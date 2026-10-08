/* ═══════════════════════════════════════════════════════════════════════
   sandbox-server.js — GÉNÉRÉ par scripts/build-sandbox-server.js.
   NE PAS ÉDITER : relancer `node scripts/build-sandbox-server.js`.
   Le vrai code serveur (api/*) empaqueté pour le bac à sable closer,
   branché sur la fausse base et des services simulés. Rien ne sort.
   Modules : ./api/sign-session.js, ./api/_parseBody.js, ./api/_sign-core.js, ./api/_companyLookup.js, ./api/_sign-pdf.js, ./api/_contract-render.js, ./api/_sign-brand.js, ./api/signature-otp.js, ./api/_twilioClient.js, ./api/signature-send-link.js, ./api/_verifyFirebaseAuth.js, ./api/signature-completed.js, ./api/gocardless-billing-request.js, ./api/gocardless-finalize.js, ./api/gocardless-payment.js, ./api/payments-send-mandate-sms.js, ./api/payments-send-mandate-email.js
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
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

/* ═══════════════════════════════════════════════════════════════════════
   Bac à sable — les services externes du code serveur, simulés.
   Source de scripts/build-sandbox-server.js. Remplace, pour le code api/*
   empaqueté : firebase-admin (→ sandbox-db.js), Twilio, Gmail, Ringover,
   l'horodatage RFC 3161, l'annuaire des entreprises et l'API GoCardless.
   RÈGLE : rien ne sort. Les SMS et e-mails arrivent dans le téléphone
   simulé (store.host.deliver) ; tout appel réseau non prévu est REFUSÉ.
   ═══════════════════════════════════════════════════════════════════════ */

