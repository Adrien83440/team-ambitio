// ============================================================================
// api/ai-closing-prep.js — DOSSIER DE PRÉPARATION AU CLOSING (Lot 2)
// ----------------------------------------------------------------------------
// Avant un RDV de closing, Opus lit TOUT le dossier du prospect (fiche, quiz,
// formulaire, notes, notes vocales, transcriptions des appels de setting,
// RDV précédents) et produit un dossier :
//   résumé, douleurs (dans ses mots), motivations, objections probables avec
//   réponse conseillée, offre conseillée, plan d'attaque, questions de
//   découverte, points de vigilance.
// Stocké sur bookings/{id}.aiPrep.
//
// Appels :
//   POST Bearer <ID token> { bookingId, force? } → rôles admin / sales
//   GET  Bearer <CRON_SECRET> (cron */15) → prépare les RDV qui commencent
//        dans les 100 prochaines minutes (4 max par passage).
// Périmètre : RDV de closing = MT.isClosingBooking (hors coaching / clients).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, cap } = require('./_ai');
const { loadLeadBundle, bundleToText } = require('./_aiLeadContext');
const MT = require('./_meetTranscript');

const ROLES = ['admin', 'sales'];
const CRON_BATCH = 4;
const LEAD_MIN = 100;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resume', 'douleurs', 'motivations', 'objectionsProbables', 'offreConseillee', 'planAttaque', 'questions', 'vigilance'],
  properties: {
    resume: { type: 'string', description: '3 phrases : qui il est, où il en est, pourquoi il vient' },
    douleurs: { type: 'array', items: { type: 'string' }, description: 'Ses douleurs, au plus près de SES mots (citations quand elles existent)' },
    motivations: { type: 'array', items: { type: 'string' } },
    objectionsProbables: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['objection', 'pourquoi', 'reponse'],
        properties: { objection: { type: 'string' }, pourquoi: { type: 'string', description: 'Signal du dossier qui la laisse prévoir' }, reponse: { type: 'string', description: 'Réponse conseillée, prête à dire' } },
      },
    },
    offreConseillee: {
      type: 'object', additionalProperties: false, required: ['offre', 'pourquoi'],
      properties: { offre: { type: 'string' }, pourquoi: { type: 'string' } },
    },
    planAttaque: { type: 'array', items: { type: 'string' }, description: '4 à 6 étapes concrètes pour CE closing' },
    questions: { type: 'array', items: { type: 'string' }, description: '3 à 5 questions de découverte à poser absolument' },
    vigilance: { type: 'array', items: { type: 'string' }, description: 'Points de vigilance (budget, décisionnaire, no-show passé…)' },
  },
};

const SYSTEM = [
  'Tu prépares un closer d\'Alteore à un RDV de closing qui commence bientôt. Il a 2 minutes pour lire ton dossier.',
  'Tu reçois tout le dossier du prospect : fiche, quiz, formulaire, notes de l\'équipe, notes vocales, transcriptions des appels de setting, RDV précédents.',
  'Produis un dossier actionnable : douleurs et motivations dans SES mots, objections probables (avec le signal qui les laisse prévoir et la réponse conseillée), l\'offre la plus adaptée parmi celles du contexte Alteore (avec la raison), un plan d\'attaque, les questions à poser, les points de vigilance.',
  'Règles : appuie-toi uniquement sur le dossier et le contexte Alteore ; si une info manque (budget, décisionnaire…), mets-la en vigilance au lieu de l\'inventer. Français, phrases courtes.',
].join('\n');

function prospectName(b) {
  const p = b.prospect || {};
  return ((p.prenom || '') + ' ' + (p.nom || '')).trim() || p.email || '?';
}

async function buildPrep(bookingId, b, uid) {
  const P = [];
  P.push('RDV : ' + (b.date || '?') + ' ' + (b.time || '') + ' · ' + (b.typeLabel || b.type || 'closing') + ' · closer ' + (b.personName || '?'));
  P.push('PROSPECT : ' + prospectName(b) + (b.prospect && b.prospect.secteur ? ' · ' + b.prospect.secteur : ''));
  if (b.prospect && b.prospect.message) P.push('MESSAGE À LA RÉSERVATION : ' + cap(b.prospect.message, 800));
  (b.formAnswers || []).slice(0, 20).forEach(function (a) {
    const v = Array.isArray(a.value) ? a.value.join(', ') : a.value;
    if (v != null && String(v).trim()) P.push('- ' + cap(a.label, 120) + ' : ' + cap(v, 300));
  });
  if (b.leadId) {
    const bundle = await loadLeadBundle(b.leadId);
    if (bundle) {
      P.push('');
      P.push(bundleToText(bundle, { maxCalls: 5, transcriptChars: 9000 }));
    }
  }
  const r = await callClaude({
    task: 'closing_prep',
    system: SYSTEM,
    prompt: P.join('\n'),
    schema: SCHEMA,
    uid: uid || null,
    ref: 'booking:' + bookingId,
  });
  if (!r.ok) return r;
  const prep = Object.assign({}, r.json, { generatedAt: Date.now(), model: r.model || null });
  await db.collection('bookings').doc(bookingId).set({ aiPrep: prep }, { merge: true });
  return { ok: true, prep: prep };
}

function today(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

async function runCron(res) {
  const typeMap = await MT.loadTypeMap();
  const s = await db.collection('bookings').where('date', 'in', [today(0), today(1)]).get();
  const now = Date.now();
  const todo = [];
  s.forEach(function (d) {
    const b = d.data() || {};
    if (b.aiPrep || !b.leadId) return;
    if (b.status === 'cancelled' || b.outcome) return;
    if (!MT.isClosingBooking(b, typeMap)) return;
    const start = MT.bookingStartMs(b);
    if (!start || start < now - 10 * 60000 || start > now + LEAD_MIN * 60000) return;
    todo.push({ id: d.id, b: b, start: start });
  });
  todo.sort(function (a, b) { return a.start - b.start; });
  const out = { ok: true, candidates: todo.length, done: 0, errors: [] };
  for (let i = 0; i < todo.length && i < CRON_BATCH; i++) {
    try {
      const r = await buildPrep(todo[i].id, todo[i].b, null);
      if (r.ok) out.done++;
      else { out.errors.push(todo[i].id + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; }
    } catch (e) { out.errors.push(todo[i].id + ':' + e.message); }
  }
  res.status(200).json(out);
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { await runCron(res); } catch (e) { console.error('[ai-closing-prep] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  const bookingId = String(body.bookingId || '').trim();
  if (!bookingId) { res.status(400).json({ ok: false, error: 'bookingId_required' }); return; }
  try {
    const snap = await db.collection('bookings').doc(bookingId).get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'booking_not_found' }); return; }
    const b = snap.data() || {};
    if (b.aiPrep && body.force !== true) { res.status(200).json({ ok: true, cached: true, prep: b.aiPrep, prospect: prospectName(b) }); return; }
    const r = await buildPrep(bookingId, b, auth.uid);
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    res.status(200).json({ ok: true, cached: false, prep: r.prep, prospect: prospectName(b) });
  } catch (e) {
    console.error('[ai-closing-prep]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
