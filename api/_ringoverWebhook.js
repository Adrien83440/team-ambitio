// ============================================================================
// api/_ringoverWebhook.js — helpers communs aux webhooks Ringover
// (ringover-call-status, ringover-recording-ready, ringover-aftercall)
// ----------------------------------------------------------------------------
// Créé le 14/09/2026 avec le passage de Ringover aux « webhooks 2.0 » :
//
// 1. readRingoverPayload(req) — parse le corps SANS perdre les grands entiers.
//    Les call_id Ringover sont des uint64 (19 chiffres) : au-delà de
//    Number.MAX_SAFE_INTEGER, JSON.parse les arrondit et l'id obtenu ne
//    correspond plus à rien (ni doc call_logs, ni leg de dialer_campaigns).
//    On lit donc le flux brut et on met les grands entiers entre guillemets
//    avant JSON.parse — même garde que dans _ringoverClient.js. Si le flux
//    n'est plus lisible (body déjà consommé en amont), on retombe sur
//    req.body : mieux que rien, mais précision non garantie.
//
// 2. verifyRingoverJwt / checkRingoverAuth — les webhooks 2.0 signent chaque
//    livraison d'un JWT HS256/384/512 (Authorization: Bearer eyJ...) dont le
//    secret est la clé de webhook. L'ancienne comparaison directe de la clé
//    (ou de sa forme base64) ne matche donc plus jamais. On accepte les deux
//    générations de format.
//
// 3. pickCallId(payload) — résout l'id d'appel canonique. Webhooks 2.0 :
//    data.id est un UUID de ressource, le vrai id est data.call_id.
//    Ancien format : data.id était l'id d'appel. Priorité : data.call_id,
//    puis call_id racine, puis data.id.
// ============================================================================

const crypto = require('crypto');

const BIGINT_GUARD = /"(call_id|id|channel_id|conversation_id|message_id|cdr_id|user_id|team_id)"\s*:\s*(\d{15,})/g;

/* Lit le flux brut avec garde-fou : si le stream a déjà été consommé, 'end'
   ne sera jamais émis — le timeout rend la main pour retomber sur req.body. */
function readRawBody(req, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const t = setTimeout(() => finish(null), timeoutMs || 2000);
    try {
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => { clearTimeout(t); finish(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { clearTimeout(t); finish(null); });
    } catch (_) {
      clearTimeout(t);
      finish(null);
    }
  });
}

async function readRingoverPayload(req) {
  const raw = await readRawBody(req);
  if (raw && raw.trim()) {
    const safe = raw.replace(BIGINT_GUARD, '"$1":"$2"');
    try { return JSON.parse(safe); } catch (_) { /* tente le brut tel quel */ }
    try { return JSON.parse(raw); } catch (_) { /* retombe sur req.body */ }
  }
  // Flux déjà consommé (ou corps illisible) : req.body pré-parsé par Vercel.
  let body = req && req.body;
  if (body == null) return {};
  if (Buffer.isBuffer(body)) { try { body = body.toString('utf8'); } catch (_) { return {}; } }
  if (typeof body === 'string') {
    const safe = body.replace(BIGINT_GUARD, '"$1":"$2"');
    try { return JSON.parse(safe); } catch (_) {}
    try { return JSON.parse(body); } catch (_) { return {}; }
  }
  if (typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

/* Id d'appel canonique — celui sous lequel ringover-call-initiate crée le
   doc call_logs et le leg de campagne, et que le sync cron upsert. */
function pickCallId(payload) {
  const d = (payload && payload.data) || {};
  const raw = d.call_id || payload.call_id || d.id || payload.id || null;
  if (raw == null) return null;
  const s = String(raw);
  return (s && s !== '0') ? s : null;
}

function verifyRingoverJwt(token, key) {
  if (!token || !key) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  let alg = null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    alg = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[header.alg];
  } catch (_) { return false; }
  if (!alg) return false;
  let expected, sig;
  try {
    expected = crypto.createHmac(alg, key).update(parts[0] + '.' + parts[1]).digest();
    sig = Buffer.from(parts[2], 'base64url');
  } catch (_) { return false; }
  return expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
}

/* Renvoie null si aucune clé configurée (rien à vérifier), sinon true/false. */
function checkRingoverAuth(req, expectedKey) {
  if (!expectedKey) return null;
  const sentHeader = req.headers['authorization'] || req.headers['x-ringover-token'] || '';
  const expectedB64 = Buffer.from(expectedKey).toString('base64');
  if (sentHeader === expectedKey
   || sentHeader === expectedB64
   || sentHeader === `Bearer ${expectedKey}`
   || sentHeader === `Bearer ${expectedB64}`) return true;
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(sentHeader);
  if (m) return verifyRingoverJwt(m[1], expectedKey);
  return false;
}

module.exports = { readRingoverPayload, readRawBody, pickCallId, verifyRingoverJwt, checkRingoverAuth };
