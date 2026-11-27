// ============================================================================
// api/_offerRelances.js — RELANCES D'OFFRES (26/11/2026)
// ----------------------------------------------------------------------------
// Module « Relances d'offres » (sales-relances-offres.html), servi par les
// actions offers / offer_draft / offer_set de api/ai-followup.js.
//
// Qui entre (règle Adrien du 26/11/2026) :
//   - un RDV de vente « non closé » (outcome 'non_close') ;
//   - une offre faite (outcome 'offre') sans retour.
//   Dans les deux cas à partir de 10 JOURS après le rendez-vous, jamais avant
//   (demande d'Adrien du 27/11/2026 ; minDays ne descend pas sous 10) : plus tôt,
//   la carte est affichée « trop récent », sans message.
//   Sortent seuls : devenu client, a répondu depuis le RDV, a repris RDV,
//   fiche fusionnée / poubelle / faux numéro, contact bloqué.
//   Un prospect = une carte : son RDV non closé le plus récent.
//
// ENVOI — uniquement au clic « Envoyer » d'un membre de l'équipe (action
// offer_send), jamais automatique, jamais groupé. Et seulement si
// _config/offer_relances.sendEnabled === true ; tant que ce drapeau est
// absent ou faux, seul un prospect listé dans testLeadIds (fiche de test)
// peut recevoir un message. E-mail d'abord (strategie@, réponses captées par
// gmail-inbound-sync), SMS ensuite (Twilio).
// Garde-fous avant chaque envoi : mis de côté, devenu client, contact bloqué,
// STOP SMS, plafond (maxSends, 3) et écart minimal (gapDays, 5 jours) — les
// relances déjà parties de l'ancien moteur (ai_followups) comptent.
//
// _config/offer_relances : { sendEnabled, testLeadIds[], minDays, gapDays,
//   maxSends, callTask (rappel d'appel le lendemain, vrai par défaut),
//   replaceLegacy (coupe la création de séquences de l'ancien cron), prompt }
//
// IMBRICATION AVEC CE QUI ÉCRIT DÉJÀ AU PROSPECT (un prospect n'est jamais
// dans deux cases) :
//   - Séquence d'après-RDV automatique (api/_parcoursSuite.js, parcours_suites) :
//     tant qu'elle est active ou en pause, la carte est en « Séquence en
//     cours » — visible, sans brouillon ni envoi. Un RDV non closé de moins de
//     4 jours attend aussi sa séquence (frein choisi à J+1). Quand elle est
//     terminée, le prospect arrive en « À relancer » et l'IA sait ce qu'il a
//     déjà reçu (frein, e-mails, choix cliqués) pour ne rien répéter.
//   - Campagne du module Relances (relance_verrous actif) : idem, en cours.
//   - Exclusion définitive (relance_exclusions : STOP, « plus intéressé »),
//     désinscription e-mail (leads.emailDesinscrit) ou « non » répondu à la
//     séquence : le prospect sort du module, aucun message possible.
//   - Un clic « réserver » dans un e-mail de séquence sans RDV repris : la
//     carte est marquée chaude et remonte en tête (appeler d'abord).
//   L'issue « offre » n'a aucune séquence automatique : c'est ce module qui
//   la relance.
//
// Données : offer_relances/{bookingId} (Admin SDK seul, pas de règle Firestore)
//   { bookingId, leadId, category, categoryBy, reason, excluded:{by,byName,at,
//     motif}|null, draft:{emailSubject, emailBody, sms, ficheVide, generatedAt,
//     model, editedAt, editedBy}|null, sends:[{at, by, byName, email, sms,
//     emailSubject, emailBody, smsText, smsSid, smsError}], sentCount,
//     lastSentAt, firstSentAt, closerUid, closerName, prospectName, updatedAt }
//   Les brouillons restent HORS de la fiche lead (limite 1 Mo).
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { callClaude, cap, tsToMs } = require('./_ai');
const { loadLeadBundle, bundleToText } = require('./_aiLeadContext');
const { estBloque } = require('./_blockedContacts');
const { sendLeadEmail } = require('./_leadEmail');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const { toE164 } = require('./_leadLookup');
const Suite = require('./_parcoursSuite');
const P = require('./_parcoursRdv');

const COL = 'offer_relances';
const OUTCOMES = ['offre', 'non_close'];
const LIEN_TEMOIGNAGES = 'https://team.alteore.com/temoignages-public.html';
const DEFAULT_MIN_DAYS = 10;     // délai avant toute relance, offre ou non closé (_config/offer_relances.minDays, jamais moins de 10)
const DEFAULT_WINDOW_DAYS = 60;  // profondeur de la liste
const MAX_ITEMS = 300;
const DEFAULT_GAP_DAYS = 5;      // écart minimal entre deux relances
const DEFAULT_MAX_SENDS = 3;     // relances au total par prospect
// Jamais dans un message, même retapé à la main (règles de contenu Adrien).
const RE_INTERDIT = /(titan|garantie\s+(de\s+)?30|30\s*jours\s+(satisfait|rembours))/i;
// Demande d'Adrien du 26/11/2026 : l'IA a écrit « j'ai une meilleure offre à
// vous proposer » à un prospect à qui l'on avait présenté notre offre d'entrée.
// Il n'existe AUCUNE autre offre : un message ne promet jamais une offre, une
// formule ou des conditions différentes de celle présentée en rendez-vous.
const RE_AUTRE_OFFRE = /((meilleure|autre|nouvelle|seconde|deuxi[èe]me)\s+(offre|formule|proposition|solution)|(offre|formule|solution|accompagnement|version)\s+(plus\s+|mieux\s+)(adapt[ée]e?|accessible|l[ée]g[èe]re?|abordable|[ée]conomique|souple|courte?|petite?|simple)|(offre|formule)\s+(alternative|sp[ée]ciale|sur[- ]mesure|interm[ée]diaire|all[ée]g[ée]e|d[ée]couverte)|tarif\s+(pr[ée]f[ée]rentiel|r[ée]duit|sp[ée]cial)|r[ée]duction\s+(de\s+prix|tarifaire|sur\s+(le|l['’ ])\s*(prix|tarif|montant|offre))|remise\s+(commerciale|exceptionnelle|tarifaire|sp[ée]ciale|de\s+\d|sur\s+(le|l['’ ])\s*(prix|tarif|montant|offre))|rabais|(offre|tarif|prix)\s+promotionnel|en\s+promotion|prix\s+(r[ée]duit|plus\s+bas)|moins\s+cher|geste\s+commercial|conditions\s+(sp[ée]ciales|exceptionnelles|particuli[èe]res))/i;
// Demande d'Adrien du 27/11/2026 : jamais de prix dans une relance, on ne sait
// pas si le prix a été annoncé au rendez-vous. Un montant collé à un mot de
// prix est refusé ; un chiffre du prospect (son chiffre d'affaires) reste permis.
const MOT_PRIX = '(prix|tarifs?|co[uû]t\\s+de\\s+l[\'’ ]\\s*(accompagnement|offre|programme)|investissement|mensualit[ée]s?|paiement\\s+en|facilit[ée]s?\\s+de\\s+paiement)';
const MONTANT = '\\d[\\d\\s.,]*\\s?(€|euros?|k€|k\\b)';
const RE_PRIX = new RegExp('(' + MOT_PRIX + '[^.\\n]{0,50}' + MONTANT + '|' + MONTANT + '[^.\\n]{0,25}(par\\s+mois|/\\s?mois|mensuels?)[^.\\n]{0,40}(accompagnement|offre|programme))', 'i');
function contenuInterdit(t) {
  const x = String(t || '');
  if (RE_PRIX.test(x)) return 'Le message donne un prix ou un montant de l\'offre : jamais de prix dans une relance.';
  if (RE_INTERDIT.test(x)) return 'Le message mentionne l\'offre Titan ou une garantie 30 jours : à retirer.';
  const m = x.match(RE_AUTRE_OFFRE);
  if (m) return 'Le message laisse entendre une autre offre, une autre formule ou une remise (« ' + m[0] + ' ») : nous n\'en avons pas. À reformuler.';
  return null;
}

const CATEGORIES = {
  a_relancer: 'À relancer',
  rappel_convenu: 'Rappel convenu',
  en_sequence: 'Séquence en cours',
  trop_recent: 'Trop récent',
  de_cote: 'Laissé de côté',
};

