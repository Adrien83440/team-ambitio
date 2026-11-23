/* ═══════════════════════════════════════════════════════════════════════
   sandbox-server.js — GÉNÉRÉ par scripts/build-sandbox-server.js.
   NE PAS ÉDITER : relancer `node scripts/build-sandbox-server.js`.
   Le vrai code serveur (api/*) empaqueté pour le bac à sable closer,
   branché sur la fausse base et des services simulés. Rien ne sort.
   Modules : ./api/sign-session.js, ./api/_parseBody.js, ./api/_sign-core.js, ./api/_companyLookup.js, ./api/_sign-pdf.js, ./api/_contract-render.js, ./api/_sign-brand.js, ./api/_closeSms.js, ./api/_twilioClient.js, ./api/signature-otp.js, ./api/signature-send-link.js, ./api/_verifyFirebaseAuth.js, ./api/signature-completed.js, ./api/gocardless-billing-request.js, ./api/gocardless-finalize.js, ./api/gocardless-payment.js, ./api/_accesPaiement.js, ./demarrage-core.js, ./api/payments-send-mandate-sms.js, ./api/payments-send-mandate-email.js
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
__defs["./api/sign-session.js"] = { map: {"./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js","./_companyLookup":"./api/_companyLookup.js","./_sign-pdf":"./api/_sign-pdf.js","./_contract-render":"./api/_contract-render.js","./_closeSms":"./api/_closeSms.js"}, shims: {"crypto": function () { return __crypto; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_tsa": function () { return __shim['./_tsa']; }, "pdf-lib": function () { return __shim['pdf-lib']; }}, fn: function (module, exports, require) {
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
//
// 14/10/2026 — signataires hors de France :
//   · company.country === 'CA' : société canadienne saisie par le signataire
//     (_companyLookup.canadaCompany), sans annuaire officiel ;
//   · R.otpChannel === 'email' : le code arrive par e-mail (signature-otp) ;
//     la page et le dossier de preuve le disent ;
//   · web.roleSignataire === 'prestataire' : contrat où Ambitio est « la
//     Société » et le signataire « le Prestataire » (closer, setter…).
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const core = require('./_sign-core');
const company = require('./_companyLookup');
const { buildPreviewPdf, buildSignedPdf, finishSigned, EVENT_LABELS } = require('./_sign-pdf');
const render = require('./_contract-render');
const { timestamp } = require('./_tsa');
const { notifyCloseSms } = require('./_closeSms');

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
/* Qualités usuelles d'une entreprise canadienne (Québec compris). */
const QUALITES_CA = ['Président', 'Administrateur', 'Dirigeant', 'Associé', 'Propriétaire unique', 'Travailleur autonome', 'Mandataire habilité'];

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
    siege_social: c.addressLine || company.addressLine(a),
    /* Société canadienne : pas de SIRET ; un ancien modèle qui imprime
       {{siret}} affiche alors son immatriculation (« NEQ … »). */
    siret: c.country === 'CA' ? (c.registryNumber ? c.registryLabel + ' ' + c.registryNumber : '') : (c.siret || ''),
    siren: c.siren || String(c.siret || '').slice(0, 9),
    tva: company.taxLine(c), forme_juridique: c.legalFormLabel || '', activite: c.nafLabel || '',
    immatriculation: company.registrationLine(c),
    /* Entreprise canadienne non inscrite aux taxes : « néant », pas une ligne vide. */
    numeros_taxes: c.country === 'CA' ? (c.taxNumbers || 'néant') : company.taxLine(c),
    pays: c.country === 'CA' ? 'Canada' : (c.name ? 'France' : ''), province: c.provinceLabel || '',
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
function dirigeantCheck(reg, first, last, co) {
  if (co && co.country === 'CA') return 'Registre canadien non consulté — habilitation certifiée par le signataire';
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
  if (i === 0 && f.company && f.company.country === 'CA') {
    const ca = company.canadaCompany(f.company, core.parisToday());
    ca.errors.forEach(function (e) { errs.push(e); });
    ca.company.addressLine = company.addressLine(ca.company.address);
    out.company = ca.company;
  } else if (i === 0) {
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
        otpChannel: core.otpChannel(R),
        emailHint: core.maskEmail(found.signer.email || R.clientEmail),
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
    if (!core.otpOk(R, i)) { send(res, 401, { error: 'Vérification par code requise.', stage: 'otp' }); return; }

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
          qualitesCa: QUALITES_CA,
          provinces: company.CA_PROVINCES,
          roleSignataire: ctx.web && ctx.web.roleSignataire === 'prestataire' ? 'prestataire' : 'client',
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
    dirigeantCheck: i === 0 ? dirigeantCheck(v.registry || null, v.rep.first, v.rep.last, v.company) : 'Second signataire',
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
    otpLine: otp.atMs
      ? (otp.canal === 'email'
        ? 'Code à usage unique envoyé par e-mail à ' + (otp.email || '') + ', validé le ' + core.parisDateTime(new Date(otp.atMs))
        : 'Code à usage unique envoyé par SMS au ' + (otp.phone || '') + ', validé le ' + core.parisDateTime(new Date(otp.atMs)))
      : 'Non vérifié',
    otpAtMs: otp.atMs || null,
    otpCanal: otp.canal === 'email' ? 'email' : 'sms',
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
    roleSignataire: ctx.web && ctx.web.roleSignataire === 'prestataire' ? 'prestataire' : 'client',
    signers: all.map(function (d) {
      return {
        repName: d.rep.full, repQualite: d.rep.qualite, dirigeantCheck: d.dirigeantCheck,
        email: d.email, phone: d.phone, otpLine: d.otpLine, otpAt: d.otpAtMs, otpCanal: d.otpCanal || 'sms',
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
    immatriculation: company.registrationLine(d0.company), pays: d0.company.country === 'CA' ? 'Canada' : 'France',
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

  /* Signé + prélèvement déjà parti = close : SMS « Nouvelle vente »
     (21/10/2026). Le cas courant (paiement après signature) part de
     gocardless-payment. Ne lève jamais. */
  await notifyCloseSms(R.leadId, 'signature');

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

/* « ad•••@gmail.com » — même rôle que maskPhone pour une adresse e-mail. */
function maskEmail(e) {
  const s = String(e || '').trim();
  const at = s.indexOf('@');
  if (at < 1) return '';
  return s.slice(0, Math.min(2, at)) + '•••' + s.slice(at);
}

/* Canal du code à usage unique d'une demande : 'sms' (défaut) ou 'email'.
   'email' se choisit à l'envoi (sales-signatures, « signataire hors de
   France ») : Twilio n'achemine pas un SMS vers le Canada ou les États-Unis
   depuis notre numéro français. Le choix vit sur la demande, jamais dans ce
   que la page envoie : un signataire ne peut pas changer de canal. */
function otpChannel(R) {
  return R && R.otpChannel === 'email' ? 'email' : 'sms';
}

module.exports = {
  sha256Hex, findByToken, clientInfo,
  appendAudit, readAudit, entryHash,
  loadTemplate, webIsValid, webDigest,
  otpOk, OTP_SESSION_MS, device, setProgress, STEP_NAMES,
  parisToday, parisDateTime, foldText, maskPhone, maskEmail, otpChannel,
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
//
// ENTREPRISES CANADIENNES (14/10/2026) — canadaCompany() valide une société
// établie au Canada, saisie par le signataire : il n'existe pas d'annuaire
// canadien interrogeable librement (le Registraire des entreprises du Québec
// n'a pas d'API publique). Format de l'identifiant contrôlé (NEQ à 10
// chiffres au Québec, numéro d'entreprise fédéral à 9 chiffres ailleurs),
// code postal canadien, numéros de TPS/TVH et de TVQ facultatifs ; le dossier
// de preuve dit que rien n'a été vérifié au registre.
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
    /* Détail lu par le feu de solvabilité (api/_scoringVerdict.js) : `etat` part
       du siège, donc une entreprise au siège fermé (« F ») n'est pas « closed ». */
    etatEntreprise: String(entry.etat_administratif || '').toUpperCase(),
    siegeEtat: String(siege.etat_administratif || '').toUpperCase(),
    etablissementsOuverts: typeof entry.nombre_etablissements_ouverts === 'number' ? entry.nombre_etablissements_ouverts : null,
  };
}

/* Adresse sur une ligne, telle qu'elle s'imprime dans le contrat. Hors de
   France : « ville (QC) H3A 1B2, Canada ». */
function addressLine(a) {
  a = a || {};
  const l1 = [a.line1, a.line2].filter(Boolean).join(', ');
  if (a.country && a.country !== 'France') {
    const l2b = [a.city, a.region ? '(' + a.region + ')' : '', a.postalCode].filter(Boolean).join(' ');
    return [l1, l2b, a.country].filter(Boolean).join(', ');
  }
  const l2 = [a.postalCode, a.city].filter(Boolean).join(' ');
  return [l1, l2].filter(Boolean).join(', ');
}

/* ── Canada ──────────────────────────────────────────────────────────────── */
const CA_PROVINCES = {
  QC: 'Québec', ON: 'Ontario', BC: 'Colombie-Britannique', AB: 'Alberta', MB: 'Manitoba',
  SK: 'Saskatchewan', NS: 'Nouvelle-Écosse', NB: 'Nouveau-Brunswick', NL: 'Terre-Neuve-et-Labrador',
  PE: 'Île-du-Prince-Édouard', YT: 'Yukon', NT: 'Territoires du Nord-Ouest', NU: 'Nunavut',
};

/* Le registre d'où vient l'identifiant : NEQ au Québec, numéro d'entreprise
   (NE, attribué par l'Agence du revenu du Canada) partout ailleurs. */
function caRegistry(province) {
  if (province === 'QC') return { label: 'NEQ', name: 'Registraire des entreprises du Québec', digits: 10 };
  return { label: 'NE', name: 'numéro d\'entreprise fédéral (Agence du revenu du Canada)', digits: 9 };
}

/* Code postal canadien « A1A 1A1 » (lettres D, F, I, O, Q, U exclues ; W et Z
   jamais en tête). Rend la forme normalisée, ou '' si invalide. */
function caPostal(s) {
  const c = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(c)) return '';
  return c.slice(0, 3) + ' ' + c.slice(3);
}

/* TPS/TVH : 9 chiffres + RT + 4 chiffres. TVQ : 10 chiffres + TQ + 4 chiffres.
   Rend la forme normalisée, '' si vide, null si invalide. */
function caTaxNumber(s, kind) {
  const c = String(s || '').toUpperCase().replace(/[\s-]+/g, '');
  if (!c) return '';
  const m = kind === 'tvq' ? /^(\d{10})TQ(\d{4})$/.exec(c) : /^(\d{9})RT(\d{4})$/.exec(c);
  if (!m) return null;
  return m[1] + (kind === 'tvq' ? ' TQ' : ' RT') + m[2];
}

/* Société canadienne saisie par le signataire → { company, errors }.
   `today` (JJ/MM/AAAA) date la mention du dossier de preuve. */
function canadaCompany(c, today) {
  c = c || {};
  const errors = [];
  const province = CA_PROVINCES[c.province] ? c.province : '';
  if (!province) errors.push('Province ou territoire de l\'entreprise manquant.');
  const reg = caRegistry(province);
  const number = String(c.registryNumber || '').replace(/\D/g, '');
  if (number.length !== reg.digits) errors.push(reg.label === 'NEQ'
    ? 'Numéro d\'entreprise du Québec (NEQ) invalide : 10 chiffres attendus.'
    : 'Numéro d\'entreprise (NE) invalide : 9 chiffres attendus.');
  const gst = caTaxNumber(c.gstNumber, 'tps');
  const qst = caTaxNumber(c.qstNumber, 'tvq');
  if (gst === null) errors.push('Numéro de TPS/TVH invalide (format 123456789 RT0001).');
  if (qst === null) errors.push('Numéro de TVQ invalide (format 1234567890 TQ0001).');
  const a = c.address || {};
  const postal = caPostal(a.postalCode);
  const address = {
    line1: String(a.line1 || '').trim().slice(0, 140),
    line2: String(a.line2 || '').trim().slice(0, 140),
    postalCode: postal || String(a.postalCode || '').trim().slice(0, 10),
    city: String(a.city || '').trim().slice(0, 80),
    region: province,
    country: 'Canada',
  };
  if (!address.line1 || !postal || !address.city) errors.push('Adresse de l\'entreprise incomplète (voie, ville, code postal au format A1A 1A1).');
  const name = String(c.name || '').trim().slice(0, 160);
  const legalFormLabel = String(c.legalFormLabel || '').trim().slice(0, 80);
  if (!name) errors.push('Nom de l\'entreprise manquant.');
  if (!legalFormLabel) errors.push('Forme juridique manquante.');
  const taxes = [gst ? 'TPS/TVH ' + gst : '', qst ? 'TVQ ' + qst : ''].filter(Boolean).join(' · ');
  return {
    errors: errors,
    company: {
      country: 'CA', countryLabel: 'Canada', province: province, provinceLabel: CA_PROVINCES[province] || '',
      name: name, legalForm: '', legalFormLabel: legalFormLabel,
      registryLabel: reg.label, registryName: reg.name, registryNumber: number,
      siret: '', siren: '', vatNumber: '',
      gstNumber: gst || '', qstNumber: qst || '', taxNumbers: taxes,
      nafLabel: '', creationDate: '',
      address: address, addressSource: 'saisie',
      verification: 'Entreprise établie au Canada (' + (CA_PROVINCES[province] || 'province non précisée') + ') — ' + reg.label + ' ' + number
        + ' déclaré par le signataire le ' + (today || '') + ' ; aucun annuaire canadien n\'étant interrogeable automatiquement, l\'immatriculation n\'a pas été vérifiée en ligne et doit l\'être sur pièce (extrait du registre : ' + reg.name + ')',
    },
  };
}

/* « SIRET 943 098 707 00012 » ou « NEQ 1234567890 (Registraire des
   entreprises du Québec) » : l'immatriculation telle qu'elle s'imprime. */
function registrationLine(C) {
  C = C || {};
  if (C.country === 'CA') return C.registryNumber ? C.registryLabel + ' ' + C.registryNumber + ' (' + C.registryName + ')' : '';
  const s = String(C.siret || '');
  return s ? 'SIRET ' + (s.length === 14 ? s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6, 9) + ' ' + s.slice(9) : s) : '';
}

/* Numéros de taxes : TVA intracommunautaire en France, TPS/TVH et TVQ au
   Canada. */
function taxLine(C) {
  C = C || {};
  return C.country === 'CA' ? (C.taxNumbers || '') : (C.vatNumber || '');
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
  CA_PROVINCES, caRegistry, caPostal, caTaxNumber, canadaCompany, registrationLine, taxLine,
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

/* Code reçu par e-mail (demande « signataire hors de France ») : mêmes
   événements, libellés exacts. */
const EMAIL_EVENT_LABELS = {
  otp_envoye: 'Code envoyé par e-mail',
  otp_echec: 'Code incorrect',
  otp_verifie: 'Adresse e-mail vérifiée par code',
};
function eventLabel(e) {
  const d = e.data || {};
  if (d.canal === 'email' && EMAIL_EVENT_LABELS[e.type]) return EMAIL_EVENT_LABELS[e.type];
  return EVENT_LABELS[e.type] || e.type;
}

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
  if (e.type === 'otp_envoye' || e.type === 'otp_verifie') return d.tel || d.dest || '';
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
    { text: 'Ce dossier a été établi automatiquement par le serveur de SAS Ambitio Corp au moment de la signature. Il rassemble les éléments qui identifient le signataire, attestent de son consentement et garantissent l\'intégrité du document : vérification ' + (P.signers.some(function (x) { return x.otpCanal === 'email'; }) ? 'de l\'adresse e-mail' : 'du téléphone') + ' par code à usage unique, mentions saisies de sa main, journal horodaté de chacune de ses actions, empreintes cryptographiques et jetons d\'horodatage émis par une autorité tierce.', font: fonts.regular },
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

  /* Contrat de prestataire (closer, setter…) : Ambitio y est « la Société »
     et le signataire « le Prestataire ». */
  const prest = P.roleSignataire === 'prestataire';
  F.section('2', 'Parties');
  F.kv([
    [prest ? 'Société' : 'Prestataire', 'SAS Ambitio Corp — SIRET 943 098 707 00012 — 231B chemin de Mourre de Masque, 83440 Fayence — représentée par Emily UGHETTO, Présidente, et Adrien FRANCOIS, Directeur général'],
  ]);
  const C = P.company || {};
  const ca = C.country === 'CA';
  F.kv([
    [prest ? 'Prestataire' : 'Client', C.name],
    ['Forme juridique', C.legalFormLabel],
    ['Pays', ca ? 'Canada' + (C.provinceLabel ? ' (' + C.provinceLabel + ')' : '') : ''],
    ca ? ['Immatriculation', C.registryNumber ? C.registryLabel + ' ' + C.registryNumber + ' — ' + C.registryName : ''] : ['SIREN / SIRET', [C.siren, C.siret].filter(Boolean).join(' / ')],
    ca ? ['Numéros de taxes', C.taxNumbers || 'Aucun déclaré'] : ['N° TVA intracommunautaire', C.vatNumber],
    [ca ? 'Adresse' : 'Siège social', C.addressLine],
    ['Vérification au registre', C.verification],
  ]);

  P.signers.forEach(function (S, i) {
    F.section(String(3 + i), P.signers.length > 1 ? 'Signataire ' + (i + 1) : 'Signataire');
    F.kv([
      ['Nom', S.repName],
      ['Qualité', S.repQualite],
      ['Dirigeants publiés', S.dirigeantCheck],
      ['Adresse e-mail', S.email],
      [S.otpCanal === 'email' ? 'Téléphone (non vérifié)' : 'Téléphone vérifié', S.phone],
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
    const lbl = eventLabel(e) + (eventDetail(e) ? ' — ' + eventDetail(e) : '');
    const who = (e.signer === null || e.signer === undefined ? 'système' : 'S' + (e.signer + 1)) + ' · ' + (e.ip || '—') + ' · #' + e.seq + ' · ' + String(e.hash || '').slice(0, 10);
    row(parisStamp(e.at), lbl, who, e.type === 'signature_validee' ? fonts.bold : fonts.regular, e.type === 'signature_validee' ? GREEN : null);
  });

  F.section(String(4 + P.signers.length), 'Intégrité et horodatage');
  F.kv([
    ['Journal des actions', P.audit.length + ' entrées — chaîne d\'empreintes ' + (P.auditIntact ? 'vérifiée intacte' : 'NON INTÈGRE')],
    ['Tête de chaîne', 'SHA-256 ' + P.auditHead, { mono: true }],
    ['Horodatage du journal', P.auditTsa ? ('Jeton RFC 3161 émis par ' + P.auditTsa.authority + ' — ' + parisStamp(P.auditTsa.genTime) + ' (heure de Paris)') : 'Autorité d\'horodatage indisponible au moment de la signature — heure serveur seule'],
    ['Sceau du fichier', P.sealPlanned ? 'Ce fichier PDF est scellé par un horodatage RFC 3161 intégré (DocTimeStamp), visible dans le panneau « Signatures » d\'un lecteur PDF. Toute modification ultérieure du fichier invalide ce sceau.' : 'Non scellé : autorités d\'horodatage injoignables au moment de la signature. L\'empreinte du fichier est conservée par SAS Ambitio Corp.'],
  ]);

  F.box([
    { text: 'Cadre juridique', font: fonts.bold },
    { text: 'Signature électronique au sens de l\'article 1367 du Code civil et du règlement (UE) n° 910/2014 dit « eIDAS ». L\'écrit électronique a la même force probante que l\'écrit sur support papier, sous réserve que puisse être dûment identifiée la personne dont il émane et qu\'il soit établi et conservé dans des conditions de nature à en garantir l\'intégrité (article 1366 du Code civil). Le présent dossier, le journal chaîné des actions et les jetons d\'horodatage sont conservés par SAS Ambitio Corp pendant toute la durée de la relation contractuelle et au-delà, dans la limite des délais de prescription applicables.' },
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
    doc.setAuthor('SAS Ambitio Corp');
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
//   {{date_signature}} {{immatriculation}} {{numeros_taxes}} {{pays}}
//   {{province}}
//
// web.roleSignataire === 'prestataire' (14/10/2026) : contrat d'un
// prestataire d'Ambitio (closer, setter…). Le bloc de signatures dit alors
// « La SOCIÉTÉ — SAS Ambitio Corp » et « Le PRESTATAIRE — <signataire> » au
// lieu de « Le PRESTATAIRE — SAS Ambitio Corp » et « Le CLIENT ».
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
  immatriculation: 'immatriculation', numeros_taxes: 'numéros de taxes', pays: 'pays', province: 'province',
};

/* Libellés des deux parties du bloc de signatures. */
function partyTitles(web) {
  return web && web.roleSignataire === 'prestataire'
    ? { ambitio: 'La SOCIÉTÉ', signataire: 'Le PRESTATAIRE' }
    : { ambitio: 'Le PRESTATAIRE', signataire: 'Le CLIENT' };
}

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
      if (sec.signatures) blocks.push(web.roleSignataire === 'prestataire'
        ? 'p:Signatures de la SOCIÉTÉ et du PRESTATAIRE apposées en fin de document, précédées de la date et de la mention « Lu et approuvé ».'
        : 'p:Signatures du PRESTATAIRE et du CLIENT apposées en fin de document, précédées de la date et de la mention « Lu et approuvé ».');
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
  const T = partyTitles(C.ctx.web);
  /* AMBITIO */
  let y = top - SIZE;
  txt(T.ambitio, ML, y, F.b); y -= LH;
  txt('SAS Ambitio Corp', ML, y); y -= LH;
  txt('Représentée par Emily UGHETTO, Présidente,', ML, y); y -= LH;
  txt('et Adrien FRANCOIS, Directeur général', ML, y); y -= 6;
  if (cachet) {
    const w = Math.min(colW, 190);
    const h = w * cachet.height / cachet.width;
    page.drawPage(cachet, { x: ML - 6, y: y - h, width: w, height: h });
    y -= h;
  }
  const yLeft = y;
  /* SIGNATAIRE */
  const xR = ML + colW + 30;
  let yr = top - SIZE;
  txt(T.signataire, xR, yr, F.b); yr -= LH;
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
// cachet + signature ; page 1 : paraphe « AF »), polices retirées.
// 23/11/2026 — passage en SAS : l'image du cachet (titre « SARL AMBITIO CORP »)
// est remplacée par « SAS AMBITIO CORP », recomposée avec les lettres du cachet
// d'origine (même inclinaison, même emplacement) ; signature et paraphe inchangés.
// L'ancien cachet reste dans l'historique git. PDF de 2 pages, une zone par page :
//   page 0 — cachet + signature du PRESTATAIRE
//   page 1 — paraphe « AF » du PRESTATAIRE
// Utilisé par api/_contract-render.js (contrats générés depuis le texte).
// ============================================================================
module.exports = { pdfBase64: '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11ODowGmJIipp2IQlCvoeopCTxvK96msCx7ZNtU/0md9KuOPT52a9OSc09/uyb2w+OCw396z4vnBuf91cvF67+zbjTUje228e3ty38qWqpinZv92U87iRc/pHjv26Kn8ayMcr77yp5cb7m+YVLfGuVma02db44qPGu587gmZdUnlY1OKvnl7/sJ7Xtv7dmJwIbr8YmzxhhTpH1HjJ9L70t8Pbl/26Nz0Rvuhhte+vprW2jnra9+VU0bzFnVM7dRe/U0X0h99/8M9v7O9dfdtRw+/VHMqY/u679AeX/yP/zF516I5KzbS+qeN8/sNZh6R+nPu2H82Zf3u5i2LDz74RtYzg0vzioL9fueilaunzV+65dgLV74f+Hb7j4tRzF/uosv/3HfrJ322P0MzEEbP1FNyQETCJwKkiRq2L9vbWxVfbdZeklQPOrgxeIm/8sDa+OeJCyUOYXV8X3/vIZltp2YXuRXf5V+rvPbK6H2N416J4efiBknsTH46P61hasOUNQXixznNHke3j3O6l9hxabr40VhvetiM2IrEiOCUadCEn8/JIC4lEilFsTP4W/niUJ6n1+T85OdFyQT4o9I/ObKPj8P6DmOxC4pDMrJu8chgLyk+88Gfly9eyK2721s87pGHt5k+borJWbvr+Pii1dd29zvV/4xkiuH7oX97X/1s/eU9Ox7UmkoWvnHC9O2j8hOeEYe17feW+lZOnoceunLb7KsfqT+pOPTd+0868lYtfSH5489rJ6175Mv/dL/w2tXAXXfsGLQhf82izGuT13zw9dihr/61tc7XQZ0eMtn71aiWF5986vXYijtcH96erxsxdP7y0mev7jAuO3df8l9/9fuqj7l7AqnyXcFpyR/sPfvG5vee3v1V1sax+zqP/WCZ0BA3bPbLeWc+13e89VLepIF3fVpSfW1/rvWHh5/efXx71YttilvS375t773JbzpOvDR646ZeDbtevFR08au3tNPVms7MLz97PacXX89ByDDno1lMs3P3yQNftKZcz2JKYLG6fwtXJPPDhaBPiq63WPVz7KVO/AFnMCz+M5QMQmbjeUNGxhgeJFMgs0iW9/1b9BPrmZ+o/0U2enPefxr+tJ9bOS11T/kr5ieXHTo4YdDCV3e8tOHErvsb3q14N+Viff6o1++fU3XFTCneOj5+NZNfMK9++vHvkg7+6C9///Dm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UUUUUUUUUUUUUUUUUUUUmB1xyaTb7A/WlxRgelGB1wOKWkIB6iilooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooor//2QplbmRzdHJlYW0KZW5kb2JqCgoyMyAwIG9iago8PAovQml0c1BlckNvbXBvbmVudCA4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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//TlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9SVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//WlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9eVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//RlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9KVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//05UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//UlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9WVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//XlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9CVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0ZUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//SlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9OVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//1JUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//VlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9aVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//15UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//QlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9GVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0pUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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', cachet: 0, paraphe: 1 };

}};

/* ── ./api/_closeSms.js ── */
__defs["./api/_closeSms.js"] = { map: {"./_twilioClient":"./api/_twilioClient.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_closeSms.js — SMS « Nouvelle vente » à la direction, au VRAI close
// ----------------------------------------------------------------------------
// notifyCloseSms(leadId, source, opts?) → { envoye, raison, ... }  (ne lève jamais)
//
// RÈGLE MÉTIER (Adrien, 21/10/2026)
// ---------------------------------
// Un close, c'est un client qui a SIGNÉ son contrat ET dont le prélèvement est
// parti. Ni l'un sans l'autre. Le SMS part donc au moment où la deuxième
// condition se réalise, quelle qu'elle soit : d'où plusieurs points d'appel,
// tous serveur, et une seule fonction qui revérifie les deux conditions dans
// Firestore à chaque fois.
//   · api/sign-session.js        signature finale (le paiement était déjà là)
//   · api/gocardless-payment.js  prélèvement déclenché (cas le plus courant)
//   · api/gocardless-status.js   resynchronisation d'un abonnement
//   · api/gocardless-lookup.js   rattrapage d'un paiement créé hors fiche
//
// POURQUOI PLUS PAR MAKE
// ----------------------
// Jusqu'ici le SMS partait des scénarios Make « Elite Onboarding » et
// « Onboarding BP12 », à la signature seule, depuis l'expéditeur alphanumérique
// « adrienemily ». Le 21/10 (Nicolas PADIOU) le message est resté « sent » chez
// Twilio, jamais livré par l'opérateur. Ici : le numéro Twilio de l'équipe
// (smsFromNumber, +33939240397), dont les SMS de signature arrivent tous.
//
// CONFIG — _config/sales_close_sms
//   enabled : true pour activer (absent ou false → rien ne part)
//   phones  : ['+33688121402', …] destinataires, E.164
//   since   : 'AAAA-MM-JJ' — seules les signatures à partir de cette date
//             comptent. Sans ce garde-fou, la resynchronisation d'un vieux
//             paiement (gocardless-status / lookup) enverrait un SMS pour un
//             client signé il y a des mois.
//
// IDEMPOTENCE : un seul SMS par lead. La trace `closeSms` est posée sur la
// fiche dans une transaction AVANT l'envoi ; un close ré-enregistré, un
// double webhook ou deux points d'appel simultanés ne renvoient rien. Un
// envoi en échec (status 'echec') est retenté au prochain déclencheur.
//
// Bac à sable : sandbox-db n'a pas ce document de config → retour immédiat,
// rien ne sort.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { getTwilioCreds, getTwilioClient } = require('./_twilioClient');

const PAID = { active: 1, completed: 1 };

function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/* Montants : espaces simples, jamais l'espace fine de toLocaleString (les
   SMS la rendent mal sur certains téléphones). */
function euros(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
}

function sigSignedMs(r) {
  return ms(r.signedAt) || ms(r.signedAtIso) || ms(r.updatedAt) || ms(r.createdAt);
}

async function memberNames() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const out = {};
    list.forEach(function (m) {
      if (m && m.slug) out[m.slug] = m.shortName || m.displayName || m.fullName || m.slug;
    });
    return out;
  } catch (e) { return {}; }
}

/* Offre lisible : le choix du pilote de closing s'il existe, sinon le
   close enregistré, sinon le nom du modèle de contrat. */
function offreDe(lead, sig) {
  const cp = (lead.closePilot && lead.closePilot.choix) || {};
  if (cp.offre === 'Elite') return 'Elite';
  if (cp.offre === 'Business') return 'Business';
  const cd = lead.closedData || {};
  if (/elite/i.test(cd.offre || '')) return 'Elite';
  if (/bp|business/i.test(cd.offre || '')) return 'Business';
  const t = String(sig.templateName || '');
  if (/elite|\bep ?\d/i.test(t)) return 'Elite';
  if (/business|\bbp ?\d/i.test(t)) return 'Business';
  return t || 'Contrat';
}

function montantDe(pay) {
  const n = Number(pay.installmentsCount) || 1;
  if (pay.type === 'installments' && n > 1) return n + ' × ' + euros(pay.installmentAmount);
  return 'PIF ' + euros(pay.totalAmount);
}

function buildMessage(lead, sig, pay, names) {
  const cd = lead.closedData || {};
  const nom = String(lead.nom || sig.clientName || 'Client').trim();
  const parts = [montantDe(pay)];
  if (cd.collecte) parts.push('encaissé ' + euros(cd.collecte));
  const closer = (cd.closerSlug && names[cd.closerSlug]) || pay.closerName
    || (lead.closePilot && lead.closePilot.byName) || '';
  const setter = (cd.setterSlug && names[cd.setterSlug]) || '';
  if (closer) parts.push('closer ' + closer);
  if (setter) parts.push('setter ' + setter);
  return '🏆 Nouvelle vente ' + offreDe(lead, sig) + ' — ' + nom + '\n' + parts.join(' · ');
}

/* opts.dryRun : calcule tout, n'écrit rien, n'envoie rien (renvoie le texte).
   opts.phones : destinataires imposés (dry-run avant création de la config). */
async function notifyCloseSms(leadId, source, opts) {
  opts = opts || {};
  try {
    if (!leadId) return { envoye: false, raison: 'sans_lead' };

    const cfgSnap = await db.collection('_config').doc('sales_close_sms').get();
    const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
    if (cfg.enabled !== true && !opts.dryRun) return { envoye: false, raison: 'desactive' };
    const phones = (Array.isArray(opts.phones) ? opts.phones : (Array.isArray(cfg.phones) ? cfg.phones : [])).map(function (p) { return String(p || '').trim(); })
      .filter(function (p) { return /^\+\d{8,15}$/.test(p); });
    if (!phones.length) return { envoye: false, raison: 'aucun_destinataire' };
    const sinceMs = cfg.since ? ms(cfg.since) : 0;

    const leadRef = db.collection('leads').doc(leadId);
    const [leadSnap, sigSnap, paySnap] = await Promise.all([
      leadRef.get(),
      db.collection('signature_requests').where('leadId', '==', leadId).get(),
      db.collection('payments').where('leadId', '==', leadId).get(),
    ]);
    if (!leadSnap.exists) return { envoye: false, raison: 'lead_introuvable' };
    const lead = leadSnap.data() || {};
    if (lead._merged) return { envoye: false, raison: 'lead_fusionne' };
    if (lead.closeSms && lead.closeSms.status !== 'echec') return { envoye: false, raison: 'deja_envoye' };

    const sigs = sigSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (r) { return r.status === 'signed'; })
      .sort(function (a, b) { return sigSignedMs(a) - sigSignedMs(b); });
    const sig = sigs[sigs.length - 1];
    if (!sig) return { envoye: false, raison: 'pas_signe' };
    if (sinceMs && sigSignedMs(sig) < sinceMs) return { envoye: false, raison: 'signature_anterieure' };

    const pays = paySnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (p) { return PAID[p.status]; })
      .sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); });
    const pay = pays[pays.length - 1];
    if (!pay) return { envoye: false, raison: 'pas_paye' };

    const body = buildMessage(lead, sig, pay, await memberNames());
    if (opts.dryRun) return { envoye: false, raison: 'dry_run', body: body, to: phones, signatureId: sig.id, paymentId: pay.id };

    /* Verrou : la trace est posée AVANT l'envoi, dans une transaction —
       deux déclencheurs simultanés ne peuvent pas envoyer chacun le leur. */
    const locked = await db.runTransaction(async function (tx) {
      const cur = await tx.get(leadRef);
      const cs = cur.exists ? (cur.data() || {}).closeSms : null;
      if (cs && cs.status !== 'echec') return false;
      tx.set(leadRef, { closeSms: {
        status: 'envoi', source: String(source || ''), signatureId: sig.id, paymentId: pay.id,
        to: phones, body: body, at: admin.firestore.FieldValue.serverTimestamp(),
      } }, { merge: true });
      return true;
    });
    if (!locked) return { envoye: false, raison: 'deja_envoye' };

    const creds = await getTwilioCreds();
    const from = creds.smsFromNumber || creds.smsFrom || null;
    let sids = [], erreurs = [];
    if (!from) erreurs.push('smsFromNumber manquant dans _config/telco_credentials.twilio');
    else {
      const client = await getTwilioClient();
      for (let k = 0; k < phones.length; k++) {
        try {
          const m = await client.messages.create({ from: from, to: phones[k], body: body });
          sids.push(m.sid);
        } catch (e) { erreurs.push(phones[k] + ' : ' + ((e && e.message) || 'erreur')); }
      }
    }

    const ok = sids.length > 0;
    await leadRef.set({ closeSms: {
      status: ok ? 'envoye' : 'echec', from: from || null, sids: sids,
      erreurs: erreurs.length ? erreurs : admin.firestore.FieldValue.delete(),
      doneAt: admin.firestore.FieldValue.serverTimestamp(),
    } }, { merge: true });
    if (erreurs.length) console.warn('[close-sms]', leadId, erreurs.join(' | '));
    else console.log('[close-sms] ✅', leadId, source, sids.join(','));
    return { envoye: ok, raison: ok ? 'ok' : 'echec', sids: sids, erreurs: erreurs };
  } catch (e) {
    console.error('[close-sms]', leadId, source, e && e.message);
    return { envoye: false, raison: 'erreur', erreur: e && e.message };
  }
}

