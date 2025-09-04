import crypto from "crypto";

/** HMAC署名検証 */
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions"; // gpt-4o-mini等に合わせて

async function callOpenAI(userText) {
  // 超最小：Chat Completions互換
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "あなたはLINEボットです。150文字以内で、丁寧に日本語で答えてください。"},
        { role: "user", content: userText }
      ],
      temperature: 0.3,
      max_tokens: 200
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("OpenAI error: " + t);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "すみません、うまく答えられませんでした。";
}

async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = {
    replyToken,
    messages: [{ type: "text", text }]
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("LINE reply error: " + t);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("ok"); // LINEのVerifyでGETが来ても200
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"] || "";
  const hmac = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody).digest("base64");
  if (hmac !== signature) {
    console.error("Signature mismatch");
    return res.status(401).end();
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    console.error("JSON parse error", e);
    return res.status(400).end();
  }

  // 複数イベントに対応
  const events = body.events || [];
  // 同期で順に処理（最小）
  for (const ev of events) {
    try {
      if (ev.type === "message" && ev.message?.type === "text") {
        const userText = ev.message.text || "";
        // （オプション）ここで簡易FAQチェック：
        // const faq = simpleFAQ(userText); if(faq) { await replyToLine(ev.replyToken, faq); continue; }

        const answer = await callOpenAI(userText);
        await replyToLine(ev.replyToken, answer);
      } else {
        // 非テキストは定型返信
        await replyToLine(ev.replyToken, "テキストでご質問ください。");
      }
    } catch (e) {
      console.error("Event error:", e);
      try { await replyToLine(ev.replyToken, "只今混み合っています。少し時間をおいてお試しください。"); } catch {}
    }
  }
  return res.status(200).send("ok");
}

/** （任意）超簡易FAQ：完全一致や含有で返すならこんな感じ
function simpleFAQ(q) {
  const list = [
    { k: ["営業時間","何時"], a: "営業時間は9:00〜18:00です（平日）。" },
    { k: ["予約","どうやって"], a: "ご予約はLINEのメニューから可能です。" },
  ];
  const t = q.normalize("NFKC");
  for (const row of list) {
    if (row.k.some(kw => t.includes(kw))) return row.a;
  }
  return null;
}
*/
