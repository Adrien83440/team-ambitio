/* ═══════════════════════════════════════════════════════════════════════
   Bac à sable — remplaçants navigateur des modules Node utilisés par le
   code serveur empaqueté (Buffer, crypto, process). Source de
   scripts/build-sandbox-server.js : injecté en tête de sandbox-server.js.
   Seules les fonctions réellement appelées par api/* sont fournies.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Buffer : un Uint8Array qui sait se convertir ── */
class Buffer extends Uint8Array {
  static from(v, enc) {
    if (typeof v === 'string') {
      enc = String(enc || 'utf8').toLowerCase();
      if (enc === 'base64' || enc === 'base64url') {
        let s = v.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
        while (s.length % 4) s += '=';
        return Buffer._bin(atob(s));
      }
      if (enc === 'hex') {
        const n = Math.floor(v.length / 2), b = new Buffer(n);
        for (let i = 0; i < n; i++) b[i] = parseInt(v.substr(i * 2, 2), 16);
        return b;
      }
      if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return Buffer._bin(v);
      const u = new TextEncoder().encode(v), b = new Buffer(u.length);
      b.set(u); return b;
    }
    if (v instanceof ArrayBuffer) { const b = new Buffer(v.byteLength); b.set(new Uint8Array(v)); return b; }
    if (ArrayBuffer.isView(v)) { const b = new Buffer(v.byteLength); b.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return b; }
    if (Array.isArray(v)) { const b = new Buffer(v.length); b.set(v); return b; }
    throw new TypeError('Buffer.from : type non géré');
  }
  static _bin(s) { const b = new Buffer(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
  static alloc(n, fill) { const b = new Buffer(n); if (fill) b.fill(fill); return b; }
  static isBuffer(x) { return x instanceof Buffer; }
  static byteLength(s, enc) { return typeof s === 'string' ? Buffer.from(s, enc).length : s.byteLength; }
  static concat(list, total) {
    const n = total != null ? total : list.reduce(function (a, b) { return a + b.length; }, 0);
    const out = new Buffer(n); let o = 0;
    list.forEach(function (b) { out.set(b.subarray(0, Math.min(b.length, n - o)), o); o += b.length; });
    return out;
  }
  _binStr() { let s = ''; const C = 0x8000; for (let i = 0; i < this.length; i += C) s += String.fromCharCode.apply(null, this.subarray(i, i + C)); return s; }
  toString(enc, start, end) {
    const v = (start != null || end != null) ? this.subarray(start || 0, end == null ? this.length : end) : this;
    enc = String(enc || 'utf8').toLowerCase();
    if (enc === 'base64') return btoa(Buffer.prototype._binStr.call(v));
    if (enc === 'hex') { let s = ''; for (let i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16); return s; }
    if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return Buffer.prototype._binStr.call(v);
    return new TextDecoder().decode(v);
  }
  write(str, offset, enc) {
    if (typeof offset === 'string') { enc = offset; offset = 0; }
    const b = Buffer.from(str, enc || 'utf8'), o = offset || 0, n = Math.min(b.length, this.length - o);
    this.set(b.subarray(0, n), o); return n;
  }
  equals(o) { if (!o || o.length !== this.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
}

/* ── SHA-256 synchrone (crypto.createHash) ── */
const __K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function __sha256(bytes) {
  const l = bytes.length, bl = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(bl);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(bl - 4, (l * 8) >>> 0); dv.setUint32(bl - 8, Math.floor(l / 0x20000000));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let o = 0; o < bl; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + __K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Buffer(32), odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}
const __crypto = {
  createHash: function (alg) {
    if (String(alg).toLowerCase() !== 'sha256') throw new Error('Bac à sable : seul sha256 est disponible');
    const parts = [];
    const h = {
      update: function (d, enc) { parts.push(typeof d === 'string' ? Buffer.from(d, enc || 'utf8') : Buffer.from(d)); return h; },
      digest: function (enc) { const r = __sha256(Buffer.concat(parts)); return enc ? r.toString(enc) : r; }
    };
    return h;
  },
  randomBytes: function (n) { const b = new Buffer(n); crypto.getRandomValues(b); return b; },
  randomInt: function (min, max) {
    if (max === undefined) { max = min; min = 0; }
    const r = new Uint32Array(1); crypto.getRandomValues(r);
    return min + (r[0] % (max - min));
  },
  timingSafeEqual: function (a, b) { if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length'); let x = 0; for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i]; return x === 0; },
  randomUUID: function () { return crypto.randomUUID(); }
};

/* ── process : les variables d'environnement d'un serveur « bac à sable » ── */
const process = {
  env: {
    GOCARDLESS_ENVIRONMENT: 'sandbox', GOCARDLESS_ACCESS_TOKEN: 'bac-a-sable',
    APP_BASE_URL: location.origin, FIREBASE_ADMIN_PROJECT_ID: 'bac-a-sable'
  },
  version: 'v24-bac-a-sable', platform: 'browser', nextTick: function (fn) { Promise.resolve().then(fn); }
};