const RE_RAPPEL = /(rappel|rappeler|recontact|reprendre contact|revenir vers|refaire un point|janvier|f[ée]vrier|\bmars\b|avril|\bmai\b|\bjuin\b|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|apr[èe]s les f[êe]tes|apr[èe]s la saison|fin de saison|d[ée]but d['’ ]ann[ée]e|mois prochain|rentr[ée]e)/i;
const RE_SENSIBLE = /(d[ée]c[èe]s|d[ée]c[ée]d|deuil|maladie|malade|hospitalis|h[ôo]pital|cancer|op[ée]ration|accident|divorce|s[ée]paration|liquidation|redressement|sauvegarde|tribunal|proc[èe]s|burn[- ]?out|d[ée]pression)/i;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categorie', 'raison', 'offrePresentee', 'ficheVide', 'emailSubject', 'emailBody', 'sms'],
  properties: {
    categorie: { type: 'string', enum: ['a_relancer', 'rappel_convenu', 'de_cote'] },
    raison: { type: 'string', description: 'Une phrase, pour le closer : pourquoi cette catégorie' },
    offrePresentee: { type: 'string', enum: ['Business Phénix', 'Elite Phénix', 'inconnue'], description: 'L\'offre présentée au prospect pendant le rendez-vous, d\'après le dossier. « inconnue » si le dossier ne permet pas de le savoir : ne devine pas.' },
    ficheVide: { type: 'boolean', description: 'true si la note du RDV manque ou ne dit rien d\'exploitable' },
    emailSubject: { type: 'string', description: 'Objet court et concret. Vide si categorie = de_cote' },
    emailBody: { type: 'string', description: '3 à 4 paragraphes brefs séparés par une ligne vide. Vide si categorie = de_cote' },
    sms: { type: 'string', description: '160 caractères si possible, 320 au plus. Vide si categorie = de_cote' },
  },
};

// Prompt par défaut. Surchargé par _config/offer_relances.prompt s'il existe.
const DEFAULT_PROMPT = [
  'Tu écris pour un closer d\'Alteore (accompagnement de dirigeants de TPE et PME) à un prospect qui a eu son rendez-vous de vente et n\'a pas encore rejoint l\'accompagnement.',
  '',
  'TON BUT : qu\'il nous rejoigne. Chaque message doit le rapprocher d\'une décision, en lui faisant faire le prochain pas le plus simple : un échange de 15 à 20 minutes avec son closer pour lever ce qui le retient et décider. Tu ne relances pas « pour prendre des nouvelles » : tu donnes une raison de répondre maintenant.',
  '',
  'COMMENT CONVAINCRE (sans jamais forcer) :',
  '- Pars de CE QU\'IL A DIT : son objectif, ce qui lui pèse, un chiffre qu\'il a donné. C\'est son problème qui vend, pas notre offre.',
  '- Montre ce que lui coûte de ne rien changer, avec ses propres mots et ses propres chiffres (temps, trésorerie, marge, fatigue). Concret, jamais dramatique.',
  '- Réponds à SON frein, celui du dossier, par un élément nouveau : une précision, une façon de démarrer, ce que l\'échange va régler. Ne rejoue pas l\'argumentaire du rendez-vous.',
  '- Rends le pas facile : un seul appel à l\'action, précis, à faible engagement. S\'il existe des facilités pour démarrer, dis qu\'elles se voient pendant l\'échange, sans les chiffrer.',
  '- S\'il a montré un signal d\'intérêt (clic sur « réserver », question posée), appuie-toi dessus : il y pensait, aide-le à conclure.',
  '- Reste digne : un dirigeant écrit à un dirigeant. Aucune flatterie, aucune culpabilisation, aucun mensonge. Tu écris pour obtenir un oui, y compris de quelqu\'un qui a dit non.',
  '',
  'TES OUTILS DE PERSUASION (ceux des meilleurs négociateurs et vendeurs ; un ou deux par message, jamais en les nommant) :',
  '- Nommer ce qu\'il ressent avant d\'argumenter : « On dirait que… », « J\'ai l\'impression que… ». Quelqu\'un qui se sent compris écoute la suite.',
  '- Dire toi-même ce qu\'il pense de nous avant qu\'il ne le pense : « Vous vous dites sans doute que je reviens vers vous pour vendre. » Cela désamorce.',
  '- La question à laquelle il est facile de répondre non : « Avez-vous renoncé à [son objectif, avec ses mots] ? » Un non le remet en mouvement.',
  '- La question ouverte qui le fait réfléchir : « Qu\'est-ce qui devrait être vrai pour que ce soit le bon moment ? », « Comment comptez-vous régler [son problème] d\'ici là ? »',
  '- Reprendre ses propres mots, à l\'identique : on ne contredit pas ce qu\'on a dit soi-même.',
  '- Le prix de ne rien faire : ce que la situation lui coûte chaque mois qui passe, avec SES chiffres. On agit plus pour ne pas perdre que pour gagner.',
  '- La preuve par d\'autres dirigeants : uniquement par le lien des témoignages fourni, jamais par un résultat que tu inventerais.',
  '- Donner avant de demander : une idée utile, précise, tirée de son dossier, qu\'il peut appliquer seul.',
  '',
  'RÉPONDRE À SON OBJECTION (celle du dossier ; ne la nie pas, accueille-la, puis retourne-la) :',
  '- « C\'est trop cher » : ne cite AUCUN montant et ne discute pas le prix. Compare à ce que le problème lui coûte déjà, avec ses chiffres ; dis que la façon de démarrer se voit pendant l\'échange.',
  '- « Je n\'ai pas le temps » : c\'est le symptôme, pas la raison. Tant que tout repose sur lui, le temps ne reviendra pas seul.',
  '- « J\'attends mon bilan », « on verra en début d\'année », « ce n\'est pas le moment » : le bilan constate, il ne corrige rien. Chaque mois d\'attente est un mois aux mêmes chiffres. Qu\'est-ce qui sera différent à cette date ?',
  '- « Je dois en parler à mon associé, à mon conjoint, à mon comptable » : propose de refaire le point à trois, lors de l\'échange.',
  '- « Je vais réfléchir » : demande, avec respect, sur quoi porte la réflexion. Une question précise se règle en un échange.',
  '- « J\'ai déjà été accompagné, cela n\'a rien donné » : reconnais-le, demande ce qui a manqué, et propose d\'en parler.',
  '- « Je vais le faire seul » : c\'est possible. Depuis combien de temps y pense-t-il, et qu\'est-ce qui a changé depuis ?',
  '- « Non », sans raison donnée : respecte le non, et pose une seule question qui rouvre la discussion.',
  '- Il demande des preuves, des avis, des exemples de clients, ou doute du résultat : donne le LIEN DES TÉMOIGNAGES, dans l\'e-mail seulement, sur sa propre ligne, en plus du lien de réservation.',
  '',
  'NOS OFFRES — CADRE STRICT, AUCUNE INITIATIVE :',
  '- Nous n\'avons que les offres décrites dans le contexte Alteore ci-dessus (« NOS OFFRES ET PRIX ») : Business Phénix, notre offre d\'entrée, et Elite Phénix. Il n\'existe RIEN d\'autre : ni offre moins chère, ni version allégée, ni formule intermédiaire, ni conditions spéciales, ni remise, ni bonus.',
  '- Le prospect a reçu UNE offre pendant son rendez-vous. Retrouve laquelle dans le dossier (note du rendez-vous, analyse du closing, appels) et renseigne offrePresentee. Ton message reste sur CETTE offre, telle qu\'elle lui a été présentée.',
  '- N\'écris JAMAIS, même de façon voilée, qu\'il existe « une meilleure offre », « une autre offre », « une autre formule », « une formule plus adaptée », « quelque chose de plus accessible », « une nouvelle proposition » ou « des conditions particulières ». C\'est faux, et le closer serait incapable de tenir la promesse.',
  '- Si tu ne sais pas quelle offre lui a été présentée (offrePresentee = inconnue), parle de « l\'accompagnement » sans le nommer et sans rien décrire de son contenu.',
  '- Ne décris de l\'offre que ce que le contexte Alteore en dit. N\'invente ni contenu, ni durée, ni modalité.',
  '- Cohérence avec le profil : Elite Phénix s\'adresse au dirigeant à 20 000 € et plus de chiffre d\'affaires mensuel ; Business Phénix à l\'artisan ou au commerçant plus petit. Si l\'offre présentée te paraît ne pas correspondre au profil, n\'en dis RIEN au prospect : signale-le au closer dans le champ raison, c\'est lui qui décide.',
  '- Seule exception : une CONSIGNE DU CLOSER explicite dans le dossier, que tu suis à la lettre.',
  '',
  'L\'ANTI-VENTE, AVEC PARCIMONIE :',
  '- Quand la situation le mérite (plusieurs relances sans réponse, hésitation qui dure, dernière relance, prospect qui repousse sans raison précise), tu peux retourner la posture, avec élégance et sans une once de mépris : nous n\'accompagnons que des dirigeants décidés à changer les choses ; beaucoup voient le problème et ne passent jamais à l\'action, et c\'est dommage ; si ce n\'est pas son cas aujourd\'hui, mieux vaut nous le dire simplement.',
  '- Une ou deux phrases au plus, jamais en ouverture, jamais sur une première relance, jamais avec un prospect en difficulté personnelle ou financière. Le ton reste chaleureux : on constate, on ne juge pas, et la porte reste ouverte.',
  '',
  'SI LE CLOSER REPREND LE DOSSIER D\'UN COLLÈGUE (indiqué dans le dossier) :',
  '- L\'e-mail et le SMS commencent par le dire, simplement : « Bonjour {prénom}, c\'est {prénom du closer}. Je reprends le fil de votre échange avec {prénom du collègue}. »',
  '- N\'explique pas pourquoi, ne dis pas que le collègue est parti. Ne fais pas comme si le closer avait mené le rendez-vous : il écrit « lors de votre échange avec {prénom du collègue} », jamais « lors de notre rendez-vous ».',
  '',
  'D\'ABORD, classe le prospect :',
  '- a_relancer : offre faite ou rendez-vous non closé, aucune réponse, aucune prochaine étape datée. Relance directe.',
  '- rappel_convenu : il a demandé du temps et une période a été évoquée (« début janvier », « après les fêtes », « après la saison »). Le message sert à FIXER UNE DATE précise dans cette période, pour que le projet ne se dissolve pas.',
  '- de_cote : le dossier signale une situation personnelle (santé, famille, deuil), une procédure ou une difficulté grave de l\'entreprise, ou il a demandé à ne plus être contacté. Aucun message : laisse emailSubject, emailBody et sms vides. Le closer décidera.',
  'Écris en une phrase pourquoi (champ raison).',
  '',
  'SELON LA SITUATION :',
  '- Offre en attente : rappelle la date du rendez-vous et ce qu\'il voulait régler, nomme le frein s\'il est connu, propose l\'échange pour décider.',
  '- Rendez-vous non closé : ne nie pas son refus, accueille-le, puis réponds à son objection par un angle différent de celui du rendez-vous. Le but est qu\'il revienne sur sa décision : propose l\'échange pour refaire le point.',
  '- Rappel convenu : rappelle ce qui avait été convenu, propose deux dates précises en semaine (jour et quantième), postérieures à la date du jour.',
  '- Dernière relance : dis-le simplement, et demande une réponse claire, oui ou non, pour ne pas le relancer inutilement.',
  '- S\'il a déjà reçu nos e-mails automatiques ou une relance, n\'en reprends ni l\'angle ni les formules : ce message doit sonner comme écrit pour lui seul, par son closer.',
  '',
  'RÈGLES D\'ÉCRITURE :',
  '- Vouvoiement, ton direct et respectueux, phrases courtes. Aucun emoji.',
  '- Signé du prénom du closer, suivi de « équipe Adrien & Emily ».',
  '- N\'utilise QUE des faits présents dans le dossier. N\'invente rien : ni chiffre, ni résultat client, ni promesse. Si le dossier est vide ou ne dit rien d\'exploitable, écris un message ouvert qui demande quelle question lui reste avant de décider, et mets ficheVide à true.',
  '- Une seule demande par message : réserver son créneau par le lien fourni. Dans l\'e-mail, il peut aussi simplement répondre. Le lien des témoignages n\'est pas une demande : c\'est une preuve, à ne donner que si le dossier le justifie.',
  '- LE PROSPECT NE PEUT PAS RÉPONDRE À UN SMS (expéditeur sans numéro). N\'écris jamais « répondez à ce SMS », « répondez-moi » ou « dites-moi » dans le SMS. Le SMS donne le lien de réservation, et rappelle qu\'il peut répondre à l\'e-mail.',
  '',
  'INTERDITS ABSOLUS :',
  '- Aucun prix, aucune fourchette de prix, aucun montant de l\'offre, aucune mensualité : nous ne savons pas si le prix lui a été annoncé. Même s\'il a dit que c\'était trop cher.',
  '- Jamais de garantie 30 jours. Jamais l\'offre Titan.',
  '- Alteore (le logiciel) ne fait pas partie de l\'accompagnement : ne le présente pas comme inclus.',
  '- Ne cite jamais une information de santé, familiale ou judiciaire, même si elle figure dans le dossier.',
  '- Aucune adresse postale, aucun numéro de téléphone de l\'entreprise.',
  '- Aucune promesse de résultat chiffré, aucune fausse urgence, aucune fausse rareté, aucune réduction.',
  '',
  'FORMAT :',
  '- E-mail : objet court, concret, personnel (jamais « Relance »), puis 3 à 4 paragraphes brefs séparés par une ligne vide. La dernière phrase est l\'appel à l\'action.',
  '- E-mail : le lien de réservation apparaît une seule fois, seul sur sa ligne, juste avant la signature.',
  '- SMS : court (le lien compte dans la longueur ; 2 SMS au plus, soit 300 caractères), commence par « Bonjour {prénom}, c\'est {prénom du closer} (Adrien & Emily). », donne en une phrase la raison de réserver, puis une phrase qui dit que tu viens de lui écrire par e-mail et pourquoi, puis « Vous pouvez réserver un créneau ici : {lien} ou retrouver ce que je vous ai partagé dans votre boîte mail. »',
].join('\n');

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function shiftDate(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days, 12)).toISOString().slice(0, 10);
}
function frDay(dateStr) {
  if (!dateStr) return '';
  const p = String(dateStr).split('-').map(Number);
  if (p.length < 3 || !p[0]) return String(dateStr);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function prospectName(b, l) {
  const p = b.prospect || {};
  const n = ((p.prenom || '') + ' ' + (p.nom || '')).trim();
  if (n) return n;
  const ln = ((l && (l.prenom || l.firstName) || '') + ' ' + (l && (l.nom || l.lastName) || '')).trim();
  return ln || p.email || '?';
}
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }

// Même règle que api/lead-reply-watch.js.
function isClient(l) {
  return l.isClient === true || l.status === 'client' || !!l.clientSince ||
    String(l.stage || '').indexOf('closed_won') === 0;
}
function isInbound(dir) { const d = String(dir || '').toLowerCase(); return d === 'inbound' || d === 'entrant' || d === 'in'; }

function numOr(v, def, min, max) {
  const n = Number(v);
  return v != null && v !== '' && n >= min && n <= max ? n : def;
}

async function loadConfig() {
  let c = {};
  try {
    const s = await db.collection('_config').doc('offer_relances').get();
    c = s.exists ? (s.data() || {}) : {};
  } catch (e) { c = {}; }
  return {
    minDays: numOr(c.minDays, DEFAULT_MIN_DAYS, DEFAULT_MIN_DAYS, 60),
    gapDays: numOr(c.gapDays, DEFAULT_GAP_DAYS, 0, 60),
    maxSends: numOr(c.maxSends, DEFAULT_MAX_SENDS, 1, 10),
    sendEnabled: c.sendEnabled === true,
    testLeadIds: Array.isArray(c.testLeadIds) ? c.testLeadIds.map(String) : [],
    callTask: c.callTask !== false,
    replaceLegacy: c.replaceLegacy === true,
    prompt: String(c.prompt || '').trim() || DEFAULT_PROMPT,
    // Lien de réservation à proposer dans les messages (facultatif). Vide :
    // le prospect répond avec un créneau et le closer pose le RDV.
    // Closer qui reprend les prospects d'un membre parti (slug du roster).
    repriseSlug: String(c.repriseSlug || '').trim(),
    lienRdv: /^https:\/\//.test(String(c.lienRdv || '')) ? String(c.lienRdv).trim() : '',
    // Envoi automatique (api/_offerRelancesAuto.js). Éteint par défaut ; allumé,
    // il tourne À BLANC tant que modeTest n'est pas explicitement faux.
    auto: (function (a) {
      return { actif: a.actif === true, modeTest: a.modeTest !== false, plafondJour: numOr(a.plafondJour, 10, 1, 50),
        secondeJours: numOr(a.secondeJours, 20, 10, 60), secondeRdvJours: numOr(a.secondeRdvJours, 30, 20, 90), depuis: a.depuis || null };
    })(c.auto && typeof c.auto === 'object' ? c.auto : {}),
    // Mur public des témoignages, donné au prospect qui demande des preuves.
    lienTemoignages: /^https:\/\//.test(String(c.lienTemoignages || '')) ? String(c.lienTemoignages).trim() : LIEN_TEMOIGNAGES,
  };
}

// Relances déjà parties : ce module + l'ancien moteur (ai_followups).
function sendHistory(state, legacy) {
  const mine = (state && Array.isArray(state.sends)) ? state.sends : [];
  const old = ((legacy && legacy.steps) || []).filter(function (x) { return x.status === 'sent'; });
  const times = mine.map(function (x) { return x.at || 0; }).concat(old.map(function (x) { return x.sentAt || 0; }));
  return { count: times.length, last: times.length ? Math.max.apply(null, times) : 0, moduleCount: mine.length };
}

// ---------------------------------------------------------------------------
//  Imbrication : séquences automatiques, campagnes, exclusions définitives
// ---------------------------------------------------------------------------

const PREP_DAYS = 4; // non closé : la séquence automatique démarre entre J+1 et J+3

async function loadContext() {
  const ctx = { exclus: {}, campagne: {}, suiteActive: {}, suitesOn: false };
  const r = await Promise.all([
    db.collection('relance_exclusions').get().catch(function () { return null; }),
    db.collection('relance_verrous').where('actif', '==', true).get().catch(function () { return null; }),
    db.collection(Suite.COL).where('etat', 'in', ['active', 'pause']).get().catch(function () { return null; }),
    P.lireConfig().catch(function () { return {}; }),
  ]);
  if (r[0]) r[0].forEach(function (d) { ctx.exclus[d.id] = (d.data() || {}).motif || 'exclu'; });
  if (r[1]) r[1].forEach(function (d) { ctx.campagne[d.id] = (d.data() || {}).campagneId || 1; });
  if (r[2]) r[2].forEach(function (d) { const x = d.data() || {}; if (x.leadId) ctx.suiteActive[x.leadId] = { id: d.id, s: x }; });
  ctx.suitesOn = Object.assign({}, Suite.DEFAUTS, (r[3] && r[3].suites) || {}).actif === true;
  return ctx;
}

// Ce que la séquence automatique a fait pour ce prospect (pour l'écran et l'IA).
function suiteInfo(id, x) {
  if (!x) return null;
  let l;
  try { l = Suite.ligneAdmin(id, x, Date.now()); } catch (e) { return null; }
  const partis = (l.etapes || []).filter(function (e) { return e && e.ok; });
  return {
    libelle: l.sequenceLibelle || '', douleur: l.douleurLibelle || null, etat: l.etat, motif: l.motif || null, motifLibelle: l.motifLibelle || null,
    envoyes: partis.length, total: l.total || 0, objets: partis.map(function (e) { return e.objet; }).filter(Boolean).slice(0, 6),
    prochainJour: l.prochain && l.prochain.jour ? l.prochain.jour : null,
    clics: l.clics || 0, aCliqueReserver: l.aCliqueReserver === true, choix: l.choixLibelle || null,
    reponses: (l.reponses || []).map(function (r) { return { sens: r.sens, resume: r.resume }; }),
  };
}

// Le prospect reçoit-il déjà quelque chose d'automatique ? → { reason } ou null.
function enCours(ctx, leadId, b, days, ownSuite) {
  const act = ctx.suiteActive[leadId];
  if (act) {
    const i = suiteInfo(act.id, act.s) || {};
    return { reason: 'Reçoit la séquence automatique « ' + (i.libelle || 'après RDV') + ' »' + (act.s.etat === 'pause' ? ' (en pause)' : '') + ' : ' + (i.envoyes || 0) + ' e-mail' + ((i.envoyes || 0) > 1 ? 's' : '') + ' sur ' + (i.total || '?') + ' parti' + ((i.envoyes || 0) > 1 ? 's' : '') +
      (i.prochainJour ? ', prochain le ' + frDay(i.prochainJour) : '') + '. La relance manuelle s\'ouvre à la fin.', info: i };
  }
  if (ctx.campagne[leadId]) return { reason: 'Dans une campagne de relance en cours (module Relances). La relance manuelle s\'ouvre à la fin.', info: null };
  if (ctx.suitesOn && b.outcome === 'non_close' && !ownSuite && days < PREP_DAYS) {
    return { reason: 'Séquence automatique en préparation : le frein est choisi le lendemain du rendez-vous, puis les e-mails partent seuls.', info: null };
  }
  return null;
}

// Closer du RDV : booking_config/{personId}.firebaseUid, repli outcomeBy.
// Un membre est parti s'il est désactivé ou archivé dans _meta/team_members
// (source de vérité, Admin → Utilisateurs) : jamais de nom en dur.
function membreParti(m) { return !!m && (m.active === false || !!m.archivedAt); }
function sansAccent(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function prenomDe(m) { return m ? (m.shortName || firstName(m.displayName || m.fullName || '')) : ''; }

async function loadMembers() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? s.data().members : null;
    return (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
  } catch (e) { return []; }
}

