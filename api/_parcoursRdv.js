// ============================================================================
// api/_parcoursRdv.js — PARCOURS « RENDEZ-VOUS » DES PROSPECTS (24/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 24/11/2026 (plan « Offres ouvertes et no-show ») : entre
// la réservation d'un RDV commercial (self-booking ou posé par un setter) et
// le RDV, le prospect suit UN parcours, un message par moment, chacun avec un
// rôle, sans doublon avec les rappels de l'agenda ni avec le nurturing :
//
//   ① confirmation_email  à la réservation   e-mail soigné, lien, rien à préparer
//   ② confirmation_sms    à la réservation   SMS court
//   ③ valeur_email        si le RDV est à plus de 36 h : « ce que vous allez
//                         retirer de votre audit », envoyé en journée
//   ④ wa_veille           la veille dès 18 h (avant 21 h) : modèle WhatsApp
//                         choisi par Adrien (`rappel_rdv_closing`) ; la
//                         réponse « oui » confirme le RDV (surReponseWhatsapp)
//   ⑤ sms_h1              une heure avant : SMS avec le lien
//   ⑥ rattrapage          5 à 15 min après l'heure, si le prospect n'est pas
//                         dans le Meet : SMS + alerte au closer
//   ⑦ ac_*                ActiveCampaign en direct (api/_activeCampaign.js) :
//                         tag « rdv_a_venir » + sortie du nurturing à la
//                         réservation ; selon l'issue : séquence « rendez-vous
//                         manqué », arrêt, ou séquence du frein (parcours-frein)
//
// Les rappels de l'agenda (Cloud Functions : e-mail de confirmation, SMS,
// J-1, H-1) s'effacent pour un type de consultation dont la config porte
// `notifications.parcoursRdv === true` — c'est ce même drapeau qui désigne
// ici les consultations concernées. Un seul interrupteur, deux côtés.
//
// GARDE-FOUS
//   - `_config/parcours_rdv.actif` faux par défaut : le cron ne fait rien.
//   - `modeTest` VRAI par défaut : seuls les RDV dont le prospect a le
//     téléphone ou l'e-mail d'un membre de test (`testMembres`, lus dans
//     _meta/team_members) reçoivent quelque chose. Tous les autres sont
//     simulés (résultat 'simule'), jamais envoyés.
//   - `depuis` : seuls les RDV CRÉÉS après l'activation entrent dans le
//     parcours — jamais de rattrapage en masse du passé.
//   - Chaque envoi est RÉSERVÉ dans une transaction sur le RDV avant de
//     partir (`bookings/{id}.parcoursRdv.{etape}`). Un envoi qui échoue reste
//     réservé et n'est pas rejoué : l'échec est tracé, à lire.
//   - Variable vide → rien ne part, alerte au setter (jamais de trou).
//   - Aucun texte qui contient un prix ne part (détecteur de relances-core).
//   - Heures de silence : rien avant 8 h ni après 21 h (sauf ⑤ et ⑥, liés à
//     l'heure du RDV lui-même).
//
// Aucune suppression : tout est ajout sur le RDV et sur la fiche lead.
// ============================================================================
'use strict';

const { admin, db } = require('./_firebaseAdmin');
const Dispo = require('../dispo-core.js');
const RelancesCore = require('../relances-core.js');
const MT = require('./_meetTranscript');
const WA = require('./_whatsappClient');

const FV = admin.firestore.FieldValue;
const BASE_URL = 'https://team.alteore.com';

const OUVERTURE = 8 * 60;
const FERMETURE = 21 * 60;

const DEFAUTS = {
  actif: false,
  modeTest: true,
  testMembres: ['adrien'],
  depuis: null,                 // ms : RDV créés après ce moment seulement
  emailCompte: 'strategie',
  signature: 'Adrien & Emily',
  whatsapp: {
    modele: 'rappel_rdv_closing',
    langue: 'fr',
    // Variables du modèle, dans l'ordre {{1}}, {{2}}… — vérifiées contre le
    // modèle validé chez Meta avant CHAQUE passage (nombre exact exigé).
    // rappel_rdv_closing (lu le 24/11/2026) : « Bonsoir {{1}}, c'est {{2}}
    // de l'équipe d'Adrien et Emily… On se retrouve demain à {{3}} en visio »
    // → prénom du prospect, prénom du closer, heure.
    variables: ['prenom', 'expert', 'heure'],
    heure: 18 * 60,
  },
  valeur: { ecartMinH: 36, apresReservationMin: 180 },
  h1: { avantMin: 60, auPlusTardMin: 20 },
  rattrapage: { actif: true, apresMin: 5, jusquaMin: 15 },
  // ActiveCampaign en direct (api/_activeCampaign.js, clé Vercel). Tags par
  // NOM. `nurturing` : automatisations dont le prospect sort à la réservation
  // (35 Élite, 26 Business, 32 ancien Élite).
  activeCampaign: {
    actif: true,
    nurturing: ['35', '26', '32'],
    tagRdv: 'rdv_a_venir', tagStop: 'stop_autom', tagManque: 'rdv_manque',
  },
  textes: {},
  // SMS au nom « adrienemily » (choix d'Adrien du 24/11/2026) : service
  // d'envoi Twilio de l'agenda (_config/twilio.messagingServiceSid, expéditeur
  // alphanumérique). Non livré → renvoyé une fois depuis le 09 (repliSms).
  // 'numero' = tout depuis le 09.
  sms: { expediteur: 'adrienemily' },
};

/* ── Textes par défaut (validés par Adrien le 24/11/2026) ─────────────────
   Vouvoiement, aucun prix, aucune garantie, rien à préparer. Variables :
   {{prenom}} {{expert}} {{date}} {{heure}} {{duree}} {{lien}} {{typeLabel}}.
   Surcharge possible par `_config/parcours_rdv.textes.<clé>`. */
const TEXTES = {
  confirmation_objet: 'Votre audit du {{date}} à {{heure}} est confirmé',
  confirmation_sms: 'Bonjour {{prenom}}, votre audit avec {{expert}} est confirmé le {{date}} à {{heure}}. Rien à préparer, venez comme vous êtes. Le lien est dans votre e-mail. Adrien & Emily',
  valeur_objet: 'Ce que vous allez retirer de votre audit',
  h1_sms: '{{prenom}}, votre audit avec {{expert}} commence à {{heure}}. Votre lien : {{lien}} À tout de suite ! Adrien & Emily',
  h1_sms_sans_lien: '{{prenom}}, votre audit avec {{expert}} commence à {{heure}}. Le lien est dans votre e-mail de confirmation. À tout de suite ! Adrien & Emily',
  rattrapage_sms: '{{prenom}}, {{expert}} vous attend en visio : {{lien}} En cas d\'imprévu, {{expert}} vous appelle dans quelques minutes pour trouver un autre créneau.',
  deplacer_whatsapp: 'Bien noté {{prenom}}, merci de nous avoir prévenus. Nous vous recontactons aujourd\'hui pour trouver un nouveau créneau qui vous convient.',
};

/* ═══ Utilitaires ═══════════════════════════════════════════════════════ */

function fusion(base, sur) {
  const out = Object.assign({}, base);
  Object.keys(sur || {}).forEach(function (k) {
    const v = sur[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = Object.assign({}, base[k], v);
    } else if (v !== undefined) out[k] = v;
  });
  return out;
}

async function lireConfig() {
  const s = await db.collection('_config').doc('parcours_rdv').get();
  return fusion(DEFAUTS, s.exists ? (s.data() || {}) : {});
}

function msDe(v) {
  if (!v) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function prenomDe(nom) {
  const t = String(nom || '').trim().split(/\s+/);
  return t[0] || '';
}

/* « mardi 25 novembre » — sans année, comme à l'oral. Midi UTC : le
   changement d'heure ne fait jamais basculer d'un jour. */
function dateLisible(ymd) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' })
      .format(new Date(ymd + 'T12:00:00Z'));
  } catch (_) { return ymd; }
}
/* '14:30' → '14h30' ; '14:00' → '14h'. */
function heureLisible(hhmm) {
  const p = String(hhmm || '').split(':');
  const h = String(parseInt(p[0], 10) || 0);
  const m = (p[1] || '00');
  return m === '00' ? h + 'h' : h + 'h' + (m.length < 2 ? '0' + m : m);
}

