/**
 * api/line.js
 * LINEボット: FAQ(Embeddings検索) → なければ OpenAI回答
 */

import crypto from "crypto";
import Papa from "papaparse";

// ======= Embeddings =======
async function getEmbedding(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small", // 安価＆十分な精度
      input: text,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Embedding error: " + t);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

function cosineSim(vecA, vecB) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ======= FAQ with Embeddings =======
let cachedFAQ = [];
let lastFetchMs = 0;

async function loadFAQwithEmbeddings() {
  const now = Date.now();
  if (cachedFAQ.length && now - lastFetchMs < 10 * 60 * 1000) return cachedFAQ;

  const url = process.env.FAQ_SHEET_URL;
  if (!url) {
    console.warn("FAQ_SHEET_URL が未設定");
    return [];
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("FAQ fetch error: " + (await res.text()));
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  cachedFAQ = [];
  for (const row of parsed.data) {
    if (!row.question || !row.answer) continue;
    try {
      const emb = await getEmbedding(row.question);
      cachedFAQ.push({
        q: row.question.trim(),
        a: row.answer.trim(),
        emb,
      });
    } catch (e) {
      console.error("Embedding生成失敗:", row.question, e.message);
    }
  }

  lastFetchMs = now;
  console.log(`[FAQ] Embeddings生成済み: ${cachedFAQ.length}件`);
  return cachedFAQ;
}

async function matchFAQbyEmbedding(userText) {
  const faqs = await loadFAQwithEmbeddings();
  if (!faqs.length) return null;

  const userEmb = await getEmbedding(userText);

  let best = { score: -1, answer: null, q: "" };
  for (const f of faqs) {
    const sim = cosineSim(userEmb, f.emb);
    if (sim > best.score) {
      best = { score: sim, answer: f.a, q: f.q };
    }
  }

  // 類似度のしきい値（0.75〜0.8 推奨）
  if (best.score >= 0.75) {
    console.log(`FAQヒット: "${best.q}" (sim=${best.score.toFixed(2)})`);
    return best.answer;
  }
  return null;
}

// ======= OpenAI Chat =======
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

// ======= LINE Reply =======
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

// ======= LINE Handler =======
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok");

  const rawBody = await readRawBody(req);

  // 署名検証
  const signature = req.headers["x-line-signature"] || "";
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET || "")
    .update(rawBody)
    .digest("base64");

  if (expected !== signature) {
    console.error("Signature mismatch");
    return res.status(401).send("unauthorized");
  }

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

        // Embeddings検索
        const faqAnswer = await matchFAQbyEmbedding(userText);
        if (faqAnswer) {
          await replyToLine(ev.replyToken, faqAnswer);
          continue;
        }

        // なければ OpenAI
        const ai = await callOpenAI(userText);
        await replyToLine(ev.replyToken, ai);
      } else {
        await replyToLine(ev.replyToken, "テキストでご質問ください。");
      }
    } catch (e) {
      console.error("Event error:", e);
      try {
        await replyToLine(ev.replyToken, "只今混み合っています。少し時間をおいてお試しください。");
      } catch {}
    }
  }

  return res.status(200).send("ok");
}
