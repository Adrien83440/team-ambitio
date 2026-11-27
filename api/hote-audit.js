// ============================================================================
// api/hote-audit.js — AUDIT DE L'HÔTE D'UN RDV (27/11/2026), LECTURE SEULE
// ----------------------------------------------------------------------------
// TEMPORAIRE, À RETIRER. N'existe que sur la branche de travail (preview
// Vercel), jamais sur `main`. Même structure et même contrôle de clé que
// l'ancienne route de reprise (git show 6798824:api/reprise-donnees.js).
//
// Pourquoi : le closer d'un RDV sans closer enregistré est l'HÔTE de sa fiche
// d'agenda (StatsCore.closerDuRdv → résolveur personId → membre). La fiche
// booking_config/elodie a été REPRISE par Anthony le 10/10/2026 (nom, titre
// et firebaseUid d'Anthony, identifiant inchangé pour garder les liens
// publics). L'ancienne règle (identifiant == slug D'ABORD, puis compte relié)
// range donc les RDV d'Anthony depuis le 10/10 en « Anciens membres ». La
// nouvelle règle (StatsCore.resoudreHote : compte relié D'ABORD — à compte
// égal un membre en place prime sur un ancien membre, puis le plus petit
// order, puis le slug — puis identifiant == slug) les rend à Anthony. Cette
// route mesure, sur la base réelle, quels RDV changent de ligne AVANT la mise
// en production.
//
// Accès : variable Vercel HOTE_AUDIT_KEY (24 caractères au moins, preview de
// la branche seulement), en-tête `x-audit-key` ou paramètre `k`. Absente ou
// fausse → 404 sans corps et sans aucune lecture. GET seulement.
// Cache-Control: no-store.
//
// N'ÉCRIT RIEN (ni set, ni update, ni add, ni batch, ni transaction).
// AUCUNE DONNÉE DE CLIENT OU DE PROSPECT EN SORTIE : ni nom, ni e-mail, ni
// téléphone, ni identifiant de fiche lead ou de RDV. Sortent seulement des
// comptes, des mois, les slugs et prénoms des MEMBRES de l'équipe et les
// identifiants des fiches d'agenda (booking_config). Un personId qui n'est
// pas une fiche d'agenda connue sort sous « (autre) ». Les RDV ne sont lus
// que par les champs utiles au calcul (select). Erreurs : statut gRPC ou
// « <nom> : (détail masqué) » (msgSur), jamais le texte libre d'une exception.
//
//   ?job=roster
//     membres de _meta/team_members (FunnelCore.loadTeamMembers) : slug,
//     prénom, role, active, departed, parti (StatsCore.estParti), aUnCompte,
//     startDate, order, ongletCloser ; fiches d'agenda (__type 'person') :
//     id, aUnCompte, compteDe (slugs des membres de ce compte), resoutVers
//     { ancienne, nouvelle } ; fichesReprises : identifiant = slug d'un membre
//     alors que le compte relié est celui d'un AUTRE membre.
//   ?job=rdv&from=AAAA-MM-JJ&to=AAAA-MM-JJ   (93 jours au plus)
//     RDV de VENTE de la plage (StatsCore.classifyBooking avec la typeMap de
//     FunnelCore.loadTypeMap ; replanifiés et doublons hors compte comme
//     StatsCore.etat), comptés par MOIS et par closer (ligne de
//     StatsCore.rangPersonne, options de api/_aiTools.js, vue closer, jour =
//     date du RDV) sous l'ANCIENNE et la NOUVELLE règle ; RDV qui changent
//     de ligne, détail { de, vers, n, parVoie } ; décompte par fiche d'agenda
//     × présence de expertSlug × présence de closeData.closerSlug.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const Core = require('../funnel-core.js');

const MAX_JOURS = 93;
const MAX_RDV = 20000;            /* plafond de lecture des RDV de la plage */
const RE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
const RE_MOIS_DEBUT = /^\d{4}-\d{2}/;
/* Champs d'un RDV lus (rien d'autre ne quitte la base) : classe, état,
   closer. Aucun champ prospect. */
const CHAMPS_RDV = ['date', 'time', 'duration', 'type', 'source', 'isCoaching', 'skipLeadCreation', 'clientId',
  'status', 'outcome', 'duplicateOf', 'cancellation', 'cancelledReason', 'rescheduled', 'transferredTo',
  'personId', 'expertSlug', 'closeData'];

function keyOk(req) {
  const want = String(process.env.HOTE_AUDIT_KEY || '');
  const q = req.query || {};
  const brut = (req.headers && req.headers['x-audit-key']) || q.k || '';
  /* Un texte seulement : un tableau (k répété) n'est jamais une clé. */
  if (typeof brut !== 'string') return false;
  /* Longueur comparée en OCTETS (timingSafeEqual lève sinon). */
  try {
    const a = Buffer.from(brut, 'utf8'), b = Buffer.from(want, 'utf8');
    if (b.length < 24 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/* Message d'erreur SANS donnée personnelle : statut gRPC seulement, sinon le
   nom de l'erreur suivi de « (détail masqué) ». */
const GRPC = ['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
function msgSur(e) {
  const brut = (e && typeof e === 'object') ? String(e.message == null ? '' : e.message) : String(e == null ? '' : e);
  const code = (e && typeof e === 'object') ? e.code : undefined;
  const num = (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 16) ? code
    : (/^(\d{1,2}) /.test(brut) && +brut.split(' ')[0] <= 16 ? +brut.split(' ')[0] : null);
  let statut = null;
  const tete = /^(?:\d{1,2} )?([A-Z_]+)/.exec(brut);
  if (tete && GRPC.indexOf(tete[1]) >= 0) statut = tete[1];
  else if (typeof code === 'string' && GRPC.indexOf(code.toUpperCase().replace(/-/g, '_')) >= 0) statut = code.toUpperCase().replace(/-/g, '_');
  else if (num != null && num >= 1) statut = GRPC[num - 1];
  if (statut) return statut + (num != null ? ' (code ' + num + ')' : '');
  const nom = (e && typeof e === 'object' && ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'FirebaseError', 'GoogleError'].indexOf(e.name) >= 0) ? e.name : 'Erreur';
  return nom + ' : (détail masqué)';
}

/* Roster en tableau (FunnelCore.loadTeamMembers rend déjà un tableau). */
function listeEquipe(team) {
  return Array.isArray(team) ? team : Object.keys(team || {}).map(function (k) {
    const m = team[k];
    if (m && typeof m === 'object' && !m.slug) { const c = {}; Object.keys(m).forEach(function (f) { c[f] = m[f]; }); c.slug = k; return c; }
    return m;
  });
}

/* ANCIENNE RÈGLE — copie de FunnelCore.resoudreAvec avant la correction
   (identifiant == slug D'ABORD, puis compte relié ; à compte égal, le
   premier membre du roster). Codée ici pour ne pas suivre la correction. */
function resoudreAncienne(persons, team) {
  const bySlug = {}, byUid = {};
  listeEquipe(team).forEach(function (m) {
    if (!m || !m.slug) return;
    bySlug[m.slug] = m;
    if (m.firebaseUid && !byUid[m.firebaseUid]) byUid[m.firebaseUid] = m;
  });
  const P = persons || {};
  return function (personId) {
    if (!personId) return null;
    if (bySlug[personId]) return personId;
    const p = P[personId];
    const m = p && p.firebaseUid ? byUid[p.firebaseUid] : null;
    return m ? m.slug : null;
  };
}

/* NOUVELLE RÈGLE — repli LOCAL, transcription ligne à ligne de
   StatsCore.resoudreHote (stats-core.js du 27/11/2026), utilisée seulement si
   stats-core.js ne la fournit pas, et comparée à elle sinon (ecartsCopieLocale) :
   compte relié D'ABORD (firebaseUid, ou uid, du membre ; à compte égal :
   membre en place avant ancien membre, puis le plus petit order — absent =
   999 —, puis le slug), puis identifiant == slug, sinon null. */
function resoudreNouvelleLocale(persons, team) {
  const bySlug = {}, byUid = {};
  let list = [];
  if (Array.isArray(team)) list = team;
  else if (team && typeof team === 'object') {
    Object.keys(team).forEach(function (k) {
      const m = team[k];
      if (!m || typeof m !== 'object') return;
      if (m.slug) { list.push(m); return; }
      const c = { slug: k };
      Object.keys(m).forEach(function (f) { if (f !== 'slug') c[f] = m[f]; });
      list.push(c);
    });
  }
  function rangHote(m) {
    return { parti: SC.estParti(m, m.slug), order: Number(m.order) || 999, slug: String(m.slug) };
  }
  function prime(a, b) {
    const ra = rangHote(a), rb = rangHote(b);
    if (ra.parti !== rb.parti) return !ra.parti;
    if (ra.order !== rb.order) return ra.order < rb.order;
    return ra.slug < rb.slug;
  }
  list.forEach(function (m) {
    if (!m || typeof m !== 'object' || !m.slug) return;
    if (!bySlug[m.slug]) bySlug[m.slug] = m;
    const uid = m.firebaseUid || m.uid || null;
    if (uid && (!byUid[uid] || prime(m, byUid[uid]))) byUid[uid] = m;
  });
  const P = persons || {};
  return function (personId) {
    if (!personId) return null;
    const p = Object.prototype.hasOwnProperty.call(P, personId) ? P[personId] : null;
    const m = p && p.firebaseUid ? byUid[p.firebaseUid] : null;
    if (m) return m.slug;
    if (Object.prototype.hasOwnProperty.call(bySlug, personId)) return String(personId);
    return null;
  };
}
function regleNouvelle() {
  return typeof SC.resoudreHote === 'function' ? 'StatsCore.resoudreHote' : 'copie locale';
}
function resoudreNouvelle(persons, team) {
  return typeof SC.resoudreHote === 'function' ? SC.resoudreHote(persons, team) : resoudreNouvelleLocale(persons, team);
}

/* Contexte commun : équipe, fiches d'agenda, (types). Une lecture en échec
   est une erreur franche : sans équipe ni fiches, la comparaison ne veut
   rien dire. */
async function contexte(avecTypes) {
  const DATA = {};
  const prom = [Core.loadTeamMembers(db), Core.loadPersons(db, DATA)];
  if (avecTypes) prom.push(Core.loadTypeMap(db));
  const r = await Promise.all(prom);
  const team = r[0] || [];
  if (team._erreur) return { erreur: 'équipe illisible' };
  if (!team.length) return { erreur: 'équipe vide (_meta/team_members absent ou sans membres)' };
  if (DATA.personsError) return { erreur: 'fiches d\'agenda illisibles' };
  const typeMap = avecTypes ? (r[2] || {}) : {};
  const bySlug = {};
  team.forEach(function (m) { if (m && m.slug) bySlug[m.slug] = m; });
  function parti(slug) { return !!slug && SC.estParti(bySlug[slug] || null, slug); }
  function prenom(slug) {
    const m = bySlug[slug];
    return m ? String(m.shortName || m.displayName || m.fullName || slug) : null;
  }
  /* Onglets de la vue closer — mêmes règles que api/_aiTools.js. */
  const ROLES_CLOSER = { closer: 1, closer_setter: 1 };
  const ongletCloser = {};
  team.forEach(function (m) {
    if (m && m.slug && !parti(m.slug) && m.active !== false && ROLES_CLOSER[m.role]) ongletCloser[m.slug] = 1;
  });
  function debut(slug) {
    const v = bySlug[slug] && bySlug[slug].startDate;
    return (typeof v === 'string' && RE_JOUR.test(v)) ? v : null;
  }
  /* Ligne d'un slug dans la vue closer (StatsCore.rangPersonne, options de
     api/_aiTools.js) : prénom du membre, « Anciens membres », ou
     « Non attribué » (avec sa précision quand elle nomme un membre). */
  function ligne(slug, jourIso) {
    const s = slug && (bySlug[slug] || parti(slug)) ? slug : null;
    const rg = SC.rangPersonne(s, jourIso || null, {
      parti: parti,
      aOnglet: function (x) { return !!ongletCloser[x]; },
      prenom: prenom,
      debut: debut,
    });
    if (rg.key !== SC.NON_ATTRIBUE) return prenom(rg.key) || 'Non attribué';
    if (rg.cas === 'ancien') return 'Anciens membres';
    return rg.precision ? 'Non attribué · ' + rg.precision : 'Non attribué';
  }
  return {
    team: team, persons: DATA.persons || {}, typeMap: typeMap, bySlug: bySlug, parti: parti, prenom: prenom,
    ongletCloser: ongletCloser, ligne: ligne,
    ancienne: resoudreAncienne(DATA.persons || {}, team),
    nouvelle: resoudreNouvelle(DATA.persons || {}, team),
    locale: resoudreNouvelleLocale(DATA.persons || {}, team),
  };
}

/* Contrôle : la nouvelle règle de stats-core.js et la copie locale donnent
   le même membre pour chaque fiche d'agenda (et chaque slug du roster). */
function ecartsCopie(C) {
  if (typeof SC.resoudreHote !== 'function') return null;
  const ids = Object.keys(C.persons).concat(C.team.map(function (m) { return m && m.slug; }).filter(Boolean));
  const out = [];
  ids.forEach(function (id) {
    const a = C.nouvelle(id), b = C.locale(id);
    if (a !== b) out.push({ id: C.persons[id] || C.bySlug[id] ? id : '(autre)', statsCore: a || null, copieLocale: b || null });
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   JOB roster
   ══════════════════════════════════════════════════════════════════ */
async function jobRoster() {
  const C = await contexte(false);
  if (C.erreur) return { code: 503, corps: { ok: false, erreur: C.erreur } };
  const membres = C.team.filter(function (m) { return m && m.slug; }).map(function (m) {
    return {
      slug: String(m.slug), prenom: C.prenom(m.slug), role: m.role == null ? null : String(m.role),
      active: m.active === undefined ? null : m.active !== false, departed: m.departed === true,
      parti: C.parti(m.slug), aUnCompte: !!(m.firebaseUid || m.uid),
      startDate: typeof m.startDate === 'string' ? m.startDate : null,
      order: typeof m.order === 'number' ? m.order : null,
      ongletCloser: !!C.ongletCloser[m.slug],
    };
  });
  const parUid = {};
  C.team.forEach(function (m) { const u = m && (m.firebaseUid || m.uid); if (m && m.slug && u) (parUid[u] = parUid[u] || []).push(String(m.slug)); });
  const fiches = Object.keys(C.persons).sort().map(function (id) {
    const p = C.persons[id] || {};
    return {
      id: id, aUnCompte: !!p.firebaseUid,
      compteDe: p.firebaseUid ? (parUid[p.firebaseUid] || []) : [],
      identifiantEstUnMembre: !!C.bySlug[id] || SC.estPartiHistorique(id),
      resoutVers: { ancienne: C.ancienne(id), nouvelle: C.nouvelle(id) },
    };
  });
  const reprises = fiches.filter(function (f) {
    return C.bySlug[f.id] && f.compteDe.length && f.compteDe.indexOf(f.id) < 0;
  }).map(function (f) {
    return { fiche: f.id, membreDeLIdentifiant: f.id, identifiantParti: C.parti(f.id), membresDuCompte: f.compteDe,
      ancienne: f.resoutVers.ancienne, nouvelle: f.resoutVers.nouvelle };
  });
  return { code: 200, corps: {
    ok: true, mode: 'lecture', regleNouvelle: regleNouvelle(), ecartsCopieLocale: ecartsCopie(C),
    membres: membres, fiches: fiches, fichesReprises: reprises,
    changentDeResolution: fiches.filter(function (f) { return f.resoutVers.ancienne !== f.resoutVers.nouvelle; }).map(function (f) { return f.id; }),
  } };
}

/* ══════════════════════════════════════════════════════════════════
   JOB rdv
   ══════════════════════════════════════════════════════════════════ */
function jourValide(s) {
  if (typeof s !== 'string' || !RE_JOUR.test(s)) return null;
  const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const d = new Date(t);
  if (d.toISOString().slice(0, 10) !== s) return null;
  return t;
}
function voieDe(b) {
  const cd = (b && b.closeData) || {};
  if (cd.closerSlug) return 'closeData';
  if (b && b.expertSlug) return 'expertSlug';
  return 'fiche';
}
function inc(o, k, n) { o[k] = (o[k] || 0) + (n == null ? 1 : n); }

async function jobRdv(q) {
  /* Paramètres validés AVANT toute lecture. */
  const tf = jourValide(q.from), tt = jourValide(q.to);
  if (tf == null || tt == null) return { code: 400, corps: { ok: false, erreur: 'from et to : AAAA-MM-JJ (dates réelles)' } };
  if (tt < tf) return { code: 400, corps: { ok: false, erreur: 'to doit suivre from' } };
  const jours = Math.round((tt - tf) / 86400000) + 1;
  if (jours > MAX_JOURS) return { code: 400, corps: { ok: false, erreur: 'plage limitée à ' + MAX_JOURS + ' jours' } };

  const C = await contexte(true);
  if (C.erreur) return { code: 503, corps: { ok: false, erreur: C.erreur } };
  const avert = [];
  if (!Object.keys(C.typeMap).length) avert.push('table des types de RDV vide ou illisible : la classe Self Booking / Setting peut être fausse');
  if (!Object.keys(C.persons).length) avert.push('aucune fiche d\'agenda : l\'hôte d\'un RDV ne peut pas être résolu');

  const qr = db.collection('bookings').where('date', '>=', q.from).where('date', '<=', q.to);
  const snap = await qr.select.apply(qr, CHAMPS_RDV).limit(MAX_RDV + 1).get();
  const docs = [];
  snap.forEach(function (d) { docs.push(d); });
  const tronque = docs.length > MAX_RDV;
  if (tronque) { docs.length = MAX_RDV; avert.push('plus de ' + MAX_RDV + ' RDV : lecture tronquée, réduire la plage'); }

  const now = Date.now();
  const mois = {}, fiches = {};
  const hors = { lus: docs.length, horsVente: 0, replanifies: 0, doublons: 0, sansDate: 0, dateNonConforme: 0 };
  const total = { rdv: 0, changent: 0 };
  const detailTotal = {};
  docs.forEach(function (doc) {
    const b = doc.data() || {};
    /* Comme les écrans (api/_aiTools.js) : toute date TEXTE ramenée par la
       requête compte, rangée au mois de ses 7 premiers caractères ; seules
       les dates qui ne sont pas du texte sont écartées. Une date texte non
       réduite à AAAA-MM-JJ est comptée et signalée (lecture.dateNonConforme). */
    if (typeof b.date !== 'string' || !RE_MOIS_DEBUT.test(b.date)) { hors.sansDate++; return; }
    if (!RE_JOUR.test(b.date)) hors.dateNonConforme++;
    const cls = SC.classifyBooking(b, C.typeMap);
    if (!SC.estRdvVente(cls)) { hors.horsVente++; return; }
    const e = SC.etat(b, now);
    if (e === 'doublon') { hors.doublons++; return; }
    if (e === 'replanifie') { hors.replanifies++; return; }

    const m = b.date.slice(0, 7);
    const M = mois[m] || (mois[m] = { rdv: 0, ancienne: {}, nouvelle: {}, changent: 0, detail: {} });
    const sA = SC.closerDuRdv(b, C.ancienne), sN = SC.closerDuRdv(b, C.nouvelle);
    const lA = C.ligne(sA, b.date), lN = C.ligne(sN, b.date);
    M.rdv++; total.rdv++;
    inc(M.ancienne, lA); inc(M.nouvelle, lN);
    if (lA !== lN) {
      M.changent++; total.changent++;
      const k = lA + '\u0000' + lN;
      [M.detail, detailTotal].forEach(function (D) {
        const g = D[k] || (D[k] = { de: lA, vers: lN, n: 0, parVoie: { closeData: 0, expertSlug: 0, fiche: 0 } });
        g.n++; g.parVoie[voieDe(b)]++;
      });
    }

    /* Fiche d'agenda × expertSlug × closeData.closerSlug */
    const pid = b.personId ? (Object.prototype.hasOwnProperty.call(C.persons, b.personId) ? String(b.personId) : '(autre)') : '(aucune)';
    const combo = (b.expertSlug ? 'expertSlug' : 'sansExpertSlug') + '+' + ((b.closeData || {}).closerSlug ? 'closerSlug' : 'sansCloserSlug');
    const F = fiches[pid] || (fiches[pid] = { total: 0, combos: {}, parMois: {} });
    F.total++; inc(F.combos, combo);
    const FM = F.parMois[m] || (F.parMois[m] = {});
    inc(FM, combo);
  });

  if (hors.sansDate) avert.push(hors.sansDate + ' RDV sans date texte écartés (ni comptés par les écrans)');
  if (hors.dateNonConforme) avert.push(hors.dateNonConforme + ' RDV à date texte non réduite à AAAA-MM-JJ : comptés comme le font les écrans');
  function trierDetail(D) {
    return Object.keys(D).map(function (k) { return D[k]; }).sort(function (a, b) { return b.n - a.n || (a.de < b.de ? -1 : 1); });
  }
  const parMois = {};
  Object.keys(mois).sort().forEach(function (k) {
    const M = mois[k];
    parMois[k] = { rdv: M.rdv, ancienne: M.ancienne, nouvelle: M.nouvelle, changent: M.changent, detail: trierDetail(M.detail) };
  });
  return { code: 200, corps: {
    ok: true, mode: 'lecture', plage: { from: q.from, to: q.to, jours: jours }, regleNouvelle: regleNouvelle(),
    ecartsCopieLocale: ecartsCopie(C), avertissements: avert, tronque: tronque, lecture: hors,
    total: { rdv: total.rdv, changent: total.changent, detail: trierDetail(detailTotal) },
    parMois: parMois, parFiche: fiches,
  } };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  try {
    let r;
    if (q.job === 'roster') r = await jobRoster();
    else if (q.job === 'rdv') r = await jobRdv(q);
    else r = { code: 400, corps: { ok: false, erreur: 'job=roster ou job=rdv&from=AAAA-MM-JJ&to=AAAA-MM-JJ' } };
    res.status(r.code).json(r.corps);
  } catch (e) {
    res.status(500).json({ ok: false, erreur: msgSur(e) });
  }
};
module.exports.config = { maxDuration: 60 };
module.exports._test = { resoudreAncienne: resoudreAncienne, resoudreNouvelleLocale: resoudreNouvelleLocale, msgSur: msgSur, jourValide: jourValide };
