// ============================================================================
// api/reprise-donnees.js — REPRISES DE DONNÉES (25/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE, À RETIRER. N'existe que sur la branche de travail (preview
// Vercel), jamais sur `main`. Même structure et même contrôle de clé que
// l'ancienne route d'audit (git show 2cd45b9:api/stats-audit.js).
//
// Accès : variable Vercel REPRISE_KEY (24 caractères au moins, preview de la
// branche seulement), en-tête `x-reprise-key` ou paramètre `k`. Absente ou
// fausse → 404 sans corps. GET seulement. Cache-Control: no-store.
//
// AUCUNE DONNÉE PERSONNELLE EN SORTIE : ni nom, ni e-mail, ni téléphone, ni
// note — des comptes, des dates, des montants, des identifiants de fiche et
// des empreintes.
//
// JOB 1 — ?job=clientsince  (À BLANC par défaut : n'écrit rien)
//   leads.clientSince écrit en TEXTE par d'anciennes pages CSM
//   (csm-clients.html, csm-diagnostic.html : `co.dateEntree`) au lieu d'un
//   Timestamp. Un filtre d'inégalité Firestore ne compare qu'un même type :
//   ces fiches sont invisibles de FunnelCore.loadClosedLeads (requête par
//   date) donc absentes des closes.
//     ?job=clientsince                 liste et décompte (lecture seule)
//     ?job=clientsince&mois=AAAA-MM    simulation sur un mois avec le VRAI
//                                      moteur (funnel-core.js) : avant / après
//     ?job=clientsince&apply=1&confirm=CONVERTIR&attendu=N
//                                      écriture (N = nombre de fiches
//                                      convertibles annoncé par la lecture)
//   Écriture : UNIQUEMENT clientSince (Timestamp), clientSinceTexte (valeur
//   d'origine gardée, rien n'est perdu) et clientSinceConvertiLe. Aucun autre
//   champ (pas d'updatedAt). Trace : reprise_client_since_log/{id}, son
//   compteur `ecrit` mis à jour après chaque lot (un MINIMUM : la relecture à
//   blanc fait foi). L'instant vient de LA règle unique StatsCore.dateTexteMs
//   (stats-core.js, celle des pages) ; une date-heure ISO n'est convertie que
//   si « T » (ou une espace) et « Z » sont en majuscules et que la contre-
//   lecture par FunnelCore.parseFlexMs donne la même seconde ; sinon
//   « illisible », jamais écrite.
//   Une fiche qui porte DÉJÀ clientSinceTexte (reprise une fois, puis remise
//   en texte par une ancienne page) est classée 'deja_reprise' : jamais
//   écrite (la valeur d'origine serait perdue), comptée (dejaReprises) et
//   listée à part, pour décision.
//   Simulation : les fiches ajoutées sont triées comme Firestore trie une
//   inégalité (clientSince puis identifiant) avant la coupe au plafond.
//   La simulation liste nouveauxCloses, closesDisparus, sourceChangee et
//   closesModifies (fiche présente avant ET après dont le jour, le signal, le
//   contracté ou le collecté change : { leadId, avant, apres, aConvertir }).
//   Déclencheurs onUpdate de leads/{leadId} vérifiés (les trois existants) :
//   • onLeadNoteMentionNotify (index.js) : ne réagit qu'à un ajout dans
//     notesHistory ;
//   • resurrectLeadOnReengagement (index.js) : qu'à un ajout dans
//     communications ou à un nouveau lastOptinAt sur un doublon fusionné ;
//   • onLeadUpdate (Functions/_sync.js, exporté par index.js) : isClient
//     inchangé (pas de création de persons) et clientSince hors de
//     TO_HUB_MAPPING.leads → propagateToHub sort sans lire ni écrire.
//   onNewLead / normalizeLeadCreatedAt sont des onCreate. Une mise à jour de
//   ces trois champs ne déclenche donc aucune écriture ni aucun envoi.
//
// JOB 2 — ?job=commissions&uids=a,b  (lecture seule)
//   commissions/{uid}/mois/* → lignes réduites à leur empreinte
//   h = sha256(email.toLowerCase().trim()|type|subtype|date) sur 16 caractères
//   hexadécimaux, pour comparer la base au code sans sortir un nom. Par mois :
//   aDeals (!!deals, la règle de la page : vrai ⇒ la base l'emportait déjà sur
//   les lignes en dur), estTableau, moisPage (mois lu par la page, AAAA-MM).
//
// JOB 3 — ?job=etat[&h=e1,e2,…]  (lecture seule)
//   Contrôles avant de ne plus servir d'anciens fichiers.
//   • retargeting : { migre (le document _meta/retargeting_migrated existe),
//     leadsWb (fiches leads dont l'identifiant commence par 'wb_' : plage sur
//     l'identifiant, agrégat count(), repli select() sans champ), methode }.
//   • noms (seulement avec h = 1 à 200 empreintes de 16 hex, sinon 400) :
//     empreinte d'un nom = 16 premiers hex de sha256 du nom en minuscules,
//     sans accents (NFD), tout hors a-z 0-9 → espace, mots triés, joints par
//     une espace. Calculée pour chaque fiche leads isClient == true et chaque
//     document clients, sur nom, name, nomComplet, fullName, leadName,
//     clientName, prenom + nom, prenom + name, firstName + lastName (lecture
//     restreinte à ces champs par select). Rend { demandes, trouves,
//     absents: [empreintes demandées non trouvées], parCollection, lus } —
//     jamais un nom.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const Core = require('../funnel-core.js');

