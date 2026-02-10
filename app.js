// app.js (MAKER) - Auto DWT marker + AUTO strength (Option B), no secret/payload needed
const $ = (id) => document.getElementById(id);

const PUBLIC_MARKER = "PWD-DWT-V1"; // public “stamp” embedded inside photo region

const photoEl = $("photo");
const exportBtn = $("exportBtn");
const dl = $("dl");
const statusEl = $("status");

const stepEl = $("step");       // (kept for UI, but auto strength overrides it)
const stepPill = $("stepPill");

const v = {
  name: $("v_name"),
  sex: $("v_sex"),
  dob: $("v_dob"),
  civil: $("v_civil"),
  blood: $("v_blood"),
  issued: $("v_issued"),
  valid: $("v_valid"),
  dtype: $("v_dtype"),
  addr: $("v_addr"),
  pwdno: $("v_pwdno"),
  photo: $("v_photo"),
};

const out = $("out");
const outCtx = out.getContext("2d", { willReadFrequently: true });

let photoDataUrl = "";

// Fixed export size (must match verifier)
const CARD_W = 1016;
const CARD_H = 638;

// Photo region (must match renderer & verifier crop)
const TOP_H = 92;
const PHOTO_X = 26;
const PHOTO_Y = TOP_H + 24; // 116
const PHOTO_W = 300;
const PHOTO_H = 360;

// DWT square size
const DWT_N = 256;

function fmtDate(s){
  if(!s) return "—";
  const d = new Date(s + "T00:00:00");
  if(Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"2-digit" });
}
function safeUpper(s){ return (s||"").trim().toUpperCase(); }

function updatePreview(){
  const last = safeUpper($("last").value);
  const first = safeUpper($("first").value);
  const mi = safeUpper($("mi").value);

  const name = [last || "LAST", ", ", first || "FIRST", mi ? ` ${mi}.` : ""].join("");
  v.name.textContent = name;

  v.sex.textContent = $("sex").value || "—";
  v.dob.textContent = fmtDate($("dob").value);
  v.civil.textContent = $("civil").value || "—";
  v.blood.textContent = $("blood").value || "—";
  v.issued.textContent = fmtDate($("issued").value);
  v.valid.textContent = fmtDate($("valid").value);

  v.dtype.textContent = $("dtype").value.trim() || "—";
  v.addr.textContent = $("addr").value.trim() || "—";
  v.pwdno.textContent = ($("pwdno").value.trim() || "—");

  if(photoDataUrl){
    v.photo.src = photoDataUrl;
    v.photo.style.display = "block";
  } else {
    v.photo.removeAttribute("src");
    v.photo.style.display = "none";
  }
}

document.addEventListener("input", updatePreview);
document.addEventListener("change", updatePreview);

// UI: keep slider, but show it's auto (still lets you see the current value)
stepEl.addEventListener("input", () => {
  stepPill.textContent = `manual: ${stepEl.value}`;
});
stepPill.textContent = `manual: ${stepEl.value}`;

photoEl.addEventListener("change", async () => {
  const f = photoEl.files?.[0];
  if(!f) return;
  photoDataUrl = await fileToDataURL(f);
  updatePreview();
  setStatus("Photo loaded.", "ok");
});

/* -----------------------------
   AUTO strength (Option B)
   Measures blue-channel “detail” in the PHOTO region of the rendered card.
   More detail => lower step; less detail => higher step.
------------------------------ */
function autoStrengthFromPhotoRegion(ctx){
  const data = ctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H).data;

  let energy = 0;
  const w = PHOTO_W, h = PHOTO_H;

  // sample every 2 pixels for speed
  for(let y=0; y<h-1; y+=2){
    for(let x=0; x<w-1; x+=2){
      const i = (y*w + x) * 4;
      const j = (y*w + (x+1)) * 4;
      const k = ((y+1)*w + x) * 4;

      const b  = data[i+2];
      const bR = data[j+2];
      const bD = data[k+2];

      energy += Math.abs(b - bR) + Math.abs(b - bD);
    }
  }

  const samplesX = Math.floor((w-1)/2) + 1;
  const samplesY = Math.floor((h-1)/2) + 1;
  const samples = samplesX * samplesY;

  // normalize to ~0..1
  const norm = energy / (samples * 2 * 255);

  // Map to 12..26 (higher when flatter)
  const step = Math.round(26 - norm * 14);
  return Math.max(16, Math.min(26, step));
}