function __store() { return window.top.__SBX_STORE; }
function __host() { const h = __store().host; if (!h) throw new Error('Bac à sable non initialisé'); return h; }
function __admin() { if (!__store().__admin) __store().__admin = window.SBXDB.admin(); return __store().__admin; }
function __firstUrl(s) { const m = String(s || '').match(/https?:\/\/[^\s<>"')]+/); return m ? m[0] : ''; }
function __id(prefix) { return prefix + Math.random().toString(36).slice(2, 10).toUpperCase() + Date.now().toString(36).slice(-4).toUpperCase(); }

/* ── Messagerie simulée ── */
function __deliver(o) {
  try { __host().deliver(o); } catch (e) { console.warn('[bac à sable] dépôt du message', e && e.message); }
}

const __shim = {};

__shim['firebase-admin'] = new Proxy({}, { get: function (t, k) { return __admin()[k]; } });
__shim['./_firebaseAdmin'] = {
  get admin() { return __admin(); },
  get db() { return __admin().firestore(); },
  storage: null
};

/* Twilio : messages.create dépose le SMS ; le rappel de statut est simulé
   comme api/twilio-sms-status.js l'écrirait (signature_otp/{reqId}). */
__shim['twilio'] = function () {
  return {
    messages: Object.assign(function (sid) { return { fetch: function () { return Promise.resolve({ sid: sid, status: 'delivered' }); } }; }, {
      create: async function (o) {
        const sid = __id('SM');
        __deliver({ channel: 'sms', to: o.to, from: o.from || 'Ambitio', text: o.body || '', url: __firstUrl(o.body) });
        const m = String(o.statusCallback || '').match(/[?&]reqId=([^&]+)/);
        if (m) {
          const reqId = decodeURIComponent(m[1]);
          setTimeout(function () {
            __admin().firestore().collection('signature_otp').doc(reqId).set({ livraison: { sid: sid, statut: 'delivered', echec: false, errorCode: null, explication: '', at: Date.now() } }, { merge: true }).catch(function () {});
          }, 1500);
        }
        return { sid: sid, status: 'queued', to: o.to, from: o.from };
      }
    })
  };
};

/* Gmail (deux helpers historiques) : l'e-mail arrive dans la boîte simulée. */
function __mail(to, subject, text, html, attachments) {
  const body = text || String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').trim();
  (Array.isArray(to) ? to : [to]).forEach(function (dest) {
    __deliver({ channel: 'email', to: dest, from: 'Ambitio <contact@adrienemily.com>', subject: subject || '', text: body, url: __firstUrl(body + ' ' + (html || '')), attachments: (attachments || []).map(function (a) { return a.filename; }) });
  });
}
__shim['./_billing-gmail'] = {
  sendGmailWithAttachment: async function (o) { __mail(o.to, o.subject, o.bodyText, o.bodyHtml, o.attachments); return { messageId: __id('GM'), threadId: __id('TH') }; },
  getValidAccessToken: async function () { return 'bac-a-sable'; },
  encodeRfc2047: function (s) { return s; },
  plainToHtml: function (s) { return String(s || '').replace(/\n/g, '<br>'); }
};
__shim['./_gmailSend'] = {
  sendEmailFromAccount: async function (o) { __mail(o.to, o.subject, o.bodyText, o.bodyHtml, o.attachments); return { ok: true, messageId: __id('GM') }; }
};

/* Ringover (SMS du lien mandat). */
__shim['./_ringoverClient'] = {
  getRingoverCreds: async function () { return { fromNumber: '+33939240397', apiKey: 'bac-a-sable' }; },
  getRingoverCredsForUser: async function () { return { fromNumber: '+33939240397', apiKey: 'bac-a-sable' }; },
  ringoverFetch: async function (path, o) {
    if (path === '/push/sms') {
      const b = (o && o.body) || {};
      __deliver({ channel: 'sms', to: b.to_number, from: b.from_number || 'Ambitio', text: b.content || '', url: __firstUrl(b.content) });
      return { message_id: __id('RO') };
    }
    throw new Error('Ringover ' + path + ' : bloqué par le bac à sable');
  }
};

/* Horodatage RFC 3161 : jamais d'appel à une autorité réelle. Le code
   serveur sait déjà vivre sans sceau (il le note au dossier de preuve). */
__shim['./_tsa'] = {
  timestamp: async function () { throw new Error('Horodatage désactivé dans le bac à sable'); },
  AUTHORITIES: []
};

__shim['pdf-lib'] = window.PDFLib;
__shim['@pdf-lib/fontkit'] = window.fontkit;

/* ═══ GoCardless simulé (API v2015-07-06, sous-ensemble utilisé) ═══════
   État dans la fausse base : _sandbox_gc/{id}. La page de mandat
   (sandbox-gc.html) appelle __SBX_SERVER.gc.complete() quand le client
   valide son IBAN ; les « webhooks » sont rejoués par sandbox-core.js. */
const __gc = {
  col: function () { return __admin().firestore().collection('_sandbox_gc'); },
  put: function (id, d) { return __gc.col().doc(id).set(d, { merge: true }).then(function () { return d; }); },
  get: function (id) { return __gc.col().doc(id).get().then(function (s) { return s.exists ? s.data() : null; }); },
  plusDays: function (n) { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); },
  handle: async function (method, path, body) {
    let m;
    if (method === 'POST' && path === '/billing_requests') {
      const id = __id('BRQ000');
      const br = { kind: 'billing_request', id: id, status: 'pending', created_at: new Date().toISOString(), metadata: (body.billing_requests || {}).metadata || {}, mandate_request: (body.billing_requests || {}).mandate_request || {}, links: {} };
      await __gc.put(id, br);
      return { status: 201, json: { billing_requests: br } };
    }
    if (method === 'POST' && path === '/billing_request_flows') {
      const id = __id('BRF000'), f = body.billing_request_flows || {};
      const flow = { kind: 'flow', id: id, authorisation_url: 'https://pay.gocardless.com/billing/static/flow?id=' + id, prefilled_customer: f.prefilled_customer || {}, redirect_uri: f.redirect_uri || '', exit_uri: f.exit_uri || '', links: f.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, flow);
      return { status: 201, json: { billing_request_flows: flow } };
    }
    if (method === 'GET' && (m = path.match(/^\/billing_requests\/([A-Za-z0-9]+)$/))) {
      const br = await __gc.get(m[1]);
      return br ? { status: 200, json: { billing_requests: br } } : { status: 404, json: { error: { message: 'Resource not found', code: 404 } } };
    }
    if (method === 'GET' && (m = path.match(/^\/mandates\/([A-Za-z0-9]+)$/))) {
      const md = await __gc.get(m[1]);
      return md ? { status: 200, json: { mandates: md } } : { status: 404, json: { error: { message: 'Resource not found', code: 404 } } };
    }
    if (method === 'POST' && path === '/payments') {
      const p = body.payments || {}, id = __id('PM00');
      const pm = { kind: 'payment', id: id, amount: p.amount, currency: p.currency, description: p.description, status: 'pending_submission', charge_date: __gc.plusDays(3), links: p.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, pm);
      return { status: 201, json: { payments: pm } };
    }
    if (method === 'POST' && path === '/subscriptions') {
      const s = body.subscriptions || {}, id = __id('SB00');
      const sb = { kind: 'subscription', id: id, amount: s.amount, currency: s.currency, interval_unit: s.interval_unit, interval: s.interval, count: s.count, start_date: s.start_date, name: s.name, status: 'active', paid: 0, links: s.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, sb);
      return { status: 201, json: { subscriptions: sb } };
    }
    return { status: 400, json: { error: { message: 'Endpoint GoCardless non simulé : ' + method + ' ' + path, code: 400 } } };
  },
  /* Le client a validé son IBAN sur la page de mandat. */
  complete: async function (flowId, info) {
    const flow = await __gc.get(flowId);
    if (!flow) throw new Error('Lien GoCardless inconnu');
    const br = await __gc.get(flow.links.billing_request);
    if (!br) throw new Error('Demande GoCardless introuvable');
    if (br.status === 'fulfilled') return br;
    const cu = __id('CU00'), md = __id('MD00');
    await __gc.put(md, { kind: 'mandate', id: md, status: 'pending_submission', scheme: 'sepa_core', next_possible_charge_date: __gc.plusDays(3), created_at: new Date().toISOString(), links: { customer: cu }, iban: info.ibanMasked, holder: info.holder });
    await __gc.put(cu, { kind: 'customer', id: cu, given_name: info.given_name, family_name: info.family_name, email: info.email, company_name: info.company_name || '', address_line1: info.address_line1, postal_code: info.postal_code, city: info.city, country_code: 'FR' });
    br.status = 'fulfilled'; br.links = { customer: cu, mandate_request_mandate: md }; br.fulfilled_at = new Date().toISOString();
    await __gc.put(br.id, br);
    return br;
  }
};

/* ═══ Annuaire des entreprises simulé (format de l'API DINUM) ═════════ */
function __registry(q) {
  const list = (__host().registry && __host().registry(q)) || [];
  return { results: list, total_results: list.length, page: 1, per_page: 10, total_pages: 1 };
}

/* ═══ fetch du « serveur » : rien ne sort, sauf les polices du PDF ═════ */
async function __sbxFetch(url, opts) {
  url = String(url && url.url ? url.url : url);
  opts = opts || {};
  const method = String(opts.method || 'GET').toUpperCase();
  let u;
  try { u = new URL(url, location.origin); } catch (e) { throw new Error('URL invalide : ' + url); }
  function resp(status, json) {
    return new Response(JSON.stringify(json), { status: status, headers: { 'Content-Type': 'application/json' } });
  }
  if (/gocardless\.com$/.test(u.hostname)) {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const r = await __gc.handle(method, u.pathname, body);
    return resp(r.status, r.json);
  }
  if (u.hostname === 'recherche-entreprises.api.gouv.fr') {
    return resp(200, __registry(u.searchParams.get('q') || ''));
  }
  /* Polices du PDF composé (Source Serif 4, Montserrat) : simples
     téléchargements de fichiers publics, sans aucun effet. */
  if (method === 'GET' && (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'raw.githubusercontent.com' || u.hostname === 'fonts.gstatic.com')) {
    return window.fetch.__sbxNative ? window.fetch.__sbxNative(url, opts) : window.fetch(url, opts);
  }
  throw new Error('Bloqué par le bac à sable : ' + u.hostname + u.pathname);
}

var fetch = __sbxFetch;
const __defs = {}, __cache = {};
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  const def = __defs[id];
  if (!def) throw new Error("Bac à sable : module " + id + " non empaqueté");
  const module = { exports: {} };
  __cache[id] = module;
  def.fn(module, module.exports, function (r) { return __resolveReq(def, r); });
  return module.exports;
}
function __resolveReq(def, r) {
  if (def.shims[r] !== undefined) return def.shims[r]();
  if (def.map[r]) return __require(def.map[r]);
  throw new Error("Bac à sable : require(" + r + ") non disponible");
}

/* ── ./api/sign-session.js ── */
__defs["./api/sign-session.js"] = { map: {"./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js","./_companyLookup":"./api/_companyLookup.js","./_sign-pdf":"./api/_sign-pdf.js","./_contract-render":"./api/_contract-render.js"}, shims: {"crypto": function () { return __crypto; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_tsa": function () { return __shim['./_tsa']; }, "pdf-lib": function () { return __shim['pdf-lib']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/sign-session.js — LA PAGE DE SIGNATURE PARLE UNIQUEMENT À CET ENDPOINT
// ----------------------------------------------------------------------------
// POST /api/sign-session   { action, token, ... }
//
//   load     → état du lien (avant code SMS) : à signer, déjà signé, en attente
//   content  → contrat + formulaire à remplir           (code SMS validé)
//   events   → journal des actions du signataire        (code SMS validé)
//   company  → recherche SIRET / SIREN / raison sociale (code SMS validé)
//   pdf      → le PDF original du modèle, pour lecture  (code SMS validé)
//   preview  → le contrat rempli, filigrané « APERÇU »  (code SMS validé)
//   submit   → validation + PDF signé + dossier de preuve + sceau
//   signed   → télécharger le contrat signé (après signature)
//
// POURQUOI UN ENDPOINT UNIQUE ET PAS FIRESTORE
// Avant, sign.html lisait et écrivait signature_requests directement, avec des
// règles ouvertes à tous (lecture ET modification sans compte). N'importe qui
// pouvait lire tous les contrats et réécrire un contrat signé : indéfendable
// devant un juge. Désormais le navigateur du signataire ne touche plus la
// base : il présente le token de son lien, le serveur vérifie, valide tout ce
// qui est saisi, écrit le journal de preuve, fabrique et scelle le PDF.
//
// Le token ne sert jamais à choisir un destinataire ni un numéro : tout ce qui
// part (SMS, e-mail) vient du document Firestore.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const core = require('./_sign-core');
const company = require('./_companyLookup');
const { buildPreviewPdf, buildSignedPdf, finishSigned, EVENT_LABELS } = require('./_sign-pdf');
const render = require('./_contract-render');
const { timestamp } = require('./_tsa');

/* Événements que la page peut journaliser. Tout le reste est ignoré : le
   journal ne doit contenir que des actions qui ont un sens probatoire. */
const CLIENT_EVENTS = {
  section_vue: 1, lecture_terminee: 1, lecture_declaree: 1, pdf_original_ouvert: 1, page_pdf_vue: 1,
  etape: 1, entreprise_selectionnee: 1, entreprise_manuelle: 1, representant_saisi: 1,
  case_cochee: 1, case_decochee: 1, champ_rempli: 1, mention_saisie: 1, paraphe_saisi: 1,
  signature_tracee: 1, signature_effacee: 1, signature_saisie: 1, signature_mode: 1, consentement: 1,
  page_masquee: 1, page_visible: 1,
};

const QUALITES = ['Gérant', 'Co-gérant', 'Président', 'Directeur général', 'Directeur général délégué', 'Associé', 'Mandataire habilité', 'Entrepreneur individuel'];

const DECLARATIONS = {
  pouvoir: 'Je certifie être habilité(e) à engager la société désignée ci-dessus et signer le présent contrat en son nom.',
  esign: 'J\'accepte de signer ce contrat électroniquement. Je reconnais que ma signature électronique a la même valeur qu\'une signature manuscrite et m\'engage au même titre.',
};

function send(res, status, obj) { res.status(status).json(obj); }

function roleOf(i) { return i >= 1 ? 2 : 1; }

/* Résumé de données client pour le journal : jamais plus de 600 caractères,
   jamais d'objet imbriqué arbitraire. */
function smallData(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  Object.keys(d).slice(0, 10).forEach(function (k) {
    const v = d[k];
    if (v === null || v === undefined) return;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v).slice(0, 200);
  });
  const s = JSON.stringify(out);
  return s.length > 600 ? { tronque: s.slice(0, 590) } : out;
}

function pngFromDataUrl(s, maxBytes) {
  const raw = String(s || '').replace(/^data:image\/png;base64,/, '');
  if (!raw || raw.length > maxBytes * 1.4) return null;
  const b = Buffer.from(raw, 'base64');
  if (b.length < 100 || b.length > maxBytes) return null;
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return b;
}

/* Les champs du modèle (instantané pris à l'envoi), dédoublonnés : « Nom
   Prénom » posé trois fois se remplit une fois ; une case ou un texte libre
   est une exigence par champ. */
/* Un champ « rempli par l'équipe » (le conseiller, dans la fenêtre d'envoi) :
   formule de paiement, nombre de mensualités… Marqué sur le champ du modèle
   (filledBy, éditeur sales-signatures) ou dans la version web (fieldHints). */
function isEquipe(f, h) { return (f && f.filledBy === 'equipe') || (h && h.filledBy === 'equipe'); }

/* Date à partir de laquelle l'accompagnement peut démarrer sans renonciation :
   le délai de 14 jours court à compter de la conclusion (aujourd'hui) ; il
   expire à la fin du 14e jour, le démarrage est donc possible le 15e. */
function startNoWaiver() {
  const p = core.parisToday().split('/');
  const d = new Date(Date.UTC(+p[2], +p[1] - 1, +p[0] + 15));
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

function formSpec(fields, role, hints, prefill) {
  const seen = {};
  const checks = [];
  const texts = [];
  const conditions = [];
  let paraphe = false;
  let dateField = false;
  let signature = false;
  (fields || []).forEach(function (f) {
    const r = f.signerRole === 2 ? 2 : 1;
    const h = (hints && hints[f.id]) || {};
    if (f.fieldType === 'texte_libre') {
      if (seen[f.id]) return; seen[f.id] = 1;
      const equipe = isEquipe(f, h);
      const pre = prefill && prefill[f.id] ? String(prefill[f.id]) : '';
      if (r !== role && !pre) return;
      texts.push({
        id: f.id, label: h.label || (f.label && f.label !== 'Texte libre' ? f.label : 'Texte libre'),
        help: h.help || '', required: !equipe && f.required === true && r === role,
        locked: equipe || !!pre, value: pre, maxLength: h.maxLength || 500,
      });
      return;
    }
    if (f.fieldType === 'case_cocher' && isEquipe(f, h)) {
      if (seen[f.id]) return; seen[f.id] = 1;
      conditions.push({ id: f.id, label: h.label || f.label || 'Option', group: h.group || f.group || '', value: !!(prefill && prefill[f.id] === true) });
      return;
    }
    if (r !== role) return;
    if (f.fieldType === 'case_cocher') {
      if (seen[f.id]) return; seen[f.id] = 1;
      const label = h.label || (f.label && f.label !== 'Case à cocher' ? f.label : 'Case à cocher');
      checks.push({
        id: f.id, label: label, help: h.help || '',
        required: h.required === false ? false : f.required !== false,
        kind: h.kind || (/renonce/i.test(label) && /r[ée]tractation/i.test(label) ? 'renonciation' : ''),
      });
      return;
    }
    if (f.fieldType === 'paraphe') paraphe = true;
    if (f.fieldType === 'date_signature') dateField = true;
    if (f.fieldType === 'signature') signature = true;
  });
  return { checks: checks, texts: texts, conditions: conditions, paraphe: paraphe, dateField: dateField, signatureField: signature };
}

/* Contrats de l'atelier (texte, generated:true) : le formulaire se déduit des
   variables et des cases du texte, plus des champs posés sur un PDF. */
function genSpec(web, prefill) {
  prefill = prefill || {};
  const vars = web.variables || [];
  const texts = vars.filter(function (v) { return v.filledBy === 'client'; }).map(function (v) {
    return { id: v.key, label: v.label, help: v.help || '', required: !!v.required, locked: false, value: '', maxLength: 500 };
  }).concat(vars.filter(function (v) { return v.filledBy !== 'client' && v.type !== 'choice'; }).map(function (v) {
    return { id: v.key, label: v.label, help: v.help || '', required: false, locked: true, value: render.formatVar(v, prefill[v.key]), maxLength: 500 };
  }));
  const conditions = vars.filter(function (v) { return v.filledBy !== 'client' && v.type === 'choice' && prefill[v.key]; }).map(function (v) {
    return { id: v.key, label: v.label + ' : ' + render.formatVar(v, prefill[v.key]), group: '', value: true };
  });
  const checks = (web.clientChecks || []).map(function (c) {
    return { id: c.id, label: c.label, help: '', required: !!c.required, kind: c.kind || '' };
  });
  return { checks: checks, texts: texts, conditions: conditions, paraphe: true, dateField: true, signatureField: true };
}
function specFor(ctx, role) {
  return ctx.generated ? genSpec(ctx.web, ctx.prefill) : formSpec(ctx.fields, role, ctx.hints, ctx.prefill);
}
/* Données client pour composer un contrat de l'atelier. */
function clientMap(d) {
  const c = d.company || {};
  const a = c.address || {};
  return {
    entreprise: c.name || '', nom_prenom: (d.rep && d.rep.full) || '', qualite: (d.rep && d.rep.qualite) || '',
    prenom: (d.rep && d.rep.first) || '', nom: (d.rep && d.rep.last) || '',
    siege_social: c.addressLine || company.addressLine(a), siret: c.siret || '', siren: c.siren || String(c.siret || '').slice(0, 9),
    tva: c.vatNumber || '', forme_juridique: c.legalFormLabel || '', activite: c.nafLabel || '',
    adresse: [a.line1, a.line2].filter(Boolean).join(', '), code_postal: a.postalCode || '', ville: a.city || '',
    date_creation: c.creationDate ? String(c.creationDate).split('-').reverse().join('/') : '',
    email: d.email || '', telephone: d.phone || '', date_signature: d.date || '',
  };
}

function initials(first, last) {
  const w = (String(first || '') + ' ' + String(last || '')).trim().split(/[\s-]+/).filter(Boolean);
  return w.map(function (x) { return x.charAt(0).toUpperCase(); }).join('.') + (w.length ? '.' : '');
}

/* Le représentant figure-t-il parmi les dirigeants publiés ? On le dit tel
   quel dans le dossier de preuve — sans bloquer : un mandataire habilité peut
   signer, il l'a certifié. */
function dirigeantCheck(reg, first, last) {
  if (!reg) return 'Registre non consulté (saisie manuelle)';
  const list = reg.dirigeants || [];
  if (!list.length) return 'Aucun dirigeant publié au registre';
  const target = core.foldText(first + ' ' + last);
  const targetLast = core.foldText(last);
  const hit = list.find(function (d) {
    if (d.type !== 'physique' || d.masque) return false;
    const full = core.foldText(d.prenoms + ' ' + d.nom);
    return full === target || (core.foldText(d.nom) === targetLast && full.indexOf(core.foldText(first).split(' ')[0]) >= 0);
  });
  if (hit) return 'Correspond au dirigeant publié (' + (hit.qualite || 'dirigeant') + ')';
  if (list.every(function (d) { return d.masque; })) return 'Dirigeants non diffusibles (masqués par l\'INSEE) — habilitation certifiée par le signataire';
  return 'Non trouvé parmi les dirigeants publiés — habilitation certifiée par le signataire';
}

/* ── Chargement commun ───────────────────────────────────────────────────── */
async function context(found) {
  const R = found.R;
  const tpl = await core.loadTemplate(R.templateId);
  const gweb = R.webSnapshot && R.webSnapshot.generated ? R.webSnapshot : (!R.webSnapshot && tpl && tpl.T.web && tpl.T.web.generated ? tpl.T.web : null);
  if (gweb) {
    /* Contrat de l'atelier : pas de PDF d'origine, le texte figé à l'envoi
       (webSnapshot) fait foi. */
    return {
      generated: true, tpl: tpl || { T: {}, pdf: null, pdfSha256: '' }, web: gweb, webMode: true,
      fields: [], scale: 1.2, prefill: R.prefill || {}, hints: {},
      signerWeb: render.resolveForSigner(gweb, R.prefill || {}),
    };
  }
  if (!tpl || !tpl.pdf) { const e = new Error('modele_introuvable'); e.status = 409; e.msg = 'Le document de ce contrat est introuvable. Contactez votre conseiller.'; throw e; }
  const frozen = R.frozen || null;
  if (frozen && frozen.templatePdfSha256 && frozen.templatePdfSha256 !== tpl.pdfSha256) {
    const e = new Error('modele_modifie'); e.status = 409;
    e.msg = 'Le contrat a été modifié depuis l\'envoi de ce lien. Pour votre sécurité, la signature est bloquée : demandez un nouveau lien à votre conseiller.';
    throw e;
  }
  const web = R.webSnapshot || (tpl.T && tpl.T.web) || null;
  const webMode = core.webIsValid(web, tpl.pdfSha256);
  return {
    tpl: tpl, web: webMode ? web : null, webMode: webMode,
    fields: Array.isArray(R.fields) && R.fields.length ? R.fields : (tpl.T.fields || []),
    scale: Number(R.pdfScale) || 1.2,
    prefill: R.prefill || {},
    hints: webMode ? (web.fieldHints || {}) : {},
  };
}

/* ── Validation complète d'une soumission ────────────────────────────────── */
async function validate(body, found, ctx, strict) {
  const i = found.signerIndex;
  const role = roleOf(i);
  const spec = specFor(ctx, role);
  const errs = [];
  const f = body.form || {};
  const out = { spec: spec };

  /* Société — saisie par le 1er signataire, reprise telle quelle par le 2e. */
  if (i === 0) {
    const c = f.company || {};
    const ident = String(c.siret || c.siren || '').replace(/\D/g, '');
    let reg = null;
    let regError = null;
    if (ident.length === 9 || ident.length === 14) {
      try { reg = await company.lookupByIdentifier(ident); } catch (e) { regError = e; }
    }
    const manualAddr = {
      line1: String((c.address && c.address.line1) || '').trim().slice(0, 140),
      line2: String((c.address && c.address.line2) || '').trim().slice(0, 140),
      postalCode: String((c.address && c.address.postalCode) || '').replace(/\s/g, '').slice(0, 10),
      city: String((c.address && c.address.city) || '').trim().slice(0, 80),
    };
    const C = {};
    if (reg) {
      if (reg.closed && strict) errs.push('Cette entreprise est radiée au registre : le contrat ne peut pas être signé en son nom. Contactez votre conseiller.');
      C.name = reg.name; C.siren = reg.siren; C.siret = reg.siret; C.vatNumber = reg.vatNumber;
      C.legalForm = reg.legalForm; C.legalFormLabel = reg.legalFormLabel;
      C.nafLabel = reg.nafLabel || ''; C.creationDate = reg.creationDate || '';
      C.address = reg.addressHidden ? manualAddr : reg.address;
      C.addressSource = reg.addressHidden ? 'saisie (adresse non diffusible au registre)' : 'registre';
      C.verification = 'Vérifiée dans l\'annuaire officiel des entreprises le ' + core.parisToday() + ' — ' + (reg.closed ? 'ENTREPRISE RADIÉE' : 'entreprise active') + (reg.creationDate ? ', créée le ' + reg.creationDate.split('-').reverse().join('/') : '') + ' — source : ' + company.SOURCE_LABEL;
      out.registry = reg;
    } else {
      /* Annuaire injoignable, ou entreprise trop récente pour y figurer :
         saisie manuelle acceptée si le SIRET est mathématiquement valide, et
         le dossier de preuve le dit sans détour. */
      if (!company.siretValid(c.siret)) errs.push('Numéro SIRET invalide (14 chiffres, clé de contrôle incorrecte).');
      C.name = String(c.name || '').trim().slice(0, 160);
      C.siret = String(c.siret || '').replace(/\D/g, '');
      C.siren = C.siret.slice(0, 9);
      C.vatNumber = company.vatFromSiren(C.siren);
      C.legalForm = '';
      C.legalFormLabel = String(c.legalFormLabel || '').trim().slice(0, 60);
      C.address = manualAddr;
      C.addressSource = 'saisie';
      C.verification = regError
        ? 'Annuaire officiel injoignable au moment de la signature — données saisies par le signataire, SIRET contrôlé (clé de Luhn)'
        : 'Entreprise non trouvée dans l\'annuaire officiel au ' + core.parisToday() + ' — données saisies par le signataire, SIRET contrôlé (clé de Luhn)';
      if (!C.name) errs.push('Raison sociale manquante.');
      if (!C.legalFormLabel) errs.push('Forme juridique manquante.');
    }
    if (!C.address.line1 || !/^\d{5}$/.test(C.address.postalCode) || !C.address.city) errs.push('Adresse du siège social incomplète (voie, code postal à 5 chiffres, ville).');
    C.addressLine = company.addressLine(C.address);
    out.company = C;
  } else {
    const s0 = (found.R.signers && found.R.signers[0]) || {};
    out.company = s0.company || null;
    if (!out.company) errs.push('Les informations de la société sont introuvables. Contactez votre conseiller.');
  }

  /* Représentant */
  const rep = f.representative || {};
  const first = String(rep.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const last = String(rep.lastName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  let qualite = String(rep.qualite || '').trim().slice(0, 60);
  if (qualite === 'Autre') qualite = String(rep.qualiteAutre || '').trim().slice(0, 60);
  if (first.length < 2 || !/[A-Za-zÀ-ÿ]/.test(first)) errs.push('Prénom du représentant manquant.');
  if (last.length < 2 || !/[A-Za-zÀ-ÿ]/.test(last)) errs.push('Nom du représentant manquant.');
  if (qualite.length < 3) errs.push('Qualité du représentant manquante (gérant, président…).');
  out.rep = { first: first, last: last, full: first + ' ' + last, qualite: qualite };

  /* Déclarations */
  const decl = f.declarations || {};
  if (decl.pouvoir !== true) errs.push('Vous devez certifier être habilité(e) à engager la société.');
  if (decl.esign !== true) errs.push('Vous devez accepter la signature électronique.');

  /* Cases et textes */
  const checks = {};
  spec.checks.forEach(function (c) {
    const v = !!(f.checks && f.checks[c.id] === true);
    checks[c.id] = v;
    if (c.required && !v) errs.push('Case obligatoire non cochée : « ' + String(c.label).replace(/^[«"\s]+|[»"\s]+$/g, '') + ' ».');
  });
  out.checks = checks;
  const texts = {};
  spec.texts.forEach(function (t) {
    if (t.locked) return;
    const v = String((f.texts && f.texts[t.id]) || '').trim().slice(0, t.maxLength || 500);
    texts[t.id] = v;
    if (t.required && !v) errs.push('Champ obligatoire vide : « ' + t.label + ' ».');
  });
  out.texts = texts;

  /* Mentions manuscrites */
  const date = String(f.date || '').trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) errs.push('Date de signature à saisir au format JJ/MM/AAAA.');
  else if (date !== core.parisToday()) errs.push('La date saisie doit être celle d\'aujourd\'hui : ' + core.parisToday() + '.');
  const lu = String(f.luApprouve || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (core.foldText(lu) !== 'lu et approuve') errs.push('Recopiez la mention « Lu et approuvé ».');
  out.date = date;
  out.luApprouve = lu;

  if (spec.paraphe) {
    const p = String(f.paraphe || '').trim().slice(0, 12);
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.\- ]{0,11}$/.test(p)) errs.push('Saisissez vos initiales pour parapher le contrat.');
    out.paraphe = p;
    out.paraphePng = pngFromDataUrl(f.paraphePng, 200000);
    if (!out.paraphePng) errs.push('Paraphe illisible : ressaisissez vos initiales.');
  }

  /* Signature tracée */
  const sig = f.signature || {};
  out.signaturePng = pngFromDataUrl(sig.png, 600000);
  /* Deux modes, au choix du signataire : tracée (souris, doigt, stylet) ou
     saisie au clavier (nom tapé, rendu en écriture manuscrite). Les deux sont
     des signatures électroniques au sens de l'article 1367 ; le mode est
     inscrit au dossier de preuve. */
  const mode = sig.mode === 'saisie' ? 'saisie' : 'dessin';
  out.trace = { mode: mode, strokes: Number(sig.strokes) || 0, points: Number(sig.points) || 0, durationMs: Number(sig.durationMs) || 0 };
  out.signatureName = String(sig.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (strict) {
    if (!out.signaturePng) errs.push(mode === 'saisie' ? 'Tapez votre nom pour signer.' : 'Tracez votre signature dans le cadre prévu.');
    else if (mode === 'dessin' && out.trace.points < 20) errs.push('Tracez votre signature dans le cadre prévu.');
    if (core.foldText(out.signatureName) !== core.foldText(out.rep.full)) errs.push('Le nom saisi sous la signature doit être celui du représentant : ' + out.rep.full + '.');
  }
  out.errors = errs;
  return out;
}

/* Données de stampage d'un signataire, depuis une validation (v) ou depuis
   ce qui a été enregistré (signer_data). */
function stampSigner(role, d, caption) {
  return {
    role: role,
    company: d.company,
    repName: d.rep.full, repQualite: d.rep.qualite,
    email: d.email, phone: d.phone,
    date: d.date, luApprouve: d.luApprouve,
    checks: d.checks, texts: d.texts,
    signaturePng: d.signaturePng || null,
    paraphePng: d.paraphePng || null,
    caption: caption || '',
  };
}

function fmtDuree(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (!s) return '';
  const m = Math.floor(s / 60);
  return (m ? m + ' min ' : '') + (s % 60) + ' s';
}

/* ── Handler ─────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'POST') { send(res, 405, { error: 'Méthode non autorisée' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '');
  let found = null;
  try {
    found = await core.findByToken(body.token);
  } catch (e) {
    console.error('[sign-session] findByToken', e && e.message);
    send(res, 500, { error: 'Service momentanément indisponible. Réessayez dans un instant.' });
    return;
  }
  if (!found) { send(res, 404, { error: 'Lien invalide ou expiré.' }); return; }

  const R = found.R;
  const i = found.signerIndex;
  const info = core.clientInfo(req);
  const signers = Array.isArray(R.signers) ? R.signers : [];
  const mineSigned = (found.signer && found.signer.status === 'signed') || R.status === 'signed';
  const waiting = i >= 1 && signers[0] && signers[0].status !== 'signed';

  try {
    if (R.status === 'cancelled') { send(res, 409, { error: 'Cette demande de signature a été annulée.' }); return; }

    /* ── load ──────────────────────────────────────────────────────────── */
    if (action === 'load') {
      const stage = mineSigned ? 'signed' : (waiting ? 'waiting' : 'sign');
      if (stage === 'sign') {
        const upd = {};
        if (R.status === 'pending') upd.status = 'opened';
        if (signers[i] && signers[i].status === 'pending') {
          const ns = signers.slice();
          ns[i] = Object.assign({}, ns[i], { status: 'opened', openedAt: new Date().toISOString() });
          upd.signers = ns;
        }
        upd.events = admin.firestore.FieldValue.arrayUnion({ type: 'opened', by: 'signer' + (i + 1), date: new Date().toISOString() });
        await found.ref.update(upd);
        await core.appendAudit(found.ref, [{ type: 'lien_ouvert', signer: i, data: { geo: [info.city, info.country].filter(Boolean).join(', ') } }], info);
        const cur = (R.progress && R.progress.etape) || 0;
        await core.setProgress(found.ref, i, { etape: Math.max(cur, 1), derniere: 'Lien ouvert', enLigne: true, ouvertures: admin.firestore.FieldValue.increment(1), premiereOuverture: (R.progress && R.progress.premiereOuverture) || new Date().toISOString() }, info);
      }
      const name = String(found.signer.name || R.clientName || '');
      send(res, 200, {
        ok: true, stage: stage, reqId: found.id, signerIndex: i,
        templateName: R.templateName || 'Contrat',
        firstName: name.split(' ')[0] || '',
        phoneHint: core.maskPhone(found.signer.phone || R.clientPhone),
        otpOk: core.otpOk(R, i),
        twoSigners: signers.length > 1,
        firstSignerName: i >= 1 && signers[0] ? signers[0].name : '',
      });
      return;
    }

    /* ── signed : télécharger son exemplaire ───────────────────────────── */
    if (action === 'signed') {
      if (R.status !== 'signed') { send(res, 409, { error: 'Le contrat n\'est pas encore signé par toutes les parties.' }); return; }
      let b64 = R.signedPdfBase64 || '';
      if (!b64) {
        const ch = await found.ref.collection('signed_pdf').orderBy('chunk').get();
        ch.forEach(function (d) { b64 += (d.data() || {}).data || ''; });
      }
      if (!b64) { send(res, 404, { error: 'Document signé introuvable.' }); return; }
      await core.appendAudit(found.ref, [{ type: 'copie_telechargee', signer: i, data: null }], info).catch(function () {});
      send(res, 200, { ok: true, pdf: b64, filename: (R.templateName || 'Contrat').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_') + '_signe.pdf' });
      return;
    }

    if (mineSigned) { send(res, 409, { error: 'Vous avez déjà signé ce contrat.', stage: 'signed' }); return; }
    if (waiting) { send(res, 409, { error: 'Le premier signataire doit signer avant vous.', stage: 'waiting' }); return; }
    if (!core.otpOk(R, i)) { send(res, 401, { error: 'Vérification par code SMS requise.', stage: 'otp' }); return; }

    /* ── events ────────────────────────────────────────────────────────── */
    if (action === 'events') {
      const list = (Array.isArray(body.events) ? body.events : []).slice(0, 60)
        .filter(function (e) { return e && CLIENT_EVENTS[e.type]; })
        .map(function (e) { return { type: e.type, signer: i, data: smallData(e.data) }; });
      if (list.length) await core.appendAudit(found.ref, list, info);
      if (list.length) {
        const pg = { derniere: (EVENT_LABELS[list[list.length - 1].type] || list[list.length - 1].type), enLigne: list[list.length - 1].type !== 'page_masquee' };
        const PAGE_TO_STEP = { 2: 3, 3: 4, 4: 5, 5: 6 };
        list.forEach(function (e) { if (e.type === 'etape' && e.data && PAGE_TO_STEP[e.data.n]) pg.etape = PAGE_TO_STEP[e.data.n]; });
        const vues = list.filter(function (e) { return e.type === 'section_vue'; }).length;
        if (vues) pg.lectureVues = admin.firestore.FieldValue.increment(vues);
        if (list.some(function (e) { return e.type === 'lecture_terminee'; })) pg.lectureOk = true;
        if (list.some(function (e) { return e.type === 'lecture_declaree'; })) pg.lectureDeclaree = true;
        await core.setProgress(found.ref, i, pg, info);
      }
      const done = list.find(function (e) { return e.type === 'lecture_terminee'; });
      if (done) {
        const upd = {};
        upd['readDone.' + i] = { at: new Date().toISOString(), data: done.data || null };
        await found.ref.update(upd);
      }
      send(res, 200, { ok: true, n: list.length });
      return;
    }

    const ctx = await context(found);

    /* ── content ───────────────────────────────────────────────────────── */
    if (action === 'content') {
      const upd = {};
      if (!R.frozen) upd.frozen = { templatePdfSha256: ctx.generated ? '' : ctx.tpl.pdfSha256, generated: !!ctx.generated, webVersion: ctx.web ? (ctx.web.version || 1) : null, webDigest: core.webDigest(ctx.web), at: new Date().toISOString() };
      if (ctx.webMode && !R.webSnapshot) upd.webSnapshot = ctx.web;
      if (Object.keys(upd).length) await found.ref.update(upd);
      const spec = specFor(ctx, roleOf(i));
      let pages = 0;
      if (!ctx.generated) { try { pages = (await require('pdf-lib').PDFDocument.load(ctx.tpl.pdf, { updateMetadata: false })).getPageCount(); } catch (e) { pages = 0; } }
      const shownWeb = ctx.generated ? ctx.signerWeb : ctx.web;
      await core.appendAudit(found.ref, [{ type: 'contenu_charge', signer: i, data: { mode: ctx.webMode ? 'texte' : 'pdf', version: ctx.web ? (ctx.web.version || 1) : null } }], info);
      await core.setProgress(found.ref, i, { lectureTotal: ctx.webMode ? ((shownWeb && shownWeb.sections) || []).length : pages, derniere: 'Contrat affiché', enLigne: true }, info);
      const s0 = signers[0] || {};
      send(res, 200, {
        ok: true,
        mode: ctx.webMode ? 'web' : 'pdf',
        templateName: R.templateName || 'Contrat',
        web: ctx.webMode ? { title: shownWeb.title, subtitle: shownWeb.subtitle, tagline: shownWeb.tagline, sections: shownWeb.sections, version: shownWeb.version || 1 } : null,
        pages: pages,
        form: {
          needsCompany: i === 0,
          company: i >= 1 ? (s0.company || null) : null,
          checks: spec.checks, texts: spec.texts, conditions: spec.conditions,
          paraphe: spec.paraphe, dateField: spec.dateField,
          startNoWaiver: startNoWaiver(),
          qualites: QUALITES,
          declarations: DECLARATIONS,
        },
        signer: { name: found.signer.name || '', email: found.signer.email || '', phone: found.signer.phone || '', index: i },
        today: core.parisToday(),
        message: R.message || '',
      });
      return;
    }

    /* ── company ───────────────────────────────────────────────────────── */
    if (action === 'company') {
      const q = String(body.q || '').trim().slice(0, 120);
      const r = await company.searchCompanies(q, 8);
      await core.appendAudit(found.ref, [{ type: 'entreprise_recherche', signer: i, data: { q: q, resultats: r.results.length } }], info);
      send(res, 200, {
        ok: true,
        results: r.results.map(function (x) {
          return {
            siren: x.siren, siret: x.siret, name: x.name, legalFormLabel: x.legalFormLabel,
            address: x.address, addressHidden: x.addressHidden, closed: x.closed,
            vatNumber: x.vatNumber, creationDate: x.creationDate, nafLabel: x.nafLabel,
            dirigeants: (x.dirigeants || []).filter(function (d) { return d.type === 'physique' && !d.masque; })
              .map(function (d) { return { prenoms: d.prenoms, nom: d.nom, qualite: d.qualite }; }),
            qualites: (x.dirigeants || []).map(function (d) { return d.qualite; }).filter(Boolean),
          };
        }),
      });
      return;
    }

    /* ── pdf original ──────────────────────────────────────────────────── */
    if (action === 'pdf') {
      await core.appendAudit(found.ref, [{ type: 'pdf_original_ouvert', signer: i, data: null }], info);
      if (ctx.generated) {
        const b = await render.composeContract({ web: ctx.web, prefill: ctx.prefill, client: {}, checks: {}, signers: [], blank: true });
        send(res, 200, { ok: true, pdf: Buffer.from(await b.doc.save()).toString('base64') });
        return;
      }
      send(res, 200, { ok: true, pdf: ctx.tpl.pdf.toString('base64'), sha256: ctx.tpl.pdfSha256 });
      return;
    }

    /* ── preview ───────────────────────────────────────────────────────── */
    if (action === 'preview') {
      const v = await validate(body, found, ctx, false);
      const role = roleOf(i);
      const S = stampSigner(role, Object.assign({}, v, { email: found.signer.email, phone: found.signer.phone }), 'Aperçu — non signé');
      const list = [S];
      if (i >= 1) {
        const d0 = await found.ref.collection('signer_data').doc('0').get();
        if (d0.exists) list.unshift(storedToStamp(1, d0.data()));
      }
      let pdf;
      if (ctx.generated) {
        const d0 = list[0];
        const b = await render.composeContract({
          web: ctx.web, prefill: ctx.prefill, texts: v.texts, checks: v.checks, preview: true,
          client: clientMap({ company: d0.company, rep: Object.assign({ full: d0.repName, qualite: d0.repQualite }, v.rep || {}), email: found.signer.email, phone: found.signer.phone, date: d0.date }),
          signers: list.map(function (x) { return { luApprouve: x.luApprouve, date: x.date, signaturePng: x.signaturePng, paraphePng: x.paraphePng, caption: 'Aperçu — non signé', repName: x.repName, repQualite: x.repQualite }; }),
        });
        pdf = Buffer.from(await b.doc.save());
      } else {
        pdf = await buildPreviewPdf({ templatePdf: ctx.tpl.pdf, fields: ctx.fields, scale: ctx.scale, signers: list, prefill: ctx.prefill });
      }
      await core.appendAudit(found.ref, [{ type: 'apercu_ouvert', signer: i, data: { manquants: v.errors.length } }], info);
      send(res, 200, { ok: true, pdf: pdf.toString('base64'), missing: v.errors });
      return;
    }

    /* ── submit ────────────────────────────────────────────────────────── */
    if (action === 'submit') {
      if (!(R.readDone && R.readDone[String(i)])) { send(res, 400, { error: 'Lisez le contrat jusqu\'au bout avant de signer.', details: ['Lecture intégrale non confirmée.'] }); return; }
      const v = await validate(body, found, ctx, true);
      if (v.errors.length) { send(res, 400, { error: 'Le formulaire est incomplet.', details: v.errors }); return; }

      /* Verrou : un double clic ou deux onglets ne produisent jamais deux
         signatures. Le verrou expire seul au bout de 90 s si tout plante. */
      const locked = await db.runTransaction(async function (tx) {
        const s = await tx.get(found.ref);
        const X = s.data() || {};
        const sx = (X.signers || [])[i];
        if ((sx && sx.status === 'signed') || X.status === 'signed') return 'deja';
        if (X.submitLock && X.submitLock.at > Date.now() - 90000) return 'encours';
        tx.update(found.ref, { submitLock: { at: Date.now(), signer: i } });
        return 'ok';
      });
      if (locked === 'deja') { send(res, 409, { error: 'Vous avez déjà signé ce contrat.', stage: 'signed' }); return; }
      if (locked === 'encours') { send(res, 409, { error: 'Signature déjà en cours de traitement. Patientez quelques secondes.' }); return; }

      try {
        const result = await finalize(found, ctx, v, info, body);
        send(res, 200, result);
      } catch (e) {
        await found.ref.update({ submitLock: admin.firestore.FieldValue.delete() }).catch(function () {});
        throw e;
      }
      return;
    }

    send(res, 400, { error: 'Action inconnue.' });
  } catch (e) {
    if (e && e.status && e.msg) { send(res, e.status, { error: e.msg }); return; }
    if (e && e.status === 429) { send(res, 429, { error: e.message || 'Trop de requêtes.' }); return; }
    if (e && e.status && e.status < 500) { send(res, e.status, { error: e.message }); return; }
    console.error('[sign-session]', action, found && found.id, e && e.stack ? e.stack : e);
    send(res, 500, { error: 'Erreur serveur. Réessayez dans un instant.' });
  }
};

function storedToStamp(role, d) {
  return {
    role: role, company: d.company, repName: d.rep.full, repQualite: d.rep.qualite,
    email: d.email, phone: d.phone, date: d.date, luApprouve: d.luApprouve,
    checks: d.checks || {}, texts: d.texts || {},
    signaturePng: d.signaturePngB64 ? Buffer.from(d.signaturePngB64, 'base64') : null,
    paraphePng: d.paraphePngB64 ? Buffer.from(d.paraphePngB64, 'base64') : null,
    caption: d.caption || '',
  };
}

/* ── Signature : enregistrement, PDF, preuve, sceau ──────────────────────── */
async function finalize(found, ctx, v, info, body) {
  const R = found.R;
  const i = found.signerIndex;
  const signers = Array.isArray(R.signers) ? R.signers.slice() : [];
  const nowIso = new Date().toISOString();
  const certId = 'SIG-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const caption = 'Signé électroniquement par ' + v.rep.full + ' le ' + core.parisDateTime(new Date()) + ' · réf. ' + certId;
  const otp = (R.otpBySigner || {})[String(i)] || {};

  /* Ce que le signataire a fait, tel que relu depuis le journal serveur. */
  const audit0 = await core.readAudit(found.ref);
  const mine = audit0.entries.filter(function (e) { return e.signer === i; });
  function firstAt(type, pred) { const e = mine.find(function (x) { return x.type === type && (!pred || pred(x)); }); return e ? e.at : ''; }
  function lastAt(type, pred) { const l = mine.filter(function (x) { return x.type === type && (!pred || pred(x)); }); return l.length ? l[l.length - 1].at : ''; }

  const readDone = (R.readDone || {})[String(i)] || {};
  const rd = readDone.data || {};
  const sectionsVues = rd.vues != null ? rd.vues : mine.filter(function (e) { return e.type === 'section_vue'; }).length;

  const data = {
    signerIndex: i,
    certificateId: certId,
    company: v.company,
    rep: v.rep,
    email: found.signer.email || R.clientEmail || '',
    phone: found.signer.phone || R.clientPhone || '',
    date: v.date, luApprouve: v.luApprouve,
    paraphe: v.paraphe || '',
    checks: v.checks, texts: v.texts,
    signatureName: v.signatureName,
    trace: v.trace,
    signaturePngB64: v.signaturePng.toString('base64'),
    paraphePngB64: v.paraphePng ? v.paraphePng.toString('base64') : '',
    caption: caption,
    signedAt: nowIso,
    ip: info.ip, ua: info.ua, geo: [info.city, info.region, info.country].filter(Boolean).join(', '),
    dirigeantCheck: i === 0 ? dirigeantCheck(v.registry || null, v.rep.first, v.rep.last) : 'Second signataire',
    declarations: [
      { id: 'pouvoir', etat: 'Accepté', libelle: DECLARATIONS.pouvoir, at: lastAt('consentement', function (e) { return e.data && e.data.id === 'pouvoir'; }) },
      { id: 'esign', etat: 'Accepté', libelle: DECLARATIONS.esign, at: lastAt('consentement', function (e) { return e.data && e.data.id === 'esign'; }) },
    ].concat(v.spec.checks.map(function (c) {
      const ty = v.checks[c.id] ? 'case_cochee' : 'case_decochee';
      let lib = c.label;
      if (c.kind === 'renonciation') {
        lib += v.checks[c.id]
          ? ' — Démarrage immédiat demandé ; renonciation au délai de rétractation.'
          : ' — Pas de renonciation : l\'accompagnement démarrera à l\'issue du délai de rétractation, à partir du ' + startNoWaiver() + '. Information affichée au signataire avant signature.';
      }
      return { id: c.id, etat: v.checks[c.id] ? 'Coché' : 'Non coché', libelle: lib, at: lastAt(ty, function (e) { return e.data && e.data.id === c.id; }) };
    })),
    lecture: (rd.declaree
      ? 'Déclaration expresse « J\'ai pris connaissance du document dans son intégralité » — ' + (rd.vuesReelles != null ? rd.vuesReelles : sectionsVues) + ' ' + (ctx.webMode ? 'article(s)' : 'page(s)') + ' sur ' + (rd.total || (ctx.webMode ? (ctx.web.sections || []).length : '?')) + ' effectivement affichés à l\'écran'
      : (ctx.webMode ? sectionsVues + ' article(s) sur ' + (ctx.web.sections || []).length + ' affichés à l\'écran' : 'PDF original lu page par page'))
      + (rd.duree ? ' — temps passé sur le contrat ' + rd.duree : '') + ' — confirmé le ' + core.parisDateTime(new Date(readDone.at || nowIso)),
    pdfConsulte: firstAt('pdf_original_ouvert') ? 'Oui, le ' + core.parisDateTime(new Date(firstAt('pdf_original_ouvert'))) : 'Non',
    apercu: firstAt('apercu_ouvert') ? 'Oui, le ' + core.parisDateTime(new Date(firstAt('apercu_ouvert'))) : 'Non consulté',
    otpLine: otp.atMs ? ('Code à usage unique envoyé par SMS au ' + (otp.phone || '') + ', validé le ' + core.parisDateTime(new Date(otp.atMs))) : 'Non vérifié',
    otpAtMs: otp.atMs || null,
  };
  data.mentions = [
    { nom: 'Date de signature', valeur: v.date, at: lastAt('mention_saisie', function (e) { return e.data && e.data.nom === 'date'; }) },
    { nom: 'Mention', valeur: v.luApprouve, at: lastAt('mention_saisie', function (e) { return e.data && e.data.nom === 'lu_approuve'; }) },
    { nom: 'Nom sous la signature', valeur: v.signatureName, at: '' },
  ];
  if (v.paraphe) data.mentions.push({ nom: 'Paraphe (initiales)', valeur: v.paraphe, at: lastAt('paraphe_saisi') });
  Object.keys(v.texts || {}).forEach(function (k) {
    const t = v.spec.texts.find(function (x) { return x.id === k; });
    if (v.texts[k]) data.mentions.push({ nom: (t && t.label) || 'Texte', valeur: v.texts[k], at: '' });
  });

  await found.ref.collection('signer_data').doc(String(i)).set(Object.assign({}, data, { serverTs: admin.firestore.FieldValue.serverTimestamp() }));
  await core.appendAudit(found.ref, [{
    type: 'signature_validee', signer: i,
    data: { ref: certId, nom: v.rep.full, qualite: v.rep.qualite, societe: (v.company && v.company.name) || '', empreinte: core.sha256Hex(JSON.stringify([data.company, data.rep, data.date, data.luApprouve, data.checks, data.texts, data.signaturePngB64])) },
  }], info);

  const isFinal = !signers.length || i >= signers.length - 1;
  const signerSummary = {
    status: 'signed', signedAtLocal: nowIso, signedAt: nowIso,
    signatureText: v.signatureName, parapheText: v.paraphe || '',
    certificateId: certId, company: i === 0 ? v.company : undefined,
    representative: { firstName: v.rep.first, lastName: v.rep.last, qualite: v.rep.qualite },
  };
  if (signerSummary.company === undefined) delete signerSummary.company;
  if (signers[i]) signers[i] = Object.assign({}, signers[i], signerSummary);

  if (!isFinal) {
    await found.ref.update({
      signers: signers, status: 'partial', currentSigner: i + 1,
      partialSignedAt: admin.firestore.FieldValue.serverTimestamp(),
      events: admin.firestore.FieldValue.arrayUnion({ type: 'signed', by: 'signer' + (i + 1), date: nowIso }),
      submitLock: admin.firestore.FieldValue.delete(),
    });
    await core.setProgress(found.ref, i, { etape: 7, derniere: 'Signé par le signataire ' + (i + 1) + ' — en attente du suivant', enLigne: false }, info);
    return { ok: true, final: false, certificateId: certId, nextSigner: (signers[i + 1] && signers[i + 1].name) || '' };
  }

  /* ── Signature finale : PDF + dossier de preuve + sceaux ─────────────── */
  const all = [];
  for (let k = 0; k <= i; k++) {
    const d = k === i ? data : ((await found.ref.collection('signer_data').doc(String(k)).get()).data() || null);
    if (d) all.push(d);
  }
  const audit = await core.readAudit(found.ref);
  let auditTsa = null;
  try {
    const t = await timestamp(Buffer.from(audit.headHash, 'hex'));
    auditTsa = { authority: t.authority, genTime: t.genTime, url: t.url, tokenB64: t.token.toString('base64') };
  } catch (e) { console.error('[sign-session] horodatage du journal impossible :', e && e.message); }

  /* Conditions convenues, remplies par le conseiller à l'envoi : elles
     figurent au dossier de preuve, le client les a vues sans pouvoir les
     modifier. */
  const spec0 = specFor(ctx, 1);
  const conditions = spec0.conditions.filter(function (c) { return c.value; }).map(function (c) { return 'Retenu : ' + c.label; })
    .concat(spec0.texts.filter(function (t) { return t.locked && t.value; }).map(function (t) { return t.label + ' : ' + t.value; }));
  const renCheck = spec0.checks.find(function (c) { return c.kind === 'renonciation'; });
  const renonce = renCheck ? !!(all[0].checks || {})[renCheck.id] : null;

  const proof = {
    conditions: conditions,
    templateName: R.templateName || 'Contrat',
    requestId: found.id,
    certificateId: certId,
    webMode: ctx.webMode,
    webVersion: ctx.web ? (ctx.web.version || 1) : null,
    templatePdfSha256: ctx.generated ? '' : ctx.tpl.pdfSha256,
    generated: !!ctx.generated,
    webDigest: core.webDigest(ctx.web),
    createdAt: R.createdAt && R.createdAt.toDate ? R.createdAt.toDate().toISOString() : '',
    createdBy: ((R.events || []).find(function (e) { return e && e.type === 'created'; }) || {}).by || '',
    company: Object.assign({}, all[0].company),
    signers: all.map(function (d) {
      return {
        repName: d.rep.full, repQualite: d.rep.qualite, dirigeantCheck: d.dirigeantCheck,
        email: d.email, phone: d.phone, otpLine: d.otpLine, otpAt: d.otpAtMs,
        ip: d.ip, geo: d.geo, ua: d.ua, signedAt: d.signedAt,
        declarations: d.declarations, lecture: d.lecture, pdfConsulte: d.pdfConsulte, apercu: d.apercu,
        mentions: d.mentions,
        signaturePng: Buffer.from(d.signaturePngB64, 'base64'),
        paraphePng: d.paraphePngB64 ? Buffer.from(d.paraphePngB64, 'base64') : null,
        sigLabel: d.trace.mode === 'saisie' ? 'Signature saisie au clavier par le signataire (« ' + d.signatureName + ' »), rendue en écriture manuscrite' : 'Signature manuscrite tracée à l\'écran',
        traceInfo: d.trace.mode === 'saisie' ? 'mode : nom tapé' : (d.trace.strokes + ' trait(s), ' + d.trace.points + ' points' + (d.trace.durationMs ? ', ' + fmtDuree(d.trace.durationMs) : '')),
      };
    }),
    audit: audit.entries,
    auditIntact: audit.intact,
    auditHead: audit.headHash,
    auditTsa: auditTsa,
  };

  let out;
  if (ctx.generated) {
    const d0g = all[0];
    out = await finishSigned(function () {
      return render.composeContract({
        web: ctx.web, prefill: ctx.prefill, texts: d0g.texts || {}, checks: d0g.checks || {},
        client: clientMap(d0g),
        signers: all.map(function (d) { const st = storedToStamp(1, d); return { luApprouve: d.luApprouve, date: d.date, signaturePng: st.signaturePng, paraphePng: st.paraphePng, caption: d.caption, repName: d.rep.full, repQualite: d.rep.qualite }; }),
      });
    }, proof);
  } else {
    out = await buildSignedPdf({
      templatePdf: ctx.tpl.pdf, fields: ctx.fields, scale: ctx.scale, prefill: ctx.prefill,
      signers: all.map(function (d, k) { return storedToStamp(roleOf(k), d); }),
      proof: proof,
    });
  }
  const finalSha = core.sha256Hex(out.bytes);
  const b64 = out.bytes.toString('base64');

  /* Le PDF : en clair sous ~900 Ko, sinon en morceaux (limite 1 Mo/doc).
     Même stockage qu'avant : signature-completed, le bouton Télécharger de
     l'équipe et la Cloud Function le relisent tel quel. */
  const upd = {};
  if (b64.length < 900000) upd.signedPdfBase64 = b64;
  else {
    const CS = 600000;
    const batch = db.batch();
    for (let k = 0, n = 0; k < b64.length; k += CS, n++) {
      batch.set(found.ref.collection('signed_pdf').doc('chunk_' + String(n).padStart(3, '0')), { chunk: n, data: b64.slice(k, k + CS) });
    }
    await batch.commit();
    upd.signedPdfBase64 = admin.firestore.FieldValue.delete();
  }

  const d0 = all[0];
  const fv = {
    nom_prenom: d0.rep.full, email: d0.email, telephone: d0.phone,
    entreprise: d0.company.name, type_entreprise: d0.company.legalFormLabel,
    siege_social: d0.company.addressLine, adresse: d0.company.addressLine, siret: d0.company.siret,
    date_signature: d0.date, lu_approuve: d0.luApprouve, qualite: d0.rep.qualite,
  };
  Object.keys(d0.checks || {}).forEach(function (k) { fv[k] = d0.checks[k]; });
  Object.keys(d0.texts || {}).forEach(function (k) { if (d0.texts[k]) fv[k] = d0.texts[k]; });
  Object.keys(ctx.prefill || {}).forEach(function (k) { if (ctx.prefill[k]) fv[k] = ctx.prefill[k]; });

  Object.assign(upd, {
    status: 'signed',
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    signedAtIso: nowIso,
    signers: signers,
    fieldValues: fv,
    signatureText: d0.signatureName, parapheText: d0.paraphe || '',
    certificateId: certId,
    documentHash: finalSha,
    signedPdfSha256: finalSha,
    signedPdfBytes: out.bytes.length,
    flow: 'v2',
    renonciationRetractation: renonce,
    demarragePossibleLe: renonce === false ? startNoWaiver() : (renonce === true ? core.parisToday() : null),
    company: d0.company,
    representative: { firstName: d0.rep.first, lastName: d0.rep.last, qualite: d0.rep.qualite },
    seal: out.seal ? { authority: out.seal.authority, genTime: out.seal.genTime } : { error: out.sealError || 'echec' },
    auditTsa: auditTsa,
    auditHeadAtSignature: { seq: audit.entries.length, hash: audit.headHash, intact: audit.intact },
    signingMeta: { userAgent: info.ua, ip: info.ip, geo: d0.geo, language: info.lang, signedAtLocal: nowIso },
    events: admin.firestore.FieldValue.arrayUnion({ type: 'signed', by: 'signer' + (i + 1), date: nowIso }),
    submitLock: admin.firestore.FieldValue.delete(),
  });
  await found.ref.update(upd);
  await core.appendAudit(found.ref, [{ type: 'document_genere', signer: null, data: { sha256: finalSha, octets: out.bytes.length, sceau: out.seal ? out.seal.authority : 'aucun' } }], info);
  await core.setProgress(found.ref, i, { etape: 7, derniere: 'Contrat signé et scellé', enLigne: false }, info);

  /* Passage du lead en client + webhook Make : traités par la Cloud Function
     onWebhookInbox (action publique signature_completed), comme avant. */
  await db.collection('webhook_inbox').add({
    action: 'signature_completed',
    signatureRequestId: found.id,
    clientName: R.clientName || d0.rep.full,
    clientEmail: R.clientEmail || d0.email,
    templateName: R.templateName || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, final: true, certificateId: certId, sha256: finalSha, sealed: !!out.seal };
}

}};

/* ── ./api/_parseBody.js ── */
__defs["./api/_parseBody.js"] = { map: {"./_parseBody":"./api/_parseBody.js"}, shims: {}, fn: function (module, exports, require) {
// ============================================================================
// api/_parseBody.js
// ----------------------------------------------------------------------------
// Helper de normalisation du body HTTP pour les Vercel Functions.
//
// Vercel passe `req.body` de façon inconsistante selon le Content-Type, la
// présence d'un bodyParser en amont, et l'état du stream :
//   - objet JSON parsé          (cas nominal Content-Type: application/json)
//   - string brute              (si un middleware a lu le stream avant)
//   - undefined                 (si aucun body)
//   - Buffer                    (rare, selon runtime)
//
// Ce helper garantit qu'on récupère toujours un objet exploitable, ou un
// objet vide en cas d'échec de parsing.
//
// Usage :
//   const parseBody = require('./_parseBody');
//   module.exports = async (req, res) => {
//     const body = parseBody(req);
//     const { phoneNumber } = body;
//     ...
//   };
// ============================================================================

/**
 * Normalise req.body en objet JS exploitable.
 * Ne lance jamais d'exception — retourne {} en cas de body invalide.
 *
 * @param {import('http').IncomingMessage & { body?: any }} req
 * @returns {Object}
 */
function parseBody(req) {
  let body = req && req.body;

  if (body == null) return {};

  // Buffer → string → JSON
  if (Buffer.isBuffer(body)) {
    try {
      body = body.toString('utf8');
    } catch (_) {
      return {};
    }
  }

  // String → JSON
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return {};
    try {
      body = JSON.parse(trimmed);
    } catch (_) {
      return {};
    }
  }

  // À ce stade on attend un objet plain
  if (typeof body !== 'object' || Array.isArray(body)) return {};

  return body;
}

module.exports = parseBody;
module.exports.parseBody = parseBody;

}};

/* ── ./api/_sign-core.js ── */
__defs["./api/_sign-core.js"] = { map: {}, shims: {"crypto": function () { return __crypto; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_sign-core.js — SOCLE DU PARCOURS DE SIGNATURE (serveur)
// ----------------------------------------------------------------------------
// Partagé par api/sign-session.js et api/signature-otp.js.
//
//   · findByToken()   — la demande et le signataire derrière un lien
//   · clientInfo()    — IP, navigateur, pays/ville (en-têtes Vercel)
//   · appendAudit()   — JOURNAL DE PREUVE CHAÎNÉ, voir plus bas
//   · loadTemplate()  — le modèle et son PDF, avec son empreinte SHA-256
//   · otpOk()         — le signataire a-t-il prouvé son téléphone ?
//
// JOURNAL DE PREUVE CHAÎNÉ
// Chaque action du signataire est écrite par le SERVEUR (heure serveur, IP,
// navigateur) dans signature_requests/{id}/audit/{000001…}. Chaque entrée
// porte l'empreinte de la précédente : hash = SHA-256(prevHash | entrée).
// Modifier, supprimer ou insérer une seule entrée après coup casse toute la
// chaîne, et la tête de chaîne (auditHead) est elle-même horodatée par une
// autorité tierce au moment de la signature. Les règles Firestore interdisent
// toute écriture cliente dans cette sous-collection.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

const MAX_AUDIT = 1500;   // garde-fou : un journal ne grossit pas sans fin

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* ── Retrouver la demande à partir du lien ───────────────────────────────── */
/* Ordre : signerTokens (nouveau modèle, index natif array-contains), puis le
   token à la racine (anciennes demandes), puis un balayage des dernières
   demandes pour un ancien 2e signataire. Jamais de lecture côté navigateur :
   les règles Firestore ne l'autorisent plus. */
async function findByToken(token) {
  token = String(token || '').replace(/[^A-Za-z0-9]/g, '');
  if (token.length < 8) return null;
  const col = db.collection('signature_requests');
  let snap = null;
  let q = await col.where('signerTokens', 'array-contains', token).limit(1).get();
  if (!q.empty) snap = q.docs[0];
  if (!snap) {
    q = await col.where('token', '==', token).limit(1).get();
    if (!q.empty) snap = q.docs[0];
  }
  if (!snap) {
    q = await col.orderBy('createdAt', 'desc').limit(300).get();
    q.forEach(function (d) {
      if (snap) return;
      const s = d.data().signers;
      if (Array.isArray(s) && s.some(function (x) { return x && x.token === token; })) snap = d;
    });
  }
  if (!snap) return null;
  const R = snap.data() || {};
  let signerIndex = 0;
  let signer = null;
  if (Array.isArray(R.signers) && R.signers.length) {
    for (let i = 0; i < R.signers.length; i++) {
      if (R.signers[i] && R.signers[i].token === token) { signerIndex = i; signer = R.signers[i]; break; }
    }
  }
  if (!signer) {
    if (R.token !== token) return null;
    signer = { name: R.clientName, email: R.clientEmail, phone: R.clientPhone, token: token, order: 1, role: 'filler', status: R.status };
  }
  return { ref: snap.ref, id: snap.id, R: R, signerIndex: signerIndex, signer: signer, token: token };
}

/* ── Qui est en face ─────────────────────────────────────────────────────── */
function clientInfo(req) {
  const h = req.headers || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || String(h['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || '';
  function dec(v) { try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); } }
  return {
    ip: ip,
    ua: String(h['user-agent'] || '').slice(0, 400),
    lang: String(h['accept-language'] || '').slice(0, 60),
    country: String(h['x-vercel-ip-country'] || ''),
    region: dec(h['x-vercel-ip-country-region']),
    city: dec(h['x-vercel-ip-city']),
  };
}

/* ── Journal de preuve chaîné ────────────────────────────────────────────── */
/* Forme canonique d'une entrée : ordre de clés FIXE, sinon deux sérialisations
   d'un même contenu donneraient deux empreintes différentes. */
function canonical(e) {
  return JSON.stringify([e.seq, e.type, e.at, e.signer, e.ip, e.ua, e.data == null ? null : e.data]);
}
function entryHash(prevHash, e) { return sha256Hex(String(prevHash || '') + '|' + canonical(e)); }

/* entries : [{ type, signer, data }]. info : clientInfo(req). Écrit tout en
   une transaction (numérotation sans trou ni doublon, même si deux appels
   arrivent ensemble). Renvoie la nouvelle tête { seq, hash }. */
async function appendAudit(reqRef, entries, info) {
  if (!entries || !entries.length) return null;
  info = info || {};
  return db.runTransaction(async function (tx) {
    const snap = await tx.get(reqRef);
    if (!snap.exists) throw new Error('request_not_found');
    const head = (snap.data() || {}).auditHead || { seq: 0, hash: '' };
    if (head.seq + entries.length > MAX_AUDIT) {
      const e = new Error('audit_full'); e.status = 429; throw e;
    }
    let seq = head.seq;
    let prev = head.hash || '';
    const now = Date.now();
    entries.forEach(function (raw, k) {
      seq += 1;
      const e = {
        seq: seq,
        type: String(raw.type || 'evenement').slice(0, 60),
        at: new Date(now + k).toISOString(),
        signer: Number.isInteger(raw.signer) ? raw.signer : null,
        ip: info.ip || '',
        ua: info.ua || '',
        data: raw.data == null ? null : raw.data,
      };
      e.prevHash = prev;
      e.hash = entryHash(prev, e);
      prev = e.hash;
      tx.set(reqRef.collection('audit').doc(String(seq).padStart(6, '0')), Object.assign({}, e, {
        geo: [info.city, info.region, info.country].filter(Boolean).join(', '),
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      }));
    });
    const newHead = { seq: seq, hash: prev, at: new Date(now).toISOString() };
    tx.update(reqRef, { auditHead: newHead });
    return newHead;
  });
}

/* Relit tout le journal et vérifie la chaîne. Sert au dossier de preuve et
   au certificat : on n'affirme jamais une intégrité qu'on n'a pas vérifiée. */
async function readAudit(reqRef) {
  const snap = await reqRef.collection('audit').orderBy('seq').get();
  const list = [];
  let prev = '';
  let ok = true;
  snap.forEach(function (d) {
    const e = d.data() || {};
    const expect = entryHash(prev, e);
    if (e.prevHash !== prev || e.hash !== expect) ok = false;
    prev = e.hash;
    list.push(e);
  });
  return { entries: list, intact: ok, headHash: prev };
}

/* ── Le modèle et son PDF ────────────────────────────────────────────────── */
async function loadTemplate(templateId) {
  if (!templateId) return null;
  const ref = db.collection('signature_templates').doc(templateId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const T = snap.data() || {};
  let b64 = T.pdfBase64 || '';
  if (!b64) {
    const chunks = await ref.collection('pdf').orderBy('chunk').get();
    const parts = [];
    chunks.forEach(function (d) { parts.push((d.data() || {}).data || ''); });
    b64 = parts.join('');
  }
  const raw = b64.indexOf(',') >= 0 ? b64.split(',')[1] : b64;
  const pdf = raw ? Buffer.from(raw, 'base64') : null;
  return { id: templateId, T: T, pdf: pdf, pdfSha256: pdf ? sha256Hex(pdf) : '' };
}

/* La version web n'est utilisable que si elle a été transcrite depuis CE PDF
   précis. Sinon : lecture du PDF original, jamais un texte qui divergerait. */
function webIsValid(web, pdfSha256) {
  return !!(web && Array.isArray(web.sections) && web.sections.length && web.sourcePdfSha256 && web.sourcePdfSha256 === pdfSha256);
}
function webDigest(web) {
  if (!web) return '';
  return sha256Hex(JSON.stringify([web.title || '', web.subtitle || '', web.tagline || '', web.sections || [], web.fieldHints || {}]));
}

/* ── Téléphone prouvé ? ──────────────────────────────────────────────────── */
const OTP_SESSION_MS = 24 * 3600 * 1000;
function otpOk(R, signerIndex) {
  const by = R.otpBySigner || {};
  const o = by[String(signerIndex)];
  if (o && o.atMs && (Date.now() - o.atMs) < OTP_SESSION_MS) return true;
  return false;
}

/* ── Dates (Europe/Paris) ────────────────────────────────────────────────── */
function parisParts(d) {
  const f = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const o = {};
  f.formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
  return o;
}
function parisToday() { const p = parisParts(); return p.day + '/' + p.month + '/' + p.year; }
function parisDateTime(d) {
  const p = parisParts(d instanceof Date ? d : new Date(d));
  return p.day + '/' + p.month + '/' + p.year + ' à ' + p.hour + ':' + p.minute + ':' + p.second;
}

/* Comparaison tolérante : casse, accents, espaces, ponctuation. « Lu et
   approuvé », « lu et approuve », « LU ET APPROUVÉ. » sont équivalents ;
   « ok », « lu » ou « X » ne le sont pas. */
function foldText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* « iPhone · Safari », « Mac · Chrome »… pour le suivi côté équipe. */
function device(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil inconnu';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return os + (br ? ' · ' + br : '');
}

/* SUIVI EN DIRECT (onglet Envois de sales-signatures) : résumé de l'avancée
   du signataire, posé sur la demande à chaque action. Étapes :
   0 envoyé · 1 lien ouvert · 2 identité vérifiée · 3 lecture · 4 société ·
   5 mentions · 6 signature · 7 signé. Le détail fait foi dans `audit`. */
const STEP_NAMES = ['Envoyé', 'Lien ouvert', 'Identité vérifiée', 'Lecture du contrat', 'Société et représentant', 'Choix et mentions', 'Signature', 'Signé'];
async function setProgress(ref, signerIndex, patch, info) {
  const u = {};
  Object.keys(patch || {}).forEach(function (k) { u['progress.' + k] = patch[k]; });
  if (patch && Number.isInteger(patch.etape)) u['progress.nom'] = STEP_NAMES[patch.etape] || '';
  u['progress.at'] = new Date().toISOString();
  u['progress.signer'] = signerIndex;
  if (info && info.ua) u['progress.appareil'] = device(info.ua);
  if (info && (info.city || info.country)) u['progress.lieu'] = [info.city, info.country].filter(Boolean).join(', ');
  await ref.update(u).catch(function (e) { console.warn('[sign-core] progression :', e && e.message); });
}

function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 2 ? '•• •• •• ' + d.slice(-2) : '';
}

module.exports = {
  sha256Hex, findByToken, clientInfo,
  appendAudit, readAudit, entryHash,
  loadTemplate, webIsValid, webDigest,
  otpOk, OTP_SESSION_MS, device, setProgress, STEP_NAMES,
  parisToday, parisDateTime, foldText, maskPhone,
};

}};

/* ── ./api/_companyLookup.js ── */
__defs["./api/_companyLookup.js"] = { map: {}, shims: {}, fn: function (module, exports, require) {
// ============================================================================
// api/_companyLookup.js — ANNUAIRE DES ENTREPRISES (API DINUM), PARTAGÉ
// ----------------------------------------------------------------------------
// Extrait de api/company-search.js (facturation, admin) pour servir aussi la
// page de signature publique (api/sign-session.js, action « company »).
// Un seul endroit normalise la réponse de recherche-entreprises.api.gouv.fr :
// un changement de l'API amont ne casse qu'un fichier.
//
// Source : https://recherche-entreprises.api.gouv.fr — publique, gratuite,
// sans clé (≈ 7 req/s).
// ============================================================================

const API_BASE = 'https://recherche-entreprises.api.gouv.fr/search';
const SOURCE_LABEL = 'Annuaire des entreprises (recherche-entreprises.api.gouv.fr — données SIRENE / RNE)';
const TIMEOUT_MS = 12000;

/* Clé de TVA intracommunautaire française : FR + clé + SIREN, avec
   clé = (12 + 3 × (SIREN mod 97)) mod 97, sur deux chiffres. */
function vatFromSiren(siren) {
  const s = String(siren || '').replace(/\D/g, '');
  if (s.length !== 9) return '';
  const key = (12 + 3 * (Number(s) % 97)) % 97;
  return 'FR' + String(key).padStart(2, '0') + s;
}

/* L'INSEE masque les données des entreprises ayant refusé la diffusion
   publique : les champs valent littéralement « [NON-DIFFUSIBLE] ». */
function clean(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  if (s.toUpperCase().indexOf('NON-DIFFUSIBLE') >= 0) return '';
  return s;
}

/* Contrôle de Luhn : SIREN (9) et SIRET (14). Exception connue : les
   établissements de La Poste (SIREN 356000000) ne respectent pas Luhn sur le
   SIRET — la somme des chiffres est alors un multiple de 5. */
function luhnOk(digits) {
  const d = String(digits || '');
  if (!/^\d+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d.charAt(d.length - 1 - i));
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
function sirenValid(siren) {
  const s = String(siren || '').replace(/\D/g, '');
  return s.length === 9 && luhnOk(s);
}
function siretValid(siret) {
  const s = String(siret || '').replace(/\D/g, '');
  if (s.length !== 14) return false;
  if (s.slice(0, 9) === '356000000') {
    let sum = 0; for (let i = 0; i < 14; i++) sum += Number(s.charAt(i));
    return sum % 5 === 0;
  }
  return luhnOk(s) && sirenValid(s.slice(0, 9));
}

/* Catégories juridiques INSEE (niveau III) les plus courantes. Au-delà, on
   retombe sur la famille (deux premiers chiffres) : jamais un code nu. */
const LEGAL_FORMS = {
  '1000': 'Entrepreneur individuel',
  '5202': 'SNC', '5306': 'SCS', '5308': 'SCA',
  '5385': 'SELCA',
  '5410': 'SARL', '5422': 'SARL immobilière de gestion', '5426': 'SARL immobilière',
  '5458': 'SCOP SARL', '5460': 'SARL coopérative',
  '5470': 'SPFPL SARL', '5485': 'SELARL',
  '5498': 'EURL', '5499': 'SARL',
  '5505': 'SA', '5510': 'SA', '5515': 'SA', '5520': 'SA', '5522': 'SA', '5525': 'SA',
  '5530': 'SA', '5531': 'SA', '5532': 'SA', '5542': 'SA', '5543': 'SA', '5546': 'SA',
  '5547': 'SA', '5551': 'SA', '5552': 'SA', '5553': 'SA', '5554': 'SA', '5555': 'SA',
  '5558': 'SA coopérative', '5559': 'SA', '5560': 'SA', '5585': 'SELAFA', '5599': 'SA',
  '5605': 'SA à directoire', '5699': 'SA à directoire', '5685': 'SELAFA',
  '5710': 'SAS', '5720': 'SASU', '5770': 'SPFPL SAS', '5785': 'SELAS', '5800': 'Société européenne',
  '6540': 'SCI', '6541': 'SCI', '6542': 'SCI', '6543': 'SCI', '6544': 'SCI',
  '6551': 'SCI', '6554': 'SCI', '6558': 'SCI', '6560': 'SCI',
  '6561': 'SCP', '6562': 'SCP', '6563': 'SCP', '6564': 'SCP', '6565': 'SCP',
  '6566': 'SCP', '6567': 'SCP', '6568': 'SCP', '6569': 'SCP',
  '6585': 'SEL', '6588': 'Société civile', '6589': 'Société civile de moyens',
  '6595': 'Caisse de crédit mutuel', '6596': 'Caisse de crédit agricole',
  '6597': 'Société civile d\'exploitation agricole', '6598': 'EARL', '6599': 'Société civile',
  '9210': 'Association', '9220': 'Association déclarée', '9221': 'Association déclarée',
  '9222': 'Association intermédiaire', '9230': 'Association reconnue d\'utilité publique',
};
const LEGAL_FAMILIES = {
  '10': 'Entrepreneur individuel', '52': 'Société en nom collectif', '53': 'Société en commandite',
  '54': 'SARL', '55': 'SA', '56': 'SA à directoire', '57': 'SAS', '58': 'Société européenne',
  '65': 'Société civile', '92': 'Association', '63': 'Société coopérative agricole',
};
function legalFormLabel(code) {
  const c = String(code || '');
  if (LEGAL_FORMS[c]) return LEGAL_FORMS[c];
  if (LEGAL_FAMILIES[c.slice(0, 2)]) return LEGAL_FAMILIES[c.slice(0, 2)];
  return c ? ('Forme juridique ' + c) : '';
}

function buildStreet(siege) {
  siege = siege || {};
  const parts = [];
  if (clean(siege.numero_voie)) parts.push(clean(siege.numero_voie));
  if (clean(siege.indice_repetition)) parts.push(clean(siege.indice_repetition));
  if (clean(siege.type_voie)) parts.push(clean(siege.type_voie));
  if (clean(siege.libelle_voie)) parts.push(clean(siege.libelle_voie));
  let street = parts.join(' ').trim();

  if (!street && clean(siege.adresse)) {
    street = clean(siege.adresse);
    const cp = clean(siege.code_postal);
    const ville = clean(siege.libelle_commune);
    if (cp) street = street.split(cp).join('');
    if (ville) street = street.replace(new RegExp(ville.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    street = street.replace(/\s{2,}/g, ' ').trim().replace(/[,\s]+$/, '');
  }
  return street;
}

/* Dirigeants publiés. Une personne physique masquée par l'INSEE reste
   comptée (on garde sa qualité) mais sans nom : l'écran ne peut alors rien
   proposer, et le dossier de preuve dit « non diffusible » au lieu de
   « absent ». */
function normalizeDirigeants(list) {
  return (Array.isArray(list) ? list : []).map(function (d) {
    d = d || {};
    const morale = String(d.type_dirigeant || '').indexOf('morale') >= 0;
    return {
      type: morale ? 'morale' : 'physique',
      prenoms: morale ? '' : clean(d.prenoms),
      nom: morale ? '' : clean(d.nom),
      denomination: morale ? clean(d.denomination) : '',
      qualite: clean(d.qualite),
      masque: !morale && !clean(d.nom),
    };
  }).slice(0, 12);
}

function normalize(entry) {
  entry = entry || {};
  const siege = entry.siege || {};
  const name = clean(entry.nom_raison_sociale) || clean(entry.nom_complet) || '';
  const etat = String(siege.etat_administratif || entry.etat_administratif || '').toUpperCase();
  const address = {
    line1: buildStreet(siege),
    line2: clean(siege.complement_adresse),
    postalCode: clean(siege.code_postal),
    city: clean(siege.libelle_commune),
    country: 'France',
  };

  return {
    siren: String(entry.siren || ''),
    siret: String(siege.siret || ''),
    name: String(name).trim(),
    legalForm: String(entry.nature_juridique || ''),
    legalFormLabel: legalFormLabel(entry.nature_juridique),
    naf: String(entry.activite_principale || ''),
    nafLabel: String(entry.libelle_activite_principale || ''),
    vatNumber: vatFromSiren(entry.siren),
    creationDate: clean(entry.date_creation),
    address: address,
    /* Vrai quand l'INSEE masque l'adresse : l'écran doit alors demander une
       saisie manuelle au lieu de laisser croire que le remplissage a marché. */
    addressHidden: !clean(siege.code_postal) && !buildStreet(siege),
    dirigeants: normalizeDirigeants(entry.dirigeants),
    active: etat !== 'C',
    closed: etat === 'C',
  };
}

/* Adresse sur une ligne, telle qu'elle s'imprime dans le contrat. */
function addressLine(a) {
  a = a || {};
  const l1 = [a.line1, a.line2].filter(Boolean).join(', ');
  const l2 = [a.postalCode, a.city].filter(Boolean).join(' ');
  return [l1, l2].filter(Boolean).join(', ');
}

/* Recherche brute. Lève une Error portant .status (400/429/502/504). */
async function searchCompanies(q, perPage) {
  q = String(q || '').trim();
  if (q.length < 3) {
    const e = new Error('Saisissez au moins 3 caractères (ou un SIRET / SIREN).'); e.status = 400; throw e;
  }
  const digits = q.replace(/\D/g, '');
  const isIdentifier = (digits.length === 9 || digits.length === 14) && digits.length === q.replace(/\s/g, '').length;
  const term = isIdentifier ? digits : q;
  const url = API_BASE + '?q=' + encodeURIComponent(term) + '&page=1&per_page=' + (perPage || 10);

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
  } catch (netErr) {
    clearTimeout(timer);
    const e = new Error(netErr && netErr.name === 'AbortError'
      ? 'L\'annuaire des entreprises ne répond pas. Réessayez dans un instant.'
      : 'Annuaire des entreprises injoignable.');
    e.status = 504;
    throw e;
  }
  clearTimeout(timer);

  if (response.status === 429) {
    const e = new Error('Trop de recherches d\'affilée. Patientez quelques secondes.'); e.status = 429; throw e;
  }
  if (!response.ok) {
    const txt = await response.text().catch(function () { return ''; });
    const e = new Error('Annuaire des entreprises : erreur ' + response.status + ' ' + txt.substring(0, 200));
    e.status = 502;
    throw e;
  }
  const data = await response.json();
  const list = Array.isArray(data.results) ? data.results : [];
  return { results: list.map(normalize), total: data.total_results || list.length, query: term, isIdentifier: isIdentifier };
}

/* L'entreprise exacte derrière un SIRET ou un SIREN, ou null. Le SIRET
   retourné est celui saisi s'il appartient bien à l'entreprise trouvée,
   sinon celui du siège. */
async function lookupByIdentifier(ident) {
  const digits = String(ident || '').replace(/\D/g, '');
  if (digits.length !== 9 && digits.length !== 14) return null;
  const r = await searchCompanies(digits, 5);
  const siren = digits.slice(0, 9);
  const hit = r.results.find(function (x) { return x.siren === siren; });
  if (!hit) return null;
  if (digits.length === 14 && hit.siret !== digits) hit.siretSaisi = digits;
  return hit;
}

module.exports = {
  SOURCE_LABEL,
  vatFromSiren, clean, luhnOk, sirenValid, siretValid,
  legalFormLabel, normalize, addressLine,
  searchCompanies, lookupByIdentifier,
};

}};

/* ── ./api/_sign-pdf.js ── */
__defs["./api/_sign-pdf.js"] = { map: {}, shims: {"crypto": function () { return __crypto; }, "./_tsa": function () { return __shim['./_tsa']; }, "pdf-lib": function () { return __shim['pdf-lib']; }, "@pdf-lib/fontkit": function () { return __shim['@pdf-lib/fontkit']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_sign-pdf.js — LE CONTRAT SIGNÉ, GÉNÉRÉ PAR LE SERVEUR
// ----------------------------------------------------------------------------
// Le PDF final est le PDF du modèle, À L'IDENTIQUE, sur lequel le serveur
// appose ce que le signataire a saisi dans le parcours web, aux emplacements
// définis dans l'éditeur de modèles (sales-signatures.html) :
//   · texte (société, SIRET, siège, représentant, date, « Lu et approuvé »)
//   · paraphe sur chaque page prévue, signature manuscrite tracée
//   · cases : une vraie case dessinée, cochée ou vide — jamais un « X » seul
// Suivent les pages du DOSSIER DE PREUVE (identité, vérification SMS,
// déclarations, mentions, chronologie complète, empreintes), puis le fichier
// entier est scellé par un horodatage RFC 3161 intégré (DocTimeStamp, lisible
// dans le panneau « Signatures » d'Adobe Reader). Toute modification du
// fichier après coup invalide ce sceau.
//
// Rien de tout ça ne se fait dans le navigateur du signataire : ce qu'il
// envoie est revalidé, puis le serveur fabrique, empreinte et horodate.
// ============================================================================

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, PDFDict } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { timestamp } = require('./_tsa');

const INK = rgb(0.06, 0.09, 0.22);
const NAVY = rgb(0.06, 0.09, 0.16);
const INDIGO = rgb(0.31, 0.27, 0.9);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);
const SOFT = rgb(0.97, 0.98, 0.99);
const GREEN = rgb(0.02, 0.59, 0.41);
const RED = rgb(0.86, 0.15, 0.15);

/* ── Polices ─────────────────────────────────────────────────────────────── */
/* Montserrat, découpe « latin » de Fontsource (≈ 48 Ko par graisse, tout le
   français : accents, œ, ’ « » € … —). Les URL « static » du dépôt Google
   Fonts qu'utilise api/_billing-fonts.js répondent 404 depuis que Google n'y
   publie plus que la police variable : on ne s'appuie pas dessus ici.
   Cache module : un seul téléchargement par conteneur Vercel chaud. */
const FONT_SOURCES = {
  regular: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-400-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Regular.ttf'],
  medium: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-500-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Medium.ttf'],
  bold: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-600-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-SemiBold.ttf'],
};
let _fontCache = null;
async function fetchFirst(urls) {
  let last = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = new Error('HTTP ' + r.status + ' ' + u);
    } catch (e) { last = e; }
  }
  throw last || new Error('police introuvable');
}
async function loadFonts() {
  if (_fontCache) return _fontCache;
  const b = await Promise.all([fetchFirst(FONT_SOURCES.regular), fetchFirst(FONT_SOURCES.medium), fetchFirst(FONT_SOURCES.bold)]);
  _fontCache = { regular: b[0], medium: b[1], bold: b[2] };
  return _fontCache;
}

async function embedFonts(doc) {
  doc.registerFontkit(fontkit);
  try {
    const f = await loadFonts();
    /* liga:false — la découpe « latin » n'a pas de glyphe pour la ligature
       « fi » : sans ça, « vérification » s'imprimerait « vérifi cation ». */
    const opt = { features: { liga: false } };
    const regular = await doc.embedFont(f.regular, opt);
    const medium = await doc.embedFont(f.medium, opt);
    const bold = await doc.embedFont(f.bold, opt);
    return { regular: regular, medium: medium, bold: bold, unicode: true };
  } catch (e) {
    console.warn('[sign-pdf] Montserrat indisponible, repli Helvetica :', e && e.message);
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      medium: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      unicode: false,
    };
  }
}

/* Espaces insécables fines (toLocaleString) et symboles absents des polices :
   on les remplace AVANT toute mesure, sinon widthOfTextAtSize lève. En repli
   Helvetica (WinAnsi), tout ce qui n'est pas encodable devient « ? ». */
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function clean(fonts, s) {
  let t = String(s == null ? '' : s)
    .replace(/[    ]/g, ' ')
    .replace(/⚠️?/g, '(!)')
    .replace(/[\u2713\u2714\u2611]/g, '[x]').replace(/\u2610/g, '[ ]')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\r\t]/g, ' ');
  if (!fonts.unicode) {
    let out = '';
    for (const ch of t) {
      const c = ch.codePointAt(0);
      out += (c < 256 || WINANSI_EXTRA.indexOf(ch) >= 0) ? ch : '?';
    }
    t = out;
  }
  return t;
}

function width(fonts, font, s, size) { return font.widthOfTextAtSize(clean(fonts, s), size); }

/* Plus grande taille (≤ max, ≥ min) à laquelle le texte tient dans maxW. */
function fitSize(fonts, font, s, maxW, max, min) {
  let size = max;
  while (size > min && width(fonts, font, s, size) > maxW) size -= 0.25;
  return size;
}

/* Tronque avec « … » si le texte ne tient toujours pas à la taille minimale. */
function truncate(fonts, font, s, size, maxW) {
  let t = clean(fonts, s);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
  return t + '…';
}

function wrap(fonts, font, text, size, maxW) {
  const out = [];
  clean(fonts, text).split('\n').forEach(function (para) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); return; }
    let line = '';
    words.forEach(function (w) {
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxW) line = test;
      else { if (line) out.push(line); line = w; }
    });
    out.push(line);
  });
  return out;
}