const LOT = 400;                 /* écritures par lot (limite Firestore : 500) */
const LOG_COLLECTION = 'reprise_client_since_log';

function keyOk(req) {
  const want = String(process.env.REPRISE_KEY || '');
  const q = req.query || {};
  const brut = (req.headers && req.headers['x-reprise-key']) || q.k || '';
  /* Un texte seulement : un tableau (k répété, ou [k] seul) n'est jamais une
     clé (String([k]) === k l'aurait laissé passer). */
  if (typeof brut !== 'string') return false;
  const got = brut;
  /* Longueur comparée en OCTETS (timingSafeEqual lève sinon : une clé de la
     bonne longueur en caractères mais accentuée donnait un 500). */
  try {
    const a = Buffer.from(got, 'utf8'), b = Buffer.from(want, 'utf8');
    if (b.length < 24 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ══════════════════════════════════════════════════════════════════
   JOB 1 — clientSince en texte
   ══════════════════════════════════════════════════════════════════ */

/* Valeur d'origine → { format, ms }  (ms = null : jamais convertie)
   L'INSTANT vient de LA règle unique StatsCore.dateTexteMs (stats-core.js,
   celle des pages) : aucun calcul local ici. La route ne fait que classer le
   texte (pour le décompte) et, pour une date-heure, contre-lire.
     'jour'      AAAA-MM-JJ        → midi UTC+1 de ce jour (même jour à Paris
                                     en hiver comme en été)
     'fr'        JJ/MM/AAAA        → idem
     'iso'       date-heure ISO    → l'instant (fuseau écrit lu tel quel ;
                                     sans fuseau = heure de Paris)
     'vide'      chaîne vide       → rien
     'illisible' tout autre texte  → rien, signalé (jour impossible, heure
                                     hors bornes, « t » / « z » minuscules…)
     'nombre'    nombre            → rien, signalé (jour indicatif seulement) */
const RE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
const RE_FR = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const RE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
function msValide(ms) { return ms != null && isFinite(ms) && isFinite(new Date(ms).getTime()); }
function analyser(v) {
  if (typeof v === 'number') {
    const msN = Core.parseFlexMs(v);
    /* Nombre hors des bornes de Date (> 8,64e15 ms…) : pas de jour indicatif,
       sinon SC.jourParis lève « Invalid time value » et toute la lecture échoue. */
    return { format: 'nombre', ms: null, msIndicatif: msValide(msN) ? msN : null };
  }
  if (typeof v !== 'string') return { format: 'illisible', ms: null };
  const s = v.trim();
  if (!s) return { format: 'vide', ms: null };
  let format = null;
  if (RE_JOUR.test(s)) format = 'jour';
  else if (RE_FR.test(s)) format = 'fr';
  else if (RE_ISO.test(s)) format = 'iso';
  if (!format) return { format: 'illisible', ms: null };
  const ms = SC.dateTexteMs(s);
  if (!msValide(ms)) return { format: 'illisible', ms: null };
  if (format === 'iso') {
    /* Contre-lecture indépendante (FunnelCore.parseFlexMs, autre code) : tout
       désaccord, à la seconde près, classe la valeur « illisible » plutôt que
       d'écrire un instant douteux. (parseFlexMs ignore la fraction de seconde
       d'une heure sans fuseau : d'où la comparaison à la seconde.) */
    const msI = Core.parseFlexMs(s);
    if (!msValide(msI) || Math.floor(msI / 1000) !== Math.floor(ms / 1000)) return { format: 'illisible', ms: null };
  }
  return { format: format, ms: ms };
}

/* Fiches dont clientSince n'est PAS un Timestamp : les TEXTES (>= '') et les
   NOMBRES (>= -MAX). Un même document ne peut sortir des deux requêtes. */
async function lireNonTimestamp() {
  const out = [];
  const textes = await db.collection('leads').where('clientSince', '>=', '').get();
  textes.forEach(function (doc) { out.push(doc); });
  const nombres = await db.collection('leads').where('clientSince', '>=', -Number.MAX_VALUE).get();
  nombres.forEach(function (doc) { out.push(doc); });
  return out.map(function (doc) {
    const d = doc.data() || {};
    const a = analyser(d.clientSince);
    /* Fiche DÉJÀ reprise une fois (clientSinceTexte présent) puis réécrite en
       texte (ancien onglet CSM resté ouvert…) : jamais réécrite d'office, sinon
       la valeur d'origine gardée dans clientSinceTexte serait perdue. Comptée
       et listée à part (format 'deja_reprise', formatTexte = lecture du texte
       actuel) pour décision. */
    if (Object.prototype.hasOwnProperty.call(d, 'clientSinceTexte')) {
      const ind = a.ms != null ? a.ms : (a.msIndicatif == null ? null : a.msIndicatif);
      return {
        id: doc.id, doc: doc, data: d, avant: d.clientSince,
        format: 'deja_reprise', formatTexte: a.format, ms: null, msIndicatif: ind
      };
    }
    return {
      id: doc.id, doc: doc, data: d, avant: d.clientSince,
      format: a.format, ms: a.ms, msIndicatif: a.msIndicatif == null ? null : a.msIndicatif
    };
  });
}

function strOuNull(v) { return (typeof v === 'string' && v) ? v.slice(0, 60) : (v == null ? null : String(v).slice(0, 60)); }

/* Décompte et liste — rien de personnel : identifiant, jour, format, étape,
   drapeaux, source technique. */
function resume(list) {
  const out = {
    total: list.length, convertibles: 0, parFormat: {}, parMois: {}, parSource: {},
    fusionnees: 0, dejaIsClient: 0, nombres: 0, illisibles: 0, vides: 0, dejaReprises: 0, fiches: []
  };
  list.forEach(function (f) {
    out.parFormat[f.format] = (out.parFormat[f.format] || 0) + 1;
    const src = f.data.source == null ? '(aucune)' : String(f.data.source).slice(0, 60);
    out.parSource[src] = (out.parSource[src] || 0) + 1;
    if (f.data._merged === true) out.fusionnees++;
    if (f.data.isClient === true) out.dejaIsClient++;
    if (f.format === 'nombre') out.nombres++;
    if (f.format === 'illisible') out.illisibles++;
    if (f.format === 'vide') out.vides++;
    if (f.format === 'deja_reprise') out.dejaReprises++;
    let jour = null;
    if (f.ms != null) {
      out.convertibles++;
      jour = SC.jourParis(new Date(f.ms));
      const mois = jour.slice(0, 7);
      out.parMois[mois] = (out.parMois[mois] || 0) + 1;
    } else if (f.msIndicatif != null) {
      jour = SC.jourParis(new Date(f.msIndicatif));
    }
    out.fiches.push({
      leadId: f.id, jour: jour, format: f.format, convertible: f.ms != null,
      formatTexte: f.formatTexte || null,
      fusionnee: f.data._merged === true, stage: strOuNull(f.data.stage),
      isClient: f.data.isClient === true, source: strOuNull(f.data.source)
    });
  });
  out.fiches.sort(function (a, b) { return String(a.jour || '9999') < String(b.jour || '9999') ? -1 : String(a.jour || '9999') > String(b.jour || '9999') ? 1 : 0; });
  return out;
}

/* ── Simulation d'un mois : db ENVELOPPÉ ─────────────────────────────
   Tout passe tel quel, sauf la collection leads :
   • la requête de loadClosedLeads (clientSince >= début, <= fin, limit)
     reçoit en plus les fiches à convertir dont la date convertie tombe dans
     l'intervalle, clientSince remplacé par le Timestamp converti ;
   • toute autre lecture de fiche (doc(id).get(), where('email'…)) rend la
     fiche telle qu'elle sera APRÈS conversion (même Timestamp), pour que la
     résolution des paiements voie le même état. */
function fauxDoc(id, data, ref) {
  return { id: id, exists: true, ref: ref || null, data: function () { return Object.assign({}, data); } };
}
function snapDe(docs) {
  return { size: docs.length, empty: docs.length === 0, docs: docs, forEach: function (fn) { docs.forEach(fn); } };
}
function enveloppe(realDb, conv) {
  /* conv : { leadId: { ts, data } } */
  function convertirDoc(doc) {
    if (!doc || !doc.exists || !conv[doc.id]) return doc;
    const d = Object.assign({}, doc.data() || {}, { clientSince: conv[doc.id].ts });
    return fauxDoc(doc.id, d, doc.ref);
  }
  function convertirSnap(snap) {
    const docs = [];
    snap.forEach(function (doc) { docs.push(convertirDoc(doc)); });
    return snapDe(docs);
  }
  function Requete(q, filtres, lim) {
    this._q = q; this._f = filtres || []; this._lim = lim;
  }
  Requete.prototype.where = function (a, op, v) { return new Requete(this._q.where(a, op, v), this._f.concat([[a, op, v]]), this._lim); };
  Requete.prototype.orderBy = function (a, dir) { return new Requete(this._q.orderBy(a, dir), this._f, this._lim); };
  Requete.prototype.limit = function (n) { return new Requete(this._q.limit(n), this._f, n); };
  Requete.prototype.select = function () { return new Requete(this._q.select.apply(this._q, arguments), this._f, this._lim); };
  Requete.prototype.startAfter = function (x) { return new Requete(this._q.startAfter(x), this._f, this._lim); };
  Requete.prototype.doc = function (id) {
    const ref = this._q.doc(id);
    return { id: id, get: function () { return ref.get().then(convertirDoc); }, collection: function (n) { return ref.collection(n); } };
  };
  Requete.prototype.get = function () {
    const f = this._f, lim = this._lim;
    const borneBasse = f.length === 2 && f[0][0] === 'clientSince' && f[0][1] === '>=' && f[1][0] === 'clientSince' && f[1][1] === '<=';
    return this._q.get().then(function (snap) {
      const s = convertirSnap(snap);
      if (!borneBasse) return s;
      const lo = Core.parseFlexMs(f[0][2]), hi = Core.parseFlexMs(f[1][2]);
      const dejaLa = {};
      s.docs.forEach(function (d) { dejaLa[d.id] = 1; });
      const ajout = [];
      Object.keys(conv).forEach(function (id) {
        if (dejaLa[id]) return;
        const c = conv[id];
        if (c.ms < lo || c.ms > hi) return;
        ajout.push(fauxDoc(id, Object.assign({}, c.data, { clientSince: c.ts })));
      });
      let docs = s.docs.concat(ajout);
      /* Ordre de Firestore pour une inégalité : clientSince croissant, puis
         identifiant. Il compte : buildCloses donne un paiement partagé
         (même e-mail / téléphone) à la PREMIÈRE fiche gagnée de la liste,
         et la coupe au plafond garde les premières. Sans ce tri, l'« après »
         simulé pouvait différer de ce que rendra la base convertie. */
      docs.sort(function (a, b) {
        const ma = Core.parseFlexMs(a.data().clientSince), mb = Core.parseFlexMs(b.data().clientSince);
        return ma !== mb ? ma - mb : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      if (lim != null && docs.length > lim) docs = docs.slice(0, lim);
      return snapDe(docs);
    });
  };
  return {
    collection: function (name) {
      const q = realDb.collection(name);
      return name === 'leads' ? new Requete(q, [], null) : q;
    },
    batch: function () { throw new Error('simulation : aucune écriture'); },
    runTransaction: function () { throw new Error('simulation : aucune écriture'); }
  };
}

function totaux(res) {
  const t = Core.sumCloses(res.rows || []);
  return { closes: t.closes, contracte: r2(t.con), collecte: r2(t.paid), sansSignal: (res.sansSignal || []).length, erreur: res.erreur || null, tronque: !!res.tronque };
}

async function simuler(list, moisTxt) {
  const p = moisTxt.split('-');
  const P = Core.periodMonth(+p[0], +p[1] - 1);
  const typeMap = await Core.loadTypeMap(db);
  const conv = {};
  list.forEach(function (f) {
    if (f.ms == null) return;
    conv[f.id] = { ms: f.ms, ts: admin.firestore.Timestamp.fromMillis(f.ms), data: f.data };
  });
  const avant = await Core.loadCloses(db, { start: P.start, end: P.end, typeMap: typeMap });
  const apres = await Core.loadCloses(enveloppe(db, conv), { start: P.start, end: P.end, typeMap: typeMap });

  /* Lignes par fiche (les closes sans fiche — RDV ou paiement seuls — ne sont
     comptés que dans les totaux : leur clé porterait un e-mail). */
  function parFiche(rows) { const o = {}; (rows || []).forEach(function (r) { if (r && r.leadId) o[r.leadId] = r; }); return o; }
  const A = parFiche(avant.rows), B = parFiche(apres.rows);
  function etat(r) { return { jour: r.day || null, src: r.src, signal: r.signal || null, contracte: r2(r.rv && r.rv.con), collecte: r2(r.rv && r.rv.paid) }; }
  const nouveauxCloses = [], sourceChangee = [], disparus = [], closesModifies = [];
  Object.keys(B).forEach(function (id) {
    const r = B[id];
    const ligne = Object.assign({ leadId: id }, etat(r), { aConvertir: !!conv[id] });
    if (!A[id]) { nouveauxCloses.push(ligne); return; }
    if (A[id].src !== r.src) sourceChangee.push(Object.assign({}, ligne, { srcAvant: A[id].src }));
    /* Fiche présente avant ET après dont le chiffre bouge (ex. paiement
       partagé par e-mail qui passe d'une fiche à une autre) : sourceChangee
       ne le voyait pas quand la source restait la même. */
    const ea = etat(A[id]), eb = etat(r);
    if (ea.jour !== eb.jour || ea.signal !== eb.signal || ea.contracte !== eb.contracte || ea.collecte !== eb.collecte) {
      closesModifies.push({ leadId: id, avant: ea, apres: eb, aConvertir: !!conv[id] });
    }
  });
  Object.keys(A).forEach(function (id) { if (!B[id]) disparus.push({ leadId: id, src: A[id].src }); });
  const sA = {};
  (avant.sansSignal || []).forEach(function (x) { if (x.leadId) sA[x.leadId] = 1; });
  const nouvellesSansVente = (apres.sansSignal || []).filter(function (x) { return x.leadId && !sA[x.leadId]; })
    .map(function (x) { return { leadId: x.leadId, jour: x.day || null, stage: strOuNull(x.stage), aConvertir: !!conv[x.leadId] }; });
  const dansLeMois = Object.keys(conv).filter(function (id) { const ms = conv[id].ms; return ms >= P.start.getTime() && ms <= P.end.getTime(); });
  return {
    mois: moisTxt, periode: { du: SC.jourParis(P.start), au: SC.jourParis(P.end) },
    fichesConvertiesDansLeMois: dansLeMois.length,
    avant: totaux(avant), apres: totaux(apres),
    ecart: {
      closes: totaux(apres).closes - totaux(avant).closes,
      contracte: r2(totaux(apres).contracte - totaux(avant).contracte),
      collecte: r2(totaux(apres).collecte - totaux(avant).collecte)
    },
    nouveauxCloses: nouveauxCloses, sourceChangee: sourceChangee, closesModifies: closesModifies, closesDisparus: disparus,
    nouvellesFichesSansVente: nouvellesSansVente
  };
}

/* ── Écriture ─────────────────────────────────────────────────────── */
async function appliquer(list, attendu) {
  const aEcrire = list.filter(function (f) { return f.ms != null; });
  if (aEcrire.length !== attendu) {
    return { code: 409, corps: { ok: false, erreur: 'nombre de fiches convertibles différent de attendu : rien n\'est écrit', convertibles: aEcrire.length, attendu: attendu } };
  }
  if (!aEcrire.length) return { code: 200, corps: { ok: true, ecrit: 0, trace: null, note: 'rien à convertir' } };
  /* La trace tient dans UN document (1 Mo) : au-delà de 5 000 fiches, refus. */
  if (aEcrire.length > 5000) return { code: 413, corps: { ok: false, erreur: 'plus de 5 000 fiches : trace trop grosse pour un document, rien n\'est écrit', convertibles: aEcrire.length } };

  const now = new Date();
  const idTrace = 'cs_' + now.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z_' + crypto.randomBytes(3).toString('hex');
  const traceRef = db.collection(LOG_COLLECTION).doc(idTrace);
  const fichesTrace = aEcrire.map(function (f) { return { leadId: f.id, avant: String(f.avant), apres: new Date(f.ms).toISOString() }; });
  /* Trace d'abord (état en cours) : un passage interrompu reste visible. */
  await traceRef.set({
    at: admin.firestore.FieldValue.serverTimestamp(), mode: 'apply', etat: 'en_cours',
    total: aEcrire.length, ecrit: 0, fiches: fichesTrace
  });

  /* « ecrit » est un MINIMUM : un commit en échec réseau (DEADLINE_EXCEEDED)
     peut avoir été appliqué côté Firestore, et Vercel peut couper la fonction
     entre deux lots. La vérité est donnée par une nouvelle lecture à blanc
     (une fiche convertie n'y figure plus). */
  let ecrit = 0;
  try {
    for (let i = 0; i < aEcrire.length; i += LOT) {
      const batch = db.batch();
      aEcrire.slice(i, i + LOT).forEach(function (f) {
        const data = {
          clientSince: admin.firestore.Timestamp.fromMillis(f.ms),
          clientSinceTexte: f.avant,
          clientSinceConvertiLe: admin.firestore.FieldValue.serverTimestamp()
        };
        /* Précondition : la fiche n'a pas changé depuis la lecture (sinon le
           lot échoue en entier, rien n'est écrit pour ce lot). */
        if (f.doc && f.doc.updateTime) batch.update(f.doc.ref, data, { lastUpdateTime: f.doc.updateTime });
        else batch.update(f.doc.ref, data);
      });
      await batch.commit();
      ecrit += Math.min(LOT, aEcrire.length - i);
      /* Trace tenue à jour après CHAQUE lot (une coupure Vercel ne la laisse
         plus à 0). Un échec ici n'arrête pas les lots suivants. */
      try { await traceRef.update({ ecrit: ecrit, ecritEstUnMinimum: true }); } catch (eT) { /* trace en retard, la relecture à blanc fait foi */ }
    }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    let traceOk = true;
    try {
      await traceRef.update({ etat: 'interrompu', ecrit: ecrit, ecritEstUnMinimum: true, erreur: msg, finLe: admin.firestore.FieldValue.serverTimestamp() });
    } catch (eT) { traceOk = false; }
    return { code: 500, corps: { ok: false, erreur: 'écriture interrompue : ' + msg + ' (relancer la lecture à blanc, puis apply avec le nouveau nombre)', ecrit: ecrit, ecritEstUnMinimum: true, trace: idTrace, traceAJour: traceOk } };
  }
  let traceFinOk = true;
  try {
    await traceRef.update({ etat: 'termine', ecrit: ecrit, ecritEstUnMinimum: false, finLe: admin.firestore.FieldValue.serverTimestamp() });
  } catch (eT) { traceFinOk = false; }
  return { code: 200, corps: { ok: true, ecrit: ecrit, trace: idTrace, traceAJour: traceFinOk } };
}

async function jobClientSince(q) {
  const list = await lireNonTimestamp();
  if (q.apply != null && String(q.apply) === '1') {
    /* Des TEXTES exactement (un tableau [x] donnerait String([x]) === x). */
    if (typeof q.apply !== 'string' || q.confirm !== 'CONVERTIR' || typeof q.attendu !== 'string' || !/^\d+$/.test(q.attendu)) {
      return { code: 400, corps: { ok: false, erreur: 'apply exige confirm=CONVERTIR et attendu=N (nombre de fiches convertibles) : rien n\'est écrit' } };
    }
    return appliquer(list, parseInt(q.attendu, 10));
  }
  if (q.mois != null) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.mois))) return { code: 400, corps: { ok: false, erreur: 'mois attendu au format AAAA-MM' } };
    return { code: 200, corps: { ok: true, mode: 'simulation', simulation: await simuler(list, String(q.mois)) } };
  }
  return { code: 200, corps: Object.assign({ ok: true, mode: 'lecture' }, resume(list)) };
}

/* ══════════════════════════════════════════════════════════════════
   JOB 2 — empreintes des lignes de commission
   ══════════════════════════════════════════════════════════════════ */
function champ(v) { return v == null ? '' : String(v); }
function empreinte(l) {
  const base = champ(l.email).toLowerCase().trim() + '|' + champ(l.type) + '|' + champ(l.subtype) + '|' + champ(l.date);
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 16);
}
function nombre(v) { const n = Number(v); return isFinite(n) ? n : null; }

