// ============================================================================
// api/bp-seances.js — BUSINESS PHÉNIX NOUVEAU FORMAT : COMPTEUR DE SÉANCES
// ----------------------------------------------------------------------------
// POST /api/bp-seances  + Bearer
//   { action:'etat',      clientId }
//       → { ok, credits, ajouts[], peutAjouter }      (admin, coach, csm)
//   { action:'ajouter',   clientId, delta (1..5), motif (≥ 10 car.) }
//   { action:'dispenser', clientId, bookingId, motif }
//       → une absence / un report tardif détecté NE consomme PAS de séance
//   { action:'annuler',   clientId, ajoutId, motif }
//       → retire un ajout ou une dispense (jamais supprimé : annule:true)
//         ajouter / dispenser / annuler : réservé à _config/business_phenix
//         .sessionGranters (Adrien, Emily — décision du 14/10/2026)
//
// POURQUOI UNE SOUS-COLLECTION
// ----------------------------
// coaching.html réécrit la fiche clients/{id} ENTIÈRE à chaque sauvegarde,
// depuis une copie locale : un compteur posé sur la fiche par le serveur
// serait écrasé par le prochain onglet resté ouvert (cf. replay_emails). Les
// ajouts vivent donc dans clients/{id}/seances_ajouts/{auto} — Admin SDK
// seulement (aucune règle Firestore = refus navigateur), historique complet,
// rien n'est jamais supprimé. La règle du compteur est dans ../bp-credits.js,
// la même que celle des pages.
//
// L'Academy suit : chaque ajout (ou son annulation) est relayé au pont
// bridge/seances-ajout pour que le compteur du client affiche le même total.
// Un échec du relais n'annule pas l'ajout (il est rejoué au prochain ajout,
// le pont recevant le TOTAL des ajouts et non un delta).
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const BP = require('../bp-credits.js');

const ROLES_LECTURE = ['admin', 'coach', 'csm'];
const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const MOTIF_MIN = 10;

function body(req) {
  try { return typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { return {}; }
}
function cap(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; }

async function granters() {
  const s = await db.collection('_config').doc('business_phenix').get();
  return (s.exists && (s.data() || {}).sessionGranters) || [];
}

async function chargerAjouts(clientId) {
  const sn = await db.collection('clients').doc(clientId).collection('seances_ajouts').get();
  const out = [];
  sn.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
  out.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  return out;
}

async function chargerBookings(email) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) return [];
  const sn = await db.collection('bookings').where('prospect.email', '==', mail).get();
  const out = [];
  sn.forEach(function (d) { const b = d.data() || {}; if (b.isCoaching === true) out.push(Object.assign({ id: d.id }, b)); });
  return out;
}

async function relaisAcademy(email, totalAjoute, motif, par) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key || !email) return { ok: false, error: 'bridge_not_configured' };
  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/seances-ajout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: email, total: totalAjoute, motif: cap(motif, 500), par: par }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return j || { ok: false, error: 'academy_unreachable' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'academy_unreachable' };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const b = body(req);
  const action = String(b.action || 'etat');
  const clientId = String(b.clientId || '').trim();
  if (!clientId) { res.status(400).json({ ok: false, error: 'clientId_requis' }); return; }

  try {
    const ref = db.collection('clients').doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'client_introuvable' }); return; }
    const c = snap.data() || {};
    if (!BP.isBusinessV2(c.programme)) { res.status(409).json({ ok: false, error: 'pas_business_nouveau_format' }); return; }

    const g = await granters();
    const peutAjouter = g.indexOf(auth.uid) >= 0;

    if (action === 'etat') {
      if (ROLES_LECTURE.indexOf(auth.role) < 0 && !peutAjouter) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const ajouts = await chargerAjouts(clientId);
      const bookings = await chargerBookings(c.email);
      const credits = BP.compute(c, { bookings: bookings, ajouts: ajouts });
      res.status(200).json({ ok: true, credits: credits, ajouts: ajouts, peutAjouter: peutAjouter });
      return;
    }

    if (!peutAjouter) { res.status(403).json({ ok: false, error: 'reserve_adrien_emily' }); return; }
    const motif = cap(b.motif, 500);
    if (motif.length < MOTIF_MIN) { res.status(400).json({ ok: false, error: 'motif_requis', min: MOTIF_MIN }); return; }

    const nowIso = new Date().toISOString();
    const par = { uid: auth.uid, nom: (auth.userData && (auth.userData.name || auth.userData.displayName)) || auth.email || '' };
    const col = ref.collection('seances_ajouts');

    if (action === 'ajouter') {
      const delta = Math.round(Number(b.delta) || 0);
      if (delta < 1 || delta > 5) { res.status(400).json({ ok: false, error: 'delta_1_a_5' }); return; }
      const docRef = await col.add({ kind: 'ajout', delta: delta, motif: motif, at: nowIso, by: par.uid, byName: par.nom, annule: false, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      const ajouts = await chargerAjouts(clientId);
      const total = ajouts.reduce(function (t, a) { return t + (a.kind === 'ajout' && a.annule !== true ? (Number(a.delta) || 0) : 0); }, 0);
      const relais = await relaisAcademy(c.email, total, motif, par.nom);
      await docRef.set({ academy: { ok: !!(relais && relais.ok), error: (relais && relais.error) || null, at: new Date().toISOString() } }, { merge: true });
      res.status(200).json({ ok: true, id: docRef.id, totalAjoute: total, academy: relais && relais.ok === true });
      return;
    }

    if (action === 'dispenser') {
      const bookingId = String(b.bookingId || '').trim();
      if (!bookingId) { res.status(400).json({ ok: false, error: 'bookingId_requis' }); return; }
      const bk = await db.collection('bookings').doc(bookingId).get();
      if (!bk.exists) { res.status(404).json({ ok: false, error: 'rdv_introuvable' }); return; }
      const x = bk.data() || {};
      const docRef = await col.add({ kind: 'dispense', bookingId: bookingId, bookingDate: x.date || '', bookingTime: x.time || '', motif: motif, at: nowIso, by: par.uid, byName: par.nom, annule: false, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      res.status(200).json({ ok: true, id: docRef.id });
      return;
    }

    if (action === 'annuler') {
      const ajoutId = String(b.ajoutId || '').trim();
      const aRef = col.doc(ajoutId);
      const a = await aRef.get();
      if (!ajoutId || !a.exists) { res.status(404).json({ ok: false, error: 'ajout_introuvable' }); return; }
      if ((a.data() || {}).annule === true) { res.status(200).json({ ok: true, deja: true }); return; }
      await aRef.set({ annule: true, annuleAt: nowIso, annuleBy: par.uid, annuleByName: par.nom, annuleMotif: motif }, { merge: true });
      let relais = null;
      if ((a.data() || {}).kind === 'ajout') {
        const ajouts = await chargerAjouts(clientId);
        const total = ajouts.reduce(function (t, x) { return t + (x.kind === 'ajout' && x.annule !== true ? (Number(x.delta) || 0) : 0); }, 0);
        relais = await relaisAcademy(c.email, total, motif, par.nom);
      }
      res.status(200).json({ ok: true, academy: relais ? relais.ok === true : null });
      return;
    }

    res.status(400).json({ ok: false, error: 'action_inconnue' });
  } catch (e) {
    console.error('[bp-seances]', e);
    res.status(500).json({ ok: false, error: (e && e.message) || 'erreur' });
  }
};
