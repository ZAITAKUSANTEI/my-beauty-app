// netlify/functions/plan.js
// 美容施術プラン生成（OpenAI）+ price_book.json 読み込み + 各種フォールバック

const fs = require("fs");
const path = require("path");

/* ========== price_book.json を読み込み（無ければ最小セットでフォールバック） ========== */
function loadPriceBook() {
  try {
    const p = path.join(__dirname, "data", "price_book.json");
    const txt = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(txt);
    if (Array.isArray(j) && j.length) return j;
    console.warn("price_book.json exists but empty array. Using fallback.");
  } catch (e) {
    console.warn("price_book.json not found or unreadable. Using fallback:", e.message);
  }
  // 最小フォールバック（念のため）
  return [
    { category: "spots",    name: "レーザートーニング",  unit: "回", price_jpy: 30000 },
    { category: "wrinkles", name: "ボトックス（額）",       unit: "回", price_jpy: 25000 },
    { category: "sagging",  name: "HIFU（全顔）",           unit: "回", price_jpy: 90000 }
  ];
}
const PRICE_BOOK = loadPriceBook();

/* ========== ユーティリティ ========== */
function resp(status, obj) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(obj)
  };
}

// OpenAI からの応答が JSON 以外のとき、コードフェンス除去や {} 抽出で頑張ってパース
function robustParseJSON(text) {
  if (!text || typeof text !== "string") return null;
  // コードフェンスを除去
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  // 先頭の { から末尾の } までを抽出
  const first = cleaned.indexOf("{");
  const last  = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = cleaned.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch (_) {}
  }
  return null;
}

/* ========== プロンプト ========== */
const PROMPT_TEMPLATE = ({ age, sex, concerns, scores, grades, extraNote }) => `
あなたは美容医療のカウンセラーです。以下の情報に基づき、
「施術プラン（ライト/スタンダード/アグレッシブ）」を **日本語のJSONオブジェクトのみ** で出力してください。
前後に文章・記号・コードブロックは付けないでください。キーは必ず下記フォーマットに一致させてください。

[患者]
- 年齢: ${age}
- 性別: ${sex}
- 主訴: ${concerns && concerns.length ? concerns.join("、") : "（未入力）"}

[評価（0-1スコア / 5段階評価）]
${JSON.stringify({ scores, grades }, null, 2)}

[施術メニュー・価格表（変更禁止）]
${JSON.stringify(PRICE_BOOK)}

[指示]
- 価格は必ず上記の価格表から選択。**書き換え・新規追加は禁止**。
- 各プランの配列 light / standard / aggressive をそれぞれ 1〜3 件で構成。
- 各アイテムは {"category","name","unit","price_jpy","sessions","reason"} を **すべて** 含めること。
- "sessions" は 1 以上の整数、"price_jpy" は数値。
- 提案理由 "reason" は患者情報（主訴・スコア）に言及して短く。
- 注意点や禁忌、通院頻度、合計目安金額は "notes" にまとめる。
- ${extraNote || "診断的断定は避け、一般的助言として表現。"}

[出力JSONフォーマット]
{
  "light":     [{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "standard":  [{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "aggressive":[{"category":"...","name":"...","unit":"...","price_jpy":12345,"sessions":1,"reason":"..."}],
  "notes":"（禁忌・注意・通院頻度・合計目安など）"
}
`;

/* ========== OpenAI 呼び出し ========== */
async function callOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set on Netlify.");
  }
  if (typeof fetch === "undefined") {
    // Node が古い（Netlify の NODE_VERSION を 18 以上に設定してください）
    throw new Error("fetch is undefined. Please set NODE_VERSION >= 18 in netlify.toml");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      // response_format は付けず、プロンプトで JSON-only を強制
      messages: [
        { role: "system", content: "You are a cautious cosmetic assistant. Output VALID JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${t}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "{}";
}

/* ========== Netlify Function 本体 ========== */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method Not Allowed" });
    }

    const payload = JSON.parse(event.body || "{}");
    const {
      age = 0,
      sex = "unknown",
      concerns = [],
      scores = {},
      grades = {},
      extraNote = ""
    } = payload;

    const prompt = PROMPT_TEMPLATE({ age, sex, concerns, scores, grades, extraNote });

    // 1回目
    let content = await callOpenAI(prompt);
    let parsed = robustParseJSON(content);

    // JSONでなければ再試行（より厳格な追い打ち）
    if (!parsed) {
      const retryPrompt = prompt + "\n\n重要: 有効なJSONオブジェクト **のみ** を返すこと。前後の文字は出力しないこと。";
      content = await callOpenAI(retryPrompt);
      parsed = robustParseJSON(content);
    }
    if (!parsed) throw new Error("LLM output is not valid JSON.");

    // 最低限のシェイプ保証（sessions 付与など）
    ["light","standard","aggressive"].forEach(k => {
      if (!Array.isArray(parsed[k])) parsed[k] = [];
      parsed[k] = parsed[k].map(it => ({
        category: it.category,
        name: it.name,
        unit: it.unit,
        price_jpy: Number(it.price_jpy),
        sessions: Number.isInteger(it.sessions) && it.sessions > 0 ? it.sessions : 1,
        reason: it.reason || ""
      }));
    });
    if (typeof parsed.notes !== "string") parsed.notes = "";

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify(parsed)
    };
  } catch (e) {
    console.error("[plan] ERROR:", e);
    return resp(500, { error: e.message || String(e) });
  }
};