async function jobCommissions(q) {
  const uids = String(q.uids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!uids.length || uids.length > 10 || uids.some(function (u) { return !/^[a-z0-9_-]{1,64}$/.test(u); })) {
    return { code: 400, corps: { ok: false, erreur: 'uids : 1 à 10 identifiants (lettres minuscules, chiffres, tiret, souligné)' } };
  }
  const out = {};
  for (const uid of uids) {
    const snap = await db.collection('commissions').doc(uid).collection('mois').get();
    const mois = {};
    snap.forEach(function (doc) {
      const d = doc.data() || {};
      const deals = Array.isArray(d.deals) ? d.deals : [];
      /* aDeals : la page (getDeals / loadAllCommFromFirestore de
         sales-commissions.html) met en cache `d.deals` dès qu'il est « vrai »
         (!!d.deals, un tableau vide compris) et ce cache l'emporte sur toute
         ligne écrite dans le code. estTableau : forme attendue (sinon la page
         échoue sur .map, avant comme après le retrait). moisPage : le mois que
         la page en déduit (_fsToM), 'AAAA-MM', null si illisible. */
      const pm = String(doc.id).split('-'), mi = parseInt(pm[1], 10);
      mois[doc.id] = {
        aDeals: !!d.deals, estTableau: Array.isArray(d.deals),
        moisPage: (pm[0] && mi >= 1 && mi <= 12) ? pm[0] + '-' + (mi < 10 ? '0' : '') + mi : null,
        nbLignes: deals.length,
        lignes: deals.map(function (l) {
          l = l || {};
          return {
            h: empreinte(l), type: l.type == null ? null : String(l.type), subtype: l.subtype == null ? null : String(l.subtype),
            date: l.date == null ? null : String(l.date),
            contracteHT: nombre(l.contracteHT), collecteHT: nombre(l.collecteHT), comm: nombre(l.comm), bonus: nombre(l.bonus),
            ok: l.ok == null ? null : !!l.ok
          };
        })
      };
    });
    out[uid] = { nbMois: Object.keys(mois).length, mois: mois };
  }
  return { code: 200, corps: { ok: true, commissions: out } };
}

