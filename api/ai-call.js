// ============================================================================
// api/ai-call.js — FIN D'APPEL AUTOMATIQUE + NOTATION + CRÉNEAUX (Lot 4)
// ----------------------------------------------------------------------------
// Pour chaque appel Ringover transcrit (call_logs, transcription rapatriée par
// api/ringover-aftercall.js), UN appel Haiku produit :
//   • résumé, résultat, statut proposé, prochaine action datée ;
//   • objections (→ bibliothèque ai_objections, source 'setting') ;
//   • notation sur la grille de setting (CONTENU du discours uniquement —
//     jamais la voix ni le ton : AI Act, reconnaissance d'émotions interdite).
// Stockage :
//   call_logs/{id}.aiCall           — analyse complète (Réécoutes, feedback)
//   leads/{leadId}.aiLastCall       — PROPOSITION affichée dans la fiche Leads
//                                     Live ; le setter l'applique d'un clic
//                                     (mêmes boutons de statut / note que
//                                     d'habitude). Rien n'est appliqué seul.
//
// Appels :
//   GET  Bearer <CRON_SECRET>           (cron */10) → appels transcrits < 48 h
//   GET  Bearer <CRON_SECRET> ?job=stats (cron quotidien) → taux de décroché
//        par jour × heure (90 j) → ai_stats/call_slots (meilleur créneau)
//   POST Bearer <ID token> { action:'analyze', callId } (admin / sales)
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, cap, tsToMs } = require('./_ai');
const { OBJECTION_ITEM_SCHEMA, saveObjections } = require('./_aiObjections');
const { callTranscript } = require('./_aiLeadContext');
const { findLeadDoc } = require('./_leadLookup');

const ROLES = ['admin', 'sales'];
const BATCH = 15;
const MIN_DURATION = 30;
const STATUS_KEYS = ['appele', 'decroche', 'messagerie', 'nrp1', 'follow_up_pm', 'set', 'rdv_pose', 'pas_interesse', 'disqualifie', 'faux_numero'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resume', 'resultat', 'statutSuggere', 'prochaineAction', 'objections', 'notation'],
  properties: {
    resume: { type: 'string', description: '3 à 5 phrases : situation du prospect, ce qui s\'est dit, issue. Prêt à coller en note.' },
    resultat: { type: 'string', enum: ['rdv_pose', 'a_rappeler', 'pas_interesse', 'disqualifie', 'messagerie', 'faux_numero', 'autre'] },
    statutSuggere: { type: 'string', enum: STATUS_KEYS },
    prochaineAction: {
      type: 'object', additionalProperties: false, required: ['action', 'quand', 'message'],
      properties: {
        action: { type: 'string', description: 'Ex. « Rappeler », « Envoyer le lien de RDV », « Rien »' },
        quand: { type: 'string', description: 'Moment convenu avec le prospect si mentionné (ex. « jeudi 18h »), sinon vide' },
        message: { type: 'string', description: 'Si un SMS de suivi est utile : le texte (vouvoiement), sinon vide' },
      },
    },
    objections: { type: 'array', items: OBJECTION_ITEM_SCHEMA },
    notation: {
      type: 'object', additionalProperties: false, required: ['score', 'etapes', 'pointFort', 'axeProgres'],
      properties: {
        score: { type: 'integer', description: 'Note globale /100 de l\'appel, sur le CONTENU' },
        etapes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['etape', 'note', 'commentaire'],
            properties: { etape: { type: 'string' }, note: { type: 'integer', description: '0 à 10' }, commentaire: { type: 'string' } } },
        },
        pointFort: { type: 'string' },
        axeProgres: { type: 'string', description: 'LE conseil n°1, concret, avec la phrase à dire la prochaine fois' },
      },
    },
  },
};

const SYSTEM = [
  'Tu analyses la transcription d\'un appel de SETTING d\'Alteore (un setter appelle un entrepreneur pour lui poser un RDV de closing). Les locuteurs sont repérés par canal [n] : déduis qui est le setter.',
  'Produis : un résumé prêt à coller en note, le résultat, le statut CRM le plus juste, la prochaine action (avec le moment convenu s\'il a été dit), les objections du prospect (citation exacte), et une notation du setter.',
  'Notation : note chaque étape du SCRIPT DE SETTING décrit dans le contexte Alteore. À défaut : Accroche & permission, Découverte, Douleur & enjeux, Qualification (budget, décisionnaire, timing), Projection, Proposition du RDV, Verrouillage du RDV.',
  'Tu notes UNIQUEMENT le contenu de ce qui est dit (questions posées, reformulations, structure), jamais la voix, le ton ou l\'état émotionnel de quiconque.',
  'Statuts possibles : appele (appel sans suite claire), decroche (échange, à poursuivre), messagerie, nrp1 (pas de réponse), follow_up_pm (à rappeler à un moment convenu), set (RDV posé par téléphone), rdv_pose, pas_interesse, disqualifie (hors cible), faux_numero.',
  'Aucune invention. Français.',
].join('\n');

function parisParts(ms) {
  const d = new Date(ms);
  const wd = d.toLocaleDateString('en-GB', { timeZone: 'Europe/Paris', weekday: 'short' });
  const h = Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  return { wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), h: h };
}