/* Renvoie le closer qui PORTE le prospect aujourd'hui :
   - le closer du RDV s'il est toujours dans l'équipe ;
   - sinon le repreneur (_config/offer_relances.repriseSlug), avec
     `reprise: { de }` — c'est lui qui voit la carte, et le message dit
     « je reprends le fil de votre échange avec … » ;
   - sans repreneur réglé : uid nul (admins seuls), reprise signalée. */
function closerResolver(cfg) {
  const cache = {};
  let members = null;
  return async function (b) {
    let uid = null; let name = b.personName || b.expertName || null;
    if (b.personId) {
      if (!(b.personId in cache)) {
        try {
          const p = await db.collection('booking_config').doc(b.personId).get();
          cache[b.personId] = p.exists ? (p.data().firebaseUid || null) : null;
        } catch (e) { cache[b.personId] = null; }
      }
      uid = cache[b.personId];
    }
    if (!uid && b.outcomeBy) { uid = b.outcomeBy; name = name || b.outcomeByName || null; }
    if (!members) members = await loadMembers();
    const fn = sansAccent(firstName(name));
    // Le NOM porté par le RDV prime : la page d'un membre parti peut avoir été
    // rattachée depuis au compte de son remplaçant.
    const m = (fn ? members.find(function (x) { return membreParti(x) && sansAccent(prenomDe(x)) === fn; }) : null) ||
      (uid ? members.find(function (x) { return x.firebaseUid === uid; }) : null) ||
      (fn ? members.find(function (x) { return sansAccent(prenomDe(x)) === fn; }) : null);
    if (!membreParti(m)) return { uid: uid, name: name, reprise: null };
    const de = prenomDe(m) || firstName(name);
    const r = cfg && cfg.repriseSlug ? members.find(function (x) { return x.slug === cfg.repriseSlug && !membreParti(x) && x.firebaseUid; }) : null;
    if (r) return { uid: r.firebaseUid, name: prenomDe(r), reprise: { de: de, fixe: true } };
    return { uid: null, name: null, reprise: { de: de, fixe: false } };
  };
}

function heuristic(b, l, days, minDays) {
  const note = String(b.outcomeNote || '');
  const hay = note + ' ' + String(l.notes || '').slice(0, 1500);
  const out = { category: 'a_relancer', reason: '', sensible: false };
  if (RE_SENSIBLE.test(hay)) out.sensible = true;
  if (days < minDays) {
    out.category = 'trop_recent';
    out.reason = (b.outcome === 'offre' ? 'Offre faite' : 'Rendez-vous non closé') + ' il y a ' + days + ' jour' + (days > 1 ? 's' : '') + ' : relance possible à partir de ' + minDays + ' jours.';
    return out;
  }
  const futureFu = (Array.isArray(l.followUps) ? l.followUps : []).some(function (f) {
    return f && !f.done && f.source !== 'offer_relance' && Date.parse(f.dateTime || '') > Date.now();
  });
  if (futureFu) { out.category = 'rappel_convenu'; out.reason = 'Un rappel est déjà programmé sur la fiche.'; }
  else if (RE_RAPPEL.test(note)) { out.category = 'rappel_convenu'; out.reason = 'La note du rendez-vous évoque un rappel ou une période : à transformer en date fixée.'; }
  else if (b.outcome === 'offre') out.reason = 'Offre faite il y a ' + days + ' jours, sans réponse ni prochaine étape datée.';
  else out.reason = 'Rendez-vous non closé il y a ' + days + ' jour' + (days > 1 ? 's' : '') + ', sans échange depuis.';
  if (!note.trim()) out.reason += ' La note du rendez-vous est vide.';
  return out;
}

// ---------------------------------------------------------------------------
//  Liste
// ---------------------------------------------------------------------------

async function listOffers(auth, opts) {
  const cfg = await loadConfig();
  const isAdmin = auth.role === 'admin';
  const all = isAdmin && opts.all !== false;
  const win = Math.min(Math.max(parseInt(opts.days, 10) || DEFAULT_WINDOW_DAYS, 7), 365);
  const today = parisDate(Date.now());
  const from = shiftDate(today, -win);

  // Une seule inégalité (date) : pas d'index composite. L'issue est filtrée ici.
  // (requête unique : sert aussi à repérer un RDV plus récent du même prospect)
  const fut = await db.collection('bookings').where('date', '>=', from).get();
  const byLead = {};
  const bkByLead = {};
  fut.forEach(function (d) {
    const b = d.data() || {};
    if (b.leadId) (bkByLead[b.leadId] = bkByLead[b.leadId] || []).push({ id: d.id, b: b });
    if (OUTCOMES.indexOf(b.outcome) < 0 || !b.leadId || b.isCoaching === true) return;
    if (String(b.date || '') > today) return;
    const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || 0;
    const cur = byLead[b.leadId];
    if (!cur || at > cur.at) byLead[b.leadId] = { id: d.id, b: b, at: at };
  });

  // Un RDV plus récent (close, nouveau RDV à venir…) fait sortir le prospect.
  const later = {};
  fut.forEach(function (d) {
    const x = d.data() || {};
    if (!x.leadId || !byLead[x.leadId] || d.id === byLead[x.leadId].id) return;
    if (x.status === 'cancelled') return;
    const ref = byLead[x.leadId].b;
    if (x.outcome === 'close') later[x.leadId] = 'close';
    else if (!x.outcome && String(x.date || '') >= today) later[x.leadId] = later[x.leadId] || 'a_repris_rdv';
    else if (String(x.date || '') > String(ref.date || '') && OUTCOMES.indexOf(x.outcome) < 0 && x.outcome !== 'no_show' && x.outcome !== 'annule' && x.outcome !== 'replanifie') later[x.leadId] = later[x.leadId] || 'rdv_plus_recent';
  });

  const resolve = closerResolver(cfg);
  const entries = Object.keys(byLead).map(function (k) { return byLead[k]; });
  const out = [];
  const sortis = { client: 0, a_repondu: 0, a_repris_rdv: 0, fiche: 0, bloque: 0, exclu: 0, desinscrit: 0, a_dit_non: 0 };
  const ctx = await loadContext();

  for (let i = 0; i < entries.length; i += 25) {
    const chunk = entries.slice(i, i + 25);
    const refs = [];
    chunk.forEach(function (e) {
      refs.push(db.collection('leads').doc(e.b.leadId));
      refs.push(db.collection(COL).doc(e.id));
      refs.push(db.collection('ai_followups').doc(e.id));
      refs.push(db.collection(Suite.COL).doc(e.id));
    });
    const docs = await db.getAll.apply(db, refs);
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j], b = e.b;
      const ls = docs[j * 4], st = docs[j * 4 + 1], old = docs[j * 4 + 2], su = docs[j * 4 + 3];
      if (!ls.exists) { sortis.fiche++; continue; }
      const l = ls.data() || {};
      if (l._merged === true || l.stage === 'poubelle' || l.stage === 'faux_numero') { sortis.fiche++; continue; }
      if (isClient(l) || later[b.leadId] === 'close') { sortis.client++; continue; }
      // Réaction APRÈS une relance partie de ce module (réponse écrite ou RDV
      // repris) : le prospect reste visible dans « Ont réagi », sans brouillon
      // ni envoi. Sans relance de notre part, il sort de la liste comme avant.
      const premier = st.exists ? ((st.data() || {}).firstSentAt || 0) : 0;
      let reagi = null;
      if (later[b.leadId]) {
        const repris = premier && (bkByLead[b.leadId] || []).some(function (k) {
          return k.id !== e.id && k.b.status !== 'cancelled' && tsToMs(k.b.createdAt) > premier;
        });
        if (!repris) { sortis.a_repris_rdv++; continue; }
        reagi = { type: 'rdv' };
      }
      const entrants = (Array.isArray(l.communications) ? l.communications : []).filter(function (c) {
        return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > e.at;
      });
      if (!reagi && entrants.length) {
        const apres = premier ? entrants.filter(function (c) { return Date.parse(c.date || c.createdAt || '') > premier; }) : [];
        if (!apres.length) { sortis.a_repondu++; continue; }
        const der = apres[apres.length - 1];
        reagi = { type: 'reponse', at: Date.parse(der.date || der.createdAt || '') || null, canal: String(der.type || ''), extrait: cap(String(der.content || der.body || der.text || ''), 400) };
      }
      // Exclusion définitive, désinscription, « non » répondu à la séquence.
      const own = su.exists ? (su.data() || {}) : null;
      if (ctx.exclus[b.leadId]) { sortis.exclu++; continue; }
      if (l.emailDesinscrit === true || (own && own.motifArret === 'desinscription')) { sortis.desinscrit++; continue; }
      if (own && own.motifArret === 'reponse_stop') { sortis.a_dit_non++; continue; }

      const closer = await resolve(b);
      if (!all && closer.uid !== auth.uid) continue;

      const p = b.prospect || {};
      const phone = l.telephone || p.telephone || '';
      const email = l.email || p.email || '';
      if (await estBloque({ phone: phone, email: email })) { sortis.bloque++; continue; }

      const days = Math.max(0, Math.floor((Date.now() - e.at) / 86400000));
      const h = heuristic(b, l, days, cfg.minDays);
      const state = st.exists ? (st.data() || {}) : {};
      let category = h.category, reason = h.reason, categoryBy = 'regle';
      if (state.excluded) { category = 'de_cote'; reason = 'Laissé de côté' + (state.excluded.byName ? ' par ' + state.excluded.byName : '') + (state.excluded.motif ? ' : ' + state.excluded.motif : '.'); categoryBy = 'manuel'; }
      else if (h.category !== 'trop_recent' && state.category && CATEGORIES[state.category] && state.category !== 'en_sequence') { category = state.category; reason = state.reason || reason; categoryBy = state.categoryBy || 'ia'; }
      const cours = enCours(ctx, b.leadId, b, days, own);
      if (cours && category !== 'de_cote') { category = 'en_sequence'; reason = cours.reason; categoryBy = 'regle'; }
      if (reagi && category !== 'de_cote') {
        category = 'ont_reagi'; categoryBy = 'regle';
        reason = reagi.type === 'rdv' ? 'A repris rendez-vous après votre relance.' : 'A répondu après votre relance : répondez-lui depuis sa fiche.';
      }
      const sInfo = (cours && cours.info) || (own ? suiteInfo(e.id, own) : null);
      const chaud = !!(sInfo && sInfo.aCliqueReserver);
      if (!cours && sInfo && category !== 'de_cote' && categoryBy === 'regle' && (sInfo.etat === 'terminee' || sInfo.etat === 'arretee')) {
        reason = 'Séquence automatique « ' + sInfo.libelle + ' » ' + (sInfo.etat === 'terminee' ? 'terminée' : 'arrêtée') + ' (' + sInfo.envoyes + ' e-mail' + (sInfo.envoyes > 1 ? 's' : '') + '), sans reprise de rendez-vous. ' + reason;
      }
      if (chaud) reason = 'A cliqué « réserver » dans un e-mail sans reprendre rendez-vous : à appeler en priorité. ' + reason;

      const hist = sendHistory(state, old.exists ? old.data() : null);
      const nextAt = hist.last ? hist.last + cfg.gapDays * 86400000 : 0;
      const lastSend = (state.sends || []).length ? state.sends[state.sends.length - 1] : null;
      const an = b.replay && b.replay.analysis;
      out.push({
        bookingId: e.id, leadId: b.leadId, name: prospectName(b, l), entreprise: l.entreprise || l.company || p.entreprise || '',
        outcome: b.outcome, rdvDate: b.date || '', rdvDateFr: frDay(b.date), days: days,
        closerName: closer.name || '—', closerUid: closer.uid || null, mine: closer.uid === auth.uid, reprise: closer.reprise || null,
        typeLabel: b.typeLabel || '', note: cap(String(b.outcomeNote || ''), 600),
        freins: an && an.prospect ? (an.prospect.freins || []).slice(0, 3) : [],
        conseil: an ? cap(String(an.conseilRelance || ''), 300) : '',
        category: category, reason: reason, categoryBy: categoryBy, sensible: h.sensible, chaud: chaud, suite: sInfo,
        hasEmail: !!email, hasPhone: !!phone, smsStop: l.smsOptedOut === true || l.smsOptOut === true,
        dejaRelance: hist.count, derniereRelanceAt: hist.last, maxSends: cfg.maxSends,
        nextAt: nextAt > Date.now() ? nextAt : 0, plafond: hist.count >= cfg.maxSends,
        dernierEnvoi: lastSend ? { at: lastSend.at, byName: lastSend.byName || null, email: !!lastSend.email, sms: !!lastSend.sms, smsError: lastSend.smsError || null } : null,
        envoiPossible: cfg.sendEnabled || cfg.testLeadIds.indexOf(b.leadId) >= 0,
        draft: state.draft || null,
        reagi: reagi, auto: state.auto || null,
        // Suivi des envois (complété plus bas : SMS remis ou non, lien ouvert).
        envois: (state.sends || []).slice(-3).map(function (s) {
          return { at: s.at, byName: s.byName || null, email: !!s.email, sms: !!s.sms, auto: s.auto === true, smsError: s.smsError || null, smsSid: s.smsSid || null, smsEtat: null, smsPourquoi: '' };
        }),
        lien: null, _lienCode: state.lienCode || null,
      });
    }
    if (out.length >= MAX_ITEMS) break;
  }

  await completerSuivi(out);
  const order = { a_relancer: 0, rappel_convenu: 1, ont_reagi: 2, en_sequence: 3, trop_recent: 4, de_cote: 5 };
  out.sort(function (a, b) { return (order[a.category] - order[b.category]) || ((b.chaud ? 1 : 0) - (a.chaud ? 1 : 0)) || (b.days - a.days); });
  const counts = { a_relancer: 0, rappel_convenu: 0, ont_reagi: 0, en_sequence: 0, trop_recent: 0, de_cote: 0 };
  out.forEach(function (x) { counts[x.category]++; });
  let stats = null;
  try { stats = await computeStats(auth, all, bkByLead); } catch (e) { console.warn('[offer-relances] stats', e && e.message); }
  return { ok: true, items: out, counts: counts, categories: Object.assign({}, CATEGORIES, { ont_reagi: 'Ont réagi' }), sortis: sortis, isAdmin: isAdmin, all: all,
    minDays: cfg.minDays, gapDays: cfg.gapDays, maxSends: cfg.maxSends, days: win, envoi: cfg.sendEnabled, stats: stats,
    auto: { actif: cfg.auto.actif, modeTest: cfg.auto.modeTest, plafondJour: cfg.auto.plafondJour, secondeRdvJours: cfg.auto.secondeRdvJours } };
}