function remplir(modele, vars) {
  return String(modele || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, function (all, k) {
    return vars[k] == null ? '' : String(vars[k]);
  });
}
/* Variables utilisées par un texte et restées vides → nom de la première. */
function variableVide(modele, vars) {
  const re = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(modele || '')))) {
    const v = vars[m[1]];
    if (v == null || String(v).trim() === '') return m[1];
  }
  return null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chiffres(v) { return String(v || '').replace(/\D/g, ''); }
function fin9(v) { const d = chiffres(v); return d.length >= 9 ? d.slice(-9) : ''; }

/* Lien visio à donner au prospect : le lien suivi (compte le clic) s'il
   existe ET que le vrai lien Meet est en place — même règle que
   _abProspectMeetLink des Cloud Functions. */
function lienVisio(b) {
  const brut = (b && b.meetLink) || '';
  if (brut && b.meetTrackedLink) return b.meetTrackedLink;
  return brut;
}

/* ═══ Périmètre ═════════════════════════════════════════════════════════ */

async function lireTypes() {
  const s = await db.collection('booking_config').doc('_types').get();
  const list = (s.exists && Array.isArray((s.data() || {}).list)) ? s.data().list : [];
  const map = {};
  list.forEach(function (t) { if (t && t.id) map[t.id] = t; });
  return map;
}

/* Le type d'un RDV : par identifiant (`type`, puis `typeId`), sinon par
   libellé — même ordre de repli que getBookingTypeNotifications des Cloud
   Functions, pour que les deux côtés décident sur la même consultation. */
function typeDe(b, typeMap) {
  const t = typeMap[b.type] || typeMap[b.typeId];
  if (t) return t;
  const lib = String(b.typeLabel || '');
  if (!lib) return null;
  const ids = Object.keys(typeMap);
  for (let i = 0; i < ids.length; i++) if (typeMap[ids[i]].label === lib) return typeMap[ids[i]];
  return null;
}

/* Même règle que AlteoreFlow.classifyBooking : un RDV coaching, CSM ou client
   n'est jamais un RDV de prospect. */
function estCommercial(b, t) {
  if (b.isCoaching === true || (t && t.isCoaching === true)) return false;
  if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return false;
  return true;
}

/* Le RDV entre-t-il dans le parcours ? Renvoie null si oui, sinon le motif. */
function horsParcours(b, typeMap, cfg) {
  const t = typeDe(b, typeMap);
  if (!t) return 'type_inconnu';
  if (!((t.notifications || {}).parcoursRdv === true)) return 'type_hors_parcours';
  if (!estCommercial(b, t)) return 'pas_un_prospect';
  if (b.status === 'cancelled') return 'annule';
  if (!b.date || !b.time) return 'sans_heure';
  const cree = msDe(b.createdAt);
  if (cfg.depuis && (!cree || cree < cfg.depuis)) return 'cree_avant_activation';
  return null;
}

/* ═══ Destinataires de test ═════════════════════════════════════════════ */

async function lireMembres() {
  const s = await db.collection('_meta').doc('team_members').get();
  const raw = s.exists ? (s.data() || {}).members : null;
  return Array.isArray(raw) ? raw : Object.values(raw || {});
}

async function destinatairesTest(cfg) {
  const membres = await lireMembres();
  const out = { tel: {}, email: {}, membres: [] };
  (cfg.testMembres || []).forEach(function (slug) {
    const m = membres.find(function (x) { return x && x.slug === slug; });
    if (!m) return;
    out.membres.push(slug);
    Object.keys(m).forEach(function (k) {
      if (/phone|tel|mobile|whatsapp/i.test(k) && fin9(m[k])) out.tel[fin9(m[k])] = true;
      if (/mail/i.test(k) && m[k] && /@/.test(String(m[k]))) out.email[String(m[k]).trim().toLowerCase()] = true;
    });
  });
  (cfg.testTelephones || []).forEach(function (t) { if (fin9(t)) out.tel[fin9(t)] = true; });
  (cfg.testEmails || []).forEach(function (e) { if (e) out.email[String(e).trim().toLowerCase()] = true; });
  // Le numéro et l'e-mail de test d'Adrien vivent déjà dans _config/relances
  // (sa fiche d'équipe n'a pas de téléphone) : on les reprend, un seul endroit.
  try {
    const r = await db.collection('_config').doc('relances').get();
    const d = r.exists ? (r.data() || {}) : {};
    if (fin9(d.testTelephone)) out.tel[fin9(d.testTelephone)] = true;
    if (d.testEmail && /@/.test(String(d.testEmail))) out.email[String(d.testEmail).trim().toLowerCase()] = true;
    out.relances = { tel: d.testTelephone || null, email: d.testEmail || null };
  } catch (e) { console.warn('[parcours-rdv] relances test', e && e.message); }
  return out;
}

function estRdvDeTest(b, T) {
  const p = b.prospect || {};
  const tel = fin9(p.telephone || p.tel);
  const em = String(p.email || '').trim().toLowerCase();
  return !!((tel && T.tel[tel]) || (em && T.email[em]));
}

/* ═══ Variables d'un RDV ════════════════════════════════════════════════ */

function variablesDe(b, t) {
  const p = b.prospect || {};
  const duree = b.displayDuration || (t && t.displayDuration) || b.duration || (t && t.duration) || null;
  return {
    prenom: String(p.prenom || '').trim() || prenomDe(p.nom),
    nom: String(p.nom || '').trim(),
    expert: prenomDe(b.personName || b.expertName || ''),
    expertComplet: String(b.personName || b.expertName || '').trim(),
    date: dateLisible(b.date),
    heure: heureLisible(b.time),
    duree: duree ? String(duree) + ' min' : '',
    lien: lienVisio(b),
    // « Audit Stratégique Personnalisé (claire) » : le nom entre parenthèses
    // sert à l'équipe (une consultation par closer), jamais au prospect.
    typeLabel: String(b.typeLabel || (t && (t.label || t.name)) || 'Audit Stratégique').replace(/\s*\([^)]*\)\s*$/, '').trim(),
  };
}

/* ═══ E-mails (mise en page soignée, lisible sur téléphone) ═════════════ */

