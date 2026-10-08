// ============================================================================
// api/ai-message.js — ASSISTANT SMS / DM (programme IA, Lot 4)
// ----------------------------------------------------------------------------
// Propose 3 réponses au setter / closer. Ce ne sont QUE des propositions :
// elles s'insèrent dans le composeur (SMS) ou se copient (DM Instagram),
// l'humain les modifie et envoie lui-même.
//
// POST Bearer <ID token> (admin / sales)
//   { leadId, channel:'sms'|'dm', conversation?, intent? }
//     channel 'sms' : contexte = fiche + derniers SMS/WhatsApp du lead
//     channel 'dm'  : conversation Instagram COLLÉE par le setter (rôle
//                     setter_ecrit — Steven, Valentin) ; leadId facultatif
//   → { ok, suggestions:[{ texte, intention }] }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { callClaude, humanError, cap } = require('./_ai');
const { loadLeadBundle, bundleToText } = require('./_aiLeadContext');

const ROLES = ['admin', 'sales'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['intention', 'texte'],
        properties: {
          intention: { type: 'string', description: 'En 3-5 mots : l\'angle de ce message (ex. « Relance douce », « Poser le RDV »)' },
          texte: { type: 'string', description: 'Le message prêt à envoyer' },
        },
      },
    },
  },
};

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  const channel = body.channel === 'dm' ? 'dm' : 'sms';
  const leadId = String(body.leadId || '').trim();
  const convo = String(body.conversation || '').trim();
  if (channel === 'dm' && convo.length < 10) { res.status(400).json({ ok: false, error: 'bad_request', message: 'Colle d\'abord la conversation Instagram.' }); return; }
  if (channel === 'sms' && !leadId) { res.status(400).json({ ok: false, error: 'bad_request' }); return; }

  try {
    const P = [];
    const me = (auth.userData && (auth.userData.firstName || auth.userData.prenom || auth.userData.name)) || '';
    if (me) P.push('EXPÉDITEUR : ' + me + ' (signe avec ce prénom)');
    if (body.intent) P.push('OBJECTIF DU MESSAGE : ' + cap(body.intent, 200));
    if (leadId) {
      const b = await loadLeadBundle(leadId);
      if (b) { P.push(''); P.push(bundleToText(b, { maxCalls: 2, transcriptChars: 1500 })); }
    }
    if (convo) { P.push(''); P.push('CONVERSATION (la plus récente en bas) :'); P.push(cap(convo, 12000)); }

    const sys = channel === 'dm'
      ? 'Tu aides un setter d\'Alteore qui prospecte par DM Instagram. Propose 3 réponses DIFFÉRENTES au dernier message du prospect : naturelles, courtes (1-3 phrases), dans le registre de la conversation (tutoiement seulement si le prospect tutoie), qui font avancer vers un appel / un RDV sans forcer. Pas d\'emoji en excès, pas de jargon marketing.'
      : 'Tu aides un setter / closer d\'Alteore à écrire un SMS au prospect. Propose 3 SMS DIFFÉRENTS (≤ 300 caractères), au vouvoiement, signés du prénom de l\'expéditeur, qui font avancer la relation (reprendre contact, proposer un créneau, répondre à sa dernière question). Appuie-toi sur le dossier, n\'invente rien.';

    const r = await callClaude({ task: 'message_assist', system: sys, prompt: P.join('\n') || 'Aucun contexte.', schema: SCHEMA, uid: auth.uid, ref: leadId ? 'lead:' + leadId : 'dm' });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    res.status(200).json({ ok: true, suggestions: (r.json.suggestions || []).slice(0, 3) });
  } catch (e) {
    console.error('[ai-message]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
