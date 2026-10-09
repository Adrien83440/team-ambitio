// ============================================================================
// api/ai-message.js — ASSISTANT SMS / EMAIL / DM (programme IA, Lot 4)
// ----------------------------------------------------------------------------
// Propose des messages au setter / closer. Ce ne sont QUE des propositions :
// elles s'insèrent dans le composeur (SMS), se copient (DM Instagram) ou
// partent par email APRÈS clic « Envoyer » ; l'humain relit et modifie.
//
// Révision du 09/10/2026 (retour Adrien, cas Jean-Charles : SMS de relance
// commerciale proposés à un prospect qui venait d'annuler) :
//   • la SITUATION ACTUELLE (RDV annulé, dernier appel, dernier message…) est
//     calculée et placée en tête ; l'IA doit d'abord l'énoncer (champ
//     `situation`, affiché pour que l'humain repère un contresens) ;
//   • champ libre `context` : ce que l'équipe sait et qu'Alteore ignore
//     (appel du matin, email reçu dans Gmail…) — prioritaire sur tout ;
//   • ton professionnel imposé (TONE_PROSPECT) ;
//   • format en deux temps pour le SMS : un EMAIL qui apporte de la valeur
//     (conseils concrets liés à sa douleur) + 3 SMS courts qui l'annoncent.
//
// POST Bearer <ID token> (admin / sales)
//   { action:'suggest' (défaut), leadId, channel:'sms'|'dm', context?, conversation? }
//     → { ok, situation, suggestions:[{ intention, texte }], email:{ objet, corps }|null }
//   { action:'sendEmail', leadId, subject, body } → envoi Gmail tracé dans la fiche
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { callClaude, humanError, cap, TONE_PROSPECT } = require('./_ai');
const { loadLeadBundle, bundleToText, situationText } = require('./_aiLeadContext');
const { sendLeadEmail } = require('./_leadEmail');

const ROLES = ['admin', 'sales'];

const SCHEMA_SMS = {
  type: 'object',
  additionalProperties: false,
  required: ['situation', 'suggestions', 'email'],
  properties: {
    situation: { type: 'string', description: 'En UNE phrase : où en est ce prospect aujourd\'hui (ce que tu as compris), et donc le but du message' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['intention', 'texte'],
        properties: {
          intention: { type: 'string', description: 'L\'angle en 3-5 mots' },
          texte: { type: 'string', description: 'SMS prêt à envoyer, 320 caractères maximum' },
        },
      },
    },
    email: {
      type: 'object', additionalProperties: false, required: ['objet', 'corps'],
      properties: {
        objet: { type: 'string', description: 'Objet sobre et personnel (pas de majuscules ni de point d\'exclamation)' },
        corps: { type: 'string', description: 'Email 140-230 mots, paragraphes séparés par une ligne vide' },
      },
    },
  },
};

const SCHEMA_DM = {
  type: 'object',
  additionalProperties: false,
  required: ['situation', 'suggestions'],
  properties: {
    situation: { type: 'string', description: 'En une phrase : où en est la conversation et le but de la réponse' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['intention', 'texte'],
        properties: { intention: { type: 'string' }, texte: { type: 'string' } },
      },
    },
  },
};

const SYSTEM_SMS = [
  'Tu aides l\'équipe commerciale d\'Alteore (accompagnement de dirigeants d\'entreprise) à écrire à un prospect.',
  'MÉTHODE :',
  '1. Lis d\'abord « CE QUE L\'ÉQUIPE SAIT EN PLUS » (prioritaire sur tout le reste) puis « SITUATION ACTUELLE ». Résume la situation en une phrase (champ situation). Le message doit en découler : on n\'écrit pas la même chose à quelqu\'un qui vient d\'annuler, à quelqu\'un qui n\'a pas répondu, ou à quelqu\'un qui a un RDV demain.',
  '2. EMAIL (le message principal) : prends acte de la situation (ex. annulation bien enregistrée et effective, suite à son échange avec un membre de notre équipe), empathie sincère, une phrase sur notre mission, puis 2 ou 3 conseils CONCRETS et actionnables tirés de SA douleur telle qu\'il l\'a exprimée (ex. manque de temps → matrice de délégation, bloc de 2 h protégé, liste « à ne plus faire » ; ne cite que des conseils pertinents pour lui), souhaite sincèrement que la situation s\'améliore, porte ouverte sans pression, et invitation à suivre nos réseaux pour continuer à recevoir des conseils gratuits (liens seulement s\'ils figurent dans le contexte Alteore).',
  '3. SMS : 3 variantes COURTES (≤ 320 caractères) cohérentes avec l\'email ; si la situation s\'y prête, l\'une d\'elles annonce simplement qu\'un email vient de lui être envoyé pour l\'aider à avancer sur son sujet.',
  'N\'invente aucun fait. Si une info manque, reste général plutôt que d\'inventer.',
  TONE_PROSPECT,
].join('\n');