async function analyzeCall(callId, uid) {
  const ref = db.collection('call_logs').doc(callId);
  const s = await ref.get();
  if (!s.exists) return { ok: false, error: 'call_not_found' };
  const c = s.data() || {};
  const tr = callTranscript(c);
  if (!tr || tr.length < 80) {
    await ref.set({ aiCall: { skipped: 'no_transcript', at: Date.now() } }, { merge: true });
    return { ok: false, error: 'no_transcript' };
  }

  // Lead : rattachement direct, sinon par numéro (appel entrant / synchronisé).
  let leadId = c.leadId || c.connectedLeadId || null;
  let leadDoc = null;
  try {
    const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    leadDoc = await findLeadDoc(leadId, null, other);
    if (leadDoc) leadId = leadDoc.id;
  } catch (e) { /* appel sans fiche : on analyse quand même */ }
  const lead = leadDoc ? (leadDoc.data() || {}) : null;

  const P = [];
  P.push('SETTER : ' + (c.userName || c.ringoverUserName || '?') + ' · appel ' + (c.direction || '') + ' · ' + (c.durationSec || 0) + ' s');
  if (lead) {
    P.push('PROSPECT : ' + (lead.nom || '?') + (lead.secteur ? ' · ' + cap(lead.secteur, 120) : '') + ' · statut actuel ' + (lead.status || 'nouveau'));
    if (lead.quiz && lead.quiz.pilier_prioritaire) P.push('Quiz : pilier prioritaire ' + lead.quiz.pilier_prioritaire + (lead.quiz.ca_mensuel ? ', CA ' + lead.quiz.ca_mensuel : ''));
  }
  P.push('');
  P.push('TRANSCRIPTION :');
  P.push(cap(tr, 60000));

  const r = await callClaude({ task: 'call_summary', system: SYSTEM, prompt: P.join('\n'), schema: SCHEMA, uid: uid || null, ref: 'call:' + callId });
  if (!r.ok) return r;
  const a = r.json || {};
  if (a.notation) a.notation.score = Math.max(0, Math.min(100, Math.round(Number(a.notation.score) || 0)));
  const at = tsToMs(c.initiatedAt || c.startTime) || Date.now();
  const aiCall = Object.assign({}, a, { leadId: leadId, setterUid: c.userId || null, setterName: c.userName || c.ringoverUserName || null, callAt: at, at: Date.now(), model: r.model || null });
  await ref.set({ aiCall: aiCall }, { merge: true });

  if (leadId && lead) {
    const prev = lead.aiLastCall;
    if (!prev || (prev.callAt || 0) <= at) {
      await db.collection('leads').doc(leadId).update({
        aiLastCall: { callId: callId, callAt: at, resume: a.resume, resultat: a.resultat, statutSuggere: a.statutSuggere,
          prochaineAction: a.prochaineAction, setter: aiCall.setterName, score: a.notation ? a.notation.score : null, at: Date.now() },
      });
    }
  }
  try {
    await saveObjections({ source: 'setting', sourceId: callId, leadId: leadId, who: aiCall.setterName, outcome: a.resultat === 'rdv_pose' ? 'rdv_pose' : null }, a.objections || []);
  } catch (e) { console.warn('[ai-call] objections', callId, e.message); }
  return { ok: true, aiCall: aiCall };
}

async function runStats(res) {
  const since = new Date(Date.now() - 90 * 86400000);
  const s = await db.collection('call_logs').where('initiatedAt', '>=', since).get();
  const buckets = {};
  s.forEach(function (d) {
    const c = d.data() || {};
    if (c.direction && c.direction !== 'outbound') return;
    const ms = tsToMs(c.initiatedAt);
    if (!ms) return;
    const p = parisParts(ms);
    if (p.wd < 0 || isNaN(p.h)) return;
    const k = p.wd + '-' + p.h;
    if (!buckets[k]) buckets[k] = { calls: 0, answered: 0 };
    buckets[k].calls++;
    if ((Number(c.durationSec) || 0) > 20) buckets[k].answered++;
  });
  await db.collection('ai_stats').doc('call_slots').set({ buckets: buckets, computedAt: Date.now(), sample: s.size });
  res.status(200).json({ ok: true, sample: s.size, buckets: Object.keys(buckets).length });
}

async function runCron(res) {
  const since = new Date(Date.now() - 48 * 3600000);
  const s = await db.collection('call_logs').where('initiatedAt', '>=', since).get();
  const todo = [];
  s.forEach(function (d) {
    const c = d.data() || {};
    if (c.aiCall) return;
    if ((Number(c.durationSec) || 0) < MIN_DURATION) return;
    if (!callTranscript(c)) return;
    todo.push(d.id);
  });
  const out = { ok: true, pending: todo.length, done: 0, errors: [] };
  for (let i = 0; i < todo.length && i < BATCH; i++) {
    try {
      const r = await analyzeCall(todo[i], null);
      if (r.ok) out.done++;
      else { out.errors.push(todo[i] + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; }
    } catch (e) { out.errors.push(todo[i] + ':' + e.message); }
  }
  res.status(200).json(out);
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      if (req.query && req.query.job === 'stats') await runStats(res);
      else await runCron(res);
    } catch (e) { console.error('[ai-call] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  if (body.action !== 'analyze' || !body.callId) { res.status(400).json({ ok: false, error: 'bad_request' }); return; }
  try {
    const r = await analyzeCall(String(body.callId), auth.uid);
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: r.error === 'no_transcript' ? 'Pas encore de transcription pour cet appel.' : humanError(r.error) }); return; }
    res.status(200).json({ ok: true, aiCall: r.aiCall });
  } catch (e) {
    console.error('[ai-call]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};

module.exports.parisParts = parisParts;