/* ── Apposition sur le PDF du modèle ─────────────────────────────────────── */
/* Le texte d'un champ, tel qu'il s'imprime, pour le signataire `S`.
   null = rien à écrire (champ vide facultatif). */
function textFor(f, S, ctx) {
  const c = S.company || {};
  switch (f.fieldType) {
    case 'entreprise': return c.name || '';
    case 'type_entreprise': return c.legalFormLabel || '';
    case 'siege_social':
    case 'adresse': return c.addressLine || '';
    case 'siret': return c.siret || '';
    case 'nom_prenom': return S.repName ? (S.repName + (S.repQualite ? ', ' + S.repQualite : '')) : '';
    case 'email': return S.email || '';
    case 'telephone': return S.phone || '';
    case 'date_signature': return S.date || '';
    case 'lu_approuve': return (S.luApprouve || '') + (ctx.hasDate[S.role] ? '' : (S.date ? ' — le ' + S.date : ''));
    default: return null;
  }
}

function drawBoxText(page, fonts, txt, box, opts) {
  if (!txt) return;
  const font = (opts && opts.font) || fonts.medium;
  const max = Math.max(6, Math.min(box.h * 0.62, (opts && opts.max) || 10.5));
  let size = fitSize(fonts, font, txt, box.w - 4, max, 6);
  const t = truncate(fonts, font, txt, size, box.w - 4);
  const y = box.y + (box.h - size * 0.7) / 2;
  page.drawText(t, { x: box.x + 2, y: y, size: size, font: font, color: INK });
}

function drawFreeText(page, fonts, txt, box) {
  if (!txt) return;
  const font = fonts.regular;
  const maxW = Math.max(4, box.w - 4);
  let size = Math.min(9, Math.max(6, box.h * 0.62));
  let lh = size * 1.25;
  let lines = wrap(fonts, font, txt, size, maxW);
  while (size > 6 && lines.length * lh > box.h - 1) { size -= 0.25; lh = size * 1.25; lines = wrap(fonts, font, txt, size, maxW); }
  const maxLines = Math.max(1, Math.floor((box.h - 1) / lh));
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = String(lines[maxLines - 1]).replace(/.$/, '') + '…'; }
  let ty = box.y + box.h - size;
  if (lines.length === 1) ty = box.y + (box.h - size * 0.7) / 2;
  lines.forEach(function (l) {
    if (l) page.drawText(l, { x: box.x + 2, y: ty, size: size, font: font, color: INK });
    ty -= lh;
  });
}

/* Une vraie case : carré dessiné, coche vectorielle si cochée, vide sinon.
   La case vide figure aussi sur le PDF : « non coché » est une information. */
function drawCheckbox(page, checked, box) {
  const s = Math.min(box.w, box.h) * 0.78;
  const x = box.x + (box.w - s) / 2;
  const y = box.y + (box.h - s) / 2;
  page.drawRectangle({ x: x, y: y, width: s, height: s, borderColor: INK, borderWidth: 0.9, color: rgb(1, 1, 1) });
  if (!checked) return;
  page.drawLine({ start: { x: x + s * 0.2, y: y + s * 0.52 }, end: { x: x + s * 0.42, y: y + s * 0.25 }, thickness: Math.max(1.1, s * 0.12), color: INDIGO });
  page.drawLine({ start: { x: x + s * 0.42, y: y + s * 0.25 }, end: { x: x + s * 0.82, y: y + s * 0.78 }, thickness: Math.max(1.1, s * 0.12), color: INDIGO });
}

function drawImageFit(page, img, box) {
  const r = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * r;
  const h = img.height * r;
  page.drawImage(img, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h });
}

/* Signature : le tracé, et dessous une mention discrète qui relie l'image à
   la preuve (« Signé électroniquement par … le … · réf. … »). */
function drawSignature(page, fonts, img, box, caption) {
  const cap = box.h >= 36 && caption;
  const capH = cap ? 7 : 0;
  drawImageFit(page, img, { x: box.x, y: box.y + capH, w: box.w, h: box.h - capH });
  if (cap) {
    const size = fitSize(fonts, fonts.regular, caption, box.w, 5, 3.6);
    page.drawText(truncate(fonts, fonts.regular, caption, size, box.w), { x: box.x, y: box.y + 1, size: size, font: fonts.regular, color: MUTED });
  }
}

/* signers : [{ role:1|2, company, repName, repQualite, email, phone, date,
   luApprouve, checks:{id:bool}, texts:{id:str}, signaturePng, paraphePng,
   caption }]. prefill : textes libres remplis par l'équipe à l'envoi. */
async function stampContract(doc, fonts, fields, scale, signers, prefill) {
  const pages = doc.getPages();
  const hasDate = { 1: false, 2: false };
  fields.forEach(function (f) { if (f.fieldType === 'date_signature') hasDate[f.signerRole === 2 ? 2 : 1] = true; });
  const ctx = { hasDate: hasDate };
  const imgs = {};
  for (const S of signers) {
    imgs[S.role] = {
      sig: S.signaturePng ? await doc.embedPng(S.signaturePng) : null,
      par: S.paraphePng ? await doc.embedPng(S.paraphePng) : null,
    };
  }
  const byRole = {};
  signers.forEach(function (S) { byRole[S.role] = S; });
  const placed = { 1: { signature: false }, 2: { signature: false } };

  fields.forEach(function (f) {
    const pi = (f.page || 1) - 1;
    if (pi < 0 || pi >= pages.length) return;
    const role = f.signerRole === 2 ? 2 : 1;
    const page = pages[pi];
    const ph = page.getHeight();
    const box = { x: f.x / scale, y: ph - f.y / scale - f.h / scale, w: f.w / scale, h: f.h / scale };

    /* Champs remplis par l'équipe à l'envoi (texte, ou case d'un choix comme
       la formule de paiement) : ils appartiennent au contrat, pas à un
       signataire — on les écrit quel que soit le rôle du champ. */
    if (f.fieldType === 'texte_libre' && prefill && prefill[f.id]) { drawFreeText(page, fonts, prefill[f.id], box); return; }
    if (f.fieldType === 'case_cocher' && prefill && typeof prefill[f.id] === 'boolean') {
      /* Choix unique (formule de paiement) : le contrat ne parle QUE de
         l'option retenue. L'autre est recouverte (zone `mask` du champ) et
         aucune case n'est dessinée — le texte restant se lit seul. */
      if (f.group) {
        /* mask : zone effacée si l'option N'EST PAS retenue.
           maskChosen : zone effacée si elle l'EST (ex. le « ou » de
           « — ou 13 000 € », qui n'a plus de sens seul). */
        const z = prefill[f.id] ? f.maskChosen : f.mask;
        if (z) {
          const mp = pages[(z.page || f.page || 1) - 1] || page;
          const mh = mp.getHeight();
          mp.drawRectangle({ x: z.x / scale, y: mh - z.y / scale - z.h / scale, width: z.w / scale, height: z.h / scale, color: rgb(1, 1, 1) });
        }
        return;
      }
      drawCheckbox(page, prefill[f.id], box);
      return;
    }

    const S = byRole[role];
    if (!S) return;
    const I = imgs[role] || {};
    if (f.fieldType === 'signature') { if (I.sig) { drawSignature(page, fonts, I.sig, box, S.caption); placed[role].signature = true; } return; }
    if (f.fieldType === 'paraphe') { if (I.par) drawImageFit(page, I.par, box); return; }
    if (f.fieldType === 'case_cocher') { drawCheckbox(page, !!(S.checks && S.checks[f.id]), box); return; }
    if (f.fieldType === 'texte_libre') { drawFreeText(page, fonts, (S.texts && S.texts[f.id]) || '', box); return; }
    drawBoxText(page, fonts, textFor(f, S, ctx), box);
  });
  return placed;
}

function watermark(doc, fonts) {
  doc.getPages().forEach(function (p) {
    const w = p.getWidth();
    const h = p.getHeight();
    const txt = 'APERÇU — NON SIGNÉ';
    const size = Math.min(w, h) / 9;
    const tw = width(fonts, fonts.bold, txt, size);
    p.drawText(clean(fonts, txt), {
      x: w / 2 - (tw / 2) * Math.cos(Math.PI / 5), y: h / 2 - (tw / 2) * Math.sin(Math.PI / 5),
      size: size, font: fonts.bold, color: RED, opacity: 0.13, rotate: degrees(36),
    });
  });
}

/* ── Mise en page des pages ajoutées (dossier de preuve, annexes) ────────── */
function Flow(doc, fonts, header) {
  this.doc = doc; this.fonts = fonts; this.header = header || '';
  this.W = 595.28; this.H = 841.89; this.M = 48;
  this.page = null; this.y = 0; this.pageNo = 0;
  this.newPage();
}
Flow.prototype.newPage = function () {
  this.page = this.doc.addPage([this.W, this.H]);
  this.pageNo++;
  this.y = this.H - this.M;
  if (this.header) {
    this.page.drawText(clean(this.fonts, this.header), { x: this.M, y: this.H - 28, size: 7, font: this.fonts.medium, color: MUTED });
    this.page.drawLine({ start: { x: this.M, y: this.H - 34 }, end: { x: this.W - this.M, y: this.H - 34 }, thickness: 0.5, color: LINE });
    this.y = this.H - 52;
  }
};
Flow.prototype.need = function (h) { if (this.y - h < this.M + 20) this.newPage(); };
Flow.prototype.text = function (s, o) {
  o = o || {};
  const font = o.font || this.fonts.regular;
  const size = o.size || 9;
  const lh = size * (o.lh || 1.4);
  const x = this.M + (o.indent || 0);
  const maxW = (o.width || (this.W - 2 * this.M)) - (o.indent || 0);
  const self = this;
  wrap(this.fonts, font, s, size, maxW).forEach(function (l) {
    self.need(lh);
    if (l) self.page.drawText(l, { x: x, y: self.y - size, size: size, font: font, color: o.color || INK });
    self.y -= lh;
  });
  if (o.after) this.y -= o.after;
};
Flow.prototype.section = function (num, title) {
  this.need(40);
  this.y -= 10;
  this.page.drawRectangle({ x: this.M, y: this.y - 20, width: 3, height: 16, color: INDIGO });
  this.page.drawText(clean(this.fonts, (num ? num + '. ' : '') + title).toUpperCase(), { x: this.M + 10, y: this.y - 16, size: 10, font: this.fonts.bold, color: NAVY });
  this.y -= 30;
};
/* Lignes libellé / valeur. Les valeurs longues passent à la ligne dans
   leur colonne, sans jamais déborder sur la marge. */
Flow.prototype.kv = function (rows) {
  const self = this;
  const labelW = 150;
  const valW = this.W - 2 * this.M - labelW;
  rows.forEach(function (r) {
    if (!r || r[1] === undefined || r[1] === null || r[1] === '') return;
    const valFont = r[2] && r[2].mono ? self.fonts.regular : self.fonts.medium;
    const size = r[2] && r[2].mono ? 7.5 : 8.6;
    const lines = wrap(self.fonts, valFont, String(r[1]), size, valW);
    const lh = size * 1.38;
    const h = Math.max(lines.length * lh, 12) + 5;
    self.need(h);
    self.page.drawText(clean(self.fonts, r[0]), { x: self.M, y: self.y - 8.6, size: 7.6, font: self.fonts.regular, color: MUTED });
    let yy = self.y - size;
    lines.forEach(function (l) {
      self.page.drawText(l, { x: self.M + labelW, y: yy, size: size, font: valFont, color: (r[2] && r[2].color) || INK });
      yy -= lh;
    });
    self.y -= h;
    self.page.drawLine({ start: { x: self.M, y: self.y + 2 }, end: { x: self.W - self.M, y: self.y + 2 }, thickness: 0.35, color: LINE });
  });
  this.y -= 4;
};
Flow.prototype.box = function (lines, o) {
  o = o || {};
  const self = this;
  const size = o.size || 8.4;
  const lh = size * 1.45;
  const maxW = this.W - 2 * this.M - 24;
  let all = [];
  lines.forEach(function (l) { all = all.concat(wrap(self.fonts, l.font || self.fonts.regular, l.text, size, maxW).map(function (t) { return { t: t, font: l.font || self.fonts.regular, color: l.color }; })); });
  const h = all.length * lh + 18;
  this.need(h);
  this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.W - 2 * this.M, height: h, color: o.bg || SOFT, borderColor: o.border || LINE, borderWidth: 0.6 });
  let yy = this.y - 9 - size;
  all.forEach(function (l) {
    if (l.t) self.page.drawText(l.t, { x: self.M + 12, y: yy, size: size, font: l.font, color: l.color || INK });
    yy -= lh;
  });
  this.y -= h + 8;
};
Flow.prototype.image = function (img, maxW, maxH, label) {
  const r = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * r;
  const h = img.height * r;
  this.need(h + 24);
  if (label) { this.page.drawText(clean(this.fonts, label), { x: this.M, y: this.y - 8, size: 7.6, font: this.fonts.regular, color: MUTED }); this.y -= 14; }
  this.page.drawRectangle({ x: this.M, y: this.y - h - 8, width: w + 16, height: h + 8, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 0.6 });
  this.page.drawImage(img, { x: this.M + 8, y: this.y - h - 4, width: w, height: h });
  this.y -= h + 16;
};
Flow.prototype.footers = function (label) {
  const self = this;
  const pages = this.doc.getPages().slice(-this.pageNo);
  pages.forEach(function (p, i) {
    const t = clean(self.fonts, label + ' — page ' + (i + 1) + ' / ' + pages.length);
    p.drawText(t, { x: self.W - self.M - width(self.fonts, self.fonts.regular, t, 7), y: 24, size: 7, font: self.fonts.regular, color: MUTED });
  });
};

const EVENT_LABELS = {
  demande_creee: 'Demande de signature créée',
  lien_envoye: 'Lien de signature envoyé',
  lien_ouvert: 'Lien de signature ouvert',
  otp_envoye: 'Code SMS envoyé',
  otp_echec: 'Code SMS incorrect',
  otp_verifie: 'Téléphone vérifié par code SMS',
  contenu_charge: 'Contrat affiché',
  section_vue: 'Article lu à l\'écran',
  lecture_terminee: 'Lecture intégrale confirmée',
  pdf_original_ouvert: 'Document PDF original consulté',
  page_pdf_vue: 'Page du PDF original consultée',
  etape: 'Étape du parcours',
  entreprise_recherche: 'Recherche d\'entreprise',
  entreprise_selectionnee: 'Entreprise sélectionnée',
  entreprise_manuelle: 'Entreprise saisie manuellement',
  representant_saisi: 'Représentant légal renseigné',
  case_cochee: 'Case cochée',
  case_decochee: 'Case décochée',
  champ_rempli: 'Champ renseigné',
  mention_saisie: 'Mention manuscrite saisie',
  paraphe_saisi: 'Paraphe saisi',
  signature_tracee: 'Signature tracée',
  signature_effacee: 'Signature effacée',
  consentement: 'Déclaration acceptée',
  apercu_ouvert: 'Aperçu du contrat rempli consulté',
  page_masquee: 'Page quittée / mise en arrière-plan',
  page_visible: 'Retour sur la page',
  signature_validee: 'SIGNATURE VALIDÉE',
  document_genere: 'Contrat signé généré et scellé',
  copie_telechargee: 'Exemplaire signé téléchargé',
  lecture_declaree: 'Déclaration : « J\'ai pris connaissance du document dans son intégralité »',
  signature_saisie: 'Signature saisie au clavier',
  signature_mode: 'Mode de signature choisi',
  copie_envoyee: 'Exemplaire signé envoyé par e-mail',
};

