import crypto from "crypto";

// ── 1) RAW BODY を必ず文字列で取得 ─────────────────────
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── 2) OpenAI（最小形。必要ならモデル名調整） ───────────────
async function callOpenAI(userText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "あなたはLINEボットです。150文字以内の丁寧な日本語で答えてください。" },
        { role: "user", content: userText }
      ],
      temperature: 0.3,
      max_tokens: 200
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "すみません、うまく答えられませんでした。";
}

async function replyToLine(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
  if (!res.ok) throw new Error("LINE reply error: " + (await res.text()));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok");

  const rawBody = await readRawBody(req);

  // ── 3) 署名検証（チャネルシークレットを使う！） ──────────────
  const signature = req.headers["x-line-signature"] || "";
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");

  if (expected !== signature) {
    console.error("Signature mismatch", { gotLen: signature.length, expLen: expected.length });
    return res.status(401).send("unauthorized");
  }

  let body;
  try { body = JSON.parse(rawBody); } 
  catch { return res.status(400).send("bad json"); }

  const events = body.events || [];
  for (const ev of events) {
    try {
      if (ev.type === "message" && ev.message?.type === "text") {
        const answer = await callOpenAI(ev.message.text || "");
        await replyToLine(ev.replyToken, answer);
      } else {
        await replyToLine(ev.replyToken, "テキストでご質問ください。");
      }
    } catch (e) {
      console.error("Event error", e);
      try { await replyToLine(ev.replyToken, "只今混み合っています。少し時間をおいてお試しください。"); } catch {}
    }
  }
  return res.status(200).send("ok");
}
