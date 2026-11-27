// ============================================================================
// api/filtre-audit.js — MESURE « Stats funnel ↔ Qualité leads sous un filtre
// tunnel / source » (27/11/2026), LECTURE SEULE
// ----------------------------------------------------------------------------
// TEMPORAIRE, À RETIRER après la mesure. N'existe que sur la branche de
// travail (preview Vercel), jamais sur `main`.
//
// Pourquoi : SOUS un filtre tunnel ou source, le Stats funnel
// (FunnelCore.computeKpis : k.tenue.rdv / presents / pitches) et Qualité
// leads (LqsCore.byCloser(M.rdvPeriode, '').total) ne comptent pas les mêmes
// RDV de la période. Sans filtre, aucun écart. Cause supposée : le funnel ne
// rattache un RDV qu'aux fiches qu'il a chargées (leads entrés pendant la
// période + ré-optins) ; un RDV de la période dont la fiche est entrée AVANT
// n'a pas de fiche, et le filtre tunnel l'écarte ; Qualité leads lit la
// fiche de chaque RDV (loadMissingLeads) et le garde. Cette route MESURE
// l'écart sur la base réelle avec les VRAIS chargeurs et les VRAIS calculs,
// et range chaque RDV en cause.
//
// Accès : GET /api/filtre-audit?key=<clé>&mois=AAAA-MM
//   key  : comparée à la variable Vercel FILTRE_AUDIT_KEY (24 caractères au
//          moins). Variable absente, vide, trop courte ou égale à « off », clé
//          absente ou fausse, autre verbe que GET → 404 sans corps, sans
//          aucune lecture.
//   mois : défaut = mois courant à l'heure de Paris. Invalide → 400.
//
// N'ÉCRIT RIEN, N'APPELLE AUCUN SERVICE EXTERNE. Cache-Control: no-store.
// AUCUNE DONNÉE PERSONNELLE EN SORTIE : ni nom, ni e-mail, ni téléphone, ni
// identifiant de fiche ou de RDV, ni texte d'erreur brut. Sortent des
// compteurs, les identifiants techniques des tunnels (elite / business) et
// des libellés de cause fixes écrits ici.
//
// Réponse 200 :
//   { ok, mode:'lecture', mois, periode:{du,au}, maintenant,
//     chargement: { funnel:{rdvLus, fiches, reoptins, erreursLecture:[…]},
//                   qualiteLeads:{rdvLus, fiches, fichesAjoutees, fichesIllisibles, erreursLecture:[…]} },
//     exposition: RDV de la période SANS filtre dont le funnel n'a pas la
//                 fiche, rangés par cause (le risque, indépendamment du filtre),
//     filtres: [ { tunnel, source,
//                  funnel:{rdv,presents,pitches}, qualiteLeads:{rdv,presents,pitches},
//                  ecart:{rdv,presents,pitches}  (= Qualité leads − funnel),
//                  controle:{ listesFunnel, listesQualiteLeads, bilan } (vrai = les
//                    listes rejouées redonnent les totaux et l'écart s'explique
//                    RDV par RDV),
//                  causes:{ rdv|presents|pitches: { enPlusQualiteLeads:{cause:n},
//                           enPlusFunnel:{cause:n} } },
//                  familles:{ rdv|presents|pitches: { famille: n } },
//                  ancienneteFichesAvantPeriode:{ jusqua30j, de31a90j, de91a365j, plusDe365j, sansDate } } ],
//     causesConnues: { cause: { famille, texte } } }
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const FC = require('../funnel-core.js');
const LC = require('../lqs-core.js');

const RE_MOIS = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_TUNNEL = /^[a-z0-9_-]{1,40}$/;
const SOURCES = ['youtube', 'other'];
const JOUR_MS = 86400000;

/* ── Clé ─────────────────────────────────────────────────────────────────
   sha256 des deux valeurs puis timingSafeEqual (digests de même longueur :
   aucune fuite de longueur). Variable absente, vide, « off » ou de moins de
   24 caractères = route fermée. */
