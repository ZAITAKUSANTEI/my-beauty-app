// netlify/functions/diagnose.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method Not Allowed" });
    }
    const { images_b64, age, sex } = JSON.parse(event.body || "{}");
    if (!images_b64 || images_b64.length !== 3) {
      return resp(400, { error: "images_b64 must be array of 3 base64 strings." });
    }

    // Vision API 呼び出し
    const body = {
      requests: images_b64.map(b64 => ({
        image: { content: b64 },
        features: [
          { type: "IMAGE_PROPERTIES", maxResults: 1 },
          { type: "FACE_DETECTION",   maxResults: 5 }
        ]
      }))
    };

    const vres = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.VISION_API_KEY}`,
      { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }
    );
    if (!vres.ok) {
      return resp(vres.status, { error: await vres.text() });
    }
    const data = await vres.json();

    // 特徴量抽出（簡易）
    const responses = data.responses || [];
    const brightnessVals = [], rRatios = [];
    for (const rep of responses) {
      const colors = rep?.imagePropertiesAnnotation?.dominantColors?.colors || [];
      if (colors.length) {
        const c = colors[0].color || {};
        const r = +c.red || 0, g = +c.green || 0, b = +c.blue || 0;
        const bright = (0.299*r + 0.587*g + 0.114*b)/255;
        brightnessVals.push(bright);
        rRatios.push(r / Math.max(1, r+g+b));
      }
    }
    const avgB = brightnessVals.length ? avg(brightnessVals) : 0.5;
    const varB = brightnessVals.length ? variance(brightnessVals, avgB) : 0.0;
    const contrast = clamp01(varB * 3);
    const redness  = rRatios.length ? avg(rRatios) : 0.3;
    const texture  = clamp01(0.4 + 0.6 * contrast);

    // 独自スコア（必要に応じて係数・閾値を後で調整）
    const spots    = clamp01(0.6*(1-avgB) + 0.4*contrast);
    const wrinkles = clamp01(0.4*(age||0)/80 + 0.6*contrast);
    const sagging  = clamp01(0.5*(age||0)/80 + 0.5*(1-contrast));
    const pores    = clamp01(0.7*texture + 0.3*contrast);
    const redn     = clamp01(redness);
    const to5 = x => x<0.2?1 : x<0.4?2 : x<0.6?3 : x<0.8?4 : 5;

    const result = {
      age, sex,
      features: { brightness: avgB, redness, texture, contrast },
      scores: {
        spots_score: spots,
        wrinkles_score: wrinkles,
        sagging_score: sagging,
        pores_score: pores,
        redness_score: redn
      },
      grades: {
        spots_grade: to5(spots),
        wrinkles_grade: to5(wrinkles),
        sagging_grade: to5(sagging),
        pores_grade: to5(pores),
        redness_grade: to5(redn)
      },
      comment: "※本結果は美容目的の参考評価です（診断ではありません）。対面での個別説明を推奨します。"
    };

    return resp(200, result);
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
function avg(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr, m){ return arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
