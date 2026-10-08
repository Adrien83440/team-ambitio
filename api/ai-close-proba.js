// ============================================================================
// api/ai-close-proba.js — PROBABILITÉ DE CLOSE PAR DEAL (programme IA, Lot 2)
// ----------------------------------------------------------------------------
// Pour les leads en phase closing (SET, RDV posé / confirmé, follow-up
// closing, no-show à replanifier), Haiku estime la probabilité de signer et
// la raison en une phrase. Stocké sur leads/{id}.aiClose { proba, raison,
// key, generatedAt } ; affiché en pastille discrète sur le kanban.
// Recalculé seulement quand la fiche bouge (key = aiLeadKey + nb de RDV).
// N'écrit QUE le champ aiClose (aucun trigger leads/{id} n'y réagit).
//
// GET Bearer <CRON_SECRET> (cron horaire) — 20 leads max par passage.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { callClaude } = require('./_ai');
const { loadLeadBundle, bundleToText, aiLeadKey } = require('./_aiLeadContext');

const STAGES = ['set', 'rdv_self_booking', 'rdv_confirmes', 'follow_up_closing', 'no_show_self', 'no_show_setting'];
const BATCH = 20;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proba', 'raison'],
  properties: {
    proba: { type: 'integer', description: 'Probabilité 0-100 que ce prospect signe dans les 30 jours' },
    raison: { type: 'string', description: 'Une phrase : les 2 signaux décisifs' },
  },
};

const SYSTEM = 'Tu estimes la probabilité qu\'un prospect d\'Alteore signe dans les 30 jours, à partir de son dossier (RDV, issues, échanges, notes, transcriptions). ' +
  'Signaux forts : RDV de closing confirmé et honoré, offre faite et prospect en réflexion active, budget et décisionnaire confirmés, réponses rapides. ' +
  'Signaux faibles : no-show, annulations répétées, silence après relance, objection prix non levée, hors cible. N\'invente rien. Réponse courte.';

function closeKey(l) { return aiLeadKey(l) + ':' + ((l.bookingsHistory || []).length); }

module.exports = async function (req, res) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const out = { ok: true, candidates: 0, scored: 0, errors: [] };
  try {
    const snap = await db.collection('leads').where('stage', 'in', STAGES).limit(800).get();
    const todo = [];
    snap.forEach(function (d) {
      const l = d.data() || {};
      if (l._merged === true || l.isClient === true) return;
      if (l.aiClose && l.aiClose.key === closeKey(l)) return;
      todo.push({ id: d.id, l: l });
    });
    out.candidates = todo.length;
    for (let i = 0; i < todo.length && i < BATCH; i++) {
      const bundle = await loadLeadBundle(todo[i].id);
      if (!bundle) continue;
      const r = await callClaude({
        task: 'close_probability', system: SYSTEM,
        prompt: bundleToText(bundle, { maxCalls: 2, transcriptChars: 1500 }),
        schema: SCHEMA, ref: 'lead:' + todo[i].id,
      });
      if (!r.ok) { out.errors.push(todo[i].id + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; continue; }
      const proba = Math.max(0, Math.min(100, Math.round(Number(r.json.proba) || 0)));
      await db.collection('leads').doc(todo[i].id).update({
        aiClose: { proba: proba, raison: String(r.json.raison || '').slice(0, 300), key: closeKey(bundle.lead), generatedAt: Date.now() },
      });
      out.scored++;
    }
    res.status(200).json(out);
  } catch (e) {
    console.error('[ai-close-proba]', e);
    res.status(200).json({ ok: false, error: e.message });
  }
};
