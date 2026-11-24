// ============================================================================
// api/_parcoursSuite.js — SÉQUENCES D'APRÈS-RDV ENVOYÉES PAR TEAM (24/11/2026)
// ----------------------------------------------------------------------------
// Décision d'Adrien du 24/11/2026 : après le RDV, c'est Team qui écrit au
// prospect, plus ActiveCampaign (les 7 automatisations 43-49 restent ÉTEINTES).
// ActiveCampaign ne garde que le nurturing d'avant RDV, la newsletter et des
// étiquettes d'information.
//
// Une SUITE = la séquence d'un prospect après UN rendez-vous :
//   - après un « non » (non_close) : 5 e-mails sur 21 jours, selon son FREIN
//     (choisi par api/parcours-frein.js) et, quand elle est connue, sa DOULEUR
//     (sa réponse à « Qu'est-ce qui vous pèse le plus ? » du questionnaire) ;
//   - après un RDV manqué ou annulé sans report : 3 e-mails sur 7 jours.
//
// Avec une douleur : e-mail 1 = frein + paragraphe miroir ; e-mail 2 = premier
// chapitre de sa douleur, deux boutons « la suite » ; e-mail 3 = la suite
// choisie (sans clic : A) ; e-mail 4 = le client qui lui ressemble ;
// e-mail 5 = frein. Sans douleur : la séquence du frein telle quelle.
//
// Textes : docs/parcours-rdv/sequences-freins.md → _acSequencesData.json ;
//          docs/parcours-rdv/sequences-choix.md  → _parcoursChoixData.json
//          (scripts/build-parcours-choix.py). Aucun texte écrit par une IA
//          au moment de l'envoi : les phrases « miroir » reprennent des
//          réponses À CHOIX du prospect, par des règles fixes (MIROIRS).
//
// Un prospect n'est jamais dans deux cases : avant CHAQUE e-mail, la suite
// s'arrête s'il a repris un RDV, s'il est devenu client, s'il s'est
// désinscrit, s'il a répondu « non / plus tard », ou si l'issue du RDV a
// changé. À la fin, il rejoint la newsletter ActiveCampaign (sauf
// désinscription).
//
// Données : parcours_suites/{bookingId} (Admin SDK seul, aucune règle).
// Réglages : _config/parcours_rdv.suites { actif (faux par défaut),
//   plafondJour, newsletterAutomation } ; le mode test est celui du parcours.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const Dispo = require('../dispo-core.js');
const Lqs = require('../lqs-core.js');
const P = require('./_parcoursRdv');
const AC_DATA = require('./_acSequencesData.json');
const CHOIX_TOUT = require('./_parcoursChoixData.json');
const CHOIX = CHOIX_TOUT.douleurs;
const CHOIX_FREINS = CHOIX_TOUT.freins;

const FV = admin.firestore.FieldValue;
const BASE_URL = 'https://team.alteore.com';
const COL = 'parcours_suites';

const DEFAUTS = { actif: false, plafondJour: 80, newsletterAutomation: '29', heureDebut: 9 * 60 + 30, heureFin: 19 * 60 };

/* Jours après le RDV, par type de séquence. */
const JOURS = { frein: [1, 4, 8, 14, 21], general: [1, 5, 12, 21], rdv_manque: [1, 3, 7], histoire: [1, 4, 8, 12, 16, 21] };
/* Avec une histoire : e-mail 1 = frein, e-mails 2 à 5 = quatre CHAPITRES (le
   premier est toujours C1, les suivants sont choisis par le prospect parmi
   trois boutons, ou pris dans cet ordre faute de clic), e-mail 6 = frein. */
const ORDRE_CHAPITRES = ['C2', 'C3', 'C5', 'C6', 'C4', 'C7'];
const PREMIER_CHAPITRE = 2, DERNIER_CHAPITRE = 5, NB_BOUTONS = 3;
const ECART_MIN_MS = 40 * 3600000; // jamais deux e-mails à moins de 40 h

const LIB_SEQ = {
  frein_tresorerie: 'trésorerie', frein_timing: 'pas le bon moment', frein_decision: 'doit en parler',
  frein_preuves: 'besoin de preuves', frein_priorite: 'pas prioritaire', frein_general: 'général', rdv_manque: 'rendez-vous manqué',
};
const LIB_DOULEUR = { rentabilite: 'rentabilité', operationnel: 'opérationnel', vie: 'vie avalée', equipe: 'équipe', plafond: 'plafond' };

/* ═══ Douleur et phrases miroir (règles fixes, jamais d'IA) ═════════════ */

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

/* Question → douleur. La citation renvoyée est SA réponse, telle quelle. */
const DOULEURS = [
  { q: /^qu'est-ce qui vous pese le plus dans votre entreprise/, r: [
    [/^je fais du chiffre, mais il ne me reste presque rien/, 'rentabilite'], [/^je suis noye dans l'operationnel/, 'operationnel'],
    [/^mon entreprise a avale ma vie/, 'vie'], [/^mes salaries viennent me voir pour tout/, 'equipe'],
    [/^mon chiffre d'affaires plafonne/, 'plafond']] },
];
/* L'ancien formulaire (« Quel est votre principal défi ? ») n'ouvre PAS
   d'histoire : les e-mails citent la question et les mots du nouveau
   questionnaire. Ces prospects reçoivent la séquence simple de leur frein. */

const ECHELLE_HAUTE = /^[45]\s*\/\s*5/;
const MIROIRS = [
  { cle: 'm_marge', q: /quelle marge vous gagnez sur chacune/, r: [[/^non$/, 'Vous nous avez dit ne pas connaître précisément la marge de chacune de vos offres.']] },
  { cle: 'm_sommeil', q: /mal dormir en pensant a la tresorerie/, r: [[ECHELLE_HAUTE, 'Vous nous avez aussi dit qu\'il vous arrive de mal dormir en pensant à la trésorerie des semaines à venir.']] },
  { cle: 'm_2semaines', q: /2 semaines sans telephone/, r: [[/^non$/, 'Vous nous avez dit que votre entreprise ne tournerait pas deux semaines sans vous.']] },
  { cle: 'm_autonome', q: /nouveau salarie peut-il devenir autonome/, r: [[/^non$/, 'Vous nous avez dit qu\'un nouveau salarié ne devient pas autonome sans que vous le formiez vous-même.']] },
  { cle: 'm_consignes', q: /repeter les memes consignes/, r: [[ECHELLE_HAUTE, 'Vous nous avez dit avoir l\'impression de répéter les mêmes consignes, encore et encore.']] },
  { cle: 'm_charge', q: /c'est moi qui absorbe la charge/, r: [[ECHELLE_HAUTE, 'Vous nous avez dit que, chaque fois que l\'activité augmente, c\'est vous qui absorbez la charge en plus.']] },
  { cle: 'm_levier', q: /quel levier actionner/, r: [[/^non$/, 'Vous nous avez dit ne pas savoir exactement quel levier actionner pour augmenter votre chiffre d\'affaires.']] },
  { cle: 'm_heures', q: /^heures travaillees/, r: [
    [/^entre 50 et 60/, 'Vous travaillez entre 50 et 60 heures par semaine.'], [/^plus de 60/, 'Vous travaillez plus de 60 heures par semaine.']] },
  { cle: 'm_rythme', q: /comment vivez-vous ce rythme/, r: [
    [/^je suis a bout/, 'Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « Je suis à bout. »'],
    [/^c'est tendu, mais je tiens/, 'Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « C\'est tendu, mais je tiens. »']] },
  { cle: 'm_duree', q: /^depuis combien de temps (etes-vous noye|manquez-vous de tresorerie|tout remonte-t-il|votre entreprise deborde)/, r: [
    [/^plus de 3 ans/, 'Cela dure depuis plus de trois ans.'], [/^entre 1 et 3 ans/, 'Cela dure depuis plus d\'un an.'], [/^entre 6 mois et 1 an/, 'Cela dure depuis plusieurs mois.']] },
  { cle: 'm_tente', q: /^qu'avez-vous deja tente/, multi: true, r: [
    [/^deleguer/, 'Vous avez déjà essayé de déléguer, avant de tout reprendre vous-même.'],
    [/^embaucher quelqu'un/, 'Vous avez déjà essayé d\'embaucher quelqu\'un pour vous soulager.'],
    [/^bloquer du temps/, 'Vous avez déjà essayé de bloquer du temps dans votre agenda, et il a fini par sauter.'],
    [/^commencer plus tot/, 'Vous avez déjà essayé de commencer plus tôt et de finir plus tard pour « vous avancer ».'],
    [/^recruter un responsable/, 'Vous avez déjà recruté un responsable ou un bras droit.'],
    [/^ecrire des procedures/, 'Vous avez déjà écrit des procédures ou des fiches de poste.'],
    [/^faire des reunions/, 'Vous avez déjà mis en place des réunions d\'équipe régulières.'],
    [/^augmenter mes prix/, 'Vous avez déjà essayé d\'augmenter vos prix.'],
    [/^reduire mes charges/, 'Vous avez déjà essayé de réduire vos charges.'],
    [/^faire plus de volume/, 'Vous avez déjà essayé de faire plus de volume.'],
    [/^en parler avec mon expert-comptable/, 'Vous en avez déjà parlé avec votre expert-comptable.'],
    [/^de nouveaux outils/, 'Vous avez déjà essayé de nouveaux outils.']] },
  { cle: 'm_temps', q: /que feriez-vous en premier/, r: [
    [/^souffler/, 'Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : souffler, tout simplement.'],
    [/^partir en vacances/, 'Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : partir en vacances avec vos proches, téléphone éteint.'],
    [/^prendre de la hauteur/, 'Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : prendre de la hauteur pour préparer la suite.'],
    [/^avancer enfin/, 'Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : avancer enfin sur le projet que vous repoussez depuis des mois.']] },
  { cle: 'm_12mois', q: /dans 12 mois, quel resultat/, r: [
    [/^une rentabilite solide/, 'Dans douze mois, ce qui changerait tout pour vous : une rentabilité solide, et enfin vous payer correctement.'],
    [/^une entreprise qui tourne sans moi/, 'Dans douze mois, ce qui changerait tout pour vous : une entreprise qui tourne sans vous au quotidien.'],
    [/^travailler moins/, 'Dans douze mois, ce qui changerait tout pour vous : travailler moins sans perdre de chiffre d\'affaires.'],
    [/^une equipe autonome/, 'Dans douze mois, ce qui changerait tout pour vous : une équipe autonome, qui décide sans tout vous remonter.']] },
];