function eventDetail(e) {
  const d = e.data || {};
  if (e.type === 'section_vue') return d.titre || d.id || '';
  if (e.type === 'etape') return d.nom || '';
  if (e.type === 'case_cochee' || e.type === 'case_decochee') return d.libelle || d.id || '';
  if (e.type === 'entreprise_selectionnee' || e.type === 'entreprise_manuelle') return [d.nom, d.siret].filter(Boolean).join(' · ');
  if (e.type === 'entreprise_recherche') return d.q || '';
  if (e.type === 'consentement') return d.libelle || d.id || '';
  if (e.type === 'mention_saisie') return d.nom ? (d.nom + ' : « ' + (d.valeur || '') + ' »') : '';
  if (e.type === 'lecture_terminee') return d.duree ? ('durée de lecture ' + d.duree) : '';
  if (e.type === 'otp_envoye' || e.type === 'otp_verifie') return d.tel || '';
  if (e.type === 'lien_envoye') return d.canaux || '';
  if (e.type === 'page_pdf_vue') return d.page ? ('page ' + d.page) : '';
  return '';
}

function parisStamp(iso) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso)).replace(' ', ' ');
  } catch (e) { return iso; }
}

/* Le dossier de preuve. P : voir buildSignedPdf. */
async function proofPages(doc, fonts, P) {
  const F = new Flow(doc, fonts, 'Dossier de preuve — ' + P.templateName + ' — réf. ' + P.certificateId);
  /* Bandeau */
  F.page.drawRectangle({ x: 0, y: F.H - 150, width: F.W, height: 150, color: NAVY });
  F.page.drawRectangle({ x: 0, y: F.H - 153, width: F.W, height: 3, color: INDIGO });
  F.page.drawText(clean(fonts, 'DOSSIER DE PREUVE'), { x: F.M, y: F.H - 62, size: 9, font: fonts.medium, color: rgb(0.65, 0.68, 1) });
  F.page.drawText(clean(fonts, 'Signature électronique du contrat'), { x: F.M, y: F.H - 88, size: 19, font: fonts.bold, color: rgb(1, 1, 1) });
  F.page.drawText(clean(fonts, '« ' + P.templateName + ' »'), { x: F.M, y: F.H - 110, size: 11, font: fonts.medium, color: rgb(0.85, 0.87, 0.95) });
  F.page.drawText(clean(fonts, 'Annexé au contrat ci-dessus, dont il fait partie intégrante.  Réf. ' + P.certificateId), { x: F.M, y: F.H - 132, size: 7.6, font: fonts.regular, color: rgb(0.7, 0.73, 0.82) });
  F.y = F.H - 180;

  F.box([
    { text: 'Ce dossier a été établi automatiquement par le serveur de SARL Ambitio Corp au moment de la signature. Il rassemble les éléments qui identifient le signataire, attestent de son consentement et garantissent l\'intégrité du document : vérification du téléphone par code à usage unique, mentions saisies de sa main, journal horodaté de chacune de ses actions, empreintes cryptographiques et jetons d\'horodatage émis par une autorité tierce.', font: fonts.regular },
  ]);

  F.section('1', 'Document');
  F.kv([
    ['Contrat', P.templateName],
    ['Référence du dossier', P.requestId],
    ['Identifiant de signature', P.certificateId],
    ['Mode de lecture', P.generated ? 'Texte intégral du contrat, article par article (version ' + P.webVersion + ') ; PDF fabriqué depuis ce même texte' : (P.webMode ? 'Texte intégral du contrat, article par article (version ' + P.webVersion + '), PDF original consultable' : 'Document PDF original, page par page')],
    ['Empreinte du modèle PDF', P.templatePdfSha256 ? 'SHA-256 ' + P.templatePdfSha256 : '', { mono: true }],
    ['Empreinte du texte présenté', P.webDigest ? 'SHA-256 ' + P.webDigest : '', { mono: true }],
    ['Conditions convenues', (P.conditions || []).length ? P.conditions.join('\n') + '\n(renseignées par le conseiller avant l\'envoi, non modifiables par le client)' : ''],
    ['Demande créée le', P.createdAt ? parisStamp(P.createdAt) + ' (heure de Paris)' : ''],
    ['Envoyée par', P.createdBy || ''],
  ]);

  F.section('2', 'Parties');
  F.kv([
    ['Prestataire', 'SARL Ambitio Corp — SIRET 943 098 707 00012 — 231B chemin de Mourre de Masque, 83440 Fayence — représentée par Emily UGHETTO et Adrien FRANCOIS'],
  ]);
  const C = P.company || {};
  F.kv([
    ['Client', C.name],
    ['Forme juridique', C.legalFormLabel],
    ['SIREN / SIRET', [C.siren, C.siret].filter(Boolean).join(' / ')],
    ['N° TVA intracommunautaire', C.vatNumber],
    ['Siège social', C.addressLine],
    ['Vérification au registre', C.verification],
  ]);

  P.signers.forEach(function (S, i) {
    F.section(String(3 + i), P.signers.length > 1 ? 'Signataire ' + (i + 1) : 'Signataire');
    F.kv([
      ['Nom', S.repName],
      ['Qualité', S.repQualite],
      ['Dirigeants publiés', S.dirigeantCheck],
      ['Adresse e-mail', S.email],
      ['Téléphone vérifié', S.phone],
      ['Vérification d\'identité', S.otpLine, { color: S.otpAt ? GREEN : RED }],
      ['Adresse IP à la signature', S.ip],
      ['Localisation (réseau)', S.geo],
      ['Navigateur', S.ua, { mono: true }],
      ['Signé le', S.signedAt ? parisStamp(S.signedAt) + ' (heure de Paris)' : ''],
    ]);
    F.text('Déclarations et choix', { font: fonts.bold, size: 9, after: 4 });
    F.kv(S.declarations.map(function (d) { return [d.etat, d.libelle + (d.at ? '  —  ' + parisStamp(d.at) : '')]; }));
    F.text('Lecture du contrat', { font: fonts.bold, size: 9, after: 4 });
    F.kv([
      ['Lecture intégrale', S.lecture],
      ['PDF original consulté', S.pdfConsulte],
      ['Aperçu du contrat rempli', S.apercu],
    ]);
    F.text('Mentions saisies de sa main', { font: fonts.bold, size: 9, after: 4 });
    F.kv(S.mentions.map(function (m) { return [m.nom, '« ' + m.valeur + ' »' + (m.at ? '  —  ' + parisStamp(m.at) : '')]; }));
    if (S.sigImg) F.image(S.sigImg, 260, 90, (S.sigLabel || 'Signature manuscrite tracée à l\'écran') + ' — ' + S.traceInfo);
    if (S.parImg) F.image(S.parImg, 120, 40, 'Paraphe');
  });

  F.section(String(3 + P.signers.length), 'Chronologie complète');
  F.text('Chaque action est enregistrée par le serveur, à l\'heure du serveur (Paris), avec l\'adresse IP de l\'appareil. Les entrées sont chaînées par empreinte : la modification ou la suppression d\'une seule d\'entre elles est détectable.', { size: 7.8, color: MUTED, after: 6 });
  const cols = [F.M, F.M + 100, F.M + 330];
  function row(a, b, c, font, color) {
    const size = 7;
    const lb = wrap(fonts, font, b, size, 222);
    const lh = size * 1.35;
    const h = Math.max(1, lb.length) * lh + 3;
    F.need(h);
    F.page.drawText(clean(fonts, a), { x: cols[0], y: F.y - size, size: size, font: font, color: color || INK });
    let yy = F.y - size;
    lb.forEach(function (l) { F.page.drawText(l, { x: cols[1], y: yy, size: size, font: font, color: color || INK }); yy -= lh; });
    F.page.drawText(truncate(fonts, font, c, size, F.W - F.M - cols[2]), { x: cols[2], y: F.y - size, size: size, font: font, color: color || MUTED });
    F.y -= h;
  }
  row('Heure (Paris)', 'Événement', 'Signataire · IP · n° · empreinte', fonts.bold, NAVY);
  F.page.drawLine({ start: { x: F.M, y: F.y + 1 }, end: { x: F.W - F.M, y: F.y + 1 }, thickness: 0.5, color: LINE });
  P.audit.forEach(function (e) {
    const lbl = (EVENT_LABELS[e.type] || e.type) + (eventDetail(e) ? ' — ' + eventDetail(e) : '');
    const who = (e.signer === null || e.signer === undefined ? 'système' : 'S' + (e.signer + 1)) + ' · ' + (e.ip || '—') + ' · #' + e.seq + ' · ' + String(e.hash || '').slice(0, 10);
    row(parisStamp(e.at), lbl, who, e.type === 'signature_validee' ? fonts.bold : fonts.regular, e.type === 'signature_validee' ? GREEN : null);
  });

  F.section(String(4 + P.signers.length), 'Intégrité et horodatage');
  F.kv([
    ['Journal des actions', P.audit.length + ' entrées — chaîne d\'empreintes ' + (P.auditIntact ? 'vérifiée intacte' : 'NON INTÈGRE')],
    ['Tête de chaîne', 'SHA-256 ' + P.auditHead, { mono: true }],
    ['Horodatage du journal', P.auditTsa ? ('Jeton RFC 3161 émis par ' + P.auditTsa.authority + ' — ' + parisStamp(P.auditTsa.genTime) + ' (heure de Paris)') : 'Autorité d\'horodatage indisponible au moment de la signature — heure serveur seule'],
    ['Sceau du fichier', P.sealPlanned ? 'Ce fichier PDF est scellé par un horodatage RFC 3161 intégré (DocTimeStamp), visible dans le panneau « Signatures » d\'un lecteur PDF. Toute modification ultérieure du fichier invalide ce sceau.' : 'Non scellé : autorités d\'horodatage injoignables au moment de la signature. L\'empreinte du fichier est conservée par SARL Ambitio Corp.'],
  ]);

  F.box([
    { text: 'Cadre juridique', font: fonts.bold },
    { text: 'Signature électronique au sens de l\'article 1367 du Code civil et du règlement (UE) n° 910/2014 dit « eIDAS ». L\'écrit électronique a la même force probante que l\'écrit sur support papier, sous réserve que puisse être dûment identifiée la personne dont il émane et qu\'il soit établi et conservé dans des conditions de nature à en garantir l\'intégrité (article 1366 du Code civil). Le présent dossier, le journal chaîné des actions et les jetons d\'horodatage sont conservés par SARL Ambitio Corp pendant toute la durée de la relation contractuelle et au-delà, dans la limite des délais de prescription applicables.' },
  ], { size: 7.6 });

  F.footers('Dossier de preuve · réf. ' + P.certificateId);
}

/* Annexe pour un 2e signataire quand le modèle ne lui a réservé aucune zone
   de signature : son tracé et ses mentions figurent alors ici, en page
   numérotée du contrat, juste avant le dossier de preuve. */
async function cosignPage(doc, fonts, S, templateName) {
  const F = new Flow(doc, fonts, 'Signatures complémentaires — ' + templateName);
  F.text('SIGNATURES COMPLÉMENTAIRES', { font: fonts.bold, size: 15, after: 4 });
  F.text('Annexe au contrat « ' + templateName + ' », signée électroniquement par le second représentant du CLIENT.', { size: 9, color: MUTED, after: 10 });
  F.kv([
    ['Signataire', S.repName + (S.repQualite ? ', ' + S.repQualite : '')],
    ['Pour le compte de', (S.company && S.company.name) || ''],
    ['Date', S.date],
    ['Mention', '« ' + S.luApprouve + ' »'],
  ]);
  if (S.signaturePng) F.image(await doc.embedPng(S.signaturePng), 260, 100, 'Signature');
}

/* ── Sceau d'horodatage intégré (PAdES DocTimeStamp) ─────────────────────── */
const SIG_BYTES = 12000;
const BR_PH = '**********';

async function sealDocument(doc, label) {
  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of(BR_PH));
  byteRange.push(PDFName.of(BR_PH));
  byteRange.push(PDFName.of(BR_PH));
  const sigDict = ctx.obj({
    Type: 'DocTimeStamp',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.RFC3161',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
  });
  const sigRef = ctx.register(sigDict);
  const pages = doc.getPages();
  const last = pages[pages.length - 1];
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
    Rect: [0, 0, 0, 0], V: sigRef, F: 132, P: last.ref,
    T: PDFString.of(label || 'Horodatage'),
  });
  const widgetRef = ctx.register(widget);
  const annots = last.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widgetRef); else last.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acro) {
    const fl = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fl) fl.push(widgetRef); else acro.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
    acro.set(PDFName.of('SigFields'), PDFNumber.of(3));
  } else {
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widgetRef], SigFields: 3 }));
  }

  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const s = bytes.toString('latin1');
  const zeros = '0'.repeat(SIG_BYTES * 2);
  const hexStart = s.indexOf('<' + zeros + '>');
  if (hexStart < 0) throw new Error('emplacement du sceau introuvable');
  const hexEnd = hexStart + zeros.length + 2;
  const brRe = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/;
  const m = brRe.exec(s);
  if (!m) throw new Error('ByteRange introuvable');
  const brTxt = '/ByteRange [0 ' + hexStart + ' ' + hexEnd + ' ' + (bytes.length - hexEnd) + ']';
  if (brTxt.length > m[0].length) throw new Error('ByteRange trop long');
  bytes.write(brTxt + ' '.repeat(m[0].length - brTxt.length), m.index, 'latin1');

  const hash = require('crypto').createHash('sha256')
    .update(bytes.slice(0, hexStart)).update(bytes.slice(hexEnd)).digest();
  const tsa = await timestamp(hash);
  const tokHex = tsa.token.toString('hex');
  if (tokHex.length > zeros.length) throw new Error('jeton d\'horodatage trop volumineux');
  bytes.write(tokHex, hexStart + 1, 'latin1');
  return { bytes: bytes, tsa: { authority: tsa.authority, genTime: tsa.genTime, url: tsa.url } };
}

/* ── Points d'entrée ─────────────────────────────────────────────────────── */
async function buildPreviewPdf(opts) {
  const doc = await PDFDocument.load(opts.templatePdf);
  const fonts = await embedFonts(doc);
  await stampContract(doc, fonts, opts.fields, opts.scale, opts.signers, opts.prefill);
  watermark(doc, fonts);
  return Buffer.from(await doc.save());
}

/* opts : { templatePdf, fields, scale, signers, prefill, proof }.
   Fabrique le contrat signé + dossier de preuve, puis le scelle. Si aucune
   autorité ne répond, on refabrique SANS sceau (et le dossier le dit) : la
   signature n'est jamais bloquée par un tiers, et le dossier n'affirme
   jamais un sceau qui n'existe pas. */
async function buildSignedPdf(opts) {
  return finishSigned(async function () {
    const doc = await PDFDocument.load(opts.templatePdf);
    const fonts = await embedFonts(doc);
    const placed = await stampContract(doc, fonts, opts.fields, opts.scale, opts.signers, opts.prefill);
    for (const S of opts.signers) {
      if (S.role === 2 && !placed[2].signature) await cosignPage(doc, fonts, S, opts.proof.templateName);
    }
    return { doc: doc, fonts: fonts };
  }, opts.proof);
}

/* Finition commune : métadonnées, dossier de preuve, sceau RFC 3161.
   makeContract() fabrique le contrat rempli et renvoie { doc, fonts } (fonts
   = jeu Montserrat de embedFonts, utilisé par le dossier de preuve). Si
   aucune autorité ne répond, on refabrique SANS sceau (et le dossier le dit). */
async function finishSigned(makeContract, proof) {
  async function make(sealPlanned) {
    const built = await makeContract();
    const doc = built.doc;
    const fonts = built.fonts;
    doc.setTitle(proof.templateName + ' — signé');
    doc.setAuthor('SARL Ambitio Corp');
    doc.setSubject('Contrat signé électroniquement — réf. ' + proof.certificateId);
    doc.setProducer('Ambitio — signature électronique');
    doc.setCreator('team.alteore.com');
    const opts = { proof: proof };
    const P = Object.assign({}, opts.proof, { sealPlanned: sealPlanned });
    P.signers = [];
    for (const ps of opts.proof.signers) {
      P.signers.push(Object.assign({}, ps, {
        sigImg: ps.signaturePng ? await doc.embedPng(ps.signaturePng) : null,
        parImg: ps.paraphePng ? await doc.embedPng(ps.paraphePng) : null,
      }));
    }
    await proofPages(doc, fonts, P);
    return doc;
  }
  try {
    const doc = await make(true);
    const sealed = await sealDocument(doc, 'Horodatage ' + proof.certificateId);
    return { bytes: sealed.bytes, seal: sealed.tsa };
  } catch (e) {
    console.error('[sign-pdf] sceau impossible, PDF non scellé :', e && e.message);
    const doc = await make(false);
    return { bytes: Buffer.from(await doc.save()), seal: null, sealError: (e && e.message) || 'echec' };
  }
}

module.exports = { buildPreviewPdf, buildSignedPdf, finishSigned, embedFonts, drawCheckbox, watermark, wrap, clean, EVENT_LABELS };

}};

/* ── ./api/_contract-render.js ── */
__defs["./api/_contract-render.js"] = { map: {"./_sign-brand":"./api/_sign-brand.js","./_sign-pdf":"./api/_sign-pdf.js"}, shims: {"pdf-lib": function () { return __shim['pdf-lib']; }, "@pdf-lib/fontkit": function () { return __shim['@pdf-lib/fontkit']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_contract-render.js — CONTRAT FABRIQUÉ DEPUIS LE TEXTE (atelier)
// ----------------------------------------------------------------------------
// Un contrat édité dans l'atelier (contract-studio.html) n'a plus de PDF
// d'origine : le PDF est COMPOSÉ ici, à partir du texte structuré
// (signature_templates/{id}.web, generated:true), au moment où on en a besoin
// — aperçu vierge, aperçu rempli, contrat signé.
//
// MODÈLE DE TEXTE (web, generated:true)
//   title, subtitle, tagline
//   sections : [{ id, title, blocks:[…], signatures? }]
//   variables : [{ key, label, type, options, filledBy, required, requiredIf, help }]
//       type : text | number | money | date | choice
//       filledBy : 'equipe' (conseiller, avant l'envoi) | 'client'
//   clientChecks : [{ id, label, required, kind }]   (ex. renonciation)
//   place : 'FAYENCE' (« Fait à … »)
//
// BLOCS (une chaîne par bloc)
//   p: paragraphe · h: sous-titre · li: puce · ol: « 1. … » · i: italique
//   check:<id>                 case du client (clientChecks)
//   if:<clé>=<valeur>:<bloc>   bloc présent seulement si la variable vaut…
//   if:<clé>:<bloc>            … seulement si la variable est renseignée
// TEXTE EN LIGNE
//   **gras** · {{var:clé}} · {{entreprise}} {{nom_prenom}} {{qualite}}
//   {{siege_social}} {{siret}} {{forme_juridique}} {{email}} {{telephone}}
//   {{date_signature}}
//
// Mise en page : celle des contrats actuels — titre centré, « ARTICLE »
// en gras souligné, texte justifié — avec en pied de CHAQUE page les deux
// paraphes (« AF » du prestataire, découpé de nos PDF, et celui du client), et
// en fin de contrat le bloc de signatures avec le cachet d'Ambitio Corp.
// ============================================================================

const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const brand = require('./_sign-brand');
const signPdf = require('./_sign-pdf');

const W = 595.28, H = 841.89;
const ML = 64, MR = 64, MT = 62, MB = 78;
const TEXT_W = W - ML - MR;
const INK = rgb(0.06, 0.09, 0.22);
const BLACK = rgb(0.08, 0.08, 0.1);
const MUTED = rgb(0.42, 0.46, 0.54);
const LINE = rgb(0.86, 0.88, 0.92);
const SIZE = 10.4, LH = 14.6;

const CLIENT_KEYS = {
  entreprise: 'raison sociale', nom_prenom: 'représentant', prenom: 'prénom', nom: 'nom', qualite: 'qualité',
  siege_social: 'siège social', adresse: 'adresse', code_postal: 'code postal', ville: 'ville',
  siret: 'SIRET', siren: 'SIREN', tva: 'n° TVA', forme_juridique: 'forme juridique', activite: 'activité',
  date_creation: 'date de création', email: 'e-mail', telephone: 'téléphone', date_signature: 'date',
};

/* ── Polices du document (Source Serif 4) ─────────────────────────────────── */
const SERIF = {
  regular: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-400-normal.ttf',
  italic: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-400-italic.ttf',
  bold: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-700-normal.ttf',
  boldItalic: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-700-italic.ttf',
};
let _serif = null;
async function loadSerif() {
  if (_serif) return _serif;
  const keys = Object.keys(SERIF);
  const bufs = await Promise.all(keys.map(function (k) {
    return fetch(SERIF[k], { signal: AbortSignal.timeout(6000) }).then(function (r) {
      if (!r.ok) throw new Error('police ' + k + ' HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (a) { return Buffer.from(a); });
  }));
  _serif = {};
  keys.forEach(function (k, i) { _serif[k] = bufs[i]; });
  return _serif;
}
async function docFonts(doc) {
  doc.registerFontkit(fontkit);
  try {
    const f = await loadSerif();
    const o = { features: { liga: false } };
    return {
      r: await doc.embedFont(f.regular, o), i: await doc.embedFont(f.italic, o),
      b: await doc.embedFont(f.bold, o), bi: await doc.embedFont(f.boldItalic, o), unicode: true,
    };
  } catch (e) {
    console.warn('[contract-render] Source Serif indisponible, repli Times :', e && e.message);
    return {
      r: await doc.embedFont(StandardFonts.TimesRoman), i: await doc.embedFont(StandardFonts.TimesRomanItalic),
      b: await doc.embedFont(StandardFonts.TimesRomanBold), bi: await doc.embedFont(StandardFonts.TimesRomanBoldItalic), unicode: false,
    };
  }
}
function cl(F, s) { return signPdf.clean({ unicode: F.unicode }, s); }

/* ── Valeurs ──────────────────────────────────────────────────────────────── */
function fmtMoney(v) {
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n)) return String(v);
  const parts = n.toFixed(Number.isInteger(n) ? 0 : 2).split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (parts[1] ? ',' + parts[1] : '') + ' €';
}
function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(v || '');
}
function varDef(web, key) { return (web.variables || []).find(function (v) { return v.key === key; }) || null; }
function formatVar(def, raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!def) return String(raw);
  if (def.type === 'money') return fmtMoney(raw);
  if (def.type === 'date') return fmtDate(raw);
  if (def.type === 'choice') {
    const o = (def.options || []).find(function (x) { return x.value === raw; });
    return o ? o.label : String(raw);
  }
  return String(raw);
}

/* Une condition « if: » est-elle remplie ? cond = « clé », « clé=valeur »
   ou « clé!=valeur ». Seules les variables (pas les données client) comptent. */
function condOk(cond, vars) {
  let m = /^([A-Za-z0-9_]+)!=(.*)$/.exec(cond);
  if (m) return String(vars[m[1]] == null ? '' : vars[m[1]]) !== m[2];
  m = /^([A-Za-z0-9_]+)=(.*)$/.exec(cond);
  if (m) return String(vars[m[1]] == null ? '' : vars[m[1]]) === m[2];
  const v = vars[cond];
  return !(v === undefined || v === null || v === '' || v === false);
}

/* Les blocs effectivement présents, une fois les conditions évaluées. */
function liveBlocks(blocks, vars) {
  const out = [];
  (blocks || []).forEach(function (b) {
    let s = String(b || '');
    for (let guard = 0; guard < 4; guard++) {
      const m = /^if:([^:]+):(.*)$/.exec(s);
      if (!m) break;
      if (!condOk(m[1], vars)) { s = null; break; }
      s = m[2];
    }
    if (s) out.push(s);
  });
  return out;
}

/* Version « page de signature » : conditions évaluées, variables du
   conseiller remplacées par leur valeur, variables du client et cases
   converties dans la syntaxe que sign.html sait afficher et faire remplir. */
function resolveForSigner(web, prefill) {
  const vars = Object.assign({}, prefill || {});
  return {
    title: web.title || '', subtitle: web.subtitle || '', tagline: web.tagline || '',
    version: web.version || 1,
    sections: (web.sections || []).map(function (sec) {
      const blocks = liveBlocks(sec.blocks, vars).map(function (b) {
        if (/^check:/.test(b)) return 'field:' + b.slice(6);
        return b.replace(/\{\{var:([A-Za-z0-9_]+)\}\}/g, function (m, k) {
          const d = varDef(web, k);
          if (d && d.filledBy === 'client') return '{{field:' + k + '}}';
          const v = formatVar(d, vars[k]);
          return v ? '**' + v + '**' : '……';
        });
      });
      if (sec.signatures) blocks.push('p:Signatures du PRESTATAIRE et du CLIENT apposées en fin de document, précédées de la date et de la mention « Lu et approuvé ».');
      return { id: sec.id, title: sec.title, blocks: blocks };
    }).filter(function (s) { return s.blocks.length || s.title; }),
  };
}

/* ── Composition du texte riche ───────────────────────────────────────────── */
/* Découpe une ligne de texte en « mots » stylés : {t, b, it, ink, blank}. */
function runs(F, text, ctx, base) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\{\{([A-Za-z0-9_:]+)\}\}/g;
  let last = 0, m;
  /* glue : mot collé au précédent (pas d'espace dans le texte source),
     ex. la virgule qui suit un **gras** ou une valeur insérée. */
  function push(t, st) {
    String(t).split(/(\s+)/).forEach(function (w) {
      if (!w) return;
      if (/^\s+$/.test(w)) out.push({ sp: true });
      else {
        const prev = out[out.length - 1];
        /* nb : ponctuation française précédée d'une espace (« ; », « : »,
           « ? », « ! », « » ») — elle ne commence jamais une ligne. */
        out.push(Object.assign({ t: w, glue: !!(prev && !prev.sp), nb: /^[;:!?»%]/.test(w) }, st));
      }
    });
  }
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index), base);
    if (m[1] !== undefined) push(m[1], Object.assign({}, base, { b: true }));
    else {
      const key = m[2];
      let val = '';
      if (key.indexOf('var:') === 0) { const k = key.slice(4); val = formatVar(varDef(ctx.web, k), ctx.vars[k]); }
      else if (key.indexOf('field:') === 0) { const k = key.slice(6); val = formatVar(varDef(ctx.web, k), ctx.vars[k]); }
      else val = ctx.client[key] || '';
      if (val) push(val, Object.assign({}, base, { b: true, ink: true }));
      else { const prev = out[out.length - 1]; out.push(Object.assign({ t: '…………………………', blank: true, glue: !!(prev && !prev.sp) }, base)); }
    }
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last), base);
  return out;
}
function fontOf(F, w) { return w.b ? (w.it ? F.bi : F.b) : (w.it ? F.i : F.r); }

/* Lignes justifiées : [{ words:[{t,…,w}], width, last }]. */
function layout(F, words, size, maxW) {
  const lines = [];
  let cur = [], curW = 0;
  const spW = F.r.widthOfTextAtSize(' ', size);
  words.forEach(function (w) {
    if (w.sp) return;
    w.t = cl(F, w.t);
    w.w = fontOf(F, w).widthOfTextAtSize(w.t, size);
    /* Un mot collé ne se sépare pas du précédent en fin de ligne : on
       repousse le groupe entier sur la ligne suivante. */
    const add = (cur.length && !w.glue ? spW : 0) + w.w;
    if (cur.length && curW + add > maxW) {
      let carry = [w];
      while ((w.glue || w.nb) && cur.length > 1 && (carry[0].glue || carry[0].nb)) carry.unshift(cur.pop());
      const ww = function (arr) { return arr.reduce(function (a, x, i) { return a + x.w + (i && !x.glue ? spW : 0); }, 0); };
      lines.push({ words: cur, width: ww(cur) });
      cur = carry; curW = ww(carry);
    }
    else { cur.push(w); curW += add; }
  });
  if (cur.length) lines.push({ words: cur, width: curW, last: true });
  return lines;
}

function Composer(doc, F, ctx) {
  this.doc = doc; this.F = F; this.ctx = ctx;
  this.page = null; this.y = 0; this.pages = [];
  this.newPage();
}
Composer.prototype.newPage = function () {
  this.page = this.doc.addPage([W, H]);
  this.pages.push(this.page);
  this.y = H - MT;
};
Composer.prototype.need = function (h) { if (this.y - h < MB) this.newPage(); };
Composer.prototype.para = function (text, o) {
  o = o || {};
  const F = this.F;
  const size = o.size || SIZE;
  const lh = o.lh || LH;
  const indent = o.indent || 0;
  const maxW = TEXT_W - indent;
  const lines = layout(F, runs(F, text, this.ctx, { b: !!o.b, it: !!o.it }), size, maxW);
  const self = this;
  if (o.keep) this.need(Math.min(lines.length, 3) * lh + (o.keepExtra || 0));
  lines.forEach(function (ln, li) {
    self.need(lh);
    const yb = self.y - size;
    if (li === 0 && o.marker) self.page.drawText(cl(F, o.marker), { x: ML + indent - (o.markerW || 12), y: yb, size: size, font: o.markerBold ? F.b : F.r, color: BLACK });
    const gaps = ln.words.filter(function (w, i) { return i > 0 && !w.glue; }).length;
    const justify = !ln.last && !o.noJustify && gaps > 0;
    const spW = F.r.widthOfTextAtSize(' ', size);
    const extra = justify ? (maxW - ln.width) / gaps : 0;
    let x = ML + indent + (o.center ? (maxW - ln.width) / 2 : 0);
    ln.words.forEach(function (w, wi) {
      if (wi > 0) x += w.glue ? 0 : spW + extra;
      const color = w.ink ? INK : (w.blank ? MUTED : (o.color || BLACK));
      self.page.drawText(w.t, { x: x, y: yb, size: size, font: fontOf(F, w), color: color });
      if (o.underline) {
        const nx = ln.words[wi + 1];
        const tail = nx ? (nx.glue ? 0 : spW + extra) : 0;
        self.page.drawLine({ start: { x: x, y: yb - 1.6 }, end: { x: x + w.w + tail, y: yb - 1.6 }, thickness: 0.7, color: BLACK });
      }
      x += w.w;
    });
    self.y -= lh;
  });
  this.y -= (o.after === undefined ? 4 : o.after);
};
Composer.prototype.checkbox = function (checked, label, o) {
  const s = 9.5;
  const F = this.F;
  const lines = layout(F, runs(F, label, this.ctx, { b: true, it: true }), SIZE, TEXT_W - 22);
  this.need(lines.length * LH + 8);
  const top = this.y - 1;
  signPdf.drawCheckbox(this.page, !!checked, { x: ML, y: top - s - 1, w: s + 2, h: s + 2 });
  this.para(label, { indent: 22, b: true, it: true, noJustify: true, after: 8 });
};

/* ── Bloc de signatures ───────────────────────────────────────────────────── */
async function signatureBlock(C, opts, cachet) {
  const F = C.F;
  const S = (opts.signers || [])[0] || {};
  const colW = (TEXT_W - 30) / 2;
  C.need(250);
  if (C.ctx.web.place || S.date) {
    C.para('Fait à ' + (C.ctx.web.place || '……………') + ', le {{date_signature}}', { after: 14, noJustify: true });
  }
  const top = C.y;
  const page = C.page;
  function txt(t, x, y, font, size, color) { page.drawText(cl(F, t), { x: x, y: y, size: size || SIZE, font: font || F.r, color: color || BLACK }); }
  /* PRESTATAIRE */
  let y = top - SIZE;
  txt('Le PRESTATAIRE', ML, y, F.b); y -= LH;
  txt('SARL Ambitio Corp', ML, y); y -= LH;
  txt('Représentée par Emily UGHETTO', ML, y); y -= LH;
  txt('et Adrien FRANCOIS', ML, y); y -= 6;
  if (cachet) {
    const w = Math.min(colW, 190);
    const h = w * cachet.height / cachet.width;
    page.drawPage(cachet, { x: ML - 6, y: y - h, width: w, height: h });
    y -= h;
  }
  const yLeft = y;
  /* CLIENT */
  const xR = ML + colW + 30;
  let yr = top - SIZE;
  txt('Le CLIENT', xR, yr, F.b); yr -= LH;
  const co = (C.ctx.client.entreprise || '').trim();
  function wrapTo(t, font, size) { return signPdf.wrap({ unicode: F.unicode }, font, t, size, colW); }
  wrapTo(co || '……………………………', co ? F.b : F.r, SIZE).forEach(function (l) { txt(l, xR, yr, co ? F.b : F.r, SIZE, co ? INK : MUTED); yr -= LH; });
  const rep = C.ctx.client.representant || '';
  wrapTo('représentée par ' + (rep || '……………………'), F.r, SIZE).forEach(function (l) { txt(l, xR, yr); yr -= LH; });
  yr -= 4;
  if (S.luApprouve) {
    txt('« ' + S.luApprouve + ' »' + (S.date ? ', le ' + S.date : ''), xR, yr, F.i, SIZE, INK); yr -= LH;
  } else {
    txt('(Signature précédée de la date et de la', xR, yr, F.i, 9, MUTED); yr -= 12;
    txt('mention « Lu et approuvé »)', xR, yr, F.i, 9, MUTED); yr -= LH;
  }
  if (S.sigImg) {
    const r = Math.min(colW / S.sigImg.width, 74 / S.sigImg.height);
    const w = S.sigImg.width * r, h = S.sigImg.height * r;
    page.drawImage(S.sigImg, { x: xR, y: yr - h, width: w, height: h });
    yr -= h + 3;
    if (S.caption) {
      const cs = 5;
      signPdf.wrap({ unicode: F.unicode }, F.r, S.caption, cs, colW).forEach(function (l) { txt(l, xR, yr - cs, F.r, cs, MUTED); yr -= cs + 1.5; });
    }
  } else if (!opts.blank) {
    page.drawRectangle({ x: xR, y: yr - 70, width: colW, height: 70, borderColor: LINE, borderWidth: 0.8, borderDashArray: [3, 3] });
    yr -= 72;
  } else { yr -= 70; }
  C.y = Math.min(yLeft, yr) - 10;
  /* Second représentant du client, le cas échéant */
  const S2 = (opts.signers || [])[1];
  if (S2 && S2.sigImg) {
    C.need(130);
    C.para('**Pour le CLIENT, second représentant :** ' + (S2.repName || '') + (S2.repQualite ? ', ' + S2.repQualite : ''), { after: 4, noJustify: true });
    C.para('« ' + (S2.luApprouve || '') + ' », le ' + (S2.date || ''), { it: true, after: 4, noJustify: true });
    const r2 = Math.min(220 / S2.sigImg.width, 70 / S2.sigImg.height);
    C.page.drawImage(S2.sigImg, { x: ML, y: C.y - S2.sigImg.height * r2, width: S2.sigImg.width * r2, height: S2.sigImg.height * r2 });
    C.y -= S2.sigImg.height * r2 + 10;
  }
}

/* ── Pieds de page : numéro + paraphes ────────────────────────────────────── */
function footers(C, opts, af) {
  const F = C.F;
  const n = C.pages.length;
  const S = (opts.signers || [])[0] || {};
  const label = cl(F, [C.ctx.web.title, C.ctx.web.subtitle].filter(Boolean).join(' — '));
  C.pages.forEach(function (p, i) {
    p.drawLine({ start: { x: ML, y: 50 }, end: { x: W - MR, y: 50 }, thickness: 0.4, color: LINE });
    p.drawText(label.slice(0, 90), { x: ML, y: 36, size: 7.4, font: F.r, color: MUTED });
    const pg = 'Page ' + (i + 1) + ' / ' + n;
    p.drawText(pg, { x: ML, y: 26, size: 7.4, font: F.r, color: MUTED });
    /* Paraphes : prestataire (AF) puis client */
    const boxH = 22, boxW = 52;
    const x2 = W - MR - boxW, x1 = x2 - boxW - 8;
    p.drawText('Paraphes', { x: x1 - 42, y: 30, size: 7, font: F.i, color: MUTED });
    if (af) { const r = Math.min(boxW / af.width, boxH / af.height); p.drawPage(af, { x: x1 + (boxW - af.width * r) / 2, y: 22, width: af.width * r, height: af.height * r }); }
    if (S.parImg) { const r = Math.min(boxW / S.parImg.width, boxH / S.parImg.height); p.drawImage(S.parImg, { x: x2 + (boxW - S.parImg.width * r) / 2, y: 22, width: S.parImg.width * r, height: S.parImg.height * r }); }
    else if (!opts.blank) p.drawRectangle({ x: x2, y: 22, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.6, borderDashArray: [2, 2] });
  });
}