/* Suivi d'une relance partie : le SMS est-il arrivé (accusé de l'opérateur,
   sms_delivery/{sid}, écrit par api/twilio-sms-status.js) et le lien de
   réservation a-t-il été ouvert (offer_liens/{code}, clic compté par le
   navigateur). Pour l'e-mail, Gmail ne donne aucun accusé : on sait qu'il est
   parti, pas qu'il a été lu. Lecture seule ; au moindre souci le suivi reste
   vide et la liste s'affiche quand même. */
async function completerSuivi(items) {
  try {
    const refs = [], cibles = [];
    items.forEach(function (x) {
      if (x._lienCode && /^[a-z0-9]{6}$/.test(x._lienCode)) { refs.push(db.collection('offer_liens').doc(x._lienCode)); cibles.push({ x: x }); }
      (x.envois || []).forEach(function (s) {
        if (s.sms && s.smsSid) { refs.push(db.collection('sms_delivery').doc(s.smsSid)); cibles.push({ s: s }); }
      });
    });
    for (let i = 0; i < refs.length; i += 100) {
      const docs = await db.getAll.apply(db, refs.slice(i, i + 100));
      docs.forEach(function (d, j) {
        const c = cibles[i + j], v = d.exists ? (d.data() || {}) : null;
        if (c.x) { if (v) c.x.lien = { clics: v.clics || 0, premierClicA: v.premierClicA || null, dernierClicA: v.dernierClicA || null }; return; }
        if (!v) return;
        c.s.smsEtat = v.livre ? 'remis' : (v.echec ? 'echec' : 'en_cours');
        c.s.smsPourquoi = v.echec ? String(v.explication || '') : '';
      });
    }
  } catch (e) { console.warn('[offer-relances] suivi', e && e.message); }
  items.forEach(function (x) {
    delete x._lienCode;
    (x.envois || []).forEach(function (s) { delete s.smsSid; });
  });
}

// ---------------------------------------------------------------------------
//  Mesure : ce que les relances envoyées depuis ce module ont produit
// ---------------------------------------------------------------------------

async function computeStats(auth, all, bkByLead) {
  const st = { prospects: 0, messages: 0, reponses: 0, rdvRepris: 0, ventes: 0 };
  const snap = await db.collection(COL).where('lastSentAt', '>', 0).limit(400).get();
  const rows = [];
  snap.forEach(function (d) {
    const x = d.data() || {};
    if (!all && x.closerUid !== auth.uid) return;
    if (x.leadId) rows.push({ id: d.id, x: x });
  });
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const docs = await db.getAll.apply(db, chunk.map(function (r) { return db.collection('leads').doc(r.x.leadId); }));
    chunk.forEach(function (r, j) {
      const x = r.x, first = x.firstSentAt || x.lastSentAt;
      st.prospects++;
      (x.sends || []).forEach(function (s) { st.messages += (s.email ? 1 : 0) + (s.sms && !s.smsError ? 1 : 0); });
      const l = docs[j].exists ? (docs[j].data() || {}) : {};
      if ((Array.isArray(l.communications) ? l.communications : []).some(function (c) {
        return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > first;
      })) st.reponses++;
      if (isClient(l)) st.ventes++;
      if ((bkByLead[x.leadId] || []).some(function (k) {
        return k.id !== r.id && k.b.status !== 'cancelled' && tsToMs(k.b.createdAt) > first;
      })) st.rdvRepris++;
    });
  }
  return st;
}

// ---------------------------------------------------------------------------
//  Droit d'agir sur une carte
// ---------------------------------------------------------------------------

async function loadCard(auth, bookingId) {
  const id = String(bookingId || '');
  if (!id) return { error: 'bad_request', code: 400 };
  const bs = await db.collection('bookings').doc(id).get();
  if (!bs.exists) return { error: 'not_found', code: 404 };
  const b = bs.data() || {};
  if (OUTCOMES.indexOf(b.outcome) < 0 || !b.leadId) return { error: 'not_an_open_offer', code: 409 };
  const closer = await closerResolver(await loadConfig())(b);
  if (auth.role !== 'admin' && closer.uid !== auth.uid) return { error: 'not_your_prospect', code: 403 };
  return { id: id, b: b, closer: closer, ref: db.collection(COL).doc(id) };
}

// Refus communs au brouillon et à l'envoi : le prospect est ailleurs.
async function gardeImbrication(card, lead, days) {
  const leadId = card.b.leadId;
  const ctx = await loadContext();
  const su = await db.collection(Suite.COL).doc(card.id).get();
  const own = su.exists ? (su.data() || {}) : null;
  if (ctx.exclus[leadId]) return { error: 'excluded_final', code: 409, message: 'Ce prospect a demandé à ne plus être contacté.' };
  if ((lead && lead.emailDesinscrit === true) || (own && own.motifArret === 'desinscription')) return { error: 'unsubscribed', code: 409, message: 'Ce prospect s\'est désinscrit de nos e-mails.' };
  if (own && own.motifArret === 'reponse_stop') return { error: 'said_no', code: 409, message: 'Ce prospect a répondu qu\'il ne souhaitait pas donner suite.' };
  const cours = enCours(ctx, leadId, card.b, days, own);
  if (cours) return { error: 'in_sequence', code: 409, message: cours.reason };
  return { own: own };
}

/* Lien de prise de RDV proposé au prospect. Réglage `lienRdv` s'il existe ;
   sinon la consultation de son rendez-vous d'origine (même type, donc même
   closer ou même équipe), rattachée à sa fiche par leadId — aucune donnée
   personnelle dans l'adresse. Un RDV repris par ce lien le sort du module. */
