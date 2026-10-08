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
