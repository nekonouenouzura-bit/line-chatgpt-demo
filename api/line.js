/**
 * api/line.js
 * LINE → (FAQヒットなら即答 / なければ OpenAI) → LINE
 * 依存: papaparse
 */

import crypto from "crypto";
import Papa from "papaparse";

// ========= ユーティリティ =========

// Webhookの生ボディ（文字列）を取得（署名検証に必須）
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// 軽量ロガー
function log(...args) {
  console.log("[line-bot]", ...args);
}

// ========= FAQ（GoogleシートCSV） =========

let cachedFAQ = [];
let lastFetchMs = 0;
const FAQ_CACHE_MS = 10 * 60 * 1000; // 10分

async function loadFAQ() {
  const now = Date.now();
  if (cachedFAQ.length && now - lastFetchMs < FAQ_CACHE_MS) return cachedFAQ;

  const url = process.env.FAQ_SHEET_URL;
  if (!url) {
    log("WARN: FAQ_SHEET_URL が未設定。FAQなしで続行します。");
    cachedFAQ = [];
    lastFetchMs = now;
    return cachedFAQ;
  }

  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`FAQ fetch error: ${res.status} ${t}`);
  }
  const csv = await res.text();

  // 1行目ヘッダ: question, answer, (tags任意)
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  cachedFAQ = (parsed.data || [])
    .map((row) => ({
      q: (row.question ?? "").toString().trim(),
      a: (row.answer ?? "").toString().trim(),
      tags: (row.tags ?? "").toString().trim(),
    }))
    .filter((r) => r.q && r.a);

  lastFetchMs = now;
  log(`FAQ loaded: ${cachedFAQ.length} rows`);
  return cachedFAQ;
}

// 文字正規化（ひらがな/カタカナ差や全半角をざっくり吸収）
function normalize(s = "") {
  const t = s
    .toString()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
  // 句読点・記号などを軽く削る
  return t.replace(/[、。・!！?？~〜－—_＿|｜/／\\（）\(\)\[\]【】「」『』"'`.,:：;；]/g, "");
}

// とりあえずの簡易スコアリング（部分一致＋逆包含を評価）
function simpleScore(qNorm, userNorm) {
  if (!qNorm || !userNorm) return 0;
  if (qNorm === userNorm) return 1;
  if (userNorm.includes(qNorm)) return qNorm.length / Math.max(userNorm.length, 1);
  if (qNorm.includes(userNorm)) return userNorm.length / Math.max(qNorm.length, 1);
  // 共通部分の長さでざっくり
  let common = 0;
  const minLen = Math.min(qNorm.length, userNorm.length);
  for (let i = 0; i < minLen; i++) {
    if (qNorm[i] === userNorm[i]) common++;
    else break;
  }
  return common / Math.max(minLen, 1) * 0.3; // 先頭一致に少しだけ点
}

// FAQ照合：しきい値を超える最高スコアの回答を返す
async function matchFAQ(userText) {
  const list = await loadFAQ();
  const u = normalize(userText);
  let best = { score: 0, answer: null, q: "" };

  for (const row of list) {
    const s = simpleScore(normalize(row.q), u);
    if (s > best.score) best = { score: s, answer: row.a, q: row.q };
  }

  // しきい値は0.4あたり（調整可）
  if (best.score >= 0.4) {
    log(`FAQ HIT: "${best.q}" (score=${best.score.toFixed(2)})`);
    return best.answer;
  }
  return null;
}

// ========= OpenAI 呼び出し =========

async function callOpenAI(userText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "あなたは企業向けLINEボットです。簡潔・丁寧な日本語で150文字以内を目安に回答してください。わからない場合は推測せず、その旨を伝えてください。",
        },
        { role: "user", content: userText },
      ],
      temperature: 0.3,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("OpenAI error: " + t);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "すみません、うまく答えられませんでした。";
}

// ========= LINE 返信 =========

async function replyToLine(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("LINE reply error: " + t);
  }
}

// ========= メインハンドラ =========

export default async function handler(req, res) {
  // GET はヘルスチェック/検証用に 200 を返す
  if (req.method !== "POST") {
    return res.status(200).send("ok");
  }

  // 1) 生ボディ＆署名検証
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"] || "";
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET || "")
    .update(rawBody)
    .digest("base64");

  if (expected !== signature) {
    log("Signature mismatch");
    return res.status(401).send("unauthorized");
  }

  // 2) JSON へ
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send("bad json");
  }

  const events = body.events || [];
  for (const ev of events) {
    try {
      if (ev.type === "message" && ev.message?.type === "text") {
        const userText = ev.message.text || "";

        // (a) まずFAQ検索
        const faqAnswer = await matchFAQ(userText);
        if (faqAnswer) {
          await replyToLine(ev.replyToken, faqAnswer);
          continue;
        }

        // (b) なければ OpenAI
        const ai = await callOpenAI(userText);
        await replyToLine(ev.replyToken, ai);
      } else {
        await replyToLine(ev.replyToken, "テキストでご質問ください。");
      }
    } catch (e) {
      log("Event error:", e?.message || e);
      try {
        await replyToLine(ev.replyToken, "只今混み合っています。少し時間をおいてお試しください。");
      } catch {}
    }
  }

  return res.status(200).send("ok");
}