async function cibleReservation(cfg, b) {
  if (cfg.lienRdv) return cfg.lienRdv;
  let cle = String(b.type || b.typeId || '');
  try {
    const types = await P.lireTypes();
    const t = types[cle];
    if (t && t.slug) cle = String(t.slug);
  } catch (e) { /* identifiant brut */ }
  return 'https://team.alteore.com/booking.html?' + (cle ? 'type=' + encodeURIComponent(cle) + '&' : '') + 'leadId=' + encodeURIComponent(String(b.leadId || ''));
}

/* Lien COURT donné au prospect (demande d'Adrien du 27/11/2026) :
   https://team.alteore.com/o/{code}, 6 caractères, ouvert par
   api/offre-lien.js qui compte le clic puis ouvre la prise de RDV. Un code
   par carte, gardé sur la carte (`lienCode`) et dans `offer_liens/{code}`
   (Admin SDK seul). La destination est écrite ici, jamais par l'appelant. Au
   moindre souci, le lien long est rendu : un message part toujours avec un
   lien qui marche. */
const BASE_COURT = 'https://team.alteore.com/o/';
const ALPHABET_CODE = 'abcdefghjkmnpqrstuvwxyz23456789';
async function lienDeReservation(cfg, b, ref) {
  const cible = await cibleReservation(cfg, b);
  if (!ref) return cible;
  try {
    const s = await ref.get();
    const deja = s.exists ? (s.data() || {}).lienCode : null;
    if (deja && /^[a-z0-9]{6}$/.test(deja)) {
      await db.collection('offer_liens').doc(deja).set({ url: cible, majA: Date.now() }, { merge: true });
      return BASE_COURT + deja;
    }
    for (let essai = 0; essai < 4; essai++) {
      const oct = require('crypto').randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i++) code += ALPHABET_CODE[oct[i] % ALPHABET_CODE.length];
      try {
        await db.collection('offer_liens').doc(code).create({ bookingId: ref.id, leadId: String(b.leadId || ''), url: cible, clics: 0, creeA: Date.now() });
      } catch (e) { continue; } // code déjà pris : on en tire un autre
      await ref.set({ bookingId: ref.id, leadId: b.leadId || null, lienCode: code }, { merge: true });
      return BASE_COURT + code;
    }
  } catch (e) { console.warn('[offer-relances] lien court', ref.id, e && e.message); }
  return cible;
}

/* E-mail mis en forme : bandeau, paragraphes, bouton de réservation à la
   place du lien écrit en clair, signature. Le texte reste celui que le
   closer a relu ; seule la présentation change. */
const BANDEAU = 'https://team.alteore.com/media/relances-offres/bandeau.jpg?v=c97debb0';
function escH(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function htmlRelance(sujet, texte, lien) {
  const RE_URL = /https?:\/\/[^\s<>"]+/g;
  const bouton = function (u) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="background:#2563eb;border-radius:10px">'
      + '<a href="' + escH(u) + '" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">Réserver mon créneau</a></td></tr></table>';
  };
  let boutonPose = false;
  const blocs = String(texte || '').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  const corps = blocs.map(function (p, i) {
    const urls = p.match(RE_URL) || [];
    const u = urls.find(function (x) { return lien && x.replace(/[.,;)]+$/, '') === lien; }) || (lien ? null : urls[0]) || null;
    if (!u && urls.length) {
      // Un autre lien (témoignages) : il reste un lien, jamais le bouton de réservation.
      const html = p.split('\n').map(function (l) {
        return escH(l).replace(/https?:\/\/[^\s<>"]+/g, function (a) {
          const net = a.replace(/[.,;)]+$/, ''), queue = a.slice(net.length);
          return '<a href="' + net + '" style="color:#2563eb;font-weight:700">' + (/temoignage/i.test(net) ? 'Voir les témoignages de nos clients' : net) + '</a>' + queue;
        });
      }).join('<br>');
      return '<p style="margin:0 0 16px">' + html + '</p>';
    }
    if (!u) {
      // La signature (dernier bloc, court) : en gras sur la première ligne.
      const lignes = p.split('\n');
      if (i === blocs.length - 1 && p.length < 90) return '<p style="margin:24px 0 0">' + lignes.map(function (l, k) { return k === 0 ? '<strong>' + escH(l) + '</strong>' : escH(l); }).join('<br>') + '</p>';
      return '<p style="margin:0 0 16px">' + lignes.map(escH).join('<br>') + '</p>';
    }
    const propre = u.replace(/[.,;)]+$/, '');
    // Le lien devient un bouton ; la phrase qui l'introduit reste, sans l'adresse.
    const reste = p.replace(u, '').replace(/\s*[:：]\s*$/, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
    boutonPose = true;
    return (reste && !/^(pour\s+)?r[ée]serv(er|ez)\b[^.]{0,60}$/i.test(reste) ? '<p style="margin:0 0 12px">' + reste.split('\n').map(escH).join('<br>') + '</p>' : '') + bouton(propre);
  }).join('');
  const fin = (!boutonPose && lien) ? bouton(lien) : '';
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' + escH(sujet) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f3f4f8"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:28px 12px"><tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Helvetica,Arial,sans-serif">'
    + '<tr><td style="background:#1e3a8a;background-image:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);border-radius:18px 18px 0 0;padding:22px 36px"><div style="font-size:12px;font-weight:700;color:#c7d2fe;letter-spacing:2.5px;text-transform:uppercase">Adrien &amp; Emily</div></td></tr>'
    + '<tr><td style="background:#ffffff;padding:32px 36px 30px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb"><div style="font-size:16px;line-height:1.7;color:#1f2937">'
    + '<div style="margin:0 0 24px"><img src="' + BANDEAU + '" alt="On reprend le fil de notre échange" width="528" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:12px"></div>'
    + corps + fin + '</div></td></tr>'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 18px 18px;padding:18px 36px;text-align:center"><div style="font-size:12px;color:#9ca3af;line-height:1.6">Adrien &amp; Emily · Accompagnement des dirigeants · <a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a><br>Vous pouvez simplement répondre à cet e-mail.</div></td></tr>'
    + '</table></td></tr></table></body></html>';
}

// Le prospect ne peut pas répondre à un SMS : pas d'invitation à le faire, et
// toujours un moyen d'agir (lien de réservation, ou renvoi vers l'e-mail).
const RE_REPONSE_SMS = /(r[ée]pond(ez|re)(-moi|-nous)?\s+(à|a|par|sur)\s+ce\s+(sms|message|texto|num[ée]ro)|par\s+retour\s+de\s+(sms|message)|r[ée]pond(ez|re)\s+(simplement\s+)?(oui|ok|stop)\b|par\s+sms)/i;
function smsInterdit(sms, avecEmail) {
  const x = String(sms || '');
  if (RE_REPONSE_SMS.test(x)) return 'Le SMS invite à répondre par SMS, ce que le prospect ne peut pas faire : donnez le lien de réservation ou renvoyez vers l\'e-mail.';
  const lien = /https?:\/\//i.test(x);
  const mail = /e-?mail|courriel/i.test(x);
  if (!lien && !(mail && avecEmail)) return avecEmail
    ? 'Le SMS doit contenir le lien de réservation ou renvoyer vers l\'e-mail : le prospect ne peut pas répondre par SMS.'
    : 'Envoyé sans e-mail, le SMS doit contenir le lien de réservation : le prospect ne peut pas répondre par SMS.';
  return null;
}

// ---------------------------------------------------------------------------
//  Brouillon IA (à la demande, une carte à la fois)
// ---------------------------------------------------------------------------