/* ── Point d'entrée ───────────────────────────────────────────────────────── */
/* opts : { web, prefill, texts, checks, client:{…}, signers:[{ luApprouve,
   date, signaturePng, paraphePng, caption, repName, repQualite }],
   blank, preview }. Renvoie { doc, fonts } — fonts = jeu Montserrat de
   _sign-pdf (dossier de preuve). */
async function composeContract(opts) {
  const web = opts.web;
  const doc = await PDFDocument.create();
  const F = await docFonts(doc);
  const ui = await signPdf.embedFonts(doc);
  const vars = Object.assign({}, opts.prefill || {}, opts.texts || {});
  const client = Object.assign({}, opts.client || {});
  if (!client.representant && client.nom_prenom) client.representant = client.nom_prenom + (client.qualite ? ', ' + client.qualite : '');
  const ctx = { web: web, vars: vars, client: client };
  const signers = [];
  for (const s of (opts.signers || [])) {
    signers.push(Object.assign({}, s, {
      sigImg: s.signaturePng ? await doc.embedPng(s.signaturePng) : null,
      parImg: s.paraphePng ? await doc.embedPng(s.paraphePng) : null,
    }));
  }
  const brandDoc = await PDFDocument.load(Buffer.from(brand.pdfBase64, 'base64'));
  const bp = brandDoc.getPages();
  const cachet = await doc.embedPage(bp[brand.cachet]);
  const af = await doc.embedPage(bp[brand.paraphe]);

  const C = new Composer(doc, F, ctx);
  /* En-tête */
  if (web.title) C.para(web.title, { size: 15, lh: 20, b: true, center: true, noJustify: true, after: 2 });
  if (web.subtitle) C.para(web.subtitle, { size: 11.5, lh: 16, b: true, center: true, noJustify: true, after: 2 });
  if (web.tagline) C.para(web.tagline, { size: 10, lh: 14, it: true, center: true, noJustify: true, color: MUTED, after: 0 });
  C.y -= 22;

  let signed = false;
  const sopts = { signers: signers, blank: opts.blank };
  for (const sec of (web.sections || [])) {
    const blocks = liveBlocks(sec.blocks, vars);
    if (!blocks.length && !sec.signatures && !sec.title) continue;
    C.y -= 8;
    if (sec.title) C.para(sec.title, { b: true, underline: /^ARTICLE|^ENTRE/i.test(sec.title), noJustify: true, keep: true, keepExtra: 30, after: 6 });
    blocks.forEach(function (b) {
      const m = /^(p|h|li|ol|i|q|check|field):(.*)$/.exec(b);
      if (!m) return;
      const k = m[1], t = m[2];
      if (k === 'p') C.para(t);
      else if (k === 'h') { C.y -= 3; C.para(t, { b: true, noJustify: true, keep: true, after: 3 }); }
      else if (k === 'li') C.para(t, { indent: 26, marker: '•', markerW: 12, after: 2 });
      else if (k === 'ol') {
        const mm = /^(\d+[.)])\s*(.*)$/.exec(t);
        if (mm) C.para(mm[2], { indent: 26, marker: mm[1], markerW: 18, after: 3 });
        else C.para(t, { indent: 26, after: 3 });
      }
      else if (k === 'i' || k === 'q') C.para(t, { it: true, size: 9.6, lh: 13.4, color: MUTED });
      else if (k === 'check' || k === 'field') {
        const def = (web.clientChecks || []).find(function (c) { return c.id === t; });
        if (def) C.checkbox(!!(opts.checks || {})[t], def.label);
      }
    });
    if (sec.signatures && !signed) { C.y -= 6; await signatureBlock(C, sopts, cachet); signed = true; }
  }
  if (!signed) {
    C.y -= 8;
    C.para('SIGNATURES', { b: true, underline: true, keep: true, keepExtra: 220, after: 8 });
    await signatureBlock(C, sopts, cachet);
  }
  footers(C, sopts, af);
  if (opts.preview) signPdf.watermark(doc, ui);
  return { doc: doc, fonts: ui };
}

/* ── Conversion d'un texte « web » historique (PDF tamponné) ──────────────── */
/* Les 3 contrats importés le 08/10/2026 parlent en champs du PDF (field:<id>,
   {{field:<id>}}, if:<id-de-case>:). On les traduit en variables et cases
   d'atelier ; la section « SIGNATURES » devient le bloc automatique. */
