// ============================================================================
// api/ai-watchdog.js — AGENT DE SURVEILLANCE (programme IA, Lot 5)
// ----------------------------------------------------------------------------
// Chaque nuit (05:40 UTC, avant le brief du matin), contrôles DÉTERMINISTES :
//   • leads jamais traités > 24 h sans assignation ; leads non traités > 48 h ;
//   • doublons probables non fusionnés (même téléphone, 60 j) ;
//   • RDV commerciaux passés sans issue saisie (J-10 → J-1) ;
//   • RDV à venir posés depuis un autre fuseau horaire que Paris ;
//   • mandats GoCardless en attente > 7 j ; plans en échec ;
//   • factures validées non envoyées > 3 j ; brouillons > 10 j ;
//   • alertes de facturation non résolues (_alerts/billing/items).
// Puis Opus rédige une recommandation courte par constat. RECOMMANDATIONS
// SEULEMENT : rien n'est corrigé automatiquement. Stocké dans ai_watch/{id}
// (status open | done | superseded) ; affiché dans Réglages IA et dans le
// brief du matin.
//
// GET  Bearer <CRON_SECRET>                      → passe complète
// POST Bearer <ID token admin> { action:'list' } → constats ouverts
// POST { action:'done', id }                     → marquer « traité »
// POST { action:'run' }                          → relancer maintenant
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, tsToMs, cap } = require('./_ai');

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function shift(d, n) { const p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10); }
function isCoaching(b) { return !!(b.isCoaching || b.clientId || b.source === 'csm_manual' || b.skipLeadCreation); }

async function checks() {
  const today = parisDate(Date.now());
  const F = [];
  function add(key, severity, title, items, link) { if (items.length) F.push({ key: key, severity: severity, title: title, count: items.length, examples: items.slice(0, 8), link: link || null }); }
  async function safe(fn) { try { await fn(); } catch (e) { console.warn('[ai-watchdog]', e.message); } }

  await safe(async function () {
    const s = await db.collection('leads').where('createdAt', '>=', new Date(Date.now() - 60 * 86400000)).get();
    const orphan = [], stale = {}, byPhone = {};
    s.forEach(function (d) {
      const l = d.data() || {};
      if (l._merged) return;
      const age = Date.now() - tsToMs(l.createdAt);
      const comms = (l.communications || []).filter(function (c) { return c.type === 'call' || c.type === 'sms'; });
      const untouched = (l.status || 'nouveau') === 'nouveau' && !comms.length && !l.isClient;
      if (untouched && !l.assignedTo && age > 24 * 3600000 && age < 14 * 86400000) orphan.push(l.nom || d.id);
      if (untouched && l.assignedTo && age > 48 * 3600000 && age < 14 * 86400000) (stale[l.assignedTo] = stale[l.assignedTo] || []).push(l.nom || d.id);
      if (l.phoneNormalized && String(l.phoneNormalized).length === 9) (byPhone[l.phoneNormalized] = byPhone[l.phoneNormalized] || []).push(l.nom || d.id);
    });
    add('leads_orphelins', 'haute', 'Leads jamais traités ni assignés depuis plus de 24 h', orphan, 'sales-leads.html');
    const st = Object.keys(stale).map(function (k) { return k + ' : ' + stale[k].length + ' lead(s) (' + stale[k].slice(0, 3).join(', ') + ')'; });
    add('leads_non_traites', 'moyenne', 'Leads assignés mais non traités depuis plus de 48 h', st, 'sales-leads.html');
    const dups = Object.keys(byPhone).filter(function (k) { return byPhone[k].length > 1; }).map(function (k) { return byPhone[k].join(' / '); });
    add('doublons', 'basse', 'Doublons probables non fusionnés (même téléphone)', dups, 'clients-dedup.html');
  });

  await safe(async function () {
    const s = await db.collection('bookings').where('date', '>=', shift(today, -10)).where('date', '<=', shift(today, 30)).get();
    const noOutcome = [], tz = [];
    s.forEach(function (d) {
      const b = d.data() || {};
      if (isCoaching(b)) return;
      const who = b.prospect ? ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim() : d.id;
      if (b.date < today && !b.outcome && (b.status === 'confirmed' || b.status === 'pending')) noOutcome.push(b.date + ' ' + (b.time || '') + ' · ' + who + ' · ' + (b.personName || '?'));
      if (b.date >= today && b.timezone && b.timezone !== 'Europe/Paris' && b.status !== 'cancelled') tz.push(b.date + ' ' + (b.time || '') + ' · ' + who + ' · posé depuis ' + b.timezone);
    });
    add('rdv_sans_issue', 'haute', 'RDV passés sans issue saisie (commissions et stats faussées)', noOutcome, 'sales-rdv.html');
    add('rdv_fuseau', 'moyenne', 'RDV à venir posés depuis un autre fuseau horaire que Paris — vérifier le créneau', tz, 'booking-admin.html');
  });

  await safe(async function () {
    const s = await db.collection('payments').get();
    const pending = [], failed = [];
    s.forEach(function (d) {
      const p = d.data() || {};
      const age = Date.now() - (tsToMs(p.mandateSentAt) || tsToMs(p.createdAt));
      if (p.status === 'pending_mandate' && age > 7 * 86400000) pending.push((p.leadName || d.id) + ' (' + Math.round(age / 86400000) + ' j)');
      if (p.status === 'mandate_failed' || p.status === 'failed') failed.push((p.leadName || d.id) + ' · ' + p.status);
    });
    add('mandats_attente', 'moyenne', 'Mandats GoCardless non signés depuis plus de 7 jours', pending, 'payments.html');
    add('paiements_echec', 'haute', 'Plans de paiement en échec', failed, 'payments.html?tab=impayes');
  });

  await safe(async function () {
    const s = await db.collection('invoices').where('status', 'in', ['validated', 'draft']).get();
    const notSent = [], oldDrafts = [];
    s.forEach(function (d) {
      const i = d.data() || {};
      const t = tsToMs(i.validatedAt) || tsToMs(i.issueDate) || tsToMs(i.updatedAt) || tsToMs(i.createdAt);
      if (i.status === 'validated' && t && Date.now() - t > 3 * 86400000) notSent.push((i.number || d.id) + ' · ' + ((i.clientSnapshot && i.clientSnapshot.companyName) || ''));
      if (i.status === 'draft' && t && Date.now() - t > 10 * 86400000) oldDrafts.push(d.id + ' · ' + ((i.clientSnapshot && i.clientSnapshot.companyName) || ''));
    });
    add('factures_non_envoyees', 'moyenne', 'Factures validées mais non envoyées depuis plus de 3 jours', notSent, 'admin-facturation.html');
    add('brouillons_anciens', 'basse', 'Brouillons de facture de plus de 10 jours', oldDrafts, 'admin-facturation.html');
  });

  await safe(async function () {
    const s = await db.collection('_alerts').doc('billing').collection('items').where('resolved', '==', false).limit(50).get();
    const list = [];
    s.forEach(function (d) { const a = d.data() || {}; list.push((a.type || 'alerte') + (a.gcPaymentId ? ' · ' + a.gcPaymentId : '') + (a.error ? ' · ' + cap(a.error, 80) : '')); });
    add('alertes_facturation', 'haute', 'Alertes de facturation non résolues', list, 'admin-facturation.html');
  });

  return F;
}