module.exports = { notifyCloseSms, buildMessage };

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

/* ── ./api/signature-otp.js ── */
__defs["./api/signature-otp.js"] = { map: {"./_twilioClient":"./api/_twilioClient.js","./_parseBody":"./api/_parseBody.js","./_sign-core":"./api/_sign-core.js"}, shims: {"crypto": function () { return __crypto; }, "./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }, "./_billing-gmail": function () { return __shim['./_billing-gmail']; }}, fn: function (module, exports, require) {
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
// CANAL E-MAIL (14/10/2026) — une demande créée avec otpChannel:'email'
// (sales-signatures, « signataire hors de France ») reçoit son code par
// e-mail, à l'adresse du signataire enregistrée sur la demande. Raison :
// Twilio n'achemine pas de SMS vers le Canada ni les États-Unis depuis notre
// numéro français. Mêmes plafonds, même durée de validité, même journal ; le
// dossier de preuve dit « envoyé par e-mail » au lieu de « par SMS ».
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
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');
const core = require('./_sign-core');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 8;

/* Comptes d'envoi autorisés — mêmes que api/signature-send-link.js. */
const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

/* Meme normalisation que api/twilio-sms-send.js (E.164, France par defaut). */
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  /* Amérique du Nord saisie sans « + » : 1 + 10 chiffres. */
  if (/^1\d{10}$/.test(cleaned)) return '+' + cleaned;
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

    // ─── ENVOI PAR E-MAIL ──────────────────────────────────────────────────
    if (action === 'send' && core.otpChannel(R) === 'email') {
      const dest = String(found.signer.email || R.clientEmail || '').trim();
      if (dest.indexOf('@') < 1) {
        res.status(400).json({ error: "Aucune adresse e-mail valide sur cette demande. Contactez votre conseiller." });
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
      /* Code écrit AVANT l'envoi, comme pour le SMS. */
      await otpRef.set({
        code,
        signerIndex,
        canal: 'email',
        email: dest,
        phone: null,
        sends,
        attempts: 0,
        expiresAt: Date.now() + OTP_TTL_MS,
        livraison: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      try {
        await sendGmailWithAttachment({
          tokenAccount: ACCOUNTS[R.sendAccount] ? R.sendAccount : 'contact',
          fromName: 'Ambitio',
          to: [dest],
          subject: 'Votre code de signature : ' + code,
          bodyText: [
            'Bonjour,',
            '',
            'Voici votre code de vérification pour signer le document « ' + (R.templateName || 'Contrat') + ' » :',
            '',
            '    ' + code,
            '',
            'Il est valable 10 minutes. Ne le communiquez à personne : il prouve que c\'est bien vous qui signez.',
            '',
            'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.',
            '',
            'L\'équipe Ambitio',
          ].join('\n'),
        });
      } catch (mailErr) {
        console.error('[signature-otp] e-mail:', mailErr && mailErr.message);
        res.status(502).json({ error: "L'envoi de l'e-mail a échoué. Réessayez dans un instant." });
        return;
      }
      /* Gmail a accepté le message : pas de rappel de remise comme chez
         Twilio, la page n'a donc rien à surveiller. */
      await otpRef.set({ livraison: { statut: 'delivered', canal: 'email', at: Date.now() } }, { merge: true }).catch(function () {});
      await core.appendAudit(reqRef, [{ type: 'otp_envoye', signer: signerIndex, data: { canal: 'email', dest: core.maskEmail(dest), envoi: sends } }], info)
        .catch(function (e) { console.error('[signature-otp] journal:', e && e.message); });
      await core.setProgress(reqRef, signerIndex, { derniere: 'Code e-mail demandé', enLigne: true }, info);
      res.status(200).json({ ok: true, canal: 'email', phoneHint: core.maskEmail(dest), destHint: core.maskEmail(dest) });
      return;
    }

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
      await core.appendAudit(reqRef, [{ type: 'otp_echec', signer: signerIndex, data: O.canal === 'email' ? { canal: 'email', tentative: attempts } : { tentative: attempts } }], info).catch(function () {});
      res.status(400).json({ error: "Code incorrect." });
      return;
    }

    /* otpVerified alimente le certificat de signature (sign-certificate.html) :
       on le pose sur la demande, comme le faisait l'ancien traitement. */
    const parEmail = O.canal === 'email';
    const by = {};
    by[String(signerIndex)] = { atMs: Date.now(), at: new Date().toISOString(), canal: parEmail ? 'email' : 'sms', phone: O.phone || null, email: parEmail ? (O.email || null) : null, ip: info.ip };
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
    await core.appendAudit(reqRef, [{ type: 'otp_verifie', signer: signerIndex, data: parEmail ? { canal: 'email', dest: core.maskEmail(O.email) } : { tel: phoneHint(O.phone) } }], info);
    await core.setProgress(reqRef, signerIndex, { etape: 2, derniere: parEmail ? 'Adresse e-mail vérifiée par code' : 'Téléphone vérifié par code SMS', enLigne: true }, info);

    /* Code consomme : il ne doit plus pouvoir servir. */
    await otpRef.delete().catch((e) => console.error('[signature-otp] purge:', e && e.message));

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[signature-otp]', e && e.stack ? e.stack : e);
    res.status(500).json({ error: "Erreur serveur. Réessayez." });
  }
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
  /* Amérique du Nord saisie sans « + » : 1 + 10 chiffres. */
  if (/^1\d{10}$/.test(cleaned)) return '+' + cleaned;
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
    /* Demande « signataire hors de France » (otpChannel 'email', 14/10/2026) :
       pas de SMS. Twilio n'achemine pas vers le Canada ni les États-Unis
       depuis notre numéro français ; le lien part par e-mail, le code aussi. */
    const smsOff = R.otpChannel === 'email';
    const to = smsOff ? null : normalizePhone(S.phone);
    const sms = { envoye: false, dest: to || null, sid: null, erreur: null, ignore: smsOff };
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
    } else if (!smsOff) {
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
  // 0. Appel INTERNE (même processus) — api/_internalCall.js. Une tâche
  //    planifiée réutilise une route existante sans jeton navigateur : elle
  //    pose req._internalAuth sur un objet requête qu'elle construit elle-même.
  //    Une requête réseau ne peut pas porter cette propriété JavaScript (seuls
  //    en-têtes, corps et URL viennent de l'extérieur) : pas de contournement
  //    possible depuis Internet. uid null = tâche automatique pour _ai.js.
  if (req && req._internalAuth && typeof req._internalAuth === 'object' && req._internalAuth.internal === true) {
    return req._internalAuth;
  }

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

/**
 * LECTEUR FUNNEL (19/11/2026) — rôle `funnel_viewer` : compte en lecture
 * seule du module Stats funnel (sales-funnel.html), créé pour la média
 * buyeuse. Autorise les admins ET ce rôle, pour les seules routes de LECTURE
 * du module (statut / journal de l'API Conversions, dry-run du cron, coût de
 * setting agrégé). Un compte au statut « disabled » ou dont l'échéance
 * (users/{uid}.expiresAt, liens d'accès api/funnel-acces.js) est passée est
 * refusé.
 * Pose auth.readOnly = true pour le lecteur : l'endpoint refuse alors toute
 * écriture.
 */
const FUNNEL_VIEWER_ROLE = 'funnel_viewer';
async function requireFunnelReader(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401/403

  if (auth.role === 'admin') { auth.readOnly = false; return auth; }
  /* Lien d'accès (api/funnel-acces.js) : échéance portée par users/{uid}. */
  const exp = auth.userData.expiresAt;
  const expMs = exp && typeof exp.toMillis === 'function' ? exp.toMillis() : (exp ? Date.parse(exp) : null);
  const notExpired = !expMs || expMs > Date.now();
  if (auth.role === FUNNEL_VIEWER_ROLE && auth.userData.status !== 'disabled' && notExpired) {
    auth.readOnly = true;
    return auth;
  }
  res.status(403).json({ error: 'Accès Stats funnel requis' });
  return null;
}

/**
 * Vrai si le compte agit comme coach : rôle `coach`, ou double casquette
 * (`users/{uid}.alsoCoach === true`, ex. la CSM qui coache aussi — 23/11/2026).
 * Le rôle, lui, ne change pas : tous les autres contrôles restent sur auth.role.
 */
function estCoach(auth) {
  return !!auth && (auth.role === 'coach' || !!(auth.userData && auth.userData.alsoCoach === true));
}

module.exports = {
  estCoach,
  verifyFirebaseAuth,
  requireAuth,
  requireAdmin,
  requirePaymentsTrigger,
  requireFunnelReader,
  FUNNEL_VIEWER_ROLE,
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

    /* Jamais de retour en arrière (12/10/2026) : finalize tourne en
       tâche de fond (retour du flow, surveillance toutes les 10 s) et
       pouvait réécrire 'mandate_active' — voire 'pending_mandate' — sur un
       paiement dont le prélèvement venait d'être déclenché. Le statut
       n'avance que depuis draft / pending_mandate / mandate_failed, relu
       dans la transaction. Les identifiants GC sont toujours synchronisés. */
    await db.runTransaction(async (t) => {
      const cur = (await t.get(paySnap.ref)).data() || {};
      const movable = !cur.status || ['draft', 'pending_mandate', 'mandate_failed'].includes(cur.status);
      if (!movable || cur.gcPaymentId || cur.gcSubscriptionId) delete update.status;
      else if (update.status !== 'mandate_active' && cur.gcMandateId) delete update.status;
      t.update(paySnap.ref, update);
    });
    if (!update.status) update.status = (await paySnap.ref.get()).data().status;

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
__defs["./api/gocardless-payment.js"] = { map: {"./_verifyFirebaseAuth":"./api/_verifyFirebaseAuth.js","./_parseBody":"./api/_parseBody.js","./_closeSms":"./api/_closeSms.js","./_accesPaiement":"./api/_accesPaiement.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
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
const { notifyCloseSms } = require('./_closeSms');
const { ouvrirSiPaye } = require('./_accesPaiement');

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
    /* Signé + prélèvement parti = close : SMS « Nouvelle vente » (21/10/2026).
       Avant res.json — Vercel coupe la fonction dès la réponse. Ne lève jamais. */
    await notifyCloseSms(pay.leadId, 'paiement');
    /* L'Academy s'ouvre au paiement (30/10/2026). Ne lève jamais. */
    await ouvrirSiPaye(pay.leadId, 'paiement');
    res.json({ gcId, gcType });

  } catch (e) {
    console.error('[gocardless-payment]', e.message);
    res.status(500).json({ error: e.message });
  }
};

}};

/* ── ./api/_accesPaiement.js ── */
__defs["./api/_accesPaiement.js"] = { map: {"../demarrage-core.js":"./demarrage-core.js"}, shims: {"./_firebaseAdmin": function () { return __shim['./_firebaseAdmin']; }}, fn: function (module, exports, require) {
// ============================================================================
// api/_accesPaiement.js — L'ACADEMY S'OUVRE AU PAIEMENT (30/10/2026, exclu du routing)
// ----------------------------------------------------------------------------
// Décision Adrien : un nouveau client signe, mais son espace Academy reste
// fermé jusqu'au paiement validé — « validé » = prélèvement déclenché
// (demarrage-core.js, paiementOk). Le closer le déclenche pendant l'appel :
// l'accès s'ouvre aussitôt (api/gocardless-payment.js → ouvrirSiPaye). Le cron
// horaire rattrape les autres chemins.
//
// PREMIER PRÉLÈVEMENT REJETÉ : l'espace se referme. Les rejets arrivent par la
// Cloud Function onWebhookInbox (lastPaymentFailure) : c'est le cron qui les lit,
// aucun déploiement de functions n'est nécessaire. Les prélèvements suivants
// restent de simples alertes, comme avant.
//
// État sur leads/{id}.accesPaiement :
//   { statut:'verrouille'|'ouvert', depuis, ouvertLe, manuel, par, rappel, historique }
// Côté Academy : users/{email}.paiementAttendu (bridge/manage-access, action
// « paiement »), indépendant de la date du démarrage différé.
//
// Chargé par api/gocardless-payment.js, donc aussi par le bac à sable : aucune
// dépendance à l'e-mail ou à WhatsApp ici, et ouvrirSiPaye ne lève jamais.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const Core = require('../demarrage-core.js');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const FENETRE_REJET_JOURS = 45;

function lower(s) { return String(s || '').trim().toLowerCase(); }

async function contratsDu(leadId, L) {
  const col = db.collection('signature_requests');
  const vus = {}, out = [];
  function add(snap) { snap.forEach(function (d) { if (!vus[d.id]) { vus[d.id] = 1; out.push(Object.assign({ _id: d.id }, d.data() || {})); } }); }
  add(await col.where('leadId', '==', leadId).get());
  const email = lower(L.email);
  if (email) add(await col.where('clientEmail', '==', email).get());
  return out;
}

async function paiementsDu(leadId, L) {
  const col = db.collection('payments');
  const vus = {}, out = [];
  function add(snap) { snap.forEach(function (d) { if (!vus[d.id]) { vus[d.id] = 1; out.push(Object.assign({ id: d.id }, d.data() || {})); } }); }
  add(await col.where('leadId', '==', leadId).get());
  if (L.personId) add(await col.where('personId', '==', L.personId).get());
  const email = lower(L.email);
  if (email) add(await col.where('leadEmail', '==', email).get());
  return out;
}

/* Le compte vit sous l'e-mail du SIGNATAIRE, qui peut différer de celui du lead. */
function emailsAcademy(L, contrats, ficheEmail) {
  const vus = {}, out = [];
  function add(e) { e = lower(e); if (e && !vus[e]) { vus[e] = 1; out.push(e); } }
  contrats.filter(function (c) { return c.status === 'signed'; }).forEach(function (c) {
    add(Array.isArray(c.signers) && c.signers[0] && c.signers[0].email);
    add(c.clientEmail);
  });
  add(L.email);
  add(ficheEmail);
  return out;
}

async function pontAcademy(emails, payload) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) return { ok: false, error: 'bridge_not_configured' };
  let trouve = false;
  for (let i = 0; i < emails.length; i++) {
    let j = null;
    try {
      const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
        body: JSON.stringify(Object.assign({ email: emails[i] }, payload)),
      });
      j = await r.json().catch(function () { return null; });
    } catch (e) { j = null; }
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || 'academy_unreachable' };
    if (j.found) trouve = true;
  }
  return { ok: true, trouve: trouve };
}

