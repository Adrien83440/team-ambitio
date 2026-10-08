// ============================================================================
// api/ai-lead.js — SCORE IA + BRIEF PRÉ-APPEL D'UN LEAD (Lot 1)
// ----------------------------------------------------------------------------
// Un seul appel Haiku produit, pour un lead :
//   • proba     : probabilité (0-100) que le lead prenne / honore un RDV ;
//   • niveau    : chaud | tiède | froid ;
//   • raison    : pourquoi ce score, en une phrase ;
//   • angle     : l'angle d'accroche conseillé ;
//   • ouverture : la phrase d'ouverture à dire au décroché ;
//   • brief     : 3 lignes « qui est-ce / ce qu'il a fait / ce qu'il veut ».
// Stocké sur leads/{id}.aiLead = { …, key, generatedAt, model }.
// `key` = aiLeadKey() (cf. _aiLeadContext.js) : le front ne redemande un score
// que si la fiche a bougé (nouvel échange, note, statut).
//
// Écrit UNIQUEMENT le champ aiLead : aucun trigger leads/{id} ne réagit à ce
// champ (vérifié : onLeadNoteMentionNotify, resurrectLeadOnReengagement).
//
// Appels :
//   POST  Bearer <ID token>  { leadId, force? }  → rôles admin / sales
//   GET   Bearer <CRON_SECRET>  (cron */10)      → score les leads récents
//         sans aiLead (créés < 72 h, 15 max par passage)
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, tsToMs } = require('./_ai');
const { loadLeadBundle, bundleToText, aiLeadKey } = require('./_aiLeadContext');

const ROLES = ['admin', 'sales'];
const CRON_BATCH = 15;
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// ── Meilleur créneau de rappel (Lot 4) — statistique, sans IA ──────────────
// 1. Le lead a déjà décroché : on reprend le jour / l'heure de ses décrochés.
// 2. Sinon : meilleur taux de décroché de l'équipe (ai_stats/call_slots, 90 j,
//    calculé chaque nuit par api/ai-call.js?job=stats), heures 9 h-20 h.
let _slotsCache = null, _slotsAt = 0;
async function teamSlots() {
  if (_slotsCache && Date.now() - _slotsAt < 10 * 60000) return _slotsCache;
  try {
    const s = await db.collection('ai_stats').doc('call_slots').get();
    _slotsCache = s.exists ? (s.data().buckets || {}) : {};
  } catch (e) { _slotsCache = {}; }
  _slotsAt = Date.now();
  return _slotsCache;
}
function parisWdH(ms) {
  const d = new Date(ms);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d.toLocaleDateString('en-GB', { timeZone: 'Europe/Paris', weekday: 'short' }));
  return { wd: wd, h: Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false })) };
}
async function bestSlot(bundle) {
  const own = {};
  bundle.calls.forEach(function (c) {
    if ((Number(c.durationSec) || 0) <= 20) return;
    const ms = tsToMs(c.initiatedAt || c.startTime);
    if (!ms) return;
    const p = parisWdH(ms);
    const k = p.wd + '-' + p.h;
    own[k] = (own[k] || 0) + 1;
  });
  const ownKeys = Object.keys(own).sort(function (a, b) { return own[b] - own[a]; });
  if (ownKeys.length) {
    const p = ownKeys[0].split('-').map(Number);
    return 'A déjà décroché le ' + DAYS[p[0]] + ' vers ' + p[1] + ' h';
  }
  const b = await teamSlots();
  let best = null;
  Object.keys(b).forEach(function (k) {
    const p = k.split('-').map(Number);
    if (p[0] === 0 || p[1] < 9 || p[1] > 20) return;
    const x = b[k];
    if (!x || x.calls < 15) return;
    const rate = x.answered / x.calls;
    if (!best || rate > best.rate) best = { wd: p[0], h: p[1], rate: rate };
  });
  return best ? 'Meilleur créneau équipe : ' + DAYS[best.wd] + ' ' + best.h + ' h (' + Math.round(best.rate * 100) + ' % de décroché)' : '';
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proba', 'niveau', 'raison', 'angle', 'ouverture', 'brief'],
  properties: {
    proba: { type: 'integer', description: 'Probabilité 0-100 que ce lead prenne et honore un RDV de closing' },
    niveau: { type: 'string', enum: ['chaud', 'tiède', 'froid'] },
    raison: { type: 'string', description: 'Une phrase : les signaux qui justifient le score' },
    angle: { type: 'string', description: 'Angle d\'accroche conseillé, une phrase' },
    ouverture: { type: 'string', description: 'Phrase d\'ouverture à dire au décroché, tutoiement interdit, naturelle' },
    brief: { type: 'array', items: { type: 'string' }, description: 'Exactement 3 lignes courtes' },
  },
};

