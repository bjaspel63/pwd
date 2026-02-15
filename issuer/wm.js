// wm.js — watermark embed/extract in DWT bands (LH2 + HL2 + optional HH2)
// Uses pseudo-random coefficient positions + signs, spread over SAMPLES_PER_BIT.

const WM = (() => {
  // Must match in verifier
  const WATERMARK_SEED = "PWD-DWT-V1";
  const LEVELS = 2;

  // Tune these:
  const SAMPLES_PER_BIT = 7;   // how many coeff samples per bit
  const ALPHA = 2.4;           // watermark strength in coefficient units

  function xorshift32(seed){
    let x = seed >>> 0;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17; x >>>= 0;
      x ^= x << 5;  x >>>= 0;
      return x >>> 0;
    };
  }

  async function seedToU32(seedStr){
    const h = await CryptoUtil.sha256(CryptoUtil.enc.encode(seedStr));
    // take first 4 bytes
    return ((h[0]<<24)>>>0) + (h[1]<<16) + (h[2]<<8) + h[3];
  }

  function clamp255(v){ return v<0?0 : v>255?255 : v; }

  function channelToFloat(imgData, ch){
    const { data, width:w } = imgData;
    const out = new Float32Array(w * imgData.height);
    let p=0;
    for(let i=0;i<data.length;i+=4){
      out[p++] = data[i+ch];
    }
    return out;
  }

  function floatToChannel(imgData, ch, arr){
    const { data } = imgData;
    let p=0;
    for(let i=0;i<data.length;i+=4){
      data[i+ch] = clamp255(Math.round(arr[p++]));
    }
  }

  function regionIndices(w, x0,x1,y0,y1){
    const idx = [];
    for(let y=y0;y<y1;y++){
      for(let x=x0;x<x1;x++){
        idx.push(y*w+x);
      }
    }
    return idx;
  }

  async function embedBitsInBlue(imgData, bits){
    const w = imgData.width, h = imgData.height;

    if((w % 4)!==0 || (h % 4)!==0){
      throw new Error("Watermark region must be divisible by 4 (for 2-level DWT).");
    }

    const seed32 = await seedToU32(WATERMARK_SEED + `|${w}x${h}`);
    const rnd = xorshift32(seed32);

    // Take blue channel
    const blue = channelToFloat(imgData, 2);

    // DWT
    let coeff = DWT.dwt2D(blue, w, h, LEVELS);

    // Capacity pool: LH2 + HL2 + optional HH2
    const rLH = DWT.getSubbandLH2(w, h);
    const rHL = DWT.getSubbandHL2(w, h);
    const rHH = (typeof DWT.getSubbandHH2 === "function") ? DWT.getSubbandHH2(w, h) : null;

    const idxLH = regionIndices(w, rLH.x0,rLH.x1,rLH.y0,rLH.y1);
    const idxHL = regionIndices(w, rHL.x0,rHL.x1,rHL.y0,rHL.y1);

    let pool = idxLH.concat(idxHL);

    if(rHH){
      const idxHH = regionIndices(w, rHH.x0,rHH.x1,rHH.y0,rHH.y1);
      pool = pool.concat(idxHH);
    }

    const poolN = pool.length;

    const need = bits.length * SAMPLES_PER_BIT;
    if(need > poolN) {
      throw new Error(`Not enough DWT capacity. Need ${need} samples, have ${poolN}. Try bigger photo region or smaller payload.`);
    }

    // pick positions without replacement
    const used = new Uint8Array(poolN);

    function pickIndex(){
      for(let tries=0; tries<50000; tries++){
        const j = rnd() % poolN;
        if(!used[j]) { used[j]=1; return pool[j]; }
      }
      for(let j=0;j<poolN;j++){
        if(!used[j]) { used[j]=1; return pool[j]; }
      }
      throw new Error("No indices left");
    }

    for(let i=0;i<bits.length;i++){
      const b = bits[i] ? 1 : 0;
      const polarity = b ? 1 : -1;
      for(let k=0;k<SAMPLES_PER_BIT;k++){
        const pos = pickIndex();
        const pn = (rnd() & 1) ? 1 : -1;
        coeff[pos] += ALPHA * polarity * pn;
      }
    }

    // Inverse DWT
    const outBlue = DWT.idwt2D(coeff, w, h, LEVELS);
    floatToChannel(imgData, 2, outBlue);
    return imgData;
  }

  async function extractBitsFromBlue(imgData, bitCount){
    const w = imgData.width, h = imgData.height;

    if((w % 4)!==0 || (h % 4)!==0) throw new Error("Region must be divisible by 4.");

    const seed32 = await seedToU32(WATERMARK_SEED + `|${w}x${h}`);
    const rnd = xorshift32(seed32);

    const blue = channelToFloat(imgData, 2);
    let coeff = DWT.dwt2D(blue, w, h, LEVELS);

    const rLH = DWT.getSubbandLH2(w, h);
    const rHL = DWT.getSubbandHL2(w, h);
    const rHH = (typeof DWT.getSubbandHH2 === "function") ? DWT.getSubbandHH2(w, h) : null;

    const idxLH = regionIndices(w, rLH.x0,rLH.x1,rLH.y0,rLH.y1);
    const idxHL = regionIndices(w, rHL.x0,rHL.x1,rHL.y0,rHL.y1);

    let pool = idxLH.concat(idxHL);

    if(rHH){
      const idxHH = regionIndices(w, rHH.x0,rHH.x1,rHH.y0,rHH.y1);
      pool = pool.concat(idxHH);
    }

    const poolN = pool.length;

    const need = bitCount * SAMPLES_PER_BIT;
    if(need > poolN) throw new Error(`Not enough capacity for requested bits. Need ${need}, have ${poolN}.`);

    const used = new Uint8Array(poolN);

    function pickIndex(){
      for(let tries=0; tries<50000; tries++){
        const j = rnd() % poolN;
        if(!used[j]) { used[j]=1; return pool[j]; }
      }
      for(let j=0;j<poolN;j++){
        if(!used[j]) { used[j]=1; return pool[j]; }
      }
      throw new Error("No indices left");
    }

    const outBits = new Array(bitCount);

    for(let i=0;i<bitCount;i++){
      let score = 0;
      for(let k=0;k<SAMPLES_PER_BIT;k++){
        const pos = pickIndex();
        const pn = (rnd() & 1) ? 1 : -1;
        score += coeff[pos] * pn;
      }
      outBits[i] = score >= 0 ? 1 : 0;
    }

    return outBits;
  }

  return { WATERMARK_SEED, LEVELS, SAMPLES_PER_BIT, ALPHA, embedBitsInBlue, extractBitsFromBlue };
})();
