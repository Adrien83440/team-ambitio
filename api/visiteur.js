// ============================================================================
// api/visiteur.js — LIEU ET APPAREIL DU PROSPECT (23/11/2026)
// ----------------------------------------------------------------------------
// Demande Adrien : savoir d'où vient chaque prospect (ville approximative,
// région, pays) et sur quoi il s'inscrit (téléphone, ordinateur, tablette,
// appli Facebook / Instagram). Règles et affichage : FunnelCore.visiteurOf
// (funnel-core.js) ; bloc construit par api/_visiteur.js.
//
// 1. POST (public, beacon du navigateur, réponse 204 toujours)
//      { e: <event_id> }   page quiz, à l'envoi du formulaire (injecté par
//                          api/_quizMetaIds.js) — le lead est créé ensuite
//                          par Make → lead-optin, qui retrouve ce relevé par
//                          metaIds.eventId ;
//      { b: <id du RDV> }  booking.html, RDV pris par le prospect lui-même
//                          (jamais un RDV posé par l'équipe : on relèverait
//                          l'appareil du setter).
//    Pour TOUS les visiteurs (pixel autorisé ou non : rien ne part chez Meta).
//    Aucune adresse IP conservée.
//
// 2. GET ?job=rattrapage   (cron horaire, CRON_SECRET)
//      relie aux fiches les relevés quiz des 48 dernières heures restés
//      orphelins (le beacon et Make arrivés en même temps).
//
// 3. GET ?job=signatures   (clé VISITEUR_KEY ou CRON_SECRET)
//      rattrapage des CLIENTS : lieu relevé à la signature du contrat
//      (api/_sign-core.js), posé sur la fiche lead qui n'a pas de lieu.
//      À BLANC par défaut (comptes seulement, aucune donnée personnelle en
//      sortie) ; &apply=1 écrit, trace visiteur_backfill_log.
//
// DONNÉES (Admin SDK seul, AUCUNE règle Firestore) :
//   lead_visiteur/{event_id} { city, region, country, device, os, browser,
//     app, via, at, e, joined, leadId, createdAt } — relevé brut du quiz.
//   leads/{id}.visiteur, bookings/{id}.visiteur — premier relevé, jamais
//   écrasé.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const V = require('./_visiteur');

const COL = 'lead_visiteur';
const JOIN_WINDOW_MS = 3 * 3600000;        // opt-in récent : le relevé lui appartient
const BOOKING_WINDOW_MS = 2 * 3600000;
const RATTRAPAGE_MS = 48 * 3600000;

function keyOf(e) { return String(e || '').replace(/[/.]/g, '_').slice(0, 100); }
function ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function authorized(req, allowKey) {
  const auth = String(req.headers.authorization || '');
  const cron = process.env.CRON_SECRET;
  if (cron && (safeEq(auth, 'Bearer ' + cron) || safeEq(String(req.headers['x-api-key'] || ''), cron))) return true;
  const key = process.env.VISITEUR_KEY;
  const given = String((req.query && req.query.key) || req.headers['x-visiteur-key'] || '');
  return !!(allowKey && key && safeEq(given, key));
}

/* Pose le relevé sur la fiche si elle n'a pas encore de lieu. */
async function attachToLead(ref, lead, blk) {
  if (!lead || V.hasGeo(lead.visiteur)) return false;
  if (lead.visiteur && typeof lead.visiteur === 'object') {
    const u = {};
    ['city', 'region', 'country'].forEach(function (k) { if (blk[k]) u['visiteur.' + k] = blk[k]; });
    u['visiteur.geoVia'] = blk.via || '';
    await ref.update(u);
  } else {
    await ref.update({ visiteur: blk });
  }
  return true;
}