function gabaritEmail(o) {
  // o : { titre, sousTitre, corpsHtml, signature }
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<title>' + esc(o.titre) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f3f4f8;-webkit-text-size-adjust:100%">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(o.preheader || '') + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:28px 12px">'
    + '<tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Helvetica,Arial,sans-serif">'
    // En-tête
    + '<tr><td style="background:#1e3a8a;background-image:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);border-radius:18px 18px 0 0;padding:34px 36px 30px;text-align:left">'
    + '<div style="font-size:12px;font-weight:700;color:#c7d2fe;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:14px">Adrien &amp; Emily</div>'
    + '<div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.3">' + esc(o.titre) + '</div>'
    + (o.sousTitre ? '<div style="font-size:15px;color:#dbeafe;margin-top:8px;line-height:1.5">' + esc(o.sousTitre) + '</div>' : '')
    + '</td></tr>'
    // Corps
    + '<tr><td style="background:#ffffff;padding:32px 36px 28px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">'
    + '<div style="font-size:16px;line-height:1.7;color:#1f2937">' + o.corpsHtml + '</div>'
    + '<div style="margin-top:26px;font-size:16px;line-height:1.6;color:#1f2937">À très vite,<br><strong>' + esc(o.signature || 'Adrien & Emily') + '</strong></div>'
    + '</td></tr>'
    // Pied
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 18px 18px;padding:20px 36px;text-align:center">'
    + '<div style="font-size:12px;color:#9ca3af;line-height:1.6">Adrien &amp; Emily · Accompagnement des dirigeants<br>'
    + '<a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a></div>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function blocRdv(v) {
  function ligne(lib, val, premier) {
    return '<tr><td style="padding:12px 18px;font-size:13px;color:#6b7280;width:96px;' + (premier ? '' : 'border-top:1px solid #e5e7eb;') + '">' + lib + '</td>'
      + '<td style="padding:12px 18px;font-size:15px;color:#111827;font-weight:600;' + (premier ? '' : 'border-top:1px solid #e5e7eb;') + '">' + esc(val) + '</td></tr>';
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;margin:22px 0">'
    + ligne('Date', v.date.charAt(0).toUpperCase() + v.date.slice(1), true)
    + ligne('Heure', v.heure + (v.duree ? ' · ' + v.duree : ''), false)
    + (v.expertComplet ? ligne('Avec', v.expertComplet, false) : '')
    + ligne('Où', 'En visio, depuis chez vous', false)
    + '</table>';
}

function bouton(lien, libelle) {
  if (!lien) return '';
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr>'
    + '<td style="background:#2563eb;border-radius:10px">'
    + '<a href="' + esc(lien) + '" style="display:inline-block;padding:15px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">' + esc(libelle) + '</a>'
    + '</td></tr></table>'
    + '<div style="font-size:12px;color:#9ca3af;margin:-12px 0 20px;word-break:break-all">Ou copiez ce lien : ' + esc(lien) + '</div>';
}

function p(html) { return '<p style="margin:0 0 16px">' + html + '</p>'; }

function emailConfirmation(v, cfg) {
  const objet = remplir((cfg.textes && cfg.textes.confirmation_objet) || TEXTES.confirmation_objet, v);
  const corps = p('Bonjour <strong>' + esc(v.prenom) + '</strong>,')
    + p('Votre ' + esc(v.typeLabel) + ' avec ' + esc(v.expertComplet || v.expert) + ' est confirmé.')
    + blocRdv(v)
    + bouton(v.lien, 'Rejoindre la visio')
    + p('<strong>Vous n\'avez rien à préparer.</strong> Venez simplement avec ce qui vous occupe l\'esprit en ce moment dans votre entreprise : c\'est de là que nous partirons.')
    + p('Ce créneau est réservé pour vous. Installez-vous au calme, de préférence devant un ordinateur.')
    + '<div style="background:#eff6ff;border-radius:10px;padding:14px 18px;font-size:14px;color:#1e40af;line-height:1.6">Un empêchement ? Répondez simplement à cet e-mail : nous déplacerons le rendez-vous plutôt que de le perdre.</div>';
  return {
    objet: objet,
    html: gabaritEmail({ titre: 'Votre rendez-vous est confirmé', sousTitre: v.date.charAt(0).toUpperCase() + v.date.slice(1) + ' à ' + v.heure,
      preheader: 'Rien à préparer : venez simplement comme vous êtes.', corpsHtml: corps, signature: cfg.signature }),
    texte: 'Bonjour ' + v.prenom + ',\n\nVotre ' + v.typeLabel + ' avec ' + (v.expertComplet || v.expert) + ' est confirmé : le ' + v.date + ' à ' + v.heure
      + (v.duree ? ' (' + v.duree + ')' : '') + ', en visio.\n\n' + (v.lien ? 'Rejoindre la visio : ' + v.lien + '\n\n' : '')
      + 'Vous n\'avez rien à préparer. Venez simplement avec ce qui vous occupe l\'esprit en ce moment dans votre entreprise : c\'est de là que nous partirons.\n\n'
      + 'Ce créneau est réservé pour vous. Installez-vous au calme, de préférence devant un ordinateur.\n\n'
      + 'Un empêchement ? Répondez simplement à cet e-mail : nous déplacerons le rendez-vous plutôt que de le perdre.\n\nÀ très vite,\n' + cfg.signature,
  };
}

function emailValeur(v, cfg) {
  const objet = remplir((cfg.textes && cfg.textes.valeur_objet) || TEXTES.valeur_objet, v);
  function etape(n, titre, texte) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr>'
      + '<td valign="top" style="width:40px"><div style="width:30px;height:30px;border-radius:15px;background:#dbeafe;color:#1d4ed8;font-weight:800;font-size:14px;line-height:30px;text-align:center">' + n + '</div></td>'
      + '<td valign="top" style="font-size:15px;line-height:1.6;color:#1f2937"><strong>' + titre + '</strong><br>' + texte + '</td></tr></table>';
  }
  const temoignage = (cfg.textes && cfg.textes.valeur_temoignage) || '';
  const corps = p('Bonjour <strong>' + esc(v.prenom) + '</strong>,')
    + p('Vous avez rendez-vous avec ' + esc(v.expertComplet || v.expert) + ' le ' + esc(v.date) + ' à ' + esc(v.heure) + '. Voici comment se déroule l\'audit, pour que vous arriviez sans surprise.')
    + '<div style="margin:22px 0 8px">'
    + etape(1, 'On commence par vous.', 'Ce qui vous prend le plus de temps et d\'énergie aujourd\'hui, avec vos mots.')
    + etape(2, 'On met le doigt sur ce qui bloque.', 'La plupart des dirigeants pensent que leur problème est commercial. Souvent, c\'est la marge ou l\'organisation qui bloque.')
    + etape(3, 'Vous repartez avec vos priorités.', 'Deux ou trois actions concrètes, que nous travaillions ensemble ou non.')
    + '</div>'
    + '<div style="border-left:4px solid #3b82f6;background:#f8fafc;border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0;font-size:16px;line-height:1.6;color:#1e293b">'
    + 'D\'ici là, une seule question à garder en tête : <strong>si rien ne change dans les douze prochains mois, où en sera votre entreprise ?</strong></div>'
    + (temoignage ? '<div style="background:#fefce8;border-radius:10px;padding:16px 20px;margin:20px 0;font-size:15px;line-height:1.6;color:#713f12;font-style:italic">' + esc(temoignage) + '</div>' : '')
    + bouton(v.lien, 'Mon lien de visio');
  return {
    objet: objet,
    html: gabaritEmail({ titre: 'Ce que vous allez retirer de votre audit', sousTitre: 'Rendez-vous le ' + v.date + ' à ' + v.heure,
      preheader: 'Comment se déroule l\'audit, en trois temps.', corpsHtml: corps, signature: cfg.signature }),
    texte: 'Bonjour ' + v.prenom + ',\n\nVous avez rendez-vous avec ' + (v.expertComplet || v.expert) + ' le ' + v.date + ' à ' + v.heure
      + '. Voici comment se déroule l\'audit, pour que vous arriviez sans surprise.\n\n'
      + '1. On commence par vous. Ce qui vous prend le plus de temps et d\'énergie aujourd\'hui, avec vos mots.\n'
      + '2. On met le doigt sur ce qui bloque. La plupart des dirigeants pensent que leur problème est commercial. Souvent, c\'est la marge ou l\'organisation qui bloque.\n'
      + '3. Vous repartez avec vos priorités. Deux ou trois actions concrètes, que nous travaillions ensemble ou non.\n\n'
      + 'D\'ici là, une seule question à garder en tête : si rien ne change dans les douze prochains mois, où en sera votre entreprise ?\n\n'
      + (temoignage ? temoignage + '\n\n' : '') + (v.lien ? 'Votre lien de visio : ' + v.lien + '\n\n' : '') + 'À très vite,\n' + cfg.signature,
  };
}

/* ═══ Envois bas niveau ═════════════════════════════════════════════════ */

async function envoyerEmail(to, mail, cfg) {
  if (!to || !/@/.test(to)) return { ok: false, canal: 'email', erreur: 'email_absent' };
  if (RelancesCore.contientPrix(mail.objet + ' ' + mail.texte)) return { ok: false, canal: 'email', erreur: 'texte_contient_un_prix' };
  try {
    const { sendEmailFromAccount } = require('./_gmailSend');
    const r = await sendEmailFromAccount({ accountKey: cfg.emailCompte || 'strategie', to: to, subject: mail.objet, bodyHtml: mail.html, bodyText: mail.texte });
    if (!r || !r.ok) return { ok: false, canal: 'email', erreur: (r && r.error) || 'echec_gmail' };
    return { ok: true, canal: 'email', id: r.messageId || null, texte: mail.objet + '\n\n' + mail.texte };
  } catch (e) {
    return { ok: false, canal: 'email', erreur: (e && e.message) || 'echec_gmail' };
  }
}

function telE164(v) {
  const d = chiffres(v);
  if (!d) return null;
  if (String(v).trim().charAt(0) === '+') return '+' + d;
  if (d.length === 10 && d.charAt(0) === '0') return '+33' + d.slice(1);
  if (d.length === 11 && d.slice(0, 2) === '33') return '+' + d;
  return d.length >= 10 ? '+' + d : null;
}

/* Client Twilio du service d'envoi au nom « adrienemily » : celui de
   l'agenda (_config/twilio : accountSid, authToken, messagingServiceSid),
   le même que les SMS des Cloud Functions. */