function avecHistorique(ap, prev, action, par) {
  const h = ((prev && prev.historique) || []).slice(-20);
  h.push({ at: Date.now(), par: par, action: action });
  ap.historique = h;
  return ap;
}

/* Ferme l'espace en attendant le paiement. Academy d'abord : si le pont
   échoue, rien n'est enregistré et on le dit. */
async function verrouiller(lead, par) {
  const L = lead.data;
  const contrats = await contratsDu(lead.id, L);
  const p = await pontAcademy(emailsAcademy(L, contrats), { action: 'paiement', attendu: true });
  if (!p.ok) return { ok: false, status: 502, error: p.error };
  const ap = avecHistorique({ statut: 'verrouille', depuis: Date.now(), ouvertLe: null, manuel: false, par: par, rappel: null }, L.accesPaiement, 'verrouille', par);
  await db.collection('leads').doc(lead.id).update({ accesPaiement: ap });
  return { ok: true, accesPaiement: ap, academy: p.trouve ? 'fermee' : 'pas_de_compte' };
}

/* Rouvre l'espace. `manuel` : décision d'un admin (virement hors GoCardless…) :
   le cron ne le refermera pas sur un rejet. */
async function ouvrir(lead, par, manuel) {
  const L = lead.data;
  const contrats = await contratsDu(lead.id, L);
  const p = await pontAcademy(emailsAcademy(L, contrats), { action: 'paiement', attendu: false });
  if (!p.ok) return { ok: false, status: 502, error: p.error };
  const ap = avecHistorique({ statut: 'ouvert', depuis: (L.accesPaiement && L.accesPaiement.depuis) || null, ouvertLe: Date.now(), manuel: !!manuel, par: par, rappel: null }, L.accesPaiement, manuel ? 'ouvert_manuel' : 'ouvert', par);
  await db.collection('leads').doc(lead.id).update({ accesPaiement: ap });
  return { ok: true, accesPaiement: ap };
}

