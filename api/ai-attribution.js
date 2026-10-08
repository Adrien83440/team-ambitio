// ============================================================================
// api/ai-attribution.js — BOUCLE D'ATTRIBUTION MARKETING (Lot 5) — admins
// ----------------------------------------------------------------------------
// Relie la provenance des leads entrés sur la période (page / tunnel / quiz /
// variante VSL, ou campagne UTM) à ce qu'ils ont produit : RDV posés, RDV
// tenus, closes, CA contracté et encaissé (bookings.closeData), y compris les
// RDV pris jusqu'à 45 jours après la fin de la période.
//
// GET  ?from=AAAA-MM-JJ&to=AAAA-MM-JJ&dim=source|campaign → { rows, totals }
// POST { action:'recos', from, to, dim, spend:{ <clé de ligne>: € } }
//      → Opus : recommandations (couper / augmenter / tester), sur la base du
//        tableau + des dépenses publicitaires SAISIES par Adrien (facultatif).
//        RECOMMANDATIONS SEULEMENT.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError } = require('./_ai');

function parisMidnightMs(dateStr) {
  const p = String(dateStr).split('-').map(Number);
  const noon = Date.UTC(p[0], p[1] - 1, p[2], 12);
  const h = Number(new Date(noon).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  return Date.UTC(p[0], p[1] - 1, p[2]) - (h - 12) * 3600000;
}
function shift(d, n) { const p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10); }
function isCoaching(b) { return !!(b.isCoaching || b.clientId || b.source === 'csm_manual' || b.skipLeadCreation); }

function keyOf(l, dim) {
  if (dim === 'campaign') {
    const a = l.attributionFirst || {};
    return a.utm_campaign || (a.utm_source ? 'source:' + a.utm_source : '(sans campagne)');
  }
  const lf = l.landingFirst || {};
  return (lf.label ? lf.label + (lf.variant ? ' · ' + lf.variant : '') : '') || l.sourceDetail || l.type || l.source || '(inconnue)';
}

async function table(from, to, dim) {
  const s = await db.collection('leads').where('createdAt', '>=', new Date(parisMidnightMs(from))).where('createdAt', '<', new Date(parisMidnightMs(to) + 86400000)).get();
  const leadKey = {}, rows = {};
  function row(k) { return rows[k] || (rows[k] = { key: k, leads: 0, chauds: 0, rdv: 0, tenus: 0, closes: 0, contracte: 0, collecte: 0 }); }
  s.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged) return;
    const k = keyOf(l, dim);
    leadKey[d.id] = k;
    const r = row(k);
    r.leads++;
    if (l.aiLead && l.aiLead.niveau === 'chaud') r.chauds++;
  });
  const bs = await db.collection('bookings').where('date', '>=', from).where('date', '<=', shift(to, 45)).get();
  const seen = {};
  bs.forEach(function (d) {
    const b = d.data() || {};
    if (isCoaching(b) || !b.leadId || !leadKey[b.leadId] || b.rescheduled) return;
    const r = row(leadKey[b.leadId]);
    if (!seen[b.leadId]) { seen[b.leadId] = 1; r.rdv++; }
    if (b.outcome === 'close' || b.outcome === 'non_close' || b.outcome === 'offre') r.tenus++;
    if (b.outcome === 'close') {
      r.closes++;
      r.contracte += Number(b.closeData && b.closeData.contracte) || 0;
      r.collecte += Number(b.closeData && b.closeData.collecte) || 0;
    }
  });
  const list = Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return b.contracte - a.contracte || b.leads - a.leads; });
  const totals = list.reduce(function (t, r) { Object.keys(t).forEach(function (f) { t[f] += r[f]; }); return t; }, { leads: 0, chauds: 0, rdv: 0, tenus: 0, closes: 0, contracte: 0, collecte: 0 });
  return { rows: list, totals: totals };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthese', 'actions'],
  properties: {
    synthese: { type: 'string', description: '3 phrases : ce qui rapporte, ce qui coûte, la tendance' },
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'cible', 'pourquoi'],
        properties: { type: { type: 'string', enum: ['augmenter', 'couper', 'tester', 'surveiller', 'corriger_tracking'] }, cible: { type: 'string' }, pourquoi: { type: 'string' } },
      },
    },
  },
};

module.exports = async function (req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const q = req.method === 'GET' ? (req.query || {}) : parseBody(req);
  const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : shift(to, -60);
  const dim = q.dim === 'campaign' ? 'campaign' : 'source';
  try {
    const t = await table(from, to, dim);
    if (req.method === 'GET') { res.status(200).json(Object.assign({ ok: true, from: from, to: to, dim: dim }, t)); return; }
    if (q.action !== 'recos') { res.status(400).json({ ok: false, error: 'unknown_action' }); return; }
    const spend = q.spend && typeof q.spend === 'object' ? q.spend : {};
    const rows = t.rows.map(function (r) {
      const sp = Number(spend[r.key]) || 0;
      return Object.assign({}, r, sp ? { depense: sp, coutParLead: Math.round(sp / Math.max(1, r.leads)), coutParClose: r.closes ? Math.round(sp / r.closes) : null, roasContracte: Math.round(r.contracte / sp * 100) / 100 } : {});
    });
    const r = await callClaude({
      task: 'attribution',
      system: 'Tu es le directeur marketing d\'Alteore (acquisition par Meta Ads → VSL / quiz / webinaire / tunnels → setting → closing). À partir du tableau d\'attribution (et des dépenses saisies quand il y en a), recommande où augmenter, couper, tester ou surveiller. Tiens compte des petits échantillons (ne tire pas de conclusion sur 3 leads). Si des lignes ressemblent à un problème de tracking (beaucoup de « inconnue »), dis-le. RECOMMANDATIONS seulement.',
      prompt: 'Période ' + from + ' → ' + to + ' · dimension ' + dim + ' (RDV comptés jusqu\'à 45 j après la période)\n' + JSON.stringify({ lignes: rows, totaux: t.totals }),
      schema: SCHEMA,
      uid: auth.uid,
      ref: 'attribution:' + from + ':' + to,
    });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    const doc = Object.assign({}, r.json, { from: from, to: to, dim: dim, generatedAt: Date.now() });
    await db.collection('ai_attribution').doc(from + '_' + to + '_' + dim).set(doc);
    res.status(200).json({ ok: true, recos: doc });
  } catch (e) {
    console.error('[ai-attribution]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
