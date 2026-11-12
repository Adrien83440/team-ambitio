// ============================================================================
// api/meta-capi.js — JOURNAL ET DIAGNOSTIC DE L'API CONVERSIONS (12/11/2026)
// ----------------------------------------------------------------------------
// Admin seulement (Bearer ID token Firebase, rôle admin). Sert l'encart
// « 📡 Événements renvoyés à Meta » de l'onglet Qualité par pub
// (ads-quality-tab.js). Le journal meta_capi_events n'a aucune règle
// Firestore : il ne se lit que par ici.
//
//   GET  ?part=status                      → réglages (sans le jeton), état
//                                            du jeton, dernier passage du cron
//   GET  ?part=journal[&status=][&event=][&limit=]
//                                          → dernières lignes du journal, avec
//                                            le nom de la fiche (admin)
//   POST { action: 'probe' }               → envoie UN exemplaire de chacun
//                                            des 6 événements pour un contact
//                                            fictif, AVEC le code de test
//                                            uniquement (refusé sans code) :
//                                            c'est la vérification dans
//                                            « Tester les événements » de Meta.
// Les réglages eux-mêmes s'écrivent depuis la page (_config/meta_capi,
// règle admin existante sur _config).
// ============================================================================
'use strict';

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const Capi = require('./_metaCapi');

function tsIso(v) { const t = Capi.ms(v); return t ? new Date(t).toISOString() : null; }

async function status() {
  const cfg = await Capi.loadConfig();
  let cursor = null;
  try { const s = await db.collection('meta_capi_state').doc('cursor').get(); if (s.exists) cursor = s.data(); } catch (e) { cursor = null; }
  return {
    enabled: cfg.enabled, testMode: cfg.testMode, testEventCode: cfg.testEventCode,
    pixelId: cfg.pixelId, apiVersion: cfg.apiVersion, tokenSet: cfg.tokenSet,
    testSince: cfg.testSince ? new Date(cfg.testSince).toISOString() : null,
    productionSince: cfg.productionSince ? new Date(cfg.productionSince).toISOString() : null,
    lastRunAt: cursor ? tsIso(cursor.lastRunAt) : null,
    lastSummary: cursor ? cursor.lastSummary || null : null
  };
}

async function journal(q) {
  const lim = Math.min(500, Math.max(10, parseInt(q.limit, 10) || 200));
  const snap = await db.collection(Capi.JOURNAL).orderBy('updatedAt', 'desc').limit(lim).get();
  const rows = [];
  snap.forEach(function (d) {
    const x = d.data() || {};
    if (q.status && x.status !== q.status) return;
    if (q.event && x.event !== q.event) return;
    const r = x.response || {};
    rows.push({
      key: d.id, event: x.event, eventId: x.eventId, status: x.status, reason: x.reason || null,
      test: !!x.test, leadId: x.leadId || null, bookingId: x.bookingId || null,
      eventTime: tsIso(x.eventTime), sentAt: tsIso(x.sentAt) || tsIso(x.updatedAt),
      value: x.value != null ? x.value : null, actionSource: x.actionSource || null,
      matchKeys: x.matchKeys || [], attempts: x.attempts || 0,
      response: { ok: !!r.ok, events_received: r.events_received != null ? r.events_received : null, error: r.error || null, fbtrace_id: r.fbtrace_id || null }
    });
  });
  /* Nom de la fiche : affiché à l'admin seulement, jamais écrit au journal. */
  const ids = {};
  rows.forEach(function (r) { if (r.leadId) ids[r.leadId] = 1; });
  const keys = Object.keys(ids).slice(0, 300);
  const names = {};
  for (let i = 0; i < keys.length; i += 100) {
    const refs = keys.slice(i, i + 100).map(function (id) { return db.collection('leads').doc(id); });
    const docs = refs.length ? await db.getAll.apply(db, refs) : [];
    docs.forEach(function (s) { if (s.exists) names[s.id] = (s.data() || {}).nom || ''; });
  }
  rows.forEach(function (r) { r.leadName = r.leadId ? (names[r.leadId] || '') : ''; });
  return rows;
}

/* Contact fictif : jamais une vraie personne, domaine réservé .invalid. */
async function probe(auth) {
  const cfg = await Capi.loadConfig();
  if (!cfg.tokenSet) return { ok: false, error: 'Variable Vercel META_CAPI_TOKEN absente.' };
  if (!cfg.testEventCode) return { ok: false, error: 'Saisis d\'abord le code de test du Gestionnaire d\'événements.' };
  const stamp = Date.now();
  const fake = {
    _id: 'probe-' + stamp, email: 'test-capi@alteore.invalid', telephone: '+33612345678',
    stage: 'lead', quiz: { ca_mensuel: 'Entre 20 000 € et 50 000 € par mois' },
    landingLast: { label: 'Test API Conversions', pageUrl: 'https://www.adrienemily.com/optin-a' },
    metaIds: { eventId: 'probe-ld-' + stamp, ua: 'Mozilla/5.0 (Test API Conversions Alteore)', pageUrl: 'https://www.adrienemily.com/optin-a', at: new Date(stamp), allowed: true }
  };
  const bk = { _id: 'probe-bk-' + stamp, source: 'self_booking', typeLabel: 'Test RDV', createdAt: new Date(stamp), outcomeAt: new Date(stamp), outcome: 'close', closeData: { contracte: 1, offre: 'Test' }, prospect: { email: fake.email } };
  const items = []
    .concat(Capi.optinEvents(fake))
    .concat(Capi.bookingCreatedEvents(bk, fake))
    .concat(Capi.bookingOutcomeEvents(bk, fake));
  const resp = await Capi.postEvents(cfg, items.map(function (it) { return it.ev; }), cfg.testEventCode);
  const FV = admin.firestore.FieldValue;
  const batch = db.batch();
  items.forEach(function (it) {
    batch.set(db.collection(Capi.JOURNAL).doc('probe_' + stamp + '_' + it.kind), {
      event: it.kind, eventId: it.ev.event_id, status: resp.ok ? 'sent' : 'error', reason: 'test manuel (contact fictif)',
      test: true, testEventCode: cfg.testEventCode, leadId: null, bookingId: null, eventTime: new Date(it.at),
      value: it.value != null ? it.value : null, actionSource: it.ev.action_source, matchKeys: Capi.matchKeys(it.ev.user_data),
      response: resp, attempts: 1, probeBy: auth.uid, sentAt: FV.serverTimestamp(), createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp()
    });
  });
  await batch.commit();
  return { ok: resp.ok, events: items.map(function (it) { return it.kind; }), response: resp };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.part === 'journal') { res.status(200).json({ ok: true, rows: await journal(q) }); return; }
      res.status(200).json(Object.assign({ ok: true }, await status()));
      return;
    }
    if (req.method === 'POST') {
      const body = parseBody(req) || {};
      if (body.action === 'probe') { res.status(200).json(await probe(auth)); return; }
      res.status(400).json({ ok: false, error: 'action inconnue' });
      return;
    }
    res.status(405).json({ ok: false });
  } catch (e) {
    console.error('[meta-capi]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
};