let _twilioAlpha = null;
async function clientAlpha() {
  if (_twilioAlpha) return _twilioAlpha;
  const s = await db.collection('_config').doc('twilio').get();
  const d = s.exists ? (s.data() || {}) : {};
  if (!d.accountSid || !d.authToken || !d.messagingServiceSid) return null;
  const twilio = require('twilio');
  _twilioAlpha = { client: twilio(d.accountSid, d.authToken), service: d.messagingServiceSid };
  return _twilioAlpha;
}

/* mode : 'adrienemily' (service d'envoi, nom affiché) | 'numero' (le 09). */
async function envoyerSms(tel, texte, mode) {
  const to = telE164(tel);
  if (!to) return { ok: false, canal: 'sms', erreur: 'telephone_absent' };
  if (RelancesCore.contientPrix(texte)) return { ok: false, canal: 'sms', erreur: 'texte_contient_un_prix' };
  try {
    if (mode === 'adrienemily') {
      const a = await clientAlpha();
      if (a) {
        const m = await a.client.messages.create({ messagingServiceSid: a.service, to: to, body: texte, statusCallback: BASE_URL + '/api/twilio-sms-status' });
        return { ok: true, canal: 'sms', id: m.sid, texte: texte, from: 'adrienemily', expediteur: 'adrienemily' };
      }
      // Service absent : on ne perd pas le SMS, il part du 09.
    }
    const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
    const creds = await getTwilioCreds();
    const from = creds.smsFromNumber || creds.smsFrom;
    if (!from) return { ok: false, canal: 'sms', erreur: 'smsFromNumber_absent' };
    const client = await getTwilioClient();
    const m = await client.messages.create({ from: from, to: to, body: texte, statusCallback: BASE_URL + '/api/twilio-sms-status' });
    return { ok: true, canal: 'sms', id: m.sid, texte: texte, from: from, expediteur: 'numero' };
  } catch (e) {
    return { ok: false, canal: 'sms', erreur: (e && e.message) || 'echec_twilio' };
  }
}

/* Statut Twilio d'un SMS envoyé au nom « adrienemily » ('delivered',
   'undelivered', 'failed', 'sent'…), ou null si illisible. */
async function statutSmsAlpha(sid) {
  try {
    const a = await clientAlpha();
    if (!a || !sid) return null;
    const m = await a.client.messages(sid).fetch();
    return String(m.status || '').toLowerCase() || null;
  } catch (e) { return null; }
}

/* Le modèle WhatsApp tel que Meta l'a validé : statut, nombre de variables
   du corps, boutons. Mis en cache le temps d'un passage. */
async function lireModeleWhatsapp(cfg, cache) {
  if (cache && cache.modele) return cache.modele;
  const nom = cfg.whatsapp.modele;
  const out = { nom: nom, ok: false, nbVariables: null, statut: null, langue: null, erreur: null, corps: null, boutons: [] };
  try {
    const creds = await WA.getWhatsappCreds();
    if (!creds.wabaId) { out.erreur = 'wabaId_absent'; return out; }
    const rep = await WA.graph(creds.wabaId + '/message_templates?name=' + encodeURIComponent(nom) + '&fields=name,status,language,components,parameter_format&limit=20');
    if (!rep.ok) { out.erreur = rep.erreur || 'lecture_modele'; return out; }
    const liste = (rep.data && rep.data.data) || [];
    const m = liste.find(function (x) { return x.name === nom && x.language === cfg.whatsapp.langue; })
      || liste.find(function (x) { return x.name === nom; });
    if (!m) { out.erreur = 'modele_introuvable'; return out; }
    out.statut = m.status; out.langue = m.language;
    if (String(m.parameter_format || 'POSITIONAL').toUpperCase() === 'NAMED') { out.erreur = 'modele_a_variables_nommees_non_gere'; return out; }
    const body = (m.components || []).find(function (c) { return c.type === 'BODY'; }) || {};
    out.corps = body.text || '';
    const nums = {};
    String(out.corps).replace(/\{\{(\d+)\}\}/g, function (a, n) { nums[n] = true; return a; });
    out.nbVariables = Object.keys(nums).length;
    const btn = (m.components || []).find(function (c) { return c.type === 'BUTTONS'; });
    out.boutons = btn ? (btn.buttons || []).map(function (b) { return { type: b.type, texte: b.text }; }) : [];
    if (m.status !== 'APPROVED') { out.erreur = 'modele_non_approuve'; return out; }
    if (out.nbVariables !== cfg.whatsapp.variables.length) { out.erreur = 'nombre_de_variables_different (modèle ' + out.nbVariables + ', réglage ' + cfg.whatsapp.variables.length + ')'; return out; }
    if (btn && (btn.buttons || []).some(function (b) { return b.type === 'URL' && /\{\{\d+\}\}/.test(b.url || ''); })) { out.erreur = 'bouton_url_dynamique_non_gere'; return out; }
    out.ok = true;
    return out;
  } catch (e) {
    out.erreur = (e && e.message) || 'lecture_modele';
    return out;
  } finally {
    if (cache) cache.modele = out;
  }
}

/* ═══ Traces ════════════════════════════════════════════════════════════ */

function dateFr() { return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }); }

const LIBELLES = {
  confirmation_email: 'e-mail de confirmation', confirmation_sms: 'SMS de confirmation',
  valeur_email: 'e-mail « ce que vous allez retirer de votre audit »', wa_veille: 'WhatsApp de confirmation de la veille',
  sms_h1: 'SMS une heure avant', rattrapage: 'SMS de rattrapage (prospect absent)',
};

async function tracerSurLead(leadId, etape, r) {
  if (!leadId || !r || !r.ok) return;
  const iso = new Date().toISOString();
  const comm = {
    type: r.canal, direction: 'outbound', content: String(r.texte || '').slice(0, 2000),
    source: 'parcours_rdv', auto: true, date: iso, createdAt: iso, parcoursEtape: etape,
    providerMessageSid: r.id || null, ownerName: 'Parcours RDV',
  };
  try {
    await db.collection('leads').doc(String(leadId)).update({
      communications: FV.arrayUnion(comm),
      timeline_history: FV.arrayUnion({ text: '📅 Parcours RDV — ' + (LIBELLES[etape] || etape) + ' envoyé', date: dateFr(), color: '#60a5fa' }),
    });
  } catch (e) { console.warn('[parcours-rdv] trace lead', leadId, e && e.message); }
}

/* Alerte dans la cloche Team (inbox_notifications, même forme que les
   mentions des Cloud Functions). */
async function alerter(uids, o) {
  const liste = (uids || []).filter(Boolean);
  if (!liste.length) return 0;
  const batch = db.batch();
  liste.forEach(function (uid) {
    batch.set(db.collection('inbox_notifications').doc(), {
      ownerUid: uid, type: 'parcours_rdv_' + o.type, authorUid: null, authorName: 'Parcours RDV',
      leadId: o.leadId || null, leadName: o.leadName || '', preview: String(o.texte || '').slice(0, 300),
      deepLinkUrl: o.leadId ? ('/sales-leads.html?app=1&leadId=' + o.leadId) : '/sales-leads.html',
      createdAt: FV.serverTimestamp(), readBy: {},
    });
  });
  await batch.commit().catch(function (e) { console.warn('[parcours-rdv] alerte', e && e.message); });
  return liste.length;
}

/* Qui prévenir pour ce RDV : le setter du lead (ou du RDV), sinon le closer.
   Mode 'closer' : le closer d'abord (rattrapage). */
async function destinatairesAlerte(b, mode) {
  const membres = await lireMembres();
  function uidDuSlug(slug) {
    const m = membres.find(function (x) { return x && x.slug === slug; });
    return m && m.firebaseUid && m.active !== false && m.departed !== true ? m.firebaseUid : null;
  }
  let setterUid = null;
  let closerUid = null;
  let lead = null;
  if (b.leadId) {
    try { const s = await db.collection('leads').doc(String(b.leadId)).get(); lead = s.exists ? (s.data() || {}) : null; } catch (_) { lead = null; }
  }
  const setterSlug = b.setterSlug || (lead && (lead.setterSlug || lead.assignedTo)) || null;
  if (setterSlug) setterUid = uidDuSlug(setterSlug);
  if (b.personId) {
    try {
      const s = await db.collection('booking_config').doc(String(b.personId)).get();
      closerUid = s.exists ? ((s.data() || {}).firebaseUid || null) : null;
    } catch (_) { closerUid = null; }
  }
  const out = mode === 'closer' ? [closerUid, setterUid] : [setterUid || closerUid];
  return out.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
}