const SYSTEM_DM = [
  'Tu aides un setter d\'Alteore qui échange par DM Instagram avec un dirigeant. Propose 3 réponses DIFFÉRENTES au dernier message : naturelles, courtes (1-3 phrases), professionnelles, qui font avancer vers un échange sans forcer, et qui respectent un refus.',
  'Instagram autorise un ton un peu plus direct, mais garde le vouvoiement sauf si le prospect tutoie clairement, et jamais de familiarité. Commence par résumer la situation (champ situation).',
  TONE_PROSPECT,
].join('\n');

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  const leadId = String(body.leadId || '').trim();

  try {
    if (body.action === 'sendEmail') {
      const subject = String(body.subject || '').trim().slice(0, 200);
      const text = String(body.body || '').trim().slice(0, 8000);
      if (!leadId || !subject || !text) { res.status(400).json({ ok: false, error: 'bad_request', message: 'Objet et message requis.' }); return; }
      await sendLeadEmail(auth, leadId, subject, text, { label: '✉️ Email (assistant IA, validé)', flag: 'aiAssist' });
      res.status(200).json({ ok: true });
      return;
    }

    const channel = body.channel === 'dm' ? 'dm' : 'sms';
    const convo = String(body.conversation || '').trim();
    const extra = String(body.context || '').trim().slice(0, 3000);
    if (channel === 'dm' && convo.length < 10) { res.status(400).json({ ok: false, error: 'bad_request', message: 'Colle d\'abord la conversation Instagram.' }); return; }
    if (channel === 'sms' && !leadId) { res.status(400).json({ ok: false, error: 'bad_request' }); return; }

    const P = [];
    const me = (auth.userData && (auth.userData.firstName || auth.userData.prenom || auth.userData.name)) || '';
    P.push('EXPÉDITEUR : ' + (me || '(prénom inconnu)'));
    if (extra) { P.push(''); P.push('CE QUE L\'ÉQUIPE SAIT EN PLUS (le plus récent, PRIORITAIRE) :'); P.push(extra); }
    if (leadId) {
      const b = await loadLeadBundle(leadId);
      if (b) {
        P.push('');
        P.push('SITUATION ACTUELLE (faits les plus récents) :');
        P.push(situationText(b));
        P.push('');
        P.push('DOSSIER COMPLET (pour le contexte, plus ancien) :');
        P.push(bundleToText(b, { maxCalls: 2, transcriptChars: 2500 }));
      }
    }
    if (convo) { P.push(''); P.push('CONVERSATION INSTAGRAM (la plus récente en bas) :'); P.push(cap(convo, 12000)); }

    const r = await callClaude({
      task: 'message_assist',
      system: channel === 'dm' ? SYSTEM_DM : SYSTEM_SMS,
      prompt: P.join('\n'),
      schema: channel === 'dm' ? SCHEMA_DM : SCHEMA_SMS,
      maxTokens: 2500,
      uid: auth.uid,
      ref: leadId ? 'lead:' + leadId : 'dm',
    });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    res.status(200).json({
      ok: true,
      situation: String(r.json.situation || ''),
      suggestions: (r.json.suggestions || []).slice(0, 3),
      email: channel === 'sms' && r.json.email ? r.json.email : null,
    });
  } catch (e) {
    console.error('[ai-message]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e), message: e && e.message });
  }
};
