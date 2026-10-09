// ============================================================================
// api/lead-routing.js — RÉPARTITION DES LEADS (09/10/2026)
// ----------------------------------------------------------------------------
// GET  (admin)  → { config, members, stats }
//      stats : répartition RÉELLE des leads entrés sur 30 jours, par personne,
//              séparément leads / self-bookings.
// POST (admin)  { action:'save', config:{ leads, selfBooking } }
// POST (admin / sales) { action:'assign', leadId }
//      → attribue un lead non attribué selon la règle (secours navigateur
//        quand la Cloud Function onNewLead n'est pas encore passée).
// Logique : api/_leadRouting.js (miroir dans Functions/index.js).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const R = require('./_leadRouting');

function cleanRule(r, allowWeighted, slugs) {
  if (!r || typeof r !== 'object') return null;
  const mode = r.mode === 'single' ? 'single' : (r.mode === 'weighted' && allowWeighted ? 'weighted' : 'round_robin');
  const out = { mode: mode };
  if (mode === 'single') {
    if (!slugs[r.single]) throw new Error('Choisis la personne qui reçoit 100 %');
    out.single = r.single;
  } else if (mode === 'weighted') {
    const w = {};
    let total = 0;
    Object.keys(r.weights || {}).forEach(function (k) {
      const v = Math.round(Number(r.weights[k]) || 0);
      if (v > 0 && slugs[k]) { w[k] = v; total += v; }
    });
    if (total !== 100) throw new Error('Les pourcentages doivent faire 100 % (actuellement ' + total + ' %)');
    out.weights = w;
  } else {
    out.members = (Array.isArray(r.members) ? r.members : []).filter(function (k) { return slugs[k]; });
    if (!out.members.length) throw new Error('Coche au moins une personne pour le round-robin');
  }
  return out;
}

module.exports = async function (req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = req.method === 'POST' ? parseBody(req) : {};

  try {
    if (req.method === 'POST' && body.action === 'assign') {
      if (auth.role !== 'admin' && auth.role !== 'sales') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const r = await R.assignLead(String(body.leadId || ''));
      res.status(200).json({ ok: true, result: r });
      return;
    }

    if (auth.role !== 'admin') { res.status(403).json({ ok: false, error: 'forbidden', message: 'Réservé aux administrateurs.' }); return; }

    if (req.method === 'POST' && body.action === 'save') {
      const members = await R.roster();
      const slugs = {};
      members.forEach(function (m) { if (R.isActive(m)) slugs[m.slug] = 1; });
      const c = body.config || {};
      const prev = await R.loadConfig();
      // Règles remplacées en bloc (pas de fusion profonde : un % retiré doit disparaître).
      const patch = {
        leads: c.leads ? cleanRule(c.leads, true, slugs) : (prev.leads || null),
        selfBooking: c.selfBooking ? cleanRule(c.selfBooking, false, slugs) : (prev.selfBooking || null),
        updatedAt: Date.now(), updatedBy: auth.uid,
      };
      await db.collection('_config').doc('lead_routing').set(patch);
      res.status(200).json({ ok: true, config: patch });
      return;
    }

    if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

    const [cfg, members, snap] = await Promise.all([
      R.loadConfig(), R.roster(),
      db.collection('leads').where('createdAt', '>=', new Date(Date.now() - 30 * 86400000)).get(),
    ]);
    const stats = { leads: { total: 0, by: {} }, selfBooking: { total: 0, by: {} } };
    snap.forEach(function (d) {
      const l = d.data() || {};
      if (l._merged) return;
      const k = R.isSelfBorn(l) ? 'selfBooking' : 'leads';
      const who = l.assignedTo || '(non attribué)';
      stats[k].total++;
      stats[k].by[who] = (stats[k].by[who] || 0) + 1;
    });
    res.status(200).json({
      ok: true,
      config: cfg,
      members: members.filter(R.isActive).map(function (m) {
        return { slug: m.slug, name: m.shortName || m.displayName || m.fullName || m.slug, role: m.role || '', eligibleForLeads: m.eligibleForLeads === true, selfBookingOwner: m.selfBookingOwner === true };
      }),
      stats: stats,
    });
  } catch (e) {
    console.error('[lead-routing]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e), message: e && e.message });
  }
};