/* ═══ Réservation transactionnelle d'une étape ══════════════════════════ */

async function reserver(ref, etape, opts) {
  return db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    if (!s.exists) return 'disparu';
    const d = s.data() || {};
    // Un RDV annulé ne reçoit plus rien… sauf la suite ActiveCampaign, qui
    // existe justement à cause de l'annulation (opts.memeAnnule).
    if (d.status === 'cancelled' && !(opts && opts.memeAnnule)) return 'annule';
    if (((d.parcoursRdv || {}).etapes || {})[etape]) return 'deja';
    const patch = { parcoursRdv: { etapes: {} } };
    patch.parcoursRdv.etapes[etape] = { reserveA: Date.now() };
    tx.set(ref, patch, { merge: true });
    return 'ok';
  });
}

async function noter(ref, etape, r) {
  const patch = { parcoursRdv: { etapes: {} } };
  patch.parcoursRdv.etapes[etape] = {
    at: Date.now(), ok: !!r.ok, canal: r.canal || null, id: r.id || r.wamid || null,
    erreur: r.erreur || null, motif: r.motif || null,
  };
  if (r.expediteur) { patch.parcoursRdv.etapes[etape].expediteur = r.expediteur; patch.parcoursRdv.etapes[etape].texteSms = r.texte || null; }
  if (r.wamid) patch.parcoursRdv.waVeilleWamid = r.wamid;
  await ref.set(patch, { merge: true }).catch(function (e) { console.warn('[parcours-rdv] trace', e && e.message); });
}

/* ═══ ActiveCampaign ═══════════════════════════════════════════════════ */

/* ActiveCampaign en direct (plus de Make, demande d'Adrien du 24/11/2026).
   evenement :
   - 'rdv_pris'       → tag `rdv_a_venir` + sortie du nurturing (35/26/32) ;
   - 'rdv_libere'     → RDV manqué (no-show) ou annulé sans report : tag
                        `rdv_a_venir` retiré, tag `rdv_manque` → séquence
                        « votre rendez-vous n'a pas pu avoir lieu » ;
   - 'nurturing_stop' → offre / close / disqualifié : `stop_autom`, tag retiré ;
   - 'frein'          → tag du frein (extra.tag) + `stop_autom`, tag retiré. */
async function versActiveCampaign(cfg, evenement, b, extra) {
  const A = cfg.activeCampaign || {};
  if (A.actif === false) return { ok: false, canal: 'ac', erreur: 'ac_coupe' };
  const AC = require('./_activeCampaign');
  const p = b.prospect || {};
  const c = await AC.contact(p.email, { firstName: p.prenom || undefined, lastName: p.nom || undefined });
  if (!c.ok) return { ok: false, canal: 'ac', erreur: c.erreur || 'contact' };
  const faits = [];
  async function pas(r, lib) { if (!r.ok) throw new Error(lib + ' : ' + (r.erreur || 'echec')); faits.push(lib); }
  try {
    if (evenement === 'rdv_pris') {
      await pas(await AC.ajouterTag(c.id, A.tagRdv || 'rdv_a_venir'), '+' + (A.tagRdv || 'rdv_a_venir'));
      const s = await AC.sortirDesAutomatisations(c.id, A.nurturing || []);
      await pas(s, 'sortie nurturing ' + ((s.sortis || []).join(',') || 'aucune en cours'));
    } else if (evenement === 'rdv_libere') {
      await pas(await AC.retirerTag(c.id, A.tagRdv || 'rdv_a_venir'), '-' + (A.tagRdv || 'rdv_a_venir'));
      await pas(await AC.ajouterTag(c.id, A.tagManque || 'rdv_manque'), '+' + (A.tagManque || 'rdv_manque'));
    } else if (evenement === 'nurturing_stop') {
      await pas(await AC.ajouterTag(c.id, A.tagStop || 'stop_autom'), '+' + (A.tagStop || 'stop_autom'));
      await pas(await AC.retirerTag(c.id, A.tagRdv || 'rdv_a_venir'), '-' + (A.tagRdv || 'rdv_a_venir'));
    } else if (evenement === 'frein') {
      if (!extra || !extra.tag) return { ok: false, canal: 'ac', erreur: 'tag_frein_absent' };
      await pas(await AC.ajouterTag(c.id, extra.tag), '+' + extra.tag);
      await pas(await AC.ajouterTag(c.id, A.tagStop || 'stop_autom'), '+' + (A.tagStop || 'stop_autom'));
      await pas(await AC.retirerTag(c.id, A.tagRdv || 'rdv_a_venir'), '-' + (A.tagRdv || 'rdv_a_venir'));
    } else return { ok: false, canal: 'ac', erreur: 'evenement_inconnu' };
  } catch (e) {
    return { ok: false, canal: 'ac', erreur: e.message, texte: faits.join(' ; '), id: c.id };
  }
  return { ok: true, canal: 'ac', id: c.id, texte: evenement + ' : ' + faits.join(' ; ') };
}

/* Après le RDV : que fait le nurturing ?
   - no-show / annulé (hors report) → séquence « rendez-vous manqué » ;
   - non-close → séquence personnalisée selon le frein (parcours-frein.js) ;
   - offre / close / disqualifié → arrêt (le closer suit, ou client). */
function suiteNurturing(b) {
  if (b.rescheduled === true || (b.cancellation && b.cancellation.via === 'reschedule')) return null;
  const o = b.outcome || null;
  if (b.status === 'cancelled' && !o) return 'rdv_libere';
  if (o === 'no_show' || o === 'annule') return 'rdv_libere';
  // non_close : c'est api/parcours-frein.js qui, à J+1, lit l'appel, choisit
  // le frein et bascule le prospect vers la séquence qui y répond (au plus
  // tard J+3, séquence « générale » à défaut d'enregistrement).
  if (o === 'offre' || o === 'close' || o === 'disqualifie') return 'nurturing_stop';
  return null;
}

/* ═══ Décisions de temps (pures, testables) ═════════════════════════════ */

/* now, debut, cree : ms. nowMin : minute de Paris. Renvoie la liste des
   étapes dues maintenant, dans l'ordre. */
function etapesDues(o) {
  const cfg = o.cfg;
  const now = o.now, debut = o.debut, cree = o.cree || o.now;
  const nowMin = o.nowMin;
  const fait = o.faites || {};
  const out = [];
  const avant = debut - now;
  const journee = nowMin >= OUVERTURE && nowMin < FERMETURE;
  const sansIssue = !o.outcome;

  if (avant > 0 && sansIssue) {
    // ① ② : dès que possible, en journée ; la nuit, au matin (si le RDV
    // n'est pas déjà passé). Un RDV pris dans l'heure n'a besoin que de ⑤.
    if (journee && avant > 75 * 60000) {
      if (!fait.confirmation_email) out.push('confirmation_email');
      if (!fait.confirmation_sms) out.push('confirmation_sms');
    }
    // ③ : seulement si le RDV a été pris à plus de 36 h, au moins 3 h après
    // la réservation, et à plus de 20 h du RDV.
    if (journee && !fait.valeur_email && (debut - cree) >= cfg.valeur.ecartMinH * 3600000
        && (now - cree) >= cfg.valeur.apresReservationMin * 60000 && avant >= 20 * 3600000) {
      out.push('valeur_email');
    }
    // ④ : la veille, de 18 h à 21 h ; jamais si la présence est déjà confirmée.
    if (!fait.wa_veille && o.estDemain && nowMin >= cfg.whatsapp.heure && nowMin < FERMETURE && !o.presenceConfirmee) {
      out.push('wa_veille');
    }
    // ⑤ : entre 60 et 20 min avant.
    if (!fait.sms_h1 && avant <= cfg.h1.avantMin * 60000 && avant > cfg.h1.auPlusTardMin * 60000) {
      out.push('sms_h1');
    }
  }
  // ⑥ : de +5 à +15 min, tant qu'aucune issue n'est posée.
  if (cfg.rattrapage.actif && !fait.rattrapage && sansIssue
      && now >= debut + cfg.rattrapage.apresMin * 60000 && now < debut + cfg.rattrapage.jusquaMin * 60000) {
    out.push('rattrapage');
  }
  return out;
}