/* Appelé au déclenchement du prélèvement et à chaque passage du cron. Ne lève
   jamais : un paiement ne doit pas échouer parce que l'Academy ne répond pas,
   le cron retentera. */
async function ouvrirSiPaye(leadId, par) {
  try {
    if (!leadId) return { ok: false, raison: 'pas_de_lead' };
    const s = await db.collection('leads').doc(leadId).get();
    if (!s.exists) return { ok: false, raison: 'lead_introuvable' };
    const L = s.data() || {};
    if (!L.accesPaiement || L.accesPaiement.statut !== 'verrouille') return { ok: false, raison: 'pas_verrouille' };
    const paiements = await paiementsDu(leadId, L);
    if (Core.premierRejet(paiements) || !paiements.some(function (p) { return Core.paiementOk(p); })) return { ok: false, raison: 'pas_paye' };
    return await ouvrir({ id: leadId, data: L }, par, false);
  } catch (e) {
    console.warn('[acces-paiement] ouverture', leadId, e && e.message);
    return { ok: false, raison: 'erreur' };
  }
}

/* Le passage du cron : ouvre ce qui est payé, referme ce qui vient d'être
   rejeté, signale ce qui attend depuis 3 jours. `alerter(sujet, lignes)` vient
   de api/_demarrage.js. */