function cleOuverte() {
  const v = String(process.env.FILTRE_AUDIT_KEY || '').trim();
  if (!v || v.toLowerCase() === 'off' || v.length < 24) return null;
  return v;
}
function keyOk(req) {
  const want = cleOuverte();
  if (!want) return false;
  const q = req.query || {};
  const got = q.key;
  if (typeof got !== 'string' || !got) return false;   // un tableau (key répété) n'est jamais une clé
  const a = crypto.createHash('sha256').update(got, 'utf8').digest();
  const b = crypto.createHash('sha256').update(want, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/* Message d'erreur SANS donnée personnelle : nom de l'erreur (liste fermée)
   et statut gRPC si l'erreur en porte un, jamais le texte de l'exception. */
const GRPC = ['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
function msgSur(e) {
  const code = (e && typeof e === 'object') ? e.code : undefined;
  let statut = null;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16) statut = GRPC[code - 1];
  else if (typeof code === 'string' && GRPC.indexOf(code.toUpperCase().replace(/-/g, '_')) >= 0) statut = code.toUpperCase().replace(/-/g, '_');
  const nom = (e && typeof e === 'object' && ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'FirebaseError', 'GoogleError'].indexOf(e.name) >= 0) ? e.name : 'Erreur';
  return statut ? nom + ' (' + statut + ')' : nom + ' : (détail masqué)';
}
/* Phrases de lecture en échec des moteurs : seule la partie FIXE (avant le
   détail entre parenthèses ou après « : ») sort, jamais le texte d'une
   erreur Firestore (qui peut contenir un chemin de document). */
function phraseSure(s) {
  return String(s == null ? '' : s).split(/ \(| : /)[0].replace(/[0-9a-zA-Z]{16,}/g, '…').slice(0, 140);
}

/* ── Causes ──────────────────────────────────────────────────────────────
   Libellés FIXES. famille = les quatre familles demandées. */
const CAUSES = {
  fiche_avant_periode_non_chargee_funnel: { famille: 'fiche_avant_periode_non_chargee_par_le_funnel',
    texte: 'Le RDV porte le leadId d’une fiche entrée AVANT la période : Qualité leads l’a lue (loadMissingLeads), le funnel ne l’a pas chargée (ni cohorte ni ré-optin) et ne trouve aucune fiche par téléphone ou e-mail.' },
  fiche_non_chargee_funnel_autre: { famille: 'fiche_avant_periode_non_chargee_par_le_funnel',
    texte: 'Comme ci-dessus, mais la fiche n’est pas entrée avant la période (date illisible, entrée après la période, ou fiche écartée de la cohorte du funnel, ex. fiche de test).' },
  fiche_qualite_leads_seulement_telephone: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Qualité leads rattache le RDV à une fiche par le TÉLÉPHONE, le funnel ne trouve aucune fiche.' },
  fiche_qualite_leads_seulement_email: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Qualité leads rattache le RDV à une fiche par l’E-MAIL, le funnel ne trouve aucune fiche.' },
  fiche_funnel_seulement_leadId: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Le funnel rattache le RDV à une fiche par son leadId, Qualité leads ne trouve aucune fiche.' },
  fiche_funnel_seulement_telephone: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Le funnel rattache le RDV à une fiche par le TÉLÉPHONE, Qualité leads ne trouve aucune fiche.' },
  fiche_funnel_seulement_email: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Le funnel rattache le RDV à une fiche par l’E-MAIL, Qualité leads ne trouve aucune fiche.' },
  fiches_differentes: { famille: 'fiche_trouvee_par_un_seul_cote_email_ou_telephone',
    texte: 'Les deux côtés trouvent une fiche, mais pas la même (une voie leadId d’un côté, téléphone ou e-mail de l’autre, par exemple) ; les deux fiches ne passent pas le même filtre.' },
  rdv_sans_fiche: { famille: 'rdv_sans_fiche',
    texte: 'Aucun des deux côtés ne trouve de fiche, et les deux côtés ne jugent pas la provenance du RDV de la même façon.' },
  meme_fiche_verdict_different: { famille: 'autre',
    texte: 'Même fiche des deux côtés, mais le filtre ne donne pas le même verdict.' },
  rdv_compte_d_un_seul_cote_sans_filtre: { famille: 'autre',
    texte: 'Le RDV n’est déjà compté que d’un côté SANS filtre (lecture, classe, période ou état) : écart qui ne vient pas du filtre.' },
  meme_rdv_etat_different: { famille: 'autre',
    texte: 'Le RDV est compté des deux côtés, mais pas dans le même état (présent / pitché).' }
};

/* ── Voies de rattachement RDV → fiche ───────────────────────────────────
   Transcriptions FIDÈLES, pour la MESURE seulement, des deux règles en place :
     funnel : FunnelCore.computeKpis, bookingLead (index leadsById /
       leadsByP9 / leadsByEmail sur DATA.leads puis DATA.reoptins) ;
     Qualité leads : la fiche retenue est b._lead posé par LqsCore.buildModel
       (leadOfBooking(b, true)) — lue telle quelle, seule la VOIE est déduite.
   Elles ne servent qu'à NOMMER la cause d'un écart déjà mesuré par les
   vrais calculs. */
function indexFunnel(DATA) {
  const byId = {}, byP9 = {}, byEmail = {};
  function idx(l) {
    byId[l._id] = l;
    if (l._p9 && !byP9[l._p9]) byP9[l._p9] = l;
    const em = String(l.email || '').toLowerCase().trim();
    if (em && !byEmail[em]) byEmail[em] = l;
  }
  (DATA.leads || []).forEach(idx);
  (DATA.reoptins || []).forEach(idx);
  return function (b) {
    if (!b) return null;
    if (b.leadId && byId[b.leadId]) return { l: byId[b.leadId], voie: 'leadId' };
    if (b._p9 && byP9[b._p9]) return { l: byP9[b._p9], voie: 'telephone' };
    const em = String((b.prospect && b.prospect.email) || '').toLowerCase().trim();
    if (em && byEmail[em]) return { l: byEmail[em], voie: 'email' };
    return null;
  };
}
function voieQualiteLeads(b) {
  const l = b && b._lead;
  if (!l) return null;
  if (b.leadId && l._id === b.leadId) return { l: l, voie: 'leadId' };
  if (b._p9 && l._p9 === b._p9) return { l: l, voie: 'telephone' };
  return { l: l, voie: 'email' };
}

/* Indicateurs 0/1 d'un RDV : LA règle commune (StatsCore.compter) au même
   instant que les deux calculs. */
function drapeaux(b, now) {
  const c = SC.compter([b], now);
  return { rdv: c.rdv ? 1 : 0, presents: c.presents ? 1 : 0, pitches: c.pitches ? 1 : 0 };
}

function compteur() { return {}; }
function inc(o, k) { o[k] = (o[k] || 0) + 1; }

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  let mois = q.mois;
  if (mois == null || mois === '') mois = SC.moisParis(new Date());
  if (typeof mois !== 'string' || !RE_MOIS.test(mois)) {
    res.status(400).json({ ok: false, erreur: 'mois=AAAA-MM' });
    return;
  }
  try {
    const p = mois.split('-');
    const P = FC.periodMonth(+p[0], +p[1] - 1);
    const pS = P.start.getTime();
    const NOW = Date.now();

    /* ── Chargement : les VRAIS chargeurs, en parallèle, sur des données
       séparées (chaque moteur annote ses propres objets). ── */
    const typeMap = await FC.loadTypeMap(db);
    const team = await FC.loadTeamMembers(db);
    const chargements = await Promise.all([
      FC.loadAll(db, { P: P, typeMap: typeMap, teamMembers: team }),
      LC.loadAll(db, { P: P, typeMap: typeMap, closerRange: { start: P.start, end: P.end } })
    ]);
    const FR = chargements[0], D = chargements[1];
    const DATA = FR.DATA;
    const teamF = FR.teamMembers || team;
    const resoudreF = FC.resoudrePersonneDe(DATA, teamF);
    const grid = LC.normalizeGrid(D.gridRaw);
    const lienFunnel = indexFunnel(DATA);

    /* Un calcul de chaque côté pour un filtre, comme sales-funnel.html
       (compute) et lqs-tab.js (rebuild) : Qualité leads reçoit les closes et
       les méta-données des tunnels du funnel, comme sur la page. */
    function calculer(tunnel, source) {
      const K = FC.computeKpis({ DATA: DATA, P: P, tunnelFilter: tunnel, sourceFilter: source,
        teamMembers: teamF, typeMap: typeMap, resoudrePersonne: resoudreF, now: NOW });
      const M = LC.buildModel(D, {
        P: P, grid: grid, gridStamp: 1, tunnelFilter: tunnel, sourceFilter: source,
        teamMembers: team, typeMap: typeMap, closerRange: { start: P.start, end: P.end },
        tunnelsMeta: DATA.tunnelsMeta || null, funnelCloses: K.closeRows || [], now: NOW
      });
      const tq = LC.byCloser(M.rdvPeriode || [], '').total;
      const t = K.tenue || {};
      /* Listes RDV par RDV, par identifiant (jamais en sortie). */
      const dr = K.drill || {};
      const F = { rdv: ids(dr.rdvMois), presents: ids(dr.live), pitches: ids(dr.pitched) };
      const Q = { rdv: new Set(), presents: new Set(), pitches: new Set() };
      const bQ = {};
      (M.rdvPeriode || []).forEach(function (x) {
        const b = x.b; if (!b || !b._id) return;
        bQ[b._id] = b;
        const f = drapeaux(b, x.now != null ? x.now : NOW);
        if (f.rdv) Q.rdv.add(b._id);
        if (f.presents) Q.presents.add(b._id);
        if (f.pitches) Q.pitches.add(b._id);
      });
      return {
        funnel: { rdv: t.rdv || 0, presents: t.presents || 0, pitches: t.pitches || 0 },
        qualiteLeads: { rdv: tq.rdv || 0, presents: tq.presents || 0, pitches: tq.pitches || 0 },
        F: F, Q: Q, bQ: bQ,
        pont: (tunnel === 'all' && source === 'all') ? pontParCloser(M) : null
      };
    }

    /* ── Pont par closer, SANS filtre (27/11/2026) : de quoi sont faits les
       « Présents » de la carte (RDV DATÉS dans la période, rangés dans
       l'onglet du closer comme Global closing) à côté de « Leads présents »
       (leads ENTRÉS pendant la période, un lead compte une fois). Compteurs
       seulement ; les clés sont les onglets de l'équipe. ── */
    function pontParCloser(M) {
      const rdv = M.rdvPeriode || [], rows = M.rows || [];
      const NA = SC.NON_ATTRIBUE || '_na';
      const cles = { '': 1 };
      rdv.forEach(function (x) { cles[x.rangKey != null ? x.rangKey : (x.closer || NA)] = 1; });
      function origine(x) {
        const lr = x.leadRow;
        if (!lr) return 'sansFicheLead';
        if (lr.cohorte) return lr.reopt ? 'reoptinDeLaPeriode' : 'leadEntrePendantLaPeriode';
        if (lr.entry == null) return 'ficheSansDateEntree';
        return lr.entry < pS ? 'ficheEntreeAvantLaPeriode' : 'ficheHorsLeadsEntres';
      }
      function ventiler(list) {
        const o = {}, vus = {}, mois = {};
        list.forEach(function (x) {
          const k = origine(x);
          const a = o[k] = o[k] || { rdv: 0, prospects: 0 };
          a.rdv++;
          const id = x.leadRow ? 'l:' + x.leadRow.id : 'b:' + (x.b && x.b._id);
          if (!vus[id]) { vus[id] = 1; a.prospects++; }
          if (k === 'ficheEntreeAvantLaPeriode') {
            const m = SC.jourParis(x.leadRow.entry).slice(0, 7);
            mois[m] = (mois[m] || 0) + 1;
          }
        });
        return { total: list.length, prospectsDistincts: Object.keys(vus).length, parOrigine: o, moisEntreeDesFichesAnciennes: mois };
      }
      return Object.keys(cles).sort().map(function (cle) {
        const B = LC.byCloser(rdv, cle);
        const presents = B.list.filter(function (x) { return x.present; });
        const pitches = B.list.filter(function (x) { return x.pitched; });
        /* Leads entrés rangés chez ce closer : la règle de l'écran
           (lqs-tab.js rows() : r.closer === closer choisi). */
        const R = cle === '' ? rows : rows.filter(function (r) { return r.closer === cle; });
        const t = LC.byNote(R, [], []).total;
        /* Recoupement : les « leads présents » se retrouvent-ils parmi les
           RDV présents de la période rangés chez ce closer ? */
        const idsPresents = {};
        presents.forEach(function (x) { if (x.leadRow) idsPresents[x.leadRow.id] = 1; });
        let dansLesRdv = 0, ailleurs = 0;
        R.forEach(function (r) { if (!r.leadPresent) return; if (idsPresents[r.id]) dansLesRdv++; else ailleurs++; });
        const idsR = {};
        R.forEach(function (r) { idsR[r.id] = 1; });
        let entresRangesAilleurs = 0;
        Object.keys(idsPresents).forEach(function (id) {
          const x = presents.filter(function (y) { return y.leadRow && y.leadRow.id === id; })[0];
          if (x && x.leadRow.cohorte && !idsR[id]) entresRangesAilleurs++;
        });
        return {
          closer: cle === '' ? '(toute l\'équipe)' : cle,
          carte: { rdv: B.total.rdv || 0, presents: B.total.presents || 0, pitches: B.total.pitches || 0 },
          controle: presents.length === (B.total.presents || 0) && pitches.length === (B.total.pitches || 0) && B.list.length === (B.total.rdv || 0),
          rdv: ventiler(B.list), presents: ventiler(presents), pitches: ventiler(pitches),
          leadsEntres: { leads: t.leads || 0, avecRdv: t.leadsAvecRdv || 0, presents: t.leadsPresents || 0, pitches: t.leadsPitches || 0 },
          recoupementLeadsPresents: { vusDansLesRdvPresentsDeLaPeriode: dansLesRdv, presentsAUnAutreRdv: ailleurs,
            leadsEntresPresentsIciMaisRangesChezUnAutreCloser: entresRangesAilleurs }
        };
      });
    }
    function ids(list) {
      const s = new Set();
      (list || []).forEach(function (b) { if (b && b._id) s.add(b._id); });
      return s;
    }

    /* Référence SANS filtre (un RDV absent d'un côté ici n'est pas un effet
       du filtre). */
    const base = calculer('all', 'all');

    /* Le RDV tel que chaque côté l'a lu. */
    function rdvFunnel(id) { return (DATA.bookingsById && DATA.bookingsById[id]) || null; }
    function rdvQualite(id, R) { return (R.bQ && R.bQ[id]) || (D.bookingsById && D.bookingsById[id]) || null; }

    function anciennete(l) {
      const e = l ? FC.realEntryMs(l) : null;
      if (e == null) return 'sansDate';
      const j = (pS - e) / JOUR_MS;
      if (j <= 30) return 'jusqua30j';
      if (j <= 90) return 'de31a90j';
      if (j <= 365) return 'de91a365j';
      return 'plusDe365j';
    }

    /* Cause d'un RDV de la différence (métrique m). */
    function classer(id, m, R) {
      if (m !== 'rdv' && R.F.rdv.has(id) && R.Q.rdv.has(id)) return { cause: 'meme_rdv_etat_different' };
      if (!(base.F.rdv.has(id) && base.Q.rdv.has(id))) return { cause: 'rdv_compte_d_un_seul_cote_sans_filtre' };
      const lf = lienFunnel(rdvFunnel(id));
      const lq = voieQualiteLeads(rdvQualite(id, R));
      if (!lf && !lq) return { cause: 'rdv_sans_fiche' };
      if (!lf) {
        if (lq.voie === 'leadId') {
          const e = FC.realEntryMs(lq.l);
          return { cause: (e != null && e < pS) ? 'fiche_avant_periode_non_chargee_funnel' : 'fiche_non_chargee_funnel_autre', fiche: lq.l };
        }
        return { cause: 'fiche_qualite_leads_seulement_' + lq.voie };
      }
      if (!lq) return { cause: 'fiche_funnel_seulement_' + lf.voie };
      if (lf.l._id !== lq.l._id) return { cause: 'fiches_differentes' };
      return { cause: 'meme_fiche_verdict_different' };
    }

    function comparer(tunnel, source, R) {
      const causes = {}, familles = {};
      const age = { jusqua30j: 0, de31a90j: 0, de91a365j: 0, plusDe365j: 0, sansDate: 0 };
      let bilan = true;
      const ecart = {};
      ['rdv', 'presents', 'pitches'].forEach(function (m) {
        const enPlusQ = compteur(), enPlusF = compteur(), fam = {};
        let nQ = 0, nF = 0;
        R.Q[m].forEach(function (id) {
          if (R.F[m].has(id)) return;
          nQ++;
          const c = classer(id, m, R);
          inc(enPlusQ, c.cause); inc(fam, CAUSES[c.cause].famille);
          if (m === 'rdv' && c.fiche) age[anciennete(c.fiche)]++;
        });
        R.F[m].forEach(function (id) {
          if (R.Q[m].has(id)) return;
          nF++;
          const c = classer(id, m, R);
          inc(enPlusF, c.cause); inc(fam, CAUSES[c.cause].famille);
          if (m === 'rdv' && c.fiche) age[anciennete(c.fiche)]++;
        });
        causes[m] = { enPlusQualiteLeads: enPlusQ, enPlusFunnel: enPlusF };
        familles[m] = fam;
        ecart[m] = R.qualiteLeads[m] - R.funnel[m];
        if (R.funnel[m] + nQ - nF !== R.qualiteLeads[m]) bilan = false;
      });
      return {
        tunnel: tunnel, source: source,
        funnel: R.funnel, qualiteLeads: R.qualiteLeads, ecart: ecart,
        controle: {
          listesFunnel: R.F.rdv.size === R.funnel.rdv && R.F.presents.size === R.funnel.presents && R.F.pitches.size === R.funnel.pitches,
          listesQualiteLeads: R.Q.rdv.size === R.qualiteLeads.rdv && R.Q.presents.size === R.qualiteLeads.presents && R.Q.pitches.size === R.qualiteLeads.pitches,
          bilan: bilan
        },
        causes: causes, familles: familles, ancienneteFichesAvantPeriode: age
      };
    }

    /* Tunnels présents dans les données (fiches des deux côtés) :
       identifiants techniques seulement (FunnelCore.leadTunnel). */
    const tunnels = new Set();
    (DATA.leads || []).concat(DATA.reoptins || [], D.leads || [], D.reoptins || [], D.extraLeads || []).forEach(function (l) {
      if (!l) return;
      const t = l._tunnel || FC.leadTunnel(l);
      if (typeof t === 'string' && RE_TUNNEL.test(t)) tunnels.add(t);
    });
    const listeTunnels = Array.from(tunnels).sort();

    const filtres = [{ t: 'all', s: 'all' }];
    /* ?seul=pont : le pont par closer seulement (un calcul, sans filtre). */
    if (q.seul !== 'pont') {
      listeTunnels.forEach(function (t) { filtres.push({ t: t, s: 'all' }); });
      SOURCES.forEach(function (s) { filtres.push({ t: 'all', s: s }); });
      listeTunnels.forEach(function (t) { SOURCES.forEach(function (s) { filtres.push({ t: t, s: s }); }); });
    }

    const sorties = filtres.map(function (f) {
      const R = (f.t === 'all' && f.s === 'all') ? base : calculer(f.t, f.s);
      return comparer(f.t, f.s, R);
    });

    /* Exposition : RDV de la période (sans filtre) dont le funnel n'a pas de
       fiche — ceux qu'un filtre tunnel écarte d'office côté funnel. */
    const expo = { rdvDeLaPeriode: base.F.rdv.size, sansFicheCoteFunnel: 0, sansFicheCoteQualiteLeads: 0, parCause: {},
      ancienneteFichesAvantPeriode: { jusqua30j: 0, de31a90j: 0, de91a365j: 0, plusDe365j: 0, sansDate: 0 } };
    base.F.rdv.forEach(function (id) {
      const lf = lienFunnel(rdvFunnel(id));
      const lq = voieQualiteLeads(rdvQualite(id, base));
      if (!lq) expo.sansFicheCoteQualiteLeads++;
      if (lf) return;
      expo.sansFicheCoteFunnel++;
      if (!lq) { inc(expo.parCause, 'rdv_sans_fiche'); return; }
      if (lq.voie === 'leadId') {
        const e = FC.realEntryMs(lq.l);
        const c = (e != null && e < pS) ? 'fiche_avant_periode_non_chargee_funnel' : 'fiche_non_chargee_funnel_autre';
        inc(expo.parCause, c);
        if (c === 'fiche_avant_periode_non_chargee_funnel') expo.ancienneteFichesAvantPeriode[anciennete(lq.l)]++;
        return;
      }
      inc(expo.parCause, 'fiche_qualite_leads_seulement_' + lq.voie);
    });

    const erreursF = [];
    if (DATA.bookingsError) erreursF.push('Lecture des RDV impossible');
    if (DATA.leadsError) erreursF.push('Lecture des leads impossible');
    if (DATA.leadsTruncated) erreursF.push('Liste des leads tronquée');
    if (DATA.reoptinsError) erreursF.push('Lecture des ré-optins impossible');
    if (DATA.reoptinsTruncated) erreursF.push('Liste des ré-optins tronquée');
    if (DATA.personsError) erreursF.push('Lecture des fiches d’agenda impossible');

    const corps = {
      ok: true, mode: 'lecture', mois: mois,
      periode: { du: SC.jourParis(P.start), au: SC.jourParis(P.end) },
      maintenant: new Date(NOW).toISOString(),
      chargement: {
        funnel: { rdvLus: (DATA.bookings || []).length, fiches: (DATA.leads || []).length, reoptins: (DATA.reoptins || []).length,
          erreursLecture: erreursF },
        qualiteLeads: { rdvLus: (D.bookings || []).length, fiches: (D.leads || []).length, reoptins: (D.reoptins || []).length,
          fichesAjoutees: (D.extraLeads || []).length, fichesIllisibles: D.extraLeadsEchecs || 0,
          erreursLecture: (D.lectures || []).map(phraseSure) }
      },
      tunnels: listeTunnels,
      exposition: expo,
      pontParCloser: base.pont,
      filtres: sorties,
      causesConnues: CAUSES
    };
    res.status(200).json(corps);
  } catch (e) {
    res.status(500).json({ ok: false, erreur: msgSur(e) });
  }
};
/* Deux chargements complets (funnel + Qualité leads) d'un mois, en
   parallèle, puis un calcul par filtre : au-delà des 10 s par défaut. Même
   réglage que les routes de mesure précédentes et api/agency-funnel.js
   (aucune entrée dans vercel.json). */
module.exports.config = { maxDuration: 60 };
module.exports._test = { keyOk: keyOk, msgSur: msgSur, phraseSure: phraseSure, CAUSES: CAUSES };
