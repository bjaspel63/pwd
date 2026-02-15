// ecc.js — simple repetition code (v1)
// repeat each bit REP times; decode by majority vote.

const ECC = (() => {
  const REP = 3; // tune: 3 is a good start; higher = more robust but needs more capacity

  function bytesToBits(u8){
    const bits = [];
    for(const b of u8){
      for(let i=7;i>=0;i--) bits.push((b>>i)&1);
    }
    return bits;
  }
  function bitsToBytes(bits){
    const n = Math.ceil(bits.length/8);
    const out = new Uint8Array(n);
    for(let i=0;i<bits.length;i++){
      const byte = (i/8)|0;
      out[byte] = (out[byte]<<1) | (bits[i]&1);
      if(i%8===7) out[byte] &= 255;
    }
    // If bits.length not multiple of 8, left-shifted; fix by shifting remaining
    const rem = bits.length % 8;
    if(rem !== 0){
      out[n-1] <<= (8-rem);
      out[n-1] &= 255;
    }
    return out;
  }

  function encodeBytes(u8){
    const bits = bytesToBits(u8);
    const out = [];
    for(const bit of bits){
      for(let r=0;r<REP;r++) out.push(bit);
    }
    return out; // array of 0/1
  }

  function decodeBytes(repBits){
    // majority vote per REP group
    const bits = [];
    for(let i=0;i<repBits.length;i+=REP){
      let sum=0;
      for(let r=0;r<REP;r++) sum += (repBits[i+r] ? 1 : 0);
      bits.push(sum >= Math.ceil(REP/2) ? 1 : 0);
    }
    return bitsToBytes(bits);
  }

  return { REP, encodeBytes, decodeBytes };
})();
