// ============================================================================
// api/_aiClosing.js — ANALYSE IA D'UN CLOSING (programme IA, Lot 2)
// ----------------------------------------------------------------------------
// Seconde passe IA après les chapitres du Replay closing (_meetTranscript.js
// importBooking + replay-closing.js action 'analyze') :
//   • note globale /100 et note par étape de la trame de closing (trame
//     décrite dans le cerveau Alteore, sinon trame standard) ;
//   • moment de bascule (horodaté) ;
//   • points forts / axes de progrès du closer ;
//   • profil du prospect (douleurs, motivations, freins) ;
//   • objections (citation exacte + réponse + levée ou non) → aussi
//     enregistrées dans la bibliothèque ai_objections ;
//   • conseil de relance si non closé.
// Stocké sur bookings/{id}.replay.analysis (+ analysisAt, analysisModel,
// analysisError). Ne dépend PAS de _meetTranscript (pas de require circulaire) :
// l'appelant fournit la transcription déjà mise en forme.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { callClaude, cap } = require('./_ai');
const { OBJECTION_ITEM_SCHEMA, saveObjections } = require('./_aiObjections');

const MAX_TRANSCRIPT_CHARS = 180000; // ~50 k tokens : un closing de 2 h tient

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'etapes', 'bascule', 'pointsForts', 'axesProgres', 'prospect', 'objections', 'conseilRelance'],
  properties: {
    score: { type: 'integer', description: 'Note globale du closing sur 100' },
    verdict: { type: 'string', description: '2 phrases : ce qui a fait (ou défait) la vente' },
    etapes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['etape', 'note', 'commentaire'],
        properties: { etape: { type: 'string' }, note: { type: 'integer', description: '0 à 10' }, commentaire: { type: 'string' } },
      },
    },
    bascule: {
      type: 'object', additionalProperties: false, required: ['t', 'description'],
      properties: { t: { type: 'integer', description: 'Secondes depuis le début de l\'enregistrement' }, description: { type: 'string' } },
    },
    pointsForts: { type: 'array', items: { type: 'string' } },
    axesProgres: { type: 'array', items: { type: 'string' } },
    prospect: {
      type: 'object', additionalProperties: false, required: ['douleurs', 'motivations', 'freins'],
      properties: {
        douleurs: { type: 'array', items: { type: 'string' } },
        motivations: { type: 'array', items: { type: 'string' } },
        freins: { type: 'array', items: { type: 'string' } },
      },
    },
    objections: {
      type: 'array',
      items: Object.assign({}, OBJECTION_ITEM_SCHEMA, {
        required: OBJECTION_ITEM_SCHEMA.required.concat(['t']),
        properties: Object.assign({}, OBJECTION_ITEM_SCHEMA.properties, { t: { type: 'integer', description: 'Secondes depuis le début' } }),
      }),
    },
    conseilRelance: { type: 'string', description: 'Si non closé : l\'angle de relance le plus prometteur, en reprenant les mots du prospect. Vide si closé.' },
  },
};

const SYSTEM = [
  'Tu es le directeur commercial d\'Alteore et tu débriefes un appel de closing enregistré (transcription horodatée [HH:MM:SS]).',
  'Évalue le closer avec exigence et bienveillance :',
  '- etapes : note /10 chaque étape de la TRAME DE CLOSING décrite dans le contexte Alteore. Si aucune trame n\'y figure, utilise : Prise de contrôle & cadre, Découverte, Douleur & enjeux, Projection, Présentation de l\'offre, Annonce du prix, Traitement des objections, Engagement / closing.',
  '- bascule : le moment (en secondes depuis le début) où la vente s\'est jouée — gagnée ou perdue — et pourquoi.',
  '- objections : TOUTES les objections du prospect, avec la citation EXACTE tirée de la transcription, la réponse du closer, et si elle a été levée. Choisis la catégorie la plus juste.',
  '- prospect : ses douleurs, motivations et freins, dans SES mots.',
  '- pointsForts / axesProgres : 2 à 4 chacun, concrets, citant des moments précis.',
  '- conseilRelance : seulement si l\'issue n\'est pas un close.',
  'Règles : aucune invention ; tout doit être ancré dans la transcription. Français.',
].join('\n');

/**
 * @param {string} bookingId
 * @param {Object} b booking
 * @param {string} transcriptText transcription [HH:MM:SS] Locuteur : texte
 * @param {Object} [opts] { uid }
 */
async function analyzeClosing(bookingId, b, transcriptText, opts) {
  opts = opts || {};
  const ref = db.collection('bookings').doc(bookingId);
  const P = [];
  const prospectName = b.prospect ? ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim() : '';
  P.push('CLOSER : ' + (b.personName || b.expertName || '?'));
  P.push('PROSPECT : ' + (prospectName || '?'));
  P.push('DATE : ' + (b.date || '?') + ' ' + (b.time || ''));
  P.push('ISSUE SAISIE : ' + (b.outcome || 'pas encore saisie') + (b.outcomeNote ? ' — ' + cap(b.outcomeNote, 400) : '') +
    (b.closeData && b.closeData.offre ? ' — closé ' + b.closeData.offre + (b.closeData.contracte ? ' (' + b.closeData.contracte + ' €)' : '') : ''));
  if (b.prospect && b.prospect.message) P.push('MESSAGE À LA RÉSERVATION : ' + cap(b.prospect.message, 600));
  if (b.leadId) {
    try {
      const l = await db.collection('leads').doc(b.leadId).get();
      if (l.exists) {
        const d = l.data() || {};
        if (d.secteur) P.push('SECTEUR : ' + cap(d.secteur, 200));
        if (d.defi) P.push('DÉFI EXPRIMÉ : ' + cap(d.defi, 400));
        if (d.quiz && d.quiz.pilier_prioritaire) P.push('PILIER PRIORITAIRE (quiz) : ' + d.quiz.pilier_prioritaire);
        if (d.quiz && d.quiz.ca_mensuel) P.push('CA MENSUEL (quiz) : ' + d.quiz.ca_mensuel);
      }
    } catch (e) { /* contexte best-effort */ }
  }
  P.push('');
  P.push('TRANSCRIPTION :');
  P.push(cap(transcriptText, MAX_TRANSCRIPT_CHARS));

  const r = await callClaude({
    task: 'closing_analysis',
    system: SYSTEM,
    prompt: P.join('\n'),
    schema: SCHEMA,
    uid: opts.uid || null,
    ref: 'booking:' + bookingId,
  });
  if (!r.ok) {
    await ref.set({ replay: { analysisError: String(r.error).slice(0, 300) } }, { merge: true });
    return r;
  }
  const a = r.json || {};
  a.score = Math.max(0, Math.min(100, Math.round(Number(a.score) || 0)));
  await ref.set({ replay: { analysis: a, analysisAt: Date.now(), analysisModel: r.model || null, analysisError: null } }, { merge: true });

  try {
    await saveObjections({
      source: 'closing', sourceId: bookingId, bookingId: bookingId, leadId: b.leadId || null,
      who: b.personName || b.expertName || null, outcome: b.outcome || null,
    }, a.objections || []);
  } catch (e) { console.warn('[_aiClosing] objections non enregistrées', bookingId, e.message); }

  return { ok: true, analysis: a };
}

module.exports = { analyzeClosing: analyzeClosing };