function legacyToGenerated(web, fields) {
  const hints = web.fieldHints || {};
  const byId = {};
  (fields || []).forEach(function (f) { byId[f.id] = f; });
  const variables = [];
  const clientChecks = [];
  const groupVar = {};
  function slug(s) { return String(s || 'choix').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'choix'; }
  (fields || []).forEach(function (f) {
    const h = hints[f.id] || {};
    const equipe = f.filledBy === 'equipe' || h.filledBy === 'equipe';
    if (f.fieldType === 'case_cocher' && equipe && (h.group || f.group)) {
      const g = h.group || f.group;
      const key = slug(g);
      if (!groupVar[key]) {
        groupVar[key] = { key: key, label: g.charAt(0).toUpperCase() + g.slice(1), type: 'choice', options: [], filledBy: 'equipe', required: true };
        variables.push(groupVar[key]);
      }
      groupVar[key].options.push({ value: f.id, label: h.label || f.label || f.id });
    } else if (f.fieldType === 'case_cocher') {
      clientChecks.push({ id: f.id, label: h.label || f.label || 'Case à cocher', required: h.required === false ? false : f.required !== false, kind: h.kind || '' });
    } else if (f.fieldType === 'texte_libre') {
      const rq = h.requiredIf ? (function () { const ff = byId[h.requiredIf] || {}; const hh = hints[h.requiredIf] || {}; const g = slug(hh.group || ff.group); return g + '=' + h.requiredIf; })() : '';
      variables.push({ key: f.id, label: h.label || f.label || 'Texte', type: h.maxLength && h.maxLength <= 3 ? 'number' : 'text', filledBy: equipe ? 'equipe' : 'client', required: equipe ? false : f.required === true, requiredIf: rq, help: (h.help || '').replace(/ ?Rempli par votre conseiller\.?/, '') });
    }
  });
  function convBlock(b) {
    b = b.replace(/^if:([A-Za-z0-9_]+):/, function (m, id) {
      for (const k in groupVar) if (groupVar[k].options.some(function (o) { return o.value === id; })) return 'if:' + k + '=' + id + ':';
      return 'if:' + id + ':';
    });
    if (/^field:/.test(b)) {
      const id = b.slice(6);
      if (clientChecks.some(function (c) { return c.id === id; })) return 'check:' + id;
      return null;
    }
    return b.replace(/\{\{field:([A-Za-z0-9_]+)\}\}/g, function (m, id) {
      const f = byId[id] || {};
      if (f.fieldType === 'date_signature') return '{{date_signature}}';
      return '{{var:' + id + '}}';
    });
  }
  let place = '';
  const sections = (web.sections || []).map(function (s) {
    const isSig = /SIGNATURE/i.test(s.title || '');
    let blocks = s.blocks.map(convBlock).filter(Boolean);
    if (isSig) {
      blocks.forEach(function (b) { const m = /Fait à ([A-ZÀ-ÿ' -]+), le/i.exec(b); if (m) place = m[1].trim(); });
      blocks = [];
    }
    return { id: s.id, title: s.title, blocks: blocks, signatures: isSig || undefined };
  });
  sections.forEach(function (s) { if (s.signatures === undefined) delete s.signatures; });
  return {
    generated: true, title: web.title || '', subtitle: web.subtitle || '', tagline: web.tagline || '',
    sections: sections, variables: variables, clientChecks: clientChecks, place: place || 'FAYENCE',
  };
}

module.exports = { composeContract, resolveForSigner, legacyToGenerated, liveBlocks, formatVar, varDef, condOk, CLIENT_KEYS };

}};

/* ── ./api/_sign-brand.js ── */
__defs["./api/_sign-brand.js"] = { map: {}, shims: {}, fn: function (module, exports, require) {
// ============================================================================
// api/_sign-brand.js — TAMPON ET PARAPHE D'AMBITIO CORP (vectoriels)
// ----------------------------------------------------------------------------
// Découpés le 08/10/2026 dans le PDF du contrat « BP12 5K PIF » (page 3 :
// cachet SARL AMBITIO CORP + signature ; page 1 : paraphe « AF »), polices
// retirées. PDF de 2 pages, une zone par page :
//   page 0 — cachet + signature du PRESTATAIRE
//   page 1 — paraphe « AF » du PRESTATAIRE
// Utilisé par api/_contract-render.js (contrats générés depuis le texte).
// ============================================================================
module.exports = { pdfBase64: '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11ODowGmJIipp2IQlCvoeopCTxvK96msCx7ZNtU/0md9KuOPT52a9OSc09/uyb2w+OCw396z4vnBuf91cvF67+zbjTUje228e3ty38qWqpinZv92U87iRc/pHjv26Kn8ayMcr77yp5cb7m+YVLfGuVma02db44qPGu587gmZdUnlY1OKvnl7/sJ7Xtv7dmJwIbr8YmzxhhTpH1HjJ9L70t8Pbl/26Nz0Rvuhhte+vprW2jnra9+VU0bzFnVM7dRe/U0X0h99/8M9v7O9dfdtRw+/VHMqY/u679AeX/yP/zF516I5KzbS+qeN8/sNZh6R+nPu2H82Zf3u5i2LDz74RtYzg0vzioL9fueilaunzV+65dgLV74f+Hb7j4tRzF/uosv/3HfrJ322P0MzEEbP1FNyQETCJwKkiRq2L9vbWxVfbdZeklQPOrgxeIm/8sDa+OeJCyUOYXV8X3/vIZltp2YXuRXf5V+rvPbK6H2N416J4efiBknsTH46P61hasOUNQXixznNHke3j3O6l9hxabr40VhvetiM2IrEiOCUadCEn8/JIC4lEilFsTP4W/niUJ6n1+T85OdFyQT4o9I/ObKPj8P6DmOxC4pDMrJu8chgLyk+88Gfly9eyK2721s87pGHt5k+borJWbvr+Pii1dd29zvV/4xkiuH7oX97X/1s/eU9Ox7UmkoWvnHC9O2j8hOeEYe17feW+lZOnoceunLb7KsfqT+pOPTd+0868lYtfSH5489rJ6175Mv/dL/w2tXAXXfsGLQhf82izGuT13zw9dihr/61tc7XQZ0eMtn71aiWF5986vXYijtcH96erxsxdP7y0mev7jAuO3df8l9/9fuqj7l7AqnyXcFpyR/sPfvG5vee3v1V1sax+zqP/WCZ0BA3bPbLeWc+13e89VLepIF3fVpSfW1/rvWHh5/efXx71YttilvS375t773JbzpOvDR646ZeDbtevFR08au3tNPVms7MLz97PacXX89ByDDno1lMs3P3yQNftKZcz2JKYLG6fwtXJPPDhaBPiq63WPVz7KVO/AFnMCz+M5QMQmbjeUNGxhgeJFMgs0iW9/1b9BPrmZ+o/0U2enPefxr+tJ9bOS11T/kr5ieXHTo4YdDCV3e8tOHErvsb3q14N+Viff6o1++fU3XFTCneOj5+NZNfMK9++vHvkg7+6C9///Dm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6tN0bW7bpbUhDfey2oKxjfk1A+L6wSZfiPli0ocU2u4lI4sYOOMCQSooz1+FUOiNKt2u2mJXJWDeLW8yWom1xSVoJIJBCcnB7Fb1o1VbrJZvELMQvxJWtAYMMJWXHlDchSOac7R37uig1owv51DebTp95iKw+61cRJdBcVh9sHmI6Dlecknq7ddJpi4zpkZ+JdClc63yFx33EDZQsjnIWBuxlJG6tWPFuitUQ707F4lMu0qYmJSoLS0tC+NQCcJyedjOOqpCDa34d8uU/aTyeeGFhIztBxtAaJPcSKD0/JvouKY8aEyYQKSuU48dsgjnANhHV2dqtTW8Iz9K3FgDKkxy6nHSC2QvPgJqerytCHEKbWApKgUqSd4IO4g0EBpuwaebhQ7vBhtodfjNPh45U540QFdJJPXWklN90zOmswLau5Q7hJemIcaWhCmXHe9IUlRGQTvyK6tppphtLLKQhCAEpSkYAA6AK90HH23SEvxAOsSFpjz5lxFzXs5W208FhSQBkdSRmugulli3ZUVchSkqhvpfaKDg7Q3eBUhSg1XLbBdnt3NxpKpTLamm3fIglRyR4NbAQgKKwkBSuk43mvVKBSlKBSlKBSlKBSlKBSlKBSlKBSlKBSlKBSlKBSlKBSlKBSlKD//XtWlKUClKUClKUClKUClKUClKUHM6stElyZb9R25svSrWtRWwDhTzKt6kD3Vu3VpzLveNTGJAs8KXb0l9tyZIkJ4ji20HKkYO9RPRursqUHNTLDf491kXHT81llE9KTJZktlxHGJSGw4nZIIOAN3Zr1F0XB8QC7HdHFTQ++qRIeOULU6ohRWCDuxjA7VdHSgg4GjrFAeRK4lUmS0QW5EpapDycDZAClEkADoFTBYZUsOKbSVDoUQCod3FZKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUH/9C1aUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQKUpQf//RtWlKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUClKUH//0rVpSlAp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AAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2QplbmRzdHJlYW0KZW5kb2JqCgozNyAwIG9iago8PAovQml0c1BlckNvbXBvbmVudCA4Ci9Db2xvclNwYWNlIC9EZXZpY2VHcmF5Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9IZWlnaHQgMTIxMAovTGVuZ3RoIDE1NDYyCi9OYW1lIC9YCi9TdWJ0eXBlIC9JbWFnZQovVHlwZSAvWE9iamVjdAovV2lkdGggMTAwMAo+PgpzdHJlYW0KSIns1DFLGwEYx2G9yyUXSw4UDtzcMhgcOklDC8nWpUPIZgi4ZMiUJUO+gF9A0CFzEEqndurQrxCCHyDZXZPNRc9RsYMSODyeZ3yn//J7d3YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4gHaDIIiq1WqSpulBkiR7YRgGeY8CtqqStV1vtVrD6XR6MRwOv2e91/IeBWyVzqH4dA7FFsVxfFiv1792u93JbDa7nEwmZ41G4yi7l/MeB2zFSafT+fXw3P16vf6b3U/zHgdshc6h+HQOxbObCUulUjmO409Jknzp9/u/X3a+2Wz+9Xq9b3mPBd6lWqvVjpvNZm80Gt3M5/O7h9dtlsvl1dNTyHsw8GY6h+LTORRXmClXKpX9NE0/t9vt8/F4/HOxWPy389VqdR0Egc7hYyhFUfRjMBj8ub19ZL9eg5rMzgCOT+4EshAhEMPKcpEVRUpXwQhiERRBBZZBF7kIC+Kiso5VZiriBZQRlaq1CwgfVihW1JnEiEYtzFADeCPKAouWW8SgS4RsssglAgpCp8fp2HEoKJfXnBCf31eYyXvOef7v5UH3GF2P5jqPxzPFffEAgHGBzgHQf9A5APoPOgdAP8xF9u7/r7TDhw/nFxQU3JRKpWqNRjM0gbbf6lMoFHksFssA98IAAP8DnQOg/6BzAPQfdA6AXiJzudzPQ0JCwouRV8jrdwwhw8i/J9G4pqWlpcDd3X0O7hUCAMgzZ86cFRYWFilBJpHz2J3L5fIzLi4udrhXCACAzgHQf9D5p4fEZDLZSUlJe7Kzs08tQ6hkMhn3RQHCkOh0uvH8+fNdQ0NDo9PT03+QSqU/dSO9yGtkqm33qdXqyrNnzx6JiYnxQTcQNoVCgQHSOSRDQ0PTgwcPpuYjKxDoXK+QUecmzs7Oi6OiojZnZGT8WF9fLyPi2f1Wr0qlqsjNzU0JCQlxQ8NEx71iMBroXL9B5+AN6Fy/QefgTeM8gUBwSaPRvOhDOpBCkUhkjL6xcF8cmBSWtbW1y/r16+PS0tKyioqKbre3tyvVavVvXV1d3b29vX2vESL6/uXevXtHAwICXHg8nrmJiQnLwMCATkJw7wAYiWRkZDSrpKSk9N3zu1lWVmYCnU9Xn9nZ2bnFxMQkZGVlFVRWVjYR0fRo5Ldu3drr5ub2BXr/g7Z1GnSuf6BzMBJ0rn+gc0DjcDiz+Hy+24oVK3zQp1W4WCwu7kfePb+XSFhgYCAD99WC8TBgs9nzfX19Yw4ePHi6vLy8urW1tU2tVnf09PS8ePXq1SCRbT+qqKjIS0tLi0E/6GxpaclmMBhU3DsARqJzuVwbT09Pb5RxUFhY2BZ0v/95tPPchP5ogPtqwXgYmpmZLQgODt6Bnt9X5XK5msiuR6qTSCQnExISVjk6OprhXjkYC3Suf6BzMBJ0rn+gc/CGCTqSNSdPnsxHTdfIZLJHT548eYq+4VoVCkV7f3//y9HOU3ThwgU27isHo2GZmpr+3svLKwrl9oNAILjZ1NQkR8epfP78uWZgYGCI6LbVaFBuiESi75YvX+5kbW09E91YWAwGg4J7J8C7TBcuXBguFArLNBpN33jP9p9FRUWmuK8cjMbYwsLCDb2P7UhPTxehe3cb0V2P1I5eEi7n5ub6WllZGeJePRgLdK5foHMwGuhcv0Dn4F2foU+p1cePH7/Q0NDQ0tnZqRkaGhoe79nWP3z40JxEIuFexCeOzmAwrGbPnu3p5+f3fVJSUl5hYeGdBw8eND5+/LhVqVR29fb2DhLV8+NHjx6dP3PmTOLOnTu/jYiIWL1y5Uo3V1dXZycnp9lomIzpdDoZ946AkdgODg4b0Fz8NJkzb5bJZBbQOW4MJpNpjzL7Ojw8PC0nJ+cOOhYNUV2PVIduIH9FLwnfoJeFRQsWLJjF5XIZZDIZhkCnQefTH3QOPgQ6n/6gczAWMo1Gc4qKijpRXV0t6+joeDGZM3/Z39/PQ2eMezGfCBNkHrLSz88vNi4uLvXIkSPnhEJheUVFRVVNTU1DU1NTq1Kp7EHHMkRQ1sNqtVqJngOFe5AAf3//hahtWxsbG46pqSnLyMiIjgYJBkBnUeh0+hJ0dOKpDoIldK4tZsgiPp8fERkZeeDQoUMClF+DXC4fICLoMQwrFIqn6B0hJxix4HA48NyeVqDz6Qc6BxMFnU8/0DkYLyqDwZi7atWqP507d07S3NysnsoQtKEhsCCR4OgJRePxeNaenp7LIyIiInft2rU7MzMz6ypSjtyvrKz8V11dnbylpeVXlUrV29/fP0xU1MjA06dPm9HvlKAf/cvGjRujlyJzEQuETqPRcO8OGBcak8lcHBsb+zf0HOiY6lA0y2Qyc9wr0jsMOzs7x5CQkIi9e/em5Ofnn5VKpfc0CBEdf8jL+vr6GoFA8Pdt27Z9h/L+EvdugEmBznUedA6mDDrXedA5mBJbd3f3JJFIVFZbW9va19c3MNWhuFFcXGyKe1XTE4lEohsbG5vb2Ng4LFq0yGPNmjVB0dHRm1NSUo5JJJKyqqqqmsbGxqbW1lZFZ2dn12uEgIz/j7q0tPRicnJy4qZNm6KDgoICvLy8/uDi4vIVurAvWCyWEe6NAhP21dq1a4XouTDlvt+6jG78bNyrmp5Q5wYcDsfK2dl5sb+//zfx8fEJ6enpmdevX79N1PGMxy8FBQXpvr6+S21tbS2pVCoF98aAKYPOdQd0Dj4W6Fx3QOfgY5jp4OBw6O7duwr0nTdM1JD8OTU1lYV7ZTqNQqPReGjrF/v4+ARHRkbG7969+1BGRkbuxYsXL4nF4uslJSWS27dvV1RXV9c2NjY2t7e3/0bU8bxPi1AoPLlhw4YgPp//Oy6XyzEyMmKimw8J946BKbFfsmSJiOhhSdy+fbsh7pXpNJqBgcEcDw+PdZs3b95z7NixvKtXr96RyWQqoo9ioqoPHDgQYmhoyMC9Q4BQ0DkW0DnQKugcC+gcaM3n8+bN23f58mU50cOyAn3c0XCvTudQqFTqPNR2bFJSUtb58+evFBcXl0ul0pq6urpmhUKh6unpeUn0UYylR6lUNty/f/8GOv+CnJyc4ykpKbu2bNkS7OzsbI0ulIx7twBhHL29vQs1Gs0g0UM0h8vlwqCMRKXT6d5RUVGnJRJJO9FbPlEq9PJQJhQKs1NTU/8YHh6+ytXV9Us2mw2vYfoHOtcq6BxgAZ1rFXQOtM5x2bJlx65du9YyODg4TOQAVVdVVVkwmUwS7hXqFI6lpeXWo0ePXiotLW1sa2vrI3LL36cP3cebamtrS8Ricd6pU6cOJycnJ8THx38bGhoa4OPj4+Hi4uJkb29vZW5uboJuRFTcOwUI5bt169b7H2OwLqGHhBHu1ekcWycnJ6FcLu/9GFv+Pp0qlarsypUrJ1DfkYGBga4ODg5mqGcK7h0BWgGdaxV0DrCAzrUKOgdaRUY81q1bdxp9KP46ibnRSKVSSXZ29oWx/iExISGBgXuVOoXN4XD25ObmNnV3dw9OIdkP6u7q6npQU1PzD7FY/GNOTk7q/v37v4+Li1sbEBCwlM/nz7W1teXOmDHDgEKhkHDvCvioKFQqNT4zM/PxJGdJlZeXd8LHxyd2rH8I8PX1peJepU6ZZW9vL9FoNK8nueXj1qZQKAoFAsH+xMTEr9Ex2PF4PDru1QMsoHOtg86B1kHnWgedA61bGhwcLKiqquqawPz0P3v27Gf0gZm1b9++HatXr/bz9vaO/g/79R7U1JXHAXzyDpGQ8KoBRUCggoCB0OUtj0HoKpkRxjK6u6AsEgRB3eqgYlEUKY8py65YWmGja9FlCgqyrN1qHI2UYZii4GOxiDSlkikrAlUirwSx+8uO7rCZXEg65N6knM+/uefc8zvnfM/J1fbgC+Dh4uJCJrpKQpHIZPLa6OjoHbt37xZt3769GI7VPqVSObMgYf7pp2lYjv7Ozs7bV69evXIenAB5IHPnzp3xGzduDA4ICHB1dnbmmpubU4ieDYQQeyoqKr7Xc2M96+joqIH7wZ/BYNCgD/OwsLAkbQ8OgiXwh4HoIolFAXvz8/ObYdpuSCSSH+Auf7kA+X5jCvr9+ty5c2dzc3M/SAC+gMvhcEhEV44YDZRzg0M5RwiHcm5wKOcIoTz8/f3Pt7e3P9dzY31z7NixNBcXl2XqHQz9cOPj43dpe/AyYMLXKdGFEksQGBh4qbm5+fuBgYHvZDKZQqlUzug55arR0dHBnp6ertbW1ptNTU0NZ8+eFZeVlZUePXr0cFpaWiosQRwct2tXAx5gwhlMdOGIcdiUmZnZo+eGU7sB58Pbs/qxTk1NPaztwTywyC9zkJKVlTX8M6Z5tnG5XN4Fp+bnpaWl+SKRKCkyMjLYwcHBjrzoj1FkPijnuEA5RwiFco4LlHOEEBQqlRoUExNzqrGxcUiPzTYDH5ayCxcuHIYNZvO6LxKFQnE+ffr0RW0NtgEKoaUag48qKysVekzzj319fXekUumX9fX1NWKx+BPI9oc5OTnvJycn/zY2NjYajllfFxcXRw6HwyYBogtEjBODyWQeqqio+Lcem09NpVAovhQKhX6z+iIzGAwfmUzWr61BMEC3jaSjo0OpxzT3SiSSyv3794vi4uIivby8HFksFp3oIhDTg3KOK5RzhBAo57hCOUdwZ25hYRG/devWSy0tLaN6bL6Rrq6uaydPntzt6enpMKs/s9WrV8cNDw8/09bIAyzur0cOl8u9I5fLp3WY4sFHjx5dr6mpKcrIyNgcFRUV5O3t7WZnZ2dJp9OpRBeCmBYHZ2fnv8MFM65HxtUeiMXi9KVLl3I0+rPZsmXLQaxG1mBx53ylq6vrUx2nuKO2tjbdz8/PjuhBI6YP5RxXKOcIIVDOcYVyjuBu+YoVK3ZmZ2ffffz4sVLHzacaGxt70NjY+MekpKRwCwsLM80+Dx069LHWhmAJIKRSoxEQEhIyjDG10zBDAzKZ7FZzc3NjTU3NUZFIFObo6Kh5lCKIXqKFQqFMoVDM6JhxtVG5XP5pcHDwSow+VzU0NNzQ1hDeo8C1OqO0GY7H5xhTOwEzdBPu8MOQ7xAnJyc20YNFfhlQznGHco7gDuUcdyjnCG5IgC8QCD4sKysbnJycfKVjxkfg41FSUVGR4ubmZovRt3dbW9t9LW1fwfkgx7VKo5SamZk5qmV6vr17925dVVXVIfh9Y0REhJuNjQ0Tow8ynU5n29vbW1OpVAquo0dMCuwPal5RUdELHfP9xp3q6urfcTgcrA2oFgCX0riWtjPtALcKjdYHx48f1zbtfz1y5MjbFAqFpEMfdC6X6xITE+PHYrEYBh8xYrJQzgmDco7gBuWcMCjnCC7MQGRUVNTnly5dmtQx31OQ3e6bN29WZGVlhcLmomH0TYOPyncnJiamtPTxsgHgWqlRKj5x4oS2Y7AwMTFxOZlMnivnLFtb21Xh4eHC5OTkXQUFBRkCgcAVt5EjJsUeSKRS6bSOGVcb7OnpKYKzwWmevrmhoaHpGH1MHwB4FGjcPrt48aK243UTj8eb7252iIiIyL5+/Xr36zbd8N8gCZdRIyYH5ZxQKOcILlDOCYVyjhgayRpsAZ33799/qWvGe3t7v6isrNzG5/OXzvMCu23bthVg9KNUvxiXMo1ag0QimdKYmuGBgYF3LS0taXO0M4fjOTonJ+fMvXv35K/bPa6urt6L28gRU0GG+yBiELzSMeNqXxQWFobQaDSyDi9Y09TU1ILRzyRsZEuDl2j0bsFfI82/UlK4473maeeRkJBQrdFuCpbyb7iMGjElKOfEQzlHDA3lnHgo54jBkEgkipOTk8s+8AzomvOnfX195SkpKZ5UKnW+nFPZbPbatra2f2npZwb6eWgOcKnWaMEykB7I5fKXGtNTV15e7jZHO5aNjc2G/Pz8axrtVLCUdRSAWwXzIZPJFNgHbDjSuepqiR7PIgPTzzp48GCujvH+n6bi4uJf6fgOC19f3zSMfiaLioqOG7RCkwCnJfWZlunZu379eus52q2KjY3VvMvfuAKpYuFWwTxIdDp9CZ/P9wkLCwtWV0v0gBYZlHOjgHKOGBTKuVFAOUcMhQSzzfTy8vI7derUX/TJ+OjQ0NCnGRkZHjq+6K0NGzbkYPQ1vmvXrp0GLdMksC0sLJ5rTM20SqVKDQoKssBoQ2exWJHZ2dlXsHIOfeKaczKNRmNyOBwrHo9n7+jouNLd3d3DG/j4+PhFRESsS05O/n1mZuYOgUDgi+fAFjeylZXVysuXL1/VJ+NqrXV1deFwSJB1fJG3WCz+J0Zfz+3t7e0MWaVp8F6zZo1CY2pGBgcHA2CaSRhteJ6enpVzLNNVLpdrjmcRTFtbW1fIs1AkEu0pLCz8U21tbYNUKv2qo6PjwayBTbe3t7fgObDFDeXceKCcI4aCcm48UM4RQyCZmZlxQkND17e0tLTpku2X09PTT/r7+3sfPnxYXVJSIqBQKFgb8P/fRCL51dfXf6Wlz5mhoSEZ7A0bQ1dr/ELDwsJeaEzPt11dXVjTzGSz2e9s2rTpIsZyzSiVysvwjJnBRgzrSmexWJY8Hs/B1dXVnc/nB6xbty4uLS3tDwUFBaVnzpypkUgkN27fvt3Z3d393eyct7a23jDYwJBZGHAXRMnl8gFdMq72I1wuZXv27NkQEhLy1hyXjCYSPLteoVCMa+lzvKqq6s+GrNJ0HMzNzZ3UmJ5TeXl5yzGeXxUVFXUOplWJsVwTsLafGXLAZDiAlvv5+b134MCB8qampq9hf2j+IcGiamxsrDPk4JA3UM6NC8o5Yggo58YF5RxZaGQmk2ktFAqTnzx58lTXnHffunUrJzExMczX19cK46NRG7qVldV7Y2NjmptY7UVJSclRQ1ZqOopLS0unNKbnIzhW7bQ8a8bhcCJSUlL+AdOqwliuZ52dneULNTgSoDEYjCVsNtvS2tqat2zZMle4KCITEhLeLysrOy+VSu+PjIyM6biXpsRi8ScLNTgEC0sgEMTDXaDrsvyXKDAw0OJnvGz55s2bizH6HPL39xcseHkmRx2jb2Qy2YzG9AidnZ0ZWp4PguP22jzL1ZGWlvbrhRqgOuMO7u7u4XA5pO7bt6+surq6c44/E/MZhXV/Z6EGh2BBOTcuKOeIIaCcGxeUc2ShkZlMpi0s1w74thvXZU2mVSrVE7lc/hsfHx9zfd8GG3hlenr6x1r6faVUKn/g8/lehqjStJiB3v7+/tk5n5yYmIhxcHCgazxLof2H/XoPaurO4gDevAiQ8EhKwqOA0K7iiKj4QkXcWkGKIC9lxEJhRGZVUl3F1zgt4GPFdXTcyoA6LF22UDrGFUHYiuJGYY1sl4W6lIdEDKA4OoAihHdImD2Z6c50YogJuYFcPJ+/b3J+95zf9/7uZTA+TU5OFmsZ2eCzZ8/KoqOj1+i7EBpgwgZhW1lZcbhcLt/e3t4ZFjEbMr46ICBga2Ji4pH09PRvrl271ggbSN+cK/v6+l63t7c3wNy9CGoe0sjK19c3Tp+zvE0ikUR4e3uzJlGMQqfTg+D3zzT872hdXZ2I8NsjpVVAPTL3y8vLf6PhWieI3NW3jOwmvHrNmcxC3ufxeMtgMdFxcXGpkOcCyPNPMD+9Xvy06MvKyjrt6Ohob2DD0Fthzk0P5hwRDXNuejDniEg0FovlFBYW9vv+/v5BXeYyCN9gNWKxOGj+/PmWkyhIZ7PZ4VKp9IWG/x6pqqoqJfwWSWkdUM/5P4qLiz9Uu45CpVLnrFy5slTLyMaGhoaKFy9erP7bN9CAObAC7wMH4Onl5bUhNDR01549e85kZGRcu3HjRj3MT6fNMoHx0dHR4VevXr18/vz5I3h2fMnn83lGaiSCTUKhOAsEgrP6zCj3/PnzbpaWltRJ1nSNioqaqGD3zp074wi9Q9KCUy5LodaevdA6W7Xr2BwO5+vGxsbXWkbWkp+fv0uHmlRnZ2dXiHToCXBbJBK9hpe8cX02h45kcE4URkRErIdDZjJnBdIP5txkYc4RYTDnJgtzjggBGafDZ5jHwYMHM3WdzzB86GWdOnXK1cLCYrI5d4uJifl6gv/vTkhI2EroXZISjIbyZ6Ce8y/Cw8Nt1K6zc3V1vdDc3Nw7QUsVw8PDP1+6dClBQxEqnU5nmAOIG9vW1pbj6enp9Rk4AyoqKyt7+/v7icz5uFKplA8MDDwvKyvLCwkJWQvnhcUUNvYdxIBzYM3Vq1cr9ZnTHw4fPmzz9v/W6rfFxcXVE/x/OyzK0P+fAVTRg5NUpt4eb7XXKNVZfr62tvaVlpHVnDx5MkJDDRo84/l+fn7rk5OTj1y5cqW4s7OzS5+9MBmDUqn0dmxsbCAVTFU3322Yc9OFOUdEwZybLsw5IgIFumzh4ODgX1RUdE+X+YwD+ejo6NH9+/cbnPPS0tL/aKqhUCik8JGIOX8P4sxSzzl0R7Ho1zmnUCgce3v7zAcPHvRoGV318ePHw365nkKj0egMBsOMyWRa8ng8V39//xB4dKcWFhaWdnV1deuTWX2oZjsG+6enqanph61btwbABqRMX3/fFRxvb++kjo4Onef6SCKRbI+JibEwtDLstZgJarzOzs5OJ+LuSI8WAdTbU5Sfn+/0q4us4CzPqq6u1pZxlW/d3d3t4HozuN4jKipq54ULFwrq6upadJ29oeTwwGoqKCj4Y0hIiA88aPAcnzKYc5OGOUeEwJybNMw5IgQXci7AnJuqmZvz5ZjzqTJn+/bt2frM6U+AxWQyiSjO5HK5v5ugTis8fDyJKEJ6Zn8H6u1J3LhxI/uXC1QZ/6a2trZPh/G1CIXCW5DrJ/rMfLK64DyogIKZKSkpSZs2bfpk3rx5TlQqlTKt/XwnYc5NHuYcGQxzbvIw58hgmHOThzlHk0ehUFadPn36B7lcrtBhZMrW1tZHmwEDELUGV9isZzUUG6iqqvoe9wOgLV261FcJ1Fs0j8ViUeECCrQpvbCwsFPDNZqMKxQK5TjQ5WJ9/bOgoODE3r17N61du3Yun8+3hvPATLVh6HQ6DVBh0+FMpxZ0fPW5c+fKdRyhUiqVNocCItcwKyws7JyGYgNisfg7IguRFn358uV+muYx18LCQhUZiDn1TElJSffk00mciry8vFSBQLDR19fX3dra2my624cw56SAOUeGwZyTAeYcGWRlSkrK9ZGREbkO4xsuKir6jgNUn1pELYDBZrPj2traujQUbI+Pjw8nqhCpsaH1JertuVZQUOBsbm7+cXBw8Jns7Oxncrl83PCU6q4D5iYqKyvLycrK+vLAgQOfR0VFrVq4cCGfxWKZM5lMBp1Op8JBMt3dQ+/5paen39JxrMNCofAvNEDkAhhWVlYJnZ2dfRoKtkVHR28gshhpsW/evPnGK9fl3NzcDyDnAeHh4VmQ+Sk/y5/Ay90teInIghfC5KSkpIigoKD5bm5ultPdLqQOc04KmHNkEMw5KWDOkd6oDAbD2t7efl1ycvLV/v7+ER1GKpdIJD96enrOJXoxy48dO3ZdqVSqf1jKu7u7K2xsbNhEFyQdMz8/vw0jQH0mleXl5Q9bWlq6e3p6BoaGhpTEpHdi7eA0HAyrfXx8Zrm4uNjz+XwusLG2tmYBcyaTSYdzgDLdLUMqNMi5rZOT04bU1NSbOo5Y3tjYeA9G+wHRi1kNZ8EbJ5WqIJzxItg3ZkQXJB2mv79/uKaZ3BOJRN0ymczo+f4/OL6lXx05cmSOu7s7k06nY55NGuacVDDnaFIw56SCOUc6sYTP3CWBgYFfnDhxQnj//v361tbWtidPnryA77ohHcbblZaWluzm5uYCo6UTuTC6hYVFUm9vr6ZFtB86dCieAogsSDo0Ho/nUV9f36RpLsNDQ0MKpdIoMR9taWmR1NTU/CgUCr+HaB9eD+A572ILGKqMv+ujMT1sDofjGxkZ+dXFixfvdXR0yPSc+QuBQBBHdMZVGJaWlvsmKPo4MTExguiCpENzcHDwgjebLkNzq68ReH+rF4vFFTk5OZdgFAnzwHR3A2mFOSctzDnSGeactDDnSCuHWbNmhcbFxZ3Nzc29//Dhw9anT5929vT0DMrlcn0+6Fq3bNkSzOVybY3xPcZbtGjRKQ1Fh9va2q7b2dnZEl2QdHh5eXlXxsbGFETlVxvFwMBAa2Zm5gk/P7+VHwF3d3c3JycnRzgnbJlguruB3uAye/bsz/ft23f57t27hhwGzcuWLZtvrEU6+vj4nNFQdFAikQjh/YFmrMKk4SgSicQGjE8vCplM1pyWlpbE5/O5033nSCeY8xkBc460wpzPCJhzNCH/zZs3lzU0NLR1dHT0wOzGDJj9z46OjjxjLdQzPj4+T0PR5h07doRTgLEKk4YbjK/fgPG9VW9jY2Pp7t27d0RHR4cuWbLESzVveMTSp/vO0VtF7dq1S0rQPqjjcrk2xlroQljoZQ1F/xscHLzKWEVJxZ2gMU7oZXV19V+DgoLWLliw4CMajUad7jtGOsOczxiYczQhzPmMgTlHGgVERkZWPn78eJigfSC7c+fO3wIDA9dQANGL/SQjI6NCrWBvTU1NDofDsSK6GCkRmvOhnp6ejqampp/EYrGotLT02/T09KQVK1Z4QrttWCyWuTFmjIziM4FA8JTAvaGQyWSPYmNjw42xBz7Nzc39l1rBlyKR6CzRhUiL0JwPdHZ2PoLz+25JSYkwJyfn5LZt29ax2Wzz6b5LpDfM+YyCOUcaYc5nFMw5esOHHh4et5ubm4cJ3BvjCoVisKGh4d9Hjx49wABELdZu7v/Yr/egpvIrDuCTe/PiGQhk0YBIwOUlD5GKuxhRy0MWER+jYxxYWnzCGMoyPndgKF2XHcXRrqID0oIs2PqoMigp0m2Bio52shtRFxBQimx4Iy5GgSiy9kdncDDekNyQGHP3fP6+95zDPff7u8HTM6Ozs3NQpWFrdnb2Nn01MWmYlZWVr772OCiXyw+HhIQEBwUFBfr7+/t6e3u78fl8Lo7jmLH/UkCK34IFC/6rrxdDxVBpaWkhC9HXsI4LFy48StDo3t69e0X6amLScC6XG6Cv/fU1NzcnGfsvAnoBOacUyDkgBDmnFMg5eAvX3t6+sLy8/Km+XgwVL7u7u1szMzP3MZlMhj4Gji4sLJQSNIKcT7CIiIiI13Vf3Q8ePLhWUVHxzfHjx9OSkpLWh4WFCYz9F4Fp48+aNauut7d3dBpZ1kQpkUjOsRF9DLxJKpX+SNAEcj6BExcXl6rrrlplMtn53Nzcz7dt2/ZrLy8vHoPBwIz9F4Fpg5xTDuQcvAVyTjmQc/AajswLDAz8Oj8//5FSqfyZ5PswOjw8fKegoODI7t2796MaFYODg0Nqrh3r6upqS09P34feGcZ0huZ5enoeGBgYIGoEOZ/ALyws/BuZXfaj/RxMSkqK27BhQ1RYWNjH8+fP93R1df3A2tqahWEYzdh/EdAZHVkeHR39XXNz8wuSGR/3XKFQfCsWi9cHBASEJyYmHkO/CX6a4voXFRUVZSxkOkPPFgqF+WoaQM4nzK6pqblJZpc/oncgxtnZ2RK9E5BpaoGcUxbkHLwGOacsyDl4LTIqKqqiurr60ZMnT8bIvBTI0+7u7rLk5OTVHh4es7lc7kx3d/cgkUiUgKJ24MqVK0Qv2VhHR0d7KoIjugxMZ7PZa/Py8qQExV+OjIxcX758+QJ9PyWTQ+fxeAt7enr6td1lR2tr6+exsbGzLSws6DQaxJxiUnbu3DlMMt8TBtD5n+Xi4mI3qR7GYDA4Xl5eoYcPHz6j5r6Xpcj4DwldBmZZWlp+JpPJOgkKj6IfF5U+Pj4CPT0c08UUCAThZHZZL5VKhXZ2dgxjTw4MAnJOSZBz8AbIOSVBzsEb/piTk6MkH/FXoyMjIxKxWLzMysqKNakeDcMwpo2NzazQ0NDNd+/evU9w789tyGaEgS4mO7Db0qVL8/r7+4cICjd99dVXW7hcrpUeH5BpsgwJCflU213er6+v/0wkEvHZbDbpfQCTUHLu3LnnOuRciT6dR9zc3OzU1KXb2toGSSSSa+oKFCNsHMfJDhy0adOmcjU1ry5ZssR3mg+EGmzWrFmTrO0ur1VWVvqin0mkdwFMBuSckiDn4A2Qc0qCnIPX7JAfWlpaxkinHL0bhw4dWsXhcNhqamMsFsshJiYm7uTJk+eICtxDkrZu3coxMzOjkRg6NC0trYag3uPbt2+fcHR0VHfw/ILQaLQZe/bsOazNHu83NjYmrlu3zp7BYJBZAzAdrohSh4yPyxcKhbO16MFZsWJForoi5WVlZXwbGxuMxNAxR44c+Q9BrfYLFy7s0vVJUAvKuXNOTs5ftNljTUVFhRs6kyHj1AU5pybIOZgMck5NkHMw2TbkhQ4Z/764uDjOycnJWoseLDc3t8U3b96sIyp0v6WlZX9GRobrzJkzcS2H/k1paWkTQa3vkpOTo6bzNCjDJjIyMkEmkzVo2mNHe3u7ODY21hbHccg5daG4Fr/UIeenVq9e7UGiz4zc3NzT6oq1tba2LvHz82NqWSxFKpV2EtSpDAoK+lCXp0A5zllZWQXa7PF7dP66WVhYkPk5BUwP5JySIOfgDZBzSoKcgwk0e+T2nTt3xkjke1SpVF4vKCj41NPT045EM2uRSCR+9uzZEFHRnx4/fnwKHQSutra2uIZC5lwuN6uzs1OhUmOoq6ur0NHRkTudR0IJlujEXFVbW3tL0y77+/r69onFYjsGg0Ez9tTAUGgeCImI/9+IQqE4IBQKHUk2o/P5/AW9vb39UxUPEQgEDA2FeHPmzPkzwb2PZDLZl7o+CkqZERsbm6nNLpsaGhrmoGMTvuWUBjmnJsg5mAxyTk2QczAZtgwhm/N/5+XlrXVxcbEm28za2np2bm7uN1MV352QkGCjoZDfqlWrygjubSkqKtqu24OgEKa9vX3w2bNn/6lpj+i4VmRlZGTwzM3NacaeGhgSHo+QzfkfAgICeDo2ZAUHB6+cqvjfz58/r+mHQlRmZuYNgntviMXiCB0How5Lb2/vBG322CGXyz0dHR1xY08MDA1yTj2Qc6AKck49kHOgCv8dQibj965evRrn5ORkqWNDukAg8Lt48eJldQ0a6urqlvv6+pqpKYDhOJ506dKlBwT3VkZGRvrr+igogUan0z/ctWtXnqY9PkeOHz161IHD4dCMPTUwNPp+hEzOS1JTU32m2ZS5bNmyKb/pv9++fbu9mpsZbDb7a4VC8Zzgvr/y+XzbaQ5n2nBzc/PwhoaGh5r2iJ6gwtfDwwMz9sTgXYCcUwvkHBCBnFML5By8Bf2nyz6JaJvxgc7Ozozw8HDHafalo/drnkQiqVDXqPz06dMfOTs7swhudnB3dz81MjIyqnLPU7lcftTGxsZ8msOZNh46QlO7uroeadrlGcTJwcGBZuyJgaHR0JfR+ltE25zfraqqCkeHgz7eDXpoaOgnUzVLiY6OJvo2z1+7du0VguvbKysrU/UwmGnzP3bs2GVtdvkRAt/yXwTIOfVAzoEqyDn1QM7BZOMZt1y5cuWaHxBt3ouH9fX1eWlpab4Yhukj57i3t7f/vxB1DYsOHjzoSqfTVZuFpaSkXCO4/u6JEydi9TCY6TLj8/kx6Ni+pWGVY7W1tVfdEH3sEbzXMB6P53L9+vUb2mR83IXs7OxAMzMzXJ9DfIKoazikUCiWWFhYqDbcXFxc3ERw/T9EIlGQHoczPTMjIiK+0GKVz9GTEhl7WPBOQM6pB3IOVEHOqQdyDibDOBzOB2jVv21qamrW9FIoh4eHZdXV1fvi4uJcmUwmpsdBaAFIHTKmpvF6Dw8P88mT4zi+u6qqSk5wfWlISIi7HoczLRhazbz09PQzGtb5srGx8c6iRYuCjT0wMDimj4/P4tbW1jbNR/+rV71yuTxx8eLFXENNk4K8UNP8i/j4+BmTrmWw2ew89J0nuv4k+vazDDXke49la2sb39vbO6hhnSNZWVmZxh4WvBOQc+qBnANVkHPqgZyD1zAMYzo7O3vu2LFjb3d3d6+mjA/09PRcLikpiZo7d66loYaKQR60t7ePEQzwp4yMDMGka3kuLi4lw8PDoyrXDba1tX2JzgCGoYZ87zkIhcL0wcHBoSnWOdbX1/cQnZyxxh4WGBSNwWDYb9myZZ+mfE+4JpFIAq2srHBDT3YiPz9fSTBAo1Qq/dWk6z7euHFjDcF1t3JyctYbesj3WkhRUVGthnUqKysrL+CIsYcFBgU5py7IOZgAOacuyDkYh3M4nP+xX+4xTaVpHE5v2HJpKcXCCA5SjVyEKKt4WQGvMOIiOioBE5LVGYjialxZwKAgAongLV5GQSpRBAmjRAXWxSojiyxD1lXj1nUENsCMA6MUxqotCLSU7NfJ8g8ppwem53yd0/f5h4Rz+p7f+73n+c457itXrtxw6tSpYjKO92s0mkt5eXlz7e3t2VSn25ecnNyr1WpHx4V41draulooFHLROXYCgSA2JyfnmYmwD9PS0sKpDmm18CUSydZ79+49Jxjn6PDwsBrNPpeNwB0YoAynpUuXbuvq6uoh47iR754+fRrk4OBAy01hh2hSKpV6E0GSgoODRegcN5lM9jXafHQmzrns6+vrRkdQq+TTdevWnTYzzhGVSvVCKpVOxx0WoBTwnLmA58AY4DlzAc8BIywul+u+ffv2Q729vW/Jen6nvLzch8/n0+I5l8fj1dTX1w+bCHJ48+bN7uic+eHh4XcHBgbG7wWDarX6jJeXlwsdQa0OFpvNnr9nz55yM+McfPjw4W2xWOyMOS9AHVyRSLRiMs9yI5/Nnj17Gp0pD2RlZWlNBGmqqqpaiI5nKhSK1yaOt9fW1ibQGdSq4Nnb2yei2arNjPN1aGjoEtxhAUoBz5kLeA6MAZ4zF/Ac+AUWi+UYGBgYq1Kp3pJ1/G1vb2+op6cnj86ge1JSUj6YCPPvhoaGtejL8mRzc3OfiePKkpKSODqDWhUib2/vVDRbUys3hr67u/tpUFBQAO6wAGWwOBxOQFlZmYKs40auFRQUuNOddFVERMREO9HRmJiYf05wrCIyMtKX7rBWw9KMjIy/mhmnKj09PQl3UIBSwHNmA54DRsBzZgOeAyw2m+0wa9asiJqamqbJeH75zJkzbnSnXRoSEtJrMBhMBZLv379faeL/Bp1OdyU0NNSb7rBWw4rjx4/XEYzSoNVq2xMTE+NwBwUogycUCkOrqqom5biRXKSVC91pBfb29u0ajcak6BPwoaur6wB6Y2HTHdZq+KNSqewmWiGFQiFHK8TBHRSgDPCc+YDnAHjOfMBz24bN4/HEfn5+W+rq6p5M1vPj6enpEroT8wUCwVPkrX4SQVUvXrzYh25iFt1hrQK+WCze3dLS0jPB6oyOjIz0lZaW5tv0TshshL6+vjva2tqI9voJ+duNGzc8cKT+S1ZW1rtJBK1NTk5ejiOoVRCSkZFxl2B1dCqVqkEqldL+agbQBnjOfMBzADxnPuC5bcNBX7qeYWFh+zs6Ot5MxfO66urqmTiSJ6Wmpr6dRNDqpKSkxTiCYsfO0dEx8tixY/UEq/MR7fM1rq6uYtxhAUqQbdu27fxU/B6jX6PR+HO5XBbdyae7ubm9mkTQo+gutqc7pFUQkpKSQvQsN/IyMjLSdt92mA94znzAcwA8Zz7guW3D4fP58xISEi79Ks+1Wu18gUDApju9ZPr06W2Dg4OjJEKO6HS6HIlEYnues9EWvCYzM/MbgtUxDA0NPVu7du0S3GEBSghC+/yNX+P4GElRUVEiHB38OTs7u49EwP/cunVrK46A2PEOCQm5amZ1ugsLC1NxBwUoAzxnPuA5AJ4zH/DctmFxOJxF6enpN8l4rNfrdYMI9Fdv6vieTZs2YfF8L/ry7CXRgLKysnILjoB4YbFYc1avXn2NaGlGR0d/PHfu3H7cWQFKmBsTE1NMxnGEJiMjI3XatGkOXyFMndBw586d2Ti6EInF4jYSHZTFxcXNwxEQK0J3d/cTKpWqn2BlBjo6OiqcnJzscYcFKAE8Zz7gOQCeMx/wHJis5ym/ec/9cQTECnhuuzhIpdLPT58+3UjScfWhQ4f2/f+3LG/ERCfuWL58uROOjg6hzafXTBcZzs7OfBzhsMFH7qY1NjZ2m1mZZjS2ANxhAYsDntsG4LltA57bBuC5bQOe2wbgue3C4fF4CfX19e16vd5AwvG3yKAj6DfcsQIsRClixMTJ3Z2dnWEikYhLlIAKAhYtWtRK0EXL/fv3t6LgdOfCh3jGjBlHHz9+3GMwGEYJVqbtxIkTX7LZbBtaGpvA6PmupqamVyQc/8Vz9NzPZI1T5ArClOc9XV1dK9Fjk3bP/YKCgloIunipUCi20B0KK2IPD48TSqXyZzPzbc3Ly9uOOyxgccBz2wA8t23Ac9sAPLdt1hw8ePCBXq83kHD81c6dO+MEAgF/fJEAxJCJH4yij8HbFy9e9KG7K7Grq+tzgk6+QV+hK+gOhZUEuVz+cmRkZJRgVTTt7e1ytC074g4LWJzPcnJy/kHCcSPfx8fHbzBVZA7ClOdG7paWlvrT3ZXIxcVFSdDJ/fz8/FC6Q2ElqaysrN3MfD+0tbVd4PP5drjDAhYHPLcNwHPbBjy3DcBz24TD4/HCU1JS7mm12mESjveWlJTkCgQCvqliXETx1atXTRUa+vjx48GNGze60dmdOc8rdu3aNZ/OQFgRSaXSCjQGvZkZ/z0qKmohC4E7MGAxjJ5vyM7ObibhuJE3BQUF6UQFzxUWFk70TM+Ni4ubQVdnRsx5Xp6QkBBIZyCsOLu7u98kMeN7ISEhfrjDAhYFPAfPwXPmA56D5+A5s3GUSCT7rl+/rlSr1YMk5v++ubn5ioeHh5SoaEBgYOCHCQq87uzs/GLBggUimho06/lXERERXnSFwc663bt3/8vMjNvLy8v38vl8Hu6wgMUQSqXSrMbGxp9IOG5E/eDBg/PoHrAjKuo5c+bM9xMUGNBoNHuXLFniQleH5jw/u2rVqpl0hcHO5wcOHHhmZsYt6HVsB+6ggEUBz8Fz8Jz5gOfgOXjObNgcDmdvRUVFy8DAgJ6E483Lli1b6OXl9QkLQVSYh4iMjo6+izaQwXFFDIg3nZ2dTQqF4vyRI0c2BAQEUOq8Oc+zfXx8aNt0sOLs5uZ2GS29lmA1dP39/dfQinyCOyxgMThcLvdIU1NTDwnHjdxHxjiRLe47b968r2traz9OUKyno6OjRi6XxwcHB0up7NKc51kymUxEZQCrQeLh4XETvU7piDxHxy+JxWIH3GEBiwGeg+fgOfMBz8Fz8Jz5/G79+vV3tVot0dzHeFVWVpaK9gUO2eJ8gUAgmzNnTlFlZeUHUzfU0NDQ+76+vtYnT57EcjgcFlVdmvM82cnJyY6qi1sNLDabvbeoqKh9ZGRklGA1vk1LS4tE42DjDgxYjLD4+PhvSThu5L8nT578cioXyS0oKFATFB5ED5BdaAOh7MYy5/k+Pp/PperiVoPR81yFQmHu3U0RGxsbjDssYFHAc/AcPGc+4Dl4Dp4zn/j8/PzvSDj+86NHjy74+/t/OpWLyHx8fI4VFxffrK6u/kGtVuvHFTegD8ZkoVBoZ+nuxiDyfAAFSkQGsKi6uNXw++jo6AbUrY5gzq/RnDNdXV0dcYcFLErihQsX2kh4/ho9B7IdHR0FU7kIl8fj7T58+PD5oqKiFpVKNWziAqlisZhv6e7GIPJcgwJ9QdWFrYo/JCYmPjcz5+/RnP+EOyhgccBz8Bw8Zz7gOXgOnjOftNu3b/9oZvY/1dXVnVy8ePFcDofDnspFWAhPmUzm4+fnFxYeHp559uzZF+/evRv7UHwol8vXoL1gSsXJQOT5D/9jv/5Do7zvOICTu0tvJv5KtFEk4zJcxFxMNCkjIWJhq5bFJp3tpCvDaov6R4y0KzSyOKrxj82wgQ7Ev5xxii7OWAtFZCVsOtdRmrpSqe0WuzCZww0crtyozUxX9nRNYYzeBeY9e+Tx9fr3juf7/t7n+36e5y5cuPBYWAvfMcqCe/SBYKfvTTHrUx0dHUuiDkvRPR/cv69NMft3jxw50p1Op0uLsWB62rRpa7q6ul4JHqPjkwsMbdu2rakYF8+nUM8vnz9//pEwF78jzAhel36Wy+Umppj1j2pra++NOixFp+d6rufxp+d6rufx13XgwIF3C8z98uDgYG9TU1NNIpEoKcaCiWQyOT+Tyaxob29/sru7+9menp4HFi5cOKsYF89n8bJly36bZ4cjx48ffzDMxe8IjwS31rcnJiY+KjDrt44dO7ahvLz8nqjDUnRP7tmzJ18D/t2CXbt2rSkJFHvhZCqVyixZsuRLbW1tVcW++H+7b8WKFaN5dvirgwcPfiXsAJF7OpjzHwvM+WO/3Llz56qogxIKPddzPY8/PddzPY+/xpUrV/78M2Y+cfPmzV/39/c/VV9fvyCMhT++d5TNmjWrcs6cOekwFvhPW3bs2HEtz+l+ZWBgIN49T5WWlp4YHR19v0DH/3blypXvL126NJRZE7l7M5nMi58x93/kcrnjnZ2dDVEHLIrvHjp06K/5eh589kDUAUN1TzqdfrXQgzzw54sXLz4TfC8VdVhCoed6rufxp+d6rufx97ny8vJHe3t7Dw8PDw8dPnz4B9u3b3++r6/vWxs2bPhydXX17KgDFsVLly5d+iDPCb9w8uTJr0YdMFQLampqfjNFz1/asmVLazKZLIk6LKGprq+v7963b993glm3NzQ0NLe0tHyhrKysNOpgRfN68HbyYZ4TfvH06dMPRR0wVLWNjY1vTtHzfcF35kcdlFDpuZ7refzpuZ7refyVV1RU1C9fvrwpm81+vrKycm5VVdWMVCqViDpYUUyfOXPmpVu3bn2U54S/PTw8/HDUIUO1fPXq1e8U6PjIwMDAY8Hcp0UdFP5nc+fNm3e5wCn/3dmzZ9dEHTJUq9etW1foF/jJ+vXrG6IOCbdFz/Wc+NNzPSf+vpjNZscKnPLXBgcHH4w6ZKjW9/T0XMmz+zeGhoY21tXVzY06JNyWptbW1j8U6Pkv9u/ff3/UIUP1dH9//5/y7P6n3d3dy6IOCLdNz/Wc+NNzPSf+Fjc2No4V6PmPN23alI06ZKjWdnV1vXr16tW/j4+P/3Ny17nr16+fPXr06FPNzc1VUQeE21ZTW1v7+wI9/15bW9v8qEOG6v7Ozs5TIyMjf8nlchOTu742Ojq6e+3atQujDgdFoed6TvzpuZ4Tf7MrKytfv3HjxoeTJ/xW8C/1zXPnzp069omvZzKZGVGHDFVm0aJF39i8efNzvb29O/r6+nYFntu6devKbDZbEXU4KJqXx8bGxid7/n7wVDsSnPQnOjo6HgpkUqlUIuqA/zcliUQiGey4JOogUHR6/ik9J770/FN6Tnx9e+/evS+eOXPmhRMnTvxw9+7dj69atap58ScqgpN/95z6kkDirtoxd4/GlpaWb27cuPFr7e3t1dOnT09GHQgoOj2H+NNziL8FmUzmvtbW1oa6urrZ6XQ6EXUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7FHhyQAAAAAAj6/7ofoQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsJIAAwB+FFOPCmVuZHN0cmVhbQplbmRvYmoKCjM4IDAgb2JqCjw8Ci9UeXBlIC9YT2JqZWN0Ci9TdWJ0eXBlIC9Gb3JtCi9Gb3JtVHlwZSAxCi9CQm94IFsgNDA1IDEwIDQ3MCA0MCBdCi9NYXRyaXggWyAxIDAgMCAxIC00MDUgLTEwIF0KL1Jlc291cmNlcyA8PAovRXh0R1N0YXRlIDw8Ci9HUzAgMjggMCBSCj4+Ci9Gb250IDw8Cj4+Ci9Qcm9jU2V0IFsgL1BERiAvVGV4dCBdCi9YT2JqZWN0IDw8Ci9GbTAgMjkgMCBSCj4+Cj4+Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggNTg2OQo+PgpzdHJlYW0KeJzNXemPGzeW/95/RX2UBlGZV5HFRSCgD/WsB3aSsRXsAs4icGzZ6aC7Zfcxk/z3+w6SRZZK3ZQyeyBwq1TF4/H93k2q8vXk5MXbL+9vm2+/ffHq/e3nZvbpbnH5Zv7i9fnLi0Y0y+XZxXlz8vVEwJfOd63qmt6o5m5z8h9/aW5PztYnohVd13w+efHXt6L5fH/yYr0WjZRt16w/nSjVt7prnNOtcc3648m72fm8b2bffzc3zWw9983szVyKZnY6XygZ7jQXc6ma2Wq+gJbNJT3/np9z49en67lrZi9hlP9a/+1ktT5ZvQYq//7UWuRBa1mvZVqDtra1+RpmzXz9W92sKs5KTZ9oqA8kD1gsmMGmlY0zvlWK+fvDfIE8egMfivgGjP7rnJlHt05fv54vOuSvBvbS87Mf5woY+hYaQLuXBA49DnfCRzNXMHKY4N8BkWb2k5YSG1KXl/9Zj4c5csHaidZnCz4AjK4WDFvb0NU27Gsb+tqG8jDlZAayQAMHnesa62wbZGaF6vQd47qeLzTJCsmAQ9RtM3uFINPXt9yM7obr7+cgTj+i6oYb4ePlfGFR+HQanMRlNMi/HaDER2hxWLT0cNEPiz5AbmS1FstD1XigbwF3LZiXD01vW3hsO9P6jiiVbT2ppprU7mj5kcK2OiPwHVhvwP4G//xC0nOF1uABDT1dbcFUdAHt8+0d3v9yAOj2aKbCTQ+SDkyVIPQ6J3r2zQEC4A6i4Fz9nDHLmbYvuPWtENIugU1wIczS4Kfs4PpyCQ4Pb+qlxc9eL9HswpV33Cw+EdDfjZqoJXXuz8Ijb5dd2aRfLX0xvl3yIC62CE+0i59q53Mh6cqIZT2A/dEAKi9bWcraNxwWoCzdocRt2Dd9QamiGz/pTvK9+w2bmVuKGh7QSg0PN9Gn2dD5Pd+gMZoDxNMfrUjaeows8tWRiSVNIs25/gPJAycNIsgW9jMp2K8bvH6A+11QtG2DZhYXZfFONfnqUD8ygGPQCecqdUBcdKghH5hmOtmabtf8fOQI8S7xboOsvD2AE+pomoLJNgopI5IuEQ2i5T1HXbcsmsaRT9xe3R9A2PFeRUL8LUrKMv0JEv8HcitcZ6pCTe63SDff5RtXFDyCHgnu8Zm+59rEfT6w7kFzl0a/Zt0apn7EqQ9QNnVM2BhMiTGtLTihKILV9FfS37N5ZM0HgonVbFDH20R/kLZNCpCoUXB0j3fEr2Ce3JNdgnjc492vpNuPNOk3xFZq12d0muyvoL/UhMQtDPUHDhUMwW1AwuKdei4fGhtMeVzjNVqHxG9YUbV1ON7jB03UopUh32QBvLlB7pgg2sFI4IMgpiSI18l9IB93RZoa3TfI3+vM9cRQWFPECxL0ZoV31ofI9WERRi7XcFMbZLiChFXna595o4XvnXDg2aWqZ/+f8dd9a3XB/8zeJJNQz5dDnetAioaLvs/ZsajmgD7MKRYBn5aGQpaBBZNxmjccjJ2J9KSjAMzlodmZTE/FEniHFzI0ueR/1MRMxnHyEuI1CgIxtuTuoi9DSQmUqRSC9uFmjE8lio6Jn0uOWc9DnJr1kJeaZ5IrWR8YalldHqkvpBxTSclSMI+qFDNk0bWWZWe1rheeQ31UZr1026li3vqQSlcZbZTVIumUwmUr7sBo88wQ43dS6IvLZTUB1WUTXWXtSlI56RzoA63SK026NPXJKlH35JC2Bz8BBtbrQ5Xh3YEQdJnsv1MtjFBAuIJnF74ewipzWxKgnEOTXyAju36pyMxcstGQXbdc+KZ40oUn58GwxaYak0xqa7ul1FlbXAqbMRyPH51fkDnEcetrj1XmvVymhkDGdvsFcL9A/G+JZP3yq5IvMExqSLr6vnXZ4g+wS6badJsq013CEu2Wda1X0dtGmei74RqkSgeZIkHMZSlIoNSn5Btj26km0gopJDcDR9hngvvEiGLVU1ekhiRbnR0AV5U/GVlL67HaWbDlf8jA/Wk5/r/XnGcouLg8zIybOk9c6hdVMwa8DlGwar9rjvC7UcHA/MlUv4ymekKZUEG05JiSLqKV1jLvAfaaNQI1w54uCQFQC7T1Ql+ec3AcNeuSlTi6s316i+PI/EnWmIY2fMcXBiF2SsQmzxRcVRx/GI2qrKTYxlPcTdSqPoT2mprWy8sRbl91upUlKn9e+p/XxD5DoX59R0QVGNZIRYUEbWVrsqUmc1od1nTH+HuwoOWs+lLWz1jnYssZnca5Sk1L4c04fkIvpKdlXaxW3DhJcpT15OCCqO/IPGqem9I8GFxjomfEqRDdWRL2bFZ5zk9QJaIqWBV3IzR0PVtKpViC6qWnqyrLFta0kxCt6IyTh2wS61pr2lXvtXXH19Oi+RUGo08qqHCNaSilhirU/QNvFQx1li0XwPHyH1wQz0q8ofI6tM6LWV/pKRfIuP71iH/5xlAcPmDntju+pCd724o+Y8EhaFbv0HfVW/TdERs+skDTWJ3QPOUjLXTw5eU5Y/AKy9Dh+IvkknQ1o+0R5wLksFnQ5dQdUDGzR2zoxGm1Gk1bj689Ys8mTdvh1kiOxfdnfyOmM+vzs0g/Nij08egSldanDi/Vo3TElk48UmVk2z/Jrh9wTp4mmag4VJJAMo3SSVQtiZN++svz52LqT9BUx6S2WkNttYba6lM0TlS3rK5VuuqE11X7Glfta1w1Rq7+mFM1Rq4aIzfCaBDavhqTvhqTvhqTvhqTvhqTvhqTvhqTvv7sWTUmfbXe+GqMfDVGvhojX42Rr8bIV2PkqzHy1Rj5+gOCe/VGimpQIHmob1p/+k1U4yJF/UE1UY2MFNXQ4LZHddNqcKSoP78p69GS9WgdcFZR1qN1wLFCWY+WrEdL1qMl69GS9WiperRUPVqqHi1Vj5aqR0vVo6Xq0VL1aKl6tFQ9Wroerfo9aFm/CS11PVq6Hi1dj1b9ZqzU9WjperR0PVqmHi1Tj1b9vpM09WiZerRMPVr1JXxp6tEy9WiZEq29SemL04uz1c+XV9fXb68+3zZnnHFi81HR5sXljWgutvCQBuQKnR6XtYzu8YwOJrGvMInFLFU36382XetAhQQ92VB+K/C2bJAuCUF66/3Q/QZy9y9z1zo84IVn71rhh7O+ojXO8mHgvlW9jYdC6fADzaaBGvBbPN3DMB1QYRXffodlMg+Jt6O6Gj3A03U858Nct73M534/mkL1rYeEoZgCFtuPppm9H2bnNRnleUYLmfLsMQ1raVTTOkCZu97lXRONv/w2l8wAPgAIXQ11RRb73TXbVkAUxbc/jjExZj8m+EskD6KSg/Jx3rcCCByg0MimT/NFx0hczReW7yVeXo2W2NGoE0u8hiVS103sIRwtTZrW+NjlPu9CGPpOTWGYaCWa6BnC6iH85FvExKwfc1N7whCPQkszNWcal4688ni3I4oVzGP9VO9skYMkf32cs8zkd6+jjOBF5yb4YmBZRu/OAj0CztTMt52cwJl/Wcby+GYFBKDZpGOPrQZdna1P16f0I7CEHwRCKFCiVSLO+maVD3hDNWceMvF60CVmcFAS7Unld7QEz1QL+rowIIEKZHohFZFEavsRuEFaO4ja/RdUU5K/BCcea8bDV5kyDx22kRTniI9AaVzQbUYJqQupPC1copGKyvmYr/sc5Z+IeoU2yUrPJ0cZthXMT9N+l/DTNKAGGUxWcT2FH3EKOKrcpD0hvZM+WzYZLJqMzsdqBnVS7pNWdkGWTGd3mfBupNIJ25Kj8c4jfFKTJOdkKYJqQTaFU4HPULIQSPAlZjgAy/Oe4W7H4300mTCXDNPfpkVuEtxpOZqsjEFrOKV/IPMqjPgrnwwWrGXDoFdzxcD9ToMWfg5AUV1cRMLumx2bVPqVmy/zwHbCJ1jvpOnJZO1YFFwPu5SuNVZPW/d4+zFIjbXRCU0I9bt8ksF8ThhSIpqush744wCW70R0tpCbuUo2rHQCD7zjgRukw7beQoPUYT0iV/BwcBZ/7URd+WhtGJB/OsVSjbv2uIlK8PHvo1jKR42gdzQ8OmidMsE204lcOjsb+QOy0bv0kChxS+YrKyMYGtMNDUzRGxim00P81VUwICrGBSZ7akYTJ+NCB4wvlws+V4fngwkHPqYQ1iIVUQPk2j4nV67K9UCY4odRC07SQWNGjs8xs16k082JmQX7bUkBxEFKDQzrz4rZISqIvp7PMwd+WBme6uGpFyPCcYaMH8QJG2UCD1STwDLaC9mTzvGv4lxcFMyYXCZphQYRcSW+JXwmwyBnScksmJ2DgB1m9X4JGoLCPIaOHljp43ETm1iqg8Ci0SmIRuYhnyAQ8PJplJPcvdslqZhMJI7ILnk1VXBkBCKocIZwoDYPJGknawB5nz69i7BFjozBAf7Wg9ObIBBRfsXSJ4MxHlkpmLSvHRlpDEYlwI4pAD7plyHQnWCrp2hjUNJsdgx5bf3sY9HaQS6wK+v5/LArGKoL5MrVJTBuSkhpgWFN/CUsnY1AXDpjvOMdF4BJ62VfRmxTvoUixRAqDEkWtSRvfDWH1VFEx86HAjmMKca+s22ikzZpR1U0C4gu0eZehA15eABhzmwNoTtd0MY8jtBjyBYMmg9haQy1OLRFfnekhjMV0zzPmoO760FcZ4vcxV5QPEo/8YTJVausDD+VB4mx3mJMODAvUt1iNQTniSGRLkOiBdgBBxPiT9JwyvNRNucjLZtnwpEizSW3vj/PxRg1jrsvk55I1YvoJoVm5AUViEgfc6OPOalZpyGjHK42A2kyJMte25K2PAWPyUVKKMrgmuNeBMrGQbLgGlIuES3qkHOwMHLAWwQVkKJ2Qu3yPyXTuDCwolqDaUHybw7OxvF4QJ8P8C5PciYCsyxsS0Cn+PyupB9GVVo+Mb3tWw3A5PRvY3rE5BsfyX8ssXgGAKzhTGQ3/yIARlwGm6Mm6lBZaSbj2pDe7IlxR/LNGgMxrYqRyx6VGYgyEXo7QfooDQRJ7Z4uK431D8XhBg95sUCE3/iKmIoUDMQk2EwwMGX1NEQSLjxAlhtoYliqVAx5ZkwMy9rdN2y1FxrEqlPBXwjDYKfUMRv5Kwou+ZBRhYSmux4JM3DK+f3CLAXMCrZWg2NWYDVRmDdRmJWOoWmq/jzk3NhXjkxGEClNWfcoA44EYu3jCWWH+BiwtjmB7/DI3yTDS9s+rrYBbnGioti2Pwsk/7spF1Zk/VN2ZX9hoVNtKvPcTkptVt9axDrOULO73cG2S6XdKUPlUI77aWzFDrb7XNpUdj6x2Cc1SllYeT+lUR/nWsZ636jU2WfG4/4ZJU8CiHrO5XDi404ZO5slmSjRT80ySMA2opKqPmiESUx2yz55aa2op2bFSiyoTpZkBtdValRaRllsvkvFvsEZjErHmNzEKlAqft9nVZrZDYypoh/SIUXwMUUAk5e1vb/igKysXRhwyAbkKDNdHGbn7qZMO55JjYpiRhaUF5kNFjlCPkARecxM9LL0QrQ/keWMdpSXD7LOM+AyOLrn5EDpvszRQvUXg/ZRjjYam/xUloxSFh1TIz3OYWQrRG0Ow7npMoQ8O8k2smnI1oMcKIrqASsnUo4qV2XpBbcXhgRWXC7z+GQoJBL9IwSHGCUmTDvoFTBdhqROxWpFBmiZUMplYch1T7r3RLFEPyVKobRQ1MX6pYkJ3bhGBsbTOF8puDRoYHxIUovSgHS1A+2ttxQlqJBfFwmS5DgiWO8tvkeHbcTH+ZgeMxUapIiMd38oTHyuRD2TMT/ULnRyLloQVURQkHeydQyviZmuKYNT6OMiYk15TxA9ttSjMnNyVZsyHDCIa1zX3cTyA5fAFuiJiDQ6WXxlj7UeCAaj6TU52TJYRcM3kVVhNMrNOBeUngxNMNA5HtkukABl8aMY8f/jLtAXfCEJ+8zJMn8WiY9hgRaxMlyGaTfbORdqhm3HFF+mDcKJckjpqzwmb7rgIBs6/gkSGfzBQuelw24JfWI1KrcqZ+NqlIKlCVNbjSoLzJmTMdEryMzYnY6shrLmKWMXr8d+My7KFablqboh7RXUVO6K6vZOmPmsA97Pj2i14O5T/Mi90POFURi4q6qL+qnlqbg6XXScCgN2wptYsd8T3hTFT3KHcRH73WQ09aMQYOyJTN8aO+Dx5LZPHzduQqUPtzEyLrkd32v3bLGMRA1YoFIsQN4urpvbxV7dOJgDxildK0s5DzOBjuWuZ0rs+W5RXhk2FNx2aYsoR6fc22BZHhTPDO0j5CX8pc4ZPKRUbUjyGjXPEUOdXKxK9cqfkFQOu2tYn00GLoNkjOoOyUbqSjNhx7KV6n7Pyha+JrKLTI/mm9/fE5ct+iXknQEkKcOvNaVLW0ZEuZF4XsuPPUKuZYXk0p5avr+2jxPg0LuqeP7bvTtJQmY255m9pCToo+05kApTbn9NGZvckOzuFMpWTmtKzBhHq7nYSQ1ypVylIHzK3U5kdPssXuHuYNgybu/r+addB3QwqJAR7cbUMKqh7GmWBcAy35CQCt+kDWIEAYzLfv/4r9lu0bXbLWmebO6XMGOP79GLs9k4nYoTvk3j83yrOL8n0tCtqBiUrZsUBVKEMnv9/UWiQHdDkgMMeIWxqWMSHB3KIwq1j5tAJUlgl6LR3SHpIn4lgkCv4zZw4NbQ8ochSIeYRdlEzcsVnejCyV+vMGcgFL6bm4jR1EZUWGSe+KQf8RPVC4WWo8fNKNPydhREpW0kysZilk3Zxg93V78nhGUfipNGprOJmwF/mmJ2nScOn7Z3N+8frra32d5YJIllH18IHPk4sYOGvw0lmSVBDITTDuXsVZpa8gbch+1PEC8/pLsclc4etg/vr+MSWTVwS06VK0ALIosFAD9CEcKmClNazzAJ0Tfb3A9bWQztp6vfsQIW7mpex5AgYaxfrJPfHsj+w+eBo3YOX/kb/y1D5yKt/dDQy4DRbgh0guA6lmNeDocHZgkz77hWtr16CFSJ7B16RAz7IXBK8d/kwD4XvSKNQXgkDxQozIJNMEB+CNRpHkcOMwzTDZPge7WE4cqdjR08RiXsf9nUc8iDYSLWWvCz7/loRB+OSKB19eehreb7GJrhGPisX4V/LhR+HI/F4Rv6r2ihw30Z+pvsfpy3L+/TXFKklwbS2CajTQ9zi3itw5iKvxdrxft9+Aw00hg+jB3a9imQGNYcaaH5beBVnNfFWlV4rpk+H/uIgRd57BOwuYhnrPBECtHyFD/Phu9Eg8/mXO3yPOcJ8Teu4TLwwYYxmU70kSywXbA9eM4AnAQq5AXavyiyNjynQ16jPijifBps1uY+7PT29vGaDcL2scFCAe6no97fX11f8YMv7++aVFWXwUkZSO2jl7rOKyjnr16uvltHmtwg/7EPWkA3vMLcZRqQuETnXUIp2GasD2LSZw1NCkosxjiZLImgE6tJvmJnaVLYI5MgoAykvDCfJx0LDPoZZX41yP7UHF2KCIMSRMGKL+pMuU0SDMoHOK3BDmdRQsLIOVkpWHuSVJuJZDeo2TS5zHgl4prM0JD0biUylJh27Sx0OA/r4cq4XKWjOjYzpk5kp01Wa/zRR+u905biVizzgaPU1sF/oI6t7kzXa9d8uIk/9lBa45vwlaXXFMZ3Dvw9DKQheJJpIKdchzHI5ED4QiDclZXoo+M4L9bbxw+//vjl5/Xm94fVR3Arr3+AwcNbdlzpWvD/IQIw4cYuFsJZpBXkQpBvSxkFE7wOC2ZmOCIa54Hz5dGmwWs4iPF8iqreP354BM8N4R2V5O42N79sH+/uNzeb24f5Dq8XaR8Cgw+ZjikUW4IbfA8x1/Putzc3/JVKnB/RCvzG/j4ku7N/bO7u8fbmvo0vqQDmnPw35oPhqwplbmRzdHJlYW0KZW5kb2JqCgo0MCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDUzCj4+CnN0cmVhbQp4nCvkMlQwAEIImZxLGlffNTcpNSUlNSUgJS0gMT1V19LcxMjMwsjUzELBJZ8rkAsAj/IUugplbmRzdHJlYW0KZW5kb2JqCgo0MSAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDEwCj4+CnN0cmVhbQp4nCvkAgAA7gB8CmVuZHN0cmVhbQplbmRvYmoKCjQyIDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMTAKPj4Kc3RyZWFtCnicC+QCAACuAFwKZW5kc3RyZWFtCmVuZG9iagoKNDMgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiAxOAovRmlyc3QgMTI4Ci9MZW5ndGggMTQ0Mgo+PgpzdHJlYW0KeJzdWG1v00gQ/p5fMZ9OIFR5370+IaQ0L4DuClWLAFHxwY1N6lMSI8c5lX9/z6xfkjTNFXo63QthWO94ZnZ2dmb2MZIEKbKKNHlHlqwRlJB1gqQgJyXhbxwrkhoMGZN0JK3B6DEmkEpIxU6SghlvPClLWiRgetIKFrUkjT+YkDY+wT+kY4UxIaMSSc+fD6J3377mFJ2n83w9iH4psjVdsR1BFyzGw+dBNCo3q5rU4MWLwVZnlNbpopwPGmWSLNxJnFdltpnlFT2fTqZTIWIhhDMgJ4QaYxyBEpDCHO+UxzMoNi2BF2sh9BDvpg25uNHh90HWtvoTjJB1LDNuZI1v5v26vNaksaEe8id5MYjOymyc1jk9Gf+shHJSCK9wBlJ/eopwVHlal//dzQX/i3J1dIc4xSuKXo9Gp+k6z8i1ecAne7m5rsPx57ezxSbLs2mRL7J1lxTTYrG4LOZsOu2SgY1MSyRQdDoaTyaTZ6N0eV0V6clpucgG0WQ1K7NiNafoQ7EartZFxxjAWrWuRzdphRTGDDbG+XpWFV85+rLJuOjXtJVRWu/4967a5OxT7xm0B1giq2/WXFE72Tpcz3K4l1iB59/nQYYQPEQq/foqL+Y3NerQDyJenSVPlGJ/Ful83Xt2elreonZOpETxsgAWiTXrcQWxBGKTg6sat5nzJl3mR6LCrz+0S7Mnr1FsxWy4mi9ywvQsvW3cVMbDgcs6X76Hy7ub3YZqEH1sd6GwxXC4Cj3j/p/ibqHjMAqyifouQo7vWXHoas5KshwCgdaGMFjMnXEUIzbaCrQjPkHmenBdnJBLLPqeYX0HuzglhybkYtfYlMmBt1bDNlqZcWicSYw5ep5CM1UizDWsacE70cKTR9N0wqDFttJBE2TRFJ3tLUAXPbB5+jf/OKqP1+aYibDLprRDNj4ZZuV1TlzH9BNxKT/tkurt6OVhSb9/Ofw0evVsiMxd7NRyOKqL3QoWBwUcUnCvgK393gK+InTIf5QUYs+kLTLFukAel6xzuKCTcPM2BJ71ppHFvNPrdB6iXh42egIfvdqGxZi4pJjCPKAGH+ZBUYjADw7CgSALftBr5Xq99jkxprfN/M4JplBqsMWb6R0VYs/h/pl9APF7Hv2uTkvBjhBbPTzHrU5HGtBFuWbkAPAB7O69j0G7n6MB3fHzboB/9GCYzB173NasbmOJkQk3q+izgR0PjOApS5ukT6lgBc3uvnTTsQgtip9DmmEFphC9NiKsv2crpIkQ++HCwoHJZ9xLdP71B9a61SWPbBOok+sPp+WxDo/BWJ85O3Q3ynFHVvSn1lFXKk2GqW0p3UOfd1vSFkqcpbOLcpmutlhiXHz5klf5apZz90AkoyEptKlosqlKvqKbLtMr7GMD7MvtwQHpduCAVvYYHHBYid8TI8FgpocD6bJYfEPD5db5dBciqBbZbCHCfpdl/mVd5fXshqI3ZbXsmC1gMPcAhgYheP8QQrAy2Yf5jO4Z41chDI1jF/m63FQcSZYLFwEeoBZ9fHv9Wz4L02iyvM4zIMTz7AsbOYlFgq8UESN7laEWf0WT2/rlZc1ItDHBvLM8K9ImgAGScORkwFHD1aqs+QDDV8mqhlPhi6WDqF0ynG0DMxqS7E+3W2wQzVKw70Oo0y0Wezw41ergbpPfe7fpPjjHwam0jwOnJrYNOMX3oT8Ep1rfzby7AXkgzXpcarTZ4lL5F3Cp9qp9UsCRGoHl0STce8xRajWc2bPlFO/POt3gy9j2zdp5YEXVSDMPsh5ciwbkfNAESkzQUhPommOoy3hcH/hAN0C2FriA51poaJrQyELzc5yrKgbq1XxR+YDAQrtmTeBVo7kf+6BhhQl2dfv0//lxbA45HR3K30XjHJ3Pf0ufSmKjnFd88NrTD/Qpx///8iddyrBQ26X+ALZRFdEKZW5kc3RyZWFtCmVuZG9iagoKNDQgMCBvYmoKPDwKL1NpemUgNDUKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCAxNzAKL1cgWyAxIDMgMiBdCi9JbmRleCBbIDAgNDUgXQo+PgpzdHJlYW0KeJwtyj8OAXEQxfH39rfYXf9WHEAoNCJRKjiDAygkSj0XUBHiAgpBzQFEq9CKaDgBnQOwM5nmk8l3HgD8fh7QAFSqHoHYiiPKIUBUTmK1ad1XU2qaqA2tZ4jLV5a3tZWAuNPuUI3ULPFoJ0vWu+I4ECc9W+bI2UfKfGQlT243UnZHKwW1SO6vVmJ6i2ey8ZZn8dAR3337lujcICnOvUS/pU7FaAX8AZHyHGgKZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVmCjE5OTMxMQolJUVPRg==', cachet: 0, paraphe: 1 };

}};

/* ── ./api/signature-otp.js ── */
__defs["./api/signature-otp.js"] = { map: {"./_twilioClient":"./api/_twilioClient.js","./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js"}, shims: {"crypto": function () { return __crypto; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/signature-otp.js — CODE SMS DE SIGNATURE (envoi + vérification)
// ----------------------------------------------------------------------------
// POST /api/signature-otp
//   { action: 'send',   token }        → 200 { ok:true, phoneHint, sid }
//   { action: 'verify', token, code }  → 200 { ok:true } | 400 { error }
//   { action: 'status', token }        → 200 { ok:true, etat, explication }
//
// 08/10/2026 — refonte signature : le TOKEN du lien remplace reqId +
// signerIndex. La demande ET le signataire se déduisent du token, côté
// serveur : un appelant ne peut plus viser le téléphone d'un autre
// signataire en changeant un index. La validation est enregistrée par
// signataire (otpBySigner.{i}) — c'est elle que api/sign-session.js exige
// avant d'afficher le contrat — et chaque étape entre dans le journal de
// preuve chaîné (envoi, échec, validation).
//
// « status » repond ce que Twilio a fini par faire du SMS : en_cours, livre
// ou echec. Sans lui, un message filtre par l'operateur laissait le
// signataire attendre indefiniment devant un « ✅ Code envoye ».
//
// POURQUOI CET ENDPOINT
// ---------------------
// Le parcours passait par un document webhook_inbox { action:'signature_otp_send' }
// traité par la Cloud Function onWebhookInbox. Cette fonction a ete redeployee
// depuis le repo, dont la copie ne contenait plus les handlers signature : le
// code SMS ne partait plus du tout. On remet la mecanique ici, sur Vercel, qui
// deploie depuis git — donc plus de divergence possible entre le code lu et le
// code execute.
//
// SÉCURITÉ
// --------
// - Endpoint PUBLIC : le signataire n'a pas de compte. C'etait deja le cas avant
//   (le navigateur ecrivait directement dans webhook_inbox). Pas de regression.
// - Le numero de destination vient TOUJOURS du document Firestore, JAMAIS du
//   body : sinon n'importe qui pourrait faire envoyer un SMS a n'importe quel
//   numero depuis notre compte Twilio.
// - Le code ne transite ni ne se stocke dans signature_requests (lisible par
//   l'équipe) — il vit dans signature_otp/{reqId}, une collection
//   sans bloc `match` : refus par defaut pour les clients, l'Admin SDK passant
//   outre les rules. Aucune modification de rules necessaire.
// - Plafonds : 5 envois et 8 tentatives par demande, code valable 10 minutes.
//   Au-dela, on refuse — 6 chiffres se brute-forcent en 10^6 essais sinon.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const parseBody = require('./_parseBody');
const core = require('./_sign-core');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 8;

/* Meme normalisation que api/twilio-sms-send.js (E.164, France par defaut). */
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

/* « •• •• •• 09 » — de quoi verifier qu'on vise le bon telephone sans
   reafficher le numero complet dans une page publique. */
function phoneHint(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length >= 2 ? '•• •• •• ' + d.slice(-2) : '';
}

function compareCode(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '');
  if (action !== 'send' && action !== 'verify' && action !== 'status') {
    res.status(400).json({ error: 'action doit valoir send, verify ou status' });
    return;
  }

  try {
    const found = await core.findByToken(body.token);
    if (!found) { res.status(404).json({ error: 'Lien invalide ou expiré.' }); return; }
    const reqId = found.id;
    const reqRef = found.ref;
    const R = found.R;
    const signerIndex = found.signerIndex;
    const info = core.clientInfo(req);
    if (R.status === 'cancelled') { res.status(409).json({ error: 'Cette demande a été annulée.' }); return; }
    if (R.status === 'signed' || (found.signer && found.signer.status === 'signed')) {
      res.status(409).json({ error: 'Ce contrat est déjà signé.' }); return;
    }

    const otpRef = db.collection('signature_otp').doc(reqId);

    // ─── ENVOI ─────────────────────────────────────────────────────────────
    if (action === 'send') {
      const to = normalizePhone(found.signer.phone || R.clientPhone);
      if (!to) {
        res.status(400).json({ error: "Aucun numéro de téléphone valide sur cette demande." });
        return;
      }

      const prevSnap = await otpRef.get();
      const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
      const sends = (prev.sends || 0) + 1;
      if (sends > MAX_SENDS) {
        res.status(429).json({ error: "Trop de demandes de code. Contactez votre conseiller." });
        return;
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const creds = await getTwilioCreds();
      const smsFrom = creds.smsFromNumber || creds.smsFrom || null;
      if (!smsFrom) {
        console.error('[signature-otp] smsFromNumber absent de _config/telco_credentials.twilio');
        res.status(500).json({ error: "Envoi SMS non configuré." });
        return;
      }

      /* On ecrit le code AVANT d'envoyer : si Twilio repond apres un timeout
         Vercel, le client aura quand meme recu son SMS et le code sera valide.
         `livraison` est remis a zero : le statut d'un envoi precedent ne doit
         pas faire croire a un echec sur le nouveau. */
      await otpRef.set({
        code,
        signerIndex,
        phone: to,
        sends,
        attempts: 0,
        expiresAt: Date.now() + OTP_TTL_MS,
        livraison: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const client = await getTwilioClient();
      let msg = null;
      try {
        /* statusCallback : SANS LUI, ON NE SAIT RIEN. `messages.create()` qui
           rend la main veut seulement dire que Twilio a ACCEPTÉ le message —
           pas qu'il arrivera. C'est exactement ce qui rendait invisible le
           probleme des codes qui n'arrivent pas : 200 cote API, « code
           envoye » a l'ecran, et un SMS filtre par l'operateur.
           reqId voyage dans l'URL pour que le rappel sache quelle demande
           mettre a jour. */
        msg = await client.messages.create({
          from: smsFrom,
          to,
          body: 'Votre code de signature : ' + code + '\nValable 10 minutes. Ne le communiquez à personne.',
          statusCallback: 'https://' + (req.headers['x-forwarded-host'] || req.headers.host)
            + '/api/twilio-sms-status?reqId=' + encodeURIComponent(reqId),
        });
      } catch (twilioErr) {
        console.error('[signature-otp] Twilio error:', twilioErr && twilioErr.message, twilioErr && twilioErr.code);
        res.status(502).json({
          error: "L'envoi du SMS a échoué. Réessayez dans un instant.",
          twilioCode: (twilioErr && twilioErr.code) || null,
        });
        return;
      }

      /* Trace de l'envoi : le SID permet de retrouver le message dans Twilio
         et de recouper avec le rappel de statut. */
      console.log('[signature-otp] envoyé sid=' + (msg && msg.sid) + ' statut=' + (msg && msg.status)
        + ' from=' + smsFrom + ' vers=' + phoneHint(to));
      await otpRef.set({ sid: (msg && msg.sid) || null }, { merge: true }).catch(function () { /* trace seule */ });
      await core.appendAudit(reqRef, [{ type: 'otp_envoye', signer: signerIndex, data: { tel: phoneHint(to), envoi: sends } }], info)
        .catch(function (e) { console.error('[signature-otp] journal:', e && e.message); });
      await core.setProgress(reqRef, signerIndex, { derniere: 'Code SMS demandé', enLigne: true }, info);

      res.status(200).json({ ok: true, phoneHint: phoneHint(to), sid: (msg && msg.sid) || null });
      return;
    }

    // ─── OÙ EN EST LE SMS ? ────────────────────────────────────────────────
    /* La page interroge ce point apres l'envoi. Tant que Twilio n'a pas
       tranche, on repond « en cours » ; des qu'il signale un echec, la page
       cesse de faire patienter quelqu'un pour rien. Aucun secret ne sort
       d'ici : ni le code, ni le numero complet. */
    if (action === 'status') {
      const snap = await otpRef.get();
      const L = (snap.exists && snap.data() && snap.data().livraison) || null;
      res.status(200).json({
        ok: true,
        etat: L ? (L.echec ? 'echec' : (L.statut === 'delivered' ? 'livre' : 'en_cours')) : 'en_cours',
        explication: (L && L.explication) || '',
      });
      return;
    }

    // ─── VÉRIFICATION ──────────────────────────────────────────────────────
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) { res.status(400).json({ error: 'Entrez les 6 chiffres du code.' }); return; }

    const otpSnap = await otpRef.get();
    if (!otpSnap.exists) {
      res.status(400).json({ error: "Aucun code en cours. Demandez un nouveau code." });
      return;
    }
    const O = otpSnap.data() || {};
    if (Number.isInteger(O.signerIndex) && O.signerIndex !== signerIndex) {
      res.status(400).json({ error: "Ce code a été demandé pour un autre signataire. Demandez un nouveau code." });
      return;
    }

    const attempts = (O.attempts || 0) + 1;
    await otpRef.set({ attempts }, { merge: true });
    if (attempts > MAX_ATTEMPTS) {
      res.status(429).json({ error: "Trop de tentatives. Demandez un nouveau code." });
      return;
    }
    if (!O.expiresAt || Date.now() > O.expiresAt) {
      res.status(400).json({ error: "Ce code a expiré. Demandez-en un nouveau." });
      return;
    }
    if (!compareCode(O.code, code)) {
      await core.appendAudit(reqRef, [{ type: 'otp_echec', signer: signerIndex, data: { tentative: attempts } }], info).catch(function () {});
      res.status(400).json({ error: "Code incorrect." });
      return;
    }

    /* otpVerified alimente le certificat de signature (sign-certificate.html) :
       on le pose sur la demande, comme le faisait l'ancien traitement. */
    const by = {};
    by[String(signerIndex)] = { atMs: Date.now(), at: new Date().toISOString(), phone: O.phone || null, ip: info.ip };
    await reqRef.set({
      otpVerified: true,
      otpVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      otpVerifiedPhone: O.phone || null,
      otpBySigner: by,
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'otp_verified',
        date: new Date().toISOString(),
        by: 'signer' + (signerIndex + 1),
      }),
    }, { merge: true });
    await core.appendAudit(reqRef, [{ type: 'otp_verifie', signer: signerIndex, data: { tel: phoneHint(O.phone) } }], info);
    await core.setProgress(reqRef, signerIndex, { etape: 2, derniere: 'Téléphone vérifié par code SMS', enLigne: true }, info);

    /* Code consomme : il ne doit plus pouvoir servir. */
    await otpRef.delete().catch((e) => console.error('[signature-otp] purge:', e && e.message));

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[signature-otp]', e && e.stack ? e.stack : e);
    res.status(500).json({ error: "Erreur serveur. Réessayez." });
  }
};

}};

/* ── ./api/_twilioClient.js ── */
__defs["./api/_twilioClient.js"] = { map: {}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "twilio": function () { return __shim['twilio']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_twilioClient.js
// ----------------------------------------------------------------------------
// Helper partagé : charge les credentials Twilio depuis _config/telco_credentials
// et instancie un client Twilio réutilisable.
//
// Les credentials sont cachés au niveau module (une seule lecture Firestore
// par cold start Vercel Function).
// ============================================================================

const { db } = require('./_firebaseAdmin');
const twilio = require('twilio');

// Caches niveau module (vidés au cold start)
let _cachedCreds = null;
let _cachedClient = null;

/**
 * Charge les credentials Twilio depuis Firestore.
 * Accepte "twilio" (lowercase) ou "Twilio" (défensif) comme nom de champ.
 */
async function getTwilioCreds() {
  if (_cachedCreds) return _cachedCreds;

  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) {
    throw new Error('_config/telco_credentials document not found');
  }

  const data = snap.data();
  const creds = data.twilio || data.Twilio;
  if (!creds || !creds.accountSid) {
    throw new Error('telco_credentials missing twilio block (accountSid required)');
  }

  _cachedCreds = creds;
  return creds;
}

/**
 * Retourne un client Twilio initialisé (avec cache).
 */
async function getTwilioClient() {
  if (_cachedClient) return _cachedClient;
  const creds = await getTwilioCreds();
  _cachedClient = twilio(creds.accountSid, creds.authToken);
  return _cachedClient;
}

module.exports = {
  getTwilioCreds,
  getTwilioClient,
};

}};

/* ── ./api/signature-send-link.js ── */
__defs["./api/signature-send-link.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_twilioClient":"./api/_twilioClient.js","./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_billing-gmail": function () { return __shim['./_billing-gmail']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/signature-send-link.js — ENVOI DU LIEN DE SIGNATURE (email + SMS)
// ----------------------------------------------------------------------------
// POST /api/signature-send-link
//   { requestId, signerIndex?, token? }
//   → 200 { ok:true, email:{envoye,dest}, sms:{envoye,dest,sid,erreur} }
//
// POURQUOI CET ENDPOINT
// ---------------------
// TROIS chemins déposaient un document webhook_inbox { action:'signature_resend' }
// en comptant sur la Cloud Function onWebhookInbox :
//   · sales-signatures.html — l'envoi initial du contrat au client ;
//   · sales-signatures.html — le bouton « Renvoyer » ;
//   · sign.html            — la notification du 2e signataire.
// Cette fonction a été redéployée sans ses handlers signature. Les documents
// sont toujours écrits, plus personne ne les lit : le client ne recevait donc
// JAMAIS son lien de signature, et l'écran affichait « ✅ Email + SMS
// renvoyés ». C'est la même panne que le code SMS et que la copie du contrat
// signé — même cause, même remède : le traitement revient sur Vercel, qui
// déploie depuis git.
//
// DEUX PORTES D'ENTRÉE, TOUTES DEUX VÉRIFIÉES
//   · l'équipe (sales-signatures) présente un jeton Firebase ;
//   · la page de signature publique présente le token de la demande — le
//     signataire 1 n'a pas de compte, mais il vient de signer et son token
//     prouve qu'il est bien sur ce dossier.
// Aucune des deux ne permet de choisir le destinataire : numéros et adresses
// viennent TOUJOURS du document Firestore.
//
// EMAIL ET SMS SONT INDÉPENDANTS
// Un SMS qui échoue ne doit pas empêcher l'email de partir — c'est justement
// le canal qui fonctionne pendant que la remise SMS est en panne côté
// opérateur. La réponse dit ce qui est parti et ce qui ne l'est pas, et
// l'appelant l'affiche : plus de « ✅ envoyé » qui ment.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');
const { appendAudit, clientInfo } = require('./_sign-core');

const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

/* Même normalisation que api/signature-otp.js (E.164, France par défaut). */
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

function tokenMatches(R, token) {
  if (!token) return false;
  if (R.token && R.token === token) return true;
  if (Array.isArray(R.signers)) return R.signers.some((s) => s && s.token && s.token === token);
  return false;
}

/* Le signataire visé, et son token — c'est LUI qui ouvre le bon document. */
function signataire(R, index) {
  const s = Array.isArray(R.signers) ? R.signers : [];
  const i = Number.isInteger(index) ? index : (R.currentSigner || 0);
  if (s[i]) return { i, ...s[i] };
  if (s.length) return { i: 0, ...s[0] };
  /* Ancien modèle : pas de tableau signers, tout est à la racine. */
  return { i: 0, name: R.clientName, email: R.clientEmail, phone: R.clientPhone, token: R.token };
}

function origineDe(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const body = parseBody(req) || {};
  const requestId = String(body.requestId || '').trim();
  const token = String(body.token || '').trim();
  const signerIndex = Number.isInteger(body.signerIndex) ? body.signerIndex : null;
  if (!requestId) { res.status(400).json({ ok: false, error: 'requestId_required' }); return; }

  try {
    const reqRef = db.collection('signature_requests').doc(requestId);
    const snap = await reqRef.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'request_not_found' }); return; }
    const R = snap.data() || {};
    if (R.status === 'cancelled') { res.status(409).json({ ok: false, error: 'request_cancelled' }); return; }

    /* Porte 1 : l'équipe, avec un jeton Firebase. Porte 2 : le token de la
       demande. L'une des deux suffit, aucune n'est facultative. */
    let par = null;
    try {
      const auth = await verifyFirebaseAuth(req);
      par = auth && auth.email ? auth.email : 'equipe';
    } catch (e) { /* pas de jeton : on tente le token de la demande */ }
    if (!par) {
      if (!tokenMatches(R, token)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      par = 'page_signature';
    }

    const S = signataire(R, signerIndex);
    if (!S.token) {
      console.error('[signature-send-link] signataire sans token', requestId, S.i);
      res.status(409).json({ ok: false, error: 'signer_token_missing' });
      return;
    }

    const lien = origineDe(req) + '/sign.html?t=' + encodeURIComponent(S.token);
    const nomDoc = R.templateName || 'votre contrat';
    const prenom = String(S.name || R.clientName || '').split(' ')[0] || '';
    const perso = String(R.message || '').trim();

    /* ── EMAIL ─────────────────────────────────────────────────────────── */
    const dest = String(S.email || '').trim();
    const email = { envoye: false, dest: dest || null, erreur: null };
    if (dest && dest.indexOf('@') > 0) {
      try {
        const account = ACCOUNTS[R.sendAccount] ? R.sendAccount : 'contact';
        await sendGmailWithAttachment({
          tokenAccount: account,
          fromName: 'Ambitio',
          to: [dest],
          subject: 'À signer — ' + nomDoc,
          bodyText: [
            'Bonjour ' + prenom + ',',
            '',
            perso ? perso + '\n' : '',
            'Votre document « ' + nomDoc + ' » est prêt à être signé.',
            'Ouvrez ce lien pour le lire et le signer :',
            lien,
            '',
            'Ce lien vous est personnel : ne le transmettez pas.',
            '',
            'Bien à vous,',
            'L\'équipe Ambitio',
          ].filter((l) => l !== '').join('\n'),
        });
        email.envoye = true;
      } catch (e) {
        email.erreur = (e && e.message) || 'echec';
        console.error('[signature-send-link] email', requestId, e && e.message);
      }
    } else {
      email.erreur = 'aucune adresse sur la demande';
    }

    /* ── SMS ───────────────────────────────────────────────────────────── */
    const to = normalizePhone(S.phone);
    const sms = { envoye: false, dest: to || null, sid: null, erreur: null };
    if (to) {
      try {
        const creds = await getTwilioCreds();
        const from = creds.smsFromNumber || creds.smsFrom || null;
        if (!from) throw new Error('smsFromNumber absent de _config/telco_credentials.twilio');
        const client = await getTwilioClient();
        /* statusCallback : la remise SMS est suivie ici comme pour le code de
           signature. Sans lui, un message filtré par l'opérateur resterait
           invisible — c'est exactement ce qui a masqué la panne du code. */
        const msg = await client.messages.create({
          from,
          to,
          body: 'Bonjour ' + prenom + ', votre document « ' + nomDoc + ' » est à signer ici : ' + lien,
          statusCallback: origineDe(req) + '/api/twilio-sms-status?reqId=' + encodeURIComponent(requestId),
        });
        sms.envoye = true;
        sms.sid = msg && msg.sid;
      } catch (e) {
        sms.erreur = (e && e.message) || 'echec';
        console.error('[signature-send-link] sms', requestId, e && e.message, e && e.code);
      }
    } else {
      sms.erreur = 'aucun numéro valide sur la demande';
    }

    /* Trace : qui a envoyé quoi, et ce qui a échoué. */
    await reqRef.set({
      dernierEnvoi: {
        at: Date.now(), par, signerIndex: S.i,
        email: { envoye: email.envoye, dest: email.dest, erreur: email.erreur },
        sms: { envoye: sms.envoye, dest: sms.dest, sid: sms.sid, erreur: sms.erreur },
      },
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'lien_envoye',
        date: new Date().toISOString(),
        by: par,
        canaux: (email.envoye ? 'email ' : '') + (sms.envoye ? 'sms' : ''),
      }),
    }, { merge: true }).catch((e) => console.warn('[signature-send-link] trace:', e && e.message));
    /* Journal de preuve chaîné (api/_sign-core.js) : l'envoi du lien fait
       partie de la chronologie opposable du dossier. */
    await appendAudit(reqRef, [{
      type: 'lien_envoye', signer: S.i,
      data: { canaux: (email.envoye ? 'e-mail ' : '') + (sms.envoye ? 'SMS' : ''), par: par },
    }], clientInfo(req)).catch((e) => console.warn('[signature-send-link] journal:', e && e.message));

    console.log('[signature-send-link]', requestId, 'signataire=' + S.i,
      'email=' + email.envoye, 'sms=' + sms.envoye, 'sid=' + sms.sid);

    /* On répond 200 même si un canal a échoué : l'autre est peut-être passé,
       et l'appelant doit pouvoir le dire précisément. 502 seulement si RIEN
       n'est parti — là, il n'y a vraiment rien à annoncer au client. */
    if (!email.envoye && !sms.envoye) {
      res.status(502).json({ ok: false, error: 'aucun_canal', email, sms });
      return;
    }
    res.status(200).json({ ok: true, email, sms });
  } catch (e) {
    console.error('[signature-send-link]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

}};

