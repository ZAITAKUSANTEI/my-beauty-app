// netlify/functions/diagnose.js

// --- 変更点(1): 新しいスコア計算関数を追加 ---
// 0-1の元スコア(1に近いほど悪い)を、30-100点(100に近いほど良い)に変換
function toNewScore(originalScore) {
  const goodnessScore = 1 - originalScore; // スコアを反転
  const scaledScore = 30 + Math.pow(goodnessScore, 1.2) * 70; // 30-100点にスケール変換し、平均を調整
  return Math.round(scaledScore);
}

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
          { type: "FACE_DETECTION",   maxResults: 1 } // 1人の顔に限定
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

    // 特徴量抽出
    const responses = data.responses || [];
    const brightnessVals = [], rRatios = [], faceAnnotations = [];
    for (const rep of responses) {
      // 色情報の抽出
      const colors = rep?.imagePropertiesAnnotation?.dominantColors?.colors || [];
      if (colors.length) {
        const c = colors[0].color || {};
        const r = +c.red || 0, g = +c.green || 0, b = +c.blue || 0;
        const bright = (0.299*r + 0.587*g + 0.114*b)/255;
        brightnessVals.push(bright);
        rRatios.push(r / Math.max(1, r+g+b));
      }
      // --- 変更点(2): 顔検出データを取得 ---
      if (rep.faceAnnotations && rep.faceAnnotations.length > 0) {
        faceAnnotations.push(rep.faceAnnotations[0]);
      }
    }

    // --- 変更点(3): 顔検出データを使って信頼性チェック ---
    let detectionConfidence = 1.0;
    let isFaceTilted = false;
    if (faceAnnotations.length === 3) {
        const avgConfidence = avg(faceAnnotations.map(fa => fa.detectionConfidence));
        detectionConfidence = avgConfidence;

        const avgTilt = avg(faceAnnotations.map(fa => Math.abs(fa.rollAngle)));
        if (avgTilt > 15) { // 平均傾きが15度以上なら傾いていると判断
            isFaceTilted = true;
        }
    } else {
        // 3枚全てで顔が検出されなかった場合
        detectionConfidence = 0.0;
    }
    
    // 特徴量の計算
    const avgB = brightnessVals.length ? avg(brightnessVals) : 0.5;
    const varB = brightnessVals.length ? variance(brightnessVals, avgB) : 0.0;
    // 顔が傾いている場合、コントラストの信頼性が下がるため少し補正
    const contrast = clamp01(varB * (isFaceTilted ? 2.5 : 3.0));
    const redness  = rRatios.length ? avg(rRatios) : 0.3;
    const texture  = clamp01(0.4 + 0.6 * contrast);

    // 元の0-1スコアを計算
    const spots_raw    = clamp01(0.6*(1-avgB) + 0.4*contrast);
    const wrinkles_raw = clamp01(0.4*(age||0)/80 + 0.6*contrast);
    const sagging_raw  = clamp01(0.5*(age||0)/80 + 0.5*(1-contrast));
    const pores_raw    = clamp01(0.7*texture + 0.3*contrast);
    const redness_raw  = clamp01(redness);

    // --- 変更点(4): 新しいスコア形式で最終結果を生成 ---
    const scores = {
      spots:    toNewScore(spots_raw),
      wrinkles: toNewScore(wrinkles_raw),
      sagging:  toNewScore(sagging_raw),
      pores:    toNewScore(pores_raw),
      redness:  toNewScore(redness_raw)
    };
    
    const overallScore = Math.round(avg(Object.values(scores)));

    // diagnose.js の末尾
    const result = {
      scores: {
        overall: overallScore,
        spots:    scores.spots,    // plan.jsと連携するため、キーをprice_book.jsonのカテゴリ名に合わせる
        wrinkles: scores.wrinkles,
        sagging:  scores.sagging,
        pores:    scores.pores,
        redness:  scores.redness
      },
        analysis_info: { // 分析の信頼性に関する情報を追加
          detection_confidence: detectionConfidence,
          is_face_tilted: isFaceTilted,
      },
      comment: "※本結果は美容目的の参考評価です（診断ではありません）。対面での個別説明を推奨します。"
    };

    return resp(200, result);
  } catch (e) {
    return resp(500, { error: e.message });
  }
};

// 補助関数 (変更なし)
function resp(status, obj){
  return {
    statusCode: status,
    headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
    body: JSON.stringify(obj)
  };
}
function avg(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr, m){ return arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }