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
const CHOIX = require('./_parcoursChoixData.json');

const FV = admin.firestore.FieldValue;
const BASE_URL = 'https://team.alteore.com';
const COL = 'parcours_suites';

const DEFAUTS = { actif: false, plafondJour: 80, newsletterAutomation: '29', heureDebut: 9 * 60 + 30, heureFin: 19 * 60 };

/* Jours après le RDV, par type de séquence. */
const JOURS = { frein: [1, 4, 8, 14, 21], general: [1, 5, 12, 21], rdv_manque: [1, 3, 7] };
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
  { q: /qu'est-ce qui vous pese le plus/, r: [
    [/^je fais du chiffre/, 'rentabilite'], [/^je suis noye/, 'operationnel'], [/^mon entreprise a avale/, 'vie'],
    [/^mes salaries viennent/, 'equipe'], [/^mon chiffre d'affaires plafonne/, 'plafond']] },
  { q: /quel est votre principal defi/, r: [
    [/^ma marge ne suit pas/, 'rentabilite'], [/^je veux structurer mon entreprise/, 'operationnel'], [/^je travaille trop d'heures/, 'vie'],
    [/^je n'arrive pas a deleguer/, 'equipe'], [/^mon ca plafonne/, 'plafond']] },
];

const ECHELLE_HAUTE = /^[45]\s*\/\s*5/;
const MIROIRS = [
  { cle: 'm_marge', q: /quelle marge vous gagnez sur chacune/, r: [[/^non/, 'Vous nous avez dit ne pas connaître précisément la marge de chacune de vos offres.']] },
  { cle: 'm_sommeil', q: /mal dormir en pensant a la tresorerie/, r: [[ECHELLE_HAUTE, 'Vous nous avez aussi dit qu\'il vous arrive de mal dormir en pensant à la trésorerie des semaines à venir.']] },
  { cle: 'm_2semaines', q: /2 semaines sans telephone/, r: [[/^non/, 'Vous nous avez dit que votre entreprise ne tournerait pas deux semaines sans vous.']] },
  { cle: 'm_autonome', q: /nouveau salarie peut-il devenir autonome/, r: [[/^non/, 'Vous nous avez dit qu\'un nouveau salarié ne devient pas autonome sans que vous le formiez vous-même.']] },
  { cle: 'm_consignes', q: /repeter les memes consignes/, r: [[ECHELLE_HAUTE, 'Vous nous avez dit avoir l\'impression de répéter les mêmes consignes, encore et encore.']] },
  { cle: 'm_charge', q: /c'est moi qui absorbe la charge/, r: [[ECHELLE_HAUTE, 'Vous nous avez dit que, chaque fois que l\'activité augmente, c\'est vous qui absorbez la charge en plus.']] },
  { cle: 'm_levier', q: /quel levier actionner/, r: [[/^non/, 'Vous nous avez dit ne pas savoir exactement quel levier actionner pour augmenter votre chiffre d\'affaires.']] },
  { cle: 'm_heures', q: /^heures travaillees/, r: [
    [/^entre 50 et 60/, 'Vous travaillez entre 50 et 60 heures par semaine.'], [/^plus de 60/, 'Vous travaillez plus de 60 heures par semaine.']] },
  { cle: 'm_rythme', q: /comment vivez-vous ce rythme/, r: [
    [/^je suis a bout/, 'Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « Je suis à bout. »'],
    [/^c'est tendu, mais je tiens/, 'Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « C\'est tendu, mais je tiens. »']] },
  { cle: 'm_duree', q: /^depuis combien de temps/, r: [
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
  const rep = Lqs.extractAnswers(lead || {});
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

function lien(jeton, action, etape) {
  return BASE_URL + '/api/parcours-clic?j=' + encodeURIComponent(jeton) + '&a=' + action + (etape ? '&e=' + etape : '');
}
function lienRdvDirect(sequence) {
  return BASE_URL + '/booking.html?type=call_strat_phenix_all&utm_source=team&utm_medium=email&utm_campaign=' + encodeURIComponent(sequence);
}

/* ═══ Contenu d'une étape ═══════════════════════════════════════════════ */

function typeDe(sequence) { return sequence === 'rdv_manque' ? 'rdv_manque' : 'frein'; }

/* Nombre d'étapes et jours : avec une douleur, toujours 5 ; sinon la
   séquence telle qu'écrite (« général » n'a que 4 e-mails). */
function planDe(suite) {
  if (suite.sequence === 'rdv_manque') return JOURS.rdv_manque;
  if (suite.douleur) return JOURS.frein;
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

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

const MIROIR_E1_HTML = '<p style="margin:0 0 16px;padding:12px 16px;background:#fffbeb;border-radius:10px;color:#92400e">Avant notre échange, à la question « Qu\'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu : <strong>« {{C}} »</strong> Nous ne l\'avons pas oublié : c\'est de là que partiront nos prochains e-mails.</p>';
const MIROIR_E1_TEXTE = 'Avant notre échange, à la question « Qu\'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu : « {{C}} » Nous ne l\'avons pas oublié : c\'est de là que partiront nos prochains e-mails.';

/* { subject, html, text, cle } de l'étape k (1…n), ou null. */
function contenuDe(suite, k) {
  const plan = planDe(suite);
  if (k < 1 || k > plan.length) return null;
  const prenom = String(suite.prenom || '').trim();
  let src = null, cle = '';
  const D = suite.douleur ? CHOIX[suite.douleur] : null;
  let miroirE1 = false;
  if (suite.sequence === 'rdv_manque') { src = acMessage('rdv_manque', k); cle = 'rdv_manque#' + k; }
  else if (D && k >= 2 && k <= 4) {
    const e = k === 2 ? 'E2' : k === 4 ? 'E4' : (suite.choix === 'b' ? 'E3B' : 'E3A');
    src = D.emails[e]; cle = suite.douleur + '#' + e;
  } else {
    // E-mail du frein. Avec une douleur, le 5e est le DERNIER du frein.
    const n = (D && k === plan.length) ? dernierN(suite.sequence) : k;
    src = acMessage(suite.sequence, n); cle = suite.sequence + '#' + n;
    miroirE1 = !!(D && k === 1 && suite.citation);
  }
  if (!src) return null;
  let html = String(src.html), text = String(src.text);

  if (miroirE1) {
    // Après le premier paragraphe qui suit « Bonjour … ».
    let pos = html.indexOf('</p>');
    pos = pos >= 0 ? html.indexOf('</p>', pos + 4) : -1;
    if (pos >= 0) html = html.slice(0, pos + 4) + MIROIR_E1_HTML.replace('{{C}}', esc(suite.citation)) + html.slice(pos + 4);
    const blocs = text.split('\n\n');
    if (blocs.length > 2) { blocs.splice(2, 0, MIROIR_E1_TEXTE.replace('{{C}}', suite.citation)); text = blocs.join('\n\n'); }
  }

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
  function partout(s, enHtml) {
    s = s.split('{{douleur_citation}}').join(enHtml ? esc(suite.citation || '') : (suite.citation || ''));
    s = s.split('{{lien_rdv}}').join(rdv).split('{{lien_choix_a}}').join(lien(suite.jeton, 'a', k)).split('{{lien_choix_b}}').join(lien(suite.jeton, 'b', k));
    s = s.split('{{lien_desinscription}}').join(stop).split('%UNSUBSCRIBELINK%').join(stop);
    // Liens de réservation écrits pour ActiveCampaign → lien suivi par Team.
    s = s.replace(/https:\/\/team\.alteore\.com\/booking\.html\?type=call_strat_phenix_all[^"'\s<]*/g, rdv);
    if (prenom) s = s.split('%FIRSTNAME%').join(enHtml ? esc(prenom) : prenom);
    else s = s.split('Bonjour %FIRSTNAME%,').join('Bonjour,').split('%FIRSTNAME%').join('');
    return s;
  }
  html = partout(html, true); text = partout(text, false);
  if (/\{\{|%[A-Z_]+%/.test(html) || /\{\{|%[A-Z_]+%/.test(text)) return { erreur: 'variable_non_remplie', cle: cle };
  return { subject: src.subject, html: html, text: text, cle: cle };
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
  let profil = { douleur: null, citation: null, miroirs: {} };
  let lead = null;
  if (b.leadId) {
    const ls = await db.collection('leads').doc(String(b.leadId)).get();
    lead = ls.exists ? (ls.data() || {}) : null;
    if (lead && o.sequence !== 'rdv_manque') profil = profilDe(lead);
  }
  const doc = {
    bookingId: String(o.bookingId), leadId: b.leadId || null, email: email,
    prenom: String(p.prenom || '').trim() || String(p.nom || '').trim().split(/\s+/)[0] || '',
    sequence: o.sequence, douleur: profil.douleur, citation: profil.citation, miroirs: profil.miroirs,
    rdvDate: b.date || null, jeton: jetonNeuf(), etat: 'active', etapes: {}, choix: null, clics: [],
    creeA: Date.now(), majA: Date.now(),
  };
  const cree = await db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    if (s.exists) return false;
    tx.set(ref, doc);
    return true;
  });
  if (!cree) return { ok: true, deja: true };
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

/* Le résumé affiché sur la fiche (leads.suiteApresRdv) : une seule ligne
   d'état, jamais une alerte. */
function resume(s) {
  const plan = planDe(s);
  const faites = Object.keys(s.etapes || {}).filter(function (k) { return s.etapes[k] && s.etapes[k].ok; }).length;
  return {
    bookingId: s.bookingId, sequence: s.sequence, sequenceLibelle: LIB_SEQ[s.sequence] || s.sequence,
    douleur: s.douleur || null, douleurLibelle: s.douleur ? LIB_DOULEUR[s.douleur] : null,
    etat: s.etat, motifArret: s.motifArret || null, envoyes: faites, total: plan.length,
    choix: s.choix || null, choixLibelle: s.choixLibelle || null, dernierClic: s.dernierClic || null, majA: Date.now(),
  };
}

/* ═══ Arrêt ═════════════════════════════════════════════════════════════ */

const LIB_ARRET = {
  rdv_repris: 'a repris un rendez-vous', client: 'est devenu client', desinscription: 's\'est désinscrit',
  reponse_stop: 'a répondu qu\'il ne souhaitait pas donner suite', issue_changee: 'l\'issue du RDV a changé',
  terminee: 'séquence terminée', rdv_annule_equipe: 'RDV annulé par l\'équipe',
};

async function arreter(ref, s, motif, opts) {
  opts = opts || {};
  const etat = motif === 'terminee' ? 'terminee' : 'arretee';
  await ref.set({ etat: etat, motifArret: motif, arreteA: Date.now(), majA: Date.now() }, { merge: true });
  const apres = Object.assign({}, s, { etat: etat, motifArret: motif });
  if (s.leadId) {
    await db.collection('leads').doc(String(s.leadId)).update({
      suiteApresRdv: resume(apres),
      timeline_history: FV.arrayUnion({ text: (motif === 'terminee' ? '📭 Séquence après RDV terminée' : '📭 Séquence après RDV arrêtée : ' + (LIB_ARRET[motif] || motif)), date: dateFr(), color: '#a78bfa' }),
    }).catch(function () {});
  }
  // ActiveCampaign : désinscription complète, ou retour à la newsletter.
  try {
    const AC = require('./_activeCampaign');
    const c = await AC.contact(s.email);
    if (c.ok) {
      if (motif === 'desinscription') {
        await AC.ajouterTag(c.id, 'stop_autom');
        const d = await AC.desinscrire(c.id);
        await ref.set({ acDesinscription: { ok: !!d.ok, listes: d.listes || 0, at: Date.now() } }, { merge: true });
      } else if (motif === 'terminee' && opts.newsletter) {
        const r = await AC.entrerAutomatisation(c.id, opts.newsletter);
        await ref.set({ acNewsletter: { ok: !!r.ok, deja: !!r.deja, at: Date.now(), erreur: r.erreur || null } }, { merge: true });
      }
    }
  } catch (e) { console.warn('[parcours-suite] AC arrêt', e && e.message); }
}

/* ═══ Passage du cron ═══════════════════════════════════════════════════ */

function parisMin(ms) { return Dispo.parisStamp(new Date(ms)); }

/* Étape due maintenant (1…n) ou 0. */
function etapeDue(s, now) {
  const plan = planDe(s);
  const et = s.etapes || {};
  let k = 1;
  while (k <= plan.length && et['e' + k]) k++;
  if (k > plan.length) return { k: 0, fini: true };
  if (!s.rdvDate) return { k: 0 };
  const st = parisMin(now);
  const jour = Dispo.addDays(s.rdvDate, plan[k - 1]);
  if (st.ymd < jour) return { k: 0 };
  const prec = k > 1 ? et['e' + (k - 1)] : null;
  if (prec && prec.at && now - prec.at < ECART_MIN_MS) return { k: 0 };
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
  const snap = await db.collection(COL).where('etat', '==', 'active').get();
  for (let i = 0; i < snap.docs.length; i++) {
    if (Date.now() - now > 45000) { sortie.interrompu = 'budget_temps'; break; }
    const d = snap.docs[i];
    const s = d.data() || {};
    sortie.suites++;
    const ligne = { id: d.id, sequence: s.sequence, douleur: s.douleur || null };
    try {
      const bs = await db.collection('bookings').doc(String(s.bookingId)).get();
      const b = bs.exists ? (bs.data() || {}) : null;
      const estTest = cfg.modeTest === false || (b && P.estRdvDeTest(b, T));
      const reel = !simulation && estTest;

      // ── Le prospect a-t-il changé de case ? ──
      let motif = null;
      if (!b) motif = 'issue_changee';
      else if (s.sequence === 'rdv_manque' && !(b.status === 'cancelled' || b.outcome === 'no_show' || b.outcome === 'annule')) motif = 'issue_changee';
      else if (s.sequence !== 'rdv_manque' && b.outcome !== 'non_close') motif = 'issue_changee';
      if (!motif && b && await P.autreRdvAVenir(b, d.id, now, typeMap)) motif = 'rdv_repris';
      if (!motif && s.leadId) {
        const ls = await db.collection('leads').doc(String(s.leadId)).get();
        const l = ls.exists ? (ls.data() || {}) : {};
        if (l.isClient === true || /^closed_won/.test(String(l.stage || ''))) motif = 'client';
        else if (l.emailDesinscrit === true) motif = 'desinscription';
      }
      if (motif) {
        ligne.resultat = 'arret:' + motif;
        if (reel) await arreter(d.ref, s, motif);
        sortie.detail.push(ligne); continue;
      }

      const due = etapeDue(s, now);
      if (due.fini) {
        // Dernier e-mail parti depuis 3 jours : fin, retour à la newsletter.
        const plan = planDe(s);
        const dernier = (s.etapes || {})['e' + plan.length];
        if (dernier && dernier.at && now - dernier.at > 3 * 86400000) {
          ligne.resultat = 'terminee';
          if (reel) await arreter(d.ref, s, 'terminee', { newsletter: S.newsletterAutomation });
        } else ligne.resultat = 'attente_fin';
        sortie.detail.push(ligne); continue;
      }
      if (!due.k) { ligne.resultat = 'pas_encore'; sortie.detail.push(ligne); continue; }
      ligne.etape = due.k;
      if (!fenetre) { ligne.resultat = 'hors_horaires'; sortie.detail.push(ligne); continue; }
      const c = contenuDe(s, due.k);
      if (!c || c.erreur) { ligne.resultat = 'contenu_indisponible'; ligne.erreur = c && c.erreur; sortie.detail.push(ligne); continue; }
      ligne.email = c.cle; ligne.objet = c.subject;
      if (!reel) { ligne.resultat = 'simule'; sortie.detail.push(ligne); continue; }
      if (compteur >= S.plafondJour) { ligne.resultat = 'plafond_du_jour'; sortie.plafondAtteint = true; sortie.detail.push(ligne); continue; }

      // Réservation transactionnelle : un e-mail n'est jamais envoyé deux fois.
      const cleE = 'e' + due.k;
      const pris = await db.runTransaction(async function (tx) {
        const x = await tx.get(d.ref);
        const dx = x.data() || {};
        if (dx.etat !== 'active' || (dx.etapes || {})[cleE]) return false;
        const patch = { etapes: {} }; patch.etapes[cleE] = { reserveA: Date.now() };
        tx.set(d.ref, patch, { merge: true });
        return true;
      });
      if (!pris) { ligne.resultat = 'deja'; sortie.detail.push(ligne); continue; }
      let r;
      try {
        const { sendEmailFromAccount } = require('./_gmailSend');
        const g = await sendEmailFromAccount({ accountKey: cfg.emailCompte || 'strategie', to: s.email, subject: c.subject, bodyHtml: c.html, bodyText: c.text });
        r = (g && g.ok) ? { ok: true, id: g.messageId || null } : { ok: false, erreur: (g && g.error) || 'echec_gmail' };
      } catch (e) { r = { ok: false, erreur: (e && e.message) || 'echec_gmail' }; }
      const note = { etapes: {}, majA: Date.now() };
      note.etapes[cleE] = { at: Date.now(), ok: !!r.ok, id: r.id || null, erreur: r.erreur || null, email: c.cle, objet: c.subject };
      // Le choix est figé au moment où la suite choisie part.
      if (due.k === 3 && s.douleur) note.choixFige = s.choix || 'a';
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

/* ═══ Clics (page publique api/parcours-clic.js) ════════════════════════ */

async function parJeton(jeton) {
  const j = String(jeton || '');
  if (!/^[a-f0-9]{36}$/.test(j)) return null;
  const s = await db.collection(COL).where('jeton', '==', j).limit(1).get();
  return s.empty ? null : { ref: s.docs[0].ref, id: s.docs[0].id, data: s.docs[0].data() || {} };
}

function titreChoix(s, lettre) {
  const D = s.douleur ? CHOIX[s.douleur] : null;
  if (!D) return null;
  const e = D.emails[lettre === 'b' ? 'E3B' : 'E3A'];
  return e ? e.subject : null;
}

/* Enregistre un clic FAIT PAR UN NAVIGATEUR (POST de la page, jamais la
   simple lecture du lien : les messageries ouvrent les liens pour l'aperçu).
   action : 'a' | 'b' | 'rdv' | 'stop'. */
async function enregistrerClic(jeton, action, etape) {
  const x = await parJeton(jeton);
  if (!x) return { ok: false, erreur: 'lien_inconnu' };
  const s = x.data;
  const now = Date.now();
  const clic = { at: now, a: action, e: Number(etape) || null };
  if (action === 'stop') {
    if (s.etat === 'active') await arreter(x.ref, s, 'desinscription');
    else await x.ref.set({ etat: 'arretee', motifArret: 'desinscription', majA: now }, { merge: true });
    if (s.leadId) await db.collection('leads').doc(String(s.leadId)).update({ emailDesinscrit: true, emailDesinscritA: now }).catch(function () {});
    await x.ref.set({ clics: FV.arrayUnion(clic) }, { merge: true });
    return { ok: true, action: 'stop' };
  }
  const patch = { clics: FV.arrayUnion(clic), majA: now };
  let libelle = null;
  if (action === 'a' || action === 'b') {
    // Deux choix opposés en moins de 2 min = un robot qui ouvre tous les
    // liens : on ne retient rien (la suite par défaut partira).
    const autre = (s.clics || []).some(function (c) { return (c.a === 'a' || c.a === 'b') && c.a !== action && now - c.at < 120000; });
    if (!s.choixFige) {
      if (autre) { patch.choix = null; patch.choixLibelle = null; patch.choixAmbigu = true; }
      else { libelle = titreChoix(s, action); patch.choix = action; patch.choixLibelle = libelle; patch.choixA = now; }
    }
  }
  if (action === 'rdv') patch.dernierClic = { quoi: 'reserver', at: now };
  await x.ref.set(patch, { merge: true });
  if (s.leadId) {
    const apres = Object.assign({}, s, patch, { clics: undefined });
    const upd = { suiteApresRdv: resume(apres) };
    // Une ligne d'historique par CHOIX (pas de cloche : le closer la lit en ouvrant la fiche).
    const deja = (s.clics || []).some(function (c) { return c.a === action; });
    if (!deja && libelle) upd.timeline_history = FV.arrayUnion({ text: '👆 Séquence après RDV — a voulu lire : « ' + libelle + ' »', date: dateFr(), color: '#a78bfa' });
    if (!deja && action === 'rdv') upd.timeline_history = FV.arrayUnion({ text: '👆 Séquence après RDV — a cliqué sur « réserver »', date: dateFr(), color: '#a78bfa' });
    await db.collection('leads').doc(String(s.leadId)).update(upd).catch(function () {});
  }
  return { ok: true, action: action, libelle: libelle, ambigu: !!patch.choixAmbigu };
}

/* ═══ Réponse par e-mail (appelé par gmail-inbound-sync) ════════════════ */

const RE_STOP = /^\s*(non( merci)?|plus tard|pas int[ée]ress[ée]e?s?|stop|d[ée]sinscri\w*|ne (me )?(contactez|relancez|[ée]crivez) plus|pas pour (moi|l'instant|le moment)|ce n'est (plus|pas) d'actualit[ée])[\s.!]*$/i;

/* Réponse d'un prospect en séquence. Renvoie { suite:false } s'il n'a pas de
   séquence active ; sinon { suite:true, silence, resume }.
   silence = vrai : « non / plus tard » → séquence arrêtée, AUCUNE cloche.
   Sinon la cloche part, avec un résumé d'une ligne. Ne lance jamais. */
async function surReponseEmail(o) {
  try {
    if (!o || !o.leadId) return { suite: false };
    const q = await db.collection(COL).where('leadId', '==', String(o.leadId)).get();
    let x = null;
    q.forEach(function (d) { const s = d.data() || {}; if (s.etat === 'active' && (!x || (s.creeA || 0) > (x.data.creeA || 0))) x = { ref: d.ref, data: s }; });
    if (!x) return { suite: false };
    const texte = String(o.texte || '').replace(/\s+/g, ' ').trim();
    let sens = RE_STOP.test(texte.slice(0, 80)) && texte.length <= 80 ? 'stop' : null;
    let res = null;
    if (!sens && texte) {
      try {
        const { callClaude } = require('./_ai');
        const r = await callClaude({
          task: 'parcours_reponse', noContext: true, maxTokens: 300,
          system: 'Tu lis la réponse d\'un dirigeant à un e-mail de suivi commercial (après un rendez-vous où il n\'a pas signé). Classe-la et résume-la en UNE phrase factuelle en français, sans rien inventer. sens = "stop" seulement s\'il dit clairement qu\'il ne veut plus être contacté ou n\'est pas intéressé ; "interesse" s\'il veut avancer ou reprendre rendez-vous ; "question" s\'il pose une question ou attend une réponse ; sinon "autre".',
          schema: { type: 'object', additionalProperties: false, required: ['sens', 'resume'], properties: { sens: { type: 'string', enum: ['stop', 'interesse', 'question', 'autre'] }, resume: { type: 'string' } } },
          prompt: texte.slice(0, 3000),
        });
        if (r && r.ok && r.json) { sens = r.json.sens; res = String(r.json.resume || '').slice(0, 220); }
      } catch (e) { /* IA indisponible : la cloche part, sans résumé */ }
    }
    await x.ref.set({ reponses: FV.arrayUnion({ at: Date.now(), sens: sens || 'autre', resume: res || texte.slice(0, 200) }), majA: Date.now() }, { merge: true });
    if (sens === 'stop') {
      await arreter(x.ref, x.data, 'reponse_stop');
      return { suite: true, silence: true, sens: 'stop' };
    }
    return { suite: true, silence: false, sens: sens || 'autre', resume: res };
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
    douleur: douleur, citation: douleur ? CHOIX[douleur].citation : null, miroirs: EXEMPLE_MIROIRS, jeton: '0'.repeat(36),
    choix: o.choix === 'b' ? 'b' : 'a', etapes: {}, etat: 'active' };
}

async function envoyerTest(o) {
  const cfg = await P.lireConfig();
  const r = await db.collection('_config').doc('relances').get();
  const email = (r.exists ? (r.data() || {}).testEmail : null);
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
  surReponseEmail: surReponseEmail, prospectsChauds: prospectsChauds, suiteFictive: suiteFictive, envoyerTest: envoyerTest, lireConfig: lireConfig, resume: resume, typeDe: typeDe,
};
