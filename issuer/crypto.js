// crypto.js — Ed25519 (WebCrypto) + helpers

const CryptoUtil = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToHex(u8){
    return [...u8].map(b => b.toString(16).padStart(2,'0')).join('');
  }
  function hexToBytes(hex){
    const clean = hex.replace(/[^0-9a-f]/gi,'').toLowerCase();
    if(clean.length % 2) throw new Error("Hex length must be even");
    const out = new Uint8Array(clean.length/2);
    for(let i=0;i<out.length;i++){
      out[i]=parseInt(clean.slice(i*2,i*2+2),16);
    }
    return out;
  }
  function randBytes(n){
    const u8 = new Uint8Array(n);
    crypto.getRandomValues(u8);
    return u8;
  }

  async function sha256(u8){
    const buf = await crypto.subtle.digest("SHA-256", u8);
    return new Uint8Array(buf);
  }

  // Compact payload (binary) for stable decoding:
  // issuer_id (2 bytes) + card_id (16 bytes) + exp_days (4 bytes) + version (1 byte) + name_hash (16 bytes)
  // total 39 bytes
  function dateToDays(yyyy_mm_dd){
    // days since 1970-01-01 UTC
    const [y,m,d] = yyyy_mm_dd.split("-").map(Number);
    const ms = Date.UTC(y,m-1,d);
    return Math.floor(ms / 86400000);
  }
  function u32ToBytes(n){
    const b = new Uint8Array(4);
    b[0]=(n>>>24)&255; b[1]=(n>>>16)&255; b[2]=(n>>>8)&255; b[3]=n&255;
    return b;
  }
  function u16ToBytes(n){
    const b = new Uint8Array(2);
    b[0]=(n>>>8)&255; b[1]=n&255;
    return b;
  }
  function bytesToU16(b0,b1){ return (b0<<8)|b1; }
  function bytesToU32(b0,b1,b2,b3){ return ((b0<<24)>>>0) + (b1<<16) + (b2<<8) + b3; }

  async function buildPayload({issuerId, cardId16, expDate, version=1, fullName=""}){
    const issuer = u16ToBytes(issuerId);
    const expDays = u32ToBytes(dateToDays(expDate));
    const nameHashFull = await sha256(enc.encode(fullName.trim().toLowerCase()));
    const nameHash16 = nameHashFull.slice(0,16);

    const out = new Uint8Array(2 + 16 + 4 + 1 + 16);
    let p=0;
    out.set(issuer,p); p+=2;
    out.set(cardId16,p); p+=16;
    out.set(expDays,p); p+=4;
    out[p++] = version & 255;
    out.set(nameHash16,p); p+=16;
    return out;
  }

  // Token format:
  // payload_len (2 bytes big-endian) + payload + signature(64)
  function buildToken(payloadBytes, signatureBytes){
    const len = payloadBytes.length;
    const out = new Uint8Array(2 + len + signatureBytes.length);
    out[0]=(len>>>8)&255; out[1]=len&255;
    out.set(payloadBytes,2);
    out.set(signatureBytes,2+len);
    return out;
  }

  function parseToken(tokenBytes){
    if(tokenBytes.length < 2+64) throw new Error("Token too short");
    const len = bytesToU16(tokenBytes[0], tokenBytes[1]);
    const need = 2 + len + 64;
    if(tokenBytes.length < need) throw new Error("Token truncated");
    const payload = tokenBytes.slice(2,2+len);
    const sig = tokenBytes.slice(2+len, 2+len+64);
    return { payload, sig };
  }

  // Decode payload fields (for displaying in verifier)
  function decodePayload(payload){
    if(payload.length !== 39) throw new Error("Unexpected payload size");
    const issuerId = bytesToU16(payload[0],payload[1]);
    const cardId = bytesToHex(payload.slice(2,18));
    const expDays = bytesToU32(payload[18],payload[19],payload[20],payload[21]);
    const version = payload[22];
    const nameHash = bytesToHex(payload.slice(23,39));
    // convert days to date
    const ms = expDays * 86400000;
    const dt = new Date(ms);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth()+1).padStart(2,'0');
    const dd = String(dt.getUTCDate()).padStart(2,'0');
    const expDate = `${yyyy}-${mm}-${dd}`;
    return { issuerId, cardId, expDate, version, nameHash };
  }

  async function generateEd25519Keypair(){
    // Ed25519 in WebCrypto (modern browsers). If this fails, you’ll need a polyfill/lib.
    return await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign","verify"]
    );
  }

  async function exportPublicKeyRaw(keypair){
    // Export raw public key (32 bytes)
    const raw = await crypto.subtle.exportKey("raw", keypair.publicKey);
    return new Uint8Array(raw);
  }

  async function exportPrivateKeyPkcs8(keypair){
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keypair.privateKey);
    return new Uint8Array(pkcs8);
  }

  async function importPublicKeyRaw(raw32){
    return await crypto.subtle.importKey(
      "raw",
      raw32,
      { name: "Ed25519" },
      true,
      ["verify"]
    );
  }

  async function signEd25519(privateKey, msgBytes){
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, msgBytes);
    return new Uint8Array(sig);
  }

  async function verifyEd25519(publicKey, msgBytes, sigBytes){
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, sigBytes, msgBytes);
  }

  function u8ToB64(u8){
    let s=""; for(const b of u8) s+=String.fromCharCode(b);
    return btoa(s);
  }
function b64ToU8(b64){
  let s = String(b64 || "").trim();

  s = s.replace(/\s+/g, "");
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad !== 0) throw new Error("Invalid base64 length");

  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
  return {
    enc, dec,
    bytesToHex, hexToBytes, randBytes,
    sha256,
    buildPayload, buildToken, parseToken, decodePayload,
    generateEd25519Keypair, exportPublicKeyRaw, exportPrivateKeyPkcs8,
    importPublicKeyRaw, signEd25519, verifyEd25519,
    u8ToB64, b64ToU8
  };
})();