/* ── ./api/_verifyFirebaseAuth.js ── */
__defs["./api/_verifyFirebaseAuth.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_verifyFirebaseAuth.js
// ----------------------------------------------------------------------------
// Helper partagé pour vérifier l'authentification Firebase sur toutes les
// Vercel Functions qui ont besoin d'un user connecté.
//
// Usage dans une Vercel Function :
//
//   const { requireAuth, requireAdmin } = require('./_verifyFirebaseAuth');
//
//   module.exports = async (req, res) => {
//     const auth = await requireAdmin(req, res);
//     if (!auth) return;  // La fonction helper a déjà répondu 401/403
//
//     // À partir d'ici on a auth.uid, auth.role, auth.email, auth.userData
//     // ... ta logique métier ...
//   };
//
// Protocole côté frontend :
//   1. Récupérer un ID token Firebase : const idToken = await firebase.auth().currentUser.getIdToken();
//   2. Le mettre dans le header : fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');

/**
 * Vérifie le Bearer token Firebase dans le header Authorization.
 * Retourne un objet { uid, email, role, userData } si valide.
 * Lance une erreur avec .statusCode 401 ou 403 sinon.
 */
async function verifyFirebaseAuth(req) {
  // 1. Extraire le token du header Authorization
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or invalid Authorization header (expected "Bearer <token>")');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    const err = new Error('Empty Bearer token');
    err.statusCode = 401;
    throw err;
  }

  // 2. Vérifier le token auprès de Firebase Auth
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (verifyErr) {
    console.warn('[verifyFirebaseAuth] Token verification failed:', verifyErr.message);
    const err = new Error('Invalid or expired Firebase token');
    err.statusCode = 401;
    throw err;
  }

  const uid = decoded.uid;

  // 3. Charger le doc user Firestore pour récupérer le rôle
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    const err = new Error('User document not found in Firestore');
    err.statusCode = 403;
    throw err;
  }

  const userData = userSnap.data();

  return {
    uid,
    email: decoded.email || userData.email || null,
    role: userData.role || null,
    userData,
  };
}

/**
 * Convenience helper : vérifie l'auth et répond 401/403 automatiquement
 * si ça échoue. Retourne l'objet auth si OK, null sinon.
 *
 * Le caller DOIT faire `if (!auth) return;` juste après pour arrêter
 * l'exécution si auth a échoué (parce que res a déjà été envoyée).
 */
async function requireAuth(req, res) {
  try {
    return await verifyFirebaseAuth(req);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Authentication failed' });
    return null;
  }
}

/**
 * Comme requireAuth, mais vérifie en plus que le user a role === "admin".
 */
async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401

  if (auth.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return null;
  }

  return auth;
}

/**
 * Comme requireAuth, mais pour le DÉCLENCHEMENT des prélèvements GoCardless
 * (endpoints gocardless-payment + gocardless-finalize). Autorise :
 *   - les admins — peuvent déclencher tous les paiements ;
 *   - tout utilisateur avec users/{uid}.paymentsTrigger === true, quel que
 *     soit son rôle (sales, csm…) — peut déclencher tous les paiements ;
 *   - les sales SANS flag — régime historique : uniquement leurs propres
 *     paiements. Le check createdBy reste à la charge de l'endpoint :
 *       if (!auth.canTriggerAll && pay.createdBy !== auth.uid) → 403
 * Pose auth.canTriggerAll = true quand le droit couvre tous les paiements.
 * Miroir du helper Firestore rules canTriggerPayments() et de la case
 * « 🚀 Déclenchement des prélèvements » dans admin-users.html.
 * NE COUVRE PAS : création, génération/envoi du lien mandat, annulation —
 * ces endpoints gardent leur gate d'origine (admin ou sales propriétaire).
 */