async function passageAcces(alerter) {
  const bilan = { ouverts: 0, refermes: 0, signales: 0 };
  const ferme = await db.collection('leads').where('accesPaiement.statut', '==', 'verrouille').get();
  for (const d of ferme.docs) {
    const L = d.data() || {}, ap = L.accesPaiement || {};
    if (L._merged === true) continue;
    const r = await ouvrirSiPaye(d.id, 'cron-acces');
    if (r.ok) { bilan.ouverts++; continue; }
    if (r.raison === 'pas_paye' && !ap.rappel && Date.now() - Number(ap.depuis || 0) > 3 * 86400000) {
      await alerter('🔒 ' + (L.nom || L.email || 'Client') + ' : signé, pas encore payé', [
        '<b>' + (L.nom || L.email || 'Client') + '</b> a signé mais aucun prélèvement n\'est parti : son accès Academy reste fermé.',
        'Il s\'ouvrira tout seul dès que le prélèvement sera déclenché.',
      ]);
      await d.ref.update({ 'accesPaiement.rappel': Date.now() });
      bilan.signales++;
    }
  }
  const ouverts = await db.collection('leads').where('accesPaiement.statut', '==', 'ouvert').get();
  for (const d of ouverts.docs) {
    const L = d.data() || {}, ap = L.accesPaiement || {};
    if (L._merged === true || ap.manuel || Date.now() - Number(ap.ouvertLe || 0) > FENETRE_REJET_JOURS * 86400000) continue;
    try {
      const paiements = await paiementsDu(d.id, L);
      if (!Core.premierRejet(paiements)) continue;
      const r = await verrouiller({ id: d.id, data: L }, 'cron-acces');
      if (!r.ok) { console.warn('[acces-paiement] refermeture', d.id, r.error); continue; }
      await alerter('⛔ Premier prélèvement rejeté : ' + (L.nom || L.email || 'client'), [
        '<b>' + (L.nom || L.email || 'Client') + '</b> : le premier prélèvement a été rejeté, son accès Academy vient d\'être refermé.',
        'Il se rouvrira dès qu\'un nouveau prélèvement sera déclenché.',
      ]);
      bilan.refermes++;
    } catch (e) { console.warn('[acces-paiement] rejet', d.id, e && e.message); }
  }
  return bilan;
}