/* Lit le questionnaire d'une fiche : { douleur, citation, miroirs }. */
function profilDe(lead) {
  // Réponses du QUESTIONNAIRE seulement (jamais un formulaire libre).
  const rep = Lqs.extractAnswers(lead || {}).filter(function (a) { return a && a.o === 'quiz'; });
  const out = { douleur: null, citation: null, miroirs: {} };
  for (let d = 0; d < DOULEURS.length && !out.douleur; d++) {
    for (let i = 0; i < rep.length && !out.douleur; i++) {
      if (!DOULEURS[d].q.test(norm(rep[i].ql))) continue;
      const a = norm(rep[i].al);
      for (let k = 0; k < DOULEURS[d].r.length; k++) {
        if (DOULEURS[d].r[k][0].test(a)) {
          out.douleur = DOULEURS[d].r[k][1];
          out.citation = String(rep[i].al).replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
          break;
        }
      }
    }
  }
  MIROIRS.forEach(function (m) {
    for (let i = 0; i < rep.length; i++) {
      if (!m.q.test(norm(rep[i].ql))) continue;
      const options = m.multi ? String(rep[i].al).split(/ \| |, (?=[A-ZÉÈÀ])/) : [rep[i].al];
      // Choix multiple : la première phrase de NOTRE liste qui correspond.
      for (let k = 0; k < m.r.length && !out.miroirs[m.cle]; k++) {
        for (let o = 0; o < options.length; o++) {
          if (m.r[k][0].test(norm(options[o]))) { out.miroirs[m.cle] = m.r[k][1]; break; }
        }
      }
      if (out.miroirs[m.cle]) break;
    }
  });
  return out;
}

/* ═══ Réglages, liens ═══════════════════════════════════════════════════ */

async function lireConfig() {
  const cfg = await P.lireConfig();
  const s = Object.assign({}, DEFAUTS, cfg.suites || {});
  return { cfg: cfg, suites: s };
}

function lien(jeton, action, etape, douleurDemo) {
  return BASE_URL + '/api/parcours-clic?j=' + encodeURIComponent(jeton) + '&a=' + action + (etape ? '&e=' + etape : '') + (douleurDemo ? '&d=' + douleurDemo : '');
}
function lienRdvDirect(sequence) {
  return BASE_URL + '/booking.html?type=call_strat_phenix_all&utm_source=team&utm_medium=email&utm_campaign=' + encodeURIComponent(sequence);
}

/* ═══ Contenu d'une étape ═══════════════════════════════════════════════ */

function typeDe(sequence) { return sequence === 'rdv_manque' ? 'rdv_manque' : 'frein'; }

/* Nombre d'étapes et jours : avec une histoire, toujours 6 ; sinon la
   séquence telle qu'écrite (« général » n'a que 4 e-mails). */
function planDe(suite) {
  if (suite.sequence === 'rdv_manque') return JOURS.rdv_manque;
  if (suite.douleur) return JOURS.histoire;
  return suite.sequence === 'frein_general' ? JOURS.general : JOURS.frein;
}

function acMessage(tag, n) {
  for (let i = 0; i < AC_DATA.length; i++) if (AC_DATA[i].tag === tag && AC_DATA[i].n === n) return AC_DATA[i];
  return null;
}
function dernierN(tag) {
  let m = 0;
  AC_DATA.forEach(function (x) { if (x.tag === tag && x.n > m) m = x.n; });
  return m;
}

/* ── Chapitres d'une histoire ─────────────────────────────────────────── */

function chapitresDe(suite) { return suite.douleur && CHOIX[suite.douleur] ? CHOIX[suite.douleur].chapitres : null; }
function chapitreActif(suite, c, off) { const C = chapitresDe(suite); return !!(C && C[c]) && !(off && off['email:' + suite.douleur + '#' + c]); }

/* Les boutons affichés à la fin de l'étape k : trois chapitres pas encore
   lus (ni celui de l'étape k). Aucun au dernier chapitre. `lus` : chapitres
   des étapes 2…k. */
function optionsApres(suite, k, lus, off) {
  if (k >= DERNIER_CHAPITRE) return [];
  return ORDRE_CHAPITRES.filter(function (c) { return lus.indexOf(c) < 0 && chapitreActif(suite, c, off); }).slice(0, NB_BOUTONS);
}

/* Le chapitre de l'étape k (2…5) : { c, choisi, options } — options = les
   boutons qu'il affichera. Une étape déjà envoyée garde ce qui est parti.
   Sinon : le chapitre que le prospect a choisi dans l'e-mail précédent
   (`choixSuivant`), à défaut le premier des boutons qu'on lui proposait. */
function chapitreDe(suite, k, off) {
  if (!chapitresDe(suite) || k < PREMIER_CHAPITRE || k > DERNIER_CHAPITRE) return null;
  const et = suite.etapes || {};
  const lus = [];
  let dernier = null;
  for (let i = PREMIER_CHAPITRE; i <= k; i++) {
    const e = et['e' + i];
    let x;
    if (e && e.chapitre) x = { c: e.chapitre, choisi: e.choisi === true, options: Array.isArray(e.options) ? e.options : null };
    else if (i === PREMIER_CHAPITRE) x = { c: 'C1', choisi: false, options: null };
    else if (suite.forceChapitre && i === k) x = { c: suite.forceChapitre, choisi: suite.forceChoisi === true, options: null };
    else {
      const proposes = (dernier && dernier.options) || [];
      const voulu = suite.choixSuivant && suite.choixSuivant.e === i - 1 ? suite.choixSuivant.c : null;
      if (voulu && lus.indexOf(voulu) < 0 && chapitreActif(suite, voulu, off)) x = { c: voulu, choisi: true, options: null };
      else {
        const suivant = proposes.filter(function (c) { return lus.indexOf(c) < 0 && chapitreActif(suite, c, off); })[0]
          || ORDRE_CHAPITRES.filter(function (c) { return lus.indexOf(c) < 0 && chapitreActif(suite, c, off); })[0];
        if (!suivant) return null;
        x = { c: suivant, choisi: false, options: null };
      }
    }
    lus.push(x.c);
    if (!x.options) x.options = optionsApres(suite, i, lus, off);
    dernier = x;
  }
  return dernier;
}