async function run() {
  const F = await checks();
  if (F.length) {
    const r = await callClaude({
      task: 'watchdog',
      system: 'Tu es l\'agent de surveillance d\'Alteore. Pour chaque constat, écris UNE recommandation courte et concrète (qui fait quoi, en une phrase), sans dramatiser. Tu ne corriges rien toi-même.',
      prompt: JSON.stringify(F.map(function (f) { return { key: f.key, titre: f.title, nombre: f.count, exemples: f.examples }; })),
      schema: { type: 'object', additionalProperties: false, required: ['recos'], properties: { recos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'reco'], properties: { key: { type: 'string' }, reco: { type: 'string' } } } } } },
      ref: 'watchdog',
    });
    if (r.ok) (r.json.recos || []).forEach(function (x) { const f = F.find(function (y) { return y.key === x.key; }); if (f) f.reco = x.reco; });
  }
  const old = await db.collection('ai_watch').where('status', '==', 'open').get();
  const batch = db.batch();
  old.forEach(function (d) { batch.update(d.ref, { status: 'superseded', supersededAt: Date.now() }); });
  F.forEach(function (f) { batch.set(db.collection('ai_watch').doc(), Object.assign({}, f, { status: 'open', createdAt: Date.now() })); });
  await batch.commit();
  return { findings: F.length };
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.status(200).json(Object.assign({ ok: true }, await run())); } catch (e) { console.error('[ai-watchdog]', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  try {
    if (body.action === 'run') { res.status(200).json(Object.assign({ ok: true }, await run())); return; }
    if (body.action === 'done') {
      await db.collection('ai_watch').doc(String(body.id || '')).update({ status: 'done', doneAt: Date.now(), doneBy: auth.uid });
      res.status(200).json({ ok: true });
      return;
    }
    const s = await db.collection('ai_watch').where('status', '==', 'open').get();
    const items = [];
    s.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
    const rank = { haute: 0, moyenne: 1, basse: 2 };
    items.sort(function (a, b) { return (rank[a.severity] || 3) - (rank[b.severity] || 3); });
    res.status(200).json({ ok: true, items: items });
  } catch (e) {
    console.error('[ai-watchdog]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
