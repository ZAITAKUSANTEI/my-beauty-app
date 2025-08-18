// netlify/functions/plan.js
const fs = require("fs");
const path = require("path");

// 施術メニューをJSONから読み込み（ビルド時同梱）
const PRICE_BOOK = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "price_book.json"), "utf-8")
);

// ここにあなたの“雛形プロンプト”を好きに書いてOK
const PROMPT_TEMPLATE = ({ age, sex, concerns, scores, grades, extraNote }) => `
あなたは美容医療のカウンセラーです。以下の情報に基づき、
「施術プラン（ライト/スタンダード/アグレッシブ）」を日本語のJSONで作成してください。

[患者]
- 年齢: ${age}
- 性別: ${sex}
- 主訴: ${concerns.length ? concerns.join("、") : "（未入力）"}

[評価（0-1スコア / 5段階評価）]
${JSON.stringify({ scores, grades }, null, 2)}

[施術メニュー・価格表（変更禁止）]
${JSON.stringify(PRICE_BOOK)}

[指示]
- 価格は必ず上記の価格表から選ぶ。**書き換え・追加は禁止**。
- 各プランは症状(しみ/しわ/たるみ/毛穴/赤み 等)と主訴に合致するものを優先。
- 施術ごとに「reason」を短文で添える（評価や主訴と結びつける）。
- 禁忌や注意がある場合は「notes」に明記。
- ${extraNote || "診断的断定は避け、一般的助言として表現。"}

[出力JSONフォーマット]
{
  "light":     [{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "standard":  [{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "aggressive":[{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "notes":"（禁忌・注意・来院頻度など。価格合計の目安やコース提案があれば記載）"
}
JSONのみを返してください。
`;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method Not Allowed" });
    }
    const { age, sex, concerns = [], scores = {}, grades = {}, extraNote = "" } = JSON.parse(event.body || "{}");

    const prompt = PROMPT_TEMPLATE({ age, sex, concerns, scores, grades, extraNote });

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a cautious cosmetic assistant. Output valid JSON only." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!res.ok) return resp(res.status, { error: await res.text() });
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content || "{}";

    // そのままJSONとして返す
    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: content
    };
  } catch (e) {
    return resp(500, { error: e.message });
  }
};

function resp(status, obj){
  return {
    statusCode: status,
    headers: {
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*"
    },
    body: JSON.stringify(obj)
  };
}