/* ═══ Réponse au WhatsApp de la veille ══════════════════════════════════ */

const RE_OUI = /^\s*(oui|ouais|yes|ok|okay|d'?accord|dac|parfait|top|super|tr[eè]s bien|c'?est (bon|not[eé]|parfait)|je (serai|suis) (bien )?(l[aà]|pr[eé]sente?)|je confirme|confirm[eé]?|pr[eé]sente?|bien re[cç]u|avec plaisir|[👍✅🙏👌])/i;
const RE_DEPLACER = /(d[eé]placer|d[eé]caler|reporter|report|reprogram|emp[eê]ch|annul|pas (dispo|disponible|libre)|ne (pourrai|peux) pas|autre (cr[eé]neau|date|jour|heure)|changer)/i;

function lireReponse(texte, payload) {
  const t = String(texte || '').trim();
  const pl = String(payload || '').trim();
  const tout = (pl + ' ' + t).trim();
  if (!tout) return 'autre';
  if (RE_DEPLACER.test(tout)) return 'deplacer';
  if (RE_OUI.test(t) || RE_OUI.test(pl)) {
    // « oui mais … » ou une question : on ne confirme pas sur un doute.
    if (/\?|\bmais\b/i.test(t) && t.length > 12) return 'autre';
    return 'oui';
  }
  return 'autre';
}

/* Retrouve le RDV visé par une réponse WhatsApp : d'abord par le message
   cité (context.id = wamid du modèle), sinon par le numéro, parmi les RDV
   d'aujourd'hui et de demain qui ont reçu le WhatsApp de la veille. */
async function rdvDeLaReponse(de, contextId) {
  if (contextId) {
    const s = await db.collection('bookings').where('parcoursRdv.waVeilleWamid', '==', String(contextId)).limit(1).get();
    if (!s.empty) return { id: s.docs[0].id, ref: s.docs[0].ref, data: s.docs[0].data() || {} };
  }
  const n = fin9(de);
  if (!n) return null;
  const auj = Dispo.parisStamp(new Date()).ymd;
  const jours = [auj, Dispo.addDays(auj, 1)];
  let trouve = null;
  for (let i = 0; i < jours.length && !trouve; i++) {
    const s = await db.collection('bookings').where('date', '==', jours[i]).get();
    s.forEach(function (d) {
      if (trouve) return;
      const b = d.data() || {};
      const et = (b.parcoursRdv || {}).etapes || {};
      if (b.status === 'cancelled' || !et.wa_veille || !et.wa_veille.ok) return;
      if (fin9((b.prospect || {}).telephone || (b.prospect || {}).tel) === n) trouve = { id: d.id, ref: d.ref, data: b };
    });
  }
  return trouve;
}

/* Confirmation automatique : mêmes structures que api/rdv-presence.js
   (rdv_confirmations/{id} + bookings.presenceConfirmed), preuve = le
   WhatsApp du prospect. Immuable : déjà confirmé → rien. */
async function confirmerPresence(rdv, preuve) {
  const b = rdv.data;
  const now = Date.now();
  const confRef = db.collection('rdv_confirmations').doc(rdv.id);
  const conf = {
    bookingId: rdv.id, leadId: b.leadId || null,
    leadName: (((b.prospect || {}).prenom || '') + ' ' + ((b.prospect || {}).nom || '')).trim(),
    rdvDate: b.date || '', rdvTime: b.time || '', rdvPersonId: b.personId || null,
    rdvLabel: dateLisible(b.date) + ' à ' + heureLisible(b.time) + (b.personName ? ' avec ' + b.personName : ''),
    channel: 'wa', proof: preuve, confirmedAt: FV.serverTimestamp(), confirmedAtMs: now,
    by: { uid: null, slug: null, name: 'Parcours RDV (réponse WhatsApp)', role: 'auto' },
    summary: null, summaryStatus: 'n/a', auto: true,
  };
  const marker = { at: now, by: 'parcours_rdv', byName: 'Réponse WhatsApp du prospect', bySlug: null, channel: 'wa', auto: true };
  let fait = false;
  await db.runTransaction(async function (tx) {
    const bs = await tx.get(rdv.ref);
    const cs = await tx.get(confRef);
    if (cs.exists || (bs.data() || {}).presenceConfirmed) return;
    tx.set(confRef, conf);
    tx.update(rdv.ref, { presenceConfirmed: marker });
    fait = true;
  });
  if (fait && b.leadId) {
    await db.collection('leads').doc(String(b.leadId)).update({
      timeline_history: FV.arrayUnion({ text: '✅ Présence au RDV du ' + conf.rdvLabel + ' confirmée par le prospect (réponse au WhatsApp de la veille)', date: dateFr(), color: '#34d399' }),
    }).catch(function (e) { console.warn('[parcours-rdv] timeline', e && e.message); });
  }
  return fait;
}

/* Appelé par whatsapp-webhook.js pour chaque message entrant. Ne lance
   jamais : une erreur ici ne doit pas casser la réception du message. */
async function surReponseWhatsapp(o) {
  try {
    const rdv = await rdvDeLaReponse(o.de, o.contextId);
    if (!rdv) return { traite: false };
    const b = rdv.data;
    const et = (b.parcoursRdv || {}).etapes || {};
    if (!et.wa_veille || !et.wa_veille.ok) return { traite: false };
    const sens = lireReponse(o.texte, o.payload);
    const deja = (b.parcoursRdv || {}).reponse;
    // Meta rejoue parfois un webhook : le même message n'est traité qu'une fois.
    if (o.wamid && deja && deja.wamid === o.wamid) return { traite: false, doublon: true };
    const trace = { at: Date.now(), sens: sens, texte: String(o.texte || o.payload || '').slice(0, 300), wamid: o.wamid || null };
    await rdv.ref.set({ parcoursRdv: { reponse: trace, reponses: FV.arrayUnion(trace) } }, { merge: true });
    const v = variablesDe(b, null);
    const leadName = (v.prenom + ' ' + v.nom).trim();

    if (sens === 'oui') {
      const ok = await confirmerPresence(rdv, { kind: 'wa', id: o.wamid || null, at: Date.now(), text: trace.texte, from: '+' + chiffres(o.de), auto: true });
      return { traite: true, sens: sens, confirme: ok };
    }
    if (sens === 'deplacer') {
      // Le report de booking.html (?reschedule=) n'existe qu'en interne
      // (iframe authentifiée) : le prospect reçoit un accusé, le setter
      // reprend la main. Une seule réponse automatique par RDV.
      let envoye = false;
      if (!deja || deja.sens !== 'deplacer') {
        const texte = remplir(TEXTES.deplacer_whatsapp, v);
        if (!variableVide(TEXTES.deplacer_whatsapp, v)) {
          const r = await WA.envoyerTexte({ to: o.de, texte: texte, contexte: { type: 'parcours_rdv_deplacer', bookingId: rdv.id, leadId: b.leadId || null } }).catch(function (e) { return { ok: false, erreur: e && e.message }; });
          envoye = !!(r && r.ok);
        }
      }
      await alerter(await destinatairesAlerte(b, 'setter'), { type: 'deplacer', leadId: b.leadId, leadName: leadName,
        texte: '📅 ' + leadName + ' veut déplacer son RDV du ' + v.date + ' à ' + v.heure + ' : « ' + trace.texte + ' »' + (envoye ? ' — prévenu qu\'on le rappelle aujourd\'hui : à replanifier.' : ' — à replanifier.') });
      return { traite: true, sens: sens, lienEnvoye: envoye };
    }
    await alerter(await destinatairesAlerte(b, 'setter'), { type: 'reponse', leadId: b.leadId, leadName: leadName,
      texte: '💬 ' + leadName + ' a répondu au WhatsApp de la veille (RDV ' + v.date + ' à ' + v.heure + ') : « ' + trace.texte + ' » — à lire, rien n\'a été confirmé.' });
    return { traite: true, sens: sens };
  } catch (e) {
    console.warn('[parcours-rdv] réponse WhatsApp', e && e.message);
    return { traite: false, erreur: e && e.message };
  }
}

/* ═══ Présence dans le Meet (rattrapage) ════════════════════════════════ */

