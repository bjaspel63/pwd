const $ = (id) => document.getElementById(id);

const fileEl = $("file");
const secretEl = $("secret");
const payloadRawEl = $("payloadRaw");

const stepEl = $("step");
const stepVal = $("stepVal");

const verifyBtn = $("verifyBtn");
const tryAutoBtn = $("tryAutoBtn");

const statusEl = $("status");
const meterEl = $("meter");
const barEl = $("bar");
const detailsText = $("detailsText");

const cv = $("cv");
const ctx = cv.getContext("2d", { willReadFrequently:true });

let imgGray = null; // Float32Array of 512*512 grayscale used for extraction
let N = 512;

stepVal.textContent = `strength: ${stepEl.value}`;
stepEl.addEventListener("input", () => stepVal.textContent = `strength: ${stepEl.value}`);

fileEl.addEventListener("change", async () => {
  const f = fileEl.files?.[0];
  if(!f) return;

  const img = await fileToImage(f);
  drawPreview(img);

  // normalize to N x N square for extraction (must match embed)
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = N;
  const tctx = tmp.getContext("2d", { willReadFrequently:true });
  tctx.drawImage(img, 0, 0, N, N);

  imgGray = canvasToGrayscale(tctx, N, N);
  setStatus("Image loaded. Enter secret + payload, then Verify.", "ok");
  setMeter(null);
});

verifyBtn.addEventListener("click", async () => {
  await doVerify(false);
});

tryAutoBtn.addEventListener("click", async () => {
  await doVerify(true);
});

async function doVerify(autoTry){
  if(!imgGray) return setStatus("Upload the signed ID image first.", "bad");
  const secret = secretEl.value;
  if(!secret) return setStatus("Enter the secret key.", "bad");

  const payload = getPayloadString();
  if(!payload) return setStatus("Provide payload (Option A paste OR Option B fill).", "bad");

  const expected = await signatureBits(secret, payload, 256);

  const baseStep = parseInt(stepEl.value, 10);
  const steps = autoTry
    ? unique([baseStep-4, baseStep-3, baseStep-2, baseStep-1, baseStep, baseStep+1, baseStep+2, baseStep+3, baseStep+4]
      .filter(s => s>=6 && s<=30))
    : [baseStep];

  let best = { score: 0, step: baseStep };

  for(const st of steps){
    const extracted = extractDWT(imgGray, N, expected.length, st);
    const score = bitMatchScore(expected, extracted);
    if(score > best.score) best = { score, step: st };
  }

  const pct = Math.round(best.score * 100);

  if(best.score >= 0.85){
    setStatus(`Verified ✅ Match: ${pct}% (strength=${best.step})`, "ok");
  } else {
    setStatus(`Not verified ❌ Match: ${pct}% (best strength=${best.step})`, "bad");
  }

  setMeter(best.score);
  detailsText.textContent =
    `Best match ${pct}% using strength ${best.step}. If you re-saved/compressed the image, try a higher embed strength or keep original PNG.`;
}

/* -----------------------------
   Payload builders
------------------------------ */
function safeUpper(s){ return (s||"").trim().toUpperCase(); }

function buildPayloadFromFields(){
  const pwdno = $("pwdno").value.trim();
  const last = safeUpper($("last").value);
  const first = safeUpper($("first").value);
  const mi = safeUpper($("mi").value);

  if(!pwdno || !last || !first) return "";

  return [
    `PWDNO=${pwdno}`,
    `NAME=${last},${first} ${mi}`,
    `SEX=${$("sex").value}`,
    `DOB=${$("dob").value}`,
    `CIVIL=${$("civil").value}`,
    `BLOOD=${$("blood").value}`,
    `ISSUED=${$("issued").value}`,
    `VALID=${$("valid").value}`,
    `DTYPE=${$("dtype").value.trim()}`,
    `ADDR=${$("addr").value.trim()}`
  ].join("|");
}

function getPayloadString(){
  const raw = (payloadRawEl.value || "").trim();
  if(raw) return raw;
  return buildPayloadFromFields();
}

/* -----------------------------
   UI helpers
------------------------------ */
function setStatus(msg, kind){
  statusEl.textContent = msg;
  statusEl.style.borderColor = kind==="bad" ? "rgba(220,38,38,.35)" : "rgba(22,163,74,.25)";
}
function setMeter(score){
  if(score == null){
    meterEl.style.display = "none";
    return;
  }
  meterEl.style.display = "block";
  const pct = Math.round(score * 100);
  barEl.style.width = `${pct}%`;
}

/* -----------------------------
   Image helpers
------------------------------ */
function fileToImage(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function drawPreview(img){
  const W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.min(W/iw, H/ih);
  const nw = iw*scale, nh = ih*scale;
  const x = (W-nw)/2, y = (H-nh)/2;
  ctx.drawImage(img, x, y, nw, nh);
}

function canvasToGrayscale(ctx, w, h){
  const { data } = ctx.getImageData(0,0,w,h);
  const out = new Float32Array(w*h);
  for(let i=0, p=0; i<data.length; i+=4, p++){
    const r = data[i], g = data[i+1], b = data[i+2];
    out[p] = 0.2126*r + 0.7152*g + 0.0722*b;
  }
  return out;
}

function unique(arr){
  return [...new Set(arr)];
}

/* -----------------------------
   Crypto bits
------------------------------ */
async function signatureBits(secret, payload, bitCount){
  const msg = `${secret}|${payload}`;
  const enc = new TextEncoder().encode(msg);
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

function bitMatchScore(a, b){
  const n = Math.min(a.length, b.length);
  let ok = 0;
  for(let i=0;i<n;i++) if(a[i]===b[i]) ok++;
  return n ? ok/n : 0;
}

/* -----------------------------
   DWT (same as maker)
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

function extractBitFromCoeff(c, step){
  const q = Math.round(c / step);
  return q & 1;
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

function extractDWT(gray, N, bitCount, step){
  const bands = dwt2Haar(gray, N);
  const order = stableIndices(bands.LH, bands.HL);

  const total = bitCount;
  const nLH = Math.floor(total/2);
  const nHL = total - nLH;

  const bits = [];

  for(let i=0;i<nLH;i++){
    const idx = order[i % order.length];
    bits.push(extractBitFromCoeff(bands.LH[idx], step));
  }
  for(let i=0;i<nHL;i++){
    const idx = order[(i + 97) % order.length];
    bits.push(extractBitFromCoeff(bands.HL[idx], step));
  }
  return bits;
}
