// verifier.js — AUTO-WARP camera capture -> detect card -> warp -> extract watermark -> verify

const $ = (id) => document.getElementById(id);

const video = $("video");
const snap = $("snap");
const sctx = snap.getContext("2d", { willReadFrequently:true });

const startBtn = $("start");
const scanBtn = $("scan");
const statusEl = $("status");
const resultEl = $("result");
const debugEl = $("debug");

// Must match issuer
const CARD_W = 1016;
const CARD_H = 638;
const TOP_H  = 92;

const PHOTO_W = 512;
const PHOTO_H = 512;
const PHOTO_X = 30;
const PHOTO_Y = TOP_H + 24;

let stream = null;
let publicKey = null;
let publicKeyRaw = null;

let cvReady = false;

function setStatus(msg){ statusEl.textContent = "Status: " + msg; }
function setResult(msg){ resultEl.textContent = msg; }
function setDebug(obj){ debugEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj,null,2); }

// ---------------------------
// OpenCV Ready
// ---------------------------
function waitForOpenCV(){
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (typeof cv !== "undefined" && cv.Mat && cv.imread) {
        // Some builds use cv.onRuntimeInitialized; but polling works reliably
        cvReady = true;
        resolve(true);
        return;
      }
      if (Date.now() - t0 > 15000) { // 15s
        reject(new Error("OpenCV.js failed to load. Try hosting opencv.js locally."));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ---------------------------
// Public key loader
// ---------------------------
async function loadPublicKey(){
  const res = await fetch("publicKey.json", { cache:"no-store" });
  if(!res.ok) throw new Error("publicKey.json not found. Put it in verifier/ folder.");
  const data = await res.json();
  if(!data.publicKey_raw_base64) throw new Error("publicKey.json missing publicKey_raw_base64");

  publicKeyRaw = CryptoUtil.b64ToU8(data.publicKey_raw_base64);
  publicKey = await CryptoUtil.importPublicKeyRaw(publicKeyRaw);
  return data;
}

// ---------------------------
// Camera
// ---------------------------
async function startCamera(){
  if(stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height:{ ideal: 720 }
    },
    audio: false
  });
  video.srcObject = stream;
}

function stopCamera(){
  if(!stream) return;
  stream.getTracks().forEach(t => t.stop());
  stream = null;
}

// Draw current video frame into fixed canvas size
function drawFrameToSnap(){
  sctx.drawImage(video, 0, 0, CARD_W, CARD_H);
}

// ---------------------------
// AUTO CARD DETECT + WARP
// ---------------------------

function orderQuadPoints(pts){
  // pts: array of {x,y} length 4
  // order: top-left, top-right, bottom-right, bottom-left
  const sum  = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.x - p.y);

  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];
  return [tl, tr, br, bl];
}

function detectCardQuadFromCanvas(canvas){
  // returns 4 points in canvas coordinates, or null
  const src = cv.imread(canvas);

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);

  const edges = new cv.Mat();
  cv.Canny(blur, edges, 60, 160);

  // Close gaps
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
  const closed = new cv.Mat();
  cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let best = null;
  let bestArea = 0;

  for(let i=0;i<contours.size();i++){
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if(area < 20000) { cnt.delete(); continue; } // ignore tiny

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if(approx.rows === 4 && area > bestArea){
      // Extract points
      const pts = [];
      for(let r=0;r<4;r++){
        const x = approx.intPtr(r,0)[0];
        const y = approx.intPtr(r,0)[1];
        pts.push({x, y});
      }
      best = pts;
      bestArea = area;
    }

    approx.delete();
    cnt.delete();
  }

  // cleanup
  src.delete(); gray.delete(); blur.delete(); edges.delete();
  kernel.delete(); closed.delete(); contours.delete(); hierarchy.delete();

  if(!best) return null;
  return orderQuadPoints(best);
}