exportBtn.addEventListener("click", async () => {
  dl.style.display = "none";

  out.width = CARD_W;
  out.height = CARD_H;

  await renderCardToCanvas(outCtx, out.width, out.height);

  // AUTO strength (overrides slider)
  const autoStep = autoStrengthFromPhotoRegion(outCtx);
  stepEl.value = autoStep; // reflect in UI
  stepPill.textContent = `auto: ${autoStep}`;

  // Always embed marker
  const bits = await publicMarkerBits(256);
  const finalUrl = await embedSignatureIntoCanvas(outCtx, out.width, out.height, bits, autoStep);

  setStatus(`Export ready ✔️ (auto strength ${autoStep})`, "ok");

  dl.href = finalUrl;
  dl.style.display = "inline-flex";
});

async function publicMarkerBits(bitCount){
  const enc = new TextEncoder().encode(PUBLIC_MARKER);
  let pool = new Uint8Array(await crypto.subtle.digest("SHA-256", enc));
  const bits = [];
  while(bits.length < bitCount){
    for(const b of pool){
      for(let k=7;k>=0;k--){
        bits.push((b>>k)&1);
        if(bits.length === bitCount) return bits;
      }
    }
    pool = new Uint8Array(await crypto.subtle.digest("SHA-256", pool));
  }
  return bits;
}

function setStatus(msg, kind){
  statusEl.textContent = msg;
  statusEl.style.borderColor = kind==="bad" ? "rgba(220,38,38,.35)" : "rgba(22,163,74,.25)";
}

/* -----------------------------
   Render card to canvas
------------------------------ */
async function renderCardToCanvas(ctx, W, H){
  ctx.clearRect(0,0,W,H);

  // background
  const g = ctx.createLinearGradient(0,0,W,H);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#f7fbff");
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, W, H, 28, true, false);

  // top band
  const topH = TOP_H;
  const g2 = ctx.createLinearGradient(0,0,W,0);
  g2.addColorStop(0, "rgba(37,99,235,.14)");
  g2.addColorStop(1, "rgba(37,99,235,0)");
  ctx.fillStyle = g2;
  roundRect(ctx, 0, 0, W, topH, 28, true, false);
  ctx.fillStyle = "rgba(0,0,0,.08)";
  ctx.fillRect(0, topH-1, W, 1);

  // title
  ctx.fillStyle = "#0f172a";
  ctx.font = "900 30px system-ui, -apple-system, Segoe UI, Arial";
  ctx.fillText("PERSONS WITH DISABILITY (PWD) ID", 26, 48);
  ctx.fillStyle = "#5a6b7a";
  ctx.font = "700 16px system-ui, -apple-system, Segoe UI, Arial";
  ctx.fillText("Auto DWT Marker • Demo", 26, 72);

  // PWD No pill
  const pwdno = $("pwdno").value.trim() || "—";
  const pillText = `PWD ID: ${pwdno}`;
  ctx.font = "900 20px system-ui, -apple-system, Segoe UI, Arial";
  const tw = ctx.measureText(pillText).width;
  const pillW = tw + 34;
  const pillH = 44;
  const pillX = W - pillW - 26;
  const pillY = 24;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, pillX, pillY, pillW, pillH, 18, true, false);
  ctx.strokeStyle = "rgba(0,0,0,.10)";
  ctx.lineWidth = 2;
  roundRect(ctx, pillX, pillY, pillW, pillH, 18, false, true);
  ctx.fillStyle = "#0f172a";
  ctx.fillText(pillText, pillX + 17, pillY + 30);

  // photo box (MUST match constants)
  const photoX = PHOTO_X, photoY = PHOTO_Y, photoW = PHOTO_W, photoH = PHOTO_H;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, photoX, photoY, photoW, photoH, 20, true, false);
  ctx.strokeStyle = "rgba(0,0,0,.10)";
  ctx.lineWidth = 2;
  roundRect(ctx, photoX, photoY, photoW, photoH, 20, false, true);

  if(photoDataUrl){
    const img = await dataURLToImage(photoDataUrl);
    drawImageCoverCanvas(ctx, img, photoX, photoY, photoW, photoH, 20);
  } else {
    ctx.fillStyle = "rgba(15,23,42,.65)";
    ctx.font = "900 18px system-ui";
    ctx.fillText("PHOTO", photoX + 18, photoY + photoH - 18);
  }

  // info area
  const infoX = photoX + photoW + 22;
  const infoY = TOP_H + 24;

  const last = safeUpper($("last").value) || "LAST";
  const first = safeUpper($("first").value) || "FIRST";
  const mi = safeUpper($("mi").value);
  const name = `${last}, ${first}${mi ? " " + mi + "." : ""}`;

  ctx.fillStyle = "#0f172a";
  ctx.font = "1000 44px system-ui, -apple-system, Segoe UI, Arial";
  ctx.fillText(name, infoX, infoY + 48);

  // divider
  ctx.fillStyle = "rgba(0,0,0,.10)";
  ctx.fillRect(infoX, infoY + 70, W - infoX - 26, 1);

  // key-values
  const kv = [
    ["Sex", $("sex").value || "—"],
    ["DOB", fmtDate($("dob").value)],
    ["Civil", $("civil").value || "—"],
    ["Blood", $("blood").value || "—"],
    ["Issued", fmtDate($("issued").value)],
    ["Valid Until", fmtDate($("valid").value)],
  ];

  const colW = 220;
  const startY = infoY + 105;
  ctx.font = "800 18px system-ui";
  for(let i=0;i<kv.length;i++){
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = infoX + col*colW;
    const y = startY + row*48;

    ctx.fillStyle = "#5a6b7a";
    ctx.fillText(`${kv[i][0]}:`, x, y);

    ctx.fillStyle = "#0f172a";
    ctx.font = "950 18px system-ui";
    ctx.fillText(`${kv[i][1]}`, x + 74, y);
    ctx.font = "800 18px system-ui";
  }

  // divider
  ctx.fillStyle = "rgba(0,0,0,.10)";
  ctx.fillRect(infoX, infoY + 210, W - infoX - 26, 1);

  // disability + address
  const dtype = $("dtype").value.trim() || "—";
  const addr = $("addr").value.trim() || "—";

  drawLabeledBlock(ctx, infoX, infoY + 235, W - infoX - 26, "DISABILITY TYPE", dtype);
  drawLabeledBlock(ctx, infoX, infoY + 315, W - infoX - 26, "ADDRESS", addr, 2);

  // bottom area
  const botH = 110;
  ctx.fillStyle = "rgba(37,99,235,.08)";
  ctx.fillRect(0, H-botH, W, botH);
  ctx.fillStyle = "rgba(0,0,0,.08)";
  ctx.fillRect(0, H-botH, W, 1);

  ctx.fillStyle = "#5a6b7a";
  ctx.font = "750 16px system-ui";
  wrapText(ctx, "This ID is issued for identification and benefits verification only.", 26, H-66, 560, 22);

  // signature line
  const sigW = 340;
  const sigX = W - sigW - 26;
  ctx.fillStyle = "rgba(15,23,42,.25)";
  ctx.fillRect(sigX, H-74, sigW, 3);
  ctx.fillStyle = "#5a6b7a";
  ctx.font = "800 14px system-ui";
  ctx.fillText("AUTHORIZED SIGNATURE", sigX + 70, H-48);

  return out.toDataURL("image/png");
}