/* 'present' | 'absent' | 'inconnu'. Inconnu = on n'envoie rien. */
async function presenceProspect(b, cache) {
  try {
    const TP = require('./team-pilotage');
    if (!TP.fetchPresence || !TP.presenceSummary) return 'inconnu';
    if (!cache.R) cache.R = await TP.loadRoster();
    if (!cache.persons) cache.persons = await TP.loadPersons();
    if (!cache.meet) cache.meet = {};
    const pr = await TP.fetchPresence(b, cache.R, cache.persons, cache.meet);
    if (!pr || !pr.ok) return 'inconnu';
    const s = TP.presenceSummary(pr);
    if (!s) return 'inconnu';
    return s.prospectJoined ? 'present' : 'absent';
  } catch (e) {
    console.warn('[parcours-rdv] présence', e && e.message);
    return 'inconnu';
  }
}

/* ═══ Une étape pour un RDV ═════════════════════════════════════════════ */

async function executerEtape(etape, it, ctx) {
  const b = it.data;
  const cfg = ctx.cfg;
  const t = typeDe(b, ctx.typeMap);
  const v = variablesDe(b, t);
  const p = b.prospect || {};
  const ligne = { id: it.id, etape: etape, date: b.date, heure: b.time };
  const leadName = (v.prenom + ' ' + v.nom).trim();

  // Préparer le message et vérifier ses variables AVANT toute réservation.
  let envoi = null;
  let manque = null;
  if (etape === 'confirmation_email') {
    manque = ['prenom', 'expert', 'date', 'heure'].find(function (k) { return !v[k]; }) || (p.email ? null : 'email');
    envoi = function () { return envoyerEmail(p.email, emailConfirmation(v, cfg), cfg); };
  } else if (etape === 'valeur_email') {
    manque = ['prenom', 'expert', 'date', 'heure'].find(function (k) { return !v[k]; }) || (p.email ? null : 'email');
    envoi = function () { return envoyerEmail(p.email, emailValeur(v, cfg), cfg); };
  } else if (etape === 'confirmation_sms' || etape === 'sms_h1' || etape === 'rattrapage') {
    let modele = etape === 'confirmation_sms' ? (cfg.textes.confirmation_sms || TEXTES.confirmation_sms)
      : etape === 'sms_h1' ? (v.lien ? (cfg.textes.h1_sms || TEXTES.h1_sms) : (cfg.textes.h1_sms_sans_lien || TEXTES.h1_sms_sans_lien))
      : (cfg.textes.rattrapage_sms || TEXTES.rattrapage_sms);
    manque = variableVide(modele, v) || (telE164(p.telephone || p.tel) ? null : 'telephone');
    const texte = remplir(modele, v);
    envoi = function () { return envoyerSms(p.telephone || p.tel, texte, (cfg.sms || {}).expediteur || 'adrienemily'); };
  } else if (etape === 'wa_veille') {
    const mod = await lireModeleWhatsapp(cfg, ctx.cache);
    if (!mod.ok) { ligne.resultat = 'modele_inutilisable'; ligne.erreur = mod.erreur; return ligne; }
    const params = cfg.whatsapp.variables.map(function (k) { return v[k]; });
    const iVide = params.findIndex(function (x) { return x == null || String(x).trim() === ''; });
    manque = iVide >= 0 ? cfg.whatsapp.variables[iVide] : (WA.normaliserNumero(p.telephone || p.tel) ? null : 'telephone');
    ligne.params = params;
    envoi = async function () {
      const r = await WA.envoyerModele({ to: p.telephone || p.tel, template: mod.nom, langue: mod.langue || cfg.whatsapp.langue, params: params,
        contexte: { type: 'parcours_rdv_veille', bookingId: it.id, leadId: b.leadId || null } });
      return { ok: r.ok, canal: 'whatsapp', wamid: r.wamid || null, id: r.wamid || null, erreur: r.erreur || null,
        texte: remplir(String(mod.corps || '').replace(/\{\{(\d+)\}\}/g, function (a, n) { return '{{p' + n + '}}'; }),
          (function () { const o = {}; params.forEach(function (x, i) { o['p' + (i + 1)] = x; }); return o; })()) };
    };
  }

  if (manque) {
    ligne.resultat = 'variable_vide';
    ligne.manque = manque;
    if (!ctx.simulation && ctx.estTest(b)) {
      // Une seule alerte par étape et par RDV.
      const r = await reserver(it.ref, etape);
      if (r === 'ok') {
        await noter(it.ref, etape, { ok: false, erreur: 'variable_vide:' + manque });
        await alerter(await destinatairesAlerte(b, 'setter'), { type: 'variable', leadId: b.leadId, leadName: leadName,
          texte: '⚠️ Parcours RDV : ' + (LIBELLES[etape] || etape) + ' NON envoyé à ' + (leadName || 'un prospect') + ' (RDV ' + v.date + ' à ' + v.heure + ') — information manquante : ' + manque + '.' });
      }
    }
    return ligne;
  }

  // Rattrapage : seulement si le Meet dit clairement « absent ».
  if (etape === 'rattrapage') {
    const pres = await presenceProspect(b, ctx.cache);
    ligne.presence = pres;
    if (pres !== 'absent') { ligne.resultat = pres === 'present' ? 'prospect_present' : 'presence_illisible'; return ligne; }
  }

  if (ctx.simulation || !ctx.estTest(b)) { ligne.resultat = 'simule'; return ligne; }

  const res = await reserver(it.ref, etape);
  if (res !== 'ok') { ligne.resultat = res; return ligne; }
  const r = await envoi();
  await noter(it.ref, etape, r);
  ligne.resultat = r.ok ? 'envoye' : 'echec';
  if (!r.ok) ligne.erreur = r.erreur;
  if (r.ok) await tracerSurLead(b.leadId, etape, r);

  if (etape === 'rattrapage') {
    await alerter(await destinatairesAlerte(b, 'closer'), { type: 'rattrapage', leadId: b.leadId, leadName: leadName,
      texte: '🚨 ' + (leadName || 'Le prospect') + ' n\'est pas dans la visio de ' + v.heure + ' — appelez-le maintenant' + (r.ok ? ' (SMS avec le lien envoyé).' : ' (le SMS n\'a pas pu partir).') });
  }
  return ligne;
}

/* ═══ Passage du cron ═══════════════════════════════════════════════════ */

