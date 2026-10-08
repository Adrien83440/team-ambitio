// ============================================================================
// api/ai-objections.js — BIBLIOTHÈQUE D'OBJECTIONS (programme IA, Lot 2)
// ----------------------------------------------------------------------------
// GET  ?days=90&source=closing|setting   → rôles admin / sales
//      { categories, counts, items[≤600], playbooks }
// POST { action:'playbook', category }    → rôles admin / sales
//      Opus synthétise, pour une catégorie, les réponses qui ont marché
//      (worked / close) en un mini-playbook stocké dans
//      ai_objection_playbooks/{category}.
// Lecture via Admin SDK : aucune règle Firestore à ouvrir.
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, cap } = require('./_ai');
const { CATEGORIES } = require('./_aiObjections');

const ROLES = ['admin', 'sales', 'coach', 'csm']; // ouvert à toute l'équipe (08/10/2026)

const PLAYBOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vraiSens', 'reponses', 'aEviter'],
  properties: {
    vraiSens: { type: 'string', description: 'Ce que cache le plus souvent cette objection chez nos prospects, 2 phrases' },
    reponses: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['titre', 'formulation', 'preuve'],
        properties: {
          titre: { type: 'string' },
          formulation: { type: 'string', description: 'Formulation prête à dire, au vouvoiement' },
          preuve: { type: 'string', description: 'Sur quels échanges réels elle s\'appuie (combien de fois elle a marché)' },
        },
      },
    },
    aEviter: { type: 'array', items: { type: 'string' } },
  },
};

async function loadItems(days, source) {
  let q = db.collection('ai_objections');
  if (days > 0) q = q.where('at', '>=', Date.now() - days * 24 * 3600 * 1000);
  const s = await q.orderBy('at', 'desc').limit(600).get();
  const items = [];
  s.forEach(function (d) {
    const o = d.data() || {};
    if (source && o.source !== source) return;
    items.push({ id: d.id, category: o.category, label: o.label, quote: o.quote, response: o.response, worked: o.worked === true,
      outcome: o.outcome || null, source: o.source, who: o.who || null, leadId: o.leadId || null, bookingId: o.bookingId || null, at: o.at });
  });
  return items;
}

module.exports = async function (req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  try {
    if (req.method === 'GET') {
      const days = Math.max(0, Math.min(3650, Number((req.query && req.query.days) || 90) || 0));
      const source = (req.query && (req.query.source === 'closing' || req.query.source === 'setting')) ? req.query.source : '';
      const [items, pbSnap] = await Promise.all([loadItems(days, source), db.collection('ai_objection_playbooks').get()]);
      const counts = {};
      Object.keys(CATEGORIES).forEach(function (k) { counts[k] = { total: 0, worked: 0, closes: 0 }; });
      items.forEach(function (o) {
        const c = counts[o.category] || counts.autre;
        c.total++;
        if (o.worked) c.worked++;
        if (o.outcome === 'close') c.closes++;
      });
      const playbooks = {};
      pbSnap.forEach(function (d) { playbooks[d.id] = d.data(); });
      res.status(200).json({ ok: true, categories: CATEGORIES, counts: counts, items: items, playbooks: playbooks });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
    const body = parseBody(req);
    if (body.action !== 'playbook' || !CATEGORIES[body.category]) { res.status(400).json({ ok: false, error: 'bad_request' }); return; }

    const all = (await loadItems(365, '')).filter(function (o) { return o.category === body.category; });
    if (all.length < 3) { res.status(200).json({ ok: false, error: 'not_enough_data', message: 'Pas assez d\'objections de ce type pour une synthèse (3 minimum).' }); return; }
    // Les réponses qui ont marché d'abord, puis les échecs (pour la liste « à éviter »).
    all.sort(function (a, b) { return (b.worked ? 1 : 0) + (b.outcome === 'close' ? 1 : 0) - (a.worked ? 1 : 0) - (a.outcome === 'close' ? 1 : 0); });
    const lines = all.slice(0, 80).map(function (o, i) {
      return (i + 1) + '. [' + (o.worked ? 'A MARCHÉ' : 'N\'A PAS MARCHÉ') + (o.outcome ? ' · issue ' + o.outcome : '') + ' · ' + o.source + ']\n' +
        '   Prospect : « ' + cap(o.quote, 300) + ' »\n   Réponse : ' + (cap(o.response, 400) || '(aucune)');
    });

    const r = await callClaude({
      task: 'objection_playbook',
      system: 'Tu es le coach commercial d\'Alteore. À partir d\'objections RÉELLES de nos prospects et des réponses de l\'équipe, tu écris un mini-playbook pour l\'objection « ' + CATEGORIES[body.category] + ' » : ce qu\'elle cache vraiment, 2 à 4 réponses qui ont fait leurs preuves (formulations prêtes à dire, fondées sur les échanges qui ont marché), et ce qu\'il faut éviter (tiré des échecs). N\'invente aucun échange ; si les données sont minces, dis-le dans « preuve ».',
      prompt: lines.join('\n'),
      schema: PLAYBOOK_SCHEMA,
      uid: auth.uid,
      ref: 'objections:' + body.category,
    });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    const pb = Object.assign({}, r.json, { category: body.category, basedOn: all.length, generatedAt: Date.now(), model: r.model || null });
    await db.collection('ai_objection_playbooks').doc(body.category).set(pb);
    res.status(200).json({ ok: true, playbook: pb });
  } catch (e) {
    console.error('[ai-objections]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