/* ══════════════════════════════════════════════════════════════════
   JOB 3 — état avant de ne plus servir d'anciens fichiers (lecture seule)
   ══════════════════════════════════════════════════════════════════ */
/* Nombre de documents d'une requête : agrégat count() (firebase-admin 12,
   @google-cloud/firestore 7 : une seule lecture facturée par lot de 1 000) ;
   repli sur select() sans champ (identifiants seuls) si l'agrégat échoue. */
async function compter(q) {
  if (typeof q.count === 'function') {
    try {
      const s = await q.count().get();
      const n = s && typeof s.data === 'function' ? s.data().count : null;
      if (typeof n === 'number' && isFinite(n)) return { n: n, methode: 'count' };
    } catch (e) { /* repli ci-dessous */ }
  }
  const snap = await q.select().get();
  return { n: snap.size, methode: 'select' };
}

/* Empreinte d'un nom : 16 premiers hex de sha256 du nom normalisé —
   minuscules, accents retirés (NFD), tout caractère hors a-z 0-9 remplacé
   par une espace, mots triés, joints par une espace. « Jean DUPONT » et
   « Dupont Jean » ont la même empreinte. null si rien ne reste. */
function normNom(v) {
  if (typeof v !== 'string') return '';
  const mots = v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  mots.sort();
  return mots.join(' ');
}
function empreinteNom(v) {
  const n = normNom(v);
  return n ? crypto.createHash('sha256').update(n, 'utf8').digest('hex').slice(0, 16) : null;
}
function texte(v) { return typeof v === 'string' ? v : ''; }
/* Toutes les façons plausibles dont une fiche porte le nom de la personne
   (lues dans migrate-clients.html : leads.nom ; csm-clients.html : nom ||
   name, précédé de prenom ; fiches coaching : nom, name…). */