/* Fiche(s) portant cet event_id, opt-in récent. */
async function joinEvent(e, blk) {
  const snap = await db.collection('leads').where('metaIds.eventId', '==', e).limit(3).get();
  let leadId = null;
  for (const d of snap.docs) {
    const l = d.data() || {};
    if (l._merged === true) continue;
    const at = ms(l.metaIds && l.metaIds.at);
    if (at != null && Date.now() - at > JOIN_WINDOW_MS) continue;
    leadId = d.id;
    await attachToLead(d.ref, l, blk);
    break;
  }
  return leadId;
}

async function beacon(req, res) {
  const body = parseBody(req) || {};
  const e = String(body.e || '').trim();
  const b = String(body.b || '').trim();
  if (e && /^[A-Za-z0-9_.:-]{6,100}$/.test(e)) {
    const blk = V.fromReq(req, { via: 'quiz' });
    if (!blk) return;
    const ref = db.collection(COL).doc(keyOf(e));
    try {
      await ref.create(Object.assign({}, blk, { e: e, joined: false, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
    } catch (err) {
      if (err && (err.code === 6 || /already exists/i.test(String(err.message)))) return;   // premier relevé fait foi
      throw err;
    }
    const leadId = await joinEvent(e, blk);
    if (leadId) await ref.update({ joined: true, leadId: leadId });
    return;
  }
  if (b && /^[A-Za-z0-9_-]{10,60}$/.test(b)) {
    const bref = db.collection('bookings').doc(b);
    const snap = await bref.get();
    if (!snap.exists) return;
    const bk = snap.data() || {};
    if (bk.visiteur || bk.isCoaching === true || bk.source === 'setter_booking' || bk.source === 'csm_manual') return;
    const created = ms(bk.createdAt);
    if (created == null || Date.now() - created > BOOKING_WINDOW_MS) return;
    const blk = V.fromReq(req, { via: 'rdv' });
    if (!blk) return;
    await bref.update({ visiteur: blk });
    if (bk.leadId) {
      const lref = db.collection('leads').doc(String(bk.leadId));
      const ls = await lref.get();
      if (ls.exists) await attachToLead(lref, ls.data() || {}, blk);
    }
  }
}

async function rattrapage(req, res) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - RATTRAPAGE_MS);
  const snap = await db.collection(COL).where('createdAt', '>=', since).limit(2000).get();
  let vus = 0, relies = 0;
  for (const d of snap.docs) {
    const x = d.data() || {};
    if (x.joined) continue;
    vus++;
    const blk = {};
    ['city', 'region', 'country', 'device', 'os', 'browser', 'app', 'via', 'at'].forEach(function (k) { if (x[k]) blk[k] = x[k]; });
    const s2 = await db.collection('leads').where('metaIds.eventId', '==', x.e).limit(3).get();
    const doc = s2.docs.filter(function (z) { return (z.data() || {})._merged !== true; })[0];
    if (!doc) continue;
    await attachToLead(doc.ref, doc.data() || {}, blk);
    await d.ref.update({ joined: true, leadId: doc.id });
    relies++;
  }
  res.status(200).json({ ok: true, job: 'rattrapage', orphelins: vus, relies: relies });
}

/* Lieu d'une demande de signature : audit « signature_validee » du premier
   signataire, sinon progress.lieu. */
async function geoOfRequest(doc) {
  const R = doc.data() || {};
  const a = await doc.ref.collection('audit').where('type', '==', 'signature_validee').limit(5).get();
  let txt = '';
  a.docs.map(function (x) { return x.data() || {}; })
    .sort(function (p, q) { return (p.seq || 0) - (q.seq || 0); })
    .forEach(function (x) { if (!txt && x.geo) txt = x.geo; });
  if (!txt && R.progress && R.progress.lieu) txt = R.progress.lieu;
  return txt ? V.fromGeoText(txt, 'signature') : null;
}

/* Fiche lead d'une demande de signature : leadId, sinon même e-mail client,
   sinon même téléphone (E.164) — fiches fusionnées ignorées, une seule
   fiche vivante exigée (sinon ambigu : on ne pose rien). */
async function leadOfRequest(R) {
  if (R.leadId) {
    const d = await db.collection('leads').doc(String(R.leadId)).get();
    return d.exists ? d : null;
  }
  const s0 = Array.isArray(R.signers) && R.signers[0];
  const email = String(R.clientEmail || (s0 && s0.email) || '').trim().toLowerCase();
  const tel = String(R.clientPhone || (s0 && s0.phone) || '').replace(/[\s.-]/g, '');
  const tries = [];
  if (email) tries.push(['email', email]);
  if (/^\+\d{8,15}$/.test(tel)) tries.push(['telephone', tel]);
  for (const t of tries) {
    const q = await db.collection('leads').where(t[0], '==', t[1]).limit(5).get();
    const alive = q.docs.filter(function (d) { return (d.data() || {})._merged !== true; });
    if (alive.length === 1) return alive[0];
    if (alive.length > 1) return 'ambigu';
  }
  return null;
}

async function signatures(req, res) {
  const apply = req.query && (req.query.apply === '1' || req.query.apply === 'true');
  const snap = await db.collection('signature_requests').where('status', '==', 'signed').get();
  const out = { ok: true, job: 'signatures', apply: !!apply, signees: snap.size, sansLead: 0, parEmailOuTel: 0, ambigus: 0, sansLieu: 0,
    dejaLocalises: 0, leadIntrouvable: 0, aEcrire: 0, ecrits: 0, parZone: {} };
  const FC = require('../funnel-core.js');
  const seen = {};
  const plan = [];
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 20) {
    const chunk = docs.slice(i, i + 20);
    const res2 = await Promise.all(chunk.map(async function (doc) {
      const R = doc.data() || {};
      const ls = await leadOfRequest(R);
      if (ls === 'ambigu') return { k: 'ambigus' };
      if (!ls) return { k: R.leadId ? 'leadIntrouvable' : 'sansLead' };
      if (seen[ls.id]) return null;
      seen[ls.id] = 1;
      const geo = await geoOfRequest(doc);
      if (!geo) return { k: 'sansLieu' };
      const lref = ls.ref;
      const l = ls.data() || {};
      if (!R.leadId) out.parEmailOuTel++;
      if (V.hasGeo(l.visiteur)) return { k: 'dejaLocalises' };
      return { k: 'aEcrire', ref: lref, lead: l, geo: geo };
    }));
    res2.forEach(function (r) {
      if (!r) return;
      out[r.k]++;
      if (r.k === 'aEcrire') {
        plan.push(r);
        const z = FC.zoneOf(r.geo) || 'inconnue';
        out.parZone[z] = (out.parZone[z] || 0) + 1;
      }
    });
  }
  if (apply) {
    const ids = [];
    for (const p of plan) {
      if (await attachToLead(p.ref, p.lead, p.geo)) { out.ecrits++; ids.push(p.ref.id); }
    }
    await db.collection('visiteur_backfill_log').add({
      job: 'signatures', at: admin.firestore.FieldValue.serverTimestamp(), ecrits: out.ecrits, leadIds: ids
    });
  }
  res.status(200).json(out);
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      try { await beacon(req, res); } catch (err) { console.error('[visiteur] beacon', err && err.message); }
      res.status(204).end();
      return;
    }
    if (req.method !== 'GET') { res.status(405).end(); return; }
    const job = String((req.query && req.query.job) || '');
    if (job === 'rattrapage') {
      if (!authorized(req, true)) { res.status(401).json({ error: 'Non autorisé' }); return; }
      await rattrapage(req, res);
      return;
    }
    if (job === 'signatures') {
      if (!authorized(req, true)) { res.status(401).json({ error: 'Non autorisé' }); return; }
      await signatures(req, res);
      return;
    }
    res.status(400).json({ error: 'job inconnu' });
  } catch (err) {
    console.error('[visiteur]', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: 'visiteur', message: String(err && err.message || err).slice(0, 200) });
  }
};
module.exports.COL = COL;
module.exports.keyOf = keyOf;
