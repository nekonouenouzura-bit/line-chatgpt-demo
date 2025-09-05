/**
 * api/line.js
 * LINEボット: FAQ(Embeddings + キーワード ハイブリッド) → なければ OpenAI
 */

import crypto from "crypto";
import Papa from "papaparse";

/* ===================== 共通ユーティリティ ===================== */

function log(...args) { console.log("[line-bot]", ...args); }

// 生ボディ取得（署名検証用）
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// 軽い日本語正規化（全角→半角、記号削り、空白除去、小文字化）
function normalizeJa(s = "") {
  return s
    .toString()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[、。・!！?？~〜－—_＿|｜/／\\（）\(\)\[\]【】「」『』"'`.,:：;；]/g, "")
    .replace(/\s+/g, "");
}

/* ===================== OpenAI Embeddings ===================== */

async function getEmbedding(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });
  if (!res.ok) throw new Error("Embedding error: " + await res.text());
  const data = await res.json();
  return data.data[0].embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ===================== FAQ ロード & 検索 ===================== */

let cachedFAQ = [];        // { q, a, tags, emb, qNorm }
let lastFetchMs = 0;
const FAQ_CACHE_MS = 10 * 60 * 1000; // 10分キャッシュ
const SIM_THRESHOLD = 0.65;          // 類似度しきい値（少し緩め）

// CSVのヘッダを柔軟にマップ
function mapRowFlexible(row) {
  // 許容ヘッダ
  const qKeys = ["question", "質問", "Question"];
  const aKeys = ["answer", "回答", "Answer"];
  const tKeys = ["tags", "tag", "タグ", "Tags"];

  const pick = (keys) => {
    for (const k of keys) {
      if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]);
      // 大文字小文字ゆるく
      const hit = Object.keys(row).find(kk => kk.toLowerCase() === k.toLowerCase());
      if (hit && String(row[hit]).trim() !== "") return String(row[hit]);
    }
    return "";
  };

  return {
    q: pick(qKeys).trim(),
    a: pick(aKeys).trim(),
    tags: pick(tKeys).trim()
  };
}

async function loadFAQwithEmbeddings() {
  const now = Date.now();
  if (cachedFAQ.length && now - lastFetchMs < FAQ_CACHE_MS) return cachedFAQ;

  const url = process.env.FAQ_SHEET_URL;
  if (!url) {
    log("WARN: FAQ_SHEET_URL 未設定。FAQなしで続行。");
    cachedFAQ = [];
    lastFetchMs = now;
    return cachedFAQ;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("FAQ fetch error: " + (await res.text()));
  const csv = await res.text();

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rows = (parsed.data || [])
    .map(mapRowFlexible)
    .filter(r => r.q && r.a);

  const out = [];
  for (const r of rows) {
    try {
      const emb = await getEmbedding(r.q);
      out.push({
        q: r.q,
        a: r.a,
        tags: r.tags,
        qNorm: normalizeJa(r.q),
        emb
      });
    } catch (e) {
      log("Embedding生成失敗:", r.q, e.message);
    }
  }

  cachedFAQ = out;
  lastFetchMs = now;
  log(`FAQ loaded: ${rows.length} rows, embedded: ${out.length}`);
  return cachedFAQ;
}

// Embeddings検索 → ダメならキーワード検索（フォールバック）
async function findFAQ(userText) {
  const list = await loadFAQwithEmbeddings();
  if (!list.length) return null;

  // 1) Embeddings 類似度
  try {
    const userEmb = await getEmbedding(userText);
    let best = { sim: -1, item: null };
    for (const item of list) {
      const sim = cosineSim(userEmb, item.emb);
      if (sim > best.sim) best = { sim, item };
    }
    if (best.item && best.sim >= SIM_THRESHOLD) {
      log(`FAQ(emb) hit: "${best.item.q}" sim=${best.sim.toFixed(2)}`);
      return { answer: best.item.a, debug: { via: "emb", sim: best.sim, q: best.item.q } };
    }
  } catch (e) {
    log("Embeddings検索失敗:", e.message);
  }

  // 2) キーワード（簡易フォールバック）
  const u = normalizeJa(userText);
  let bestK = { score: 0, item: null };
  for (const item of list) {
    const qn = item.qNorm;
    if (!qn) continue;
    // 片方の包含でスコア
    let score = 0;
    if (u.includes(qn)) score = qn.length / Math.max(u.length, 1);
    else if (qn.includes(u)) score = u.length / Math.max(qn.length, 1);
    // 「営業時間」「定休日」など良くある語は強めに拾える
    if (u.includes("営業時間") && qn.includes("営業時間")) score = Math.max(score, 0.8);
    if (u.includes("定休日") && qn.includes("定休日")) score = Math.max(score, 0.8);

    if (score > bestK.score) bestK = { score, item };
  }
  if (bestK.item && bestK.score >= 0.6) {
    log(`FAQ(keyword) hit: "${bestK.item.q}" score=${bestK.score.toFixed(2)}`);
    return { answer: bestK.item.a, debug: { via: "kw", score: bestK.score, q: bestK.item.q } };
  }

  return null;
}

/* ===================== OpenAI Chat ===================== */

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

  if (!res.ok) throw new Error("OpenAI error: " + await res.text());
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "すみません、うまく答えられませんでした。";
}

/* ===================== LINE 返信 ===================== */

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
  if (!res.ok) throw new Error("LINE reply error: " + await res.text());
}

/* ===================== メイン ===================== */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok");

  // 署名検証
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

  // JSON化
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return res.status(400).send("bad json"); }

  const events = body.events || [];
  for (const ev of events) {
    try {
      if (ev.type === "message" && ev.message?.type === "text") {
        const text = ev.message.text || "";

        // デバッグ：`debug` と送ると内部状態を返す（本番はOFF推奨）
        if (process.env.DEBUG_FAQ && text.trim().toLowerCase() === "debug") {
          const list = await loadFAQwithEmbeddings();
          await replyToLine(ev.replyToken, `FAQ件数: ${list.length}\n閾値: ${SIM_THRESHOLD}`);
          continue;
        }

        // まずFAQ検索（Embeddings→キーワード）
        const hit = await findFAQ(text);
        if (hit) {
          await replyToLine(ev.replyToken, hit.answer);
          continue;
        }

        // なければOpenAI回答
        const ai = await callOpenAI(text);
        await replyToLine(ev.replyToken, ai);
      } else {
        await replyToLine(ev.replyToken, "テキストでご質問ください。");
      }
    } catch (e) {
      log("Event error:", e);
      try { await replyToLine(ev.replyToken, "只今混み合っています。少し時間をおいてお試しください。"); } catch {}
    }
  }

  return res.status(200).send("ok");
}