async function draftOffer(auth, body, me) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const b = card.b;
  const cfg = await loadConfig();
  const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || Date.now();
  const days = Math.max(0, Math.floor((Date.now() - at) / 86400000));
  if (days < cfg.minDays) return { error: 'too_recent', code: 409, message: 'Rendez-vous trop récent : relance possible à partir de ' + cfg.minDays + ' jours.' };
  const st = await card.ref.get();
  if (st.exists && (st.data() || {}).excluded) return { error: 'excluded', code: 409, message: 'Ce prospect est laissé de côté.' };
  const garde = await gardeImbrication(card, null, days);
  if (garde.error) return garde;
  const sI = garde.own ? suiteInfo(card.id, garde.own) : null;
  const sent = sendHistory(st.exists ? st.data() : null, null);

  const name = prospectName(b, null);
  const P = [];
  P.push('DATE DU JOUR : ' + frDay(parisDate(Date.now())));
  // Signataire : le closer qui porte le prospect ; à défaut (membre parti sans
  // repreneur réglé), celui qui clique.
  const signataire = firstName(card.closer.name) || firstName(me && me.name) || '';
  if (!signataire) return { error: 'no_signer', code: 409, message: 'Aucun closer pour signer ce message : réglez le repreneur des prospects d\'un membre parti.' };
  P.push('CLOSER : ' + signataire + ' (signe de ce prénom)');
  if (card.closer.reprise) P.push('REPRISE DE DOSSIER : ' + signataire + ' reprend ce prospect à la place de ' + card.closer.reprise.de + ', qui a mené le rendez-vous. ' + signataire + ' n\'était pas au rendez-vous.');
  P.push('PROSPECT : ' + name);
  P.push('RENDEZ-VOUS : ' + (frDay(b.date) || '?') + ' — il y a ' + days + ' jours — issue « ' + (b.outcome === 'offre' ? 'offre faite, en attente de réponse' : 'non closé (refus exprimé)') + ' »');
  P.push('NOTE DU RENDEZ-VOUS : ' + (String(b.outcomeNote || '').trim() ? cap(b.outcomeNote, 1200) : '(vide)'));
  // Ce que la fiche sait déjà de lui : frein repéré après le rendez-vous et
  // réponse au questionnaire (mot pour mot).
  try {
    const ls = await db.collection('leads').doc(String(b.leadId)).get();
    const L = ls.exists ? (ls.data() || {}) : {};
    const fp = L.freinPrincipal;
    if (fp && fp.libelle) P.push('FREIN PRINCIPAL REPÉRÉ APRÈS LE RENDEZ-VOUS : ' + fp.libelle + (fp.citation ? ' — il a dit : « ' + cap(fp.citation, 240) + ' »' : ''));
    const pr = Suite.profilDe(L);
    if (pr && pr.citation) P.push('CE QUI LUI PÈSE LE PLUS (sa réponse au questionnaire, mot pour mot) : « ' + cap(pr.citation, 200) + ' »');
  } catch (e) { /* le dossier ci-dessous suffit */ }
  const an = b.replay && b.replay.analysis;
  if (an) {
    P.push('ANALYSE DE L\'ENREGISTREMENT DU CLOSING :');
    if (an.verdict) P.push('- Verdict : ' + an.verdict);
    if (an.prospect) {
      if ((an.prospect.douleurs || []).length) P.push('- Douleurs : ' + an.prospect.douleurs.join(' | '));
      if ((an.prospect.motivations || []).length) P.push('- Motivations : ' + an.prospect.motivations.join(' | '));
      if ((an.prospect.freins || []).length) P.push('- Freins : ' + an.prospect.freins.join(' | '));
    }
    (an.objections || []).slice(0, 5).forEach(function (o) { P.push('- Objection : « ' + cap(o.quote, 200) + ' »'); });
    if (an.conseilRelance) P.push('- Conseil de relance : ' + an.conseilRelance);
  }
  if (sI && sI.envoyes) {
    P.push('');
    P.push('CE QU\'IL A DÉJÀ REÇU DE NOTRE PART (séquence d\'e-mails automatique « ' + sI.libelle + ' », ' + (sI.etat === 'terminee' ? 'terminée' : 'arrêtée') + ') — ne répète ni ces angles ni ces objets, apporte autre chose :');
    sI.objets.forEach(function (o) { P.push('- E-mail : « ' + o + ' »'); });
    if (sI.douleur) P.push('- Ce qui lui pèse le plus (sa réponse au questionnaire) : ' + sI.douleur);
    if (sI.choix) P.push('- Dans ces e-mails, il a choisi : ' + sI.choix);
    if (sI.aCliqueReserver) P.push('- SIGNAL FORT : il a cliqué sur « réserver » dans l\'un de ces e-mails, sans aller au bout. Il est intéressé : facilite-lui le pas.');
    (sI.reponses || []).forEach(function (r) { if (r.resume) P.push('- Il a répondu : ' + cap(r.resume, 220)); });
  }
  if (sent.moduleCount) {
    P.push('');
    P.push('RELANCES DÉJÀ ENVOYÉES PAR LE CLOSER (ne pas répéter, changer d\'angle) :');
    (st.data().sends || []).slice(-3).forEach(function (x) { P.push('- ' + frDay(parisDate(x.at)) + ' : ' + cap(x.emailBody || x.smsText || '', 400)); });
    P.push('C\'est la relance n° ' + (sent.moduleCount + 1) + ' sur ' + cfg.maxSends + (sent.moduleCount + 1 >= cfg.maxSends ? ' : la dernière. Demande une décision claire, oui ou non, avec élégance.' : '.'));
  }
  P.push('');
  const lienRdv = await lienDeReservation(cfg, b, card.ref);
  // Ces rappels valent même si un prompt personnalisé est réglé.
  P.push('LIEN DES TÉMOIGNAGES (à donner tel quel, dans l\'e-mail seulement et sur sa propre ligne, UNIQUEMENT s\'il a demandé des preuves, des avis ou des exemples de clients, ou s\'il doute du résultat) : ' + cfg.lienTemoignages);
  P.push('JAMAIS DE PRIX : aucun montant de l\'offre, aucune mensualité, même s\'il a dit que c\'était trop cher. Nous ne savons pas si le prix lui a été annoncé.');
  P.push('BUT : qu\'il revienne sur sa décision et nous rejoigne. Réponds à son objection par un contre-argument tiré de son dossier, avec les principes des meilleurs négociateurs (nommer ce qu\'il ressent, question à laquelle il répond non, question ouverte, ses propres mots, prix de ne rien faire), sans rien inventer.');
  P.push('APPUIE-TOI SUR LE DOSSIER CI-DESSOUS : le message cite au moins deux éléments précis qui viennent de lui (ses mots, un chiffre qu\'il a donné, son frein, sa réponse au questionnaire). Un message qui pourrait être envoyé à n\'importe qui est refusé.');
  P.push('SMS, FORME ATTENDUE : « Bonjour {prénom}, c\'est {prénom du closer} (Adrien & Emily). » puis une phrase qui dit que tu viens de lui écrire par e-mail et pourquoi, puis : « Vous pouvez réserver un créneau ici : {lien} ou retrouver ce que je vous ai partagé dans votre boîte mail. » Rien d\'autre.');
  P.push('LIEN DE RÉSERVATION (à écrire tel quel, sans le modifier ni le raccourcir, une seule fois dans l\'e-mail et une seule fois dans le SMS) : ' + lienRdv);
  const bundle = await loadLeadBundle(b.leadId);
  if (bundle) { P.push(''); P.push(bundleToText(bundle, { maxCalls: 2, transcriptChars: 3000 })); }
  const instr = String(body.instruction || '').trim().slice(0, 500);
  if (instr) { P.push(''); P.push('CONSIGNE DU CLOSER POUR CETTE VERSION : ' + instr); }

  let r = await callClaude({ task: 'offer_followup', system: cfg.prompt, prompt: P.join('\n'), schema: SCHEMA, uid: auth.uid, ref: 'offer:' + card.id, source: 'offer_relances' });
  if (!r.ok) throw new Error(r.error);
  let j = r.json || {};
  // Contrôle du texte produit : une seconde rédaction si l'IA a quand même
  // évoqué une autre offre ; au-delà, le brouillon est livré avec une alerte
  // et l'envoi le refusera tant que la phrase est là.
  let alerte = contenuInterdit([j.emailSubject, j.emailBody, j.sms].join(' '));
  if (alerte && !instr) {
    const r2 = await callClaude({ task: 'offer_followup', system: cfg.prompt, schema: SCHEMA, uid: auth.uid, ref: 'offer:' + card.id, source: 'offer_relances',
      prompt: P.join('\n') + '\n\nTA PREMIÈRE VERSION A ÉTÉ REFUSÉE : ' + alerte + ' Réécris l\'e-mail et le SMS sans aucune allusion à une autre offre, une autre formule, une remise ou des conditions particulières.' });
    if (r2.ok && r2.json) { r = r2; j = r2.json; alerte = contenuInterdit([j.emailSubject, j.emailBody, j.sms].join(' ')); }
  }
  let smsOut = String(j.sms || '').trim();
  let mailOut = String(j.emailBody || '').trim();
  if (j.categorie !== 'de_cote') {
    if (smsOut && smsOut.indexOf(lienRdv) < 0) smsOut = smsOut.replace(/\s*https?:\/\/\S+/g, '').replace(/[\s.]+$/, '') + '. Vous pouvez réserver un créneau ici : ' + lienRdv + ' ou retrouver ce que je vous ai partagé dans votre boîte mail.';
    if (mailOut && mailOut.indexOf(lienRdv) < 0) mailOut = mailOut.replace(/\n\n(?=[^\n]*\n?[^\n]*$)/, '\n\nPour réserver votre créneau : ' + lienRdv + '\n\n');
    if (mailOut && mailOut.indexOf(lienRdv) < 0) mailOut += '\n\nPour réserver votre créneau : ' + lienRdv;
    if (!alerte) alerte = smsInterdit(smsOut, true);
  }
  const draft = {
    emailSubject: String(j.emailSubject || '').trim().slice(0, 200),
    emailBody: mailOut.slice(0, 6000),
    sms: smsOut.slice(0, 640),
    ficheVide: j.ficheVide === true, lienRdv: lienRdv, offrePresentee: j.offrePresentee || 'inconnue', alerte: alerte || null, signataire: signataire, generatedAt: Date.now(), model: r.model || null, instruction: instr || null,
  };
  const patch = {
    bookingId: card.id, leadId: b.leadId, category: j.categorie, categoryBy: 'ia',
    reason: String(j.raison || '').trim().slice(0, 400), draft: draft, updatedAt: Date.now(),
  };
  await card.ref.set(patch, { merge: true });
  return { ok: true, category: patch.category, reason: patch.reason, categoryBy: 'ia', draft: draft };
}

// ---------------------------------------------------------------------------
//  Réglages manuels d'une carte : catégorie, mise de côté, texte modifié
// ---------------------------------------------------------------------------

async function setOffer(auth, body, me) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const patch = { bookingId: card.id, leadId: card.b.leadId, updatedAt: Date.now() };
  if (body.exclude === true) {
    const motif = String(body.motif || '').trim().slice(0, 300);
    if (!motif) return { error: 'motif_required', code: 400, message: 'Indiquez le motif.' };
    patch.excluded = { by: auth.uid, byName: (me && me.name) || auth.email || null, at: Date.now(), motif: motif };
  } else if (body.exclude === false) {
    patch.excluded = null;
  }
  if (body.category) {
    if (body.category !== 'a_relancer' && body.category !== 'rappel_convenu') return { error: 'bad_category', code: 400 };
    patch.category = body.category; patch.categoryBy = 'manuel';
    patch.reason = 'Classé à la main' + ((me && me.name) ? ' par ' + me.name : '') + '.';
  }
  if (body.draft && typeof body.draft === 'object') {
    const st = await card.ref.get();
    const cur = (st.exists && (st.data() || {}).draft) || {};
    patch.draft = Object.assign({}, cur, {
      emailSubject: String(body.draft.emailSubject || '').trim().slice(0, 200),
      emailBody: String(body.draft.emailBody || '').trim().slice(0, 6000),
      sms: String(body.draft.sms || '').trim().slice(0, 640),
      editedAt: Date.now(), editedBy: auth.uid,
    });
  }
  await card.ref.set(patch, { merge: true });
  return { ok: true };
}

/* Aperçu de l'e-mail tel qu'il partira : la même mise en forme que l'envoi
   (htmlRelance), sur le texte affiché dans la page. Rien n'est écrit. */
async function previewOffer(auth, body) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const st = await card.ref.get();
  const d = (st.exists && (st.data() || {}).draft) || {};
  const sujet = String(body.emailSubject != null ? body.emailSubject : d.emailSubject || '').trim().slice(0, 200);
  const texte = String(body.emailBody != null ? body.emailBody : d.emailBody || '').trim().slice(0, 6000);
  return { ok: true, html: htmlRelance(sujet, texte, d.lienRdv || null) };
}

