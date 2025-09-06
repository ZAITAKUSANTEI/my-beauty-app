// netlify/functions/plan.js
// 診断結果(scores/grades) + 年齢/性別 + 関心(concerns[]) を入力に、OpenAIで3段階プランをJSON生成。
// 価格は price_book.json（任意）を参照し、なければ簡易レートで見積もる。

/**
 * 環境変数:
 *  - OPENAI_API_KEY : OpenAI API Key
 * 必須: Node 18+ （fetch/WHATWG標準）
 */
const fs = require("fs");
const path = require("path");

function loadPriceBook(){
  try{
    const p = path.join(__dirname, "data", "price_book.json");
    const txt = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(txt);
    if(Array.isArray(j) && j.length) return j;
  }catch(_){/* not found */}
  // フォールバック（概算）
  return [
    { code:"HIFU", name:"HIFU（ハイフ）", price:45000 },
    { code:"THREAD", name:"スレッドリフト(簡易)", price:120000 },
    { code:"PRP", name:"PRP皮膚再生療法（小範囲）", price:80000 },
    { code:"LASER_TONE", name:"レーザートーニング", price:15000 },
    { code:"LASER_CO2", name:"CO2フラクショナル(小範囲)", price:30000 },
    { code:"TRX", name:"トラネキサム酸内服/外用", price:3000 },
    { code:"BOTOX", name:"ボトックス(眉間/額/目尻)", price:20000 },
    { code:"FILLER", name:"ヒアルロン酸フィラー(1本)", price:40000 },
    { code:"LIPO_SHOT", name:"脂肪溶解注射(頬/顎下)", price:20000 },
    { code:"RETINOID", name:"レチノイド外用(医療用)", price:4000 },
  ];
}
const PRICE_BOOK = loadPriceBook();

function estimatePrice(items){
  let sum = 0;
  for(const it of items||[]){
    const hit = PRICE_BOOK.find(x => it.includes(x.name) || it.includes(x.code));
    sum += hit ? hit.price : 10000; // 不明は1万円で概算
  }
  return sum;
}

function extractJSON(text){
  if(!text) return null;
  const cleaned = text.trim();
  // 最初の { から最後の } までを抜き出して JSON.parse を試みる
  const first = cleaned.indexOf("{");
  const last  = cleaned.lastIndexOf("}");
  if(first>=0 && last>first){
    const cand = cleaned.slice(first, last+1);
    try{ return JSON.parse(cand); }catch(_){}
  }
  return null;
}

function buildPrompt({ age, sex, concerns, scores, grades, extraNote }){
  return `
あなたは美容医療の専門カウンセラーです。以下の患者情報と診断結果を踏まえ、
"必ずJSONのみ" を出力してください（前後の説明や記号・コードブロックは不要）。キーは下記に厳密に一致させてください。

[患者]
- 年齢: ${age}
- 性別: ${sex}
- 主な悩み: ${Array.isArray(concerns)? concerns.join(", ") : ""}

[診断スコア(30-100 高いほど良い)]
- spots: ${scores?.spots}
- wrinkles: ${scores?.wrinkles}
- sagging: ${scores?.sagging}
- pores: ${scores?.pores}
- redness: ${scores?.redness}
- overall: ${Object.values(scores||{}).length? Math.round(Object.values(scores).reduce((a,b)=>a+b,0)/Object.values(scores).length):"-"}

[グレード(A-D)]
- ${Object.entries(grades||{}).map(([k,v])=>`${k}: ${v}`).join(", ")}

[補足メモ]
${extraNote||""}

[出力JSONフォーマット]
{
  "light":    { "title": "ライト",      "items": ["...","..."], "note": "補足（任意）", "est_price": 0 },
  "standard": { "title": "スタンダード", "items": ["...","..."], "note": "補足（任意）", "est_price": 0 },
  "aggressive":{ "title": "アグレッシブ","items": ["...","..."], "note": "補足（任意）", "est_price": 0 },
  "notes": "全体の注意点（任意）"
}

[作成方針]
- 5カテゴリ（リフトアップ/色素・美白/肌質改善/脂肪除去/毛穴）を適切に組み合わせ、冗長にならないよう各プランは3〜6項目で。
- 安全性重視。妊娠可能性がある場合は内服/施術の注意に必ず言及。
- 重複施術は避け、通院回数やダウンタイムに配慮した提案にする。
- 価格は一般的相場感を用いつつ、相対感だけでよい（整数・円）。
- JSON以外は出力しない。
`.trim();
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=="POST"){
      return resp(405, { error:"Method Not Allowed" });
    }
    if(!process.env.OPENAI_API_KEY){
      return resp(500, { error:"OPENAI_API_KEY が未設定です" });
    }
    const body = JSON.parse(event.body||"{}");
    const { age, sex, concerns=[], scores={}, grades={}, extraNote="" } = body;

    const prompt = buildPrompt({ age, sex, concerns, scores, grades, extraNote });

    const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role:"system", content:"You are a helpful assistant that outputs strictly valid JSON when asked." },
          { role:"user", content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 800
      })
    });
    if(!oaiRes.ok){
      const t = await oaiRes.text().catch(()=> "");
      return resp(502, { error:"OpenAI API error", detail:t });
    }
    const comp = await oaiRes.json();
    const txt  = comp?.choices?.[0]?.message?.content || "";
    let parsed = extractJSON(txt);

    // フォールバック（最低限の骨組み）
    if(!parsed){
      parsed = {
        light:    { title:"ライト", items:["トラネキサム酸外用/内服","レチノイド外用"], note:"刺激が出る場合は頻度を調整", est_price: 0 },
        standard: { title:"スタンダード", items:["レーザートーニング(月1)","HIFU(軽)","ボトックス(必要部位)"], note:"ダウンタイム少", est_price: 0 },
        aggressive:{title:"アグレッシブ", items:["CO2フラクショナル(小範囲)","スレッド(少本)","PRP(小範囲)"], note:"ダウンタイムあり", est_price: 0 },
        notes:"AI提案のため最終判断は医師と相談"
      };
    }

    // 概算価格を補完
    ["light","standard","aggressive"].forEach(k=>{
      if(!parsed[k]) return;
      if(!Array.isArray(parsed[k].items)) parsed[k].items=[];
      if(typeof parsed[k].title!=="string") parsed[k].title = (k==="light"?"ライト":k==="standard"?"スタンダード":"アグレッシブ");
      parsed[k].est_price = estimatePrice(parsed[k].items);
      if(typeof parsed[k].note!=="string") parsed[k].note = "";
    });
    if(typeof parsed.notes!=="string") parsed.notes="";

    return resp(200, parsed);

  }catch(e){
    console.error("[plan] ERROR:", e);
    return resp(500, { error: e.message || String(e) });
  }
};

function resp(status,obj){
  return {
    statusCode: status,
    headers:{ "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
    body: JSON.stringify(obj)
  };
}
