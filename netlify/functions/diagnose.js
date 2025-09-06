// netlify/functions/diagnosis.js
// 画像3枚 + 年齢/性別 を入力として、Vision API由来の特徴量から
// 5指標（spots, wrinkles, sagging, pores, redness）と overall を返す。
// スコアは 30〜100点（高いほど良い）。grades は A〜D。

/**
 * 環境変数:
 *  - VISION_API_KEY : Google Cloud Vision API Key
 *  - NODE_VERSION   : 18以上を推奨（Netlify build env）
 */
const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

function toNewScore(originalScore){ // 0-1(悪) -> 30-100(良)
  const goodness = 1 - originalScore;
  const scaled = 30 + Math.pow(goodness, 1.2) * 70;
  return Math.round(scaled);
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function avg(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== "POST"){
      return resp(405, { error:"Method Not Allowed" });
    }
    const { images_b64=[], age, sex } = JSON.parse(event.body||"{}");
    if(!Array.isArray(images_b64) || images_b64.filter(Boolean).length !== 3){
      return resp(400, { error:"3枚の画像（base64, dataURIヘッダ不要）を送ってください" });
    }
    if(!process.env.VISION_API_KEY){
      return resp(500, { error:"VISION_API_KEY が未設定です" });
    }

    // Vision API: imageProperties + face detection（軽量特徴量として活用）
    const reqBody = {
      requests: images_b64.map(b64=>({
        image:{ content:b64 },
        features:[
          { type:"IMAGE_PROPERTIES", maxResults:1 },
          { type:"FACE_DETECTION",   maxResults:1 }
        ]
      }))
    };
    const vres = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(process.env.VISION_API_KEY)}`, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(reqBody)
    });
    if(!vres.ok){
      const t = await vres.text().catch(()=> "");
      return resp(502, { error:"Vision API error", detail:t });
    }
    const vjson = await vres.json();

    // 特徴量抽出
    const responses = vjson.responses || [];
    const brightnessVals = [], rRatios = [], faceAnnots = [];
    for(const rep of responses){
      const colors = rep?.imagePropertiesAnnotation?.dominantColors?.colors || [];
      if(colors.length){
        const c = colors[0].color || {};
        const r = +c.red || 0, g = +c.green || 0, b = +c.blue || 0;
        const bright = (0.299*r + 0.587*g + 0.114*b)/255;
        brightnessVals.push(bright);
        rRatios.push( (r) / Math.max(1, r+g+b) );
      }else{
        brightnessVals.push(0.6); rRatios.push(0.34);
      }
      if(rep.faceAnnotations && rep.faceAnnotations.length>0){
        faceAnnots.push(rep.faceAnnotations[0]);
      }else{
        faceAnnots.push({});
      }
    }

    // 顔ランドマークの簡略的統合（表情・たるみの代理）
    // Visionの笑い/怒り等 likelihood を 0..1 に換算
    function likeTo01(v){
      const map={ VERY_UNLIKELY:0, UNLIKELY:0.2, POSSIBLE:0.4, LIKELY:0.7, VERY_LIKELY:1 };
      return map[String(v)||""] ?? 0.0;
    }
    const expressions = faceAnnots.map(a=>({
      joy: likeTo01(a.joyLikelihood), anger: likeTo01(a.angerLikelihood),
      sorrow: likeTo01(a.sorrowLikelihood), surprise: likeTo01(a.surpriseLikelihood)
    }));

    // —— ヘuristic な特徴量（0-1で「悪さ」寄りに設計）——
    const brightness = clamp01(1 - avg(brightnessVals));      // 暗いほど悪
    const redness    = clamp01(avg(rRatios));                  // R比が高いほど赤み
    const texture    = clamp01(0.45 + 0.2*brightness);         // 粗さ代理
    const contrast   = clamp01(0.4  + 0.3*(1-brightness));     // 影→しわ代理
    const sagProxy   = clamp01(0.35 + 0.25*avg(expressions.map(e=>e.sorrow))); // たるみ代理

    // 元スコア（0-1で悪いほど1）
    const spots_raw    = clamp01(0.5*redness + 0.5*brightness);
    const wrinkles_raw = clamp01(0.6*contrast + 0.4*brightness);
    const sagging_raw  = clamp01(0.7*sagProxy + 0.3*contrast);
    const pores_raw    = clamp01(0.7*texture + 0.3*contrast);
    const redness_raw  = clamp01(redness);

    // 30-100点（高いほど良い）へ
    const scores = {
      spots:    toNewScore(spots_raw),
      wrinkles: toNewScore(wrinkles_raw),
      sagging:  toNewScore(sagging_raw),
      pores:    toNewScore(pores_raw),
      redness:  toNewScore(redness_raw),
    };
    const overallScore = Math.round(avg(Object.values(scores)));

    function grade(x){
      if(x>=85) return "A";
      if(x>=70) return "B";
      if(x>=55) return "C";
      return "D";
    }
    const grades = {
      spots:grade(scores.spots), wrinkles:grade(scores.wrinkles), sagging:grade(scores.sagging),
      pores:grade(scores.pores), redness:grade(scores.redness), overall:grade(overallScore)
    };

    return resp(200, {
      age, sex,
      scores, grades, overallScore,
      notes: "Vision由来の簡易特徴量からの推定。照明や撮影条件で変動します。"
    });

  }catch(e){
    console.error("[diagnosis] ERROR:", e);
    return resp(500, { error: e.message || String(e) });
  }
};

function resp(status,obj){
  return {
    statusCode: status,
    headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
    body: JSON.stringify(obj)
  };
}
