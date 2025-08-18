// netlify/functions/plan.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method Not Allowed" });
    }
    const { age, sex, concerns = [], scores = {}, grades = {} } = JSON.parse(event.body || "{}");

    const PRICE_BOOK = [
      {"category":"spots","name":"トラネキサム酸内服","unit":"月","price_jpy":3000},
      {"category":"spots","name":"レーザートーニング","unit":"回","price_jpy":12000},
      {"category":"wrinkles","name":"ボトックス（額）","unit":"回","price_jpy":25000},
      {"category":"sagging","name":"HIFU（全顔）","unit":"回","price_jpy":80000},
      {"category":"pores","name":"CO2フラクショナル","unit":"回","price_jpy":35000},
      {"category":"redness","name":"IPL（赤み）","unit":"回","price_jpy":18000}
    ];

    const prompt = `
あなたは美容医療のカウンセラーです。以下の情報に基づき、
「施術プラン（ライト/スタンダード/アグレッシブ）」を日本語のJSONで作成してください。
価格は必ず提示される価格表から選び、書き換えや追加はしないでください。

[患者]
- 年齢: ${age}
- 性別: ${sex}
- 主訴: ${concerns.join(", ") || "（未入力）"}

[評価]
${JSON.stringify({scores, grades}, null, 2)}

[価格表]
${JSON.stringify(PRICE_BOOK)}

[出力フォーマット(JSON)]
{
 "light":[{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
 "standard":[{...}],
 "aggressive":[{...}],
 "notes":"（禁忌・注意・来院頻度など）"
}
診断的断定は避け、一般的助言の範囲で。JSONのみを返してください。`;

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
