// dwt.js — 2D Haar DWT (supports 2 levels if dims divisible by 4)

const DWT = (() => {
  function haar1D(arr){
    const n = arr.length;
    const out = new Float32Array(n);
    const half = n>>1;
    for(let i=0;i<half;i++){
      const a = arr[2*i];
      const b = arr[2*i+1];
      out[i] = (a+b)/2;
      out[half+i] = (a-b)/2;
    }
    return out;
  }

  function ihaar1D(arr){
    const n = arr.length;
    const out = new Float32Array(n);
    const half = n>>1;
    for(let i=0;i<half;i++){
      const s = arr[i];
      const d = arr[half+i];
      out[2*i]   = s + d;
      out[2*i+1] = s - d;
    }
    return out;
  }

  function dwt2D(mat, w, h, levels=2){
    // mat is Float32Array length w*h, row-major
    let cur = mat.slice();
    let cw=w, ch=h;

    for(let lv=0; lv<levels; lv++){
      // rows
      for(let y=0;y<ch;y++){
        const row = new Float32Array(cw);
        const base = y*w;
        for(let x=0;x<cw;x++) row[x]=cur[base+x];
        const tr = haar1D(row);
        for(let x=0;x<cw;x++) cur[base+x]=tr[x];
      }
      // cols
      for(let x=0;x<cw;x++){
        const col = new Float32Array(ch);
        for(let y=0;y<ch;y++) col[y]=cur[y*w + x];
        const tc = haar1D(col);
        for(let y=0;y<ch;y++) cur[y*w + x]=tc[y];
      }
      cw >>= 1; ch >>= 1;
    }
    return cur;
  }

  function idwt2D(coeff, w, h, levels=2){
    let cur = coeff.slice();
    let cw = w >> (levels-1);
    let ch = h >> (levels-1);

    for(let lv=levels-1; lv>=0; lv--){
      // cols inverse on region cw x ch
      for(let x=0;x<cw;x++){
        const col = new Float32Array(ch);
        for(let y=0;y<ch;y++) col[y]=cur[y*w + x];
        const ic = ihaar1D(col);
        for(let y=0;y<ch;y++) cur[y*w + x]=ic[y];
      }
      // rows inverse
      for(let y=0;y<ch;y++){
        const row = new Float32Array(cw);
        const base = y*w;
        for(let x=0;x<cw;x++) row[x]=cur[base+x];
        const ir = ihaar1D(row);
        for(let x=0;x<cw;x++) cur[base+x]=ir[x];
      }
      cw <<= 1; ch <<= 1;
    }
    return cur;
  }

  function getSubbandLH2(w, h){
  // After 2-level Haar DWT:
  // Level-1 quadrants are size (w/2 x h/2)
  // Level-2 detail subbands live INSIDE the LL1 (top-left w/2 x h/2) region:
  // LH2: x in [w/4, w/2), y in [0, h/4)
  const x0 = (w >> 2), x1 = (w >> 1);
  const y0 = 0,        y1 = (h >> 2);
  return { x0, x1, y0, y1 };
}

function getSubbandHL2(w, h){
  // HL2: x in [0, w/4), y in [h/4, h/2)
  const x0 = 0,        x1 = (w >> 2);
  const y0 = (h >> 2), y1 = (h >> 1);
  return { x0, x1, y0, y1 };
}

function getSubbandHH2(w, h){
  // HH2: x in [w/4, w/2), y in [h/4, h/2)
  const x0 = (w >> 2), x1 = (w >> 1);
  const y0 = (h >> 2), y1 = (h >> 1);
  return { x0, x1, y0, y1 };
}


  return { dwt2D, idwt2D, getSubbandLH2, getSubbandHL2,getSubbandHH2 };
})();