function warpCanvasToCardSize(canvas, quadPts){
  // quadPts: [tl,tr,br,bl] in canvas coords
  const src = cv.imread(canvas);

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quadPts[0].x, quadPts[0].y,
    quadPts[1].x, quadPts[1].y,
    quadPts[2].x, quadPts[2].y,
    quadPts[3].x, quadPts[3].y
  ]);

  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    CARD_W-1, 0,
    CARD_W-1, CARD_H-1,
    0, CARD_H-1
  ]);

  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(CARD_W, CARD_H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  // Write warped into snap canvas
  cv.imshow(canvas, dst);

  // cleanup
  src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
}

// ---------------------------
// Watermark extraction settings
// ---------------------------
function tokenBytesLenGuess(){
  // Issuer payload is 39 bytes; token = 2 + 39 + 64 = 105 bytes
  // (parseToken uses length inside token, but we must extract enough bits to recover those 105 bytes)
  return 105;
}

startBtn.addEventListener("click", async ()=>{
  try{
    setStatus("loading OpenCV + public key…");
    await waitForOpenCV();
    const pub = await loadPublicKey();

    setStatus("starting camera…");
    await startCamera();
    scanBtn.disabled = false;

    setResult("Ready. Align the printed card. Tap Scan.");
    setDebug({ publicKey_raw_base64: pub.publicKey_raw_base64, opencv: "loaded" });

    setStatus("ready ✅");
  } catch(e){
    setStatus("failed ❌");
    setResult(String(e));
    setDebug(String(e));
  }
});

scanBtn.addEventListener("click", async ()=>{
  try{
    if(!publicKey) throw new Error("Public key not loaded.");
    if(!cvReady) throw new Error("OpenCV not ready.");

    setStatus("capturing frame…");
    drawFrameToSnap();

    setStatus("detecting card corners…");
    const quad = detectCardQuadFromCanvas(snap);

    if(!quad){
      throw new Error("Could not detect card edges. Try: brighter light, less glare, fill the frame, steady hands.");
    }

    setStatus("warping to standard size…");
    warpCanvasToCardSize(snap, quad);

    // Now snap is warped to exact CARD_W x CARD_H
    const photoData = sctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);

    const tokenLen = tokenBytesLenGuess();
    const tokenBits = tokenLen * 8;
    const repBitsCount = tokenBits * ECC.REP;

    setStatus("extracting watermark…");
    const repBits = await WM.extractBitsFromBlue(photoData, repBitsCount);

    setStatus("ECC decode…");
    const tokenBytes = ECC.decodeBytes(repBits);

    // Parse token => payload + signature
    const { payload, sig } = CryptoUtil.parseToken(tokenBytes);

    setStatus("verifying signature…");
    const ok = await CryptoUtil.verifyEd25519(publicKey, payload, sig);

    let out = ok ? "✅ VERIFIED\n\n" : "❌ NOT VERIFIED\n\n";

    try{
      const fields = CryptoUtil.decodePayload(payload);
      out += `Issuer ID: ${fields.issuerId}\n`;
      out += `Card ID:   ${fields.cardId}\n`;
      out += `Expiry:    ${fields.expDate}\n`;
      out += `Version:   ${fields.version}\n`;
      out += `NameHash:  ${fields.nameHash}\n\n`;
      out += "(NameHash is a privacy-safe hash of the name used during issuance.)\n";
    } catch(e){
      out += "Payload decoded with unexpected format.\n";
    }

    setResult(out);
    setStatus("done ✅");

    setDebug({
      quad,
      extracted_rep_bits: repBits.length,
      rep: ECC.REP,
      wm_samples_per_bit: WM.SAMPLES_PER_BIT,
      wm_alpha: WM.ALPHA,
      token_len_bytes: tokenBytes.length,
      payload_len: payload.length
    });

  } catch(e){
    setStatus("scan failed ❌");
    setResult(String(e));
    setDebug(String(e));
  }
});

window.addEventListener("beforeunload", stopCamera);
