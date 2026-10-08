// ============================================================================
// api/ai-setter-feedback.js — FEEDBACK QUOTIDIEN DES SETTERS (Lot 4)
// ----------------------------------------------------------------------------
// Chaque soir (cron 17:30 UTC ≈ 18h30-19h30 Paris), pour chaque setter qui a
// des appels notés dans la journée (call_logs.aiCall, api/ai-call.js), Haiku
// synthétise 3 conseils concrets + ce qui a bien marché, à partir des
// notations (contenu du discours uniquement).
// Stocké dans ai_feedback/{YYYY-MM-DD}_{uid}. Lu par ai-feedback-widget.js
// (page Set NB) et par le brief du matin des admins.
//
// GET  Bearer <CRON_SECRET>                  → génère le feedback du jour
// POST Bearer <ID token> { action:'mine', date? } → mon feedback (sales) ;
//      admin : { action:'team', date? } → tous les feedbacks du jour
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, cap, tsToMs } = require('./_ai');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bravo', 'conseils', 'phraseDuJour'],
  properties: {
    bravo: { type: 'string', description: 'Ce qui a bien marché aujourd\'hui, 1-2 phrases, concret' },
    conseils: { type: 'array', items: { type: 'string' }, description: 'Exactement 3 conseils concrets pour demain' },
    phraseDuJour: { type: 'string', description: 'Une phrase à essayer demain (formulation prête à dire)' },
  },
};

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function parisMidnightMs(dateStr) {
  const p = dateStr.split('-').map(Number);
  const noon = Date.UTC(p[0], p[1] - 1, p[2], 12);
  const h = Number(new Date(noon).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  return Date.UTC(p[0], p[1] - 1, p[2]) - (h - 12) * 3600000;
}

async function generate(date) {
  const start = parisMidnightMs(date);
  const s = await db.collection('call_logs').where('initiatedAt', '>=', new Date(start)).where('initiatedAt', '<', new Date(start + 86400000)).get();
  const by = {};
  s.forEach(function (d) {
    const c = d.data() || {};
    const a = c.aiCall;
    if (!a || !a.notation || !c.userId) return;
    if (!by[c.userId]) by[c.userId] = { name: c.userName || a.setterName || '', calls: [] };
    by[c.userId].calls.push(a);
  });
  const out = { setters: 0, errors: [] };
  for (const uid of Object.keys(by)) {
    const g = by[uid];
    const scores = g.calls.map(function (a) { return a.notation.score || 0; });
    const avg = Math.round(scores.reduce(function (x, y) { return x + y; }, 0) / scores.length);
    const lines = g.calls.slice(0, 25).map(function (a, i) {
      return (i + 1) + '. ' + a.notation.score + '/100 · ' + (a.resultat || '') + ' · fort : ' + cap(a.notation.pointFort, 160) + ' · à travailler : ' + cap(a.notation.axeProgres, 220);
    });
    const r = await callClaude({
      task: 'call_rating',
      system: 'Tu es le coach des setters d\'Alteore. À partir des notations des appels du jour d\'un setter (contenu du discours uniquement), écris un feedback bienveillant et exigeant : ce qui a bien marché, exactement 3 conseils concrets pour demain (les plus impactants, sans répéter), et une phrase à essayer. Tutoiement, ton d\'équipe.',
      prompt: 'SETTER : ' + g.name + '\nAPPELS NOTÉS : ' + g.calls.length + ' · moyenne ' + avg + '/100\n' + lines.join('\n'),
      schema: SCHEMA,
      ref: 'feedback:' + date + ':' + uid,
    });
    if (!r.ok) { out.errors.push(uid + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; continue; }
    await db.collection('ai_feedback').doc(date + '_' + uid).set(Object.assign({}, r.json, { date: date, uid: uid, name: g.name, calls: g.calls.length, avg: avg, generatedAt: Date.now() }));
    out.setters++;
  }
  return out;
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.status(200).json(Object.assign({ ok: true }, await generate(parisDate(Date.now())))); }
    catch (e) { console.error('[ai-setter-feedback] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  try {
    if (body.action === 'team' && auth.role === 'admin') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : parisDate(Date.now());
      const s = await db.collection('ai_feedback').where('date', '==', date).get();
      const items = []; s.forEach(function (d) { items.push(d.data()); });
      res.status(200).json({ ok: true, items: items });
      return;
    }
    // Le plus récent feedback de l'utilisateur (aujourd'hui ou les jours précédents).
    const s = await db.collection('ai_feedback').where('uid', '==', auth.uid).get();
    let best = null;
    s.forEach(function (d) { const f = d.data() || {}; if (!best || String(f.date) > String(best.date)) best = f; });
    res.status(200).json({ ok: true, feedback: best });
  } catch (e) {
    console.error('[ai-setter-feedback]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
