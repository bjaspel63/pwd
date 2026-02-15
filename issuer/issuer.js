// issuer.js — build card + watermark the photo region
const $ = (id) => document.getElementById(id);

const cv = $("cv");
const ctx = cv.getContext("2d", { willReadFrequently:true });

const statusEl = $("status");
const debugEl = $("debug");

const photoEl = $("photo");
const issuerIdEl = $("issuerId");
const cardIdHexEl = $("cardIdHex");
const expEl = $("exp");
const fullNameEl = $("fullName");

const genKeysBtn = $("genKeys");
const makeBtn = $("make");
const dlBtn = $("download");
const exportPubBtn = $("exportPub");

let keypair = null;
let lastPngBlob = null;
let lastPublicKeyRaw = null;

// Card geometry (must match verifier)
const CARD_W = 1016;
const CARD_H = 638;
const TOP_H = 92;

// Photo region (512x512, divisible by 4)
const PHOTO_W = 512;
const PHOTO_H = 512;
const PHOTO_X = 30;
const PHOTO_Y = TOP_H + 24;

function setStatus(msg){ statusEl.textContent = "Status: " + msg; }
function setDebug(obj){ debugEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj,null,2); }

function drawBaseCard({fullName, issuerId, expDate, cardIdHex}){
  // background
  ctx.clearRect(0,0,CARD_W,CARD_H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0,0,CARD_W,CARD_H);

  // top bar
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0,0,CARD_W,TOP_H);

  ctx.fillStyle = "#eaf0ff";
  ctx.font = "700 28px system-ui";
  ctx.fillText("PWD / Secure ID", 24, 58);

  ctx.font = "500 16px system-ui";
  ctx.fillStyle = "rgba(234,240,255,.85)";
  ctx.fillText(`Issuer: ${issuerId}  •  Exp: ${expDate}`, 320, 58);

  // subtle alignment corners (optional)
  ctx.strokeStyle = "rgba(0,0,0,.18)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10,10,CARD_W-20,CARD_H-20);

  // name + id
  ctx.fillStyle = "#111827";
  ctx.font = "700 30px system-ui";
  ctx.fillText(fullName || "—", PHOTO_X + PHOTO_W + 28, PHOTO_Y + 48);

  ctx.font = "500 16px system-ui";
  ctx.fillStyle = "rgba(17,24,39,.75)";
  ctx.fillText(`Card ID: ${cardIdHex.slice(0,8)}…${cardIdHex.slice(-8)}`, PHOTO_X + PHOTO_W + 28, PHOTO_Y + 80);

  ctx.fillText("This card contains an invisible watermark in the photo.", PHOTO_X + PHOTO_W + 28, PHOTO_Y + 118);

  // photo frame
  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
  ctx.strokeStyle = "rgba(17,24,39,.20)";
  ctx.lineWidth = 2;
  ctx.strokeRect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
}

async function loadImageFromFile(file){
  const url = URL.createObjectURL(file);
  try{
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res,rej)=>{
      img.onload=()=>res();
      img.onerror=()=>rej(new Error("Image load failed"));
      img.src=url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawPhotoCover(img){
  // cover-fit into PHOTO_W x PHOTO_H
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const s = Math.max(PHOTO_W/iw, PHOTO_H/ih);
  const dw = iw*s;
  const dh = ih*s;
  const dx = PHOTO_X + (PHOTO_W-dw)/2;
  const dy = PHOTO_Y + (PHOTO_H-dh)/2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

async function canvasToBlob(){
  return await new Promise(res => cv.toBlob(res, "image/png", 1.0));
}

function downloadBlob(blob, filename){
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ensureExpDefault(){
  if(!expEl.value){
    // default + 1 year from today
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear()+1);
    const yyyy=d.getUTCFullYear();
    const mm=String(d.getUTCMonth()+1).padStart(2,'0');
    const dd=String(d.getUTCDate()).padStart(2,'0');
    expEl.value = `${yyyy}-${mm}-${dd}`;
  }
}

genKeysBtn.addEventListener("click", async ()=>{
  try{
    setStatus("generating Ed25519 keys…");
    keypair = await CryptoUtil.generateEd25519Keypair();
    lastPublicKeyRaw = await CryptoUtil.exportPublicKeyRaw(keypair);
    setStatus("keys generated ✅");
    exportPubBtn.disabled = false;
    setDebug({ publicKey_raw_base64: CryptoUtil.u8ToB64(lastPublicKeyRaw) });
  } catch(e){
    setStatus("keygen failed ❌ (your browser may not support Ed25519 WebCrypto)");
    setDebug(String(e));
  }
});

exportPubBtn.addEventListener("click", async ()=>{
  if(!lastPublicKeyRaw) return;
  const obj = {
    alg: "Ed25519",
    publicKey_raw_base64: CryptoUtil.u8ToB64(lastPublicKeyRaw),
    note: "Copy this into verifier/publicKey.json"
  };
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:"application/json"});
  downloadBlob(blob, "publicKey.json");
});

makeBtn.addEventListener("click", async ()=>{
  try{
    ensureExpDefault();
    if(!keypair) throw new Error("Generate keys first.");

    setStatus("building payload…");

    const issuerId = Math.max(0, Math.min(65535, Number(issuerIdEl.value||0)));
    let cardId16;
    if(cardIdHexEl.value.trim()){
      const bytes = CryptoUtil.hexToBytes(cardIdHexEl.value.trim());
      if(bytes.length !== 16) throw new Error("Card ID must be exactly 16 bytes hex (32 hex chars).");
      cardId16 = bytes;
    } else {
      cardId16 = CryptoUtil.randBytes(16);
      cardIdHexEl.value = CryptoUtil.bytesToHex(cardId16);
    }

    const expDate = expEl.value;
    const fullName = fullNameEl.value;

    const payload = await CryptoUtil.buildPayload({ issuerId, cardId16, expDate, version:1, fullName });

    setStatus("signing payload…");
    const sig = await CryptoUtil.signEd25519(keypair.privateKey, payload);

    const token = CryptoUtil.buildToken(payload, sig);

    // ECC (repeat bits)
    const repBits = ECC.encodeBytes(token);

    // Draw base card + photo
    drawBaseCard({
      fullName,
      issuerId,
      expDate,
      cardIdHex: CryptoUtil.bytesToHex(cardId16)
    });

    const file = photoEl.files?.[0];
    if(!file) throw new Error("Upload a photo first.");
    const img = await loadImageFromFile(file);
    drawPhotoCover(img);

    // Extract photo region ImageData
    setStatus("embedding invisible watermark…");
    const photoData = ctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);

    // Embed bits into photoData (blue channel in DWT)
    await WM.embedBitsInBlue(photoData, repBits);

    // Put it back
    ctx.putImageData(photoData, PHOTO_X, PHOTO_Y);

    // Save png
    setStatus("rendering PNG…");
    lastPngBlob = await canvasToBlob();
    dlBtn.disabled = false;

    setStatus("done ✅ (print the card and verify with camera)");
    setDebug({
      payload_len: payload.length,
      token_len: token.length,
      rep_bits: repBits.length,
      rep_factor: ECC.REP,
      wm_samples_per_bit: WM.SAMPLES_PER_BIT,
      wm_alpha: WM.ALPHA,
      publicKey_raw_base64: CryptoUtil.u8ToB64(lastPublicKeyRaw)
    });
  } catch(e){
    setStatus("failed ❌");
    setDebug(String(e));
  }
});

dlBtn.addEventListener("click", ()=>{
  if(!lastPngBlob) return;
  downloadBlob(lastPngBlob, "id_card_watermarked.png");
});