function libelleChapitre(suite, c) { const C = chapitresDe(suite); return C && C[c] ? C[c].bouton : null; }

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* { subject, html, text, cle } de l'étape k (1…n), ou null. */
function contenuDe(suite, k, off) {
  const plan = planDe(suite);
  if (k < 1 || k > plan.length) return null;
  const prenom = String(suite.prenom || '').trim();
  let src = null, cle = '';
  const D = suite.douleur ? CHOIX[suite.douleur] : null;
  let chap = null;
  if (suite.sequence === 'rdv_manque') { src = acMessage('rdv_manque', k); cle = 'rdv_manque#' + k; }
  else if (D && k >= PREMIER_CHAPITRE && k <= DERNIER_CHAPITRE) {
    chap = chapitreDe(suite, k, off);
    if (!chap) return { erreur: 'plus_de_chapitre', cle: suite.douleur + '#?' };
    src = D.chapitres[chap.c]; cle = suite.douleur + '#' + chap.c;
  } else {
    // E-mail du frein. Avec une histoire, les e-mails 1 et 5 sont ceux
    // écrits POUR ce cas (ils n'annoncent pas les e-mails du frein, qui ne
    // partiront pas) : FREINS_HISTOIRE de _parcoursChoixData.json.
    const H = D && CHOIX_FREINS[suite.sequence];
    if (H && (k === 1 || k === plan.length)) { src = H[k === 1 ? 'E1' : 'E5']; cle = suite.sequence + '#H' + (k === 1 ? 1 : 5); }
    else { src = acMessage(suite.sequence, k); cle = suite.sequence + '#' + k; }
  }
  if (!src) return null;
  let html = String(src.html), text = String(src.text);

  // Phrases miroir : remplies, ou retirées avec leur bloc.
  const mir = suite.miroirs || {};
  html = html.replace(/<!--M:(m_[a-z0-9_]+)-->([\s\S]*?)<!--\/M-->/g, function (tout, c, bloc) {
    return mir[c] ? bloc.replace('{{' + c + '}}', esc(mir[c])) : '';
  });
  text = text.split('\n\n').map(function (b) {
    const m = /^\{\{(m_[a-z0-9_]+)\}\}$/.exec(b.trim());
    return m ? (mir[m[1]] || null) : b;
  }).filter(function (b) { return b !== null; }).join('\n\n');

  const stop = lien(suite.jeton, 'stop');
  const rdv = lien(suite.jeton, 'rdv', k);
  const dm = /^0+$/.test(String(suite.jeton)) ? suite.douleur : null; // e-mail de test

  // Chapitre d'une histoire : la phrase d'ouverture et les boutons de la suite.
  if (chap) {
    const ouv = chap.choisi ? 'Vous avez choisi de lire : « ' + D.chapitres[chap.c].bouton + ' ». Le voici.' : 'Voici la suite de votre histoire.';
    let bh = '', bt = '';
    if (chap.options.length) {
      bh = '<p style="margin:26px 0 12px;font-size:17px;font-weight:700;color:#111827">Que voulez-vous lire ensuite ?</p>';
      bt = 'QUE VOULEZ-VOUS LIRE ENSUITE ?';
      chap.options.forEach(function (c, i) {
        const u = lien(suite.jeton, 'c', k, dm) + '&c=' + c;
        const st = i === 0 ? 'background:#2563eb;color:#ffffff;border:2px solid #2563eb' : 'background:#ffffff;color:#2563eb;border:2px solid #2563eb';
        bh += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px"><tr><td><a href="' + esc(u) + '" style="display:block;' + st + ';border-radius:12px;padding:14px 18px;font-size:16px;font-weight:700;text-decoration:none;text-align:center">' + esc(D.chapitres[c].bouton) + ' →</a></td></tr></table>';
        bt += '\n→ ' + D.chapitres[c].bouton + ' : ' + u;
      });
      const defaut = D.chapitres[chap.options[0]].bouton;
      bh += '<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:#6b7280">Sans clic de votre part, vous recevrez « ' + esc(defaut) + ' ».</p>';
      bt += '\nSans clic de votre part, vous recevrez « ' + defaut + ' ».';
    } else {
      bh = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 6px"><tr><td style="background:#2563eb;border-radius:10px"><a href="' + esc(rdv) + '" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">Réserver mon audit</a></td></tr></table>';
      bt = 'Réserver mon audit : ' + rdv;
    }
    html = html.split('{{ouverture}}').join(esc(ouv)).split('{{choix_html}}').join(bh);
    text = text.split('{{ouverture}}').join(ouv).split('{{choix_texte}}').join(bt);
  }
  function partout(s, enHtml) {
    s = s.split('{{douleur_citation}}').join(enHtml ? esc(suite.citation || '') : (suite.citation || ''));
    s = s.split('{{lien_rdv}}').join(rdv);
    s = s.split('{{lien_desinscription}}').join(stop).split('%UNSUBSCRIBELINK%').join(stop);
    // Liens de réservation écrits pour ActiveCampaign → lien suivi par Team.
    s = s.replace(/https:\/\/team\.alteore\.com\/booking\.html\?type=call_strat_phenix_all[^"'\s<]*/g, rdv);
    if (prenom) s = s.split('%FIRSTNAME%').join(enHtml ? esc(prenom) : prenom);
    else s = s.split('Bonjour %FIRSTNAME%,').join('Bonjour,').split('%FIRSTNAME%').join('');
    return s;
  }
  html = partout(html, true); text = partout(text, false);
  if (/\{\{|%[A-Z_]+%/.test(html) || /\{\{|%[A-Z_]+%/.test(text)) return { erreur: 'variable_non_remplie', cle: cle };
  return { subject: src.subject, html: html, text: text, cle: cle, chapitre: chap ? chap.c : null, choisi: chap ? chap.choisi : null, options: chap ? chap.options : null };
}

/* ═══ Création d'une suite ══════════════════════════════════════════════ */

function jetonNeuf() { return crypto.randomBytes(18).toString('hex'); }

/* Idempotent : une suite par RDV. `o` : { bookingId, booking, sequence }. */
async function creer(o) {
  const b = o.booking || {};
  const p = b.prospect || {};
  const email = String(p.email || '').trim().toLowerCase();
  if (!email || !/@/.test(email)) return { ok: false, erreur: 'email_absent' };
  if (!LIB_SEQ[o.sequence]) return { ok: false, erreur: 'sequence_inconnue' };
  const ref = db.collection(COL).doc(String(o.bookingId));
  const C0 = await lireConfig();
  // Moteur éteint : aucune suite n'est créée (rien ne s'accumule pour partir
  // d'un coup, en retard, le jour où on l'allume).
  if (C0.suites.actif !== true) return { ok: false, erreur: 'suites_eteintes' };
  const off = C0.suites.off || {};
  if (off['seq:' + o.sequence]) return { ok: false, erreur: 'sequence_desactivee' };
  let profil = { douleur: null, citation: null, miroirs: {} };
  let lead = null;
  if (b.leadId) {
    const ls = await db.collection('leads').doc(String(b.leadId)).get();
    lead = ls.exists ? (ls.data() || {}) : null;
    if (lead && o.sequence !== 'rdv_manque') profil = profilDe(lead);
  }
  // Histoire désactivée dans le module admin : séquence simple du frein.
  if (profil.douleur && off['douleur:' + profil.douleur]) { profil.douleur = null; profil.citation = null; }
  const doc = {
    bookingId: String(o.bookingId), leadId: b.leadId || null, email: email,
    prenom: String(p.prenom || '').trim() || String(p.nom || '').trim().split(/\s+/)[0] || '',
    sequence: o.sequence, douleur: profil.douleur, citation: profil.citation, miroirs: profil.miroirs,
    // RDV annulé à l'avance : les jours se comptent depuis l'annulation.
    rdvDate: (o.sequence === 'rdv_manque' && b.date && b.date > parisMin(Date.now()).ymd) ? parisMin(Date.now()).ymd : (b.date || null),
    jeton: jetonNeuf(), etat: 'active', etapes: {}, choixSuivant: null, clics: [],
    creeA: Date.now(), majA: Date.now(),
  };
  const cree = await db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    if (s.exists) {
      // Issue corrigée après coup (manqué ↔ « non ») : l'ancienne suite,
      // arrêtée pour ce motif, laisse la place à la bonne séquence.
      const a = s.data() || {};
      if (!(a.etat === 'arretee' && a.motifArret === 'issue_changee' && a.sequence !== o.sequence)) return false;
      doc.precedente = { sequence: a.sequence, etapes: a.etapes || {}, arreteA: a.arreteA || null, creeA: a.creeA || null };
    }
    tx.set(ref, doc);
    return true;
  });
  if (!cree) return { ok: true, deja: true };
  // Un prospect n'a qu'UNE séquence à la fois : les autres s'arrêtent.
  try {
    const autres = await db.collection(COL).where('email', '==', email).get();
    for (let i = 0; i < autres.docs.length; i++) {
      const x = autres.docs[i];
      if (x.id !== String(o.bookingId) && ['active', 'pause'].indexOf((x.data() || {}).etat) >= 0) await arreter(x.ref, x.data() || {}, 'remplacee');
    }
  } catch (e) { console.warn('[parcours-suite] autres suites', e && e.message); }
  if (b.leadId) {
    await db.collection('leads').doc(String(b.leadId)).update({
      suiteApresRdv: resume(doc),
      timeline_history: FV.arrayUnion({ text: '📬 Séquence après RDV démarrée : ' + LIB_SEQ[o.sequence] + (profil.douleur ? ' · douleur ' + LIB_DOULEUR[profil.douleur] : '') + ' (' + planDe(doc).length + ' e-mails)', date: dateFr(), color: '#a78bfa' }),
    }).catch(function (e) { console.warn('[parcours-suite] lead', e && e.message); });
  }
  // Étiquette d'information dans ActiveCampaign (ne déclenche rien).
  if (profil.douleur) {
    try {
      const AC = require('./_activeCampaign');
      const c = await AC.contact(email);
      if (c.ok) await AC.ajouterTag(c.id, 'douleur_' + profil.douleur, { creer: true });
    } catch (e) { console.warn('[parcours-suite] tag douleur', e && e.message); }
  }
  return { ok: true, cree: true, douleur: profil.douleur, miroirs: Object.keys(profil.miroirs).length };
}

function dateFr() { return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }); }

/* Les chapitres déjà partis, dans l'ordre : [{ c, bouton, choisi }]. */
function parcoursDe(s) {
  const out = [];
  if (!chapitresDe(s)) return out;
  for (let k = PREMIER_CHAPITRE; k <= DERNIER_CHAPITRE; k++) {
    const e = (s.etapes || {})['e' + k];
    if (e && e.ok === true && e.chapitre) out.push({ c: e.chapitre, bouton: libelleChapitre(s, e.chapitre), choisi: e.choisi === true });
  }
  return out;
}

/* Le résumé affiché sur la fiche (leads.suiteApresRdv) : une seule ligne
   d'état, jamais une alerte. */
function resume(s) {
  const plan = planDe(s);
  const faites = Object.keys(s.etapes || {}).filter(function (k) { return s.etapes[k] && s.etapes[k].ok; }).length;
  return {
    bookingId: s.bookingId, sequence: s.sequence, sequenceLibelle: LIB_SEQ[s.sequence] || s.sequence,
    douleur: s.douleur || null, douleurLibelle: s.douleur ? LIB_DOULEUR[s.douleur] : null,
    etat: s.etat, motifArret: s.motifArret || null, envoyes: faites, total: plan.length,
    parcours: parcoursDe(s), choixLibelle: s.choixLibelle || null, dernierClic: s.dernierClic || null, majA: Date.now(),
  };
}

/* ═══ Arrêt ═════════════════════════════════════════════════════════════ */

const LIB_ARRET = {
  rdv_repris: 'a repris un rendez-vous', client: 'est devenu client', desinscription: 's\'est désinscrit',
  reponse_stop: 'a répondu qu\'il ne souhaitait pas donner suite', issue_changee: 'l\'issue du RDV a changé',
  terminee: 'séquence terminée', remplacee: 'remplacée par la séquence d\'un RDV plus récent', trop_tard: 'e-mails trop en retard pour partir', fiche_ecartee: 'fiche disqualifiée ou écartée', rdv_annule_equipe: 'RDV annulé par l\'équipe', arret_admin: 'arrêtée par un admin',
};

async function arreter(ref, s, motif, opts) {
  opts = opts || {};
  const etat = motif === 'terminee' ? 'terminee' : 'arretee';
  const patch = { etat: etat, motifArret: motif, arreteA: Date.now(), majA: Date.now() };
  // Ce qu'il reste à faire dans ActiveCampaign, rejoué tant que ce n'est pas fait.
  if (motif === 'desinscription') { patch.acAFaire = 'desinscription'; patch.acEnAttente = true; patch.acEssais = 0; }
  else if (motif === 'terminee' && opts.newsletter) { patch.acAFaire = 'newsletter'; patch.acNewsletterId = String(opts.newsletter); patch.acEnAttente = true; patch.acEssais = 0; }
  await ref.set(patch, { merge: true });
  const apres = Object.assign({}, s, patch);
  if (s.leadId) {
    await db.collection('leads').doc(String(s.leadId)).update({
      suiteApresRdv: resume(apres),
      timeline_history: FV.arrayUnion({ text: (motif === 'terminee' ? '📭 Séquence après RDV terminée' : '📭 Séquence après RDV arrêtée : ' + (LIB_ARRET[motif] || motif)), date: dateFr(), color: '#a78bfa' }),
    }).catch(function () {});
  }
  if (patch.acEnAttente) await faireAC(ref, apres);
}

/* Désinscription complète ou entrée dans la newsletter, côté ActiveCampaign.
   Idempotent. En cas d'échec, `acEnAttente` reste vrai : le passage suivant
   réessaie (6 fois au plus), puis le module admin l'affiche. */
async function faireAC(ref, s) {
  const essais = (s.acEssais || 0) + 1;
  let ok = false, detail = null;
  try {
    const AC = require('./_activeCampaign');
    const c = await AC.contact(s.email);
    if (!c.ok) detail = c.erreur || 'contact';
    else if (s.acAFaire === 'desinscription') {
      const t = await AC.ajouterTag(c.id, 'stop_autom');
      const d = await AC.desinscrire(c.id);
      ok = !!(t.ok && d.ok); detail = ok ? (d.listes || 0) + ' liste(s)' : ((!t.ok && t.erreur) || d.erreur || 'echec');
    } else if (s.acAFaire === 'newsletter') {
      // L'étiquette « stop_autom », posée par Team pour la durée de la
      // séquence, est retirée : elle ne doit pas le tenir hors de la newsletter.
      const t = await AC.retirerTag(c.id, 'stop_autom');
      const r = await AC.entrerAutomatisation(c.id, s.acNewsletterId);
      ok = !!(t.ok && r.ok); detail = ok ? (r.deja ? 'déjà dedans' : 'entré') : ((!t.ok && t.erreur) || r.erreur || 'echec');
    } else ok = true;
  } catch (e) { detail = (e && e.message) || 'erreur'; }
  await ref.set({ acEnAttente: ok ? false : essais < 6, acEssais: essais, acResultat: { ok: ok, detail: detail, at: Date.now() } }, { merge: true });
  return ok;
}

/* Désinscription d'un prospect, quel que soit l'état de sa suite : la fiche
   D'ABORD (c'est elle qui arrête tout envoi de Team), ActiveCampaign ensuite. */
async function desinscrire(ref, s) {
  const now = Date.now();
  if (s.leadId) await db.collection('leads').doc(String(s.leadId)).update({ emailDesinscrit: true, emailDesinscritA: now }).catch(function (e) { console.warn('[parcours-suite] désinscription fiche', e && e.message); });
  if (s.etat === 'active' || s.etat === 'pause') { await arreter(ref, s, 'desinscription'); return; }
  await ref.set({ desinscritA: now, acAFaire: 'desinscription', acEnAttente: true, acEssais: 0, majA: now }, { merge: true });
  await faireAC(ref, Object.assign({}, s, { acAFaire: 'desinscription', acEssais: 0 }));
}

/* ═══ Passage du cron ═══════════════════════════════════════════════════ */

function parisMin(ms) { return Dispo.parisStamp(new Date(ms)); }

/* Une étape est « réglée » quand l'e-mail est parti, a été sauté, ou a
   échoué 3 fois. Un échec (Gmail en panne) est rejoué au passage suivant.
   Une réservation restée sans suite (plantage entre la réservation et
   l'envoi) n'est PAS rejouée : on ne sait pas si l'e-mail est parti, et un
   doublon est pire qu'un trou ; elle est signalée dans le module admin. */
function reglee(e) {
  if (!e) return false;
  if (e.ok === true || e.saute === true) return true;
  if (e.ok === false) return (e.essais || 1) >= 3;
  return true; // réservée, jamais notée
}
function momentDe(e) { return e ? (e.at || e.reserveA || 0) : 0; }

/* Étape due maintenant (1…n) ou 0. */
function etapeDue(s, now) {
  const plan = planDe(s);
  const et = s.etapes || {};
  let k = 1;
  while (k <= plan.length && reglee(et['e' + k])) k++;
  if (k > plan.length) return { k: 0, fini: true };
  if (s.forcer === true) return { k: k, force: true };
  if (!s.rdvDate) return { k: 0 };
  const st = parisMin(now);
  const jour = Dispo.addDays(s.rdvDate, plan[k - 1]);
  if (st.ymd < jour) return { k: 0 };
  const prec = k > 1 ? et['e' + (k - 1)] : null;
  if (prec && momentDe(prec) && now - momentDe(prec) < ECART_MIN_MS) return { k: 0 };
  // Trop tard pour commencer : un premier e-mail avec 5 jours de retard n'a plus de sens.
  if (k === 1 && !et.e1 && st.ymd > Dispo.addDays(jour, 5)) return { k: 0, tropTard: true };
  return { k: k };
}

async function envoyesAujourdhui(auj) {
  const s = await db.collection('_config').doc('parcours_rdv').get();
  const c = (s.exists ? (s.data() || {}).suitesCompteur : null) || {};
  return c.jour === auj ? (c.n || 0) : 0;
}

async function passage(opts) {
  opts = opts || {};
  const C = await lireConfig();
  const cfg = C.cfg, S = C.suites;
  const simulation = !!opts.simulation || S.actif !== true || cfg.actif !== true;
  const now = Date.now();
  const st = parisMin(now);
  const sortie = { ok: true, simulation: simulation, actif: S.actif === true, modeTest: cfg.modeTest !== false, parisLe: st.ymd, parisA: Dispo.minToTime(st.min), suites: 0, detail: [] };
  const dimanche = new Date(st.ymd + 'T12:00:00Z').getUTCDay() === 0;
  const fenetre = st.min >= S.heureDebut && st.min < S.heureFin && !dimanche;
  sortie.fenetre = fenetre;

  const T = await P.destinatairesTest(cfg);
  const typeMap = await P.lireTypes();
  let compteur = await envoyesAujourdhui(st.ymd);
  // ActiveCampaign : désinscriptions / entrées newsletter restées en échec.
  if (!simulation) {
    try {
      const att = await db.collection(COL).where('acEnAttente', '==', true).get();
      for (let i = 0; i < att.docs.length && i < 20; i++) {
        const a = att.docs[i].data() || {};
        if (a.etat === 'active' || a.etat === 'pause') continue;
        if (Date.now() - ((a.acResultat || {}).at || 0) < 10 * 60000) continue;
        const okAc = await faireAC(att.docs[i].ref, a);
        sortie.detail.push({ id: att.docs[i].id, resultat: 'activecampaign_' + a.acAFaire + (okAc ? '_fait' : '_echec') });
      }
    } catch (e) { console.warn('[parcours-suite] AC en attente', e && e.message); }
  }
  const snap = await db.collection(COL).where('etat', '==', 'active').get();
  for (let i = 0; i < snap.docs.length; i++) {
    if (Date.now() - now > 45000) { sortie.interrompu = 'budget_temps'; break; }
    const d = snap.docs[i];
    const s = d.data() || {};
    sortie.suites++;
    const ligne = { id: d.id, sequence: s.sequence, douleur: s.douleur || null };
    try {
      // Rien à envoyer ni à clore pour l'instant : aucune lecture inutile.
      const due0 = etapeDue(s, now);
      if (!due0.k && !due0.fini && !due0.tropTard) { ligne.resultat = 'pas_encore'; sortie.detail.push(ligne); continue; }
      const bs = await db.collection('bookings').doc(String(s.bookingId)).get();
      const b = bs.exists ? (bs.data() || {}) : null;
      const estTest = cfg.modeTest === false || (b && P.estRdvDeTest(b, T));
      const reel = !simulation && estTest;

      // ── Le prospect a-t-il changé de case ? ──
      let motif = null;
      if (!b) motif = 'issue_changee';
      else if (s.sequence === 'rdv_manque' && !(b.status === 'cancelled' || b.outcome === 'no_show' || b.outcome === 'annule')) motif = 'issue_changee';
      else if (s.sequence !== 'rdv_manque' && b.outcome !== 'non_close') motif = 'issue_changee';
      // Un RDV plus récent (à venir, ou déjà passé avec sa propre issue).
      if (!motif && b && await P.rdvPlusRecent(b, d.id, typeMap)) motif = 'rdv_repris';
      if (!motif && due0.tropTard) motif = 'trop_tard';
      if (!motif && s.leadId) {
        const ls = await db.collection('leads').doc(String(s.leadId)).get();
        const l = ls.exists ? (ls.data() || {}) : {};
        if (l.isClient === true || /^closed_won/.test(String(l.stage || '')) || l.status === 'client') motif = 'client';
        else if (l.emailDesinscrit === true) motif = 'desinscription';
        else if (/^(disqualif|poubelle|faux_numero)/.test(String(l.stage || '')) || l._merged === true) motif = 'fiche_ecartee';
      }
      if (motif) {
        ligne.resultat = 'arret:' + motif;
        if (reel) await arreter(d.ref, s, motif);
        sortie.detail.push(ligne); continue;
      }

      const due = due0;
      if (due.fini) {
        // Dernier e-mail parti depuis 3 jours : fin, retour à la newsletter.
        const plan = planDe(s);
        const dernier = (s.etapes || {})['e' + plan.length];
        if (!dernier || now - momentDe(dernier) > 3 * 86400000) {
          ligne.resultat = 'terminee';
          if (reel) await arreter(d.ref, s, 'terminee', { newsletter: S.newsletterAutomation });
        } else ligne.resultat = 'attente_fin';
        sortie.detail.push(ligne); continue;
      }
      if (!due.k) { ligne.resultat = 'pas_encore'; sortie.detail.push(ligne); continue; }
      ligne.etape = due.k;
      const off = S.off || {};
      if (off['seq:' + s.sequence]) { ligne.resultat = 'sequence_desactivee'; sortie.detail.push(ligne); continue; }
      // « Envoyer maintenant » (module admin) passe outre le calendrier et les horaires.
      if (!fenetre && !due.force) { ligne.resultat = 'hors_horaires'; sortie.detail.push(ligne); continue; }
      const c = contenuDe(s, due.k, off);
      if (!c || c.erreur) {
        ligne.resultat = 'contenu_indisponible'; ligne.erreur = c && c.erreur;
        if (reel && s.probleme !== 'contenu_indisponible') await d.ref.set({ probleme: 'contenu_indisponible', majA: Date.now() }, { merge: true });
        sortie.detail.push(ligne); continue;
      }
      ligne.email = c.cle; ligne.objet = c.subject;
      if (!reel) { ligne.resultat = 'simule'; sortie.detail.push(ligne); continue; }
      // E-mail désactivé dans le module admin : l'étape est sautée, la séquence continue.
      if (off['email:' + c.cle]) {
        const sv = { etapes: {}, majA: Date.now(), forcer: false };
        sv.etapes['e' + due.k] = { at: Date.now(), ok: false, saute: true, email: c.cle, objet: c.subject };
        if (c.chapitre) { sv.etapes['e' + due.k].chapitre = c.chapitre; sv.etapes['e' + due.k].options = c.options || []; }
        await d.ref.set(sv, { merge: true });
        ligne.resultat = 'email_desactive'; sortie.detail.push(ligne); continue;
      }
      if (compteur >= S.plafondJour) { ligne.resultat = 'plafond_du_jour'; sortie.plafondAtteint = true; sortie.detail.push(ligne); continue; }

      // Réservation transactionnelle : un e-mail n'est jamais envoyé deux fois.
      const cleE = 'e' + due.k;
      let essaiN = 1;
      const pris = await db.runTransaction(async function (tx) {
        const x = await tx.get(d.ref);
        const dx = x.data() || {};
        const ex = (dx.etapes || {})[cleE];
        if (dx.etat !== 'active' || reglee(ex)) return false;
        essaiN = ex ? (ex.essais || 1) + 1 : 1;
        // Remplacement complet de l'étape (un ancien échec ne doit pas rester).
        tx.update(d.ref, new admin.firestore.FieldPath('etapes', cleE), { reserveA: Date.now(), essais: essaiN });
        return true;
      });
      if (!pris) { ligne.resultat = 'deja'; sortie.detail.push(ligne); continue; }
      let r;
      try {
        const { sendEmailFromAccount } = require('./_gmailSend');
        const g = await sendEmailFromAccount({ accountKey: cfg.emailCompte || 'strategie', to: s.email, subject: c.subject, bodyHtml: c.html, bodyText: c.text });
        r = (g && g.ok) ? { ok: true, id: g.messageId || null } : { ok: false, erreur: (g && g.error) || 'echec_gmail' };
      } catch (e) { r = { ok: false, erreur: (e && e.message) || 'echec_gmail' }; }
      const note = { etapes: {}, majA: Date.now(), forcer: false };
      note.etapes[cleE] = { at: Date.now(), ok: !!r.ok, id: r.id || null, erreur: r.erreur || null, email: c.cle, objet: c.subject, essais: essaiN };
      // Le chapitre parti, s'il a été choisi, et les boutons qu'il affichait.
      if (c.chapitre) {
        note.etapes[cleE].chapitre = c.chapitre; note.etapes[cleE].choisi = c.choisi === true; note.etapes[cleE].options = c.options || [];
        note.choixSuivant = null; note.choixLibelle = null;
      }
      await d.ref.set(note, { merge: true });
      ligne.resultat = r.ok ? 'envoye' : 'echec';
      if (!r.ok) ligne.erreur = r.erreur;
      if (r.ok) {
        compteur++;
        await db.collection('_config').doc('parcours_rdv').set({ suitesCompteur: { jour: st.ymd, n: compteur } }, { merge: true });
        const apres = Object.assign({}, s); apres.etapes = Object.assign({}, s.etapes || {}); apres.etapes[cleE] = note.etapes[cleE];
        if (s.leadId) {
          const iso = new Date().toISOString();
          await db.collection('leads').doc(String(s.leadId)).update({
            suiteApresRdv: resume(apres),
            communications: FV.arrayUnion({ type: 'email', direction: 'outbound', subject: c.subject, content: c.text.slice(0, 2000),
              source: 'parcours_suite', auto: true, date: iso, createdAt: iso, providerMessageSid: r.id || null, ownerName: 'Séquence après RDV' }),
          }).catch(function (e) { console.warn('[parcours-suite] trace', e && e.message); });
        }
      }
    } catch (e) {
      console.error('[parcours-suite] suite', d.id, e && e.stack ? e.stack : e);
      ligne.resultat = 'erreur'; ligne.erreur = (e && e.message) || 'erreur';
    }
    sortie.detail.push(ligne);
  }
  return sortie;
}

/* ═══ Module admin (api/parcours-suite-admin.js) ════════════════════════ */

/* Jour (AAAA-MM-JJ, Paris) du prochain e-mail, ou null. */
function prochainEnvoi(s, now) {
  if (s.etat !== 'active') return null;
  const plan = planDe(s);
  const et = s.etapes || {};
  let k = 1;
  while (k <= plan.length && reglee(et['e' + k])) k++;
  if (k > plan.length || !s.rdvDate) return null;
  let jour = Dispo.addDays(s.rdvDate, plan[k - 1]);
  const prec = k > 1 ? et['e' + (k - 1)] : null;
  if (prec && momentDe(prec)) { const j2 = parisMin(momentDe(prec) + ECART_MIN_MS).ymd; if (j2 > jour) jour = j2; }
  const auj = parisMin(now).ymd;
  if (jour < auj) jour = auj;
  return { etape: k, jour: jour, maintenant: s.forcer === true };
}

function ligneAdmin(id, s, now) {
  const plan = planDe(s);
  const et = s.etapes || {};
  const envoyes = [];
  for (let k = 1; k <= plan.length; k++) {
    const e = et['e' + k];
    envoyes.push(e ? { k: k, ok: e.ok === true, saute: e.saute === true, at: e.at || e.reserveA || null, objet: e.objet || null,
      erreur: e.erreur || (e.ok == null && !e.saute ? 'envoi interrompu, non rejoué' : null) } : null);
  }
  const clics = (s.clics || []).filter(function (c) { return c && c.a !== 'stop'; });
  return {
    id: id, leadId: s.leadId || null, prenom: s.prenom || '', email: s.email || '',
    sequence: s.sequence, sequenceLibelle: LIB_SEQ[s.sequence] || s.sequence,
    douleur: s.douleur || null, douleurLibelle: s.douleur ? LIB_DOULEUR[s.douleur] : null,
    etat: s.etat, motif: s.motifArret || null, motifLibelle: s.motifArret ? (LIB_ARRET[s.motifArret] || s.motifArret) : null,
    rdvDate: s.rdvDate || null, creeA: s.creeA || null, total: plan.length, etapes: envoyes,
    parcours: parcoursDe(s), choixLibelle: s.choixLibelle || null,
    clics: clics.length, aCliqueReserver: clics.some(function (c) { return c.a === 'rdv'; }),
    reponses: (s.reponses || []).slice(-3), prochain: prochainEnvoi(s, now),
    probleme: s.probleme || (s.acEnAttente === false && s.acResultat && s.acResultat.ok === false ? 'activecampaign_' + s.acAFaire : null)
      || (envoyes.some(function (e) { return e && !e.ok && !e.saute; }) ? 'email_non_parti' : null),
    miroirs: Object.keys(s.miroirs || {}).length,
  };
}

async function listeAdmin() {
  const now = Date.now();
  const snap = await db.collection(COL).orderBy('creeA', 'desc').limit(500).get();
  const out = [];
  snap.forEach(function (d) { out.push(ligneAdmin(d.id, d.data() || {}, now)); });
  return out;
}

function statsDe(liste) {
  const st = { total: liste.length, active: 0, pause: 0, terminee: 0, arretee: 0, envoyes: 0, clics: 0, choix: 0, motifs: {}, sequences: {}, douleurs: {} };
  liste.forEach(function (x) {
    if (st[x.etat] != null) st[x.etat]++;
    x.etapes.forEach(function (e) { if (e && e.ok) st.envoyes++; });
    if (x.clics) st.clics++;
    if (x.choixLibelle || x.parcours.some(function (p) { return p.choisi; })) st.choix++;
    if (x.motif) st.motifs[x.motif] = (st.motifs[x.motif] || 0) + 1;
    if (x.probleme) st.problemes = (st.problemes || 0) + 1;
    st.sequences[x.sequence] = (st.sequences[x.sequence] || 0) + 1;
    st.douleurs[x.douleur || 'aucune'] = (st.douleurs[x.douleur || 'aucune'] || 0) + 1;
  });
  return st;
}

/* L'arbre des e-mails : par frein (séquence simple) et par douleur. */
function arbre(off) {
  off = off || {};
  const sequences = Object.keys(LIB_SEQ).map(function (seq) {
    const n = dernierN(seq), jours = seq === 'rdv_manque' ? JOURS.rdv_manque : (seq === 'frein_general' ? JOURS.general : JOURS.frein);
    const emails = [];
    for (let k = 1; k <= n; k++) { const m = acMessage(seq, k); if (m) emails.push({ k: k, cle: seq + '#' + k, objet: m.subject, jour: jours[k - 1], off: !!off['email:' + seq + '#' + k] }); }
    const H = CHOIX_FREINS[seq];
    const histoire = H ? [{ e: 'E1', cle: seq + '#H1', objet: H.E1.subject, off: !!off['email:' + seq + '#H1'] }, { e: 'E5', cle: seq + '#H5', objet: H.E5.subject, off: !!off['email:' + seq + '#H5'] }] : [];
    return { cle: seq, libelle: LIB_SEQ[seq], off: !!off['seq:' + seq], emails: emails, histoire: histoire };
  });
  const douleurs = Object.keys(CHOIX).map(function (dl) {
    const D = CHOIX[dl];
    return { cle: dl, libelle: LIB_DOULEUR[dl] || dl, citation: D.citation, off: !!off['douleur:' + dl],
      emails: ['C1'].concat(ORDRE_CHAPITRES).map(function (e) { return { e: e, cle: dl + '#' + e, objet: D.chapitres[e].subject, bouton: D.chapitres[e].bouton, off: !!off['email:' + dl + '#' + e] }; }) };
  });
  return { sequences: sequences, douleurs: douleurs, jours: JOURS };
}

/* Action d'un admin sur UNE suite. Tout est tracé dans `historique`. */
async function actionAdmin(id, quoi, valeur, par) {
  const ref = db.collection(COL).doc(String(id || '_'));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, erreur: 'suite_introuvable' };
  const s = snap.data() || {};
  const trace = { at: Date.now(), par: par || null, quoi: quoi, valeur: valeur == null ? null : valeur };
  const patch = { majA: Date.now(), historique: FV.arrayUnion(trace) };
  if (quoi === 'pause') { if (s.etat !== 'active') return { ok: false, erreur: 'pas_active' }; patch.etat = 'pause'; }
  else if (quoi === 'reprendre') {
    if (s.etat !== 'pause' && s.etat !== 'arretee') return { ok: false, erreur: 'rien_a_reprendre' };
    if (s.motifArret === 'desinscription') return { ok: false, erreur: 'prospect_desinscrit' };
    patch.etat = 'active'; patch.motifArret = null;
  }
  else if (quoi === 'arreter') { if (s.etat !== 'active' && s.etat !== 'pause') return { ok: false, erreur: 'deja_arretee' }; patch.etat = 'arretee'; patch.motifArret = 'arret_admin'; patch.arreteA = Date.now(); }
  else if (quoi === 'forcer') { if (s.etat !== 'active') return { ok: false, erreur: 'pas_active' }; patch.forcer = true; }
  else if (quoi === 'douleur') {
    const v = valeur ? String(valeur) : null;
    if (v && !CHOIX[v]) return { ok: false, erreur: 'histoire_inconnue' };
    if ((s.etapes || {}).e2) return { ok: false, erreur: 'histoire_deja_commencee' };
    patch.douleur = v; patch.citation = v ? (s.citation || CHOIX[v].citation) : null;
  }
  else if (quoi === 'choix') {
    const dernierK = dernierChapitreParti(s);
    if (!dernierK || !libelleChapitre(s, String(valeur)) || parcoursDe(s).some(function (x) { return x.c === valeur; })) return { ok: false, erreur: 'choix_invalide' };
    patch.choixSuivant = { c: String(valeur), e: dernierK, at: Date.now(), admin: true }; patch.choixLibelle = libelleChapitre(s, String(valeur));
  }
  else return { ok: false, erreur: 'action_inconnue' };
  await ref.set(patch, { merge: true });
  if (s.leadId) {
    const apres = Object.assign({}, s, patch);
    await db.collection('leads').doc(String(s.leadId)).update({ suiteApresRdv: resume(apres) }).catch(function () {});
  }
  return { ok: true };
}

/* ═══ Clics (page publique api/parcours-clic.js) ════════════════════════ */

async function parJeton(jeton) {
  const j = String(jeton || '');
  if (!/^[a-f0-9]{36}$/.test(j)) return null;
  const s = await db.collection(COL).where('jeton', '==', j).limit(1).get();
  return s.empty ? null : { ref: s.docs[0].ref, id: s.docs[0].id, data: s.docs[0].data() || {} };
}

function titreChoix(s, c) { return libelleChapitre(s, String(c || '')); }

/* Numéro de la dernière étape-chapitre partie (2…5), ou 0. */
function dernierChapitreParti(s) {
  let k = 0;
  for (let i = PREMIER_CHAPITRE; i <= DERNIER_CHAPITRE; i++) { const e = (s.etapes || {})['e' + i]; if (e && e.ok === true && e.chapitre) k = i; }
  return k;
}

/* Enregistre un clic FAIT PAR UN NAVIGATEUR (POST de la page, jamais la
   simple lecture du lien : les messageries ouvrent les liens pour l'aperçu).
   action : 'a' | 'b' | 'rdv' | 'stop'. */
async function enregistrerClic(jeton, action, etape, chapitre) {
  const x = await parJeton(jeton);
  if (!x) return { ok: false, erreur: 'lien_inconnu' };
  const s = x.data;
  const now = Date.now();
  const clic = { at: now, a: action, e: Number(etape) || null };
  if (action === 'c') clic.c = String(chapitre || '').slice(0, 4);
  if (action === 'stop') {
    await x.ref.set({ clics: FV.arrayUnion(clic) }, { merge: true });
    await desinscrire(x.ref, s);
    return { ok: true, action: 'stop' };
  }
  const patch = { clics: FV.arrayUnion(clic), majA: now };
  let libelle = null;
  if (action === 'c') {
    // Le choix ne vaut que s'il vient du DERNIER e-mail parti, pour un
    // chapitre que cet e-mail proposait, et tant que le suivant n'est pas parti.
    const k = dernierChapitreParti(s);
    const e = k ? s.etapes['e' + k] : null;
    const valable = !!e && Number(etape) === k && Array.isArray(e.options) && e.options.indexOf(clic.c) >= 0 && !(s.etapes || {})['e' + (k + 1)];
    if (!valable) { await x.ref.set({ clics: FV.arrayUnion(clic), majA: now }, { merge: true }); return { ok: true, action: 'c', tropTard: true }; }
    // Deux chapitres différents cliqués en moins de 2 min = un robot qui
    // ouvre tous les liens : on ne retient rien (le chapitre par défaut partira).
    const autre = (s.clics || []).some(function (c) { return c.a === 'c' && c.c !== clic.c && now - c.at < 120000; });
    if (autre) { patch.choixSuivant = null; patch.choixLibelle = null; patch.choixAmbigu = true; }
    else { libelle = titreChoix(s, clic.c); patch.choixSuivant = { c: clic.c, e: k, at: now }; patch.choixLibelle = libelle; patch.choixAmbigu = false; }
  }
  if (action === 'rdv') patch.dernierClic = { quoi: 'reserver', at: now };
  await x.ref.set(patch, { merge: true });
  if (s.leadId) {
    const apres = Object.assign({}, s, patch, { clics: undefined });
    const upd = { suiteApresRdv: resume(apres) };
    // Une ligne d'historique par CHOIX (pas de cloche : le closer la lit en ouvrant la fiche).
    const deja = (s.clics || []).some(function (c) { return c.a === action && (action !== 'c' || c.c === clic.c); });
    if (!deja && libelle) upd.timeline_history = FV.arrayUnion({ text: '👆 Séquence après RDV — a choisi de lire : « ' + libelle + ' »', date: dateFr(), color: '#a78bfa' });
    if (!deja && action === 'rdv') upd.timeline_history = FV.arrayUnion({ text: '👆 Séquence après RDV — a cliqué sur « réserver »', date: dateFr(), color: '#a78bfa' });
    await db.collection('leads').doc(String(s.leadId)).update(upd).catch(function () {});
  }
  return { ok: true, action: action, libelle: libelle, ambigu: !!patch.choixAmbigu };
}

/* ═══ Réponse par e-mail (appelé par gmail-inbound-sync) ════════════════ */

/* « Non », « plus tard » : la séquence s'arrête, sans cloche. */
const RE_NON = /^\s*(non( merci)?|plus tard|pas int[ée]ress[ée]e?s?|pas pour (moi|l'instant|le moment)|ce n'est (plus|pas) d'actualit[ée])[\s.!]*$/i;
/* « Stop », « désinscription » : désinscription complète, sans cloche. */
const RE_DESINSCRIRE = /^\s*(stop|d[ée]sinscri\w*( moi)?|d[ée]sabonn\w*( moi)?|unsubscribe|(merci de )?ne (plus )?(me |m')?(contact|relanc|[ée]cri|envoy)\w* plus( svp| s'il vous pla[iî]t)?( de (mails?|e-?mails?|messages?))?)[\s.!]*$/i;

function sujetNu(x) { return norm(String(x || '').replace(/^\s*((re|tr|fw|fwd)\s*:\s*)+/i, '')); }

/* Réponse d'un prospect en séquence. Renvoie { suite:false } s'il n'a pas de
   séquence concernée ; sinon { suite:true, silence, resume }.
   Le SILENCE (pas de cloche) n'existe que si la réponse est faite À UN E-MAIL
   DE LA SÉQUENCE (même objet) et qu'elle dit, en quelques mots, « non »,
   « plus tard » ou « stop ». Tout le reste sonne comme avant. Ne lance jamais. */
async function surReponseEmail(o) {
  try {
    if (!o || !o.leadId) return { suite: false };
    const q = await db.collection(COL).where('leadId', '==', String(o.leadId)).get();
    let x = null;
    q.forEach(function (d) { const s = d.data() || {}; if (s.etat === 'active' && (!x || (s.creeA || 0) > (x.data.creeA || 0))) x = { ref: d.ref, data: s }; });
    if (!x) return { suite: false };
    // Réponse à l'un de NOS e-mails de séquence ? (objet identique, « Re: » retiré)
    const et = x.data.etapes || {};
    const sujet = sujetNu(o.sujet);
    const dansLeFil = !!sujet && Object.keys(et).some(function (k) { return et[k] && et[k].ok === true && sujetNu(et[k].objet) === sujet; });
    if (!dansLeFil) return { suite: false };
    const texte = String(o.texte || '').replace(/\s+/g, ' ').trim();
    const court = texte.length <= 80;
    if (court && RE_DESINSCRIRE.test(texte)) {
      await x.ref.set({ reponses: FV.arrayUnion({ at: Date.now(), sens: 'desinscription', resume: texte.slice(0, 200) }) }, { merge: true });
      await desinscrire(x.ref, x.data);
      return { suite: true, silence: true, sens: 'desinscription' };
    }
    if (court && RE_NON.test(texte)) {
      await x.ref.set({ reponses: FV.arrayUnion({ at: Date.now(), sens: 'stop', resume: texte.slice(0, 200) }) }, { merge: true });
      await arreter(x.ref, x.data, 'reponse_stop');
      return { suite: true, silence: true, sens: 'stop' };
    }
    // Toute autre réponse SONNE. L'IA ne sert qu'à résumer en une ligne et à
    // arrêter la séquence si le prospect dit clairement non : jamais à taire.
    let sens = 'autre', res = null;
    if (texte) {
      try {
        const { callClaude } = require('./_ai');
        const r = await callClaude({
          task: 'parcours_reponse', noContext: true, maxTokens: 300,
          system: 'Tu lis la réponse d\'un dirigeant à un e-mail de suivi commercial (après un rendez-vous où il n\'a pas signé). Classe-la et résume-la en UNE phrase factuelle en français, sans rien inventer. sens = "stop" seulement s\'il dit clairement qu\'il ne veut plus être contacté ou n\'est pas intéressé ; "interesse" s\'il veut avancer ou reprendre rendez-vous ; "question" s\'il pose une question ou attend une réponse ; sinon "autre".',
          schema: { type: 'object', additionalProperties: false, required: ['sens', 'resume'], properties: { sens: { type: 'string', enum: ['stop', 'interesse', 'question', 'autre'] }, resume: { type: 'string' } } },
          prompt: texte.slice(0, 3000),
        });
        if (r && r.ok && r.json) { sens = r.json.sens || 'autre'; res = String(r.json.resume || '').slice(0, 220); }
      } catch (e) { /* IA indisponible : la cloche part, sans résumé */ }
    }
    await x.ref.set({ reponses: FV.arrayUnion({ at: Date.now(), sens: sens, resume: res || texte.slice(0, 200) }), majA: Date.now() }, { merge: true });
    if (sens === 'stop') await arreter(x.ref, x.data, 'reponse_stop');
    return { suite: true, silence: false, sens: sens, resume: res };
  } catch (e) {
    console.warn('[parcours-suite] réponse e-mail', e && e.message);
    return { suite: false };
  }
}

/* ═══ Prospects chauds (brief du matin) ═════════════════════════════════ */

/* Ceux qui ont cliqué « réserver » ou choisi une suite depuis `depuisMs`
   et n'ont pas repris de RDV. Prénoms + ce qu'ils ont fait, rien d'autre. */
async function prospectsChauds(depuisMs) {
  const snap = await db.collection(COL).where('majA', '>=', depuisMs).get();
  const out = [];
  snap.forEach(function (d) {
    const s = d.data() || {};
    if (s.etat !== 'active') return;
    const clics = (s.clics || []).filter(function (c) { return c.at >= depuisMs && c.a !== 'stop'; });
    if (!clics.length) return;
    out.push({ leadId: s.leadId || null, prenom: s.prenom || '', sequence: LIB_SEQ[s.sequence] || s.sequence,
      reserver: clics.some(function (c) { return c.a === 'rdv'; }), choix: s.choixLibelle || null });
  });
  return out;
}

/* ═══ Test (au membre de test uniquement) ═══════════════════════════════ */

const EXEMPLE_MIROIRS = (function () { const o = {}; MIROIRS.forEach(function (m) { o[m.cle] = m.r[0][1]; }); return o; })();

function suiteFictive(o) {
  const douleur = CHOIX[o.douleur] ? o.douleur : null;
  return { bookingId: 'test', leadId: null, email: o.email, prenom: o.prenom || 'Adrien', sequence: LIB_SEQ[o.sequence] ? o.sequence : 'frein_tresorerie',
    douleur: douleur, citation: douleur ? CHOIX[douleur].citation : null, choixSuivant: null, miroirs: EXEMPLE_MIROIRS, jeton: '0'.repeat(36),
    forceChapitre: (douleur && CHOIX[douleur].chapitres[o.chapitre]) ? o.chapitre : null, forceChoisi: o.choisi === true,
    etapes: {}, etat: 'active' };
}

async function envoyerTest(o) {
  const cfg = await P.lireConfig();
  const r = await db.collection('_config').doc('relances').get();
  const email = o.vers || (r.exists ? (r.data() || {}).testEmail : null);
  if (!email) return { ok: false, erreur: 'email_de_test_absent' };
  const s = suiteFictive(Object.assign({}, o, { email: email }));
  const c = contenuDe(s, Number(o.etape) || 1);
  if (!c || c.erreur) return { ok: false, erreur: (c && c.erreur) || 'etape_inconnue' };
  const { sendEmailFromAccount } = require('./_gmailSend');
  const g = await sendEmailFromAccount({ accountKey: cfg.emailCompte || 'strategie', to: email, subject: c.subject, bodyHtml: c.html, bodyText: c.text });
  return { ok: !!(g && g.ok), email: c.cle, objet: c.subject, erreur: g && g.ok ? null : (g && g.error) };
}

module.exports = {
  DEFAUTS: DEFAUTS, JOURS: JOURS, LIB_SEQ: LIB_SEQ, LIB_DOULEUR: LIB_DOULEUR, MIROIRS: MIROIRS, COL: COL,
  profilDe: profilDe, planDe: planDe, contenuDe: contenuDe, etapeDue: etapeDue, creer: creer, arreter: arreter, passage: passage,
  parJeton: parJeton, enregistrerClic: enregistrerClic, titreChoix: titreChoix, lienRdvDirect: lienRdvDirect,
  chapitreDe: chapitreDe, optionsApres: optionsApres, parcoursDe: parcoursDe, ORDRE_CHAPITRES: ORDRE_CHAPITRES,
  prochainEnvoi: prochainEnvoi, ligneAdmin: ligneAdmin, listeAdmin: listeAdmin, statsDe: statsDe, arbre: arbre, actionAdmin: actionAdmin,
  desinscrire: desinscrire, faireAC: faireAC, reglee: reglee,
  surReponseEmail: surReponseEmail, prospectsChauds: prospectsChauds, suiteFictive: suiteFictive, envoyerTest: envoyerTest, lireConfig: lireConfig, resume: resume, typeDe: typeDe,
};