const SYSTEM = [
  'Tu es l\'assistant des setters d\'Alteore. Un setter appelle des prospects (entrepreneurs) qui ont laissé leurs coordonnées, pour leur poser un rendez-vous de closing.',
  'À partir du dossier du prospect, tu produis :',
  '1. proba : la probabilité (0 à 100) qu\'il prenne ET honore un RDV. Signaux positifs : quiz complété avec un défi clair, CA significatif, message détaillé, ré-opt-ins multiples, RDV déjà pris par lui-même, échanges récents positifs. Signaux négatifs : appels sans réponse répétés, refus exprimé, hors cible, coordonnées douteuses, aucune info.',
  '2. niveau : chaud (≥ 60), tiède (30-59), froid (< 30).',
  '3. raison : une phrase factuelle citant les 2-3 signaux décisifs.',
  '4. angle : l\'angle d\'accroche le plus pertinent pour CE prospect (son défi, son secteur, ce qu\'il a regardé).',
  '5. ouverture : la première phrase à dire au décroché, au vouvoiement, naturelle, qui montre qu\'on connaît sa demande.',
  '6. brief : exactement 3 lignes de 15 mots max — « Qui » (profil), « Parcours » (ce qu\'il a fait chez nous), « Attente » (ce qu\'il cherche / point de vigilance).',
  'Règles : n\'invente rien qui ne soit pas dans le dossier. Si le dossier est quasi vide, dis-le et mets une proba basse. Français, phrases courtes.',
].join('\n');

async function scoreLead(leadId, uid) {
  const bundle = await loadLeadBundle(leadId);
  if (!bundle) return { ok: false, error: 'lead_not_found' };
  if (bundle.lead._merged === true) return { ok: false, error: 'lead_merged' };

  const r = await callClaude({
    task: 'lead_score',
    system: SYSTEM,
    prompt: bundleToText(bundle, { maxCalls: 3, transcriptChars: 1800 }),
    schema: SCHEMA,
    uid: uid || null,
    ref: 'lead:' + leadId,
  });
  if (!r.ok) return r;

  const j = r.json || {};
  const proba = Math.max(0, Math.min(100, Math.round(Number(j.proba) || 0)));
  const aiLead = {
    proba: proba,
    niveau: proba >= 60 ? 'chaud' : (proba >= 30 ? 'tiède' : 'froid'),
    raison: String(j.raison || '').slice(0, 400),
    angle: String(j.angle || '').slice(0, 400),
    ouverture: String(j.ouverture || '').slice(0, 400),
    brief: (Array.isArray(j.brief) ? j.brief : []).slice(0, 3).map(function (s) { return String(s).slice(0, 200); }),
    creneau: await bestSlot(bundle).catch(function () { return ''; }),
    key: aiLeadKey(bundle.lead),
    generatedAt: Date.now(),
    model: r.model || null,
  };
  await db.collection('leads').doc(leadId).update({ aiLead: aiLead });
  return { ok: true, aiLead: aiLead };
}

async function runCron(res) {
  const since = new Date(Date.now() - 72 * 3600 * 1000);
  const snap = await db.collection('leads').where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(200).get();
  const todo = [];
  snap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true || l.isClient === true) return;
    if (l.aiLead && l.aiLead.key === aiLeadKey(l)) return;
    // Laisse 2 min à onNewLead pour fusionner un éventuel doublon.
    if (Date.now() - tsToMs(l.createdAt) < 2 * 60 * 1000) return;
    todo.push(d.id);
  });
  const done = [], errors = [];
  for (let i = 0; i < todo.length && i < CRON_BATCH; i++) {
    try {
      const r = await scoreLead(todo[i], null);
      if (r.ok) done.push(todo[i]);
      else {
        errors.push(todo[i] + ':' + r.error);
        if (r.error === 'ai_budget_exceeded' || r.error === 'ai_disabled' || r.error === 'ai_task_disabled') break;
      }
    } catch (e) { errors.push(todo[i] + ':' + (e && e.message)); }
  }
  res.status(200).json({ ok: true, pending: todo.length, scored: done.length, errors: errors });
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try { await runCron(res); }
    catch (e) { console.error('[ai-lead] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  const body = parseBody(req);
  const leadId = String(body.leadId || '').trim();
  if (!leadId) { res.status(400).json({ ok: false, error: 'leadId_required' }); return; }

  try {
    if (body.force !== true) {
      const s = await db.collection('leads').doc(leadId).get();
      if (!s.exists) { res.status(404).json({ ok: false, error: 'lead_not_found' }); return; }
      const l = s.data() || {};
      if (l.aiLead && l.aiLead.key === aiLeadKey(l)) { res.status(200).json({ ok: true, cached: true, aiLead: l.aiLead }); return; }
    }
    const r = await scoreLead(leadId, auth.uid);
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    res.status(200).json({ ok: true, cached: false, aiLead: r.aiLead });
  } catch (e) {
    console.error('[ai-lead]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
