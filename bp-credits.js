// ============================================================================
// bp-credits.js — BUSINESS PHÉNIX NOUVEAU FORMAT : COMPTEUR DE SÉANCES
// ----------------------------------------------------------------------------
// Partagé navigateur ↔ serveur, comme funnel-core.js :
//   · coaching.html, csm-clients.html, csm-cockpit.html (<script>)
//   · api/bp-seances.js, api/booking-check-coaching-quota.js,
//     api/booking-series-create.js, api/_clientHealth.js (require)
//
// RÈGLES (cahier des charges du 14/10/2026, décisions d'Adrien) :
//   · 10 séances individuelles de 60 min, créneau fixe toutes les deux
//     semaines, sur 180 jours à compter de J0 = DÉMARRAGE (la signature si
//     le client renonce au délai de rétractation, sinon J+15 — décision
//     Adrien du 14/10/2026) ;
//   · séance 0 = « RDV audit business » de 30 min avec un coach (type
//     rdv72h), HORS des 10 ;
//   · consomme une séance : séance tenue (fiche, statut 'fait'), absence ou
//     report à moins de 48 h (statut 'consommee' sur la fiche, OU réservation
//     no_show / annulée par le client < 48 h avant — détectée seule) ;
//   · ne consomme pas : report ≥ 48 h, annulation par l'équipe ;
//   · au-delà du total → bloqué ; après J0 + 180 → séances restantes perdues ;
//   · seules les personnes de _config/business_phenix.sessionGranters
//     (Adrien, Emily) ajoutent des séances ou dispensent une consommation —
//     sous-collection clients/{id}/seances_ajouts, écrite par api/bp-seances.
//
// AUCUNE dépendance : ni Firebase, ni DOM. ES5 strict.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BPCredits = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROGRAMME = 'Business NEW - 6 Mois - 10C';
  var LIBELLE = 'Business Phénix';
  var LIBELLE_ANCIEN = 'Business Phénix — ancienne formule 12 mois';
  var TOTAL = 10;
  var DUREE_JOURS = 180;
  var PERIODE_JOURS = 14;
  var DELAI_REPORT_H = 48;
  var SEANCE1_JOURS = 7;
  var TITRE_AUDIT = 'RDV AUDIT BUSINESS';

  /* Les 10 séances (cahier §6.3) et leurs jalons (§6.4). */
  var SEANCES = [
    { n: 1,  titre: 'Diagnostic et cadrage',                    moteur: 'Cadrage',      jalon: 'J1',  jalonTitre: 'Point A et point B déposés, créneau récurrent posé' },
    { n: 2,  titre: 'Lire ses chiffres',                        moteur: 'Piloter',      jalon: 'J2',  jalonTitre: 'Tableau de bord mensuel en place' },
    { n: 3,  titre: 'Le temps du dirigeant',                    moteur: 'Piloter',      jalon: 'J3',  jalonTitre: 'Revue mensuelle des chiffres tenue' },
    { n: 4,  titre: 'Marge par produit et construction des prix', moteur: 'Se rémunérer', jalon: 'J4', jalonTitre: 'Grille de prix revue' },
    { n: 5,  titre: 'Charges, seuil de rentabilité, trésorerie', moteur: 'Se rémunérer', jalon: 'J5',  jalonTitre: 'Plan d\'économies chiffré et seuil de rentabilité' },
    { n: 6,  titre: 'La rémunération du dirigeant',             moteur: 'Se rémunérer', jalon: 'J6',  jalonTitre: 'Montant et date du premier salaire fixés' },
    { n: 7,  titre: 'Offre et concept',                         moteur: 'Vendre',       jalon: 'J7',  jalonTitre: 'Offre retravaillée' },
    { n: 8,  titre: 'Acquisition de base',                      moteur: 'Vendre',       jalon: 'J8',  jalonTitre: 'Plan d\'action commercial sur 90 jours' },
    { n: 9,  titre: 'Premières délégations',                    moteur: 'Vendre',       jalon: 'J9',  jalonTitre: '2 tâches déléguées avec procédure' },
    { n: 10, titre: 'Bilan',                                    moteur: 'Bilan',        jalon: 'J10', jalonTitre: 'Plan autonome, orientation éventuelle vers Elite', jalonTitreClient: 'Plan autonome des 6 mois suivants' }
  ];

  /* Documents à déposer avant la séance 1 (cahier §6.3). */
  var DOCUMENTS_SEANCE1 = [
    'Dernier bilan et compte de résultat (à défaut, l\'export comptable de l\'année)',
    'CA mensuel des 6 derniers mois',
    'Liste des produits ou services avec leurs prix',
    'Liste des charges fixes mensuelles',
    'Rémunération actuelle du dirigeant',
    'Semaine type'
  ];

  /* ── Programme ── */
  function isBusinessV2(programme) { return /^\s*business\s+new\b/i.test(String(programme || '')); }
  function isBusinessAncien(programme) { return /^\s*bp\s*12\b/i.test(String(programme || '')); }
  function libelleProgramme(programme) {
    if (isBusinessV2(programme)) return LIBELLE;
    if (isBusinessAncien(programme)) return LIBELLE_ANCIEN;
    return String(programme || '');
  }
  function seanceInfo(n) { for (var i = 0; i < SEANCES.length; i++) if (SEANCES[i].n === n) return SEANCES[i]; return null; }

  /* ── Dates (jour calendaire, Europe/Paris) ── */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdParis(d) {
    d = d || new Date();
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
    } catch (e) {}
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDays(ymd, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return '';
    var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }
  function daysBetween(a, b) {
    var ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a || '')), mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b || ''));
    if (!ma || !mb) return 0;
    return Math.round((Date.UTC(+mb[1], +mb[2] - 1, +mb[3]) - Date.UTC(+ma[1], +ma[2] - 1, +ma[3])) / 86400000);
  }
  /* Instant (ms) d'un créneau « YYYY-MM-DD » + « HH:MM » heure de Paris. */
  function parisMs(date, time) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
    if (!m) return 0;
    var t = /^(\d{1,2}):(\d{2})/.exec(String(time || '')) || [0, 12, 0];
    var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
      var o = {};
      parts.forEach(function (p) { o[p.type] = p.value; });
      var asParis = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute);
      return guess - (asParis - guess);
    } catch (e) { return guess - 3600000; }
  }
  function toMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (v.seconds != null) return v.seconds * 1000;
    if (v._seconds != null) return v._seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }

  /* ── Fiche ── */
  function flatSessions(c) {
    var out = [];
    if (c && Array.isArray(c.years) && c.years.length) {
      c.years.forEach(function (y, yi) { (y.sessions || []).forEach(function (s) { out.push({ s: s, yi: yi }); }); });
    } else if (c && Array.isArray(c.sessions)) {
      c.sessions.forEach(function (s) { out.push({ s: s, yi: -1 }); });
    }
    return out;
  }
  function isAudit(s) { return !!s && (s.numero === 0 || s.type === 'rdv72h'); }
  function j0Of(c) { return (c && (c.j0 || c.dateEntree)) || ''; }
  function finOf(c) { return (c && c.finAccompagnement) || (j0Of(c) ? addDays(j0Of(c), DUREE_JOURS) : ''); }

  /* ── Réservations ── */
  function fold(s) { return String(s || '').toLowerCase().replace(/[àâä]/g, 'a').replace(/[éèêë]/g, 'e'); }
  /* RDV audit business / RDV 72 h : séance 0, jamais une des 10. */
  function isAuditBooking(b) {
    var t = fold((b.type || '') + ' ' + (b.typeLabel || '') + ' ' + (b.typeName || '') + ' ' + (b.title || ''));
    return /audit|urgent|72\s*h|rdv72|plan.?d.?action/.test(t);
  }
  function cancelInfo(b) {
    var c = b.cancellation || {};
    return { origin: c.origin || b.cancelledOrigin || '', at: toMs(c.at) || toMs(b.cancelledAt) };
  }
  /* 'tenue' | 'consommee' | 'reportee' | 'annulee_equipe' | 'a_statuer' |
     'planifiee' | null (pas une séance individuelle). */
  function classify(b, nowMs) {
    if (!b || b.isCoaching !== true || isAuditBooking(b)) return null;
    var start = parisMs(b.date, b.time);
    if (b.status === 'no_show') return { statut: 'consommee', motif: 'absence', start: start };
    if (b.status === 'completed') return { statut: 'tenue', start: start };
    if (b.status === 'cancelled') {
      var ci = cancelInfo(b);
      if (ci.origin === 'equipe' || ci.origin === 'systeme') return { statut: 'annulee_equipe', start: start };
      if (ci.origin === 'prospect' && ci.at && start) {
        var h = (start - ci.at) / 3600000;
        return h < DELAI_REPORT_H ? { statut: 'consommee', motif: 'report_tardif', start: start, heures: Math.round(h) } : { statut: 'reportee', start: start };
      }
      /* Origine ou heure d'annulation inconnues : on ne consomme jamais une
         séance sur une donnée incomplète (rattrapable par le coach). */
      return { statut: 'reportee', start: start, incertain: true };
    }
    if (start && start < (nowMs || Date.now())) return { statut: 'a_statuer', start: start };
    return { statut: 'planifiee', start: start };
  }

  /* ── Compteur ──
     client  : fiche clients/{id}
     opts    : { bookings: [...], ajouts: [...] (seances_ajouts), now: Date } */
  function compute(client, opts) {
    opts = opts || {};
    var now = opts.now || new Date(), nowMs = now.getTime(), today = ymdParis(now);
    var ajouts = opts.ajouts || [], bookings = opts.bookings || [];
    var bonus = 0, dispenses = {};
    ajouts.forEach(function (a) {
      if (!a || a.annule === true) return;
      if (a.kind === 'dispense' && a.bookingId) dispenses[a.bookingId] = a;
      else if (a.kind !== 'dispense') bonus += Math.max(0, Number(a.delta) || 0);
    });
    var total = TOTAL + bonus;

    var tenues = 0, consoFiche = 0, dates = {}, linked = {};
    flatSessions(client).forEach(function (x) {
      var s = x.s;
      if (isAudit(s)) return;
      if (s.statut === 'fait') { tenues++; if (s.date) dates[s.date] = 1; }
      if (s.statut === 'consommee') { consoFiche++; if (s.date) dates[s.date] = 1; if (s.bookingId) linked[s.bookingId] = 1; }
    });

    var auto = [], historique = [];
    bookings.forEach(function (b) {
      var k = classify(b, nowMs);
      if (!k) return;
      historique.push({ id: b.id, date: b.date, time: b.time, statut: k.statut, motif: k.motif || '', start: k.start, personName: b.personName || '', incertain: !!k.incertain });
      if (k.statut !== 'consommee') return;
      if (linked[b.id] || dispenses[b.id] || dates[b.date]) return;
      auto.push({ id: b.id, date: b.date, time: b.time, motif: k.motif, heures: k.heures, personName: b.personName || '' });
    });
    historique.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });

    var consumed = tenues + consoFiche + auto.length;
    var restantes = Math.max(0, total - consumed);
    var j0 = j0Of(client), fin = finOf(client);
    var expired = !!fin && today > fin;
    var joursRestants = fin ? Math.max(0, daysBetween(today, fin)) : 0;
    var creneauxRestants = expired ? 0 : Math.ceil(joursRestants / PERIODE_JOURS);

    var alertes = [];
    if (!expired && j0 && daysBetween(j0, today) > SEANCE1_JOURS && tenues === 0) {
      alertes.push({ code: 'seance1_j7', niveau: 'rouge', texte: 'Séance 1 non tenue à J+' + SEANCE1_JOURS + ' (J0 le ' + j0.split('-').reverse().join('/') + ')' });
    }
    var passees = historique.filter(function (h) { return h.statut !== 'planifiee' && h.statut !== 'annulee_equipe' && h.statut !== 'a_statuer' && h.start && h.start < nowMs; });
    if (passees.length >= 2) {
      var a1 = passees[passees.length - 1], a2 = passees[passees.length - 2];
      if (a1.statut !== 'tenue' && a2.statut !== 'tenue') {
        alertes.push({ code: 'deux_non_tenus', niveau: 'orange', texte: '2 créneaux consécutifs non tenus (' + a2.date.split('-').reverse().join('/') + ', ' + a1.date.split('-').reverse().join('/') + ')' });
      }
    }
    if (!expired && restantes > creneauxRestants) {
      alertes.push({ code: 'retard', niveau: 'orange', texte: restantes + ' séance' + (restantes > 1 ? 's' : '') + ' restante' + (restantes > 1 ? 's' : '') + ' pour ' + creneauxRestants + ' créneau' + (creneauxRestants > 1 ? 'x' : '') + ' avant la fin (' + fin.split('-').reverse().join('/') + ')' });
    }
    if (expired && restantes > 0) {
      alertes.push({ code: 'expire', niveau: 'info', texte: 'Accompagnement terminé le ' + fin.split('-').reverse().join('/') + ' — ' + restantes + ' séance' + (restantes > 1 ? 's' : '') + ' perdue' + (restantes > 1 ? 's' : '') });
    }

    return {
      total: total, base: TOTAL, bonus: bonus, tenues: tenues, consommeesFiche: consoFiche,
      consommeesAuto: auto, consommees: consoFiche + auto.length, consumed: consumed, restantes: restantes,
      j0: j0, fin: fin, today: today, expired: expired, joursRestants: joursRestants, creneauxRestants: creneauxRestants,
      complet: consumed >= total, bloque: consumed >= total || expired,
      alertes: alertes, historique: historique
    };
  }

  /* Trame de compte rendu (cahier §6.5), pré-remplie. */
  function trameCompteRendu(n, ctx) {
    ctx = ctx || {};
    var info = seanceInfo(n) || { titre: '', jalon: 'J' + n };
    var L = [];
    L.push('Compte rendu — Séance ' + n + '/' + TOTAL + ' — ' + info.titre + ' — ' + (ctx.date ? String(ctx.date).split('-').reverse().join('/') : '[date]'));
    L.push('Client : ' + (ctx.client || '[entreprise, dirigeant]') + '        Coach référent : ' + (ctx.coach || '[nom]'));
    L.push('');
    L.push('1. Actions de la séance précédente');
    L.push('   - [action] : faite / partielle / non faite — [commentaire]');
    L.push('');
    if (n >= 3) {
      L.push('2. Chiffres du moment');
      L.push('   CA du mois : …   Taux de marge brute : …   Charges fixes : …');
      L.push('   Trésorerie fin de mois : …   Panier moyen : …   Salaire du dirigeant : …');
    } else {
      L.push('2. Chiffres du moment (à partir de la séance 3)');
    }
    L.push('');
    L.push('3. Ce qu\'on a travaillé');
    L.push('   [3 à 6 lignes]');
    L.push('');
    L.push('4. Décisions prises');
    L.push('   [liste courte]');
    L.push('');
    L.push('5. Jalon ' + info.jalon + (info.jalonTitre ? ' (' + info.jalonTitre + ')' : '') + ' : atteint / en cours — [ce qui manque]');
    L.push('');
    L.push('6. Actions d\'ici la prochaine séance (3 maximum, datées)');
    L.push('   1. [action] — pour le [date]');
    L.push('   2. [action] — pour le [date]');
    L.push('   3. [action] — pour le [date]');
    L.push('');
    L.push('Prochaine séance : [date, heure] — Séances restantes : ' + (ctx.restantes != null ? ctx.restantes : '[x]') + '/' + TOTAL + ' — Fin d\'accompagnement : ' + (ctx.fin ? String(ctx.fin).split('-').reverse().join('/') : '[J0 + 180]'));
    return L.join('\n');
  }

  /* Gabarit des séances d'une fiche neuve : RDV audit business + 10 séances. */
  function sessionsTemplate() {
    var out = [{ numero: 0, titre: TITRE_AUDIT, date: '', coach: '', resume: '', devoirs: '', statut: 'planifie', type: 'rdv72h' }];
    SEANCES.forEach(function (s) {
      out.push({ numero: s.n, titre: 'SÉANCE ' + s.n + '/' + TOTAL + ' — ' + s.titre.toUpperCase(), date: '', coach: '', resume: '', devoirs: '', statut: 'planifie', jalon: s.jalon, moteur: s.moteur });
    });
    return out;
  }

  return {
    PROGRAMME: PROGRAMME, LIBELLE: LIBELLE, LIBELLE_ANCIEN: LIBELLE_ANCIEN, TOTAL: TOTAL,
    DUREE_JOURS: DUREE_JOURS, PERIODE_JOURS: PERIODE_JOURS, DELAI_REPORT_H: DELAI_REPORT_H,
    TITRE_AUDIT: TITRE_AUDIT, SEANCES: SEANCES, DOCUMENTS_SEANCE1: DOCUMENTS_SEANCE1,
    isBusinessV2: isBusinessV2, isBusinessAncien: isBusinessAncien, libelleProgramme: libelleProgramme,
    seanceInfo: seanceInfo, ymdParis: ymdParis, addDays: addDays, daysBetween: daysBetween, parisMs: parisMs,
    j0Of: j0Of, finOf: finOf, isAuditBooking: isAuditBooking, classify: classify, compute: compute,
    trameCompteRendu: trameCompteRendu, sessionsTemplate: sessionsTemplate
  };
}));