function drawLabeledBlock(ctx, x, y, w, label, value, lines=1){
  ctx.fillStyle = "#5a6b7a";
  ctx.font = "900 14px system-ui";
  ctx.fillText(label, x, y);

  ctx.fillStyle = "#0f172a";
  ctx.font = "850 18px system-ui";
  if(lines <= 1){
    ctx.fillText(value, x, y + 26);
  } else {
    wrapText(ctx, value, x, y + 26, w, 22);
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = (text||"").split(/\s+/);
  let line = "";
  for(const w of words){
    const test = line ? line + " " + w : w;
    if(ctx.measureText(test).width > maxWidth && line){
      ctx.fillText(line, x, y);
      line = w;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if(line) ctx.fillText(line, x, y);
}

function roundRect(ctx, x, y, w, h, r, fill, stroke){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
  if(fill) ctx.fill();
  if(stroke) ctx.stroke();
}

function drawImageCoverCanvas(ctx, img, x, y, w, h, r){
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
  ctx.clip();

  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.max(w/iw, h/ih);
  const nw = iw * scale, nh = ih * scale;
  const dx = x + (w - nw)/2, dy = y + (h - nh)/2;
  ctx.drawImage(img, dx, dy, nw, nh);
  ctx.restore();
}

/* -----------------------------
   file/dataurl
------------------------------ */
function fileToDataURL(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function dataURLToImage(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=> resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/* -----------------------------
   Embed signature ONLY inside PHOTO region, BLUE channel
------------------------------ */
async function embedSignatureIntoCanvas(ctx, W, H, bits, step){
  const region = ctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);

  const tmp = document.createElement("canvas");
  tmp.width = PHOTO_W; tmp.height = PHOTO_H;
  const tctx = tmp.getContext("2d", { willReadFrequently:true });
  tctx.putImageData(region, 0, 0);

  const sq = document.createElement("canvas");
  sq.width = sq.height = DWT_N;
  const sctx = sq.getContext("2d", { willReadFrequently:true });
  sctx.drawImage(tmp, 0, 0, DWT_N, DWT_N);

  // BLUE channel
  const img = sctx.getImageData(0, 0, DWT_N, DWT_N);
  const blue = new Float32Array(DWT_N * DWT_N);
  for(let p=0, i=0; p<blue.length; p++, i+=4){
    blue[p] = img.data[i+2];
  }

  const signedBlue = embedDWT(blue, DWT_N, bits, step);

  for(let p=0, i=0; p<signedBlue.length; p++, i+=4){
    img.data[i+2] = clamp8(signedBlue[p]);
  }
  sctx.putImageData(img, 0, 0);

  const outPhoto = document.createElement("canvas");
  outPhoto.width = PHOTO_W; outPhoto.height = PHOTO_H;
  const octx = outPhoto.getContext("2d", { willReadFrequently:true });
  octx.drawImage(sq, 0, 0, PHOTO_W, PHOTO_H);

  const merged = ctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
  const signedRegion = octx.getImageData(0, 0, PHOTO_W, PHOTO_H);

  for(let i=0; i<merged.data.length; i+=4){
    merged.data[i+2] = signedRegion.data[i+2];
  }

  ctx.putImageData(merged, PHOTO_X, PHOTO_Y);
  return ctx.canvas.toDataURL("image/png");
}

function clamp8(x){
  x = Math.round(x);
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/* -----------------------------
   DWT (1-level 2D Haar)
------------------------------ */
function dwt2Haar(gray, N){
  const half = N>>1;
  const lowRows = new Float32Array(half * N);
  const highRows = new Float32Array(half * N);

  for(let y=0;y<N;y++){
    for(let x=0;x<half;x++){
      const a = gray[y*N + 2*x];
      const b = gray[y*N + 2*x+1];
      lowRows[y*half + x]  = (a + b) * 0.5;
      highRows[y*half + x] = (a - b) * 0.5;
    }
  }

  const LL = new Float32Array(half*half);
  const HL = new Float32Array(half*half);
  const LH = new Float32Array(half*half);
  const HH = new Float32Array(half*half);

  for(let x=0;x<half;x++){
    for(let y=0;y<half;y++){
      const a = lowRows[(2*y)*half + x];
      const b = lowRows[(2*y+1)*half + x];
      LL[y*half + x] = (a + b) * 0.5;
      HL[y*half + x] = (a - b) * 0.5;

      const c = highRows[(2*y)*half + x];
      const d = highRows[(2*y+1)*half + x];
      LH[y*half + x] = (c + d) * 0.5;
      HH[y*half + x] = (c - d) * 0.5;
    }
  }

  return {LL, LH, HL, HH, half};
}

function idwt2Haar({LL, LH, HL, HH, half}, N){
  const lowRows = new Float32Array(half * N);
  const highRows = new Float32Array(half * N);

  for(let x=0;x<half;x++){
    for(let y=0;y<half;y++){
      const s = LL[y*half + x], d = HL[y*half + x];
      lowRows[(2*y)*half + x] = s + d;
      lowRows[(2*y+1)*half + x] = s - d;

      const s2 = LH[y*half + x], d2 = HH[y*half + x];
      highRows[(2*y)*half + x] = s2 + d2;
      highRows[(2*y+1)*half + x] = s2 - d2;
    }
  }

  const out = new Float32Array(N*N);
  for(let y=0;y<N;y++){
    for(let x=0;x<half;x++){
      const s = lowRows[y*half + x], d = highRows[y*half + x];
      out[y*N + 2*x]   = s + d;
      out[y*N + 2*x+1] = s - d;
    }
  }
  return out;
}

function embedBitInCoeff(c, bit, step){
  const q = Math.round(c / step);
  const want = bit & 1;
  let q2 = q;
  if((q2 & 1) !== want) q2 = q2 + 1;
  return q2 * step;
}

function stableIndices(LH, HL){
  const n = LH.length;
  const idxs = [];
  for(let i=0;i<n;i++){
    const mag = Math.abs(LH[i]) + Math.abs(HL[i]);
    if(mag > 2.0) idxs.push(i);
  }
  if(idxs.length < 500){
    for(let i=0;i<n;i++) idxs.push(i);
  }
  idxs.sort((a,b)=> (Math.abs(LH[b])+Math.abs(HL[b])) - (Math.abs(LH[a])+Math.abs(HL[a])));
  return idxs.slice(0, Math.min(idxs.length, 6000));
}

function embedDWT(gray, N, bits, step){
  const bands = dwt2Haar(gray, N);
  const order = stableIndices(bands.LH, bands.HL);

  const total = bits.length;
  const nLH = Math.floor(total/2);
  const nHL = total - nLH;

  for(let i=0;i<nLH;i++){
    const idx = order[i % order.length];
    bands.LH[idx] = embedBitInCoeff(bands.LH[idx], bits[i], step);
  }
  for(let i=0;i<nHL;i++){
    const idx = order[(i + 97) % order.length];
    bands.HL[idx] = embedBitInCoeff(bands.HL[idx], bits[nLH+i], step);
  }

  const recon = idwt2Haar(bands, N);
  for(let i=0;i<recon.length;i++){
    if(recon[i] < 0) recon[i] = 0;
    else if(recon[i] > 255) recon[i] = 255;
  }
  return recon;
}