async function requirePaymentsTrigger(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401/403

  const canTriggerAll = auth.role === 'admin' || auth.userData.paymentsTrigger === true;
  if (!canTriggerAll && auth.role !== 'sales') {
    res.status(403).json({ error: 'Droit de déclenchement requis (paymentsTrigger)' });
    return null;
  }

  auth.canTriggerAll = canTriggerAll;
  return auth;
}

module.exports = {
  verifyFirebaseAuth,
  requireAuth,
  requireAdmin,
  requirePaymentsTrigger,
};

}};

/* ── ./api/signature-completed.js ── */
__defs["./api/signature-completed.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_billing-gmail": function () { return __shim['./_billing-gmail']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/signature-completed.js — LA COPIE DU CONTRAT SIGNÉ, PAR EMAIL
// ----------------------------------------------------------------------------
// POST /api/signature-completed   { requestId, token }            (signataire)
// POST /api/signature-completed   { requestId, force }  + Bearer  (équipe)
//   → 200 { ok:true, sentTo, filename, envois }
//   → 200 { ok:true, already:true }     déjà envoyée, on ne double pas
//
// POURQUOI CET ENDPOINT
// ---------------------
// À la fin de la signature, sign.html déposait un document
// webhook_inbox { action:'signature_completed' } et comptait sur la Cloud
// Function onWebhookInbox pour envoyer la copie au client. Cette fonction a
// été redéployée depuis le repo, dont la copie ne contenait plus les handlers
// signature : le document est toujours écrit, plus personne ne le lit. Le
// client signait et ne recevait jamais son contrat, sans qu'aucune erreur
// n'apparaisse nulle part.
//
// C'est EXACTEMENT la panne qui avait déjà emporté le code SMS (voir
// api/signature-otp.js, même en-tête). On applique le même remède : le
// traitement revient sur Vercel, qui déploie depuis git — le code lu est donc
// le code exécuté, et la divergence n'est plus possible.
//
// DEUX PORTES D'ENTRÉE, TOUTES DEUX VÉRIFIÉES — même modèle que
// api/signature-send-link.js :
//   · le signataire, avec le token de la demande — il n'a pas de compte, mais
//     il vient de signer et son token prouve qu'il est bien sur ce dossier ;
//   · l'équipe, avec un jeton Firebase — c'est le bouton « Envoyer la copie »
//     de l'onglet Terminés dans sales-signatures.
// Aucune des deux ne choisit le destinataire : l'adresse vient TOUJOURS du
// document Firestore, jamais du corps de requête — sinon n'importe qui ferait
// expédier un contrat signé à l'adresse de son choix.
//
// IDEMPOTENCE — ET SA LEVÉE VOLONTAIRE
// `copieEnvoyeeAt` marque l'envoi : un rechargement de la page de fin ou un
// double clic ne renvoie pas le contrat une seconde fois. L'équipe, elle, peut
// passer outre avec force:true — c'est tout l'intérêt du bouton : le client a
// perdu son mail, il est parti en spam, l'adresse a été corrigée. Le garde
// reste absolu pour la porte publique, qui ne peut PAS demander force.
//
// COUCHE ADDITIVE : l'écriture dans webhook_inbox reste en place côté
// sign.html. Si la Cloud Function revenait un jour à la vie, le garde
// d'idempotence empêcherait le double envoi.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');
const { appendAudit, clientInfo } = require('./_sign-core');

/* Comptes d'envoi autorisés — mêmes que signature-fallback.js. */
const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

function safeFilename(s) {
  return String(s || 'contrat')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '_')
    .slice(0, 60) || 'contrat';
}

/* Même vérification que api/academy-grant.js : le token du lien de signature,
   à la racine (ancien modèle) ou porté par un signataire (nouveau). */
function tokenMatches(reqData, token) {
  if (!token) return false;
  if (reqData.token && reqData.token === token) return true;
  if (Array.isArray(reqData.signers)) {
    return reqData.signers.some((s) => s && s.token && s.token === token);
  }
  return false;
}

/* Le PDF signé vit soit en clair sur la demande, soit découpé en morceaux
   dans la sous-collection signed_pdf — au-delà de ~900 Ko, sign.html découpe
   pour tenir sous la limite de 1 Mo par document Firestore.
   orderBy('chunk') : les morceaux se recollent par leur index, jamais par
   l'ordre alphabétique de leur identifiant. */
async function lirePdfSigne(reqRef, reqData) {
  if (reqData.signedPdfBase64) return reqData.signedPdfBase64;
  const snap = await reqRef.collection('signed_pdf').orderBy('chunk').get();
  if (snap.empty) return null;
  let b64 = '';
  snap.forEach((d) => { b64 += (d.data() || {}).data || ''; });
  return b64 || null;
}

/* Le destinataire : l'adresse du document, jamais celle du corps de requête. */
function emailDuClient(R) {
  if (R.clientEmail) return String(R.clientEmail).trim();
  if (Array.isArray(R.signers)) {
    const s = R.signers.find((x) => x && x.email);
    if (s) return String(s.email).trim();
  }
  return '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const body = parseBody(req) || {};
  const requestId = String(body.requestId || '').trim();
  const token = String(body.token || '').trim();
  if (!requestId) { res.status(400).json({ ok: false, error: 'requestId_required' }); return; }

  try {
    const reqRef = db.collection('signature_requests').doc(requestId);
    const snap = await reqRef.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'request_not_found' }); return; }
    const R = snap.data() || {};

    /* Porte 1 : l'équipe, avec un jeton Firebase. Porte 2 : le token de la
       demande. L'une des deux suffit, aucune n'est facultative. */
    let par = null;
    let equipe = false;
    try {
      const auth = await verifyFirebaseAuth(req);
      if (auth) { equipe = true; par = auth.email || 'equipe'; }
    } catch (e) { /* pas de jeton : on tente le token de la demande */ }
    if (!equipe) {
      if (!tokenMatches(R, token)) { res.status(401).json({ ok: false, error: 'invalid_token' }); return; }
      par = 'systeme';
    }

    if (R.status !== 'signed') {
      res.status(409).json({ ok: false, error: 'not_signed_yet' });
      return;
    }

    /* Déjà envoyée : on répond sans rien refaire. Un rechargement de la page
       de fin ne doit pas expédier le contrat une deuxième fois. Seule l'équipe
       peut passer outre, et seulement en le demandant explicitement. */
    const force = equipe && body.force === true;
    if (R.copieEnvoyeeAt && !force) {
      res.status(200).json({ ok: true, already: true, sentTo: R.copieEnvoyeeA || null });
      return;
    }

    const to = emailDuClient(R);
    if (!to || to.indexOf('@') < 0) {
      console.error('[signature-completed] aucune adresse sur la demande', requestId);
      res.status(400).json({ ok: false, error: 'no_client_email' });
      return;
    }

    const b64 = await lirePdfSigne(reqRef, R);
    if (!b64) {
      console.error('[signature-completed] PDF signé introuvable', requestId);
      res.status(409).json({ ok: false, error: 'signed_pdf_missing' });
      return;
    }

    const nomDoc = R.templateName || 'Contrat';
    const fichier = safeFilename(nomDoc + ' - ' + (R.clientName || 'client')) + '.pdf';
    const account = ACCOUNTS[R.sendAccount] ? R.sendAccount : 'contact';

    const bodyText = [
      'Bonjour ' + (R.clientName || '') + ',',
      '',
      'Votre contrat « ' + nomDoc + ' » a bien été signé.',
      'Vous en trouverez la copie signée en pièce jointe de cet e-mail.',
      '',
      'Conservez-la : elle fait foi.',
      '',
      'Bien à vous,',
      'L\'équipe Ambitio',
    ].join('\n');

    const sent = await sendGmailWithAttachment({
      tokenAccount: account,
      fromName: 'Ambitio',
      to: [to],
      subject: 'Votre contrat signé — ' + nomDoc,
      bodyText,
      attachments: [{
        filename: fichier,
        contentBytes: Buffer.from(b64, 'base64'),
        contentType: 'application/pdf',
      }],
    });

    /* Trace sur la demande : sert de garde d'idempotence ET de preuve d'envoi
       dans la fiche signature. Le compteur dit combien de fois la copie est
       partie — un renvoi manuel ne doit pas effacer la trace du premier. */
    const envois = (Number(R.copieEnvoyeeCount) || (R.copieEnvoyeeAt ? 1 : 0)) + 1;
    await reqRef.set({
      copieEnvoyeeAt: admin.firestore.FieldValue.serverTimestamp(),
      copieEnvoyeeA: to,
      copieEnvoyeeCount: envois,
      copieEnvoyeePar: par,
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'copie_envoyee',
        date: new Date().toISOString(),
        to,
        by: par,
      }),
    }, { merge: true });

    await appendAudit(reqRef, [{ type: 'copie_envoyee', signer: null, data: { a: to, par: par, envoi: envois } }], clientInfo(req))
      .catch(function (e) { console.warn('[signature-completed] journal:', e && e.message); });

    console.log('[signature-completed] copie envoyée', requestId, '→', to,
      'par=' + par, 'envoi n°' + envois, 'msg=' + (sent && sent.messageId));
    res.status(200).json({ ok: true, sentTo: to, filename: fichier, envois });
  } catch (e) {
    console.error('[signature-completed]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

}};

/* ── ./api/gocardless-billing-request.js ── */
__defs["./api/gocardless-billing-request.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js"}, shims: {"firebase-admin": function () { return __shim['firebase-admin']; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ==========================================================================
// api/gocardless-billing-request.js  (v3 — fix 403 "create_customer")
// --------------------------------------------------------------------------
// Crée un billing request + billing request flow (lien mandat IBAN hébergé).
//
// CHANGEMENT CLÉ vs v2 :
//   v2 appelait POST /customers pour créer le customer avant le BR. Support
//   GoCardless (Vlad, ticket 4258993) a confirmé que POST /customers est
//   restreint au niveau compte car nos pages de paiement custom ne sont pas
//   activées → 403 systématique. On laisse donc GoCardless créer lui-même le
//   customer + le compte bancaire + le mandat via la page hébergée. Les
//   infos client sont juste pré-remplies via `prefilled_customer` sur le
//   flow (ça c'est autorisé, c'est juste de la pré-pop UI).
//
// On ajoute aussi `metadata.paymentId` sur le BR → le Cloud Function
// `onWebhookInbox` et la route `/api/gocardless-finalize` pourront retrouver
// notre doc Firestore `payments/{id}` à partir du billing request.
//
// Body : { paymentId, leadName, leadEmail, leadPhone }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { billingRequestId, flowUrl, reused? }
// ==========================================================================

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
// Version API GoCardless. 2015-07-06 est la version de base (celle utilisée
// partout ailleurs dans le repo : gocardless-payment, gocardless-lookup,
// gocardless-status). Elle couvre les billing requests en rétro-compat.
// Ne pas remettre de date "moderne" sans vérifier qu'elle existe dans
// https://developer.gocardless.com/api-reference → sinon HTTP 400
// "Version not found".
const GC_VERSION = '2015-07-06';

class GoCardlessError extends Error {
  constructor(step, status, body) {
    super('GoCardless ' + status + ' on ' + step + ': ' + JSON.stringify(body));
    this.step = step;
    this.status = status;
    this.body = body;
    this.name = 'GoCardlessError';
  }
}

async function gcRequest(stepName, method, path, body) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');

  const resp = await fetch(`${GC_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': GC_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let json;
  try { json = await resp.json(); } catch (e) { json = { parseError: true }; }

  if (!resp.ok) {
    // Dump explicite en string pour que Vercel n'affiche pas "[Array]"
    // sur les sous-objets (errors détaillés sont cruciaux pour le debug GC).
    console.error('[gocardless-billing-request] ❌ ' + stepName + ' failed',
      'env=' + GC_ENV,
      'status=' + resp.status,
      'path=' + path,
      'response=' + JSON.stringify(json)
    );
    throw new GoCardlessError(stepName, resp.status, json);
  }
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId, leadName, leadEmail, leadPhone } = parseBody(req);

    if (!paymentId || !leadEmail) {
      res.status(400).json({ error: 'paymentId et leadEmail requis' });
      return;
    }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) {
      res.status(404).json({ error: 'Paiement introuvable' });
      return;
    }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (pay.gcMandateId) {
      res.status(400).json({ error: 'Un mandat existe déjà pour ce paiement' });
      return;
    }

    // Idempotence : si un BR + flow existent déjà, on les renvoie tels quels
    // plutôt que d'en créer un nouveau (protection contre le double-clic).
    if (pay.gcBillingRequestId && pay.gcBillingRequestFlowUrl) {
      res.json({
        billingRequestId: pay.gcBillingRequestId,
        flowUrl: pay.gcBillingRequestFlowUrl,
        reused: true
      });
      return;
    }

    const nameParts = (leadName || '').trim().split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] || 'Client';
    // Si le lead n'a qu'un prénom saisi ("Adrien"), on n'envoie PAS family_name
    // — envoyer un '-' placeholder affichait le dash sur la page GC.
    const familyName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

    console.log('[gocardless-billing-request] start', {
      env: GC_ENV,
      paymentId,
      leadEmail,
    });

    // ─── 1. Créer le billing request ───
    // Pas de `links.customer` — on laisse GoCardless créer le customer via
    // la page hébergée. `metadata.paymentId` permet aux webhooks GC et à la
    // route finalize de retrouver notre doc payment Firestore.
    const brResp = await gcRequest('create_billing_request', 'POST', '/billing_requests', {
      billing_requests: {
        mandate_request: {
          currency: 'EUR',
          scheme: 'sepa_core'
        },
        metadata: {
          paymentId: paymentId
        }
      }
    });
    const billingRequestId = brResp.billing_requests.id;

    // ─── 2. Créer le flow (URL vers la page hébergée GoCardless) ───
    // `prefilled_customer` pré-remplit les champs pour le client sur la
    // page hébergée. Attention : sur l'API version 2015-07-06, seuls
    // given_name / family_name / email sont des clés permises. phone_number
    // et country_code sont rejetés avec "Invalid document structure".
    // Construction conditionnelle : family_name n'est inclus que s'il
    // existe vraiment — évite d'afficher un dash placeholder.
    const prefilled = {
      given_name: givenName,
      email: leadEmail
    };
    if (familyName) prefilled.family_name = familyName;

    const baseUrl = process.env.APP_BASE_URL || 'https://team.alteore.com';
    const flowResp = await gcRequest('create_billing_request_flow', 'POST', '/billing_request_flows', {
      billing_request_flows: {
        redirect_uri: `${baseUrl}/payments.html?mandateDone=1&paymentId=${paymentId}`,
        exit_uri: `${baseUrl}/payments.html?mandateCancelled=1&paymentId=${paymentId}`,
        prefilled_customer: prefilled,
        links: { billing_request: billingRequestId }
      }
    });
    const flowUrl = flowResp.billing_request_flows.authorisation_url;

    // ─── 3. MAJ Firestore ───
    await db.collection('payments').doc(paymentId).update({
      gcBillingRequestId: billingRequestId,
      gcBillingRequestFlowUrl: flowUrl,
      status: 'pending_mandate',
      updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    });

    console.log('[gocardless-billing-request] ✅ success', { paymentId, billingRequestId });
    res.json({ billingRequestId, flowUrl });

  } catch (e) {
    if (e instanceof GoCardlessError) {
      res.status(e.status).json({
        error: 'GoCardless error on step "' + e.step + '"',
        step: e.step,
        gocardlessStatus: e.status,
        gocardlessBody: e.body,
        env: GC_ENV,
      });
      return;
    }
    console.error('[gocardless-billing-request] unhandled', e);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ── ./api/gocardless-finalize.js ── */
__defs["./api/gocardless-finalize.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ==========================================================================
// api/gocardless-finalize.js   (nouveau — 2026-04-17)
// --------------------------------------------------------------------------
// Récupère l'état d'un billing request GoCardless et synchronise le doc
// payment Firestore correspondant (gcCustomerId, gcMandateId, status).
//
// Rôle : filet de sécurité côté client. Quand le sales ouvre un paiement
// en `pending_mandate` sans gcMandateId, payments.html appelle cette route
// pour récupérer immédiatement l'état du BR depuis GoCardless, sans
// attendre le webhook. Utile si :
//   - le webhook onWebhookInbox est en retard (retry GC)
//   - le webhook a été perdu (indisponibilité)
//   - le sales veut forcer un refresh manuel via le bouton dédié
//
// Le webhook `onWebhookInbox` (Cloud Function) reste la source async
// principale. Cette route est purement best-effort côté client.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token — admin, flag paymentsTrigger (tout rôle),
//        ou sales sur ses propres paiements (historique)
// Réponse : { status, billingRequestStatus, gcMandateId, gcCustomerId }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requirePaymentsTrigger } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
// Version API GoCardless — voir commentaire dans gocardless-billing-request.js
const GC_VERSION = '2015-07-06';

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': GC_VERSION,
      'Accept': 'application/json'
    }
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requirePaymentsTrigger(req, res);
  if (!auth) return;

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (!auth.canTriggerAll && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé' });
      return;
    }
    if (!pay.gcBillingRequestId) {
      res.status(400).json({ error: 'Aucun billing request sur ce paiement' });
      return;
    }

    // ─── Fetch le BR pour lire son statut + ses liens ───
    const brResp = await gcGet('/billing_requests/' + pay.gcBillingRequestId);
    if (!brResp || !brResp.billing_requests) {
      res.status(404).json({ error: 'Billing request introuvable côté GoCardless' });
      return;
    }
    const br = brResp.billing_requests;
    const brStatus = br.status; // pending | ready_to_fulfil | fulfilled | cancelled
    const links = br.links || {};

    const customerId = links.customer || null;
    const mandateId = links.mandate_request_mandate || null;

    const update = {
      gcLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (customerId && customerId !== pay.gcCustomerId) update.gcCustomerId = customerId;
    if (mandateId && mandateId !== pay.gcMandateId) update.gcMandateId = mandateId;

    // ─── Mapping statut BR → statut Firestore payment ───
    if (brStatus === 'fulfilled' && mandateId) {
      update.status = 'mandate_active';
      if (!pay.mandateCreatedAt) update.mandateCreatedAt = admin.firestore.FieldValue.serverTimestamp();
    } else if (brStatus === 'cancelled') {
      // Le client a abandonné sur la page hébergée
      update.status = 'draft';
      update.gcBillingRequestFlowUrl = null; // force la regénération d'un nouveau lien
    } else {
      // pending / ready_to_fulfil → on reste en pending_mandate
      update.status = 'pending_mandate';
    }

    await paySnap.ref.update(update);

    console.log('[gocardless-finalize] ✅', {
      paymentId,
      brStatus,
      mandateId,
      customerId,
      newStatus: update.status
    });

    res.json({
      status: update.status,
      billingRequestStatus: brStatus,
      gcMandateId: mandateId,
      gcCustomerId: customerId
    });

  } catch (e) {
    console.error('[gocardless-finalize]', e.message);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ── ./api/gocardless-payment.js ── */
__defs["./api/gocardless-payment.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ==========================================================================
// api/gocardless-payment.js
// --------------------------------------------------------------------------
// Déclenche un paiement GoCardless sur un mandat existant.
// - Paiement intégral  → POST /payments
// - Fractionné         → POST /subscriptions
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token — admin, flag paymentsTrigger (tout rôle),
//        ou sales sur ses propres paiements (historique)
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requirePaymentsTrigger } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

async function gcRequest(method, path, body) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requirePaymentsTrigger(req, res);
  if (!auth) return;

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (!auth.canTriggerAll && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé' }); return;
    }
    if (!pay.gcMandateId) {
      res.status(400).json({ error: 'Aucun mandat actif — le client doit d\'abord renseigner son IBAN' }); return;
    }
    if (pay.gcPaymentId || pay.gcSubscriptionId) {
      res.status(400).json({ error: 'Un paiement ou abonnement existe déjà pour ce mandat' }); return;
    }

    const amountCents = Math.round(pay.installmentAmount * 100);
    const description = pay.description || 'Programme Business Phénix';

    let gcId, gcType, update;

    if (pay.type === 'installments' && pay.installmentsCount > 1) {
      // Abonnement mensuel
      let startDate = pay.startDate || new Date().toISOString().slice(0, 10);

      // GoCardless refuse une start_date antérieure à la première date de
      // prélèvement possible du mandat (préavis SEPA). On lit
      // next_possible_charge_date et on cale la start_date dessus si la date
      // voulue est trop tôt, pour éviter le 422
      // "must be on or after mandate's next_possible_charge_date".
      try {
        const mandateResp = await gcRequest('GET', `/mandates/${pay.gcMandateId}`);
        const npcd = mandateResp && mandateResp.mandates && mandateResp.mandates.next_possible_charge_date;
        if (npcd && startDate < npcd) startDate = npcd;
      } catch (mErr) {
        console.warn('[gocardless-payment] lecture mandat impossible, start_date conservée:', mErr.message);
      }

      const subResp = await gcRequest('POST', '/subscriptions', {
        subscriptions: {
          amount: amountCents,
          currency: 'EUR',
          interval_unit: 'monthly',
          interval: 1,
          count: pay.installmentsCount,
          start_date: startDate,
          name: description,
          links: { mandate: pay.gcMandateId }
        }
      });
      gcId = subResp.subscriptions.id;
      gcType = 'subscription';
      update = {
        gcSubscriptionId: gcId,
        status: 'active',
        paidCount: 0,
        startDate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
    } else {
      // Paiement unique
      const payResp = await gcRequest('POST', '/payments', {
        payments: {
          amount: Math.round(pay.totalAmount * 100),
          currency: 'EUR',
          description,
          links: { mandate: pay.gcMandateId }
        }
      });
      gcId = payResp.payments.id;
      gcType = 'payment';
      update = {
        gcPaymentId: gcId,
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
    }

    await db.collection('payments').doc(paymentId).update(update);
    res.json({ gcId, gcType });

  } catch (e) {
    console.error('[gocardless-payment]', e.message);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ── ./api/payments-send-mandate-sms.js ── */
__defs["./api/payments-send-mandate-sms.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_ringoverClient": function () { return __shim['./_ringoverClient']; }}, fn: function (module, exports, require) {
// api/payments-send-mandate-sms.js  (v3 — endpoint /push/sms correct)
const { db, admin } = require('./_firebaseAdmin');
const { requireAuth }  = require('./_verifyFirebaseAuth');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (c.startsWith('33') && c.length >= 11) return '+' + c;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') { res.status(403).json({ error: 'Rôle requis' }); return; }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) { res.status(403).json({ error: 'Accès refusé' }); return; }
    if (!pay.gcBillingRequestFlowUrl) { res.status(400).json({ error: 'Aucun lien mandat généré' }); return; }

    const toNumber = normalizeE164(pay.leadPhone);
    if (!toNumber) { res.status(400).json({ error: 'Numéro invalide' }); return; }

    const creds = await getRingoverCreds();
    if (!creds.fromNumber) { res.status(500).json({ error: 'ringover.fromNumber manquant' }); return; }

    const firstName = String(pay.leadName || 'Bonjour').trim().split(/\s+/)[0];
    const content = `Bonjour ${firstName},\n\nPour finaliser votre prélèvement (${pay.description || 'Programme'}), renseignez votre IBAN ici :\n\n${pay.gcBillingRequestFlowUrl}\n\nL'équipe Ambitio`;

    let resp;
    try {
      resp = await ringoverFetch('/push/sms', {
        method: 'POST',
        body: { from_number: creds.fromNumber, to_number: toNumber, content },
      });
    } catch (e) {
      console.error('[payments-send-mandate-sms] Ringover error:', e.message);
      res.status(502).json({ error: e.message });
      return;
    }

    if (pay.leadId) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const nowIso = new Date().toISOString();
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const tlDate = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      db.collection('leads').doc(pay.leadId).update({
        communications: admin.firestore.FieldValue.arrayUnion({
          type: 'sms', direction: 'outbound', content, source: 'ringover-sms',
          date: nowIso, createdAt: nowIso, ownerUid: auth.uid,
          fromNumber: creds.fromNumber, toNumber,
        }),
        timeline_history: admin.firestore.FieldValue.arrayUnion({
          text: '💬 SMS mandat envoyé', date: tlDate, color: '#60a5fa',
        }),
        lastContactAt: now, lastContactType: 'sms', updatedAt: now,
      }).catch(e => console.warn('[payments-mandate-sms] log lead:', e.message));
    }

    res.json({ ok: true, messageId: resp?.message_id || null, from: creds.fromNumber, to: toNumber });
  } catch (e) {
    console.error('[payments-send-mandate-sms]', e.message);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ── ./api/payments-send-mandate-email.js ── */
__defs["./api/payments-send-mandate-email.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_gmailSend": function () { return __shim['./_gmailSend']; }}, fn: function (module, exports, require) {
// ==========================================================================
// api/payments-send-mandate-email.js
// --------------------------------------------------------------------------
// Envoie au client l'email contenant le lien mandat GoCardless (IBAN).
// Utilise le compte Gmail OAuth `strategie@adrienemily.com` (token dans
// email_tokens/strategie) via le helper partagé `_gmailSend`.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { ok: true, messageId, from }
//
// Log latéral : écrit une entrée communications[] + timeline_history[] sur
// leads/{leadId} (même schéma que twilio-sms-send pour que sales-contact.html
// et sales-leads.html rendent l'email sans modification frontend).
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { sendEmailFromAccount } = require('./_gmailSend');
const parseBody = require('./_parseBody');

const ACCOUNT_KEY = 'strategie';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmail({ leadName, description, flowUrl }) {
  const safeName = esc(leadName || 'Bonjour');
  const safeDesc = esc(description || 'votre programme');
  const safeUrl = esc(flowUrl);

  const subject = 'Mise en place de votre prélèvement — ' + (description || 'Ambitio');

  const bodyHtml = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f7;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
          <tr>
            <td style="padding:32px 36px 8px;font-size:16px;line-height:1.55;color:#1a1a1a">
              <p style="margin:0 0 16px">Bonjour ${safeName},</p>

              <p style="margin:0 0 16px">Pour finaliser la mise en place de <strong>${safeDesc}</strong>, il ne vous reste qu'à renseigner vos coordonnées bancaires via le lien sécurisé ci-dessous :</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 36px 24px">
              <a href="${safeUrl}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px">Renseigner mon IBAN</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 24px;font-size:13px;line-height:1.55;color:#555">
              <p style="margin:0 0 12px">Ou copiez ce lien dans votre navigateur :</p>
              <p style="margin:0 0 20px;word-break:break-all;font-family:Menlo,Monaco,monospace;font-size:12px;color:#333">${safeUrl}</p>

              <p style="margin:0 0 12px;font-size:12px;color:#777">Ce lien vous dirige vers notre partenaire de prélèvement <strong>GoCardless</strong>, leader européen du SEPA. Vos informations bancaires sont traitées de manière sécurisée et ne sont jamais stockées sur nos serveurs.</p>

              <p style="margin:16px 0 0;font-size:13px;color:#555">Pour toute question, répondez simplement à cet email.</p>

              <p style="margin:16px 0 0;font-size:13px;color:#1a1a1a">Cordialement,<br/><strong>L'équipe Ambitio</strong></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const bodyText = `Bonjour ${leadName || ''},

Pour finaliser la mise en place de ${description || 'votre programme'}, il ne vous reste qu'à renseigner vos coordonnées bancaires via le lien sécurisé ci-dessous :

${flowUrl}

Ce lien vous dirige vers notre partenaire GoCardless (prélèvement SEPA). Vos informations bancaires sont traitées de manière sécurisée et ne sont jamais stockées sur nos serveurs.

Pour toute question, répondez simplement à cet email.

Cordialement,
L'équipe Ambitio`;

  return { subject, bodyHtml, bodyText };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    // ─── Load payment ───
    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (!pay.leadEmail) {
      res.status(400).json({ error: 'Aucun email sur ce paiement' });
      return;
    }
    if (!pay.gcBillingRequestFlowUrl) {
      res.status(400).json({ error: 'Aucun lien mandat généré — crée-le d\'abord' });
      return;
    }

    // ─── Build email ───
    const { subject, bodyHtml, bodyText } = buildEmail({
      leadName: pay.leadName,
      description: pay.description,
      flowUrl: pay.gcBillingRequestFlowUrl
    });

    // ─── Send via Gmail OAuth (compte strategie) ───
    const result = await sendEmailFromAccount({
      accountKey: ACCOUNT_KEY,
      to: pay.leadEmail,
      subject,
      bodyHtml,
      bodyText
    });

    if (!result.ok) {
      console.error('[payments-send-mandate-email] send failed:', result.error);
      res.status(502).json({ error: result.error || 'Échec envoi Gmail' });
      return;
    }

    // ─── Log dans leads/{leadId}.communications[] + timeline_history[] ───
    if (pay.leadId) {
      try {
        // Résolution ownerName (même pattern que twilio-sms-send)
        let ownerName = null;
        try {
          const metaSnap = await db.collection('_meta').doc('team_members').get();
          if (metaSnap.exists) {
            const members = metaSnap.data().members || [];
            const me = members.find(m => m.firebaseUid === auth.uid);
            if (me) ownerName = me.shortName || me.displayName || null;
          }
        } catch (_) { /* non-bloquant */ }
        ownerName = ownerName || auth.email || 'Équipe';

        const nowIso = new Date().toISOString();
        const commEntry = {
          type: 'email',
          direction: 'outbound',
          content: bodyText,
          subject: subject,
          source: 'gmail-strategie',
          date: nowIso,
          createdAt: nowIso,
          ownerUid: auth.uid,
          ownerName,
          providerMessageId: result.messageId || null,
          fromEmail: result.from || ACCOUNT_KEY + '@adrienemily.com',
          toEmail: pay.leadEmail
        };

        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const timelineEntry = {
          text: '📧 Email mandat envoyé (strategie) — ' + (subject || '').substring(0, 100),
          date: tlDate,
          color: '#a78bfa'
        };

        await db.collection('leads').doc(pay.leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion(commEntry),
          timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
          lastContactType: 'email',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logErr) {
        // Non-bloquant : l'email est parti, on log juste l'échec du tracking
        console.warn('[payments-send-mandate-email] log lead failed (non-bloquant):', logErr.message);
      }
    }

    console.log('[payments-send-mandate-email] ✅ sent', {
      paymentId,
      to: pay.leadEmail,
      from: result.from,
      messageId: result.messageId
    });

    res.json({
      ok: true,
      messageId: result.messageId,
      from: result.from
    });

  } catch (e) {
    console.error('[payments-send-mandate-email]', e.message);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ═══════════════════════════════════════════════════════════════════════
   Bac à sable — le « serveur » : routage des appels /api/* des vraies
   pages vers le VRAI code des endpoints (api/*.js, empaqueté tel quel),
   avec une requête et une réponse façon Vercel.
   Endpoints absents de ROUTES : réponse inerte (FAKE) ou refus explicite.
   Source de scripts/build-sandbox-server.js.
   ═══════════════════════════════════════════════════════════════════════ */

const ROUTES = {
  '/api/sign-session': './api/sign-session.js',
  '/api/signature-otp': './api/signature-otp.js',
  '/api/signature-send-link': './api/signature-send-link.js',
  '/api/signature-completed': './api/signature-completed.js',
  '/api/gocardless-billing-request': './api/gocardless-billing-request.js',
  '/api/gocardless-finalize': './api/gocardless-finalize.js',
  '/api/gocardless-payment': './api/gocardless-payment.js',
  '/api/payments-send-mandate-sms': './api/payments-send-mandate-sms.js',
  '/api/payments-send-mandate-email': './api/payments-send-mandate-email.js'
};

/* Ce qui ne doit JAMAIS s'exécuter, même simulé : l'ouverture d'un accès
   AE Academy, l'envoi de secours hors signature électronique, l'IA. Les
   statistiques et notifications répondent « vide ». */
const FAKE = {
  '/api/academy-grant': function () { return [200, { granted: false, reason: 'disabled_by_template', sandbox: true }]; },
  '/api/academy-courses': function () { return [200, { ok: true, courses: [] }]; },
  '/api/signature-fallback': function () { return [409, { error: 'Envoi de secours désactivé dans le bac à sable.' }]; },
  '/api/payments-unpaid': function () { return [200, { ok: true, kpis: {}, items: [], events: [], note: '' }]; },
  '/api/user-activity': function () { return [200, { ok: true }]; },
  '/api/ai-followup': function () { return [200, { ok: true, items: [] }]; },
  '/api/twilio-sms-status': function () { return [200, {}]; },
  /* Réservation (booking.html) : attribution setting et quota coaching —
     sans effet dans le bac à sable (le RDV est écrit dans la fausse base). */
  '/api/booking-setter-attribution': function () { return [200, { ok: true, sandbox: true }]; },
  '/api/booking-attribution': function () { return [200, { ok: true, sandbox: true }]; },
  '/api/booking-check-coaching-quota': function () { return [200, { allowed: true }]; }
};

async function __handle(path, init) {
  init = init || {};
  const u = new URL(path, location.origin);
  const route = u.pathname.replace(/\/+$/, '');
  const method = String(init.method || 'GET').toUpperCase();
  const hdrs = {};
  const h = init.headers || {};
  if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { hdrs[String(k).toLowerCase()] = v; });
  else Object.keys(h).forEach(function (k) { hdrs[k.toLowerCase()] = h[k]; });
  hdrs['user-agent'] = hdrs['user-agent'] || navigator.userAgent;
  hdrs['accept-language'] = hdrs['accept-language'] || navigator.language || 'fr-FR';
  hdrs['host'] = 'team.alteore.com';
  hdrs['x-forwarded-proto'] = 'https';
  hdrs['x-forwarded-for'] = '127.0.0.1';
  hdrs['x-vercel-ip-city'] = encodeURIComponent('Bac à sable');
  hdrs['x-vercel-ip-country'] = 'FR';

  if (FAKE[route]) { const r = FAKE[route](); return { status: r[0], body: JSON.stringify(r[1]) }; }
  if (!ROUTES[route]) return { status: 503, body: JSON.stringify({ error: 'Bloqué par le bac à sable : ' + route }) };

  let body = init.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* laissé brut */ } }
  const query = {};
  u.searchParams.forEach(function (v, k) { query[k] = v; });
  const req = { method: method, url: u.pathname + u.search, headers: hdrs, body: body == null ? {} : body, query: query, socket: { remoteAddress: '127.0.0.1' } };

  return new Promise(function (resolve) {
    let status = 200, done = false;
    const outHeaders = {};
    function finish(b) { if (done) return; done = true; resolve({ status: status, body: b == null ? '' : b, headers: outHeaders }); }
    const res = {
      statusCode: 200,
      status: function (c) { status = c; res.statusCode = c; return res; },
      setHeader: function (k, v) { outHeaders[k] = v; return res; },
      getHeader: function (k) { return outHeaders[k]; },
      json: function (o) { finish(JSON.stringify(o)); return res; },
      send: function (b) { finish(typeof b === 'string' ? b : JSON.stringify(b)); return res; },
      end: function (b) { finish(b || ''); return res; },
      writeHead: function (c) { status = c; return res; },
      redirect: function (c, loc) { status = typeof c === 'number' ? c : 302; finish(''); return res; }
    };
    Promise.resolve().then(function () { return __require(ROUTES[route])(req, res); }).then(function () {
      finish('');
    }).catch(function (e) {
      console.error('[bac à sable] ' + route, e);
      if (!done) { status = 500; finish(JSON.stringify({ error: (e && e.message) || 'Erreur serveur (bac à sable)' })); }
    });
  });
}

window.__SBX_SERVER = {
  handle: __handle,
  gc: { complete: __gc.complete, get: __gc.get },
  require: __require
};

})();