async function passage(opts) {
  opts = opts || {};
  const cfg = await lireConfig();
  const simulation = !!opts.simulation || cfg.actif !== true;
  const now = Date.now();
  const st = Dispo.parisStamp(new Date(now));
  const auj = st.ymd;
  const demain = Dispo.addDays(auj, 1);
  const sortie = { ok: true, simulation: simulation, actif: cfg.actif === true, modeTest: cfg.modeTest !== false,
    parisLe: auj, parisA: Dispo.minToTime(st.min), rdv: 0, detail: [], ac: [] };

  const typeMap = await lireTypes();
  const T = await destinatairesTest(cfg);
  sortie.membresTest = T.membres;
  const ctx = {
    cfg: cfg, typeMap: typeMap, simulation: simulation, cache: {},
    // Hors mode test, tout RDV du parcours est réel.
    estTest: function (b) { return cfg.modeTest === false ? true : estRdvDeTest(b, T); },
  };

  // RDV d'hier (issue → ActiveCampaign), d'aujourd'hui et des 3 jours suivants.
  const jours = [Dispo.addDays(auj, -1), auj, demain, Dispo.addDays(auj, 2), Dispo.addDays(auj, 3)];
  const snap = await db.collection('bookings').where('date', '>=', jours[0]).where('date', '<=', jours[jours.length - 1]).get();
  const items = [];
  snap.forEach(function (d) { items.push({ id: d.id, ref: d.ref, data: Object.assign({ _id: d.id }, d.data() || {}) }); });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const b = it.data;
    const t = typeDe(b, typeMap);

    // ── ActiveCampaign : suite du nurturing une fois l'issue connue ──
    // (un RDV annulé sort du parcours mais libère quand même le nurturing)
    const etapesAc = ((b.parcoursRdv || {}).etapes) || {};
    if (etapesAc.ac_rdv_pris && etapesAc.ac_rdv_pris.ok) {
      const suite = suiteNurturing(b);
      if (suite && !etapesAc['ac_' + suite]) {
        const lAc = { id: it.id, etape: 'ac_' + suite };
        if (simulation || !ctx.estTest(b)) lAc.resultat = 'simule';
        else if ((await reserver(it.ref, 'ac_' + suite, { memeAnnule: true })) === 'ok') {
          const r = await versActiveCampaign(cfg, suite, b, { outcome: b.outcome || null });
          await noter(it.ref, 'ac_' + suite, r);
          lAc.resultat = r.ok ? 'envoye' : 'echec';
        }
        sortie.ac.push(lAc);
      }
    }

    const motif = horsParcours(b, typeMap, cfg);
    if (motif) continue;
    sortie.rdv++;
    const debut = MT.bookingStartMs(b);
    if (!debut || now > debut + 60 * 60000) continue;

    // ── ActiveCampaign : RDV pris → nurturing en pause ──
    if (!etapesAc.ac_rdv_pris && now < debut) {
      const lAc = { id: it.id, etape: 'ac_rdv_pris' };
      if (simulation || !ctx.estTest(b)) lAc.resultat = 'simule';
      else if ((await reserver(it.ref, 'ac_rdv_pris')) === 'ok') {
        const r = await versActiveCampaign(cfg, 'rdv_pris', b, { dateRdv: b.date, heureRdv: b.time });
        await noter(it.ref, 'ac_rdv_pris', r);
        lAc.resultat = r.ok ? 'envoye' : 'echec';
      }
      sortie.ac.push(lAc);
    }

    // ── Repli : un SMS « adrienemily » non livré repart une fois du 09 ──
    if (!simulation && ctx.estTest(b)) {
      const ets = ((b.parcoursRdv || {}).etapes) || {};
      const smsEtapes = ['confirmation_sms', 'sms_h1', 'rattrapage'];
      for (let k = 0; k < smsEtapes.length; k++) {
        const e = ets[smsEtapes[k]];
        if (!e || !e.ok || e.expediteur !== 'adrienemily' || !e.id || !e.texteSms || ets[smsEtapes[k] + '_repli']) continue;
        if (now - (e.at || 0) < 3 * 60000 || now - (e.at || 0) > 3 * 3600000) continue;
        const st = await statutSmsAlpha(e.id);
        if (st !== 'undelivered' && st !== 'failed') continue;
        if ((await reserver(it.ref, smsEtapes[k] + '_repli')) !== 'ok') continue;
        const r2 = await envoyerSms((b.prospect || {}).telephone || (b.prospect || {}).tel, e.texteSms, 'numero');
        await noter(it.ref, smsEtapes[k] + '_repli', Object.assign({ motif: 'non_livre_' + st }, r2));
        sortie.detail.push({ id: it.id, etape: smsEtapes[k] + '_repli', resultat: r2.ok ? 'envoye' : 'echec', motif: st });
      }
    }

    const dues = etapesDues({
      cfg: cfg, now: now, debut: debut, cree: msDe(b.createdAt), nowMin: st.min,
      faites: ((b.parcoursRdv || {}).etapes) || {}, outcome: b.outcome || null,
      estDemain: b.date === demain, presenceConfirmee: !!b.presenceConfirmed,
    });
    for (let k = 0; k < dues.length; k++) {
      // ① ② ③ n'ont plus de sens une fois l'heure du H-1 venue.
      sortie.detail.push(await executerEtape(dues[k], it, ctx));
    }
    void t;
  }
  if (ctx.cache.modele) sortie.modeleWhatsapp = ctx.cache.modele;
  return sortie;
}

/* ═══ Aperçu et test (déclenchés par un admin) ══════════════════════════ */

/* Construit un RDV fictif (ou lit un vrai RDV) et envoie un message choisi
   AU MEMBRE DE TEST UNIQUEMENT. Ne touche à aucun RDV. */
async function envoyerTest(o) {
  const cfg = await lireConfig();
  const membres = await lireMembres();
  const m = membres.find(function (x) { return x && x.slug === o.membre; });
  if (!m) return { ok: false, erreur: 'membre_introuvable' };
  let tel = null, email = null;
  Object.keys(m).forEach(function (k) {
    if (!tel && /phone|tel|mobile|whatsapp/i.test(k) && fin9(m[k])) tel = m[k];
    if (!email && /mail/i.test(k) && /@/.test(String(m[k] || ''))) email = m[k];
  });
  if (o.email) email = o.email;
  if (!tel || !email) {
    const r = await db.collection('_config').doc('relances').get();
    const d = r.exists ? (r.data() || {}) : {};
    if (!tel) tel = d.testTelephone || null;
    if (!email) email = d.testEmail || null;
  }
  const demain = Dispo.addDays(Dispo.parisStamp(new Date()).ymd, 1);
  const b = {
    date: demain, time: '14:30', personName: o.expert || 'Claire Martin', typeLabel: 'Audit Stratégique Personnalisé',
    displayDuration: 45, meetLink: 'https://meet.google.com/abc-defg-hij',
    prospect: { prenom: String(m.shortName || m.fullName || 'Adrien').split(' ')[0], nom: 'Test', telephone: tel, email: email },
  };
  const v = variablesDe(b, null);
  const quoi = o.quoi;
  let r;
  if (quoi === 'confirmation_email') r = await envoyerEmail(email, emailConfirmation(v, cfg), cfg);
  else if (quoi === 'valeur_email') r = await envoyerEmail(email, emailValeur(v, cfg), cfg);
  else if (quoi === 'confirmation_sms') r = await envoyerSms(tel, remplir(cfg.textes.confirmation_sms || TEXTES.confirmation_sms, v), (cfg.sms || {}).expediteur);
  else if (quoi === 'sms_h1') r = await envoyerSms(tel, remplir(cfg.textes.h1_sms || TEXTES.h1_sms, v), (cfg.sms || {}).expediteur);
  else if (quoi === 'rattrapage') r = await envoyerSms(tel, remplir(cfg.textes.rattrapage_sms || TEXTES.rattrapage_sms, v), (cfg.sms || {}).expediteur);
  else if (quoi === 'wa_veille') {
    const mod = await lireModeleWhatsapp(cfg, {});
    if (!mod.ok) return { ok: false, erreur: mod.erreur, modele: mod };
    const params = cfg.whatsapp.variables.map(function (k) { return v[k]; });
    const w = await WA.envoyerModele({ to: tel, template: mod.nom, langue: mod.langue || cfg.whatsapp.langue, params: params, contexte: { type: 'parcours_rdv_test' } });
    r = { ok: w.ok, canal: 'whatsapp', id: w.wamid, erreur: w.erreur, params: params, modele: mod };
  } else return { ok: false, erreur: 'etape_inconnue' };
  return Object.assign({ destinataire: quoi.indexOf('email') >= 0 ? 'e-mail du membre ' + o.membre : 'téléphone du membre ' + o.membre }, r);
}

function apercuEmails() {
  const cfg = DEFAUTS;
  const v = variablesDe({ date: Dispo.addDays(Dispo.parisStamp(new Date()).ymd, 2), time: '14:30', personName: 'Claire Martin',
    typeLabel: 'Audit Stratégique Personnalisé', displayDuration: 45, meetLink: 'https://meet.google.com/abc-defg-hij',
    prospect: { prenom: 'Sylvie', nom: 'Exemple' } }, null);
  return { confirmation: emailConfirmation(v, cfg), valeur: emailValeur(v, cfg) };
}

module.exports = {
  versActiveCampaign: versActiveCampaign, reserver: reserver, noter: noter, lireTypes: lireTypes, typeDe: typeDe,
  estCommercial: estCommercial, destinatairesTest: destinatairesTest, alerter: alerter,
  DEFAUTS: DEFAUTS, TEXTES: TEXTES,
  lireConfig: lireConfig, passage: passage, envoyerTest: envoyerTest, apercuEmails: apercuEmails,
  surReponseWhatsapp: surReponseWhatsapp, lireModeleWhatsapp: lireModeleWhatsapp,
  // Exposés pour les tests
  etapesDues: etapesDues, lireReponse: lireReponse, suiteNurturing: suiteNurturing, horsParcours: horsParcours,
  variablesDe: variablesDe, remplir: remplir, variableVide: variableVide, heureLisible: heureLisible, dateLisible: dateLisible,
  telE164: telE164, estRdvDeTest: estRdvDeTest, emailConfirmation: emailConfirmation, emailValeur: emailValeur,
};
