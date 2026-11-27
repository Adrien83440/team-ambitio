// ============================================================================
// api/_aiTools.js — OUTILS « DONNÉES ALTEORE » en LECTURE SEULE (Lot 5)
// ----------------------------------------------------------------------------
// Une seule définition d'outils, trois consommateurs :
//   • api/ai-ask.js     — « Demande à Alteore » (réponse admin de la barre ⌘K, Opus) ;
//   • api/mcp.js        — serveur MCP (connecteur AltTeam : Claude Desktop / claude.ai d'Adrien) ;
//   • api/ai-command.js — search_leads seul (ouvrir une fiche depuis ⌘K).
// AUCUN outil n'écrit en base. Chaque outil renvoie un objet JSON compact.
// Périmètre : données sales, coaching, paiements, IA. Pas de factures
// détaillées ni de données personnelles au-delà de nom / contact.
// Fichier préfixé `_` : exclu du routing Vercel.
//
// RÉFÉRENTIEL DES CHIFFRES (audit de cohérence du 25/11/2026) — l'assistant
// répète ces chiffres à l'équipe : ils doivent être EXACTEMENT ceux des
// écrans, sous les mêmes mots.
//   · RDV : classe (Self Booking / Setting / Manuel / hors vente) et état
//     (annulé, no-show, présent, à statuer, à venir, replanifié, doublon) par
//     stats-core.js (StatsCore.classifyBooking, StatsCore.compter) — jamais
//     un prédicat recopié ici. Identité garantie :
//       RDV = annulés + no-show + présents + à statuer + à venir.
//   · Closes, Contracté, Collecté : LA liste unique (FunnelCore.loadCloses +
//     sumCloses) — un close = un client gagné, daté du jour de la vente,
//     closes annulés retirés, montants HT du module Paiements. Le montant
//     déclaré par le closer n'est jamais renvoyé sous ces mots.
//   · Leads : date d'entrée réelle (FunnelCore.loadLeads), fusionnées et
//     fiches de test exclues, ré-optins à part. Décrochés : StatsCore.estDecroche.
//   · Jours et bornes de période : heure de Paris (StatsCore).
//   · Chaque outil renvoie `definitions` : le texte du glossaire commun pour
//     chaque chiffre renvoyé (StatsCore.texte), pour que l'assistant explique
//     un chiffre avec les mots de l'écran.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { tsToMs, cap } = require('./_ai');
const SC = require('../stats-core.js');
const FC = require('../funnel-core.js');

const JOUR_MS = 86400000;
const RE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
const LISTE_MAX = 80;

// ---------------------------------------------------------------------------
//  Dates — toujours l'heure de Paris (StatsCore)
// ---------------------------------------------------------------------------

function parisDate(ms) { return SC.jourParis(ms); }
function jourValide(s) {
  if (!RE_JOUR.test(String(s || ''))) return false;
  const p = String(s).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
/* Décale un jour 'AAAA-MM-JJ' de n jours de calendrier (aucun fuseau). */
function decaler(iso, n) {
  const p = String(iso).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10);
}
/* Période demandée : du jour `from` 00:00 au jour `to` 23:59:59.999, heure de
   Paris. Défaut : « 30 jours » = aujourd'hui et les 29 jours précédents. */
function range(input) {
  const today = parisDate(Date.now());
  let from = jourValide(input && input.from) ? input.from : decaler(today, -29);
  let to = jourValide(input && input.to) ? input.to : today;
  if (from > to) { const t = from; from = to; to = t; }
  const start = SC.debutJourParis(from), end = SC.finJourParis(to);
  return { from: from, to: to, start: start, end: end, fromMs: start.getTime(), toMs: end.getTime(),
    label: from + ' → ' + to + ' inclus (heure de Paris)' };
}
function arrondi(n) { return n == null || isNaN(n) ? null : Math.round(Number(n)); }

