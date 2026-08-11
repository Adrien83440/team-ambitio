// ============================================================================
// dispo-core.js — CAPACITÉ DE CRÉNEAUX, PARTAGÉ NAVIGATEUR ↔ SERVEUR
// ----------------------------------------------------------------------------
// Une seule implémentation du calcul « combien de créneaux une personne
// a-t-elle ouverts, pris, laissés libres », utilisée par :
//   · sales-funnel.html              (section « Capacité & dispos »)
//   · api/availability-snapshot.js   (archivage nocturne, Admin SDK)
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// La capacité d'une personne n'est PAS historisée par Firestore : booking_config
// ne contient que ses horaires ACTUELS. Si Élodie retire trois heures le mardi,
// plus rien ne permet de dire ce qu'elle avait ouvert le mois dernier. D'où
// l'archive quotidienne (availability_daily) — et d'où ce module, pour que
// l'archive nocturne et l'affichage du funnel comptent EXACTEMENT pareil.
//
// ⚠ RÈGLE : toute correction de comptage se fait ICI, jamais dans une page.
//
// UNITÉ DE COMPTE : LE CRÉNEAU D'1 H
// ----------------------------------
// Les créneaux réellement proposés au prospect dépendent du type de
// consultation (30 / 45 / 60 min, intervalle, buffers) — donc « le » nombre de
// créneaux d'une personne n'existe pas dans l'absolu. On compte donc en pas
// fixe d'1 h, choisi avec Adrien : une capacité, pas une simulation de booking.
//
// FUSEAU HORAIRE
// --------------
// Tout est ramené à Europe/Paris de façon EXPLICITE (parisStamp), jamais au
// fuseau local de la machine : sinon le serveur Vercel (UTC) décalerait les
// plages Google Calendar de 1 à 2 h par rapport au navigateur d'Adrien, et
// l'archive ne correspondrait pas à l'écran. Les dates « YYYY-MM-DD » sont
// ancrées à midi (T12:00:00) pour ne jamais basculer de jour.
//
// AUCUNE dépendance : ni Firebase, ni DOM, ni window. Les données sont
// toujours reçues en paramètre.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DispoCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Pas de découpage. Changer cette valeur change la définition d'un
     « créneau » — et rend l'archive déjà écrite incomparable. Ne pas toucher
     sans plan de reprise de availability_daily. */
  var SLOT_MINUTES = 60;

  var JOURS_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  /* Statuts de RDV qui CONSOMMENT le créneau. Un no-show a bien occupé la
     case (le closer a attendu) — seul un RDV annulé la libère. */
  var CONSUMING_STATUSES = ['confirmed', 'pending', 'completed', 'no_show'];

  /* Rôles équipe considérés comme « sales » pour cette section. Même liste
     que funnel-core.js — les coachs et la CSM n'ont pas de capacité de vente. */
  var SALES_ROLES = ['setter', 'closer', 'closer_setter'];

  /* Membres partis, exclus en dur même si le roster n'est pas à jour.
     Repris à l'identique de alteore-flow.js (DEPARTED). */
  var DEPARTED = { guillaume: 1 };

  /* Repli quand le roster _meta/team_members ne porte AUCUN rôle sales.
     Ce n'est pas une hypothèse : alteore-flow.js et funnel-core.js portent
     déjà le même repli, parce que le champ `role` n'est pas toujours
     renseigné dans le roster. Sans lui, la section affichait « aucun expert
     rattaché » alors qu'Élodie a bien un planning. Mêmes valeurs que
     alteore-flow.js pour qu'un seul endroit fasse foi si ça change. */
  var ELODIE_FALLBACK = {
    slug: 'elodie', shortName: 'Elodie', displayName: 'Elodie Vidotto Siarri',
    role: 'closer_setter', color: '#60a5fa',
    firebaseUid: 'IrL8bfOrUfMH2fEPFzuojPT8bQh1', active: true
  };

  /* Jours fériés — définition et liste par défaut reprises TELLES QUELLES de
     booking.html, pour que « jour férié » veuille dire la même chose dans le
     moteur de réservation et dans le comptage. */
  var HOLIDAYS_DEF = [
    { id: 'jour_an', month: 1, day: 1 }, { id: 'lundi_paques', easter: 1 },
    { id: 'fete_travail', month: 5, day: 1 }, { id: 'victoire_1945', month: 5, day: 8 },
    { id: 'ascension', easter: 39 }, { id: 'pentecote', easter: 50 },
    { id: 'fete_nationale', month: 7, day: 14 }, { id: 'assomption', month: 8, day: 15 },
    { id: 'toussaint', month: 11, day: 1 }, { id: 'armistice', month: 11, day: 11 },
    { id: 'noel', month: 12, day: 25 }
  ];
  var HOLIDAYS_DEFAULT = ['jour_an', 'fete_travail', 'victoire_1945', 'ascension',
    'pentecote', 'fete_nationale', 'assomption', 'toussaint', 'armistice', 'noel'];


  /* ══════════════════════════════════════════════════════════════
     DATES — jamais toISOString (décalage de fuseau la nuit)
     ══════════════════════════════════════════════════════════════ */
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* Date native → 'YYYY-MM-DD' avec les getters LOCAUX. À n'utiliser que sur
     une Date déjà construite jour par jour (ymdToDate + addDays), jamais sur
     un instant brut côté serveur : pour ça, c'est parisStamp. */
  function toYMD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /* 'YYYY-MM-DD' → Date ancrée à MIDI : ni un passage à l'heure d'été, ni un
     décalage de fuseau ne peuvent la faire changer de jour. */
  function ymdToDate(ds) { return new Date(ds + 'T12:00:00'); }

  function addDays(ds, n) { var d = ymdToDate(ds); d.setDate(d.getDate() + n); return toYMD(d); }

  function monthKeyOf(ds) { return ds.slice(0, 7); }

  /* Liste inclusive des jours entre deux 'YYYY-MM-DD'. Renvoie [] si l'ordre
     est inversé plutôt que de boucler à l'infini. */
  function eachDay(startDs, endDs) {
    var out = [];
    if (!startDs || !endDs || startDs > endDs) return out;
    var cur = startDs;
    /* Garde-fou : 10 ans max, une plage aberrante ne doit pas figer l'onglet. */
    for (var guard = 0; guard < 3700 && cur <= endDs; guard++) {
      out.push(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }

  /* Instant → { ymd, min } À PARIS. Utilisé pour les plages Google Calendar
     (timestamps absolus) et pour « quel jour on est » côté serveur UTC. */
  var _parisFmt = null;
  function parisStamp(dateObj) {
    if (!_parisFmt) {
      _parisFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      });
    }
    var parts = _parisFmt.formatToParts(dateObj), o = {};
    for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
    var hh = parseInt(o.hour, 10);
    if (!isFinite(hh) || hh === 24) hh = 0;              // certaines ICU rendent 24:00
    var mm = parseInt(o.minute, 10);
    return { ymd: o.year + '-' + o.month + '-' + o.day, min: hh * 60 + (isFinite(mm) ? mm : 0) };
  }

  /* Le jour courant À PARIS — la seule définition d'« aujourd'hui » qui donne
     le même résultat dans le navigateur d'Adrien et dans le cron Vercel. */
  function todayParis() { return parisStamp(new Date()).ymd; }


  /* ══════════════════════════════════════════════════════════════
     HEURES
     ══════════════════════════════════════════════════════════════ */
  function timeToMin(t) {
    if (!t) return 0;
    var p = String(t).split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);
  }
  function minToTime(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }


  /* ══════════════════════════════════════════════════════════════
     JOURS FÉRIÉS / JOURS OUVRÉS
     ══════════════════════════════════════════════════════════════ */
  function computeEaster(year) {
    var a = year % 19, b = Math.floor(year / 100), c = year % 100,
      d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
      m = Math.floor((a + 11 * h + 22 * l) / 451),
      month = Math.floor((h + l - 7 * m + 114) / 31),
      day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  /* Cache par année : eachDay sur un an appellerait computeEaster 365 fois. */
  var _holCache = {};
  function holidaySet(year, enabled) {
    var key = year + '|' + enabled.join(',');
    if (_holCache[key]) return _holCache[key];
    var set = {};
    for (var i = 0; i < HOLIDAYS_DEF.length; i++) {
      var hd = HOLIDAYS_DEF[i];
      if (enabled.indexOf(hd.id) < 0) continue;
      var hDate;
      if (hd.month) hDate = new Date(year, hd.month - 1, hd.day);
      else { hDate = computeEaster(year); hDate.setDate(hDate.getDate() + hd.easter); }
      set[toYMD(hDate)] = 1;
    }
    _holCache[key] = set;
    return set;
  }

  /* settings = booking_config/_settings (champ `holidays`). Absent → liste par
     défaut, exactement comme booking.html. */
  function enabledHolidays(settings) {
    var h = settings && settings.holidays;
    return (h && h.length) ? h : HOLIDAYS_DEFAULT;
  }

  function isHoliday(ds, settings) {
    var enabled = enabledHolidays(settings);
    if (!enabled.length) return false;
    return holidaySet(ymdToDate(ds).getFullYear(), enabled)[ds] === 1;
  }

  /* Jour ouvré = lundi→vendredi hors férié. Sert de dénominateur à la moyenne
     « par jour ouvré » : c'est le repère qui parle à une équipe sales. */
  function isWorkingDay(ds, settings) {
    var dow = ymdToDate(ds).getDay();
    if (dow === 0 || dow === 6) return false;
    return !isHoliday(ds, settings);
  }


  /* ══════════════════════════════════════════════════════════════
     PLAGES EFFECTIVES — port à l'identique de booking.html
     (getEffectiveSlotsForDate + _ruleMatchesDate + _subtractIntervals)
     ══════════════════════════════════════════════════════════════ */
  function ruleMatchesDate(r, ds) {
    if (!r || !ds) return false;
    if (r.mode === 'date') return r.date === ds;
    if (r.mode === 'range') {
      if (!r.startDate || !r.endDate) return false;
      return ds >= r.startDate && ds <= r.endDate;
    }
    if (r.mode === 'recurring') {
      if (r.startDate && ds < r.startDate) return false;
      if (r.endDate && ds > r.endDate) return false;
      var d = ymdToDate(ds);
      var dow = d.getDay();
      if (parseInt(r.dayOfWeek, 10) !== dow) return false;
      if (r.pattern === 'every_week') return true;
      if (r.pattern === 'every_2_weeks') {
        if (!r.startDate) return false;
        var s = ymdToDate(r.startDate);
        var diffDays = Math.floor((d - s) / 86400000);
        return diffDays >= 0 && Math.floor(diffDays / 7) % 2 === 0;
      }
      if (r.pattern === 'first_of_month') {
        var first = new Date(d.getFullYear(), d.getMonth(), 1);
        var offset = (dow - first.getDay() + 7) % 7;
        return d.getDate() === (1 + offset);
      }
      if (r.pattern === 'last_of_month') {
        var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        var lastOffset = (lastDay.getDay() - dow + 7) % 7;
        return d.getDate() === (lastDay.getDate() - lastOffset);
      }
      return false;
    }
    return false;
  }

  function subtractIntervals(ranges, blocks) {
    if (!blocks || !blocks.length) return ranges.slice();
    var result = ranges.slice();
    blocks.forEach(function (b) {
      var bs = timeToMin(b.start), be = timeToMin(b.end);
      if (be <= bs) return;
      var next = [];
      result.forEach(function (s) {
        var ss = timeToMin(s.start), se = timeToMin(s.end);
        if (be <= ss || bs >= se) { next.push(s); return; }
        if (bs <= ss && be >= se) return;
        if (bs <= ss && be < se) { next.push({ start: minToTime(be), end: s.end }); return; }
        if (bs > ss && be >= se) { next.push({ start: s.start, end: minToTime(bs) }); return; }
        next.push({ start: s.start, end: minToTime(bs) });
        next.push({ start: minToTime(be), end: s.end });
      });
      result = next;
    });
    return result;
  }

  /* Plages d'ouverture d'une personne un jour donné, après :
       1. horaires récurrents du jour de semaine
       2. dateOverrides (REMPLACENT la journée)
       3. availabilityRules : available+slots remplace, unavailable sans slots
          bloque tout, unavailable avec slots soustrait. */
  function effectiveRanges(person, ds) {
    if (!person || !ds) return [];
    var dayName = JOURS_FULL[ymdToDate(ds).getDay()];
    var sched = person.schedule || {};
    var ranges = (sched[dayName] || []).slice();

    var dOv = person.dateOverrides || {};
    if (dOv[ds]) ranges = dOv[ds].slice();

    var rules = person.availabilityRules || [];
    var matching = rules.filter(function (r) { return ruleMatchesDate(r, ds); });

    matching.forEach(function (r) {
      if (r.type === 'available' && r.slots && r.slots.length) ranges = r.slots.slice();
    });
    for (var i = 0; i < matching.length; i++) {
      var r = matching[i];
      if (r.type === 'unavailable') {
        if (!r.slots || !r.slots.length) return [];
        ranges = subtractIntervals(ranges, r.slots);
      }
    }
    return ranges;
  }

  /* Découpage des plages en créneaux d'1 h. Un reliquat de moins d'1 h n'est
     PAS compté : une demi-heure ouverte n'est pas un rendez-vous vendable. */
  function hourSlots(person, ds, settings) {
    if (!person || !ds) return [];
    if ((person.blockedDates || []).indexOf(ds) >= 0) return [];
    if (isHoliday(ds, settings)) return [];
    var out = [];
    var ranges = effectiveRanges(person, ds);
    for (var i = 0; i < ranges.length; i++) {
      var s = timeToMin(ranges[i].start), e = timeToMin(ranges[i].end);
      for (var m = s; m + SLOT_MINUTES <= e; m += SLOT_MINUTES) out.push(m);
    }
    return out;
  }


  /* ══════════════════════════════════════════════════════════════
     CAPACITÉ D'UNE JOURNÉE
     ══════════════════════════════════════════════════════════════ */
  /* Plages occupées par les RDV de cette personne ce jour-là, en minutes.
     `bookings` = RDV déjà filtrés sur la personne ET la date par l'appelant
     (indexBookings). Les annulés ne consomment rien. */
  function bookedRangesFor(bookings) {
    var out = [];
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      if (CONSUMING_STATUSES.indexOf(b.status) < 0) continue;
      var start = timeToMin(b.time);
      var dur = parseInt(b.duration, 10);
      if (!isFinite(dur) || dur <= 0) dur = 30;
      out.push({ start: start, end: start + dur });
    }
    return out;
  }

  function overlaps(slotStart, ranges) {
    var slotEnd = slotStart + SLOT_MINUTES;
    for (var i = 0; i < ranges.length; i++) {
      if (slotStart < ranges[i].end && slotEnd > ranges[i].start) return true;
    }
    return false;
  }

  /**
   * Capacité d'une personne sur UNE journée.
   * @param person   doc booking_config (__type === 'person')
   * @param ds       'YYYY-MM-DD'
   * @param opts     { settings, bookings: [RDV de cette personne ce jour] }
   * @returns { open, booked, free, work }
   *
   * L'agenda Google personnel n'entre PAS dans le comptage (retiré le
   * 11/08 à la demande d'Adrien) : une heure ouverte au planning mais
   * occupée par un rendez-vous perso compte donc comme libre. En échange
   * le tableau est arithmétiquement simple — Ouverts = Pris + Libres.
   */
  function dayCapacity(person, ds, opts) {
    var o = opts || {};
    var slots = hourSlots(person, ds, o.settings);
    var res = { open: slots.length, booked: 0, free: 0, work: isWorkingDay(ds, o.settings) };
    if (!slots.length) return res;

    var bRanges = bookedRangesFor(o.bookings);
    for (var i = 0; i < slots.length; i++) {
      if (overlaps(slots[i], bRanges)) res.booked++;
    }
    res.free = res.open - res.booked;
    return res;
  }

  /* Index { personId: { 'YYYY-MM-DD': [RDV] } } — construit une fois, évite de
     rebalayer tous les RDV pour chaque personne et chaque jour. */
  function indexBookings(bookings) {
    var idx = {};
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      if (!b || !b.personId || !b.date) continue;
      if (!idx[b.personId]) idx[b.personId] = {};
      (idx[b.personId][b.date] = idx[b.personId][b.date] || []).push(b);
    }
    return idx;
  }

  function emptyTotals() {
    return {
      open: 0, booked: 0, free: 0,
      /* Capacité ouverte sur les seuls jours ouvrés. Sans ça, la moyenne
         « par jour ouvré » d'une personne qui ouvre aussi le samedi serait
         gonflée par des créneaux qui ne tombent pas dans le dénominateur. */
      openWork: 0,
      days: 0, workDays: 0, openDays: 0, estimated: 0
    };
  }

  function addDayTo(tot, day) {
    tot.open += day.open; tot.booked += day.booked; tot.free += day.free;
    tot.days++;
    if (day.work) { tot.workDays++; tot.openWork += day.open; }
    if (day.open > 0) tot.openDays++;
    if (day.estimated) tot.estimated++;
    return tot;
  }

  /**
   * Capacité d'une personne sur une plage de jours.
   *
   * Chaque jour vient SOIT de l'archive (jour écoulé : ce qui était réellement
   * ouvert ce jour-là), SOIT du calcul en direct sur les horaires actuels
   * (aujourd'hui et après — et jours passés non archivés, marqués `estimated`).
   *
   * @param person   doc booking_config
   * @param days     ['YYYY-MM-DD', ...]
   * @param opts     { settings, bookingsByDate: {ds:[RDV]},
   *                   archive: {ds:{open,booked,work,final,approx}}, today: 'YYYY-MM-DD' }
   * @returns { totals, byDay }
   */
  function rangeCapacity(person, days, opts) {
    var o = opts || {};
    var today = o.today || todayParis();
    var archive = o.archive || {};
    var byDate = o.bookingsByDate || {};
    var totals = emptyTotals();
    var byDay = {};

    for (var i = 0; i < days.length; i++) {
      var ds = days[i];
      var a = archive[ds];
      var day;
      /* `final` = l'entrée a été écrite APRÈS la fin de la journée : le nombre
         de RDV pris y est définitif. Une entrée non finale (l'instantané du
         matin même, ou une nuit où le cron a planté avant la fin) ne doit PAS
         faire foi — sinon un jour resterait éternellement à « 0 pris ». */
      if (a && a.final === true && ds < today) {
        day = {
          open: a.open || 0, booked: a.booked || 0,
          /* `free` est TOUJOURS recalculé, jamais lu : les entrées écrites
             avant le 11/08 stockent un free amputé de l'agenda perso, qui
             ne veut plus rien dire sous la définition actuelle. */
          free: (a.open || 0) - (a.booked || 0),
          work: a.work != null ? a.work : isWorkingDay(ds, o.settings),
          /* `approx` : capacité reconstituée par un rattrapage tardif, donc
             depuis des horaires postérieurs à la journée concernée. */
          estimated: a.approx === true
        };
      } else {
        day = dayCapacity(person, ds, { settings: o.settings, bookings: byDate[ds] });
        /* Jour passé sans archive = reconstitué depuis les horaires
           d'aujourd'hui. Le chiffre est plausible, pas constaté : on le marque
           pour que l'écran puisse le dire. */
        day.estimated = ds < today;
      }
      byDay[ds] = day;
      addDayTo(totals, day);
    }
    return { totals: totals, byDay: byDay };
  }

  function sumTotals(list) {
    var t = emptyTotals();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      t.open += s.open; t.booked += s.booked; t.free += s.free;
      t.openWork += s.openWork;
      t.estimated += s.estimated;
      /* days / workDays sont des propriétés du CALENDRIER, pas des personnes :
         additionner celles de 3 closeurs donnerait 93 jours dans un mois. On
         garde donc le max, qui vaut la longueur de la période. */
      t.days = Math.max(t.days, s.days);
      t.workDays = Math.max(t.workDays, s.workDays);
      t.openDays = Math.max(t.openDays, s.openDays);
    }
    return t;
  }

  function fillRate(t) {
    if (!t || !t.open) return null;
    return (t.booked / t.open) * 100;
  }


  /* ══════════════════════════════════════════════════════════════
     PÉRIMÈTRE — quels experts booking sont des « sales »
     ══════════════════════════════════════════════════════════════ */
  /* Membres sales du roster — MÊME règle que alteore-flow.js salesMembers()
     (rôle sales, actif, non parti), repli Élodie compris. */
  function salesTeamMembers(teamMembers) {
    var all = teamMembers || [];
    var list = all.filter(function (m) {
      return m && m.slug && !DEPARTED[m.slug] && m.active !== false && SALES_ROLES.indexOf(m.role) >= 0;
    });
    if (list.length) return { list: list, fallback: false, teamCount: all.length };
    return { list: [ELODIE_FALLBACK], fallback: true, teamCount: all.length };
  }

  /**
   * Rapproche les experts booking_config des membres d'équipe sales.
   *
   * Clé primaire : firebaseUid (posé par l'admin dans booking-admin).
   * Replis sur le nom, parce qu'un expert non rapproché disparaît de l'écran
   * en silence — pire qu'un rapprochement approximatif signalé :
   *   · nom complet normalisé  (« Élodie » ≡ « elodie »)
   *   · prénom seul            (« Elodie Vidotto Siarri » ≡ « Elodie »)
   *
   * @returns { list: [{person, member, matchedBy}], fallback, teamCount, salesCount }
   */
  function salesPersons(persons, teamMembers) {
    var team = salesTeamMembers(teamMembers);
    var byUid = {}, byName = {};
    team.list.forEach(function (m) {
      if (m.firebaseUid) byUid[m.firebaseUid] = m;
      [m.shortName, m.displayName, m.slug].forEach(function (n) {
        if (n) byName[normName(n)] = m;
      });
    });

    var out = [];
    (persons || []).forEach(function (p) {
      if (!p || p.isCoach === true) return;
      var m = null, how = null;
      var full = p.name ? normName(p.name) : '';
      var first = p.name ? normName(String(p.name).split(/\s+/)[0]) : '';
      if (p.firebaseUid && byUid[p.firebaseUid]) { m = byUid[p.firebaseUid]; how = 'uid'; }
      else if (full && byName[full]) { m = byName[full]; how = 'nom'; }
      else if (first && byName[first]) { m = byName[first]; how = 'prenom'; }
      if (!m) return;
      out.push({ person: p, member: m, matchedBy: how });
    });
    out.sort(function (a, b) { return (a.person.name || '').localeCompare(b.person.name || ''); });
    return {
      list: out, fallback: team.fallback,
      teamCount: team.teamCount, salesCount: team.list.length
    };
  }

  /* Minuscules sans accents ni espaces : « Élodie » ≡ « elodie ». */
  function normName(s) {
    return String(s || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }


  /* ══════════════════════════════════════════════════════════════
     ARCHIVE — availability_daily
     ══════════════════════════════════════════════════════════════ */
  /* Un document par personne et par mois : borne le nombre de docs
     (nb personnes × 12 / an) et permet de charger un mois en une lecture. */
  function archiveDocId(personId, monthKey) { return personId + '__' + monthKey; }

  /* Marqueurs posés sur une entrée d'archive au moment de l'écrire.
       final  : la journée est terminée → le nombre de RDV pris est définitif.
       approx : écrite plus d'un jour après coup (rattrapage), donc capacité
                reconstituée depuis des horaires postérieurs à la journée.
     Ces deux drapeaux sont ce qui permet à rangeCapacity de distinguer
     « constaté » de « reconstitué » — d'où leur place ici et pas dans
     l'endpoint, où ils ne seraient pas testables. */
  function archiveDayMeta(ds, today) {
    return { final: ds < today, approx: ds < addDays(today, -1) };
  }

  /* Faut-il réécrire ce jour ? Seule une entrée déjà CLÔTURÉE est intouchable :
     sans ça, une nuit ratée figerait un jour sur l'instantané du matin
     (capacité correcte mais « 0 RDV pris »). */
  function shouldRewriteArchiveDay(existingEntry) {
    return !(existingEntry && existingEntry.final === true);
  }

  /* Mois couverts par une plage de jours, sans doublon, en ordre. */
  function monthKeysFor(days) {
    var seen = {}, out = [];
    for (var i = 0; i < days.length; i++) {
      var mk = monthKeyOf(days[i]);
      if (!seen[mk]) { seen[mk] = 1; out.push(mk); }
    }
    return out;
  }


  return {
    SLOT_MINUTES: SLOT_MINUTES,
    SALES_ROLES: SALES_ROLES,
    CONSUMING_STATUSES: CONSUMING_STATUSES,
    HOLIDAYS_DEFAULT: HOLIDAYS_DEFAULT,

    pad2: pad2,
    toYMD: toYMD,
    ymdToDate: ymdToDate,
    addDays: addDays,
    eachDay: eachDay,
    monthKeyOf: monthKeyOf,
    parisStamp: parisStamp,
    todayParis: todayParis,

    timeToMin: timeToMin,
    minToTime: minToTime,

    computeEaster: computeEaster,
    isHoliday: isHoliday,
    isWorkingDay: isWorkingDay,

    ruleMatchesDate: ruleMatchesDate,
    subtractIntervals: subtractIntervals,
    effectiveRanges: effectiveRanges,
    hourSlots: hourSlots,

    dayCapacity: dayCapacity,
    rangeCapacity: rangeCapacity,
    indexBookings: indexBookings,
    emptyTotals: emptyTotals,
    sumTotals: sumTotals,
    fillRate: fillRate,

    salesPersons: salesPersons,
    salesTeamMembers: salesTeamMembers,
    normName: normName,

    archiveDocId: archiveDocId,
    archiveDayMeta: archiveDayMeta,
    shouldRewriteArchiveDay: shouldRewriteArchiveDay,
    monthKeysFor: monthKeysFor
  };
}));