const CHAMPS_NOM = ['nom', 'name', 'prenom', 'firstName', 'lastName', 'nomComplet', 'fullName', 'leadName', 'clientName'];
function nomsPossibles(d) {
  const out = [];
  ['nom', 'name', 'nomComplet', 'fullName', 'leadName', 'clientName'].forEach(function (k) { out.push(texte(d[k])); });
  out.push(texte(d.prenom) + ' ' + texte(d.nom), texte(d.prenom) + ' ' + texte(d.name), texte(d.firstName) + ' ' + texte(d.lastName));
  return out;
}

async function jobEtat(q) {
  /* Paramètre h (facultatif) validé AVANT toute lecture. */
  let demandes = null;
  if (q.h != null) {
    if (typeof q.h !== 'string') return { code: 400, corps: { ok: false, erreur: 'h : une seule liste d\'empreintes séparées par des virgules' } };
    const l = q.h.split(',').map(function (x) { return x.trim().toLowerCase(); });
    if (!l.length || l.length > 200 || l.some(function (x) { return !/^[0-9a-f]{16}$/.test(x); })) {
      return { code: 400, corps: { ok: false, erreur: 'h : 1 à 200 empreintes de 16 caractères hexadécimaux, séparées par des virgules' } };
    }
    demandes = {};
    l.forEach(function (x) { demandes[x] = 1; });
  }

  /* Retargeting : import des contacts webinaire déjà fait ? */
  const FP = admin.firestore.FieldPath.documentId();
  const migreSnap = await db.collection('_meta').doc('retargeting_migrated').get();
  const wb = await compter(db.collection('leads').where(FP, '>=', 'wb_').where(FP, '<', 'wb`'));
  const corps = { ok: true, mode: 'lecture', retargeting: { migre: !!(migreSnap && migreSnap.exists), leadsWb: wb.n, methode: wb.methode }, noms: null };

  if (demandes) {
    const trouves = {}, parCol = { leads: {}, clients: {} }, lus = { leads: 0, clients: 0 };
    function examiner(col, doc) {
      lus[col]++;
      const d = doc.data() || {};
      nomsPossibles(d).forEach(function (n) {
        const h = empreinteNom(n);
        if (h && demandes[h]) { trouves[h] = 1; parCol[col][h] = 1; }
      });
    }
    /* Seuls les champs de nom sont lus (select) : rien d'autre ne quitte la base. */
    const qL = db.collection('leads').where('isClient', '==', true);
    const sL = await qL.select.apply(qL, CHAMPS_NOM).get();
    sL.forEach(function (doc) { examiner('leads', doc); });
    const qC = db.collection('clients');
    const sC = await qC.select.apply(qC, CHAMPS_NOM).get();
    sC.forEach(function (doc) { examiner('clients', doc); });
    const liste = Object.keys(demandes);
    corps.noms = {
      demandes: liste.length,
      trouves: liste.filter(function (h) { return trouves[h]; }).length,
      absents: liste.filter(function (h) { return !trouves[h]; }).sort(),
      parCollection: { leads: Object.keys(parCol.leads).length, clients: Object.keys(parCol.clients).length },
      lus: lus
    };
  }
  return { code: 200, corps: corps };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  try {
    let r;
    if (q.job === 'clientsince') r = await jobClientSince(q);
    else if (q.job === 'commissions') r = await jobCommissions(q);
    else if (q.job === 'etat') r = await jobEtat(q);
    else r = { code: 400, corps: { ok: false, erreur: 'job=clientsince, job=commissions ou job=etat' } };
    res.status(r.code).json(r.corps);
  } catch (e) {
    res.status(500).json({ ok: false, erreur: String((e && e.message) || e).slice(0, 300) });
  }
};
module.exports.config = { maxDuration: 60 };
module.exports._test = { analyser: analyser, empreinte: empreinte, enveloppe: enveloppe, empreinteNom: empreinteNom, normNom: normNom };
