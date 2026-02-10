// verify.js (VERIFIER) - Upload only, AUTO verify (no strength slider)
const $ = (id) => document.getElementById(id);

const PUBLIC_MARKER = "PWD-DWT-V1";

const fileEl = $("file");
const stepVal = $("stepVal");

const statusEl = $("status");
const meterEl = $("meter");
const barEl = $("bar");
const detailsText = $("detailsText");

const cv = $("cv");
const ctx = cv.getContext("2d", { willReadFrequently:true });

// Must match maker
const CARD_W = 1016;
const CARD_H = 638;

const TOP_H = 92;
const PHOTO_X = 26;
const PHOTO_Y = TOP_H + 24; // 116
const PHOTO_W = 300;
const PHOTO_H = 360;

const DWT_N = 256;

let blueForExtract = null;
let autoStep = 18;

stepVal.textContent = `auto: —`;

fileEl.addEventListener("change", async () => {
  const f = fileEl.files?.[0];
  if(!f) return;

  const img = await fileToImage(f);

  // Draw uploaded image to a fixed-size canvas (match maker)
  const base = document.createElement("canvas");
  base.width = CARD_W;
  base.height = CARD_H;
  const bctx = base.getContext("2d", { willReadFrequently:true });
  bctx.drawImage(img, 0, 0, CARD_W, CARD_H);

  // Preview
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.drawImage(base, 0, 0, cv.width, cv.height);

  // AUTO strength (same logic as maker)
  autoStep = autoStrengthFromPhotoRegionCanvas(bctx);
  stepVal.textContent = `auto: ${autoStep}`;

  // Crop photo region
  const region = bctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);

  // Resize to DWT_N x DWT_N
  const tmp = document.createElement("canvas");
  tmp.width = PHOTO_W; tmp.height = PHOTO_H;
  const tctx = tmp.getContext("2d", { willReadFrequently:true });
  tctx.putImageData(region, 0, 0);

  const sq = document.createElement("canvas");
  sq.width = sq.height = DWT_N;
  const sctx = sq.getContext("2d", { willReadFrequently:true });
  sctx.drawImage(tmp, 0, 0, DWT_N, DWT_N);

  // Extract BLUE channel float array
  const data = sctx.getImageData(0, 0, DWT_N, DWT_N).data;
  blueForExtract = new Float32Array(DWT_N * DWT_N);
  for(let p=0, i=0; p<blueForExtract.length; p++, i+=4){
    blueForExtract[p] = data[i+2];
  }

  setStatus("Image loaded. Verifying…", "ok");
  setMeter(null);

  await doVerify();
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

/* -----------------------------
   AUTO strength — matches maker
------------------------------ */
function autoStrengthFromPhotoRegionCanvas(bctx){
  const data = bctx.getImageData(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H).data;

  let energy = 0;
  const w = PHOTO_W, h = PHOTO_H;

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

  const norm = energy / (samples * 2 * 255);
  const step = Math.round(26 - norm * 14);
  return Math.max(12, Math.min(26, step));
}

async function doVerify(){
  if(!blueForExtract){
    setStatus("Upload an image to begin.", "bad");
    setMeter(null);
    detailsText.textContent = "";
    return;
  }

  const expected = await publicMarkerBits(256);

  // Try a range around auto strength
  const base = autoStep;
  const steps = unique([
    base-4, base-3, base-2, base-1,
    base,
    base+1, base+2, base+3, base+4
  ].filter(s => s>=6 && s<=30));

  let best = { score: 0, step: base };

  for(const st of steps){
    const extracted = extractDWT(blueForExtract, DWT_N, expected.length, st);
    const score = bitMatchScore(expected, extracted);
    if(score > best.score) best = { score, step: st };
  }

  const pct = Math.round(best.score * 100);
  setMeter(best.score);

  if(best.score >= 0.85){
    setStatus(`Verified ✅ Match: ${pct}%`, "ok");
  } else {
    setStatus(`Not verified ❌ Match: ${pct}%`, "bad");
  }

  detailsText.textContent = `Best match ${pct}% at strength ${best.step}.`;
}

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
  barEl.style.width = `${Math.round(score*100)}%`;
}

function bitMatchScore(a, b){
  const n = Math.min(a.length, b.length);
  let ok = 0;
  for(let i=0;i<n;i++) if(a[i]===b[i]) ok++;
  return n ? ok/n : 0;
}
function unique(arr){ return [...new Set(arr)]; }

/* -----------------------------
   image helper
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

/* -----------------------------
   DWT extract (same scheme as maker)
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

  const REPS = 7;
  const total = bitCount;
  const nLH = Math.floor(total/2);
  const nHL = total - nLH;

  const bits = [];

  // majority vote helper
  const vote = (arr) => {
    let ones = 0;
    for(const b of arr) ones += (b ? 1 : 0);
    return ones >= Math.ceil(arr.length/2) ? 1 : 0;
  };

  for(let i=0;i<nLH;i++){
    const reads = [];
    for(let r=0;r<REPS;r++){
      const idx = order[(i*REPS + r) % order.length];
      reads.push(extractBitFromCoeff(bands.LH[idx], step));
    }
    bits.push(vote(reads));
  }

  for(let i=0;i<nHL;i++){
    const reads = [];
    for(let r=0;r<REPS;r++){
      const idx = order[((i*REPS + r) + 97) % order.length];
      reads.push(extractBitFromCoeff(bands.HL[idx], step));
    }
    bits.push(vote(reads));
  }

  return bits;
}