function inc(map, k, field, n) { k = k || '(inconnu)'; if (!map[k]) map[k] = {}; map[k][field] = (map[k][field] || 0) + (n == null ? 1 : n); }
function srcOf(l) { return (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || l.source || 'autre'; }
function nomProspect(b) {
  if (b && b.prospect) return ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim();
  return (b && b.clientName) || '';
}

// ---------------------------------------------------------------------------
//  Définitions — le glossaire commun (stats-core.js), jamais réécrit ici
// ---------------------------------------------------------------------------

/* Termes qui n'existent pas (encore) dans le glossaire commun : notes propres
   à l'assistant, signalées pour ajout centralisé. Elles ne redéfinissent
   AUCUN terme du glossaire. */
const LIBRE = {
  appels_recus: { mot: 'Appels reçus', texte: 'Appels entrants de la période (le prospect nous appelle). Comptés à part : ils ne sont jamais dans Appels, qui ne compte que les sortants.' },
  appels_recus_decroches: { mot: 'Appels reçus décrochés', texte: 'Appels entrants avec au moins 5 secondes de conversation, répondeurs écartés (même règle que Décrochés).' },
  appels_sens_inconnu: { mot: 'Appels sans sens', texte: 'Appels sans sens (entrant / sortant) enregistré : comptés nulle part, signalés ici.' },
  note_ia_appel: { mot: 'Note IA moyenne', texte: 'Moyenne des notes données par l’IA aux appels analysés de la période (sur 100). Seuls les appels analysés comptent.' },
  leads_setter_fiche: { mot: 'Leads par setter de la fiche', texte: 'Leads entrés pendant la période, rangés chez le setter de la fiche (setter verrouillé, sinon personne assignée), Self Booking compris : ce ne sont pas les « Leads NB reçus » de Set NB.' },
  leads_statut: { mot: 'Statut actuel', texte: 'Statut de la fiche aujourd’hui (pas au moment de son entrée).' },
  leads_chauds: { mot: 'Leads chauds (IA)', texte: 'Leads dont l’analyse IA de la fiche dit « chaud ». Estimation de l’IA, pas un chiffre des écrans de vente.' },
  fiches_test: { mot: 'Fiches de test', texte: 'Fiches entrées pendant la période et marquées « fiche de test » (essais de l’équipe) : retirées des Leads.' },
  rdv_remplacants_crees: { mot: 'RDV de report créés', texte: 'Nouveaux créneaux créés pendant la période pour un RDV déplacé ou transféré : ils ne sont pas de nouveaux RDV pris.' },
  manuels_crees: { mot: 'RDV manuels créés', texte: 'RDV créés à la main dans l’Agenda pendant la période. Jamais dans RDV pris, Sets ni LTB.' },
  reste_du_ttc: { mot: 'Reste dû TTC', texte: 'Montant TTC du contrat moins ce qui a déjà été prélevé, TOUTES échéances comprises (y compris celles qui ne sont pas encore arrivées). Ce n’est pas un montant en retard.' },
  reste_du_ht: { mot: 'Reste dû HT', texte: 'Le reste dû TTC converti hors taxes (÷ 1,2, sauf contrat déjà HT), toutes échéances comprises.' },
  montant_en_retard: { mot: 'Montant en retard TTC', texte: 'Échéances déjà arrivées et non prélevées (nombre d’échéances en retard × montant d’une échéance), TTC. Absent quand le dossier n’est pas un plan en plusieurs fois (rejet d’un paiement unique : voir le reste dû).' },
  echeances_en_retard: { mot: 'Échéances en retard', texte: 'Échéances qui auraient dû être prélevées à ce jour (une par mois depuis le début du plan) moins celles déjà prélevées.' },
  dossiers_impayes: { mot: 'Dossiers impayés', texte: 'Plans de paiement avec un problème : mandat ou paiement en échec, dernier prélèvement rejeté non rattrapé, échéances en retard, facturation en procédure ou dossier suivi en recouvrement. Même règle que le module Impayés.' },
  feu_client: { mot: 'Feu client', texte: 'Niveau de risque d’un client coaching (rouge / orange / vert), calculé chaque nuit à partir de son suivi.' },
  objections: { mot: 'Objections', texte: 'Objections détectées par l’IA dans les appels analysés (closings et setting). Levées = l’objection a été traitée dans l’appel. RDV closés = appels de closing au résultat Close où l’objection est apparue (ce n’est pas « Closes »).' },
  conso_ia: { mot: 'Consommation IA', texte: 'Coût des appels à l’IA ce mois-ci (en dollars) et nombre d’appels.' },
  jamais_contactes_24h: { mot: 'Jamais contactés depuis 24 h', texte: 'Leads des 7 derniers jours, entrés depuis plus de 24 h, toujours au statut « nouveau » et sans aucun appel ni SMS sur la fiche.' },
};
/* map : { champRenvoyé: 'cle' | ['cle', 'précision propre à l'outil'] }
   → { champRenvoyé: 'Mot : texte du glossaire [précision]' }. */
function definitions(map) {
  const out = {};
  Object.keys(map).forEach(function (champ) {
    const v = map[champ];
    const cle = Array.isArray(v) ? v[0] : v;
    const prec = Array.isArray(v) ? v[1] : '';
    const g = SC.GLOSSAIRE[cle] || LIBRE[cle];
    if (!g) return;
    out[champ] = g.mot + ' : ' + g.texte + (prec ? ' ' + prec : '');
  });
  return out;
}

// ---------------------------------------------------------------------------
//  Contexte : table des types, fiches d'agenda, équipe (une lecture par appel)
// ---------------------------------------------------------------------------

async function contexte() {
  const avert = [];
  const [cfg, team] = await Promise.all([
    db.collection('booking_config').get().then(function (snap) {
      let types = null;
      const persons = {};
      snap.forEach(function (doc) {
        const d = doc.data() || {};
        if (doc.id === '_types') types = d.list || [];
        else if (d.__type === 'person') persons[doc.id] = { firebaseUid: d.firebaseUid || null, name: d.name || doc.id };
      });
      if (types === null) avert.push('Table des types de RDV absente : la répartition Self Booking / Setting peut être fausse.');
      return { typeMap: FC.buildTypeMap(types || []), persons: persons };
    }).catch(function (e) {
      avert.push('Réglages de l’agenda illisibles (' + ((e && e.message) || 'lecture impossible') + ') : la répartition Self Booking / Setting et le closer des RDV peuvent être faux.');
      return { typeMap: {}, persons: {} };
    }),
    FC.loadTeamMembers(db),
  ]);
  if (team && team._erreur) avert.push('Équipe illisible (' + team._erreur + ') : les noms ne sont pas résolus, tout est rangé dans « Non attribué ».');
  return construireContexte(cfg.typeMap, cfg.persons, team || [], avert);
}

/* Rôles qui ont un onglet (mêmes listes que alteore-flow.js : SETTER_ROLES
   pour Set NB, CLOSER_ROLES pour Close SB / Global closing). */
const ROLES_ONGLET = {
  setter: { setter: 1, closer_setter: 1, setter_ecrit: 1 },
  closer: { closer: 1, closer_setter: 1 },
};
const ROLES_SALES = { setter: 1, closer: 1, closer_setter: 1, setter_ecrit: 1 };

/* Contexte à partir de données déjà lues — aussi le repli du brief du matin
   quand la lecture échoue (construireContexte({}, {}, [], [])) : sans équipe,
   tout le monde est « Non attribué », jamais un identifiant brut. */
function construireContexte(typeMap, persons, team, avert) {
  persons = persons || {};
  team = team || [];
  const bySlug = {};
  team.forEach(function (m) {
    if (!m || !m.slug) return;
    bySlug[m.slug] = m;
  });
  /* personId d'une fiche d'agenda → slug du membre : LA règle commune
     StatsCore.resoudreHote (compte relié AVANT l'égalité personId == slug —
     fiche reprise, 27/11/2026), roster complet. null = inconnu. */
  const resoudre = SC.resoudreHote(persons, team);
  /* Membre parti : drapeau de la fiche, fiche archivée avec date de fin, ou
     liste historique commune (StatsCore.estParti — la même qu'à l'écran). */
  function parti(slug) { return !!slug && SC.estParti(bySlug[slug] || null, slug); }
  function prenom(slug) {
    const m = bySlug[slug];
    return m ? (m.shortName || m.displayName || m.fullName || String(slug)) : null;
  }
  /* Nom affiché d'un slug : « Anciens membres » pour un membre parti
     (décision D10 : jamais son nom), « Non attribué » si inconnu — jamais
     l'identifiant brut. */
  function nomDe(slug) {
    if (!slug) return SC.mot('non_attribue');
    if (parti(slug)) return SC.mot('anciens_membres');
    return prenom(slug) || SC.mot('non_attribue');
  }
  /* Nom en clair déjà écrit sur un document (ex. payments.closerName) : un
     ancien membre n'est jamais nommé — même prénom qu'un membre parti ou
     qu'un slug de la liste historique → « Anciens membres ». */
  function tok(v) {
    let t = String(v || '');
    try { t = t.normalize('NFD').replace(/[\u0300-\u036F]/g, ''); } catch (e) { /* rien */ }
    return t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(' ')[0];
  }
  const prenomsPartis = {};
  Object.keys(SC.PARTIS_HISTORIQUES || {}).forEach(function (k) { prenomsPartis[tok(k)] = 1; });
  team.forEach(function (m) { if (m && m.slug && parti(m.slug)) prenomsPartis[tok(m.shortName || m.displayName || m.fullName || m.slug)] = 1; });
  function nomEnClair(nom) {
    if (!nom) return null;
    return prenomsPartis[tok(nom)] ? SC.mot('anciens_membres') : String(nom);
  }
  /* Qui a un onglet dans la vue : membre actif, non parti, au rôle de la vue
     (Set NB : à défaut de tout setter, toute l'équipe sales). */
  const onglets = { setter: {}, closer: {} };
  ['setter', 'closer'].forEach(function (vue) {
    team.forEach(function (m) {
      if (m && m.slug && !parti(m.slug) && m.active !== false && ROLES_ONGLET[vue][m.role]) onglets[vue][m.slug] = 1;
    });
  });
  if (!Object.keys(onglets.setter).length) {
    team.forEach(function (m) {
      if (m && m.slug && !parti(m.slug) && m.active !== false && ROLES_SALES[m.role]) onglets.setter[m.slug] = 1;
    });
  }
  function debut(slug) {
    const v = bySlug[slug] && bySlug[slug].startDate;
    return (typeof v === 'string' && RE_JOUR.test(v)) ? v : null;
  }
  /* OÙ RANGER une personne dans une vue par personne (StatsCore.rangPersonne,
     la règle de Set NB, Global closing et du Dashboard). vue = 'setter' |
     'closer' ; jourIso = date du RDV, jour de création (Paris) d'un set, jour
     du close. → { key: libellé de la ligne, precision: détail de la ligne
     « Non attribué » ('' sinon) }. */
  function rang(slug, jourIso, vue) {
    /* Slug absent de l'équipe (et pas un ancien membre) = personne inconnue. */
    const s = slug && (bySlug[slug] || parti(slug)) ? slug : null;
    const r = SC.rangPersonne(s, jourIso || null, {
      parti: parti,
      aOnglet: function (x) { return !!onglets[vue === 'closer' ? 'closer' : 'setter'][x]; },
      prenom: prenom,
      debut: debut,
    });
    if (r.key !== SC.NON_ATTRIBUE) return { key: nomDe(r.key), precision: '' };
    return { key: SC.mot('non_attribue'), precision: r.precision || (vue === 'closer' ? 'Closer inconnu' : 'Setter inconnu') };
  }
  /* Auteur d'un appel et périmètre : LE prédicat du Stats funnel
     (FunnelCore.perimetreAppel, auteur = FunnelCore.callerOf) —
     'sales' | 'sans_auteur' | 'hors' (CSM, coachs → « Hors équipe sales »). */
  const idxAppels = FC.callerIndex(team);
  function auteurAppel(c) {
    const perim = FC.perimetreAppel(c, idxAppels);
    if (perim === 'sans_auteur') return { perim: perim, key: SC.mot('non_attribue') };
    if (perim === 'hors') return { perim: perim, key: SC.mot('hors_equipe_sales') };
    const who = FC.callerOf(c, idxAppels) || {};
    const depart = who.departed || parti(who.slug);
    if (depart) return { perim: perim, key: SC.mot('anciens_membres') };
    /* Appel daté d'avant l'arrivée du membre : « Non attribué », précision
       « Prénom (avant son arrivée) » — la règle de Set NB, du Dashboard et de
       Pilotage (FunnelCore.ligneAppel → StatsCore.rangPersonne). */
    const ms = FC.parseFlexMs(c.initiatedAt) || FC.parseFlexMs(c.startTime);
    const la = FC.ligneAppel(who, ms ? SC.jourParis(ms) : null);
    if (la.cas === 'avant_arrivee') return { perim: perim, key: SC.mot('non_attribue'), precision: la.precision };
    return { perim: perim, key: who.name || SC.mot('non_attribue') };
  }
  return { typeMap: typeMap || {}, persons: persons, team: team, bySlug: bySlug, resoudre: resoudre, nomDe: nomDe,
    nomEnClair: nomEnClair, parti: parti, rang: rang, auteurAppel: auteurAppel, avert: avert || [] };
}

/* Regroupement par ligne d'une vue par personne : la ligne « Non attribué »
   garde le détail de ce qu'elle contient (champ `detail`, par précision). */
function ranger(G, rg) {
  const g = G[rg.key] = G[rg.key] || { rdv: [], closes: [], sets: 0 };
  const cibles = [g];
  if (rg.precision) {
    g.detail = g.detail || {};
    cibles.push(g.detail[rg.precision] = g.detail[rg.precision] || { rdv: [], closes: [], sets: 0 });
  }
  return cibles;
}
function finir(G, bloc) {
  const out = {};
  Object.keys(G).forEach(function (k) {
    const o = bloc(G[k]);
    if (G[k].detail) {
      o.detail = {};
      Object.keys(G[k].detail).forEach(function (p) { o.detail[p] = bloc(G[k].detail[p]); });
    }
    out[k] = o;
  });
  return out;
}
function jourCreation(b) {
  const ms = tsToMs(b && b.createdAt);
  return ms ? parisDate(ms) : null;
}

/* RDV dont la DATE tombe entre deux jours 'AAAA-MM-JJ' (inclus), classés. */
async function lireRdvDates(fromIso, toIso, ctx) {
  const s = await db.collection('bookings').where('date', '>=', fromIso).where('date', '<=', toIso).get();
  const list = [];
  s.forEach(function (d) {
    const b = d.data() || {};
    b._id = d.id;
    b._class = SC.classifyBooking(b, ctx.typeMap);
    list.push(b);
  });
  return list;
}
/* RDV CRÉÉS pendant la période (axe « RDV pris »), classés. */
async function lireRdvCrees(r, ctx) {
  const s = await db.collection('bookings').where('createdAt', '>=', r.start).where('createdAt', '<=', r.end).get();
  const list = [];
  s.forEach(function (d) {
    const b = d.data() || {};
    b._id = d.id;
    b._class = SC.classifyBooking(b, ctx.typeMap);
    list.push(b);
  });
  return list;
}
function teteDeChaine(b) { return !SC.estRemplacant(b) && !SC.estDoublon(b); }
/* Bloc « RDV pris » : même règle que le Stats funnel (k.booked) et Set NB. */
function blocPris(crees) {
  const pris = crees.filter(function (b) { return SC.estRdvPris(b._class) && teteDeChaine(b); });
  return {
    pris: pris,
    rdvPris: pris.length,
    selfBooking: pris.filter(function (b) { return b._class === 'self'; }).length,
    sets: pris.filter(function (b) { return b._class === 'setter'; }).length,
    manuelsCrees: crees.filter(function (b) { return b._class === 'admin' && teteDeChaine(b); }).length,
    remplacantsCrees: crees.filter(function (b) { return SC.estRdvPris(b._class) && SC.estRemplacant(b) && !SC.estDoublon(b); }).length,
    doublonsSupprimes: crees.filter(function (b) { return SC.estRdvVente(b._class) && SC.estDoublon(b); }).length,
  };
}
/* Fiches des RDV (setter de la fiche) : lecture groupée des seuls champs
   utiles (masque de champs). Une fiche fusionnée est remplacée par la fiche
   gardée (_mergedInto, 3 sauts au plus — même règle que Set NB et
   Pilotage), enregistrée sous l'identifiant d'origine. */
const CHAMPS_FICHE = ['setterSlug', 'assignedTo', '_merged', '_mergedInto'];
async function lireFiches(ids) {
  const uniq = Object.keys(ids || {});
  const out = {};
  let echecs = 0;
  if (!uniq.length) return { byId: out, echecs: 0 };
  const LOT = 100;
  async function lire(list) {
    const got = {}, rate = {};
    for (let i = 0; i < list.length; i += LOT) {
      const part = list.slice(i, i + LOT);
      let snaps;
      try {
        const refs = part.map(function (id) { return db.collection('leads').doc(id); });
        if (typeof db.getAll === 'function') snaps = await db.getAll.apply(db, refs.concat([{ fieldMask: CHAMPS_FICHE }]));
        else snaps = await Promise.all(refs.map(function (ref) { return ref.get(); }));
      } catch (e) { part.forEach(function (id) { rate[id] = 1; }); continue; }
      snaps.forEach(function (s) { if (s && s.exists) got[s.id] = s.data() || {}; });
    }
    return { got: got, rate: rate };
  }
  let attente = {};
  uniq.forEach(function (id) { attente[id] = id; });
  for (let sauts = 0; sauts <= 3 && Object.keys(attente).length; sauts++) {
    const cibles = {};
    Object.keys(attente).forEach(function (o) { cibles[attente[o]] = 1; });
    const R = await lire(Object.keys(cibles));
    const suivant = {};
    Object.keys(attente).forEach(function (orig) {
      const cur = attente[orig];
      if (R.rate[cur]) { echecs++; return; }
      const f = R.got[cur];
      if (!f) return;
      if (f._merged === true) { if (f._mergedInto && sauts < 3) suivant[orig] = String(f._mergedInto); return; }
      f._id = cur;
      out[orig] = f;
    });
    attente = suivant;
  }
  return { byId: out, echecs: echecs };
}

/* Agrégat d'une liste de RDV (StatsCore.compter) → champs renvoyés. */
function blocRdv(a) {
  return {
    rdv: a.rdv, annules: a.annules, noshow: a.noshow, presents: a.presents,
    disqua: a.disqua, pitches: a.pitches, offresEnAttente: a.offres, nonCloses: a.nonCloses,
    rdvCloses: a.rdvCloses, sansDetail: a.sansDetail, aStatuer: a.aStatuer, aVenir: a.aVenir,
    kept: a.kept, keptPct: SC.fmtPct(a.keptPct), showUp: SC.fmtPct(a.showUp), tauxNoShow: SC.fmtPct(a.tauxNoShow),
    tauxPitch: SC.fmtPct(a.tauxPitch), tauxAnnulation: SC.fmtPct(a.tauxAnnul),
    replanifies: a.replan, doublonsSupprimes: a.doublons,
  };
}
const DEF_RDV = {
  rdv: 'rdv', annules: 'annules', noshow: 'no_show', presents: 'presents', disqua: 'disqua', pitches: 'pitches',
  offresEnAttente: 'offres_attente', nonCloses: 'non_closes', rdvCloses: 'rdv_closes', sansDetail: 'sans_detail',
  aStatuer: 'a_statuer', aVenir: 'a_venir', kept: ['kept', 'Les RDV à venir sont dans le Kept (champ aVenir).'], keptPct: 'kept_pct',
  showUp: 'show_up', tauxNoShow: 'taux_no_show', tauxPitch: 'taux_pitch', tauxAnnulation: 'taux_annulation',
  replanifies: 'replanifie', doublonsSupprimes: 'doublons_supprimes',
};
const DEF_CLOSES = {
  closes: 'closes', closesSB: 'closes_sb', closesNB: 'closes_nb', contracte: 'contracte', collecte: 'collecte',
  resteAEncaisser: 'reste_a_encaisser', premiersPrelevementsEnAttente: 'premiers_prelevements', panierMoyen: 'panier_moyen',
  collecteParClose: 'collecte_par_close', closesSansPaiement: 'close_sans_paiement', closesAnnules: 'closes_annules',
  canalInconnu: 'canal_inconnu', ecartsCanal: 'ecart_canal', fichesClientesSansVente: 'clientes_sans_vente',
  tauxCloseSurPitches: 'taux_close_pitches', tauxCloseSurPresents: 'taux_close_presents', tauxCloseSurRdv: 'taux_close_rdv',
  montants: 'ht', canal: 'canal', closer: 'closer', setter: 'setter', nonAttribue: 'non_attribue', anciensMembres: 'anciens_membres',
  declare: 'declare_au_close', detail: 'non_attribue_contenu',
};

/* Liste unique des closes d'une période → champs renvoyés (HT, arrondis à
   l'euro à la sortie seulement). */
function blocCloses(CL, ctx, base) {
  const t = FC.sumCloses(CL.rows);
  const sb = FC.sumCloses(CL.rows.filter(function (r) { return r.sb; }));
  const nb = FC.sumCloses(CL.rows.filter(function (r) { return !r.sb; }));
  const raisons = {};
  CL.annules.forEach(function (r) { const k = (r.rv && r.rv.reason) || 'raison inconnue'; raisons[k] = (raisons[k] || 0) + 1; });
  /* Par closer du close, rangé comme Global closing (jour du close). */
  const GC = {};
  CL.rows.forEach(function (r) {
    const rg = ctx.rang ? ctx.rang(r.closer, r.day, 'closer') : { key: ctx.nomDe(r.closer), precision: '' };
    ranger(GC, rg).forEach(function (g) { g.closes.push(r); });
  });
  const parCloser = finir(GC, function (g) {
    const c = FC.sumCloses(g.closes);
    return { closes: c.closes, contracte: arrondi(c.con), collecte: arrondi(c.paid) };
  });
  const liste = CL.rows.slice(0, LISTE_MAX).map(function (r) {
    const o = { jour: r.day, canal: r.sb ? SC.CLASSES.self : SC.CLASSES.setter, closer: ctx.nomDe(r.closer), setter: ctx.nomDe(r.setter),
      contracte: arrondi(r.rv.con), collecte: arrondi(r.rv.paid), leadId: r.leadId || null };
    if (!r.rv.hasPay) { o.sansPaiement = true; if (r.rv.declCol) o.declare = { collecte: arrondi(r.rv.declCol) }; }
    if (r.canalSrc === 'inconnu') o.canalInconnu = true;
    if (r.canalEcart) o.ecartCanal = true;
    return o;
  });
  const out = {
    closes: t.closes, closesSB: sb.closes, closesNB: nb.closes,
    contracte: arrondi(t.con), collecte: arrondi(t.paid), resteAEncaisser: arrondi(t.reste),
    premiersPrelevementsEnAttente: arrondi(t.pending), panierMoyen: arrondi(t.panier), collecteParClose: arrondi(t.collecteParClose),
    montants: 'HT, arrondis à l’euro',
    parCanal: {
      selfBooking: { closes: sb.closes, contracte: arrondi(sb.con), collecte: arrondi(sb.paid) },
      setting: { closes: nb.closes, contracte: arrondi(nb.con), collecte: arrondi(nb.paid) },
    },
    parCloser: parCloser,
    closesSansPaiement: t.sansPaiement,
    closesAnnules: CL.annules.length, closesAnnulesRaisons: raisons,
    canalInconnu: CL.rows.filter(function (r) { return r.canalSrc === 'inconnu'; }).length,
    ecartsCanal: (CL.ecartsCanal || []).length,
    fichesClientesSansVente: (CL.sansSignal || []).length,
    liste: liste,
  };
  if (CL.rows.length > LISTE_MAX) out.listeTronquee = 'liste limitée aux ' + LISTE_MAX + ' premiers closes sur ' + CL.rows.length + ' (les totaux comptent tout)';
  if (base) {
    out.tauxCloseSurPitches = SC.fmtPct(SC.tauxClose(t.closes, base.pitches));
    out.tauxCloseSurPresents = SC.fmtPct(SC.tauxClose(t.closes, base.presents));
    out.tauxCloseSurRdv = SC.fmtPct(SC.tauxClose(t.closes, base.rdv));
  }
  return out;
}
function avertCloses(CL) {
  const a = [];
  if (CL.erreur) a.push('Closes : lecture incomplète — ' + CL.erreur + '. Closes, contracté et collecté peuvent être sous-estimés.');
  if (CL.tronque) a.push('Closes : plafond de lecture des clients gagnés atteint (' + FC.CLOSED_LEADS_LIMIT + ') — liste tronquée, réduire la période.');
  return a;
}

const RANGE_PROPS = {
  from: { type: 'string', description: 'Début AAAA-MM-JJ, heure de Paris (défaut : il y a 29 jours — « 30 jours » = aujourd\'hui et les 29 jours précédents)' },
  to: { type: 'string', description: 'Fin incluse AAAA-MM-JJ, heure de Paris (défaut : aujourd\'hui)' },
};

const TOOLS = [
  {
    name: 'leads_stats',
    description: 'Leads ENTRÉS sur une période (date d\'entrée réelle, comme le Stats funnel : la plus ancienne entre webinaire, import et création ; fiches fusionnées et fiches de test retirées), ventilés par provenance (page / tunnel / quiz / VSL), par setter de la fiche et par statut actuel. Renvoie aussi les ré-optins (à part, jamais additionnés aux leads), les RDV pris de la période et le LTB (RDV pris ÷ leads entrés) tel qu\'affiché au Stats funnel. Champ `definitions` : le texte de chaque chiffre. Pour « combien de leads… », « d\'où viennent les leads… », « quel LTB… ».',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const ctx = await contexte();
      const D = {};
      const avert = ctx.avert.slice();
      let leadsOk = true;
      const [, crees] = await Promise.all([
        FC.loadLeads(db, { start: r.start, end: r.end }, D).catch(function () { leadsOk = false; }),
        lireRdvCrees(r, ctx).catch(function (e) { avert.push('RDV pris illisibles (' + ((e && e.message) || 'lecture impossible') + ') : LTB non calculé.'); return null; }),
      ]);
      if (!leadsOk || D.leadsError) return { periode: r.label, error: 'Lecture des leads impossible : ' + (D.leadsError || 'erreur inconnue') + '. Aucun chiffre renvoyé plutôt qu\'un chiffre faux.' };
      if (D.leadsTruncated) avert.push('Leads : plafond de lecture atteint — total tronqué, réduire la période.');
      if (D.reoptinsError) avert.push('Ré-optins illisibles (' + D.reoptinsError + ').');
      if (D.reoptinsTruncated) avert.push('Ré-optins : plafond de lecture atteint — total tronqué.');
      const leads = D.leads || [];
      const bySrc = {}, bySetter = {}, byStatus = {};
      leads.forEach(function (l) {
        inc(bySrc, srcOf(l), 'leads'); inc(bySetter, ctx.nomDe(l.setterSlug || l.assignedTo), 'leads'); inc(byStatus, l.status || 'nouveau', 'leads');
        if (l.aiLead && l.aiLead.niveau === 'chaud') inc(bySrc, srcOf(l), 'chauds');
      });
      const out = { periode: r.label, leads: leads.length, reoptins: D.reoptinsError ? null : (D.reoptins || []).length, fichesDeTest: D.leadsTest || 0,
        parProvenance: bySrc, parSetterDeLaFiche: bySetter, parStatutActuel: byStatus };
      if (crees) {
        const P = blocPris(crees);
        out.rdvPris = P.rdvPris;
        out.ltb = SC.fmtPct(leads.length > 0 ? P.rdvPris / leads.length * 100 : null);
      }
      if (avert.length) out.avertissements = avert;
      out.definitions = definitions({ leads: 'leads', reoptins: 'reoptins', fichesDeTest: 'fiches_test', parProvenance: ['leads', 'Ventilés par page / tunnel / quiz d\'entrée.'],
        parSetterDeLaFiche: 'leads_setter_fiche', parStatutActuel: 'leads_statut', chauds: 'leads_chauds', rdvPris: 'rdv_pris', ltb: 'ltb', nonAttribue: 'non_attribue', anciensMembres: 'anciens_membres' });
      return out;
    },
  },
  {
    name: 'bookings_stats',
    description: 'Chiffres commerciaux d\'une période, mêmes règles et mêmes mots que le Stats funnel, Set NB, Close SB et Global closing. ' +
      '`rdv` : RDV de vente dont la DATE tombe dans la période (Self Booking + Setting + Manuels ; replanifiés et doublons hors compte, donnés à part) — rdv = annules + noshow + presents + aStatuer + aVenir ; presents = disqua + pitches + sansDetail ; pitches = offresEnAttente + nonCloses + rdvCloses ; kept = rdv − annules ; showUp = presents ÷ (kept − aVenir) ; parts parCanal.selfBooking / setting / manuels (manuels seulement s\'il y en a). ' +
      '`pris` : RDV PRIS (créés) pendant la période — rdvPris = selfBooking + sets ; les sets sont rangés chez le setter du RDV (setter du close, sinon setter de la fiche, sinon la personne qui l\'a posé, sinon la personne assignée). ' +
      '`closes` : la liste unique des clients gagnés pendant la période (un par client, daté du jour de la vente, closes annulés retirés) — closes, contracte, collecte (prélèvements passés à ce jour sur ces clients), resteAEncaisser, premiersPrelevementsEnAttente, panierMoyen, collecteParClose, taux de close (closes ÷ pitchés / présents / RDV, « — » quand il n\'a pas de sens), parCloser, parCanal, liste (jour, canal, closer, setter, montants, leadId). Montants HT. ' +
      '`parCloser` (RDV par closer du RDV, + closes du closer) et `parSetter` (RDV du setting par setter + sets + closes Setting) : une ligne par onglet de Global closing / Set NB, le reste sur la ligne « Non attribué » (ancien membre, personne sans onglet comme un admin, élément daté d\'avant l\'arrivée de la personne, personne inconnue), dont le contenu est dans `detail`. Jamais de montant déclaré sous « contracté / collecté » : un close sans paiement porte `sansPaiement` et, au besoin, `declare`. ' +
      'Champ `definitions` : le texte de l\'écran pour chaque chiffre ; `avertissements` : lecture incomplète à signaler. Pour les RDV, le show-up, les closes, le taux de close, le contracté et le collecté.',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const ctx = await contexte();
      const avert = ctx.avert.slice();
      const now = Date.now();
      const [liste, crees] = await Promise.all([
        lireRdvDates(r.from, r.to, ctx),
        lireRdvCrees(r, ctx).catch(function (e) { avert.push('RDV pris illisibles (' + ((e && e.message) || 'lecture impossible') + ') : bloc « pris » absent.'); return null; }),
      ]);
      const vente = liste.filter(function (b) { return SC.estRdvVente(b._class); });
      const tot = SC.compter(vente, now);
      const parts = {
        selfBooking: SC.compter(vente.filter(function (b) { return b._class === 'self'; }), now),
        setting: SC.compter(vente.filter(function (b) { return b._class === 'setter'; }), now),
        manuels: SC.compter(vente.filter(function (b) { return b._class === 'admin'; }), now),
      };
      const P = crees ? blocPris(crees) : null;

      /* Closes : la liste unique, avec les RDV de la période déjà lus. */
      const CL = await FC.loadCloses(db, { start: r.start, end: r.end, typeMap: ctx.typeMap, bookings: liste, resoudrePersonne: ctx.resoudre });
      avertCloses(CL).forEach(function (a) { avert.push(a); });

      /* Fiches des RDV du setting (setter de la fiche) — date et création. */
      const ids = {};
      vente.forEach(function (b) { if (b._class === 'setter' && b.leadId) ids[b.leadId] = 1; });
      if (P) P.pris.forEach(function (b) { if (b._class === 'setter' && b.leadId) ids[b.leadId] = 1; });
      const F = await lireFiches(ids);
      if (F.echecs) avert.push('Fiches de ' + F.echecs + ' RDV du setting illisibles : rangées d\'après le RDV seul (setter du close, puis personne qui l\'a posé).');
      function setterSlugDe(b) { return SC.setterDuRdv(b, b.leadId ? (F.byId[b.leadId] || null) : null); }

      /* Vues par personne : StatsCore.rangPersonne (ctx.rang) — onglet pour un
         membre de la vue, sinon la ligne « Non attribué » (ancien membre,
         « Prénom (hors onglets) », « Prénom (avant son arrivée) », inconnu),
         avec son détail. Mêmes lignes que Set NB, Global closing, Dashboard. */

      /* Par closer (vue Global closing) : RDV de vente au closer du RDV (jour = date du RDV), closes au closer du close (jour du close). */
      const GC = {};
      vente.forEach(function (b) { ranger(GC, ctx.rang(SC.closerDuRdv(b, ctx.resoudre), b.date, 'closer')).forEach(function (g) { g.rdv.push(b); }); });
      CL.rows.forEach(function (row) { ranger(GC, ctx.rang(row.closer, row.day, 'closer')).forEach(function (g) { g.closes.push(row); }); });
      const parCloser = finir(GC, function (g) {
        const a = SC.compter(g.rdv, now);
        const c = FC.sumCloses(g.closes);
        return { rdv: a.rdv, annules: a.annules, noshow: a.noshow, presents: a.presents, pitches: a.pitches, aStatuer: a.aStatuer, aVenir: a.aVenir,
          kept: a.kept, showUp: SC.fmtPct(a.showUp), closes: c.closes, contracte: arrondi(c.con), collecte: arrondi(c.paid),
          tauxCloseSurPitches: SC.fmtPct(SC.tauxClose(c.closes, a.pitches)) };
      });

      /* Par setter (vue Set NB) : RDV NB au setter du RDV (jour = date du RDV), sets au setter du RDV (jour de création, Paris),
         closes Setting au setter du close (jour du close). */
      const GS = {};
      vente.forEach(function (b) {
        if (b._class !== 'setter') return;
        ranger(GS, ctx.rang(setterSlugDe(b), b.date, 'setter')).forEach(function (g) { g.rdv.push(b); });
      });
      if (P) P.pris.forEach(function (b) {
        if (b._class !== 'setter') return;
        ranger(GS, ctx.rang(setterSlugDe(b), jourCreation(b), 'setter')).forEach(function (g) { g.sets++; });
      });
      CL.rows.forEach(function (row) {
        if (row.sb) return;
        ranger(GS, ctx.rang(row.setter, row.day, 'setter')).forEach(function (g) { g.closes.push(row); });
      });
      const parSetter = finir(GS, function (g) {
        const a = SC.compter(g.rdv, now);
        const c = FC.sumCloses(g.closes);
        return { sets: P ? g.sets : null, rdvNB: a.rdv, presents: a.presents, pitches: a.pitches, closesNB: c.closes, contracte: arrondi(c.con), collecte: arrondi(c.paid) };
      });

      const out = {
        periode: r.label,
        rdv: Object.assign(blocRdv(tot), { parCanal: { selfBooking: blocRdv(parts.selfBooking), setting: blocRdv(parts.setting) } }),
      };
      if (parts.manuels.total > 0) out.rdv.parCanal.manuels = blocRdv(parts.manuels);
      if (P) out.pris = { rdvPris: P.rdvPris, selfBooking: P.selfBooking, sets: P.sets, manuelsCrees: P.manuelsCrees, remplacantsCrees: P.remplacantsCrees, doublonsSupprimes: P.doublonsSupprimes };
      out.closes = blocCloses(CL, ctx, tot);
      out.parCloser = parCloser;
      out.parSetter = parSetter;
      if (avert.length) out.avertissements = avert;
      out.definitions = Object.assign(
        definitions(DEF_RDV),
        definitions(DEF_CLOSES),
        definitions({ parCanal: 'canal', rdvSB: 'rdv_sb', rdvNB: 'rdv_nb', manuels: 'rdv_manuels', rdvPris: 'rdv_pris', sets: 'sets',
          manuelsCrees: 'manuels_crees', remplacantsCrees: 'rdv_remplacants_crees', parCloser: ['closer', 'Dans parCloser : RDV au closer du RDV, closes au closer du close.'],
          parSetter: ['setter', 'Dans parSetter : RDV du setting (rdvNB) et sets au setter du RDV, closes Setting (closesNB) au setter du close.'], detail: 'non_attribue_contenu',
          lectureIncomplete: 'lecture_incomplete', heureParis: 'heure_paris' })
      );
      return out;
    },
  },
  {
    name: 'calls_stats',
    description: 'Appels téléphoniques (Ringover) sur la période, même périmètre que le Stats funnel : équipe sales (setters, closers, admins, anciens membres compris) + appels sans auteur. Par membre (auteur = compte relié à l\'appel, sinon prénom Ringover ; ligne « Non attribué » = appels sans auteur + appels datés d\'avant l\'arrivée d\'un membre, détaillés dans parPersonne[« Non attribué »].detail ; anciens membres sur « Anciens membres ») : appels (SORTANTS seulement), décrochés (au moins 5 s de conversation, répondeurs écartés), taux de décroché, temps d\'appel (conversation des sortants décrochés, en minutes), appels reçus (entrants, à part), note IA moyenne des appels analysés. `equipe` = somme des lignes de parPersonne. Les appels de la CSM et des coachs sont à part dans `horsEquipeSales` : jamais dans equipe. Champ `definitions`.',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const ctx = await contexte();
      const s = await db.collection('call_logs').where('initiatedAt', '>=', r.start).where('initiatedAt', '<=', r.end).get();
      /* Périmètre du Stats funnel (ctx.auteurAppel) : équipe sales + sans
         auteur dans equipe ; CSM / coachs à part (horsEquipeSales). */
      const groupes = {}, notes = {}, details = {};
      let sansSens = 0;
      const tous = [], hors = [];
      s.forEach(function (d) {
        const c = d.data() || {};
        if (c.direction !== 'outbound' && c.direction !== 'inbound') sansSens++;
        const a = ctx.auteurAppel(c);
        if (a.perim === 'hors') { hors.push(c); return; }
        const k = a.key;
        (groupes[k] = groupes[k] || []).push(c);
        if (a.precision) { const gd = (details[k] = details[k] || {}); (gd[a.precision] = gd[a.precision] || []).push(c); }
        tous.push(c);
        if (c.aiCall && c.aiCall.notation) { inc(notes, k, 'n'); inc(notes, k, 'somme', Number(c.aiCall.notation.score) || 0); }
      });
      function bloc(list, k) {
        const st = FC.callStats(list);
        const o = { appels: st.out, decroches: st.answered, tauxDecroche: SC.fmtPct(SC.pct(st.answered, st.out)),
          tempsAppelMin: Math.round(st.talkSec / 60), dureeMoyenneMin: st.answered ? Math.round(st.talkSec / st.answered / 6) / 10 : null,
          appelsRecus: st.inbound, appelsRecusDecroches: st.inboundAnswered };
        if (k && notes[k] && notes[k].n) o.noteIAMoyenne = Math.round(notes[k].somme / notes[k].n);
        return o;
      }
      const parPersonne = {};
      Object.keys(groupes).forEach(function (k) {
        parPersonne[k] = bloc(groupes[k], k);
        /* Détail de « Non attribué » : appels datés d'avant l'arrivée d'un membre. */
        if (details[k]) {
          parPersonne[k].detail = {};
          Object.keys(details[k]).forEach(function (pr) { parPersonne[k].detail[pr] = bloc(details[k][pr], null); });
        }
      });
      const out = { periode: r.label, equipe: bloc(tous, null), parPersonne: parPersonne };
      if (hors.length) out.horsEquipeSales = bloc(hors, null);
      const avert = ctx.avert.slice();
      if (sansSens) avert.push(sansSens + ' appel(s) sans sens (entrant / sortant) enregistré : comptés nulle part.');
      if (avert.length) out.avertissements = avert;
      out.definitions = definitions({ appels: 'appels', decroches: 'decroches', tauxDecroche: 'taux_decroche', tempsAppelMin: ['temps_appel', 'En minutes.'],
        dureeMoyenneMin: ['duree_moyenne_appel', 'En minutes.'], appelsRecus: 'appels_recus', appelsRecusDecroches: 'appels_recus_decroches',
        noteIAMoyenne: 'note_ia_appel', equipe: ['equipe', 'Ici : équipe sales et appels sans auteur, comme le Stats funnel.'], horsEquipeSales: 'hors_equipe_sales', nonAttribue: ['non_attribue', 'Ici : appels sans auteur (poste relié à aucun compte) et appels datés d’avant l’arrivée d’un membre ; le champ detail donne la part de chaque cas « Prénom (avant son arrivée) ».'], detail: 'non_attribue_contenu', anciensMembres: 'anciens_membres', sansSens: 'appels_sens_inconnu' });
      return out;
    },
  },
  {
    name: 'search_leads',
    description: 'Cherche des leads par nom, email ou téléphone (30 résultats max, fiches fusionnées exclues). Renvoie statut, provenance, score IA, date d\'entrée réelle (heure de Paris), client ou non.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async function (i) {
      const q = String(i.query || '').trim().toLowerCase();
      if (q.length < 2) return { error: 'requête trop courte' };
      const digits = q.replace(/\D/g, '');
      let snap;
      if (digits.length >= 9) snap = await db.collection('leads').where('phoneNormalized', '==', digits.slice(-9)).limit(10).get();
      else if (q.indexOf('@') > 0) snap = await db.collection('leads').where('email', '==', q).limit(10).get();
      else snap = await db.collection('leads').orderBy('createdAt', 'desc').limit(3000).get();
      const eq = construireContexte({}, {}, await FC.loadTeamMembers(db), []);
      const out = [];
      snap.forEach(function (d) {
        if (out.length >= 30) return;
        const l = d.data() || {};
        if (l._merged) return;
        if (digits.length < 9 && q.indexOf('@') < 0 && String(l.nom || '').toLowerCase().indexOf(q) < 0) return;
        const entree = FC.realEntryMs(l) || tsToMs(l.createdAt);
        out.push({ id: d.id, nom: l.nom, email: l.email, telephone: l.telephone, statut: l.status || 'nouveau', etape: l.stage || null, provenance: srcOf(l),
          scoreIA: l.aiLead ? l.aiLead.proba : null, assigne: (l.setterSlug || l.assignedTo) ? eq.nomDe(l.setterSlug || l.assignedTo) : null, entree: entree ? parisDate(entree) : null, client: !!l.isClient,
          ficheDeTest: l.interne === true || undefined });
      });
      const res = { resultats: out };
      if (digits.length < 9 && q.indexOf('@') < 0) res.note = 'Recherche par nom sur les 3 000 fiches les plus récentes seulement.';
      return res;
    },
  },
  {
    name: 'get_lead',
    description: 'Dossier d\'un lead par son id : fiche, brief IA, dernier appel analysé, notes récentes, RDV (avec leur état sous les mots des écrans : Annulé, No-show, Close, Non close, Offre en attente, Disqualifié, À statuer, À venir, Replanifié…).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async function (i) {
      const s = await db.collection('leads').doc(String(i.id)).get();
      if (!s.exists) return { error: 'lead introuvable' };
      const l = s.data() || {};
      const bs = await db.collection('bookings').where('leadId', '==', s.id).get();
      const rdv = [];
      const now = Date.now();
      bs.forEach(function (d) {
        const b = d.data() || {};
        rdv.push({ date: b.date, heure: b.time, avec: b.personName, etat: SC.libelle(b, now).mot, note: cap(b.outcomeNote || '', 200) });
      });
      rdv.sort(function (a, b) { return String(a.date) + String(a.heure) < String(b.date) + String(b.heure) ? -1 : 1; });
      const entree = FC.realEntryMs(l) || tsToMs(l.createdAt);
      return { id: s.id, nom: l.nom, email: l.email, telephone: l.telephone, statut: l.status, etape: l.stage, provenance: srcOf(l), secteur: l.secteur, defi: cap(l.defi || '', 300),
        entree: entree ? parisDate(entree) : null, fusionnee: l._merged === true || undefined,
        briefIA: l.aiLead || null, dernierAppel: l.aiLastCall ? { resume: l.aiLastCall.resume, resultat: l.aiLastCall.resultat } : null,
        notes: (l.notesHistory || []).slice(-5).map(function (n) { return cap(n.text, 200); }), rdv: rdv };
    },
  },
  {
    name: 'clients_risk',
    description: 'Portefeuille coaching : clients actifs par feu (rouge / orange / vert) avec les raisons, et opportunités de renouvellement / upsell (calculés chaque nuit). Champ `definitions`.',
    input_schema: { type: 'object', properties: { niveau: { type: 'string', enum: ['rouge', 'orange', 'vert', 'tous'] } }, additionalProperties: false },
    run: async function (i) {
      const s = await db.collection('client_ai').get();
      const counts = { rouge: 0, orange: 0, vert: 0 };
      const list = [], opps = [];
      s.forEach(function (d) {
        const a = d.data() || {};
        if (!a.risk) return;
        counts[a.risk.level] = (counts[a.risk.level] || 0) + 1;
        if (!i.niveau || i.niveau === 'tous' || i.niveau === a.risk.level) list.push({ client: a.nom, niveau: a.risk.level, coach: a.coach, raisons: a.risk.reasons });
        if (a.opportunity) opps.push({ client: a.nom, type: a.opportunity.type, finDansJours: a.opportunity.daysToEnd, argument: a.opportunity.argument });
      });
      const out = { compteurs: counts, clients: list.slice(0, 60), opportunites: opps.slice(0, 30) };
      if (list.length > 60) out.listeTronquee = 'clients limités aux 60 premiers sur ' + list.length + ' (les compteurs comptent tout)';
      if (opps.length > 30) out.opportunitesTronquees = 'opportunités limitées aux 30 premières sur ' + opps.length;
      out.definitions = definitions({ compteurs: 'feu_client' });
      return out;
    },
  },
  {
    name: 'unpaid_summary',
    description: 'Impayés (même règle que le module Impayés) : plans de paiement avec un problème — mandat ou paiement en échec, dernier prélèvement rejeté non rattrapé, échéances en retard, facturation en procédure, dossier en recouvrement. Pour chaque dossier : resteDuTTC (contrat TTC − déjà prélevé, TOUTES échéances comprises, y compris futures), resteDuHT (le même hors taxes), echeancesEnRetard et montantEnRetardTTC (échéances déjà arrivées et non prélevées, plans en plusieurs fois seulement), état du recouvrement. Totaux : resteDuTotalTTC, resteDuTotalHT, montantEnRetardTotalTTC. Champ `definitions`.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function () {
      const today = parisDate(Date.now());
      const avert = [];
      const eq = construireContexte({}, {}, await FC.loadTeamMembers(db), []);
      const [s, ic] = await Promise.all([
        db.collection('payments').get(),
        db.collection('invoice_clients').where('clientStatus', '==', 'procedure').get().catch(function (e) {
          avert.push('Fiches de facturation illisibles (' + ((e && e.message) || 'lecture impossible') + ') : les dossiers « facturation en procédure » peuvent manquer.');
          return null;
        }),
      ]);
      const procByCustomer = {}, procByEmail = {};
      if (ic) ic.forEach(function (d) {
        const x = d.data() || {};
        if (x.gcCustomerId) procByCustomer[x.gcCustomerId] = 1;
        if (x.gocardlessCustomerId) procByCustomer[x.gocardlessCustomerId] = 1;
        if (x.email) procByEmail[String(x.email).toLowerCase()] = 1;
      });
      function moisDepuis(dateStr) {
        const a = String(dateStr).slice(0, 10).split('-').map(Number), b = today.split('-').map(Number);
        if (a.length < 3 || a.some(isNaN)) return 0;
        return (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
      }
      const out = [];
      let dueTTC = 0, dueHT = 0, retardTTC = 0;
      s.forEach(function (d) {
        const p = d.data() || {};
        if (p.status === 'draft' || p.status === 'cancelled') return;
        const motifs = [];
        if (p.status === 'mandate_failed') motifs.push('mandat en échec');
        if (p.status === 'failed') motifs.push('paiement en échec');
        const f = p.lastPaymentFailure;
        if (f && f.at) {
          const fMs = tsToMs(f.at);
          const rattrape = (p.paymentsHistory || []).some(function (h) { return tsToMs(h.eventAt || h.date) > fMs; });
          if (!rattrape) motifs.push('prélèvement rejeté le ' + parisDate(fMs) + ' non rattrapé');
        }
        let retard = 0;
        if ((p.status === 'active' || p.status === 'mandate_active') && Number(p.installmentsCount) > 1 && p.startDate) {
          const attendu = Math.min(Number(p.installmentsCount), Math.max(0, moisDepuis(p.startDate)) + 1);
          retard = Math.max(0, attendu - (Number(p.paidCount) || 0));
          if (retard >= 1) motifs.push(retard + ' échéance(s) en retard');
        }
        if (procByCustomer[p.gcCustomerId] || procByEmail[String(p.leadEmail || '').toLowerCase()]) motifs.push('facturation en procédure');
        const rec = p.recouvrement && p.recouvrement.status ? p.recouvrement.status : null;
        if (!motifs.length && !rec) return;
        const restTTC = Math.max(0, (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0));
        const restHT = FC.revHT(p, restTTC);
        const enRetard = retard > 0 && Number(p.installmentAmount) > 0 ? retard * Number(p.installmentAmount) : null;
        dueTTC += restTTC; dueHT += restHT; if (enRetard) retardTTC += enRetard;
        out.push({ client: p.leadName, statut: p.status, motifs: motifs, resteDuTTC: arrondi(restTTC), resteDuHT: arrondi(restHT),
          echeancesEnRetard: retard || 0, montantEnRetardTTC: arrondi(enRetard),
          dernierRejet: f && f.at ? parisDate(tsToMs(f.at)) : null, recouvrement: rec, closer: p.closerSlug ? eq.nomDe(p.closerSlug) : eq.nomEnClair(p.closerName) });
      });
      out.sort(function (a, b) { return b.resteDuTTC - a.resteDuTTC; });
      const res = { dossiers: out.length, resteDuTotalTTC: arrondi(dueTTC), resteDuTotalHT: arrondi(dueHT), montantEnRetardTotalTTC: arrondi(retardTTC), liste: out.slice(0, 40) };
      if (out.length > 40) res.listeTronquee = 'liste limitée aux 40 plus gros dossiers sur ' + out.length + ' (les totaux comptent tout)';
      if (avert.length) res.avertissements = avert;
      res.definitions = definitions({ dossiers: 'dossiers_impayes', resteDuTTC: 'reste_du_ttc', resteDuHT: 'reste_du_ht', echeancesEnRetard: 'echeances_en_retard', montantEnRetardTTC: 'montant_en_retard' });
      return res;
    },
  },
  {
    name: 'objections_top',
    description: 'Objections les plus fréquentes détectées par l\'IA (closings et appels de setting) sur N jours, avec le nombre de levées et de RDV closés où elles sont apparues (`rdvCloses` : ce n\'est pas « Closes »). Champ `definitions`.',
    input_schema: { type: 'object', properties: { jours: { type: 'integer' } }, additionalProperties: false },
    run: async function (i) {
      const days = Math.max(1, Math.min(365, Number(i.jours) || 90));
      const depuis = SC.debutJourParis(decaler(parisDate(Date.now()), -(days - 1))).getTime();
      const s = await db.collection('ai_objections').where('at', '>=', depuis).get();
      const by = {};
      s.forEach(function (d) { const o = d.data() || {}; inc(by, o.category, 'total'); if (o.worked) inc(by, o.category, 'levees'); if (o.outcome === 'close') inc(by, o.category, 'rdvCloses'); });
      return { jours: days, depuis: parisDate(depuis), parCategorie: by, definitions: definitions({ parCategorie: 'objections' }) };
    },
  },
  {
    name: 'ai_usage',
    description: 'Consommation de l\'IA ce mois-ci, mois de Paris (coût en dollars, nombre d\'appels, par tâche).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function () {
      const k = SC.moisParis(Date.now());
      const s = await db.collection('ai_usage_months').doc(k).get();
      const out = s.exists ? Object.assign({}, s.data()) : { month: k, costUsd: 0, calls: 0 };
      out.definitions = definitions({ costUsd: 'conso_ia' });
      return out;
    },
  },
  {
    name: 'today_agenda',
    description: 'Agenda d\'un jour (défaut aujourd\'hui, heure de Paris) : RDV commerciaux (canal Self Booking / Setting / Manuel, closer) et RDV coaching, avec heure, personne, prospect / client et état sous les mots des écrans (À venir, À statuer, Présent, Close, No-show, Annulé, Replanifié…). Les doublons supprimés sont retirés (comptés à part).',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'AAAA-MM-JJ' } }, additionalProperties: false },
    run: async function (i) {
      const date = jourValide(i.date) ? i.date : parisDate(Date.now());
      const ctx = await contexte();
      const s = await db.collection('bookings').where('date', '==', date).get();
      const out = [];
      const now = Date.now();
      let doublons = 0;
      s.forEach(function (d) {
        const b = d.data() || {};
        if (SC.estDoublon(b)) { doublons++; return; }
        const cls = SC.classifyBooking(b, ctx.typeMap);
        const vente = SC.estRdvVente(cls);
        const o = { heure: b.time, type: vente ? 'commercial' : 'coaching / hors vente', libelle: b.typeLabel || b.type, avec: b.personName, personne: nomProspect(b), etat: SC.libelle(b, now).mot };
        if (vente) { o.canal = SC.CLASSES[cls]; o.closer = ctx.nomDe(SC.closerDuRdv(b, ctx.resoudre)); }
        out.push(o);
      });
      out.sort(function (a, b) { return String(a.heure) < String(b.heure) ? -1 : 1; });
      const res = { date: date, rdv: out };
      if (doublons) res.doublonsSupprimes = doublons;
      if (ctx.avert.length) res.avertissements = ctx.avert;
      res.definitions = definitions({ canal: 'canal', closer: 'closer', a_statuer: 'a_statuer', a_venir: 'a_venir', doublonsSupprimes: 'doublons_supprimes', heureParis: 'heure_paris' });
      return res;
    },
  },
];

const BY_NAME = {};
TOOLS.forEach(function (t) { BY_NAME[t.name] = t; });

/** Définitions au format Messages API (tools[]). */
function claudeTools() {
  return TOOLS.map(function (t) { return { name: t.name, description: t.description, input_schema: t.input_schema }; });
}

async function runTool(name, input) {
  const t = BY_NAME[name];
  if (!t) return { error: 'outil inconnu : ' + name };
  try { return await t.run(input || {}); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
}

module.exports = {
  TOOLS: TOOLS, claudeTools: claudeTools, runTool: runTool,
  /* Partagés avec le brief du matin (api/ai-morning-brief.js) : mêmes
     règles, mêmes mots. */
  contexte: contexte, construireContexte: construireContexte, lireRdvDates: lireRdvDates, blocRdv: blocRdv, blocCloses: blocCloses, avertCloses: avertCloses,
  definitions: definitions, DEF_RDV: DEF_RDV, DEF_CLOSES: DEF_CLOSES, range: range, decaler: decaler,
};
