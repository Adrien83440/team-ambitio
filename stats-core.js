// ============================================================================
// stats-core.js — RÈGLES UNIQUES DES CHIFFRES COMMERCIAUX (25/11/2026)
// ----------------------------------------------------------------------------
// Audit de cohérence du 25/11/2026 (demande d'Adrien, retours de Vincent) :
// 1 026 chiffres relevés sur tous les écrans, le même mot calculé de plusieurs
// façons selon la page. Ce fichier est désormais LA source des règles :
//
//   · classe d'un RDV (Self Booking / Setting / Manuel / exclu) ;
//   · état d'un RDV (replanifié, annulé, no-show, présent, à statuer, à venir)
//     — un RDV n'a qu'UN état, donc les colonnes s'additionnent toujours ;
//   · Kept, Show-up, taux de pitch, taux de close : une seule formule ;
//   · le GLOSSAIRE : un mot = un calcul = un texte d'explication, le même sur
//     tous les écrans (le petit « i » à côté de chaque chiffre) ;
//   · le composant « i » lui-même (survol, clic, clavier).
//
// ⚠ RÈGLE ABSOLUE : aucune page ne recode un de ces prédicats. alteore-flow.js
// et funnel-core.js délèguent ici ; les pages passent par eux ou par StatsCore.
// Changer une règle = la changer ICI, et tous les écrans suivent.
//
// Partagé navigateur ↔ serveur (même format que funnel-core.js). Aucune
// dépendance : ni Firebase, ni DOM pour les règles (le « i » n'utilise le DOM
// que dans un navigateur). ES5 strict.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StatsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════
     0. RÉGLAGES DU RÉFÉRENTIEL
     ══════════════════════════════════════════════════════════════════════ */

  /* Date d'un close. 'vente' : le jour où le client est gagné (leads.clientSince,
     posé une fois à la signature ou à la validation du close) — c'est la règle
     du Stats funnel, des Projections et du mois de commission. 'rdv' : le jour
     du RDV qui porte le close. UNE seule valeur pour tous les écrans. */
  var CLOSE_AXE = 'vente';

  /* Colonnes qu'une correction manuelle ✎ a encore le droit de remplacer :
     celles qui n'ont pas de source corrigible (téléphonie, actions de fiche).
     Les colonnes tirées des RDV et du module Paiements se corrigent à la
     source (résultat du RDV, paiement) : là seulement elles changent partout. */
  var CORRECTIONS_AUTORISEES = { tel: 1, dm: 1, act: 1 };   /* groupes de colonnes : téléphone, messages, actions de fiche */

  var DUREE_DEFAUT_MIN = 30;

  /* ══════════════════════════════════════════════════════════════════════
     1. TEMPS — toujours l'heure de Paris, quel que soit l'appareil
     ══════════════════════════════════════════════════════════════════════ */
  var _fmt = null;
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function toDate(d) {
    if (d == null) return new Date();
    if (d instanceof Date) return d;
    if (typeof d === 'number') return new Date(d);
    if (d && typeof d.toDate === 'function') return d.toDate();
    if (d && typeof d.seconds === 'number') return new Date(d.seconds * 1000);
    if (d && typeof d._seconds === 'number') return new Date(d._seconds * 1000);
    return new Date(d);
  }
  function parisParts(d) {
    var o = {};
    if (!_fmt) {
      _fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      });
    }
    _fmt.formatToParts(toDate(d)).forEach(function (p) { o[p.type] = p.value; });
    if (o.hour === '24') o.hour = '00';
    return o;
  }
  /* 'AAAA-MM-JJ' à Paris. */
  function jourParis(d) { var o = parisParts(d); return o.year + '-' + o.month + '-' + o.day; }
  /* 'AAAA-MM' à Paris. */
  function moisParis(d) { var o = parisParts(d); return o.year + '-' + o.month; }

  /* Début du RDV en millisecondes : bookings.date ('AAAA-MM-JJ') et
     bookings.time ('HH:MM') sont des heures de Paris. NaN si illisible. */
  function debutMs(b) {
    if (!b || !b.date) return NaN;
    var p = String(b.date).split('-');
    var t = String(b.time || '').split(':');
    var hh = t[0] !== '' && !isNaN(+t[0]) ? +t[0] : 0;
    var mm = t[1] != null && !isNaN(+t[1]) ? +t[1] : 0;
    var guess = Date.UTC(+p[0], +p[1] - 1, +p[2], hh, mm);
    if (isNaN(guess)) return NaN;
    var o = parisParts(new Date(guess));
    var asParis = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute);
    return guess - (asParis - guess);
  }
  /* Fin du créneau : début + durée (30 min par défaut, comme l'Agenda). */
  function finMs(b) {
    var s = debutMs(b);
    if (isNaN(s)) return NaN;
    var dur = Number(b.duration) > 0 ? Number(b.duration) : DUREE_DEFAUT_MIN;
    return s + dur * 60000;
  }
  /* Une date construite à l'heure de PARIS (mois de 0 à 11), quel que soit le
     fuseau de l'appareil ou du serveur : le 1er du mois à 00:00 est le même
     instant pour l'équipe, pour une média buyeuse à l'étranger et pour une
     Vercel Function (qui tourne en UTC). */
  function dateParis(y, m0, d, hh, mi, ss, ms) {
    var guess = Date.UTC(y, m0, d == null ? 1 : d, hh || 0, mi || 0, ss || 0, ms || 0);
    var o = parisParts(new Date(guess));
    var asParis = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, ss || 0, ms || 0);
    var out = new Date(guess - (asParis - guess));
    /* Changement d'heure : une seconde passe corrige le décalage résiduel. */
    var o2 = parisParts(out);
    var asParis2 = Date.UTC(+o2.year, +o2.month - 1, +o2.day, +o2.hour, +o2.minute, ss || 0, ms || 0);
    if (asParis2 !== guess) out = new Date(out.getTime() - (asParis2 - guess));
    return out;
  }
  /* Début (00:00:00.000) et fin (23:59:59.999) d'un jour 'AAAA-MM-JJ' à Paris. */
  function debutJourParis(iso) { var p = String(iso).split('-'); return dateParis(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0); }
  function finJourParis(iso) { var p = String(iso).split('-'); return dateParis(+p[0], +p[1] - 1, +p[2], 23, 59, 59, 999); }

  /* Un RDV est « passé » quand son créneau est terminé — le même seuil que le
     bouton Résultat de l'Agenda. Sans heure lisible : passé dès le lendemain. */
  function estPasse(b, now) {
    now = now || Date.now();
    if (!b || !b.date) return false;
    if (!b.time) return String(b.date) < jourParis(now);
    var f = finMs(b);
    if (isNaN(f)) return String(b.date) < jourParis(now);
    return now > f;
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. CLASSE D'UN RDV — Self Booking / Setting (NB) / Manuel / exclu
     ══════════════════════════════════════════════════════════════════════
     Règle « deux liens » (Adrien, 15/07/2026) : le TYPE de consultation prime
     sur un ancien source 'self_booking' — un RDV pris sur le lien d'un setter
     (type isSetterOnly) est Setting.
       'excluded' → coaching, RDV CSM, client existant, skipLeadCreation
       'admin'    → créé à la main dans l'Agenda (« Manuel »)
       'setter'   → Setting (No Booking)
       'self'     → Self Booking
     typeMap : { typeId: { isSetterOnly, isCoaching } } (booking_config/_types). */
  function classifyBooking(b, typeMap) {
    b = b || {};
    var t = (typeMap || {})[b.type] || {};
    if (b.isCoaching === true || t.isCoaching === true) return 'excluded';
    if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return 'excluded';
    if (b.source === 'admin_manual') return 'admin';
    if (b.source === 'setter_booking') return 'setter';
    if (t.isSetterOnly === true) return 'setter';
    return 'self';
  }
  var CLASSES = { self: 'Self Booking', setter: 'Setting (NB)', admin: 'Manuel', excluded: 'Hors vente' };
  /* RDV de vente comptés à leur DATE (RDV, présents, pitchés…) : Self Booking,
     Setting et Manuel. */
  function estRdvVente(cls) { return cls === 'self' || cls === 'setter' || cls === 'admin'; }
  /* RDV de vente comptés à leur CRÉATION (RDV pris, Sets, LTB) : Self Booking
     et Setting seulement — un RDV créé à la main n'est ni pris par le prospect
     ni posé par un setter. */
  function estRdvPris(cls) { return cls === 'self' || cls === 'setter'; }

  /* ══════════════════════════════════════════════════════════════════════
     3. ÉTAT D'UN RDV — un seul état par RDV
     ══════════════════════════════════════════════════════════════════════
     Le RÉSULTAT saisi (bookings.outcome) fait foi ; le statut (bookings.status)
     ne sert de repli que lorsqu'aucun résultat n'est saisi.

       doublon     RDV en double supprimé par le nettoyage : compté nulle part.
       replanifie  RDV déplacé (ou transféré à un autre expert) : son
                   remplaçant compte à sa propre date ; lui ne compte plus.
       annule      RDV annulé et non reporté (prospect, équipe ou système).
       no_show     RDV maintenu, prospect absent.
       present     Prospect venu : offre, close, non close, disqualifié, ou
                   RDV marqué « terminé » sans résultat (« sans détail »).
       a_statuer   Créneau passé, aucun résultat saisi.
       a_venir     Créneau pas encore passé, aucun résultat saisi.            */
  var PRESENT = { offre: 1, close: 1, non_close: 1, disqualifie: 1 };
  var PITCHE = { offre: 1, close: 1, non_close: 1 };
  var VIA_REMPLACE = { coach_transfer: 1 };

  function resultat(b) { return (b && b.outcome) || null; }
  function viaAnnulation(b) {
    var c = (b && b.cancellation) || null;
    return (c && c.via) || (b && b.cancelledReason) || '';
  }
  function estDoublon(b) {
    if (!b || b.outcome) return false;
    return b.status === 'cancelled' && (!!b.duplicateOf || viaAnnulation(b) === 'dedupe');
  }
  /* Déplacé : résultat « replanifié », ou — sans aucun résultat — annulé avec
     le drapeau de report, ou transféré à un autre expert. La branche statut
     exige « aucun résultat » : un RDV reporté puis re-statué « Annulé » est un
     annulé (le résultat saisi fait foi). */
  function estReplanifie(b) {
    if (!b) return false;
    if (b.outcome === 'replanifie') return true;
    if (b.outcome) return false;
    if (b.status !== 'cancelled') return false;
    return b.rescheduled === true || !!b.transferredTo || !!VIA_REMPLACE[viaAnnulation(b)];
  }
  function estAnnule(b) {
    if (!b || estDoublon(b) || estReplanifie(b)) return false;
    return b.outcome === 'annule' || (!b.outcome && b.status === 'cancelled');
  }
  function estNoShow(b) {
    if (!b) return false;
    return b.outcome === 'no_show' || (!b.outcome && b.status === 'no_show');
  }
  function estPresent(b) {
    if (!b) return false;
    return b.outcome ? !!PRESENT[b.outcome] : b.status === 'completed';
  }
  function estPitche(b) { return !!(b && PITCHE[b.outcome]); }
  function estSansDetail(b) { return !!(b && !b.outcome && b.status === 'completed'); }

  function etat(b, now) {
    if (estDoublon(b)) return 'doublon';
    if (estReplanifie(b)) return 'replanifie';
    if (estAnnule(b)) return 'annule';
    if (estNoShow(b)) return 'no_show';
    if (estPresent(b)) return 'present';
    return estPasse(b, now) ? 'a_statuer' : 'a_venir';
  }
  /* Détail d'un présent : 'close' | 'non_close' | 'offre' | 'disqualifie' |
     'sans_detail'. null si le RDV n'est pas « présent ». */
  function detail(b) {
    if (!estPresent(b)) return null;
    return b.outcome || 'sans_detail';
  }
  /* Le RDV qui remplace celui-ci (report ou transfert), s'il existe. */
  function suivantId(b) { return (b && (b.rescheduledToId || b.transferredTo)) || null; }
  /* Ce RDV en remplace-t-il un autre ? Un remplaçant n'est jamais un nouveau
     « RDV pris » : la prise a été comptée à la création du premier. */
  function estRemplacant(b) { return !!(b && (b.rescheduledFromId || b.transferredFrom)); }

  /* Origine d'une annulation : 'prospect' | 'equipe' | 'systeme' | 'inconnu'.
     Bloc `cancellation` posé par tous les chemins d'annulation depuis le
     28/09/2026 ; repli sur les champs d'avant. « inconnu » = annulé avant la
     traçabilité, jamais estimé. */
  function origineAnnulation(b) {
    b = b || {};
    var c = b.cancellation || null;
    var o = (c && c.origin) || b.cancelledOrigin || null;
    if (!o && b.cancelledReason) o = 'systeme';
    return (o === 'prospect' || o === 'equipe' || o === 'systeme') ? o : 'inconnu';
  }
  /* « RDV non honoré par l'équipe » : personne de chez nous au RDV. */
  function estNonHonore(b) {
    var c = (b && b.cancellation) || null;
    return !!(c && c.kind === 'non_honore' && c.origin === 'equipe');
  }
  var ORIGINES = { prospect: 'par le prospect', equipe: 'par l’équipe', systeme: 'par le système', inconnu: 'origine inconnue' };

  var ETATS = {
    doublon:    { mot: 'Doublon supprimé', couleur: '#596180' },
    replanifie: { mot: 'Replanifié',       couleur: '#a78bfa' },
    annule:     { mot: 'Annulé',           couleur: '#ef4444' },
    no_show:    { mot: 'No-show',          couleur: '#fbbf24' },
    present:    { mot: 'Présent',          couleur: '#34d399' },
    a_statuer:  { mot: 'À statuer',        couleur: '#fbbf24' },
    a_venir:    { mot: 'À venir',          couleur: '#8f97b2' }
  };
  var DETAILS = {
    close:       { mot: 'Close',                  couleur: '#34d399' },
    non_close:   { mot: 'Non close',              couleur: '#f87171' },
    offre:       { mot: 'Offre en attente',       couleur: '#5b7cfa' },
    disqualifie: { mot: 'Disqualifié',            couleur: '#94a3b8' },
    sans_detail: { mot: 'Présent (sans détail)',  couleur: '#34d399' }
  };
  /* Libellé et couleur d'un RDV pour une liste nominative. */
  function libelle(b, now) {
    var e = etat(b, now);
    if (e === 'present') { var d = DETAILS[detail(b)] || DETAILS.sans_detail; return { etat: e, mot: d.mot, couleur: d.couleur }; }
    return { etat: e, mot: ETATS[e].mot, couleur: ETATS[e].couleur };
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. AGRÉGAT — les colonnes d'une liste de RDV, identités garanties
     ══════════════════════════════════════════════════════════════════════
       rdv      = total − doublons − replanifiés
                = annulés + no-show + présents + à statuer + à venir
       kept     = rdv − annulés   (le no-show reste dedans : règle Vincent 14/07)
       présents = disqualifiés + pitchés + sans détail
       pitchés  = offres en attente + non closes + RDV closés
       show-up  = présents ÷ (kept − à venir)                                */
  function pct(n, d) { return d > 0 ? n / d * 100 : null; }
  function vide() {
    return {
      total: 0, doublons: 0, replan: 0, rdv: 0, annules: 0, noshow: 0, presents: 0,
      disqua: 0, pitches: 0, offres: 0, nonCloses: 0, rdvCloses: 0, sansDetail: 0,
      aStatuer: 0, aVenir: 0, kept: 0, keptEchus: 0
    };
  }
  /* Ajoute un RDV à l'agrégat et renvoie son état. */
  function ajouter(a, b, now) {
    var e = etat(b, now);
    a.total++;
    if (e === 'doublon') { a.doublons++; return e; }
    if (e === 'replanifie') { a.replan++; return e; }
    a.rdv++;
    if (e === 'annule') a.annules++;
    else if (e === 'no_show') a.noshow++;
    else if (e === 'a_statuer') a.aStatuer++;
    else if (e === 'a_venir') a.aVenir++;
    else {
      a.presents++;
      var d = detail(b);
      if (d === 'disqualifie') a.disqua++;
      else if (d === 'sans_detail') a.sansDetail++;
      else {
        a.pitches++;
        if (d === 'offre') a.offres++;
        else if (d === 'non_close') a.nonCloses++;
        else a.rdvCloses++;
      }
    }
    return e;
  }
  /* Calcule les dérivés (kept, taux). À rappeler après des ajouts à la main
     ou une somme d'agrégats. */
  function finir(a) {
    a.kept = a.rdv - a.annules;
    a.keptEchus = a.kept - a.aVenir;
    a.keptPct = pct(a.kept, a.rdv);
    a.tauxAnnul = pct(a.annules, a.rdv);
    a.showUp = pct(a.presents, a.keptEchus);
    a.tauxNoShow = pct(a.noshow, a.keptEchus);
    a.tauxPitch = pct(a.pitches, a.presents);
    return a;
  }
  function compter(list, now) {
    var a = vide();
    now = now || Date.now();
    (list || []).forEach(function (b) { ajouter(a, b, now); });
    return finir(a);
  }
  var CHAMPS_SOMME = ['total', 'doublons', 'replan', 'rdv', 'annules', 'noshow', 'presents', 'disqua', 'pitches', 'offres', 'nonCloses', 'rdvCloses', 'sansDetail', 'aStatuer', 'aVenir'];
  /* Somme de plusieurs agrégats (Self Booking + Setting, jours d'une semaine…). */
  function sommer(liste) {
    var a = vide();
    (liste || []).forEach(function (x) {
      if (!x) return;
      CHAMPS_SOMME.forEach(function (k) { a[k] += Number(x[k]) || 0; });
    });
    return finir(a);
  }
  /* Show-up à partir de compteurs déjà faits (corrections, totaux). */
  function showUp(presents, kept, aVenir) { return pct(Number(presents) || 0, (Number(kept) || 0) - (Number(aVenir) || 0)); }
  /* Taux de close : closes de la période ÷ pitchés (ou présents) de la période.
     Un close est daté du jour de la vente, un RDV du jour où il a lieu : sur
     une courte période le rapport peut dépasser 100 %, il n'a alors pas de sens
     → null (« — »). */
  function tauxClose(closes, base) {
    closes = Number(closes) || 0; base = Number(base) || 0;
    if (base <= 0 || closes > base) return null;
    return closes / base * 100;
  }
  /* Une seule façon d'écrire un taux : une décimale, virgule, « — » si vide. */
  function fmtPct(v, decimales) {
    if (v == null || isNaN(v)) return '—';
    var n = decimales == null ? 1 : decimales;
    return Number(v).toFixed(n).replace('.', ',') + ' %';
  }

  /* Une seule façon d'écrire un montant : euros entiers, séparateur français.
     L'arrondi se fait à l'affichage seulement, jamais avant une somme. */
  function fmtEuro(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString('fr-FR') + ' €';
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. QUI — setter et closer d'un RDV, une seule chaîne
     ══════════════════════════════════════════════════════════════════════
     Setter : celui retenu au close (commission) → setter verrouillé de la
     fiche → la personne qui a posé le RDV → la personne à qui la fiche est
     assignée. null = « Non attribué » (jamais « le seul setter de l'équipe »). */
  function setterDuRdv(b, fiche) {
    b = b || {};
    var cd = b.closeData || {};
    return cd.setterSlug || (fiche && fiche.setterSlug) || b.bookedBySlug || (fiche && fiche.assignedTo) || null;
  }
  /* Closer : celui qui a validé le close → l'hôte figé sur le RDV → l'hôte de
     la fiche d'agenda (résolu par la page : personId → membre). null = « Non
     attribué » (jamais « le seul closer de l'équipe »). */
  function closerDuRdv(b, resoudrePersonne) {
    b = b || {};
    var cd = b.closeData || {};
    if (cd.closerSlug) return cd.closerSlug;
    if (b.expertSlug) return b.expertSlug;
    if (typeof resoudrePersonne === 'function') return resoudrePersonne(b.personId, b) || null;
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════
     5 bis. TÉLÉPHONE — un appel « décroché », une seule règle
     ══════════════════════════════════════════════════════════════════════
     Décroché = au moins 5 secondes de conversation, répondeurs écartés. La
     signature du répondeur (mesurée sur les appels réels le 17/08/2026) :
     une sonnerie longue (≥ 15 s) suivie d'une conversation courte (< 15 s).
     Sonnerie inconnue → on garde l'appel (mieux vaut un décroché de trop
     qu'une conversation jetée sur une supposition). */
  var DECROCHE_MIN_SEC = 5;
  var REPONDEUR_SONNERIE_MIN_SEC = 15;
  var REPONDEUR_PAROLE_MAX_SEC = 15;
  function msOf(v) {
    if (v == null || v === '') return null;
    var t = toDate(v).getTime();
    return isNaN(t) ? null : t;
  }
  function sonnerieSec(c) {
    if (!c) return null;
    var r = Number(c.ringingDurationSec);
    if (c.ringingDurationSec != null && isFinite(r) && r >= 0) return r;
    var ansMs = msOf(c.answeredAt), iniMs = msOf(c.initiatedAt);
    if (ansMs != null && iniMs != null && ansMs >= iniMs) return Math.round((ansMs - iniMs) / 1000);
    var tot = Number(c.totalDurationSec), talk = Number(c.durationSec) || 0;
    if (!isFinite(tot) || tot <= 0) return null;
    var diff = tot - talk;
    return diff > 0 ? diff : 0;
  }
  function estDecroche(c) {
    var talk = Number(c && c.durationSec) || 0;
    if (talk < DECROCHE_MIN_SEC) return false;
    var ring = sonnerieSec(c);
    if (ring == null) return true;
    if (ring >= REPONDEUR_SONNERIE_MIN_SEC && talk < REPONDEUR_PAROLE_MAX_SEC) return false;
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. GLOSSAIRE — un mot = un calcul = un texte
     ══════════════════════════════════════════════════════════════════════
     Toute explication d'un chiffre affiché vient d'ici. Un écran qui a besoin
     d'une précision locale l'AJOUTE (info(cle, precision)), il ne réécrit pas
     la définition. Français simple : ces textes sont lus par l'équipe. */
  var G = {
    /* ── RDV ── */
    rdv: { mot: 'RDV', texte: 'RDV de vente prévus sur la période (date du RDV), annulés et no-show compris. Un RDV déplacé n’est compté qu’une fois, à sa nouvelle date.' },
    rdv_sb: { mot: 'RDV SB', texte: 'RDV Self Booking de la période (date du RDV) : le prospect a réservé seul. Annulés et no-show compris, RDV déplacés comptés à leur nouvelle date.' },
    rdv_nb: { mot: 'RDV NB', texte: 'RDV du setting de la période (date du RDV) : posés par un setter. Annulés et no-show compris, RDV déplacés comptés à leur nouvelle date. Différent des Sets, comptés le jour où le RDV est posé.' },
    rdv_manuels: { mot: 'RDV manuels', texte: 'RDV de vente créés à la main dans l’Agenda (ni réservés par le prospect, ni posés par un setter). Comptés à leur date dans RDV, Présents et Pitchés ; jamais dans RDV pris, Sets ni LTB.' },
    rdv_pris: { mot: 'RDV pris', texte: 'RDV de vente créés pendant la période (Self Booking + Setting), annulés compris. Un RDV déplacé n’est pas une nouvelle prise. Compté le jour où le RDV est pris, pas le jour où il a lieu.' },
    sets: { mot: 'Sets', texte: 'RDV posés par un setter pendant la période : un set = un RDV réellement créé dans l’agenda, compté le jour où il est posé. Un RDV déplacé n’est pas un nouveau set.' },
    statuts_set_sans_rdv: { mot: 'Statuts « Set » sans RDV', texte: 'Fiches passées au statut Set pendant la période sans qu’aucun RDV du setting ait été créé. Ce ne sont pas des sets : à vérifier, puis poser le RDV dans l’agenda.' },
    replanifie: { mot: 'Replanifiés', texte: 'RDV déplacés à une autre date. Ils ne sont plus comptés ici : le nouveau RDV est compté à sa nouvelle date.' },
    annules: { mot: 'Annulés', texte: 'RDV annulés et non reportés, toutes origines (prospect, équipe, système). Si le prospect reprend RDV ensuite, le RDV passe en Replanifié et quitte cette colonne.' },
    no_show: { mot: 'No-show', texte: 'RDV maintenu, prospect absent. Il reste compté dans le Kept. Si le prospect reprend RDV ensuite, le RDV passe en Replanifié.' },
    kept: { mot: 'Kept', texte: 'RDV maintenus : les RDV de la période moins les annulés. Un no-show reste dedans (le RDV était maintenu, le prospect n’est pas venu).' },
    a_statuer: { mot: 'À statuer', texte: 'RDV dont l’heure est passée et qui n’a pas encore de résultat. À saisir depuis l’Agenda (bouton Résultat) ou la fiche du prospect.' },
    a_venir: { mot: 'À venir', texte: 'RDV de la période qui n’ont pas encore eu lieu.' },
    poses_avant: { mot: 'Posés avant la période', texte: 'RDV de la période qui avaient été posés avant son début.' },
    reportes: { mot: 'Reportés à une nouvelle date', texte: 'RDV de la période qui sont le nouveau créneau d’un RDV déplacé.' },
    canal: { mot: 'Canal', texte: 'Self Booking : le prospect a réservé seul. Setting (NB) : le RDV a été posé par un setter. Manuel : RDV créé à la main dans l’Agenda. Pour un close, c’est le canal de son RDV closé ; sans RDV closé, la réponse du closer au moment du close, puis l’étape de la fiche.' },
    origine_annulation: { mot: 'Origine de l’annulation', texte: 'Qui a annulé : le prospect, l’équipe (dont « non honoré » quand personne de chez nous n’était au RDV) ou le système (contact bloqué, client désactivé). Les RDV annulés avant octobre 2026 n’ont pas d’origine connue.' },
    /* ── Présence ── */
    presents: { mot: 'Présents', texte: 'RDV où le prospect est venu : résultat Offre, Close, Non close ou Disqualifié (ou RDV marqué « terminé » sans résultat). Comptés à la date du RDV.' },
    pitches: { mot: 'Pitchés', texte: 'RDV où l’offre a été présentée : résultat Offre, Close ou Non close. Un prospect présent mais disqualifié n’est pas pitché.' },
    disqua: { mot: 'Disqua.', texte: 'Prospects venus au RDV mais hors cible : aucune offre présentée. Comptés dans Présents, pas dans Pitchés.' },
    non_closes: { mot: 'Non closes', texte: 'RDV où l’offre a été présentée et refusée. Une offre encore en réflexion ou un prospect disqualifié n’est pas un non close.' },
    offres_attente: { mot: 'Offres en attente', texte: 'RDV où l’offre a été présentée et où le prospect réfléchit encore (ni close ni refus).' },
    sans_detail: { mot: 'Présents sans détail', texte: 'RDV marqués « terminé » sans résultat saisi : on sait que le prospect est venu, pas si l’offre a été présentée. À statuer.' },
    show_up: { mot: 'Show-up', texte: 'Présents ÷ RDV maintenus déjà passés (Kept moins les RDV à venir). Un no-show fait baisser le taux ; un annulé ou un RDV déplacé n’y entre pas.' },
    taux_pitch: { mot: 'Taux de pitch', texte: 'Pitchés ÷ Présents : part des prospects venus à qui l’offre a été présentée.' },
    taux_annulation: { mot: 'Taux d’annulation', texte: 'Annulés ÷ RDV de la période. Les no-show n’y sont pas : ils ont leur propre colonne.' },
    /* ── Closes ── */
    closes: { mot: 'Closes', texte: 'Clients gagnés pendant la période : un par client, compté le jour où il devient client (signature ou validation du close). Les closes annulés sont retirés.' },
    closes_sb: { mot: 'Closes SB', texte: 'Closes dont le RDV était un Self Booking (le prospect a réservé seul). Closes SB + Closes NB = Closes.' },
    closes_nb: { mot: 'Closes NB', texte: 'Closes dont le RDV avait été posé par un setter. Closes SB + Closes NB = Closes.' },
    closes_annules: { mot: 'Closes annulés', texte: 'Closes retirés : rien n’a été encaissé et le paiement est annulé ou le client stoppé. Le retrait s’applique au mois du close, même passé.' },
    closes_sans_rdv: { mot: 'Closes sans RDV', texte: 'Clients gagnés pour lesquels aucun RDV n’a été statué « Close » (vente validée directement sur la fiche, ou repérée par le paiement). Ils comptent dans Closes.' },
    rdv_closes: { mot: 'RDV closés', texte: 'RDV de la période dont le résultat est Close, comptés à la date du RDV. Ce n’est pas « Closes », qui compte les clients le jour où ils sont gagnés.' },
    taux_close_pitches: { mot: 'Close / pitchés', texte: 'Closes de la période ÷ RDV pitchés de la période. Un close est daté du jour de la vente, un RDV du jour où il a lieu : sur une période courte le taux peut ne pas avoir de sens (affiché —).' },
    taux_close_presents: { mot: 'Close / présents', texte: 'Closes de la période ÷ RDV présents de la période. Un close est daté du jour de la vente, un RDV du jour où il a lieu : sur une période courte le taux peut ne pas avoir de sens (affiché —).' },
    taux_close_rdv: { mot: 'Close / RDV', texte: 'Closes de la période ÷ RDV de la période (annulés et no-show compris).' },
    closes_cohorte: { mot: 'Closes des leads entrés', texte: 'Parmi les leads entrés pendant la période : ceux devenus clients depuis, quelle que soit la date du close. Différent de Closes, qui compte les clients gagnés pendant la période.' },
    /* ── Montants ── */
    contracte: { mot: 'Contracté', texte: 'Valeur hors taxes des contrats des clients gagnés pendant la période. Lue dans le module Paiements ; tant qu’aucun paiement n’existe, c’est le tarif déclaré au close.' },
    collecte: { mot: 'Collecté', texte: 'Tout ce qui a déjà été prélevé, jusqu’à aujourd’hui, sur les clients gagnés pendant la période (hors taxes). Ce chiffre monte à chaque mensualité.' },
    preleve_periode: { mot: 'Prélevé sur la période', texte: 'Argent réellement rentré pendant la période : tous les prélèvements passés à ces dates, anciens clients compris (hors taxes). Différent du Collecté, qui suit les clients gagnés pendant la période.' },
    reste_a_encaisser: { mot: 'Reste à encaisser', texte: 'Contracté moins collecté : ce qui reste à prélever sur les clients gagnés pendant la période, toutes échéances à venir comprises.' },
    premiers_prelevements: { mot: '1ers prélèvements en attente', texte: 'Clients dont le mandat est signé mais dont rien n’a encore été prélevé : montant de leur première échéance. Ce n’est qu’une partie du reste à encaisser.' },
    panier_moyen: { mot: 'Panier moyen', texte: 'Valeur moyenne d’un contrat : contracté ÷ nombre de closes de la période (hors taxes).' },
    collecte_par_close: { mot: 'Collecté / close', texte: 'Collecté à ce jour ÷ nombre de closes de la période. Il monte à chaque mensualité.' },
    declare_au_close: { mot: 'Déclaré au close', texte: 'Montant saisi par le closer au moment du close. Ce n’est ni le contrat ni un prélèvement du module Paiements.' },
    close_sans_paiement: { mot: 'Close sans paiement', texte: 'Client gagné sans paiement dans le module Paiements : son contracté est le tarif déclaré au close, son collecté est à 0. Créer le paiement fait remonter les vrais montants.' },
    ht: { mot: 'HT', texte: 'Tous les montants sont hors taxes et arrondis à l’euro : la somme des lignes peut différer du total d’un euro.' },
    roas_pub: { mot: 'ROAS pub', texte: 'Collecté à ce jour sur les clients gagnés pendant la période et venus de la publicité, divisé par la dépense pub de la période. Il monte à chaque mensualité.' },
    contracte_sur_depense: { mot: 'Contracté ÷ dépense', texte: 'Valeur des contrats signés par les leads entrés pendant la période, divisée par la dépense de la pub. Ce n’est pas le ROAS pub : il suit les leads entrés et la valeur des contrats, pas les prélèvements.' },
    /* ── Équipe ── */
    equipe: { mot: 'Équipe', texte: 'La somme des onglets de chaque personne, plus la ligne « Non attribué ». Le chiffre est le même quel que soit le compte connecté.' },
    non_attribue: { mot: 'Non attribué', texte: 'Ce qui compte pour l’équipe mais n’appartient à aucun onglet : personne sans onglet, ancien membre, closer ou setter inconnu, ou rattachement antérieur à l’arrivée de la personne.' },
    anciens_membres: { mot: 'Anciens membres', texte: 'Personnes qui ont quitté l’équipe. Elles n’ont plus d’onglet, mais leur activité d’avant leur départ reste dans le total Équipe.' },
    closer: { mot: 'Closer', texte: 'La personne qui a validé le close ; à défaut, celle qui tenait le RDV.' },
    setter: { mot: 'Setter', texte: 'Le setter de la fiche, celui qui touche la commission de setting. Si une autre personne a posé le RDV, la liste l’indique.' },
    correction: { mot: 'Correction ✎', texte: 'Chiffre saisi à la main pour ce jour et cette personne, à la place du chiffre calculé. Réservé aux appels et aux actions de fiche ; les RDV et les montants se corrigent à la source (résultat du RDV, module Paiements).' },
    correction_ancienne: { mot: 'Ancienne correction ✎', texte: 'Une correction manuelle avait été saisie ici. Elle n’est plus appliquée : le chiffre affiché est celui de la base, le même que sur les autres écrans. Pour le changer, corriger le résultat du RDV ou le paiement.' },
    date_debut: { mot: 'Date de début', texte: 'Avant sa date de début, cette personne n’a pas de donnée (ce n’est pas un zéro). Ce qui lui est rattaché avant reste compté dans Équipe, ligne « Non attribué ».' },
    /* ── Leads et téléphone ── */
    leads: { mot: 'Leads', texte: 'Fiches entrées pendant la période (date d’entrée réelle : la plus ancienne entre le webinaire, l’import et la création). Une personne qui se réinscrit n’est pas un nouveau lead.' },
    reoptins: { mot: 'Ré-optins', texte: 'Fiches déjà connues qui se sont réinscrites pendant la période. Comptées une fois par fiche, à part des Leads.' },
    leads_nb_recus: { mot: 'Leads NB reçus', texte: 'Leads entrés pendant la période qui n’ont pas réservé seuls : ceux que le setting doit travailler. Rangés chez le setter de la fiche.' },
    leads_travailles: { mot: 'Leads travaillés', texte: 'Fiches contactées pour la première fois pendant la période, quelle que soit leur date d’entrée. Dans l’onglet d’un setter : celles que LUI a contactées pour la première fois. Dans Équipe : fiches distinctes.' },
    pas_encore_travailles: { mot: 'Pas encore travaillés', texte: 'Leads reçus pendant la période sur lesquels aucune action de l’équipe n’a encore été enregistrée.' },
    appels: { mot: 'Appels', texte: 'Appels sortants passés pendant la période.' },
    appels_sans_auteur: { mot: 'Appels sans auteur', texte: 'Appels sortants passés depuis un poste téléphonique qui n’est relié à aucun compte de l’équipe. Ils ne peuvent être rangés dans l’onglet de personne.' },
    appels_equipe_non_lisibles: { mot: 'Appels de l’équipe', texte: 'Ton compte ne peut lire que tes propres appels : le total de l’équipe n’est pas affiché plutôt que d’être faux. Un admin le voit.' },
    decroches: { mot: 'Décrochés', texte: 'Appels sortants où quelqu’un a répondu : au moins 5 secondes de conversation, répondeurs écartés.' },
    taux_decroche: { mot: 'Taux de décroché', texte: 'Décrochés ÷ appels sortants de la période.' },
    ltb: { mot: 'LTB', texte: 'Lead to booking : RDV pris pendant la période ÷ leads entrés pendant la période. Les RDV pris par d’anciens leads comptent au numérateur.' },
    taux_set: { mot: 'Sets / décrochés', texte: 'Sets de la période ÷ appels décrochés de la période : efficacité du setting au téléphone.' },
    /* ── Chiffres saisis à la main ── */
    declare: { mot: 'Déclaré', texte: 'Chiffre saisi à la main par le membre, non vérifié. Le chiffre officiel est celui calculé à partir des RDV et des paiements.' },
    ancienne_saisie: { mot: 'Ancienne saisie', texte: 'Chiffres de l’ancienne saisie hebdomadaire, arrêtée en juillet 2026. Depuis, les chiffres sont calculés à partir des RDV et des paiements.' },
    /* ── Contrôles et cas particuliers (ajoutés à la demande des écrans) ── */
    deplaces_sans_suite: { mot: 'Déplacés sans nouveau créneau', texte: 'RDV pris pendant la période puis déplacés, dont le nouveau créneau n’est pas connu. Ils ne sont ni annulés ni maintenus : comptés dans RDV pris, pas dans le Kept ni dans le show-up.' },
    taux_no_show: { mot: 'Taux de no-show', texte: 'No-show ÷ RDV maintenus déjà passés (Kept moins les RDV à venir). Show-up + taux de no-show + part des RDV à statuer = 100 %.' },
    kept_pct: { mot: 'Kept %', texte: 'Kept ÷ RDV de la période : part des RDV qui n’ont pas été annulés. Les RDV déplacés n’y entrent pas.' },
    doublons_supprimes: { mot: 'Doublons supprimés', texte: 'RDV créés deux fois pour le même prospect, dont un exemplaire a été supprimé par le nettoyage. Ils ne sont comptés nulle part.' },
    clientes_sans_vente: { mot: 'Fiches clientes sans vente enregistrée', texte: 'Fiches marquées clientes pendant la période sans aucune trace de vente : ni étape « gagné », ni RDV au résultat Close, ni paiement, ni contrat signé. Elles ne comptent pas dans Closes : à vérifier sur la fiche.' },
    ecart_canal: { mot: 'Écarts de canal', texte: 'Closes dont le RDV dit Self Booking et la réponse du closer dit Setting (ou l’inverse). Le close est compté selon le RDV ; la commission suit la réponse du closer.' },
    canal_inconnu: { mot: 'Canal inconnu', texte: 'Closes sans RDV closé, sans réponse du closer et sans étape « gagné » : on ne sait pas s’ils viennent du Self Booking ou du Setting. Ils sont rangés en Setting.' },
    rdv_closes_hors_periode: { mot: 'RDV closés sans close sur la période', texte: 'RDV de la période au résultat Close dont le client n’est pas un close de la période : il a été gagné à une autre date, ou sa fiche n’est jamais passée cliente.' },
    doublons_rdv_closes: { mot: 'Clients à deux RDV closés', texte: 'Clients qui ont deux RDV au résultat Close. Un seul close est compté ; son canal, son closer et son setter sont ceux du premier RDV.' },
    rdv_pris_hors_tunnel: { mot: 'RDV pris hors tunnel', texte: 'RDV pris pendant la période par un lead plus ancien ou sans fiche : il n’est rangé ni en Élite ni en Business. Élite + Business + hors tunnel = RDV pris.' },
    lecture_incomplete: { mot: 'Lecture incomplète', texte: 'Une lecture a échoué ou a atteint son plafond : les chiffres concernés sont partiels. Recharge la page ou réduis la période.' },
    objectif: { mot: 'Objectif annuel', texte: 'Objectif de contracté fixé par la direction dans Projections. Un mois sans objectif propre reprend l’objectif annuel divisé par 12.' },
    projection_annee: { mot: 'Projection fin d’année', texte: 'Contracté depuis janvier, plus la moyenne des 3 derniers mois terminés pour chaque mois restant (le mois en cours est complété jusqu’à cette moyenne).' },
    temps_appel: { mot: 'Temps d’appel', texte: 'Temps passé en conversation sur les appels sortants décrochés de la période. Les appels reçus et les messageries ne sont pas comptés.' },
    duree_moyenne_appel: { mot: 'Durée moyenne', texte: 'Temps d’appel ÷ appels décrochés de la période.' },
    montants_par_personne: { mot: 'Montants par personne', texte: 'Les montants par personne ne sont visibles que par la personne elle-même et par un admin. Les totaux de l’équipe sont visibles de tous.' },
    appels_non_charges: { mot: 'Appels non chargés', texte: 'Les appels ne sont chargés que pour un mois à la fois (plafond de lecture). Choisis un seul mois pour les voir.' },
    vues_page: { mot: 'Vues', texte: 'Visites de la page pendant la période (mesure de la page, hors visites internes).' },
    clics_bouton: { mot: 'Clics bouton', texte: 'Clics sur le bouton principal de la page (réserver, commencer le quiz…). Ce ne sont pas les clics sur la publicité.' },
    formulaires_page: { mot: 'Formulaires', texte: 'Formulaires remplis (opt-in) depuis la page pendant la période : nouveaux leads entrés par cette page et ré-optins revenus par elle.' },
    debriefs_appel: { mot: 'Débriefs d’appel', texte: 'Fiches de débrief ajoutées à la main sur cet appareil (ce navigateur seulement). Ce n’est pas le nombre d’appels passés : celui-ci est dans Set NB.' },
    objectif_personnel: { mot: 'Objectif personnel', texte: 'Note libre enregistrée dans ce navigateur, lue par aucun autre écran. L’objectif de l’équipe est celui fixé dans Projections.' },
    bareme_commission: { mot: 'Barème de commission', texte: 'Rappel du type de contrat seulement : aucune commission n’est calculée sur cette page. Le barème appliqué est celui de la page Commissions (et du contrat du membre).' },
    nrp1___nrp2___nrp3___all_nrp: { mot: 'NRP 1 / NRP 2 / NRP 3 / All NRP', texte: 'Fiches passées au statut NRP N (appel sans réponse) ce jour-là, d’après le journal d’actions de Leads Live.' },
    messagerie: { mot: 'Messageries', texte: 'Fiches passées au statut Messagerie (répondeur) ce jour-là, d’après le journal d’actions de Leads Live.' },
    follow_up: { mot: 'Follow-up', texte: 'Fiches passées en follow-up (rappel programmé) ce jour-là, d’après le journal d’actions de Leads Live.' },
    out: { mot: 'Out', texte: 'Fiches passées en faux numéro, pas intéressé, disqualifié ou poubelle ce jour-là. Ce sont des actions du journal sur les fiches, pas des RDV.' },
    dm_envoyes___dm_recus___conv_ouvertes___reponses_dm___conv_entrantes: { mot: 'DM envoyés / DM reçus / Conversations ouvertes / Réponses / Conversations entrantes', texte: 'Messages Instagram sortants (échos Meta) ou entrants, comptés le jour de l’envoi ou de la réception ; conversations ouvertes par nous ; conversations ouvertes par nous ayant reçu leur première réponse ce jour-là ; conversations ouvertes par le prospect.' },
    taux_set_reponses: { mot: 'Sets / réponses', texte: 'Sets de la période ÷ conversations qui ont reçu une réponse pendant la période : efficacité du setting écrit.' },
    lecture_funnel_bloc: { mot: 'Lecture du bloc', texte: 'Chaque pourcentage se lit sur l’étape juste avant. Pas de pourcentage entre deux étapes qui ne comptent pas la même chose (leads et appels ; Sets, jour de la pose, et RDV NB, jour du RDV). Présents : le show-up. Closes : Close / pitchés.' },
    heure_paris: { mot: 'Heure de Paris', texte: 'Jours et mois comptés à l’heure de Paris, quel que soit l’endroit d’où tu regardes.' },
    poses_apres: { mot: 'Posés après la période', texte: 'RDV de la période créés après sa fin (saisis après coup dans l’agenda). Ils ne sont pas dans les Sets de la période.' },
    pose_inconnue: { mot: 'Date de pose inconnue', texte: 'RDV de la période sans date de création enregistrée : on ne sait pas quand il a été posé.' },
    repris_2e_setter: { mot: 'Repris par un deuxième setter', texte: 'Fiches travaillées pendant la période par plusieurs setters : chacun la compte dans son onglet, l’Équipe ne la compte qu’une fois.' },
    non_attribue_contenu: { mot: 'Contenu de la ligne Non attribué', texte: 'Ce qui est rangé ici : anciens membres (sans nom), personnes sans onglet sur cette page, setter inconnu, appels sans auteur, ou éléments datés d’avant l’arrivée de la personne.' },
    cpl_pub: { mot: 'CPL pub', texte: 'Dépense pub de la période ÷ leads entrés sur la période et venus de la publicité. Les leads organiques n’y entrent pas : la dépense pub ne les a pas achetés.' },
    collecte_sur_depense: { mot: 'Collecté total ÷ dépense pub', texte: 'Tout le collecté des closes de la période (pub, organique, setting) divisé par la seule dépense pub. Ce n’est pas un ROAS : il crédite la pub de ventes qu’elle n’a pas apportées.' },
    roas_pub_setting: { mot: 'ROAS pub + setting', texte: 'Collecté des closes de la période ÷ (dépense pub + coût du setting). Les commissions de closing et le fixe des closers n’y sont pas : ce n’est pas la rentabilité globale.' },
    cout_setting: { mot: 'Coût du setting', texte: 'Fixe + outils (au prorata des jours, arrêtés à aujourd’hui sur une période en cours) + commissions de setting dues de la période (validées ou non).' },
    cout_rdv_pris_nb: { mot: 'Coût / RDV pris NB', texte: '(Fixe + outils + commissions de setting hors closes Self Booking) ÷ RDV pris NB (= Sets) de la période. Non calculé avec un filtre tunnel ou source.' },
    hors_equipe_sales: { mot: 'Hors équipe sales', texte: 'Appels sortants passés par la CSM ou les coachs. Ils ne sont pas comptés dans Appels ni dans Décrochés.' },
    couverture_depense: { mot: 'Jours de dépense reçus', texte: 'Jours de la période pour lesquels la dépense Meta est arrivée, comptés jusqu’à hier (la dépense d’un jour n’arrive que le lendemain). S’il en manque, CPL, CPR, CAC et ROAS sous-estiment le coût.' },
    reoptins_ecartes: { mot: 'Réinscriptions non comptées', texte: 'Fiches remontées pendant la période sans vrai formulaire : message entrant, fiche remontée à la main, client. Ce ne sont pas des ré-optins.' },
    leads_test: { mot: 'Fiches de test', texte: 'Fiches créées par une visite interne (essai de l’équipe). Elles ne comptent pas comme leads.' },
    lead_to_speech: { mot: 'Lead to speech', texte: 'Temps entre l’arrivée d’un lead et le premier appel sortant de l’équipe vers lui, décroché ou non, dans ses 14 premiers jours. Appelé : au moins un appel sortant dans cette fenêtre. Joint : au moins un de ces appels décroché.' },
    taux_recuperation: { mot: 'Taux de récupération', texte: 'Leads NB reçus qui ont un RDV du setting ÷ leads NB reçus de la période.' },
    appels_recus: { mot: 'Appels reçus', texte: 'Appels entrants pris par l’équipe pendant la période. Jamais comptés dans Appels.' },
    closes_par_page: { mot: 'Closes de la page', texte: 'Clients gagnés pendant la période dont le RDV (ou l’opt-in) vient de cette page. Pages + autres pages + non rattachés = Closes.' },
    leads_avec_rdv: { mot: 'Leads avec RDV', texte: 'Leads entrés pendant la période qui ont au moins un RDV de vente (Self Booking, Setting ou manuel), à n’importe quelle date jusqu’à aujourd’hui. Un lead compte une fois. Ce n’est pas « RDV pris » du Stats funnel, qui compte les RDV créés pendant la période, anciens leads compris.' },
    leads_presents: { mot: 'Leads présents', texte: 'Leads entrés pendant la période venus à au moins un de leurs RDV (lu sur le dernier RDV de chaque chaîne de report). Un lead compte une fois.' },
    taux_close_leads_presents: { mot: 'Taux de close / leads présents', texte: 'Closes des leads entrés venus au RDV ÷ leads présents. Calculé par lead : un lead compte une fois, même avec plusieurs RDV. Un close sans RDV enregistré n’y entre pas.' },
    close_sans_rdv_enregistre: { mot: 'Sans RDV enregistré', texte: 'Client gagné directement depuis sa fiche ou repéré par le module Paiements, sans RDV de vente à son nom. Il compte dans les closes, ni dans les leads avec RDV ni dans les leads présents.' },
    deja_client: { mot: 'Déjà client', texte: 'Lead réinscrit pendant la période qui était déjà client avant son entrée. Ce n’est pas un close des leads entrés.' },
    leads_et_reoptins: { mot: 'Leads + ré-optins', texte: 'Nouveaux leads entrés pendant la période, plus les anciens leads qui ont rempli un nouveau formulaire pendant la période. Le Stats funnel affiche ces deux nombres séparément.' },
    taux_close_leads_avec_rdv: { mot: 'Close / leads avec RDV', texte: 'Closes des leads entrés qui avaient un RDV ÷ leads avec RDV, par lead.' },
    taux_close_lead: { mot: 'Close / lead', texte: 'Closes des leads entrés ÷ leads (+ ré-optins) de la ligne.' },
    contracte_cohorte: { mot: 'Contracté des leads entrés', texte: 'Valeur HT des contrats des closes des leads entrés pendant la période (gagnés à n’importe quelle date). Différent du Contracté (clients gagnés pendant la période).' },
    collecte_cohorte: { mot: 'Collecté des leads entrés', texte: 'Ce qui a déjà été prélevé, jusqu’à aujourd’hui, sur les closes des leads entrés (HT).' },
    contracte_par_lead: { mot: 'Contracté / lead', texte: 'Contracté des leads entrés ÷ leads de la ligne.' },
    part_contracte: { mot: 'Part du contracté', texte: 'Part de la ligne dans le contracté total du tableau.' },
    lqs: { mot: 'LQS', texte: 'Note de 1 à 5 calculée uniquement à partir des réponses du lead avec le barème ⚙️. Ni la note équipe ★, ni le CA déclaré.' },
    lqs_45: { mot: 'LQS 4-5', texte: 'Leads notés LQS 4 ou 5 ÷ leads notés (les non notés ne comptent pas).' },
    note_equipe: { mot: 'Note équipe ★', texte: 'Moyenne du curseur ★ posé par le setter ou le closer dans Leads Live. Ce n’est pas la note LQS.' },
    qualite_pipe: { mot: 'Qualité du pipe', texte: 'LQS moyen des leads des RDV de la ligne.' },
    mqs: { mot: 'MQS', texte: '60 % qualité (LQS moyen) + 40 % résultats (contracté des leads entrés par lead vs moyenne ; sans contrat, taux de leads présents).' },
    depense_pub_ligne: { mot: 'Dépense par pub', texte: 'Dépense Meta reçue pub par pub, rattachée à la ligne qui porte la pub ; peut être inférieure à la dépense du compte.' },
    cpl_source: { mot: 'CPL de la source', texte: 'Dépense de la ligne ÷ leads de la ligne ; total : lignes venues de la pub seulement.' },
    cout_lead_45: { mot: 'Coût / lead LQS 4-5', texte: 'Dépense ÷ leads notés LQS 4 ou 5 de la ligne.' },
    filtre_closer: { mot: 'Filtre closer', texte: 'Seuls les leads rattachés au closer choisi (closer de leur close, sinon de leur RDV) sont comptés ; les taux par lead entré et les coûts pub ne sont pas calculés.' },
    mode_periode: { mot: 'Closes de la période, par note', texte: 'Closes, Contracté et Collecté des clients gagnés pendant la période, rangés selon la note du lead ; taux par lead non calculés.' },
    non_calcule_periode: { mot: 'Non calculé dans ce mode', texte: 'Les closes de la période ne viennent pas tous des leads entrés pendant la période.' },
    plage_closers: { mot: 'Plage de la vue Closers', texte: 'La plage ne change que les tableaux des closers ; les cartes de la vue d’ensemble restent sur la période.' },
    depense_incomplete: { mot: 'Dépense incomplète', texte: 'Jours de la période, jusqu’à hier, sans dépense par pub reçue : coûts masqués, ils seraient faussement bons.' },
    arrives: { mot: 'Arrivés', texte: 'Pages du quiz affichées, une fois par session (visites internes exclues).' },
    formulaire_envoye: { mot: 'Formulaire envoyé', texte: 'Envois du formulaire comptés sur la page ; peut dépasser le nombre de fiches (double envoi).' },
    nouveaux_leads: { mot: 'Nouveaux leads', texte: 'Nouvelles fiches dont la page d’entrée est ce quiz.' },
    vus_q1: { mot: 'Ont vu la 1re question', texte: 'Visiteurs mesurés par le quiz lui-même (période comparable) ; diffère légèrement des Arrivés comptés par la page.' },
    rdv_poses_clic: { mot: 'RDV posés par lui (clic)', texte: 'RDV de vente que la personne a créés elle-même dans l’agenda pendant la période, RDV déplacés exclus. Compte d’activité : le chiffre officiel est « Sets », rangé chez le setter de la fiche.' },
    clics_rdv_pose: { mot: 'Clics RDV posé', texte: 'Actions « RDV posé » du journal de Leads Live (clic sur le statut). Un clic n’est pas un set : un set est un RDV réellement créé dans l’agenda.' },
    envois_auto: { mot: 'Envois automatiques', texte: 'Messages partis sans personne derrière : relances, parcours RDV, rappels WhatsApp de RDV. Comptés à part, une seule fois, jamais dans les messages d’une personne ni comme contact d’un rappel.' },
    leads_appeles: { mot: 'Leads appelés', texte: 'Leads dont le 1er appel sortant a été passé pendant la période (population du Lead to speech). Ce ne sont pas les « Leads » (fiches entrées).' },
    decroches_1min: { mot: 'Décrochés ≥ 1 min', texte: 'Appels sortants décrochés dont la conversation a duré au moins 1 minute.' },
    appels_recus_decroches: { mot: 'Reçus décrochés', texte: 'Appels reçus avec au moins 5 secondes de conversation, répondeurs écartés (même règle que Décrochés).' },
    temps_appels_recus: { mot: 'Temps des appels reçus', texte: 'Conversation des appels reçus décrochés. À part du Temps d’appel, qui ne compte que les sortants.' },
    rappel_fait: { mot: 'Rappels (faits)', texte: '« Fait » = un vrai contact de l’équipe avec le prospect (appel, message envoyé par une personne, action sur la fiche) entre 30 min avant l’heure prévue et la fin de la journée ; les envois automatiques ne comptent pas.' },
    reste_du_ttc: { mot: 'Reste dû TTC', texte: 'Montant TTC du contrat moins ce qui a déjà été prélevé, TOUTES échéances comprises (y compris celles qui ne sont pas encore arrivées). Ce n’est pas un montant en retard.' },
    reste_du_ht: { mot: 'Reste dû HT', texte: 'Le reste dû TTC converti hors taxes (÷ 1,2, sauf contrat déjà HT), toutes échéances comprises.' },
    montant_en_retard: { mot: 'Montant en retard TTC', texte: 'Échéances déjà arrivées et non prélevées (nombre d’échéances en retard × montant d’une échéance), TTC. Absent quand le dossier n’est pas un plan en plusieurs fois.' },
    echeances_en_retard: { mot: 'Échéances en retard', texte: 'Échéances qui auraient dû être prélevées à ce jour (une par mois depuis le début du plan) moins celles déjà prélevées.' },
    dossiers_impayes: { mot: 'Dossiers impayés', texte: 'Plans de paiement avec un problème : mandat ou paiement en échec, prélèvement rejeté non rattrapé, échéances en retard, facturation en procédure ou dossier en recouvrement. Même règle que le module Impayés.' },
    fiches_test: { mot: 'Fiches de test', texte: 'Fiches entrées pendant la période et marquées « fiche de test » (essais de l’équipe) : retirées des Leads.' },
    leads_setter_fiche: { mot: 'Leads par setter de la fiche', texte: 'Leads entrés pendant la période, rangés chez le setter de la fiche (setter verrouillé, sinon personne assignée), Self Booking compris : ce ne sont pas les Leads NB reçus de Set NB.' },
    manuels_crees: { mot: 'RDV manuels créés', texte: 'RDV créés à la main dans l’Agenda pendant la période. Jamais dans RDV pris, Sets ni LTB.' },
    rdv_remplacants_crees: { mot: 'RDV de report créés', texte: 'Nouveaux créneaux créés pendant la période pour un RDV déplacé ou transféré : ce ne sont pas de nouveaux RDV pris.' },
    jamais_contactes_24h: { mot: 'Jamais contactés depuis 24 h', texte: 'Leads des 7 derniers jours, entrés depuis plus de 24 h, toujours au statut « nouveau » et sans aucun appel ni SMS sur la fiche.' }
  };

  function mot(cle) { return G[cle] ? G[cle].mot : ''; }
  function texte(cle) { return G[cle] ? G[cle].texte : ''; }
  /* Texte brut pour un attribut title="" (repli là où un « i » ne tient pas). */
  function titre(cle, precision) {
    var t = texte(cle);
    return precision ? (t ? t + ' ' + precision : precision) : t;
  }

  /* ══════════════════════════════════════════════════════════════════════
     7. LE « i » — survol, clic, clavier
     ══════════════════════════════════════════════════════════════════════ */
  var STYLE_ID = 'scStyle';
  var POP_ID = 'scPop';
  var _bound = false;
  var _open = null;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hasDom() { return typeof document !== 'undefined' && !!document.createElement; }

  function ensureUi() {
    if (!hasDom() || _bound) return;
    _bound = true;
    if (!document.getElementById(STYLE_ID)) {
      var css =
        '.sc-i{display:inline-block;width:14px;height:14px;line-height:13px;margin-left:5px;border-radius:50%;border:1px solid currentColor;' +
        'font-size:9.5px;font-weight:800;font-style:normal;font-family:Georgia,serif;text-align:center;text-transform:none;letter-spacing:0;' +
        'opacity:.55;cursor:help;vertical-align:middle;user-select:none;-webkit-user-select:none;flex:none}' +
        '.sc-i:hover,.sc-i:focus,.sc-i.sc-on{opacity:1;outline:none}' +
        '.sc-pop{position:fixed;z-index:9996;max-width:320px;padding:11px 13px;border-radius:12px;font-size:12.5px;line-height:1.5;font-weight:400;' +
        'text-align:left;text-transform:none;letter-spacing:0;white-space:normal;background:#161a2b;color:#eef0f8;border:1px solid rgba(148,163,214,.3);' +
        'box-shadow:0 12px 32px rgba(3,5,14,.55);display:none;pointer-events:none}' +
        '.sc-pop.show{display:block}' +
        '.sc-pop b{display:block;font-size:12.5px;font-weight:700;margin-bottom:3px}' +
        '.sc-pop .sc-x{display:block;margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,214,.25);opacity:.9}' +
        'body.light-theme .sc-pop{background:#ffffff;color:#14182f;border-color:rgba(20,24,48,.16);box-shadow:0 18px 44px rgba(20,24,48,.24)}' +
        'body.light-theme .sc-pop .sc-x{border-top-color:rgba(20,24,48,.14)}' +
        '@media print{.sc-i,.sc-pop{display:none !important}}';
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.appendChild(document.createTextNode(css));
      (document.head || document.documentElement).appendChild(st);
    }
    document.addEventListener('mouseover', function (e) {
      var t = cible(e.target);
      if (t) ouvrir(t, false);
    }, true);
    document.addEventListener('mouseout', function (e) {
      var t = cible(e.target);
      if (t && _open && _open.el === t && !_open.fixe) fermer();
    }, true);
    document.addEventListener('focusin', function (e) {
      var t = cible(e.target);
      if (t) ouvrir(t, false);
    }, true);
    document.addEventListener('focusout', function (e) {
      var t = cible(e.target);
      if (t && _open && _open.el === t && !_open.fixe) fermer();
    }, true);
    /* Clic (et doigt) : ouvre et garde ouvert ; un second clic ou un clic
       ailleurs ferme. Le clic ne traverse pas : un « i » posé dans un chiffre
       cliquable n'ouvre pas la liste derrière. */
    document.addEventListener('click', function (e) {
      var t = cible(e.target);
      if (t) {
        e.preventDefault();
        e.stopPropagation();
        if (_open && _open.el === t && _open.fixe) fermer();
        else ouvrir(t, true);
        return;
      }
      if (_open) fermer();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (!_open) {
        var t = cible(e.target);
        if (t && (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32)) { e.preventDefault(); ouvrir(t, true); }
        return;
      }
      if (e.key === 'Escape' || e.keyCode === 27) fermer();
    }, true);
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', function () { if (_open) fermer(); }, true);
      window.addEventListener('resize', function () { if (_open) fermer(); });
    }
  }
  function cible(n) {
    while (n && n.nodeType === 1) {
      if (n.getAttribute && n.getAttribute('data-sc-i') != null) return n;
      n = n.parentNode;
    }
    return null;
  }
  function pop() {
    var p = document.getElementById(POP_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = POP_ID;
    p.className = 'sc-pop';
    p.setAttribute('role', 'tooltip');
    document.body.appendChild(p);
    return p;
  }
  function ouvrir(el, fixe) {
    var cle = el.getAttribute('data-sc-i') || '';
    var m = el.getAttribute('data-sc-m') || mot(cle);
    var t = el.getAttribute('data-sc-t') || texte(cle);
    var x = el.getAttribute('data-sc-x') || '';
    if (!t && !x) return;
    var p = pop();
    p.innerHTML = (m ? '<b>' + esc(m) + '</b>' : '') + esc(t) + (x ? '<span class="sc-x">' + esc(x) + '</span>' : '');
    p.className = 'sc-pop show';
    var r = el.getBoundingClientRect();
    var w = p.offsetWidth, h = p.offsetHeight;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = r.left + r.width / 2 - w / 2;
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
    var top = r.bottom + 8;
    if (top + h > vh - 8 && r.top - 8 - h > 0) top = r.top - 8 - h;
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
    if (_open && _open.el !== el) _open.el.className = _open.el.className.replace(/\s*sc-on/g, '');
    if (el.className.indexOf('sc-on') < 0) el.className += ' sc-on';
    _open = { el: el, fixe: !!fixe };
  }
  function fermer() {
    var p = hasDom() ? document.getElementById(POP_ID) : null;
    if (p) p.className = 'sc-pop';
    if (_open) _open.el.className = _open.el.className.replace(/\s*sc-on/g, '');
    _open = null;
  }

  /* Le petit « i » d'un terme du glossaire. precision (facultatif) : une
     phrase propre à l'écran, AJOUTÉE sous la définition commune. Renvoie du
     HTML ; chaîne vide côté serveur ou si la clé n'existe pas. */
  function info(cle, precision) {
    if (!hasDom()) return '';
    if (!G[cle]) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[StatsCore] terme absent du glossaire : ' + cle);
      return '';
    }
    ensureUi();
    return '<span class="sc-i" data-sc-i="' + esc(cle) + '"' + (precision ? ' data-sc-x="' + esc(precision) + '"' : '') +
      ' tabindex="0" role="button" aria-label="' + esc('Explication : ' + G[cle].mot) + '">i</span>';
  }
  /* Un « i » au texte libre, pour une précision qui n'est pas un terme du
     glossaire (une note de lecture propre à un écran). Jamais pour redéfinir
     un terme qui existe dans le glossaire. */
  function infoLibre(titreMot, texteLibre) {
    if (!hasDom() || !texteLibre) return '';
    ensureUi();
    return '<span class="sc-i" data-sc-i="" data-sc-m="' + esc(titreMot || '') + '" data-sc-t="' + esc(texteLibre) + '"' +
      ' tabindex="0" role="button" aria-label="' + esc('Explication' + (titreMot ? ' : ' + titreMot : '')) + '">i</span>';
  }
  /* Libellé + « i » d'un coup : « Kept ⓘ ». */
  function motInfo(cle, precision) { return esc(mot(cle)) + info(cle, precision); }

  return {
    /* Réglages */
    CLOSE_AXE: CLOSE_AXE, CORRECTIONS_AUTORISEES: CORRECTIONS_AUTORISEES,
    correctionAutorisee: function (groupe) { return CORRECTIONS_AUTORISEES[groupe] === 1; },
    /* Temps */
    parisParts: parisParts, jourParis: jourParis, moisParis: moisParis,
    dateParis: dateParis, debutJourParis: debutJourParis, finJourParis: finJourParis,
    debutMs: debutMs, finMs: finMs, estPasse: estPasse, toDate: toDate, pad2: pad2,
    /* Classe d'un RDV */
    classifyBooking: classifyBooking, CLASSES: CLASSES, estRdvVente: estRdvVente, estRdvPris: estRdvPris,
    /* État d'un RDV */
    PRESENT: PRESENT, PITCHE: PITCHE, ETATS: ETATS, DETAILS: DETAILS,
    resultat: resultat, etat: etat, detail: detail, libelle: libelle,
    estDoublon: estDoublon, estReplanifie: estReplanifie, estAnnule: estAnnule, estNoShow: estNoShow,
    estPresent: estPresent, estPitche: estPitche, estSansDetail: estSansDetail,
    suivantId: suivantId, estRemplacant: estRemplacant,
    origineAnnulation: origineAnnulation, estNonHonore: estNonHonore, ORIGINES: ORIGINES,
    /* Agrégat et taux */
    vide: vide, ajouter: ajouter, finir: finir, compter: compter, sommer: sommer,
    pct: pct, showUp: showUp, tauxClose: tauxClose, fmtPct: fmtPct, fmtEuro: fmtEuro,
    /* Qui */
    setterDuRdv: setterDuRdv, closerDuRdv: closerDuRdv,
    /* Téléphone */
    DECROCHE_MIN_SEC: DECROCHE_MIN_SEC, estDecroche: estDecroche, sonnerieSec: sonnerieSec,
    /* Glossaire et « i » */
    GLOSSAIRE: G, mot: mot, texte: texte, titre: titre,
    info: info, infoLibre: infoLibre, motInfo: motInfo, fermerInfo: fermer
  };
}));