// ---------------------------------------------------------------------------
//  Envoi (au clic uniquement)
// ---------------------------------------------------------------------------

function fail(error, code, message) { return { error: error, code: code, message: message }; }

// Demain 10 h, heure de Paris, au format des rappels de Leads Live.
function tomorrowAt10() { return shiftDate(parisDate(Date.now()), 1) + 'T10:00:00'; }

async function sendOffer(auth, body, me) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const b = card.b, leadId = b.leadId;
  const wantEmail = body.email === true, wantSms = body.sms === true;
  if (!wantEmail && !wantSms) return fail('no_channel', 400, 'Choisissez l\'e-mail, le SMS ou les deux.');

  const cfg = await loadConfig();
  // `me._auto` n'est posé que par l'automate (côté serveur, jamais par une requête).
  const parAutomate = !!(me && me._auto === true);
  if (parAutomate && !(cfg.auto.actif && cfg.auto.modeTest === false)) return fail('auto_off', 409, 'Envoi automatique éteint ou à blanc.');
  if (!parAutomate && !cfg.sendEnabled && cfg.testLeadIds.indexOf(leadId) < 0) {
    return fail('send_disabled', 409, 'L\'envoi n\'est pas encore activé (hors fiche de test).');
  }
  const got = await db.getAll(db.collection('leads').doc(leadId), card.ref, db.collection('ai_followups').doc(card.id));
  if (!got[0].exists) return fail('lead_not_found', 404, 'Fiche prospect introuvable.');
  const lead = got[0].data() || {};
  const state = got[1].exists ? (got[1].data() || {}) : {};

  if (state.excluded) return fail('excluded', 409, 'Ce prospect est laissé de côté.');
  if (lead._merged === true) return fail('merged', 409, 'Cette fiche a été fusionnée.');
  if (isClient(lead)) return fail('client', 409, 'Ce prospect est devenu client.');
  const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || Date.now();
  if (Date.now() - at < cfg.minDays * 86400000) return fail('too_recent', 409, 'Rendez-vous trop récent : relance possible à partir de ' + cfg.minDays + ' jours.');
  if ((Array.isArray(lead.communications) ? lead.communications : []).some(function (c) {
    return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > at;
  })) return fail('replied', 409, 'Ce prospect a écrit depuis le rendez-vous : répondez-lui depuis sa fiche.');

  const garde = await gardeImbrication(card, lead, Math.max(0, Math.floor((Date.now() - at) / 86400000)));
  if (garde.error) return garde;

  const hist = sendHistory(state, got[2].exists ? got[2].data() : null);
  if (hist.count >= cfg.maxSends) return fail('cap', 409, 'Déjà ' + hist.count + ' relances envoyées : plafond atteint.');
  if (hist.last && Date.now() - hist.last < cfg.gapDays * 86400000) {
    return fail('gap', 409, 'Dernière relance le ' + new Date(hist.last).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) + ' : ' + cfg.gapDays + ' jours minimum entre deux relances.');
  }

  const phoneRaw = lead.telephone || (b.prospect || {}).telephone || '';
  const email = String(lead.email || '').trim();
  if (await estBloque({ phone: phoneRaw, email: email })) return fail('blocked', 409, 'Ce contact est bloqué.');

  const d = state.draft || {};
  const subject = String(body.emailSubject != null ? body.emailSubject : d.emailSubject || '').trim().slice(0, 200);
  let mailBody = String(body.emailBody != null ? body.emailBody : d.emailBody || '').trim().slice(0, 6000);
  let smsText = String(body.smsText != null ? body.smsText : d.sms || '').trim().slice(0, 640);
  // Un brouillon d'avant le lien court porte encore l'adresse longue : on la
  // remplace à l'envoi, dans l'e-mail comme dans le SMS.
  const cibleLongue = await cibleReservation(cfg, b);
  const lienCourtRdv = await lienDeReservation(cfg, b, card.ref);
  if (lienCourtRdv !== cibleLongue) {
    mailBody = mailBody.split(cibleLongue).join(lienCourtRdv);
    smsText = smsText.split(cibleLongue).join(lienCourtRdv);
  }
  if (wantEmail && (!subject || !mailBody)) return fail('empty_email', 400, 'L\'objet et le texte de l\'e-mail sont obligatoires.');
  if (wantEmail && email.indexOf('@') < 0) return fail('no_email', 409, 'Ce prospect n\'a pas d\'e-mail.');
  if (wantSms && !smsText) return fail('empty_sms', 400, 'Le SMS est vide.');
  if (wantSms) { const ko = smsInterdit(smsText, wantEmail); if (ko) return fail('sms_no_reply', 400, ko); }
  const interdit = contenuInterdit((wantEmail ? subject + ' ' + mailBody : '') + ' ' + (wantSms ? smsText : ''));
  if (interdit) return fail('forbidden_content', 400, interdit);
  let toNumber = null, smsFrom = null;
  if (wantSms) {
    if (lead.smsOptedOut === true || lead.smsOptOut === true) return fail('sms_stop', 409, 'Ce prospect a demandé l\'arrêt des SMS.');
    toNumber = toE164(phoneRaw);
    if (!/^\+\d{8,15}$/.test(toNumber)) return fail('no_phone', 409, 'Numéro du prospect manquant ou invalide.');
    const creds = await getTwilioCreds();
    smsFrom = creds.smsFromNumber || creds.smsFrom || null;
    if (!smsFrom) return fail('sms_not_configured', 500, 'Numéro d\'envoi SMS non configuré.');
  }

  // Verrou anti double clic : un seul envoi en cours par carte.
  const locked = await db.runTransaction(async function (tx) {
    const s = await tx.get(card.ref);
    const cur = s.exists ? (s.data() || {}) : {};
    if (cur.sendingAt && Date.now() - cur.sendingAt < 120000) return false;
    tx.set(card.ref, { bookingId: card.id, leadId: leadId, sendingAt: Date.now() }, { merge: true });
    return true;
  });
  if (!locked) return fail('busy', 409, 'Un envoi est déjà en cours pour ce prospect.');

  const now = Date.now();
  const rec = { at: now, by: auth.uid, byName: parAutomate ? 'Envoi automatique' : ((me && me.name) || auth.email || null), email: false, sms: false };
  if (parAutomate) rec.auto = true;
  let firstError = null;
  try {
    if (wantEmail) {
      try {
        await sendLeadEmail(auth, leadId, subject, mailBody, { label: '✉️ Relance d\'offre (e-mail)', flag: 'offerRelance', bodyHtml: htmlRelance(subject, mailBody, lienCourtRdv) });
        rec.email = true; rec.emailSubject = subject; rec.emailBody = mailBody;
      } catch (e) { firstError = 'E-mail non envoyé : ' + (e && e.message ? e.message : e); }
    }
    // Pas de SMS « je viens de vous envoyer un e-mail » si l'e-mail a échoué.
    if (wantSms && !firstError) {
      try {
        const client = await getTwilioClient();
        // Accusé de l'opérateur (remis / non remis) : lu par le suivi de la page.
        const msg = await client.messages.create({ from: smsFrom, to: toNumber, body: smsText, statusCallback: 'https://team.alteore.com/api/twilio-sms-status' });
        const nowIso = new Date().toISOString();
        await db.collection('leads').doc(leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion({
            type: 'sms', direction: 'outbound', content: smsText, source: 'twilio-sms', date: nowIso, createdAt: nowIso,
            ownerUid: auth.uid, ownerName: rec.byName, ownerSlug: (me && me.slug) || null,
            providerMessageSid: msg.sid, fromNumber: smsFrom, toNumber: toNumber, offerRelance: true,
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '💬 Relance d\'offre (SMS) — ' + smsText.substring(0, 100),
            date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#60a5fa',
          }),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(), lastContactType: 'sms',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        rec.sms = true; rec.smsText = smsText; rec.smsSid = msg.sid;
      } catch (e) { rec.smsError = String(e && e.message ? e.message : e).slice(0, 300); }
    }
  } finally {
    // Toujours écrit avant de répondre : trace de l'envoi + levée du verrou.
    const patch = { sendingAt: null, updatedAt: Date.now() };
    if (rec.email || rec.sms) {
      patch.sends = admin.firestore.FieldValue.arrayUnion(rec);
      patch.sentCount = admin.firestore.FieldValue.increment(1);
      patch.lastSentAt = now;
      if (!state.firstSentAt) patch.firstSentAt = now;
      patch.closerUid = card.closer.uid || null;
      patch.closerName = card.closer.name || null;
      patch.prospectName = prospectName(b, lead);
      patch.outcome = b.outcome;
      patch.draft = Object.assign({}, d, { emailSubject: subject || d.emailSubject || '', emailBody: mailBody || d.emailBody || '', sms: smsText || d.sms || '' });
    }
    try { await card.ref.set(patch, { merge: true }); } catch (e) { console.error('[offer-relances] trace envoi', e && e.message); }
  }
  if (!rec.email && !rec.sms) return fail('send_failed', 502, firstError || ('SMS non envoyé : ' + (rec.smsError || 'erreur inconnue')));

  // Rappel d'appel pour le lendemain, visible dans les rappels de la fiche.
  let callTask = null;
  if (cfg.callTask) {
    try {
      callTask = tomorrowAt10();
      await db.collection('leads').doc(leadId).update({
        followUps: admin.firestore.FieldValue.arrayUnion({
          id: now.toString(36) + Math.random().toString(36).substr(2, 4), dateTime: callTask,
          note: 'Appeler : relance d\'offre envoyée la veille, sans réponse', duration: 15, done: false,
          createdBy: 'Relances d\'offres', createdAt: new Date().toISOString(), source: 'offer_relance', bookingId: card.id,
        }),
      });
    } catch (e) { callTask = null; console.warn('[offer-relances] rappel', e && e.message); }
  }
  return { ok: true, email: rec.email, sms: rec.sms, smsError: rec.smsError || null, at: now, callTask: callTask,
    warning: rec.smsError ? 'E-mail envoyé, mais le SMS a échoué : ' + rec.smsError : null };
}

module.exports = { listOffers, draftOffer, setOffer, sendOffer, previewOffer, loadConfig, CATEGORIES, DEFAULT_PROMPT, htmlRelance, lienDeReservation };
