// ============================================================================
// api/meta-capi-cron.js — ENVOI DES ÉVÉNEMENTS À L'API CONVERSIONS META (12/11/2026)
// ----------------------------------------------------------------------------
// Brief « Outil 2 », partie C. Toutes les 10 minutes (vercel.json), relit ce
// qui s'est passé depuis le dernier passage et l'envoie au pixel :
//   · fiches dont l'opt-in porte des identifiants Meta (metaIds.at)
//       → Lead (jumeau du navigateur) + LeadQualifie (CA ≥ 20 k€/mois) ;
//   · RDV créés (createdAt)    → Schedule (jumeau de booking.html) + RdvPose ;
//   · issues saisies (outcomeAt) → RdvHonore (close / non close / offre)
//                                  + Vente (close, montant contracté HT).
// Règles, exclusions, hachage, journal : api/_metaCapi.js.
//
// Pourquoi un cron et pas un trigger Firestore : les issues de RDV sont
// écrites par le navigateur (alteore-flow.js) ; un trigger serait une Cloud
// Function, dont le déploiement est interactif (CLAUDE.md). Le journal
// (clé = event_id) rend chaque passage rejouable sans doublon, et la
// fenêtre relit 30 min avant le dernier passage pour ne rien rater.
//
// Rien ne part tant que :
//   · _config/meta_capi.enabled n'est pas vrai ;
//   · la variable Vercel META_CAPI_TOKEN n'est pas posée ;
//   · en mode test (défaut), aucun code de test n'est saisi ;
//   · le fait (opt-in, RDV, issue) est antérieur à l'activation du mode
//     (testSince / productionSince) — jamais de rattrapage du passé.
//
// Accès :
//   GET  Bearer <CRON_SECRET>            → passage réel (cron Vercel)
//   GET|POST Bearer <ID token admin>     → passage manuel (bouton « Lancer
//                                          maintenant » de l'onglet) ;
//                                          ?dry=1 : liste ce qui partirait,
//                                          sans rien envoyer ni écrire.
// ============================================================================
'use strict';

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const Lookup = require('./_leadLookup');
const Capi = require('./_metaCapi');

const STATE = db.collection('meta_capi_state').doc('cursor');
const OVERLAP_MS = 30 * 60000;
const FIRST_LOOKBACK_MS = 6 * 3600000;
const LIMIT = 300;

function checkCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  return bearer === secret;
}

async function docsSince(col, field, fromMs) {
  const snap = await db.collection(col)
    .where(field, '>=', admin.firestore.Timestamp.fromMillis(fromMs))
    .orderBy(field, 'asc').limit(LIMIT).get();
  const out = [];
  snap.forEach(function (d) { const x = d.data() || {}; x._id = d.id; out.push(x); });
  return { list: out, truncated: snap.size >= LIMIT };
}

async function leadForBooking(b, cache) {
  const k = b.leadId || ('b:' + b._id);
  if (k in cache) return cache[k];
  let snap = null;
  try {
    snap = await Lookup.findLeadDoc(b.leadId || null, b.prospect && b.prospect.email, b.prospect && (b.prospect.telephone || b.prospect.phone));
  } catch (e) { snap = null; }
  const lead = snap ? Object.assign({ _id: snap.id }, snap.data()) : null;
  cache[k] = lead;
  return lead;
}

async function run(opts) {
  const dry = !!(opts && opts.dry);
  const cfg = await Capi.loadConfig();
  const since = Capi.sinceOf(cfg);
  const state = { enabled: cfg.enabled, testMode: cfg.testMode, tokenSet: cfg.tokenSet, testCodeSet: !!cfg.testEventCode, since: since };
  if (!dry) {
    if (!cfg.enabled) return Object.assign(state, { skipped: 'désactivé (_config/meta_capi.enabled)' });
    if (!cfg.tokenSet) return Object.assign(state, { skipped: 'variable Vercel META_CAPI_TOKEN absente' });
    if (cfg.testMode && !cfg.testEventCode) return Object.assign(state, { skipped: 'mode test sans code de test' });
  }
  if (!since) return Object.assign(state, { skipped: 'mode jamais activé (date de départ absente)' });

  const now = Date.now();
  let last = null;
  try { const s = await STATE.get(); if (s.exists) last = Capi.ms(s.data().lastRunAt); } catch (e) { last = null; }
  const from = Math.max(since, (last || now - FIRST_LOOKBACK_MS) - OVERLAP_MS);

  const [leadsQ, createdQ, outcomeQ] = await Promise.all([
    docsSince('leads', 'metaIds.at', from),
    docsSince('bookings', 'createdAt', from),
    docsSince('bookings', 'outcomeAt', from)
  ]);

  const leadsById = {};
  const items = [];
  leadsQ.list.forEach(function (l) {
    if (l._merged === true) return;
    leadsById[l._id] = l;
    Capi.optinEvents(l).forEach(function (it) { items.push(it); });
  });
  const cache = {};
  for (const b of createdQ.list) {
    if (!Capi.bookingIsCommercial(b)) continue;
    const lead = await leadForBooking(b, cache);
    if (!lead) continue;
    leadsById[lead._id] = lead;
    Capi.bookingCreatedEvents(b, lead).forEach(function (it) { items.push(it); });
  }
  for (const b of outcomeQ.list) {
    if (!Capi.bookingIsCommercial(b)) continue;
    const lead = await leadForBooking(b, cache);
    if (!lead) continue;
    leadsById[lead._id] = lead;
    Capi.bookingOutcomeEvents(b, lead).forEach(function (it) { items.push(it); });
  }
  /* Jamais un fait antérieur à l'activation du mode. */
  const fresh = items.filter(function (it) { return it.at >= since; });

  const summary = Object.assign(state, {
    from: new Date(from).toISOString(), candidates: fresh.length,
    truncated: leadsQ.truncated || createdQ.truncated || outcomeQ.truncated
  });
  if (dry) {
    summary.dry = true;
    summary.events = fresh.slice(0, 200).map(function (it) {
      return { event: it.kind, eventId: it.ev.event_id, leadRef: Capi.leadRef(it.leadId), bookingId: it.bookingId || null,
        at: new Date(it.at).toISOString(), actionSource: it.ev.action_source, matchKeys: Capi.matchKeys(it.ev.user_data), value: it.value != null ? it.value : null };
    });
    return summary;
  }

  const toSend = await Capi.prepare(cfg, fresh, leadsById);
  const res = toSend.length ? await Capi.sendBatch(cfg, toSend) : { sent: 0, errors: 0 };
  summary.sent = res.sent;
  summary.errors = res.errors;
  summary.skippedOrDone = fresh.length - toSend.length;
  /* Curseur avancé seulement si la lecture n'a pas été tronquée : sinon le
     passage suivant repart du même point (le journal évite les doublons). */
  if (!summary.truncated) {
    await STATE.set({ lastRunAt: admin.firestore.Timestamp.fromMillis(now), lastSummary: { sent: res.sent, errors: res.errors, candidates: fresh.length, testMode: cfg.testMode } }, { merge: true });
  }
  return summary;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const isCron = checkCron(req);
  if (!isCron) {
    const auth = await requireAdmin(req, res);
    if (!auth) return;
  }
  const dry = String((req.query && req.query.dry) || '') === '1';
  try {
    const out = await run({ dry: dry });
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    console.error('[meta-capi-cron]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
};
module.exports.run = run;
module.exports.config = { maxDuration: 120 };
