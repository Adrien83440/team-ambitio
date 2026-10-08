// ============================================================================
// api/ai-ask.js — « DEMANDE À ALTEORE » (programme IA, Lot 5) — admins
// ----------------------------------------------------------------------------
// Chat (vocal ou texte) sur les données d'Alteore. Opus 5.5 répond en
// s'appuyant sur des outils en LECTURE SEULE (api/_aiTools.js — les mêmes que
// le serveur MCP). Boucle d'outils limitée à 6 tours.
//
// POST Bearer <ID token admin>
//   { history:[{ role:'user'|'assistant', text }], question, voice? }
//   → { ok, answer, tools:[noms utilisés] }
// `voice: true` → réponse courte, sans mise en forme, faite pour être lue à
// voix haute (ElevenLabs, api/ai-voice.js).
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { callClaude, humanError, cap } = require('./_ai');
const { claudeTools, runTool } = require('./_aiTools');

const MAX_TURNS = 6;

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  const question = String(body.question || '').trim().slice(0, 2000);
  if (!question) { res.status(400).json({ ok: false, error: 'question_required' }); return; }

  const today = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const iso = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  const system = [
    'Tu es « Alteore », l\'assistant IA des dirigeants d\'Alteore (Adrien, Emily, Vincent). Nous sommes le ' + today + ' (' + iso + ').',
    'Tu réponds à leurs questions sur l\'activité en interrogeant les outils (lecture seule). Utilise les outils dès qu\'une question porte sur des chiffres, des personnes ou des dossiers : ne réponds jamais de mémoire sur les données.',
    'Calcule toi-même les taux et comparaisons à partir des résultats. Si une donnée n\'existe pas dans les outils, dis-le simplement.',
    body.voice
      ? 'MODE VOCAL : ta réponse sera lue à voix haute. 2 à 4 phrases maximum, naturelles, sans liste, sans markdown, sans emoji ; arrondis les chiffres ; termine par une piste d\'action si c\'est utile.'
      : 'Réponse claire et concise ; listes courtes autorisées ; chiffres précis.',
  ].join('\n');

  const messages = [];
  (Array.isArray(body.history) ? body.history : []).slice(-10).forEach(function (m) {
    if (!m || !m.text) return;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: cap(m.text, 4000) });
  });
  // L'API exige d'alterner et de commencer par l'utilisateur.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
  messages.push({ role: 'user', content: question });

  const used = [];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await callClaude({ task: 'ask_alteore', system: system, messages: messages, tools: claudeTools(), uid: auth.uid, ref: 'ask' });
      if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
      if (r.stopReason !== 'tool_use') {
        res.status(200).json({ ok: true, answer: r.text || '(pas de réponse)', tools: used });
        return;
      }
      // Rejouer le contenu complet de l'assistant (blocs de réflexion compris),
      // puis TOUS les résultats d'outils dans un seul message utilisateur.
      messages.push({ role: 'assistant', content: r.content });
      const calls = r.content.filter(function (b) { return b.type === 'tool_use'; });
      const results = await Promise.all(calls.map(async function (c) {
        used.push(c.name);
        const out = await runTool(c.name, c.input);
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 60000), is_error: !!(out && out.error) };
      }));
      messages.push({ role: 'user', content: results });
    }
    res.status(200).json({ ok: true, answer: 'Je n\'ai pas réussi à conclure en un nombre raisonnable d\'étapes. Peux-tu préciser la question ?', tools: used });
  } catch (e) {
    console.error('[ai-ask]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