module.exports = { contratsDu, paiementsDu, emailsAcademy, pontAcademy, verrouiller, ouvrir, ouvrirSiPaye, passageAcces };

}};

/* ── ./demarrage-core.js ── */
__defs["./demarrage-core.js"] = { map: {}, shims: {}, fn: function (module, exports, require) {
// ============================================================================
// demarrage-core.js — DÉMARRAGE DIFFÉRÉ D'UN CLIENT (30/10/2026)
// ----------------------------------------------------------------------------
// Le client signe et paie aujourd'hui, mais ne commence que plus tard (« je
// n'attaque qu'en janvier »). Partagé navigateur ↔ serveur, comme bp-credits.js.
//
// LA RÈGLE D'ADRIEN : on peut décaler le DÉMARRAGE, jamais le PAIEMENT. Date
// de close, commissions, prélèvements et factures ne bougent pas. Le contrat
// doit être signé et le premier prélèvement déclenché (ou le paiement intégral
// fait) : « payé » se lit ici, à un seul endroit (paiementOk).
//
// Forme de leads/{id}.demarrageDiffere (source de vérité) :
//   { statut:'attente'|'demarre'|'annule', date:'AAAA-MM-JJ' (date prévue),
//     demarreLe:'AAAA-MM-JJ' (jour réel), historique:[{at,par,action,date}],
//     rappels:{ j7, bloque } }
// Copie résumée sur clients/{id} et persons/{id} (resume) : coaching.html
// réécrit la fiche entière depuis une copie locale, la copie peut donc être en
// retard. Tout ce qui décide côté serveur repasse par le lead.
//
// AUCUNE dépendance : ni Firebase, ni DOM. ES5 strict.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DemarrageCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RAPPEL_JOURS = 7;      // premier rappel et prévenance du coach
  var MAX_JOURS = 366;       // au-delà, c'est une faute de frappe
  /* GoCardless repousse le premier prélèvement d'un NOUVEAU mandat au préavis
     SEPA (api/gocardless-payment.js réécrit startDate) : quelques jours ne
     sont pas un décalage de paiement. Au-delà, si. */
  var TOLERANCE_SEPA_JOURS = 10;

  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function aujourdhui(d) {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  }
  function joursEntre(a, b) { // b - a, en jours calendaires
    if (!isDate(a) || !isDate(b)) return null;
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function fr(ymd) { return isDate(ymd) ? ymd.split('-').reverse().join('/') : ''; }

  function enAttente(dd) { return !!(dd && dd.statut === 'attente' && isDate(dd.date)); }
  /* Le jour qui compte pour les jalons, la fin de programme et la santé. */
  function debut(dd) {
    if (!dd) return '';
    if (dd.statut === 'attente') return isDate(dd.date) ? dd.date : '';
    if (dd.statut === 'demarre') return isDate(dd.demarreLe) ? dd.demarreLe : (isDate(dd.date) ? dd.date : '');
    return '';
  }
  function dateValable(date, today) {
    var j = joursEntre(today || aujourdhui(), date);
    return j !== null && j > 0 && j <= MAX_JOURS;
  }
  function resume(dd) {
    if (!dd) return null;
    return { statut: dd.statut || '', date: dd.date || '', demarreLe: dd.demarreLe || '' };
  }
  function badge(dd) { return enAttente(dd) ? '⏳ Démarre le ' + fr(dd.date) : ''; }

  function prelevementDecale(p, today) {
    var d = String((p && p.startDate) || '').slice(0, 10);
    var j = isDate(d) ? joursEntre(today || aujourdhui(), d) : null;
    return j !== null && j > TOLERANCE_SEPA_JOURS;
  }
  /* « Payé » (décision Adrien 30/10/2026) : premier prélèvement déclenché ou
     paiement intégral fait. Un mandat seul ne suffit pas, et un prélèvement
     programmé plus tard non plus : le paiement ne se décale jamais. */
  function paiementOk(p, today) {
    if (!p || (p.status !== 'active' && p.status !== 'completed')) return false;
    return !prelevementDecale(p, today);
  }
  function msDe(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v.toMillis) return v.toMillis();
    if (v._seconds) return v._seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  /* Le PREMIER prélèvement a-t-il été rejeté ? On regarde le dernier paiement
     réellement parti chez GoCardless : un paiement refait après un rejet
     efface le rejet. Dès qu'un prélèvement est encaissé, ce n'est plus le
     premier : on ne referme plus rien. */
  function premierRejet(paiements) {
    var liste = paiements || [];
    if (liste.some(function (p) { return p && (Number(p.paidCount) > 0 || Number(p.paidAmount) > 0); })) return false;
    var partis = liste.filter(function (p) { return p && (p.gcPaymentId || p.gcSubscriptionId); })
      .sort(function (a, b) { return msDe(b.createdAt) - msDe(a.createdAt); });
    var d = partis[0];
    if (!d) return false;
    return !!d.lastPaymentFailure || d.status === 'failed' || d.status === 'mandate_failed' || d.status === 'cancelled';
  }
  function conditions(contrats, paiements, today) {
    var signe = (contrats || []).some(function (c) { return c && c.status === 'signed'; });
    var paye = (paiements || []).some(function (p) { return paiementOk(p, today); });
    var manque = [];
    if (!signe) manque.push('Contrat non signé');
    if (!paye) manque.push('Paiement non déclenché');
    return { signe: signe, paye: paye, ok: signe && paye, manque: manque };
  }

  return {
    RAPPEL_JOURS: RAPPEL_JOURS, MAX_JOURS: MAX_JOURS,
    isDate: isDate, aujourdhui: aujourdhui, joursEntre: joursEntre, fr: fr,
    enAttente: enAttente, debut: debut, dateValable: dateValable, resume: resume, badge: badge,
    paiementOk: paiementOk, prelevementDecale: prelevementDecale, premierRejet: premierRejet, conditions: conditions, msDe: msDe
  };
}));

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
      const tlDate = d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
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
        const tlDate = d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
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
  '/api/booking-check-coaching-quota': function () { return [200, { allowed: true }]; },
  '/api/client-demarrage': function () { return [200, { ok: true, leadId: null }]; }
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
