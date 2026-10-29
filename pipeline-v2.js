/* ═══════════════════════════════════════════════════════════════════════════
   pipeline-v2.js — Nouveau Pipeline (21/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Module d'interface, sans aucun accès direct à Firebase : toutes les
   lectures et écritures passent par un « hôte » fourni au démarrage.
     - Labo (sandbox-pipeline.html) : hôte = sandbox-pipeline-data.js,
       faux leads en mémoire, rien ne part.
     - Plus tard, le vrai Pipeline : hôte branché sur Firestore et
       AlteoreFlow, même module.

   Démarrage : PipelineV2.start(elementRacine, hote)

   L'hôte expose :
     me {slug,name} · team [{slug,name,color}] · leads() · bookings()
     (objet leadId → [bookings]) · pref(cle[, valeur])
     setStage(lead, stage, cb) · addNote(lead, texte, cb)
     logCall(lead, {answered, result, duration}, cb)
     sendMessage(lead, canal, texte, cb) · addFollowUp(lead, {dateTime, note}, cb)
     update(lead, champ, valeur, cb) · setAssigned(lead, slug, cb)
     addTag(lead, tag, cb) · bump(lead, cb) · generateAi(lead, cb)
     createLead({nom, telephone, email}, cb) · callDetail(lead, comm, cb)
     openClose(lead) · openBooking(lead) · call(lead) · listen(lead, comm)
     objectionsOf(booking) (facultatif)
     setOutcome(lead, booking, outcome, {origin, kind, note}, cb)
       résultat d'un RDV (annulé / non honoré / no show / offre / non closé)
     openLeadsLive(lead) : ouvre la même fiche dans Leads Live

   Données lues sur le lead : champs réels de `leads` (stage, telephone,
   communications[], notesHistory[], timeline_history[], followUps[], quiz,
   formAnswers, attributionFirst, landingFirst, aiLead, closedData…) et
   les bookings réels (date, time, outcome, outcomeNote, cancellation,
   presenceConfirmed, replay, aiPrep). Rien n'est inventé à l'affichage :
   les phrases « où il en est » sont déduites de ces champs.

   Colonnes (29/10/2026) : une par étape, définies dans pipeline-etapes.js,
   le MÊME classement que la liste déroulante de Leads Live.
   ES5 strict. Dépend de pipeline-etapes.js (à charger avant).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ═══ 1. Modèle ═══
     Colonnes, sous-filtres et classement : pipeline-etapes.js (partagé avec
     Leads Live). Refonte du 29/10/2026 : une colonne par étape, dans l'ordre
     des SOP. d.fam reste un regroupement interne (phrases « où il en est »,
     paniers de la vue Rappels). */
  var E = window.PipelineEtapes;
  var COLS = E.COLS;
  var STAGE_LABEL = E.STAGE_LABEL;
  var FAM_OF_COL = { lead: 'joindre', nrp1: 'joindre', nrp2: 'joindre', nrp3: 'joindre', all_nrp: 'joindre', fu: 'relance', set: 'rdv', sb: 'rdv', perdu: 'sansuite', closing: 'client', poubelle: 'ecarte', disqua: 'ecarte' };
  var NRP_STAGES = { lead: 1, nrp1: 1, nrp2: 1, nrp3: 1, all_nrp: 1 };
  var LOST_STAGES = { rdv_annules_prospect: 1, rdv_annules_equipe: 1, no_show_self: 1, no_show_setting: 1, follow_up_closing: 1, closed_lost: 1 };
  var OUTCOME = { close: 'Closé', non_close: 'Non closé', offre: 'Offre envoyée', disqualifie: 'Disqualifié', no_show: 'Absence', annule: 'Annulé', replanifie: 'Replanifié' };
  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var MOISL = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  var DAY = 864e5;

  var BASKETS = [
    { id: 'sansuite', ic: 'check', t: 'No show / Annulé / Closed Lost', s: 'Ont eu un RDV, n\'ont pas signé', cols: ['perdu'] },
    { id: 'joindre',  ic: 'off',   t: 'Lead / NRP',                     s: 'Pas encore eus au téléphone', cols: ['lead', 'nrp1', 'nrp2', 'nrp3', 'all_nrp'] },
    { id: 'relance',  ic: 'redo',  t: 'FU',                             s: 'Rappel convenu avec eux', cols: ['fu'] }
  ];

  var IC = {
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    sms: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    wa: '<path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 7.8 19.6z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    chev: '<path d="M9 6l6 6-6 6"/>', back: '<path d="M15 6l-6 6 6 6"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="M8 12l3 3 5-5"/><circle cx="12" cy="12" r="9"/>',
    off: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M3 3l18 18"/>',
    redo: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    play: '<path d="M7 4v16l13-8z"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    note: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>', up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    bolt: '<path d="M13 3 4 14h7l-1 7 9-11h-7z"/>',
    fold: '<path d="M14 6l-6 6 6 6"/>', unfold: '<path d="M10 6l6 6-6 6"/>', step: '<path d="M4 12h12M12 6l6 6-6 6"/>'
  };
  function ic(n) { return '<svg class="pv2i" viewBox="0 0 24 24" aria-hidden="true">' + (IC[n] || '') + '</svg>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function cut(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, a, b) { return n + ' ' + (n > 1 ? (b || a + 's') : a); }

  /* ═══ 2. Dates ═══ */
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (e) { return null; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var s = String(v).trim();
    /* Formats français des notes / timeline : « 19/03/2026 15:10 », « 19/03 15:10 », « 19/03/2026, 15:10:00 » */
    var m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:[ ,à]+(\d{1,2})[:hH](\d{2}))?/);
    if (m) {
      var y = m[3] ? +m[3] : new Date().getFullYear();
      if (y < 100) y += 2000;
      var d = new Date(y, +m[2] - 1, +m[1], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
      if (!m[3] && d.getTime() > Date.now() + DAY) d.setFullYear(y - 1);
      return d.getTime();
    }
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function daysSince(ms) { return ms == null ? null : Math.max(0, Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / DAY)); }
  function fdate(ms) {
    if (ms == null) return '—';
    var d = new Date(ms), y = d.getFullYear() !== new Date().getFullYear();
    return d.getDate() + ' ' + MOIS[d.getMonth()] + (y ? ' ' + d.getFullYear() : '');
  }
  function fdateL(ms) { var d = new Date(ms); return JOURS[d.getDay()] + ' ' + fdate(ms); }
  function fhour(ms) { var d = new Date(ms), mn = d.getMinutes(); return d.getHours() + ' h' + (mn ? ' ' + (mn < 10 ? '0' : '') + mn : ''); }
  function fhm(ms) { var d = new Date(ms); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  function frel(ms) {
    var dd = Math.round((startOfDay(ms) - startOfDay(Date.now())) / DAY);
    if (dd === 0) return 'aujourd\'hui à ' + fhour(ms);
    if (dd === 1) return 'demain à ' + fhour(ms);
    if (dd === -1) return 'hier à ' + fhour(ms);
    return 'le ' + fdateL(ms) + ' à ' + fhour(ms);
  }
  function fdur(sec) { sec = +sec || 0; var m = Math.floor(sec / 60), s = sec % 60; return m ? m + ' min' + (s ? ' ' + (s < 10 ? '0' : '') + s : '') : s + ' s'; }
  function since(days) {
    if (days == null) return 'aucun contact';
    if (days === 0) return 'contact aujourd\'hui';
    if (days < 60) return days + ' j sans contact';
    return Math.round(days / 30) + ' mois sans contact';
  }
  function bookingStart(b) {
    if (!b || !b.date) return null;
    var p = String(b.date).split('-'), h = String(b.time || '12:00').split(':');
    return new Date(+p[0], +p[1] - 1, +p[2], +h[0] || 0, +h[1] || 0).getTime();
  }

  /* ═══ 3. Lecture d'un lead ═══ */
  var H = null;           // hôte
  var BOOK = {};          // leadId → bookings
  var CACHE = {};         // leadId → dérivé

  function realDate(l) {
    var c = [toMs(l.dateWebinaire), toMs(l.importedCreatedAt), toMs(l.createdAt)].filter(function (x) { return x; });
    return c.length ? Math.min.apply(null, c) : null;
  }
  function commsOf(l) {
    return (l.communications || []).map(function (c, i) {
      return { c: c, i: i, ms: toMs(c.date || c.createdAt || c.at || c.timestamp) };
    }).filter(function (x) { return x.ms; });
  }
  function isAnswered(c) { return c.type === 'call' && (c.answered === true || (+c.duration || 0) >= 30); }
  function lastContact(l) {
    var best = toMs(l.lastContactAt);
    commsOf(l).forEach(function (x) { if (x.c.type !== 'note' && !x.c.auto && (!best || x.ms > best)) best = x.ms; });
    return best;
  }
  function bookingsOf(l) {
    return (BOOK[l.id] || []).slice().sort(function (a, b) { return (bookingStart(a) || 0) - (bookingStart(b) || 0); });
  }
  function isCancelled(b) { return b.status === 'cancelled' || b.outcome === 'annule'; }
  function bookingResult(b) {
    var st = bookingStart(b), now = Date.now();
    if (isCancelled(b)) {
      var o = b.cancellation && b.cancellation.origin;
      if (b.cancellation && b.cancellation.kind === 'non_honore') return { label: 'Non honoré par l\'équipe', tone: 'late', key: 'annule' };
      return { label: o === 'prospect' ? 'Annulé par le prospect' : o === 'equipe' ? 'Annulé par l\'équipe' : 'Annulé', tone: 'warn', key: 'annule' };
    }
    if (b.outcome) return { label: OUTCOME[b.outcome] || b.outcome, tone: b.outcome === 'close' ? 'go' : b.outcome === 'offre' ? 'go' : b.outcome === 'replanifie' ? 'grey' : 'late', key: b.outcome };
    if (b.status === 'no_show') return { label: 'Absence', tone: 'late', key: 'no_show' };
    if (st && st > now) return { label: 'À venir', tone: 'go', key: 'avenir' };
    return { label: 'Résultat non saisi', tone: 'warn', key: 'nonsaisi' };
  }
  function nextFollowUp(l) {
    var fu = null;
    (l.followUps || []).forEach(function (f) {
      if (f.done) return;
      var ms = toMs(f.dateTime);
      if (ms && (!fu || ms < fu.ms)) fu = { ms: ms, note: f.note || '', overdue: ms < Date.now() };
    });
    return fu;
  }
  function sourceOf(l) {
    var t = l.type || '', s = l.source || '', page = (l.landingFirst && l.landingFirst.page) || '', lab, short;
    if (s === 'bigin_import' || s === 'webinar_import' || s === 'zoho_import') { lab = short = 'Ancienne base'; }
    else if (t === 'quiz_funnel') { lab = short = /business/i.test(page) ? 'Quiz Business' : 'Quiz Élite'; }
    else if (t === 'vsl_elite') { lab = short = 'VSL Élite'; }
    else if (t === 'business') { lab = short = 'VSL Business'; }
    else if (t === 'webinaire') { lab = short = 'Webinaire'; }
    else if (t === 'self_booking') { lab = short = 'Prise de RDV directe'; }
    else if (t === 'alteoform') { short = 'Formulaire'; lab = l.formTitle ? 'Formulaire « ' + l.formTitle + ' »' : 'Formulaire'; }
    else if (t === 'manual_booking') { lab = short = 'RDV posé par l\'équipe'; }
    else if (s === 'instagram' || (l.instagramUsername && !t)) { lab = short = 'Instagram'; }
    else { lab = short = l.sourceDetail || t || 'Source inconnue'; }
    var a = l.attributionFirst || {};
    return { label: lab, short: short, campaign: a.utm_campaign ? (a.utm_source ? cap(a.utm_source) + ' · ' : '') + a.utm_campaign : '' };
  }
  function problemOf(l) {
    var t = l.defi || '', pilier = l.quiz && l.quiz.pilier_prioritaire ? cap(l.quiz.pilier_prioritaire) : '';
    if (!t && l.formAnswers) l.formAnswers.forEach(function (a) { if (!t && /d[ée]fi|probl|bloqu/i.test(a.label || '') && a.value) t = String(a.value); });
    if (!t && l.quiz && l.quiz.reponses) l.quiz.reponses.forEach(function (r) { if (!t && /bloqu|d[ée]fi|probl/i.test(r.question || '') && r.reponse) t = String(r.reponse); });
    if (!t && pilier) t = 'Point faible au quiz : ' + pilier;
    return { text: t, pilier: pilier };
  }
  function lastNote(l) {
    var n = null;
    (l.notesHistory || []).forEach(function (x) { var ms = toMs(x.date); if (!n || (ms || 0) >= (n.ms || 0)) n = { ms: ms, text: x.text, by: x.authorName }; });
    return n;
  }
  function memberName(slug) {
    if (!slug) return 'Personne';
    for (var i = 0; i < H.team.length; i++) if (H.team[i].slug === slug) return H.team[i].name;
    return cap(slug);
  }
  function memberColor(slug) {
    for (var i = 0; i < H.team.length; i++) if (H.team[i].slug === slug) return H.team[i].color;
    return '#9096ad';
  }

  function derive(l) {
    var key = l.id + ':' + (l._v || 0);
    if (CACHE[l.id] && CACHE[l.id].key === key) return CACHE[l.id];
    var d = { key: key, now: Date.now() };
    d.cl = E.classify(l, BOOK[l.id] || []); d.col = d.cl.col; d.key = d.cl.key;
    d.fam = FAM_OF_COL[d.col] || 'joindre'; d.stage = d.cl.stage;
    /* Pastille : le sous-filtre pour les colonnes regroupées ; l'étape sinon,
       ou le nom de la colonne quand le lead y est rangé par son RDV (lead
       auto-réservé, lead repris après un no show…) */
    d.stageLabel = d.col === 'perdu' || d.col === 'poubelle' || d.col === 'disqua' || d.col === 'closing' ? E.label(d.key) :
      E.COL_OF_STAGE[d.stage] === d.col ? (STAGE_LABEL[d.stage] || d.stage) : colDef(d.col).t;
    d.real = realDate(l); d.arrDays = daysSince(d.real);
    d.last = lastContact(l); d.days = daysSince(d.last);
    var cs = commsOf(l), calls = 0, ans = 0, lastAns = null, lastCall = null, msgs = 0;
    cs.forEach(function (x) {
      var c = x.c, out = c.direction !== 'inbound';
      if (c.type === 'call') { calls++; if (!lastCall || x.ms > lastCall) lastCall = x.ms; if (isAnswered(c)) { ans++; if (!lastAns || x.ms > lastAns.ms) lastAns = { ms: x.ms, dur: c.duration }; } }
      if ((c.type === 'sms' || c.type === 'whatsapp') && out && !c.auto) msgs++;
    });
    d.calls = calls; d.answered = ans; d.lastAns = lastAns; d.lastCall = lastCall; d.msgs = msgs;
    var bs = bookingsOf(l), now = d.now;
    d.bookings = bs; d.upcoming = null; d.lastPast = null;
    bs.forEach(function (b) {
      var st = bookingStart(b);
      if (!st) return;
      if (st > now && !isCancelled(b) && b.outcome !== 'replanifie') { if (!d.upcoming) d.upcoming = b; }
      else if (b.outcome !== 'replanifie') d.lastPast = b;
    });
    d.fu = nextFollowUp(l);
    d.src = sourceOf(l); d.pb = problemOf(l);
    d.who = memberName(l.assignedTo);
    var note = lastNote(l), contact = d.days == null ? 'Aucun contact enregistré.' : d.days === 0 ? 'Dernier contact aujourd\'hui.' : 'Dernier contact il y a ' + plural(d.days, 'jour') + '.';
    var tone = null, ct = 'warn';

    if (d.fam === 'client') {
      var off = l.closedData && l.closedData.offre;
      d.ligne = 'Client depuis le ' + fdate(toMs(l.clientSince)) + (off ? ' · ' + off : '');
      d.situ = d.ligne + '.' + (l.coachAssigne && l.coachAssigne.nom ? ' Suivi en coaching par ' + l.coachAssigne.nom + '.' : '');
      d.conseil = 'Rien à faire côté vente'; tone = 'go'; ct = 'go';
    } else if (d.fam === 'ecarte') {
      d.ligne = d.stageLabel + (note ? ' · ' + cut(note.text, 60) : '');
      d.situ = d.stageLabel + '.' + (note ? ' « ' + cut(note.text, 160) + ' »' : '');
      d.conseil = 'Rien à faire'; tone = 'grey'; ct = 'go';
    } else if (d.upcoming) {
      var u = d.upcoming, us = bookingStart(u), pres = !!u.presenceConfirmed;
      d.ligne = 'RDV ' + fdateL(us) + ' à ' + fhour(us) + ' avec ' + (u.personName || '—') + ' · présence ' + (pres ? 'confirmée' : 'à confirmer');
      d.situ = 'Rendez-vous ' + fdateL(us) + ' à ' + fhour(us) + ' avec ' + (u.personName || '—') + '. ' + (pres ? 'Présence confirmée.' : 'Présence pas encore confirmée.');
      d.conseil = pres ? 'Rien à faire avant le RDV' : 'Confirmer la présence la veille du RDV';
      tone = pres ? 'go' : 'warn'; ct = pres ? 'go' : 'warn';
    } else if (d.fu) {
      d.ligne = (d.fu.overdue ? 'Rappel en retard depuis le ' + fdate(d.fu.ms) : 'Rappel prévu ' + frel(d.fu.ms)) + (d.fu.note ? ' · ' + cut(d.fu.note, 50) : '');
      d.situ = (d.lastPast ? 'RDV du ' + fdateL(bookingStart(d.lastPast)) + ' : ' + bookingResult(d.lastPast).label.toLowerCase() + '. ' : d.lastAns ? 'Joint le ' + fdate(d.lastAns.ms) + '. ' : '') +
        (d.fu.note ? '« ' + d.fu.note + ' » ' : '') + contact;
      d.conseil = d.fu.overdue ? 'Rappel prévu le ' + fdate(d.fu.ms) + ', en retard' : 'Rappel prévu ' + frel(d.fu.ms);
      tone = d.fu.overdue ? 'late' : 'go'; ct = d.fu.overdue ? 'late' : 'go';
    } else if (d.lastPast) {
      var b = d.lastPast, r = bookingResult(b), bs0 = bookingStart(b);
      d.ligne = r.label + ' au RDV du ' + fdate(bs0) + ' · ' + since(d.days);
      d.situ = 'RDV du ' + fdateL(bs0) + ' avec ' + (b.personName || '—') + ' : ' + r.label.toLowerCase() + '.' +
        (b.outcomeNote ? ' « ' + cut(b.outcomeNote, 200) + ' »' : '') +
        (b.cancellation && b.cancellation.reason ? ' Motif : « ' + cut(b.cancellation.reason, 120) + ' »' : '') + ' ' + contact;
      if (r.key === 'no_show') d.conseil = 'Lui reproposer un créneau';
      else if (r.key === 'annule') d.conseil = 'Rappeler : l\'annulation date de ' + plural(daysSince(bs0), 'jour');
      else if (r.key === 'nonsaisi') d.conseil = 'Saisir le résultat du RDV';
      else d.conseil = (l.aiLead && l.aiLead.angle) || 'Le rappeler pour reprendre la discussion';
    } else if (!calls && !msgs) {
      d.ligne = (d.arrDays === 0 ? 'Arrivé aujourd\'hui' : 'Arrivé il y a ' + plural(d.arrDays || 0, 'jour')) + ', jamais appelé';
      d.situ = 'Arrivé le ' + fdate(d.real) + ' par ' + d.src.label + '. Personne ne l\'a encore appelé.';
      d.conseil = 'Premier appel'; ct = 'go';
      tone = (d.arrDays || 0) <= 2 ? 'go' : (d.arrDays || 0) <= 14 ? 'warn' : 'late';
    } else if (!ans) {
      d.ligne = plural(calls, 'appel') + ' sans réponse' + (msgs ? '' : ', aucun message envoyé');
      d.situ = plural(calls, 'appel') + ', jamais décroché. Dernier appel le ' + fdate(lastCall).replace(/\.$/, '') + '. ' + (msgs ? plural(msgs, 'message envoyé', 'messages envoyés') + '.' : 'Aucun SMS ni WhatsApp envoyé.');
      d.conseil = calls >= 3 && !msgs ? 'Essayer un WhatsApp ou un SMS plutôt qu\'un nouvel appel' : 'Nouvel appel'; ct = 'go';
    } else {
      d.ligne = 'Joint le ' + fdate(lastAns.ms) + ' · ' + since(d.days);
      d.situ = 'Joint le ' + fdate(lastAns.ms) + ' (' + fdur(lastAns.dur) + ').' + (note ? ' « ' + cut(note.text, 180) + ' »' : '') + ' ' + contact;
      d.conseil = 'Le rappeler pour poser un RDV'; ct = 'go';
    }
    if (!tone) tone = d.days == null ? 'late' : d.days > 30 ? 'late' : d.days > 7 ? 'warn' : 'go';
    d.tone = tone; d.ctone = ct;
    d.lost = d.col === 'perdu' ? lostInfo(d) : null;
    d.blob = (l.nom + ' ' + (l.email || '') + ' ' + String(l.telephone || '').replace(/\D/g, '') + ' ' + (l.secteur || '') + ' ' + d.pb.text + ' ' + (l.tags || []).join(' ') + ' ' +
      (l.notesHistory || []).map(function (n) { return n.text; }).join(' ')).toLowerCase();
    CACHE[l.id] = d;
    return d;
  }

  /* Dernière colonne : tout ce qu'il faut savoir sur le RDV raté, sans ouvrir la fiche */
  var ROLE = { admin: 'admin', closer: 'closer', setter: 'setter', closer_setter: 'setter-closer', setter_ecrit: 'setter', sales: 'sales', csm: 'CSM', coach: 'coach' };
  function lostInfo(d) {
    var b = d.cl.booking, out = [];
    if (b) { var st = bookingStart(b); if (st) out.push('RDV du ' + fdate(st) + ' à ' + fhour(st) + (b.personName ? ' avec ' + b.personName : '') + (d.cl.sb === true ? ' · SB' : d.cl.sb === false ? ' · NB' : '')); }
    if (d.cl.sub === 'fu_closing' && d.upcoming && d.upcoming !== b) out.push('Prochain RDV ' + frel(bookingStart(d.upcoming)));
    if (b && isCancelled(b)) {
      var c = b.cancellation || {}, who = c.byName || b.cancelledByName || (b.outcome === 'annule' ? b.outcomeByName : '') || '';
      var at = toMs(c.at) || toMs(b.cancelledAt) || (b.outcome === 'annule' ? toMs(b.outcomeAt) : null);
      out.push(bookingResult(b).label + (who ? (c.origin === 'prospect' ? ' · noté par ' : ' · par ') + who + (c.byRole && ROLE[c.byRole] ? ' (' + ROLE[c.byRole] + ')' : '') : '') + (at ? ', le ' + fdate(at) + ' à ' + fhour(at) : ''));
      var why = c.reason || (b.outcome === 'annule' ? b.outcomeNote : '');
      out.push(why ? 'Motif : « ' + cut(why, 140) + ' »' : 'Motif non renseigné');
    } else if (b && (b.outcome || b.status === 'no_show')) {
      out.push(bookingResult(b).label + (b.outcomeByName ? ' · noté par ' + b.outcomeByName : '') + (toMs(b.outcomeAt) ? ', le ' + fdate(toMs(b.outcomeAt)) : ''));
      if (b.outcomeNote) out.push('« ' + cut(b.outcomeNote, 140) + ' »');
    } else if (!b) out.push('RDV introuvable (plus ancien que les données chargées)');
    return out;
  }

  /* Fil complet : tous les échanges et événements, du plus récent au plus ancien */
  function feed(l) {
    var d = derive(l), it = [];
    commsOf(l).forEach(function (x) {
      var c = x.c, inb = c.direction === 'inbound', o = { ms: x.ms, who: c.ownerName || (inb ? l.nom : ''), body: c.content || '', idx: x.i };
      if (c.type === 'call') {
        o.k = 'phone'; o.cls = 'pv2-c-go';
        o.title = (inb ? 'Appel entrant' : 'Appel sortant') + ' · ' + (isAnswered(c) ? fdur(c.duration) : (c.result || 'pas de réponse'));
        o.body = c.note || ''; o.tr = !!(c.callLogId || c.hasTranscript); o.rec = !!(c.callLogId || c.hasRecording);
      } else if (c.type === 'sms') { o.k = 'sms'; o.cls = 'pv2-c-acc'; o.title = 'SMS ' + (inb ? 'reçu' : 'envoyé') + (c.auto ? ' · automatique' : ''); }
      else if (c.type === 'whatsapp') { o.k = 'wa'; o.cls = 'pv2-c-go'; o.title = 'WhatsApp ' + (inb ? 'reçu' : 'envoyé'); }
      else if (c.type === 'email') { o.k = 'mail'; o.cls = 'pv2-c-acc'; o.title = 'E-mail ' + (inb ? 'reçu' : 'envoyé') + (c.subject ? ' · ' + c.subject : ''); }
      else { o.k = 'note'; o.cls = 'pv2-c-warn'; o.title = 'Note'; }
      it.push(o);
    });
    (l.notesHistory || []).forEach(function (n) { it.push({ ms: toMs(n.date), k: 'note', cls: 'pv2-c-warn', title: 'Note' + (n.authorName ? ' de ' + n.authorName : ''), who: '', body: n.text }); });
    (l.timeline_history || []).forEach(function (t) { it.push({ ms: toMs(t.date), k: 'step', cls: '', title: t.text, who: '', body: '' }); });
    d.bookings.forEach(function (b, i) {
      var st = bookingStart(b), r = bookingResult(b), cr = toMs(b.createdAt);
      if (cr) it.push({ ms: cr, k: 'cal', cls: 'pv2-c-acc', title: 'RDV n°' + (i + 1) + ' pris pour le ' + fdateL(st) + ' à ' + fhour(st), who: b.bookedByName || (b.source === 'self_booking' ? 'par le prospect' : ''), body: '' });
      if (st && r.key !== 'avenir') it.push({ ms: st, k: 'cal', cls: r.tone === 'late' ? 'pv2-c-late' : 'pv2-c-acc', title: 'RDV n°' + (i + 1) + ' avec ' + (b.personName || '—') + ' · ' + r.label.toLowerCase(), who: b.outcomeByName || '', body: b.outcomeNote || (b.cancellation && b.cancellation.reason ? 'Motif : ' + b.cancellation.reason : '') });
    });
    if (d.real) it.push({ ms: d.real, k: 'flag', cls: '', title: 'Arrivée : ' + d.src.label + (l.quiz && l.quiz.score_global != null ? ' · score ' + l.quiz.score_global + '/100' : ''), who: '', body: d.src.campaign });
    if (l.lastOptinAt) it.push({ ms: toMs(l.lastOptinAt), k: 'flag', cls: '', title: 'Revenu : ' + (l.lastOptinSource || 'nouveau passage'), who: '', body: l.lastOptinReason || '' });
    it = it.filter(function (x) { return x.ms; });
    it.sort(function (a, b) { return b.ms - a.ms; });
    return it;
  }

  /* ═══ 4. État ═══ */
  var ROOT = null, APP = null, TOAST = null;
  var S = {
    view: 'pipe', q: '', per: 'tout', who: null, sort: 'arr',
    f: { src: '', pb: '', par: '', last: '' },
    fold: { poubelle: true, disqua: true, closing: true }, lim: {},
    drawer: null, full: null, ft: 'fil', fevf: 'tout', cmp: 'note', tr: {},
    keys: [], rap: [{ s: 'home' }], mine: false, sess: null, sheet: null, drag: null, dark: false, okOther: {}
  };
  function lead(id) { var a = H.leads(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
  function colDef(id) { return E.colOf(id); }

  function okPeriod(d) {
    if (S.per === 'tout' || !d.real) return S.per === 'tout';
    var now = new Date(), r = d.real;
    if (S.per === 'mois') return r >= new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    if (S.per === '3m') return d.arrDays <= 92;
    if (S.per === '6m') return d.arrDays <= 183;
    if (S.per === 'an') return new Date(r).getFullYear() === now.getFullYear();
    if (S.per === 'an1') return new Date(r).getFullYear() === now.getFullYear() - 1;
    return true;
  }
  /* Statut précis : colonnes et sous-filtres (« NRP 1 », « No show · SB »…), plusieurs à la fois.
     Clé = 'colonne' ou 'colonne:sous-filtre' (même clé que la liste déroulante de Leads Live). */
  function keyOk(d, colId) {
    var sel = S.keys;
    if (colId) sel = sel.filter(function (k) { return k.split(':')[0] === colId; });
    if (!sel.length) return true;
    for (var i = 0; i < sel.length; i++) if (sel[i] === d.col || sel[i] === d.key) return true;
    return false;
  }
  function keysLabel() {
    if (!S.keys.length) return 'Étape';
    var n = S.keys.map(function (k) { return E.label(k); });
    return n.length <= 2 ? n.join(', ') : n.slice(0, 2).join(', ') + ' +' + (n.length - 2);
  }
  function chips(keys, counts) {
    var list = keys.filter(function (k) { return counts[k] || S.keys.indexOf(k) > -1; });
    if (list.length < 2 && !list.some(function (k) { return S.keys.indexOf(k) > -1; })) return '';
    return '<div class="pv2-subs">' + list.map(function (k) {
      var c = colDef(k.split(':')[0]), sub = k.split(':')[1], t = c.t;
      if (sub) (c.subs || []).forEach(function (x) { if (x.id === sub) t = x.t; });
      return '<button class="pv2-sub" data-a="stg" data-v="' + esc(k) + '" aria-pressed="' + (S.keys.indexOf(k) > -1) + '">' + esc(t) + ' <span>' + (counts[k] || 0) + '</span></button>'; }).join('') + '</div>';
  }
  function subKeys(c) { return (c.subs || []).map(function (x) { return c.id + ':' + x.id; }); }
  function countKeys(rows) { var c = {}; rows.forEach(function (l) { var d = derive(l); c[d.col] = (c[d.col] || 0) + 1; if (d.key !== d.col) c[d.key] = (c[d.key] || 0) + 1; }); return c; }
  function okFilters(l, d, sansMembre, sansStatut) {
    if (!sansStatut && !keyOk(d)) return false;
    if (!sansMembre && S.who && (l.assignedTo || '') !== (S.who === '_none' ? '' : S.who)) return false;
    if (S.f.src && d.src.short !== S.f.src) return false;
    if (S.f.pb && d.pb.pilier !== S.f.pb) return false;
    var p = S.f.par;
    if (p === 'jamais' && (d.calls || d.msgs)) return false;
    if (p === 'nonjoint' && (!d.calls || d.answered)) return false;
    if (p === 'joint' && !d.answered) return false;
    if (p === 'rdv' && !d.bookings.length) return false;
    if (p === 'absent' && !d.bookings.some(function (b) { return bookingResult(b).key === 'no_show'; })) return false;
    if (p === 'nonclose' && !d.bookings.some(function (b) { var k = bookingResult(b).key; return k === 'non_close' || k === 'offre'; })) return false;
    if (S.f.last && !(d.days == null || d.days > +S.f.last)) return false;
    return true;
  }
  function filtered(sansStatut) {
    var q = S.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    return H.leads().filter(function (l) {
      if (l._merged) return false;
      var d = derive(l);
      if (q) {
        if (d.blob.indexOf(q) < 0 && !(qd.length >= 4 && d.blob.indexOf(qd.replace(/^0/, '')) > -1)) return false;
        return true;
      }
      return okPeriod(d) && okFilters(l, d, false, sansStatut);
    });
  }
  function sortLeads(a) {
    var s = S.sort;
    return a.sort(function (x, y) {
      var dx = derive(x), dy = derive(y);
      if (s === 'oubli') return (dy.days == null ? 1e9 : dy.days) - (dx.days == null ? 1e9 : dx.days);
      if (s === 'chaud') return ((y.aiLead && y.aiLead.proba) || 0) - ((x.aiLead && x.aiLead.proba) || 0);
      if (s === 'nom') return String(x.nom || '').localeCompare(String(y.nom || ''), 'fr');
      return (dy.real || 0) - (dx.real || 0);
    });
  }
  /* Reprise d'un lead (retour Vincent du 22/10/2026) : un sales peut prendre
     le lead d'un autre s'il n'a eu aucun contact depuis plus de 7 jours ;
     un admin peut toujours. Seul assignedTo change : le setter d'origine
     (setterSlug, verrouillé, commissions) ne bouge jamais. */
  var TAKE_DAYS = 7;
  function isMine(l) { return (l.assignedTo || '') === H.me.slug; }
  function isAdmin() { return H.me.role === 'admin'; }
  function canTake(l) {
    if (isMine(l)) return false;
    if (isAdmin() || !l.assignedTo) return true;
    var d = derive(l);
    return d.days == null || d.days > TAKE_DAYS;
  }
  function ownerHTML(l) {
    var d = derive(l), h = '<div class="pv2-owner"><span>Suivi par <b>' + esc(isMine(l) ? 'toi' : d.who) + '</b></span>';
    if (canTake(l)) h += '<button class="pv2-take" data-a="take">Je le prends</button>';
    else if (!isMine(l)) h += '<span class="pv2-ownnote">Contacté ' + (d.days === 0 ? 'aujourd\'hui' : 'il y a ' + plural(d.days, 'jour')) + ' : seul un admin peut le réattribuer</span>';
    if (isAdmin()) h += '<button class="pv2-lk" style="padding:0" data-a="assignto">Attribuer à…</button>';
    return h + '</div>';
  }
  function activeFilterCount() { var n = 0; for (var k in S.f) if (S.f[k]) n++; return n; }

  /* ═══ 5. Rendus ═══ */
  function ownTag(l) {
    var slug = l.assignedTo || '';
    return '<span class="pv2-ownt" title="Suivi par ' + esc(memberName(slug)) + '"><i style="background:' + esc(slug ? memberColor(slug) : '#9096ad') + '"></i>' + esc(slug ? (isMine(l) ? 'Moi' : memberName(slug)) : 'Personne') + '</span>';
  }
  function ini(n) { return String(n || '?').split(/\s+/).map(function (x) { return x.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function header() {
    return '<div class="pv2-head"><h1 class="pv2-h1">Pipeline</h1>' +
      '<div class="pv2-mode" role="group" aria-label="Vue"><button data-a="view" data-v="pipe" aria-pressed="' + (S.view === 'pipe') + '">Pipeline</button><button data-a="view" data-v="rap" aria-pressed="' + (S.view === 'rap') + '">Rappels</button></div>' +
      '<span class="pv2-sp"></span><button class="pv2-ib" data-a="theme" aria-label="Thème clair ou sombre" title="Thème clair ou sombre">' + ic('moon') + '</button>' +
      (S.view === 'pipe' ? '<button class="pv2-add" data-a="newlead">' + ic('plus') + '<span>Nouveau lead</span></button>' : '') + '</div>';
  }

  function viewPipe() {
    var rows = sortLeads(filtered()), stc = countKeys(filtered(true)), total = H.leads().length, h = header();
    h += '<div class="pv2-tools"><label class="pv2-search">' + ic('search') + '<input id="pv2q" value="' + esc(S.q) + '" placeholder="Nom, téléphone, e-mail, mot d\'une note" autocomplete="off">' + (S.q ? '<button class="pv2-clr" data-a="clearq" aria-label="Effacer">' + ic('x') + '</button>' : '') + '</label>';
    h += '<div class="pv2-pills" role="group" aria-label="Arrivés">' + [['tout', 'Arrivés : tout'], ['mois', 'Ce mois-ci'], ['3m', '3 mois'], ['6m', '6 mois'], ['an', 'Cette année'], ['an1', 'L\'an dernier']].map(function (p) {
      return '<button class="pv2-pill" data-a="per" data-v="' + p[0] + '" aria-pressed="' + (S.per === p[0]) + '">' + p[1] + '</button>'; }).join('') + '</div>';
    h += whoSelect();
    h += '<button class="pv2-pill" data-a="stages" aria-pressed="' + (S.keys.length > 0) + '">' + esc(keysLabel()) + ' ▾</button>';
    var fc = activeFilterCount();
    h += '<button class="pv2-pill" data-a="filters" aria-pressed="' + (fc > 0) + '">Plus de filtres' + (fc ? '<span class="pv2-n">' + fc + '</span>' : '') + '</button></div>';
    var restricted = S.q || S.per !== 'tout' || S.who || fc || S.keys.length, bulk = bulkCandidates(rows);
    h += '<div class="pv2-result"><span><b>' + rows.length + '</b> lead' + (rows.length > 1 ? 's' : '') + (restricted ? ' sur ' + total + ' · <button data-a="reset">Tout effacer</button>' : '') + (S.q ? ' · la recherche ignore les filtres' : '') + '</span>' +
      (bulk.ok.length ? '<button class="pv2-take" data-a="bulktake">Prendre ces ' + plural(bulk.ok.length, 'lead') + '</button>' : '') + '<span class="pv2-sp"></span>' +
      '<label>Trier : <select class="pv2-sort" id="pv2sort">' + [['arr', 'arrivée récente d\'abord'], ['oubli', 'oubliés depuis longtemps d\'abord'], ['chaud', 'les plus chauds d\'abord'], ['nom', 'par nom']].map(function (o) {
      return '<option value="' + o[0] + '"' + (S.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>';
    h += '<div class="pv2-boardwrap"><div class="pv2-board">';
    /* Une colonne par étape (29/10/2026). Avec une recherche ou une étape choisie,
       les colonnes vides s'effacent pour ne pas noyer les résultats. */
    var serre = !!(S.q || S.keys.length);
    COLS.forEach(function (f) {
      var cs = rows.filter(function (l) { return derive(l).col === f.id; });
      if (f.id === 'lead') cs.sort(function (x, y) { return (derive(y).real || 0) - (derive(x).real || 0); });
      if (serre && !cs.length) return;
      var folded = S.fold[f.id] && !serre;
      if (folded) { h += '<button class="pv2-colx" data-a="unfold" data-v="' + f.id + '" data-col="' + f.id + '" title="Déplier">' + ic('unfold') + '<span class="pv2-v">' + esc(f.t) + '</span><span class="pv2-c">' + cs.length + '</span></button>'; return; }
      var lim = S.lim[f.id] || 25;
      h += '<section class="pv2-col' + (f.id === 'perdu' ? ' pv2-col-perdu' : '') + '" data-col="' + f.id + '"><div class="pv2-ch"><span class="pv2-t">' + esc(f.t) + '</span><span class="pv2-c">' + cs.length + '</span>' +
        '<button class="pv2-fold" data-a="fold" data-v="' + f.id + '" title="Replier" aria-label="Replier">' + ic('fold') + '</button></div>' +
        (f.s ? '<div class="pv2-chs">' + esc(f.s) + '</div>' : '') + (S.q ? '' : chips(subKeys(f), stc)) + '<div class="pv2-cards">';
      h += cs.length ? cs.slice(0, lim).map(card).join('') : '<div class="pv2-empty">Aucun lead</div>';
      if (cs.length > lim) h += '<button class="pv2-more" data-a="more" data-v="' + f.id + '">Voir les ' + (cs.length - lim) + ' autres</button>';
      h += '</div></section>';
    });
    h += '</div></div><div class="pv2-legend"><span><i class="pv2-dot pv2-d-go"></i>Contact récent ou action prévue</span><span><i class="pv2-dot pv2-d-warn"></i>À reprendre</span><span><i class="pv2-dot pv2-d-late"></i>Oublié ou en retard</span><span>Glisse une carte vers une autre colonne pour changer d\'étape · les mêmes étapes servent de filtre dans Leads Live</span></div>';
    return h;
  }
  /* Menu « Suivi par » avec le nombre de leads de chacun (période et filtres appliqués) */
  function whoSelect() {
    var cnt = { '': 0, _none: 0 };
    if (!S.q) H.leads().forEach(function (l) {
      if (l._merged) return;
      var d = derive(l);
      if (!okPeriod(d) || !okFilters(l, d, true)) return;
      cnt[''] = (cnt[''] || 0) + 1;
      var k = l.assignedTo || '_none'; cnt[k] = (cnt[k] || 0) + 1;
    });
    var mem = H.team.filter(function (m) { return m.pipeline !== false && m.slug !== H.me.slug; });
    var o = [['', 'Tout le monde', cnt['']], [H.me.slug, 'Les miens', cnt[H.me.slug] || 0]].concat(mem.map(function (m) { return [m.slug, m.name, cnt[m.slug] || 0]; })).concat([['_none', 'Personne', cnt._none || 0]]);
    return '<label class="pv2-whosel' + (S.who ? ' pv2-on' : '') + '"><span>Suivi par</span><select id="pv2who">' + o.map(function (x) {
      return '<option value="' + esc(x[0]) + '"' + ((S.who || '') === x[0] ? ' selected' : '') + '>' + esc(x[1]) + (S.q ? '' : ' (' + x[2] + ')') + '</option>'; }).join('') + '</select></label>';
  }
  /* « Prendre ces N leads » : seulement quand on regarde les leads de quelqu'un d'autre */
  function bulkCandidates(rows) {
    var r = { ok: [], kept: 0 };
    if (!S.who || S.who === H.me.slug || S.q) return r;
    rows.forEach(function (l) {
      var f = derive(l).fam;
      if (f === 'client' || f === 'ecarte') return;
      if (canTake(l)) r.ok.push(l.id); else r.kept++;
    });
    return r;
  }
  function card(l) {
    var d = derive(l);
    return '<button class="pv2-card" draggable="true" data-a="open" data-v="' + esc(l.id) + '" data-id="' + esc(l.id) + '"><div class="pv2-k1"><i class="pv2-dot pv2-d-' + d.tone + '"></i><span class="pv2-nm">' + esc(l.nom || 'Sans nom') + '</span></div>' +
      (d.lost ? '<div class="pv2-k2l">' + d.lost.map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('') + '</div>' : '<div class="pv2-k2">' + esc(d.ligne) + '</div>') + '<div class="pv2-k3"><span class="pv2-etp">' + esc(d.stageLabel) + '</span><span class="pv2-src">' + esc(d.src.short) + ' · ' + fdate(d.real) + '</span>' + ownTag(l) + '</div></button>';
  }

  /* Fiche courte : tiroir du pipeline, écran de la vue Rappels, carte de séance */
  function fiche(l, o) {
    o = o || {};
    var d = derive(l), first = String(l.nom || '').split(' ')[0], stop = l.smsOptedOut || l.smsOptOut;
    var h = '<h2 class="pv2-name">' + esc(l.nom) + '</h2><div class="pv2-who">' + esc([l.secteur, l.ca].filter(Boolean).join(' · ') || 'Secteur non renseigné') + '</div>' + ownerHTML(l);
    h += '<div class="pv2-status">' + esc(d.situ) + '<small class="pv2-' + d.ctone + '">→ ' + esc(d.conseil) + '</small></div>';
    if (!o.noCall) h += '<button class="pv2-big" data-a="call" data-v="' + esc(l.id) + '"' + (l.telephone ? '' : ' disabled') + '>' + ic('phone') + 'Appeler ' + esc(first) + '</button>';
    h += '<div class="pv2-acts">' +
      '<button class="pv2-act" data-a="msg" data-v="sms"' + (stop ? ' disabled title="Ce lead a répondu STOP aux SMS"' : '') + '><span>' + ic('sms') + '</span>' + (stop ? 'STOP SMS' : 'SMS') + '</button>' +
      '<button class="pv2-act" data-a="msg" data-v="whatsapp"><span>' + ic('wa') + '</span>WhatsApp</button>' +
      '<button class="pv2-act" data-a="fu"><span>' + ic('clock') + '</span>Rappel</button>' +
      '<button class="pv2-act" data-a="rdv"><span>' + ic('cal') + '</span>RDV</button></div>';
    var rb = d.upcoming || d.lastPast;
    h += '<div class="pv2-gt">Ce qu\'il faut savoir</div><div class="pv2-group">' +
      kv('Son problème', d.pb.text ? '<span class="pv2-q">« ' + esc(cut(d.pb.text, 220)) + ' »</span>' : 'Non renseigné') +
      (d.lost ? kv('Son rendez-vous', d.lost.map(esc).join('<br>')) : rb ? kv('Son rendez-vous', esc(fdate(bookingStart(rb)) + ' avec ' + (rb.personName || '—') + ' · ' + bookingResult(rb).label.toLowerCase() + (rb.outcomeNote ? ' · « ' + cut(rb.outcomeNote, 120) + ' »' : ''))) : '') +
      kv('Arrivé par', esc(d.src.label + ' · ' + fdate(d.real))) +
      kv('Dernier échange', esc(lastExchange(l))) + '</div>';
    var nNotes = (l.notesHistory || []).length, f = feed(l).length;
    h += '<div class="pv2-gt">Tout le détail</div><div class="pv2-group">' +
      sub('hist', 'Historique', plural(f, 'événement') + ' · appels, messages, RDV, notes') +
      (l.quiz || (l.formAnswers && l.formAnswers.length) ? sub('pb', 'Problématique et quiz', l.quiz ? 'Quiz ' + (l.quiz.score_global != null ? l.quiz.score_global + '/100' : '') + (l.quiz.reponses ? ' · ' + plural(l.quiz.reponses.length, 'réponse') : '') : plural(l.formAnswers.length, 'réponse au formulaire', 'réponses au formulaire')) : '') +
      sub('notes', 'Notes de l\'équipe', nNotes ? plural(nNotes, 'note') : 'Aucune note') +
      sub('etape', 'Étape', colDef(d.col).t + (d.stageLabel !== colDef(d.col).t ? ' · ' + d.stageLabel : '')) +
      sub('infos', 'Infos', 'Coordonnées, suivi, tags') +
      '<button class="pv2-row" data-a="full" data-v="' + esc(l.id) + '"><span class="pv2-tile">' + ic('expand') + '</span><div class="pv2-tx"><div class="pv2-tt">Fiche complète</div><div class="pv2-st">Tout le dossier sur une page</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>' +
      llRow(l) + '</div>';
    return h;
  }
  /* Même fiche, ouverte dans Leads Live (nouvel onglet) */
  function llRow(l) {
    return '<button class="pv2-row" data-a="ll" data-v="' + esc(l.id) + '"><span class="pv2-tile">' + ic('bolt') + '</span><div class="pv2-tx"><div class="pv2-tt">Ouvrir dans Leads Live</div><div class="pv2-st">La même fiche, côté setters</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>';
  }
  function lastExchange(l) {
    var it = feed(l).filter(function (x) { return x.k === 'phone' || x.k === 'sms' || x.k === 'wa' || x.k === 'mail'; })[0];
    return it ? it.title + ' · ' + fdate(it.ms) + (it.who ? ' (' + it.who + ')' : '') : 'Aucun';
  }
  function kv(k, v) { return '<div class="pv2-row"><div class="pv2-tx"><div class="pv2-k">' + k + '</div><div class="pv2-v">' + v + '</div></div></div>'; }
  function sub(s, t, st) { return '<button class="pv2-row" data-a="sub" data-v="' + s + '"><div class="pv2-tx"><div class="pv2-tt">' + t + '</div><div class="pv2-st">' + esc(st) + '</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>'; }

  function subScreen(s, l) {
    var d = derive(l), top = '<div class="pv2-who">' + esc(l.nom) + '</div>', h;
    if (s === 'hist') {
      var it = feed(l), last = '';
      h = '<h2 class="pv2-name">Historique</h2>' + top;
      if (!it.length) return h + '<p class="pv2-muted">Rien pour l\'instant.</p>';
      h += '<div class="pv2-pane" style="margin-top:16px">';
      it.forEach(function (x) { var dd = fdate(x.ms); if (dd !== last) { h += '<div class="pv2-fday">' + dd + '</div>'; last = dd; } h += fev(l, x); });
      return h + '</div>';
    }
    if (s === 'pb') return '<h2 class="pv2-name">Problématique</h2>' + top + '<div style="margin-top:16px">' + pbBlocks(l) + '</div>';
    if (s === 'notes') {
      h = '<h2 class="pv2-name">Notes</h2>' + top + '<div class="pv2-pane" style="margin-top:16px"><div class="pv2-cta"><textarea id="pv2note" placeholder="Écrire une note pour l\'équipe"></textarea><button data-a="addnote">Ajouter</button></div></div>';
      var ns = (l.notesHistory || []).slice().sort(function (a, b) { return (toMs(b.date) || 0) - (toMs(a.date) || 0); });
      if (ns.length) h += '<div class="pv2-group" style="margin-top:14px">' + ns.map(function (n) { return kv(esc((n.authorName || 'Équipe') + ' · ' + fdate(toMs(n.date))), esc(n.text)); }).join('') + '</div>';
      return h;
    }
    if (s === 'etape') {
      return '<h2 class="pv2-name">Étape</h2>' + top + stageRows(d.stage, false);
    }
    h = '<h2 class="pv2-name">Infos</h2>' + top + '<div class="pv2-group" style="margin-top:16px">' +
      kv('Téléphone', '<span style="user-select:all">' + esc(l.telephone || '—') + '</span>') + kv('E-mail', '<span style="user-select:all">' + esc(l.email || '—') + '</span>') +
      (l.instagramUsername ? kv('Instagram', '@' + esc(l.instagramUsername)) : '') + kv('Setter d\'origine', esc(l.setterName || memberName(l.setterSlug) || '—') + (l.setterSlug ? ' · ne change jamais' : '')) + '</div>';
    h += '<div class="pv2-pane" style="margin-top:14px">' + ownerHTML(l) + '</div>';
    h += '<div class="pv2-gt">Tags</div>' + tagsHTML(l);
    return h;
  }
  function tagsHTML(l) { return '<div class="pv2-tags">' + (l.tags || []).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '<button data-a="tag">+ tag</button></div>'; }

  function fev(l, x) {
    var tr = x.tr ? (S.tr[l.id + ':' + x.idx] || null) : null;
    var h = '<div class="pv2-fev"><div class="pv2-fic ' + x.cls + '">' + ic(x.k) + '</div><div style="min-width:0"><div class="pv2-a">' + esc(x.title) + '</div>' +
      (x.who || x.body ? '<div class="pv2-b">' + esc(x.who) + (x.who && x.body ? ' : ' : '') + esc(x.body) + '</div>' : '');
    if (x.tr || x.rec) {
      h += (x.tr ? '<button class="pv2-lk" data-a="tr" data-v="' + x.idx + '">' + (tr && tr.open ? 'Masquer la conversation' : 'Lire la conversation') + '</button>' : '') +
        (x.rec ? '<button class="pv2-lk" data-a="listen" data-v="' + x.idx + '">▶ Écouter</button>' : '');
      if (tr && tr.open) {
        h += tr.loading ? '<div class="pv2-b">Chargement…</div>' : tr.error ? '<div class="pv2-b">' + esc(tr.error) + '</div>' :
          '<div class="pv2-bub">' + (tr.data.summary ? '<div class="pv2-b"><b>Résumé :</b> ' + esc(tr.data.summary) + '</div>' : '') + (tr.data.speeches || []).map(function (sp) { return '<p class="' + (sp.me ? 'pv2-me' : '') + '">' + esc(sp.text) + '</p>'; }).join('') + '</div>';
      }
    }
    return h + '</div><span class="pv2-h">' + fhm(x.ms) + '</span></div>';
  }

  function pbBlocks(l) {
    var d = derive(l), h = '<div class="pv2-pane"><h3>Ce qu\'il a écrit</h3><div class="pv2-v pv2-q">' + (d.pb.text ? '« ' + esc(d.pb.text) + ' »' : 'Non renseigné') + '</div>' +
      ((l.ca || l.secteur) ? '<div class="pv2-muted" style="margin-top:8px">' + esc([l.secteur, l.ca ? 'CA ' + l.ca : ''].filter(Boolean).join(' · ')) + '</div>' : '') + '</div>';
    if (l.quiz) {
      var q = l.quiz, sc = q.scores || {};
      h += '<div class="pv2-pane"><h3>Quiz · ' + fdate(toMs(l.quizSubmittedAt) || derive(l).real) + (q.score_global != null ? ' · score ' + q.score_global + '/100' : '') + (d.pb.pilier ? ' · point faible : ' + esc(d.pb.pilier) : '') + '</h3>';
      Object.keys(sc).forEach(function (k) { var v = +sc[k] || 0; h += '<div class="pv2-qbar' + (v < 40 ? ' pv2-low' : '') + '"><span>' + esc(cap(k)) + '</span><div class="pv2-tr"><div class="pv2-fl" style="width:' + Math.min(100, v) + '%"></div></div><b>' + v + '</b></div>'; });
      var extra = [['Chiffre d\'affaires mensuel', q.ca_mensuel], ['Objectif', q.objectif], ['Équipe', q.equipe], ['Heures par semaine', q.heures]].filter(function (x) { return x[1]; });
      var rep = (q.reponses || []).map(function (r) { return [r.question, r.reponse]; });
      var all = extra.concat(rep);
      if (all.length) h += '<div class="pv2-group" style="margin-top:14px">' + all.map(function (r) { return kv(esc(r[0]), esc(r[1])); }).join('') + '</div>';
      h += '</div>';
    }
    if (l.formAnswers && l.formAnswers.length) {
      h += '<div class="pv2-pane"><h3>' + esc(l.formTitle ? 'Formulaire « ' + l.formTitle + ' »' : 'Formulaire') + (l.formSubmittedAt ? ' · ' + fdate(toMs(l.formSubmittedAt)) : '') + '</h3><div class="pv2-group">' +
        l.formAnswers.map(function (a) { return kv(esc(a.label), esc(Array.isArray(a.value) ? a.value.join(', ') : a.value)); }).join('') + '</div></div>';
    }
    if (!l.quiz && !(l.formAnswers && l.formAnswers.length)) h += '<div class="pv2-pane"><div class="pv2-muted">Aucun quiz ni formulaire rempli.</div></div>';
    return h;
  }

  /* Tiroir (vue Pipeline) */
  function drawerHTML() {
    var st = S.drawer, c = st[st.length - 1], l = lead(c.id);
    if (!l) { S.drawer = null; return ''; }
    var h = '<div class="pv2-scrim" data-a="dclose"></div><aside class="pv2-drawer" id="pv2drawer" aria-label="Fiche de ' + esc(l.nom) + '"><div class="pv2-dbar">' +
      (st.length > 1 ? '<button class="pv2-back" data-a="dback">' + ic('back') + esc(l.nom) + '</button>' : '') + '<span class="pv2-sp"></span>' +
      '<button class="pv2-ib" data-a="full" data-v="' + esc(l.id) + '" aria-label="Fiche complète" title="Fiche complète">' + ic('expand') + '</button>' +
      '<button class="pv2-ib" data-a="dclose" aria-label="Fermer" title="Fermer">' + ic('x') + '</button></div>';
    h += c.s === 'fiche' ? fiche(l) : subScreen(c.s, l);
    return h + '</aside>';
  }

  /* Vue Rappels : écrans façon Leads Live + séance un par un */
  function basketLeads(id, sansStatut) {
    return H.leads().filter(function (l) {
      if (l._merged) return false;
      var d = derive(l);
      if (d.fam !== id) return false;
      if (!sansStatut && !keyOk(d)) return false;
      if (S.mine && l.assignedTo !== H.me.slug) return false;
      return okPeriod(d);
    }).sort(function (a, b) { var da = derive(a).days, db = derive(b).days; return (db == null ? 1e9 : db) - (da == null ? 1e9 : da); });
  }
  function viewRap() {
    var c = S.rap[S.rap.length - 1], h = '<div class="pv2-narrow">' + header(), l;
    if (c.s === 'home') {
      h += '<p class="pv2-lead" style="margin-top:-6px">Qui rappeler aujourd\'hui ?</p>' + rapPills();
      h += '<div class="pv2-group" style="margin-top:14px">' + BASKETS.map(function (b) {
        return '<button class="pv2-row" data-a="bk" data-v="' + b.id + '"><span class="pv2-tile">' + ic(b.ic) + '</span><div class="pv2-tx"><div class="pv2-tt">' + b.t + '</div><div class="pv2-st">' + b.s + '</div></div><span class="pv2-cnt">' + basketLeads(b.id).length + '</span><span class="pv2-chev">' + ic('chev') + '</span></button>'; }).join('') + '</div>';
      h += '<div class="pv2-gt">Ou</div><div class="pv2-group"><button class="pv2-row" data-a="view" data-v="pipe"><span class="pv2-tile">' + ic('search') + '</span><div class="pv2-tx"><div class="pv2-tt">Voir tout le pipeline</div><div class="pv2-st">Tous les leads, par étape</div></div><span class="pv2-chev">' + ic('chev') + '</span></button></div>';
    } else if (c.s === 'list') {
      var b = basketById(c.bk), grp = basketGroups(c.bk), g = grp.g, ord = grp.ord, rows = grp.flat;
      h += '<div class="pv2-bar"><button class="pv2-back" data-a="rback">' + ic('back') + 'Rappels</button></div><h2 class="pv2-name">' + b.t + '</h2><p class="pv2-lead">' + b.s + '. Rangés par mois d\'arrivée, les plus oubliés en tête de chaque mois.</p>' + rapPills() + chips(basketKeys(b), countKeys(basketLeads(c.bk, true)));
      h += '<div style="margin-top:14px"><button class="pv2-big pv2-blue" data-a="sess" data-v="' + c.bk + '"' + (rows.length ? '' : ' disabled') + '>' + ic('play') + 'Les rappeler un par un (' + rows.length + ')</button></div>';
      if (!rows.length) h += '<p class="pv2-muted" style="margin-top:18px">Personne dans ce panier avec ces réglages.</p>';
      ord.forEach(function (m) {
        h += '<div class="pv2-gt">Arrivés en ' + m + '</div><div class="pv2-group">' + g[m].map(function (x) {
          var d = derive(x);
          return '<button class="pv2-row" data-a="rlead" data-v="' + esc(x.id) + '"><div class="pv2-av">' + esc(ini(x.nom)) + '<i class="pv2-dot pv2-d-' + d.tone + '"></i></div><div class="pv2-tx"><div class="pv2-tt">' + esc(x.nom) + '</div><div class="pv2-st">' + esc(d.ligne) + '</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>'; }).join('') + '</div>';
      });
    } else if (c.s === 'sess') {
      var ss = S.sess;
      if (ss.i >= ss.ids.length) {
        h += '<div class="pv2-bar"><button class="pv2-back" data-a="rback">' + ic('back') + 'Retour</button></div><div class="pv2-sess pv2-done"><h2 class="pv2-name">Séance terminée</h2><p class="pv2-lead">' + plural(ss.ids.length, 'lead passé', 'leads passés') + ' en revue · ' + plural(ss.called, 'appel') + '.</p><button class="pv2-big pv2-blue" data-a="rhome">Revenir aux paniers</button></div>';
      } else {
        l = lead(ss.ids[ss.i]);
        h += '<div class="pv2-bar"><button class="pv2-back" data-a="rback">' + ic('back') + 'Terminer la séance</button></div>';
        h += '<div class="pv2-prog"><span>' + basketById(ss.bk).t + '</span><div class="pv2-tr"><div class="pv2-fl" style="width:' + Math.round((ss.i + 1) / ss.ids.length * 100) + '%"></div></div><span>' + (ss.i + 1) + ' / ' + ss.ids.length + '</span></div>';
        h += '<div class="pv2-sess pv2-enter">' + fiche(l, { noCall: true }) + '</div>';
        h += '<div style="margin-top:16px"><button class="pv2-big" data-a="call" data-v="' + esc(l.id) + '"' + (l.telephone ? '' : ' disabled') + '>' + ic('phone') + 'Appeler ' + esc(String(l.nom || '').split(' ')[0]) + '</button><div class="pv2-after"><button class="pv2-soft" data-a="later">Plus tard</button><button class="pv2-soft" data-a="next">Suivant</button></div></div>';
      }
    } else if (c.s === 'fiche') {
      h += '<div class="pv2-bar"><button class="pv2-back" data-a="rback">' + ic('back') + 'Retour</button></div>' + fiche(lead(c.id));
    } else {
      h += '<div class="pv2-bar"><button class="pv2-back" data-a="rback">' + ic('back') + esc(lead(c.id).nom) + '</button></div>' + subScreen(c.s, lead(c.id));
    }
    return h + '</div>';
  }
  /* Panier rangé comme à l'écran : mois d'arrivée (récent d'abord), puis les plus oubliés. La séance suit cet ordre. */
  function basketGroups(id) {
    var g = {}, ord = [], flat = [];
    basketLeads(id).forEach(function (x) { var r = derive(x).real, k = r ? MOISL[new Date(r).getMonth()] + ' ' + new Date(r).getFullYear() : 'date inconnue'; if (!g[k]) { g[k] = []; ord.push(k); } g[k].push(x); });
    ord.sort(function (a, b) { return (derive(g[b][0]).real || 0) - (derive(g[a][0]).real || 0); });
    ord.forEach(function (k) { flat = flat.concat(g[k]); });
    return { g: g, ord: ord, flat: flat };
  }
  function rapPills() {
    return '<div class="pv2-pills" role="group" aria-label="Réglages"><button class="pv2-pill" data-a="mine" aria-pressed="' + S.mine + '">Seulement les miens</button>' +
      [['tout', 'Arrivés : tout'], ['3m', '3 mois'], ['6m', '6 mois'], ['an', 'Cette année'], ['an1', 'L\'an dernier']].map(function (p) {
        return '<button class="pv2-pill" data-a="per" data-v="' + p[0] + '" aria-pressed="' + (S.per === p[0]) + '">' + p[1] + '</button>'; }).join('') + '</div>';
  }
  function basketKeys(b) { var k = []; b.cols.forEach(function (c) { var sk = subKeys(colDef(c)); k = k.concat(sk.length ? sk : [c]); }); return k; }
  function basketById(id) { for (var i = 0; i < BASKETS.length; i++) if (BASKETS[i].id === id) return BASKETS[i]; return BASKETS[0]; }

  /* Fiche complète */
  function fullView(l) {
    var d = derive(l), fi = -1;
    for (var i = 0; i < COLS.length; i++) if (COLS[i].id === d.col) fi = i;
    var h = '<div class="pv2-full"><div class="pv2-bar"><button class="pv2-back" data-a="fclose">' + ic('back') + 'Retour</button></div><div class="pv2-fgrid"><aside class="pv2-fleft">';
    h += '<div class="pv2-idt"><div class="pv2-av">' + esc(ini(l.nom)) + '</div><div style="min-width:0"><h2 class="pv2-name" style="font-size:25px">' + esc(l.nom) + '</h2><div class="pv2-who">' + esc([l.secteur, l.ca].filter(Boolean).join(' · ') || 'Secteur non renseigné') + '</div><span class="pv2-badge">' + (d.fam === 'client' ? 'Closing' : d.fam === 'ecarte' ? 'Disqualifié' : 'Lead') + '</span></div></div>' + ownerHTML(l);
    h += '<div class="pv2-steps" title="Étape">' + COLS.map(function (f, i) { return '<i class="' + (i === fi ? 'pv2-on' : (i < fi && d.fam !== 'ecarte' ? 'pv2-past' : '')) + '"></i>'; }).join('') + '</div>' +
      '<div class="pv2-stepl"><b>' + esc(colDef(d.col).t) + '</b>' + (d.stageLabel !== colDef(d.col).t ? ' · ' + esc(d.stageLabel) : '') + ' · <button class="pv2-lk" style="padding:0" data-a="fstage">changer</button></div>';
    if (d.lost) h += '<div class="pv2-pane pv2-lostp">' + d.lost.map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('') + '</div>';
    h += '<div class="pv2-status">' + esc(d.situ) + '<small class="pv2-' + d.ctone + '">→ ' + esc(d.conseil) + '</small></div>';
    h += '<button class="pv2-big" data-a="call" data-v="' + esc(l.id) + '"' + (l.telephone ? '' : ' disabled') + '>' + ic('phone') + 'Appeler ' + esc(String(l.nom || '').split(' ')[0]) + '</button>';
    var stop = l.smsOptedOut || l.smsOptOut;
    h += '<div class="pv2-acts"><button class="pv2-act" data-a="msg" data-v="sms"' + (stop ? ' disabled' : '') + '><span>' + ic('sms') + '</span>' + (stop ? 'STOP SMS' : 'SMS') + '</button><button class="pv2-act" data-a="msg" data-v="whatsapp"><span>' + ic('wa') + '</span>WhatsApp</button><button class="pv2-act" data-a="fu"><span>' + ic('clock') + '</span>Rappel</button><button class="pv2-act" data-a="rdv"><span>' + ic('cal') + '</span>RDV</button></div>';
    h += '<div class="pv2-gt">Contact</div><div class="pv2-group">' + kv('Téléphone', '<span style="user-select:all">' + esc(l.telephone || '—') + '</span>') + kv('E-mail', '<span style="user-select:all">' + esc(l.email || '—') + '</span>') + kv('Instagram', l.instagramUsername ? '@' + esc(l.instagramUsername) : '—') + '</div>';
    h += '<div class="pv2-gt">Qui s\'en occupe</div><div class="pv2-group">' + kv('Setter d\'origine', esc(l.setterName || (l.setterSlug ? memberName(l.setterSlug) : '—')) + (l.setterSlug ? ' · ne change jamais' : '')) + kv('Closer', esc(l.closeur || (d.bookings.length ? d.bookings[d.bookings.length - 1].personName : '') || '—')) + '</div>';
    h += '<div class="pv2-gt">Tags</div>' + tagsHTML(l);
    h += '<div class="pv2-group" style="margin-top:18px">' + llRow(l) + '<button class="pv2-row" data-a="bump"><span class="pv2-tile">' + ic('up') + '</span><div class="pv2-tx"><div class="pv2-tt">Remonter dans Leads Live</div><div class="pv2-st">Le remet en tête de liste des setters</div></div></button></div>';
    h += '</aside><main style="min-width:0">';
    var tabs = [['fil', 'Fil complet'], ['pb', 'Problématique'], ['rdv', 'Rendez-vous (' + d.bookings.length + ')'], ['ia', 'Résumé IA'], ['contrat', 'Contrat et paiements'], ['rappels', 'Rappels et tâches'], ['fichiers', 'Fichiers'], ['champs', 'Tous les champs']];
    h += '<div class="pv2-tabs" role="tablist">' + tabs.map(function (t) { return '<button data-a="ft" data-v="' + t[0] + '" aria-pressed="' + (S.ft === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div>';
    return h + fullTab(l) + '</main></div></div>';
  }
  function fullTab(l) {
    var d = derive(l), t = S.ft, h = '';
    if (t === 'fil') {
      var labels = { note: 'une note pour l\'équipe', sms: 'un SMS', whatsapp: 'un WhatsApp', email: 'un e-mail' };
      h += '<div class="pv2-pane"><div class="pv2-chips">' + [['note', 'Note'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail']].map(function (m) {
        return '<button data-a="cmp" data-v="' + m[0] + '" aria-pressed="' + (S.cmp === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div>' +
        '<div class="pv2-cta"><textarea id="pv2cmp" placeholder="Écrire ' + labels[S.cmp] + (S.cmp === 'note' ? '' : ' à ' + esc(String(l.nom || '').split(' ')[0])) + '"></textarea><button data-a="cmpsend">' + (S.cmp === 'note' ? 'Ajouter' : 'Envoyer') + '</button></div></div>';
      var flt = [['tout', 'Tout'], ['phone', 'Appels'], ['msg', 'SMS et WhatsApp'], ['mail', 'E-mails'], ['note', 'Notes'], ['cal', 'RDV'], ['etapes', 'Étapes et arrivées']];
      h += '<div class="pv2-pane"><div class="pv2-chips">' + flt.map(function (f) { return '<button data-a="fevf" data-v="' + f[0] + '" aria-pressed="' + (S.fevf === f[0]) + '">' + f[1] + '</button>'; }).join('') + '</div>';
      var it = feed(l).filter(function (x) {
        var f = S.fevf; return f === 'tout' || x.k === f || (f === 'msg' && (x.k === 'sms' || x.k === 'wa')) || (f === 'etapes' && (x.k === 'step' || x.k === 'flag')); }), last = '';
      if (!it.length) h += '<div class="pv2-muted">Rien à afficher.</div>';
      it.forEach(function (x) { var dd = fdate(x.ms); if (dd !== last) { h += '<div class="pv2-fday">' + dd + '</div>'; last = dd; } h += fev(l, x); });
      return h + '</div>';
    }
    if (t === 'pb') return pbBlocks(l);
    if (t === 'rdv') {
      if (!d.bookings.length) return '<div class="pv2-pane"><div class="pv2-muted">Aucun rendez-vous pour l\'instant. <button class="pv2-lk" style="padding:0" data-a="rdv">Poser un RDV</button></div></div>';
      d.bookings.slice().reverse().forEach(function (b) {
        var n = d.bookings.indexOf(b) + 1, st = bookingStart(b), r = bookingResult(b), cr = toMs(b.createdAt), obj = H.objectionsOf ? H.objectionsOf(b) : [];
        var by = b.bookedByName ? 'par ' + b.bookedByName : b.source === 'self_booking' ? 'par le prospect' : '';
        h += '<div class="pv2-pane"><h3>RDV n°' + n + ' · ' + fdateL(st) + ' à ' + fhour(st) + (b.typeLabel ? ' · ' + esc(b.typeLabel) : '') + '</h3><div class="pv2-group">' +
          kv('Pris le', esc((cr ? fdate(cr) : '—') + (by ? ' ' + by : ''))) + kv('Avec', esc(b.personName || '—')) +
          kv('Présence', b.presenceConfirmed ? 'Confirmée' + (b.presenceConfirmed.channel ? ' par ' + esc(b.presenceConfirmed.channel) : '') + (b.presenceConfirmed.at ? ' le ' + fdate(toMs(b.presenceConfirmed.at)) : '') : 'Non confirmée') +
          kv('Résultat', esc(r.label) + (b.outcomeByName ? ' · saisi par ' + esc(b.outcomeByName) : '')) +
          (b.outcomeNote ? kv('Note du closer', '« ' + esc(b.outcomeNote) + ' »') : '') +
          (b.cancellation && b.cancellation.reason ? kv('Motif d\'annulation', '« ' + esc(b.cancellation.reason) + ' »') : '') +
          (obj && obj.length ? kv('Objections', esc(obj.join(' · '))) : '') + '</div>';
        if (b.replay && b.replay.summary) h += '<button class="pv2-lk" data-a="toggle" data-v="rp-' + esc(b.id) + '">▶ Résumé du closing' + (b.replay.durationSec ? ' (' + Math.round(b.replay.durationSec / 60) + ' min)' : '') + '</button><div id="rp-' + esc(b.id) + '" class="pv2-b" hidden style="margin-top:8px">' + esc(b.replay.summary) + '</div>';
        if (b.aiPrep && b.aiPrep.resume) h += '<button class="pv2-lk" data-a="toggle" data-v="ap-' + esc(b.id) + '">Préparation IA du RDV</button><div id="ap-' + esc(b.id) + '" class="pv2-b" hidden style="margin-top:8px">' + esc(b.aiPrep.resume) + '</div>';
        h += '</div>';
      });
      return h;
    }
    if (t === 'ia') {
      var a = l.aiLead;
      if (!a) return '<div class="pv2-pane"><h3>Résumé IA</h3><p class="pv2-muted">Pas encore généré pour ce lead. Le résumé lit le quiz, les formulaires, les appels, les RDV et les notes.</p><button class="pv2-big pv2-blue" data-a="aigen" style="margin-top:12px">Générer le résumé</button></div>';
      return '<div class="pv2-pane"><h3>Résumé IA · ' + (a.generatedAt ? 'généré le ' + fdate(toMs(a.generatedAt)) : '') + ' · <button class="pv2-lk" style="padding:0" data-a="aigen">régénérer</button></h3><div class="pv2-group">' +
        kv('Température', esc(cap(a.niveau || '—')) + (a.proba != null ? ' · ' + a.proba + ' % de chances' : '')) +
        (a.brief && a.brief.length ? kv('À retenir', esc(a.brief.join('\n'))) : '') + (a.raison ? kv('Pourquoi', esc(a.raison)) : '') +
        (a.angle ? kv('Angle pour le rappel', esc(a.angle)) : '') + (a.ouverture ? kv('Phrase d\'ouverture', '« ' + esc(a.ouverture) + ' »') : '') + '</div></div>';
    }
    if (t === 'contrat') {
      var cd = l.closedData || {};
      h += '<div class="pv2-pane"><h3>Offre et signature</h3><div class="pv2-group">' + kv('Offre', esc(cd.offre || '—') + (cd.subtype ? ' · ' + (cd.subtype === 'pif' ? 'paiement comptant' : 'mensualisé') : '')) +
        kv('Contrat', l.contractSigned ? 'Signé' + (l.contractTemplateName ? ' · ' + esc(l.contractTemplateName) : '') : 'Aucun contrat signé') +
        kv('Montant', cd.contracte ? esc(cd.contracte + ' € contractés' + (cd.collecte ? ' · ' + cd.collecte + ' € encaissés' : '')) : '—') + '</div>' +
        '<div class="pv2-tags" style="margin-top:12px"><button data-a="labo" data-v="Envoi d\'un contrat">Envoyer un contrat</button><button data-a="labo" data-v="Création d\'un paiement">Créer un paiement</button></div></div>';
      h += '<div class="pv2-pane"><h3>Programme</h3><div class="pv2-flds">' + [['formule', 'Formule'], ['dateInscription', 'Date d\'inscription'], ['dateFinProgramme', 'Fin du programme'], ['retractation', 'Rétractation'], ['plateformePaiement', 'Plateforme de paiement'], ['commissions', 'Commissions'], ['coaching72h', 'Coaching 72 h'], ['coach72h', 'Coach 72 h'], ['goodies', 'Goodies'], ['dateEnvoiGoodies', 'Envoi des goodies']].map(function (f) { return fld(l, f[0], f[1]); }).join('') + '</div></div>';
      return h;
    }
    if (t === 'rappels') {
      var fus = (l.followUps || []).slice().sort(function (a2, b2) { return (toMs(b2.dateTime) || 0) - (toMs(a2.dateTime) || 0); });
      h += '<div class="pv2-pane"><h3>Rappels</h3>';
      h += fus.length ? '<div class="pv2-group">' + fus.map(function (f) { var ms = toMs(f.dateTime); return kv(esc((f.done ? '✓ Fait · ' : ms < Date.now() ? 'En retard · ' : '') + fdateL(ms) + ' à ' + fhour(ms)), esc(f.note || 'Sans note')); }).join('') + '</div>' : '<div class="pv2-muted">Aucun rappel.</div>';
      return h + '<button class="pv2-lk" data-a="fu">+ Programmer un rappel</button></div>';
    }
    if (t === 'fichiers') {
      var fs = l.files || [];
      h += '<div class="pv2-pane"><h3>Fichiers</h3>' + (fs.length ? '<div class="pv2-group">' + fs.map(function (f) { return '<div class="pv2-row"><span class="pv2-tile">' + ic('file') + '</span><div class="pv2-tx"><div class="pv2-tt" style="font-size:15px">' + esc(f.name) + '</div><div class="pv2-st">' + esc((f.by || '') + (f.at ? ' · ' + fdate(toMs(f.at)) : '') + (f.size ? ' · ' + Math.round(f.size / 1024) + ' Ko' : '')) + '</div></div></div>'; }).join('') + '</div>' : '<div class="pv2-muted">Aucun fichier.</div>');
      return h + '<button class="pv2-lk" data-a="labo" data-v="Ajout d\'un fichier">+ Ajouter un fichier</button></div>';
    }
    h += '<div class="pv2-pane"><h3>Contact</h3><div class="pv2-flds">' + fld(l, 'nom', 'Nom') + fld(l, 'telephone', 'Téléphone') + fld(l, 'email', 'E-mail') + fld(l, 'instagramUsername', 'Instagram') + '</div></div>';
    h += '<div class="pv2-pane"><h3>Entreprise et besoin</h3><div class="pv2-flds">' + fld(l, 'secteur', 'Secteur') + fld(l, 'ca', 'Chiffre d\'affaires') + fld(l, 'defi', 'Défi') + fld(l, 'disponibilite', 'Disponibilités') + fld(l, 'timeline', 'Délai pour démarrer') + fld(l, 'description', 'Description') + '</div></div>';
    var at = l.attributionFirst || {};
    h += '<div class="pv2-pane"><h3>Provenance · remplie automatiquement</h3><div class="pv2-flds">' + ro('Source', d.src.label) + ro('Campagne', d.src.campaign) + ro('Page d\'arrivée', (l.landingFirst && (l.landingFirst.label || l.landingFirst.page)) || '') + ro('Date d\'arrivée', d.real ? fdate(d.real) : '') + ro('Webinaire', l.dateWebinaire ? fdate(toMs(l.dateWebinaire)) + (l.present ? ' · présent' : '') : '') + ro('UTM', [at.utm_source, at.utm_medium, at.utm_campaign].filter(Boolean).join(' / ') || l.utm || '') + '</div></div>';
    h += '<div class="pv2-pane"><h3>Suivi</h3>' + ownerHTML(l) + '<div class="pv2-flds" style="margin-top:12px">' + ro('Setter d\'origine', l.setterName || (l.setterSlug ? memberName(l.setterSlug) : '')) + fld(l, 'closeur', 'Closeur') + fld(l, 'setting', 'Setting') + '</div></div>';
    return h + '<div class="pv2-pane"><details class="pv2-old"><summary>Anciennes données (Zoho, Bigin, webinaires)</summary><div class="pv2-flds" style="margin-top:12px">' + ro('Origine Zoho', l.zohoOrigine || '') + ro('Gestionnaire Zoho', l.zohoGestionnaire || '') + ro('Tags webinaire', l.tagsWebi || '') + ro('Rejet mails', l.rejetMails || '') + ro('Prospect webinaire', l.prospectWebinaire || '') + ro('Date de réception', l.dateReceptionLead || '') + '</div></details></div>';
  }
  function fld(l, k, lb) { return '<label>' + lb + '<input data-field="' + k + '" value="' + esc(l[k] == null ? '' : l[k]) + '"></label>'; }
  function ro(lb, v) { return '<label>' + lb + '<input value="' + esc(v || '') + '" readonly></label>'; }

  /* Feuilles */
  function sheetHTML() {
    var sh = S.sheet, l = sh.id ? lead(sh.id) : null, h = '<div class="pv2-sbg" data-a="sclose"></div><div class="pv2-sheet" role="dialog" aria-modal="true">';
    if (sh.k === 'filters') {
      var srcs = {}, pbs = {};
      H.leads().forEach(function (x) { var d = derive(x); srcs[d.src.short] = 1; if (d.pb.pilier) pbs[d.pb.pilier] = 1; });
      h += '<h2>Plus de filtres</h2><p>Pour fouiller plus finement. La recherche, elle, cherche partout.</p>' +
        selF('src', 'Arrivés par', [['', 'Toutes les sources']].concat(Object.keys(srcs).sort().map(function (x) { return [x, x]; }))) +
        selF('pb', 'Leur problème (point faible au quiz)', [['', 'Tous']].concat(Object.keys(pbs).sort().map(function (x) { return [x, x]; }))) +
        selF('par', 'Leur parcours', [['', 'Peu importe'], ['jamais', 'Nouveau (jamais appelé)'], ['nonjoint', 'NRP (appelé, jamais joint)'], ['joint', 'Décroché au moins une fois'], ['rdv', 'RDV posé au moins une fois'], ['absent', 'No show'], ['nonclose', 'Closed Lost ou offre envoyée']]) +
        selF('last', 'Dernier contact', [['', 'Peu importe'], ['7', 'Il y a plus de 7 jours'], ['30', 'Il y a plus de 30 jours'], ['90', 'Il y a plus de 3 mois']]) +
        '<button class="pv2-big pv2-blue" data-a="applyf">Voir les leads</button>';
    } else if (sh.k === 'move') {
      /* sh.to : colonne visée (glisser-déposer) ; absent = toutes les étapes (bouton « changer ») */
      h += '<h2>' + esc(l.nom) + (sh.to ? ' → ' + esc(colDef(sh.to).t) : '') + '</h2><p>' + (sh.to ? 'Quelle étape précise ?' : 'Choisir la nouvelle étape') + '</p>' + stageRows(l.stage || 'lead', true, sh.to);
    } else if (sh.k === 'lost') {
      /* Dernière colonne : on enregistre le résultat du RDV, avec qui et pourquoi */
      var dl = derive(l), tb = lostTarget(dl);
      h += '<h2>' + esc(l.nom) + ' → No show / Annulé / Closed Lost</h2><p>' + (tb ? 'RDV du ' + esc(fdateL(bookingStart(tb)) + ' à ' + fhour(bookingStart(tb)) + (tb.personName ? ' avec ' + tb.personName : '')) + ' · ' + (E.sbOf(tb) ? 'SB (pris par le prospect)' : 'NB (posé par l\'équipe)') : 'Aucun RDV retrouvé : seule l\'étape changera, le motif part en note.') + '</p><div class="pv2-group">' + LOST.map(function (x) {
        return '<button class="pv2-row" data-a="lostpick" data-v="' + x.id + '"' + (sh.pick === x.id ? ' aria-current="true"' : '') + '><div class="pv2-tx"><div class="pv2-tt">' + x.t + '</div><div class="pv2-st">' + x.s + '</div></div>' + (sh.pick === x.id ? '<span class="pv2-check">✓</span>' : '') + '</button>'; }).join('') + '</div>' +
        '<label for="pv2lostwhy">Motif' + (sh.pick && lostDef(sh.pick).why ? ' (obligatoire)' : ' (facultatif)') + '</label><textarea id="pv2lostwhy" placeholder="Ex. : closer malade, RDV à replanifier">' + esc(sh.why || '') + '</textarea>' +
        '<button class="pv2-big pv2-blue" data-a="lostsave"' + (sh.pick ? '' : ' disabled') + '>Enregistrer</button>';
    } else if (sh.k === 'result') {
      h += '<h2>Comment s\'est passé l\'appel ?</h2><p>' + esc(l.nom) + '</p><div class="pv2-group">' + [['answered', 'Décroché'], ['noanswer', 'NRP (pas de réponse)'], ['voicemail', 'Messagerie'], ['wrong', 'Faux numéro']].map(function (x) {
        return '<button class="pv2-row" data-a="res" data-v="' + x[0] + '"><div class="pv2-tx"><div class="pv2-tt">' + x[1] + '</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>'; }).join('') + '</div><button class="pv2-soft" style="width:100%;margin-top:12px" data-a="sclose">Je n\'ai pas appelé</button>';
    } else if (sh.k === 'result2') {
      h += '<h2>Et ensuite ?</h2><p>' + esc(l.nom) + ' a décroché.</p><div class="pv2-group">' + [['rdv', 'SET : un RDV est posé'], ['fu', 'FU : à rappeler'], ['nope', 'Disqualifié'], ['trash', 'Poubelle']].map(function (x) {
        return '<button class="pv2-row" data-a="res2" data-v="' + x[0] + '"><div class="pv2-tx"><div class="pv2-tt">' + x[1] + '</div></div><span class="pv2-chev">' + ic('chev') + '</span></button>'; }).join('') + '</div>';
    } else if (sh.k === 'fu') {
      h += '<h2>Programmer un rappel</h2><p>' + esc(l.nom) + '</p><div class="pv2-group">' + [['d1', 'Demain à 10 h'], ['d3', 'Dans 3 jours à 10 h'], ['w1', 'Dans une semaine à 10 h'], ['m1', 'Dans un mois à 10 h']].map(function (x) {
        return '<button class="pv2-row" data-a="fuq" data-v="' + x[0] + '"' + (sh.q === x[0] ? ' aria-current="true"' : '') + '><div class="pv2-tx"><div class="pv2-tt">' + x[1] + '</div></div>' + (sh.q === x[0] ? '<span class="pv2-check">✓</span>' : '') + '</button>'; }).join('') + '</div>' +
        '<label for="pv2fudt">Ou une date précise</label><input id="pv2fudt" type="datetime-local" value="' + esc(sh.dt || '') + '"><label for="pv2funote">Pourquoi le rappeler ?</label><textarea id="pv2funote" placeholder="Ex. : l\'associé devait donner sa réponse">' + esc(sh.note || '') + '</textarea>' +
        '<button class="pv2-big pv2-blue" data-a="fusave">Enregistrer le rappel</button>';
    } else if (sh.k === 'msg') {
      var nm = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'E-mail' }[sh.ch];
      h += '<h2>' + nm + ' à ' + esc(l.nom) + '</h2><p>' + esc(sh.ch === 'email' ? (l.email || 'Pas d\'e-mail') : (l.telephone || 'Pas de téléphone')) + '</p><textarea id="pv2msg" placeholder="Votre message"></textarea><button class="pv2-big pv2-blue" data-a="msgsend">Envoyer</button>';
    } else if (sh.k === 'tag') {
      h += '<h2>Ajouter un tag</h2><p>' + esc(l.nom) + '</p><input id="pv2tag" placeholder="Ex. : Associé, Budget OK"><button class="pv2-big pv2-blue" data-a="tagsave">Ajouter</button>';
    } else if (sh.k === 'stages') {
      var cs = countKeys(filtered(true));
      h += '<h2>Étape</h2><p>Coche une ou plusieurs étapes. Les chiffres tiennent compte des autres filtres. C\'est la même liste que dans Leads Live.</p><div class="pv2-group">' + E.options().map(function (o) {
        var on = S.keys.indexOf(o.key) > -1;
        return '<button class="pv2-row' + (o.sub ? ' pv2-row-sub' : '') + '" data-a="stg" data-v="' + esc(o.key) + '" aria-pressed="' + on + '"><div class="pv2-tx"><div class="pv2-tt" style="font-size:' + (o.sub ? '14.5' : '15.5') + 'px">' + esc(o.label) + '</div></div><span class="pv2-cnt">' + (cs[o.key] || 0) + '</span><span class="pv2-box' + (on ? ' pv2-on' : '') + '">' + (on ? '✓' : '') + '</span></button>'; }).join('') + '</div>' +
        '<button class="pv2-big pv2-blue" data-a="sclose">Voir les leads</button>' + (S.keys.length ? '<button class="pv2-soft" style="width:100%;margin-top:10px" data-a="stgclear">Toutes les étapes</button>' : '');
    } else if (sh.k === 'ask') {
      var dd = derive(l), ok = canTake(l), quand = dd.days == null ? 'jamais contacté' : dd.days === 0 ? 'contacté aujourd\'hui' : 'contacté il y a ' + plural(dd.days, 'jour');
      h += '<h2>Ce lead est suivi par ' + esc(dd.who) + '</h2><p>' + esc(l.nom) + ' · ' + quand + '. ' + (ok ? 'Tu veux le prendre ?' : 'Seul un admin peut le réattribuer avant ' + TAKE_DAYS + ' jours sans contact.') + '</p>' +
        (ok ? '<button class="pv2-big pv2-blue" data-a="askyes">Oui, je le prends</button>' : '') +
        '<button class="pv2-soft" style="width:100%;margin-top:10px" data-a="askno">' + (ok ? 'Non, juste cette fois' : 'Continuer sans le prendre') + '</button>';
    } else if (sh.k === 'assign') {
      h += '<h2>Attribuer à…</h2><p>' + esc(l.nom) + ' · le setter d\'origine ne change pas</p><div class="pv2-group">' + H.team.filter(function (m) { return m.pipeline !== false; }).concat([{ slug: '', name: 'Personne' }]).map(function (m) {
        return '<button class="pv2-row" data-a="assignset" data-v="' + esc(m.slug) + '"><div class="pv2-tx">' + esc(m.name) + (m.slug === H.me.slug ? ' (moi)' : '') + '</div>' + ((l.assignedTo || '') === m.slug ? '<span class="pv2-check">✓</span>' : '') + '</button>'; }).join('') + '</div>';
    } else if (sh.k === 'bulk') {
      h += '<h2>Prendre ' + plural(sh.ids.length, 'lead') + ' ?</h2><p>Suivis aujourd\'hui par ' + esc(memberName(S.who === '_none' ? '' : S.who)) + '. Ils passent dans tes leads ; le setter d\'origine ne change pas.' +
        (sh.kept ? ' ' + plural(sh.kept, 'lead contacté', 'leads contactés') + ' il y a moins de ' + TAKE_DAYS + ' jours ' + (sh.kept > 1 ? 'restent' : 'reste') + ' à ' + esc(memberName(S.who)) + '.' : '') + '</p>' +
        '<button class="pv2-big pv2-blue" data-a="bulkyes">Oui, je les prends</button><button class="pv2-soft" style="width:100%;margin-top:10px" data-a="sclose">Annuler</button>';
    } else if (sh.k === 'new') {
      h += '<h2>Nouveau lead</h2><p>Il arrive dans la colonne « Lead ».</p><label for="pv2nn">Nom et prénom</label><input id="pv2nn"><label for="pv2nt">Téléphone</label><input id="pv2nt" inputmode="tel"><label for="pv2ne">E-mail</label><input id="pv2ne" inputmode="email"><button class="pv2-big pv2-blue" data-a="newsave">Créer le lead</button>';
    }
    return h + '</div>';
  }
  function selF(k, lb, opts) { return '<label for="pv2f-' + k + '">' + lb + '</label><select id="pv2f-' + k + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (S.f[k] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }

  /* Liste des étapes à choisir. La colonne Self booking n'en fait pas partie :
     seul le prospect y entre, en réservant lui-même. La dernière colonne passe
     par la fenêtre « RDV raté » (qui, quand, pourquoi). */
  function stageRows(cur, chev, only) {
    return COLS.filter(function (f) { return only ? f.id === only : f.id !== 'sb'; }).map(function (f) {
      var rows = f.id === 'perdu'
        ? '<button class="pv2-row" data-a="lost"><div class="pv2-tx"><div class="pv2-tt">' + esc(f.t) + '…</div><div class="pv2-st">Annulé, non honoré, no show, FU closing, Closed Lost</div></div>' + (LOST_STAGES[cur] ? '<span class="pv2-check">✓</span>' : '<span class="pv2-chev">' + ic('chev') + '</span>') + '</button>'
        : f.st.map(function (x) {
          return '<button class="pv2-row" data-a="setstage" data-v="' + x + '" aria-current="' + (x === cur) + '"><div class="pv2-tx">' + esc(STAGE_LABEL[x]) + '</div>' + (x === cur ? '<span class="pv2-check">✓</span>' : chev ? '<span class="pv2-chev">' + ic('chev') + '</span>' : '') + '</button>'; }).join('');
      return (only ? '' : '<div class="pv2-gt">' + esc(f.t) + '</div>') + '<div class="pv2-group">' + rows + '</div>';
    }).join('');
  }
  /* Résultats possibles d'un RDV raté (dernière colonne) */
  var LOST = [
    { id: 'annule_prospect', t: 'Annulé par le prospect', s: 'Il a annulé ou demandé à décaler', outcome: 'annule', origin: 'prospect' },
    { id: 'annule_equipe', t: 'Annulé par l\'équipe', s: 'On a annulé de notre côté', outcome: 'annule', origin: 'equipe', why: true },
    { id: 'non_honore', t: 'Non honoré par l\'équipe', s: 'Personne de chez nous ne s\'est présenté', outcome: 'annule', origin: 'equipe', kind: 'non_honore', why: true },
    { id: 'no_show', t: 'No show', s: 'Le prospect n\'est pas venu', outcome: 'no_show' },
    { id: 'fu_closing', t: 'FU closing', s: 'RDV tenu, pas signé, on le relance (offre, 2ᵉ RDV)', outcome: 'offre' },
    { id: 'closed_lost', t: 'Closed Lost', s: 'RDV tenu, il a dit non', outcome: 'non_close' }
  ];
  function lostDef(id) { for (var i = 0; i < LOST.length; i++) if (LOST[i].id === id) return LOST[i]; return LOST[0]; }
  /* RDV visé : celui à venir, sinon le dernier sans résultat, sinon le dernier passé */
  function lostTarget(d) {
    if (d.upcoming) return d.upcoming;
    var bs = d.bookings.filter(function (b) { return b.outcome !== 'replanifie'; });
    for (var i = bs.length - 1; i >= 0; i--) if (!bs[i].outcome && !isCancelled(bs[i]) && bs[i].status !== 'no_show') return bs[i];
    return d.lastPast;
  }
  /* Sans RDV retrouvé : l'étape équivalente, le motif part en note */
  function lostStage(x, l) {
    var sb = (l.type === 'self_booking');
    return { annule_prospect: 'rdv_annules_prospect', annule_equipe: 'rdv_annules_equipe', non_honore: 'rdv_annules_equipe', no_show: sb ? 'no_show_self' : 'no_show_setting', fu_closing: 'follow_up_closing', closed_lost: 'closed_lost' }[x.id];
  }

  /* ═══ 6. Rendu global ═══ */
  function render(keepScroll) {
    var bw = APP.querySelector('.pv2-boardwrap'), sx = bw ? bw.scrollLeft : 0, dr = document.getElementById('pv2drawer'), dy = dr ? dr.scrollTop : 0;
    var foc = document.activeElement && document.activeElement.id === 'pv2q' ? document.activeElement.selectionStart : null;
    var h = '<div class="pv2-page">' + (S.full && lead(S.full) ? fullView(lead(S.full)) : S.view === 'pipe' ? viewPipe() : viewRap()) + '</div>';
    if (!S.full && S.view === 'pipe' && S.drawer) h += drawerHTML();
    if (S.sheet) h += sheetHTML();
    APP.innerHTML = h;
    var nb = APP.querySelector('.pv2-boardwrap'); if (nb) nb.scrollLeft = sx;
    var nd = document.getElementById('pv2drawer'); if (nd && keepScroll) nd.scrollTop = dy;
    if (foc != null) { var q = document.getElementById('pv2q'); if (q) { q.focus(); try { q.setSelectionRange(foc, foc); } catch (e) {} } }
  }
  function toast(msg) {
    TOAST.textContent = msg; TOAST.className = 'pv2-toast pv2-on';
    clearTimeout(toast.t); toast.t = setTimeout(function () { TOAST.className = 'pv2-toast'; }, 2200);
  }
  function done(msg) { return function (err) { if (err) { toast('Erreur : ' + (err.message || err)); return; } if (msg) toast(msg); render(true); }; }
  function curLeadId() {
    if (S.sheet && S.sheet.id) return S.sheet.id;
    if (S.full) return S.full;
    if (S.view === 'pipe' && S.drawer) return S.drawer[0].id;
    var c = S.rap[S.rap.length - 1];
    if (c.s === 'sess' && S.sess) return S.sess.ids[S.sess.i];
    return c.id || null;
  }
  function pushSub(s) {
    var id = curLeadId();
    if (S.view === 'pipe' && S.drawer && !S.full) { S.drawer.push({ s: s, id: id }); render(); var d = document.getElementById('pv2drawer'); if (d) d.scrollTop = 0; return; }
    S.rap.push({ s: s, id: id }); render(); window.scrollTo(0, 0);
  }
  function popAfterWrite() {
    if (S.view === 'pipe' && S.drawer && S.drawer.length > 1 && !S.full) S.drawer.pop();
    else if (!S.full && S.view === 'rap' && S.rap.length > 1 && S.rap[S.rap.length - 1].s === 'etape') S.rap.pop();
  }
  function moveTo(l, stage) {
    if (E.COL_OF_STAGE[stage] === 'closing') { S.sheet = null; render(); H.openClose(l); return; }
    if (LOST_STAGES[stage]) { S.sheet = { k: 'lost', id: l.id }; render(true); return; }
    S.sheet = null; popAfterWrite();
    H.setStage(l, stage, done(l.nom + ' → ' + STAGE_LABEL[stage]));
  }
  function savePrefs() { try { H.pref('state2', JSON.stringify({ view: S.view, per: S.per, sort: S.sort, fold: S.fold, mine: S.mine, dark: S.dark })); } catch (e) {} }
  function loadPrefs() {
    try { var p = JSON.parse(H.pref('state2') || 'null'); if (p) { S.view = p.view || S.view; S.per = p.per || S.per; S.sort = p.sort || S.sort; S.fold = p.fold || S.fold; S.mine = !!p.mine; S.dark = !!p.dark; } } catch (e) {}
  }
  function applyTheme() { ROOT.className = 'pv2' + (S.dark ? ' pv2-dark' : ''); document.documentElement.style.background = S.dark ? '#07080f' : '#eceff8'; }
  function fuDate(q) {
    var d = new Date(); d.setHours(10, 0, 0, 0);
    d.setDate(d.getDate() + (q === 'd1' ? 1 : q === 'd3' ? 3 : q === 'w1' ? 7 : 30));
    return d;
  }
  function localIso(d) { function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; }

  /* ═══ 7. Actions ═══ */
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-a]') : null;
    if (!t || !ROOT.contains(t) || t.disabled) return;
    var a = t.getAttribute('data-a'), v = t.getAttribute('data-v');
    if (t.tagName === 'SELECT') return;
    act(a, v);
  }
  function act(a, v) {
    var l, p;
    /* Agir sur le lead d'un autre : on demande d'abord s'il faut le prendre */
    if ((a === 'call' || a === 'msg' || a === 'fu') && !S.sheet) {
      l = lead(a === 'call' ? v : curLeadId());
      if (l && l.assignedTo && !isMine(l) && !S.okOther[l.id]) { S.sheet = { k: 'ask', id: l.id, a: a, v: v }; render(true); return; }
    }
    switch (a) {
      case 'view': S.view = v; S.full = null; S.drawer = null; if (v === 'rap') S.rap = [{ s: 'home' }]; savePrefs(); render(); window.scrollTo(0, 0); break;
      case 'theme': S.dark = !S.dark; applyTheme(); savePrefs(); break;
      case 'per': S.per = v; savePrefs(); render(); break;
      case 'mine': S.mine = !S.mine; savePrefs(); render(); break;
      case 'clearq': S.q = ''; render(); break;
      case 'reset': S.q = ''; S.per = 'tout'; S.who = null; S.keys = []; S.f = { src: '', pb: '', par: '', last: '' }; savePrefs(); render(); break;
      case 'filters': S.sheet = { k: 'filters' }; render(); break;
      case 'applyf': ['src', 'pb', 'par', 'last'].forEach(function (k) { S.f[k] = val('pv2f-' + k); }); S.sheet = null; render(); break;
      case 'fold': S.fold[v] = true; savePrefs(); render(); break;
      case 'unfold': S.fold[v] = false; savePrefs(); render(); break;
      case 'more': S.lim[v] = (S.lim[v] || 25) + 50; render(); break;
      case 'open': S.drawer = [{ s: 'fiche', id: v }]; render(); break;
      case 'dclose': S.drawer = null; render(); break;
      case 'dback': S.drawer.pop(); render(); break;
      case 'sub': pushSub(v); break;
      case 'full': S.full = v; S.ft = 'fil'; S.fevf = 'tout'; S.cmp = 'note'; render(); window.scrollTo(0, 0); break;
      case 'fclose': S.full = null; render(); window.scrollTo(0, 0); break;
      case 'ft': S.ft = v; render(true); break;
      case 'fevf': S.fevf = v; render(true); break;
      case 'cmp': S.cmp = v; render(true); break;
      case 'fstage': S.sheet = { k: 'move', id: S.full, to: null }; render(true); break;
      case 'toggle': var el = document.getElementById(v); if (el) el.hidden = !el.hidden; break;
      case 'tr':
        l = lead(curLeadId()); var key = l.id + ':' + v, cur = S.tr[key];
        if (cur && cur.open) { cur.open = false; render(true); break; }
        if (cur && cur.data) { cur.open = true; render(true); break; }
        S.tr[key] = { open: true, loading: true }; render(true);
        H.callDetail(l, l.communications[+v], function (err, data) { S.tr[key] = err ? { open: true, error: 'Conversation indisponible : ' + (err.message || err) } : { open: true, data: data || {} }; render(true); });
        break;
      case 'listen': l = lead(curLeadId()); H.listen(l, l.communications[+v]); break;
      case 'call': l = lead(v); H.call(l); S.sheet = { k: 'result', id: l.id }; if (S.sess) S.sess.called++; render(true); break;
      case 'res':
        l = lead(S.sheet.id);
        if (v === 'answered') { S.sheet = { k: 'result2', id: l.id }; H.logCall(l, { answered: true, duration: 180 }, done()); break; }
        var res = v === 'voicemail' ? 'messagerie' : v === 'wrong' ? 'faux numéro' : 'pas de réponse';
        S.sheet = null;
        H.logCall(l, { answered: false, result: res }, function (err) {
          if (err) return done()(err);
          var cst = l.stage || 'lead', nx = v === 'wrong' ? 'faux_numero' : (NRP_STAGES[cst] ? E.NEXT_NRP[cst] : null);
          if (nx && nx !== cst) H.setStage(l, nx, done('Appel noté : ' + res + ' · ' + STAGE_LABEL[nx])); else done('Appel noté : ' + res)();
        });
        break;
      case 'res2':
        l = lead(S.sheet.id);
        if (v === 'rdv') { S.sheet = null; render(true); H.openBooking(l); }
        else if (v === 'fu') { S.sheet = { k: 'fu', id: l.id, q: 'd3' }; render(true); }
        else if (v === 'nope') { S.sheet = null; H.setStage(l, 'disqualification', done(l.nom + ' → Disqualifié')); }
        else if (v === 'trash') { S.sheet = null; H.setStage(l, 'poubelle', done(l.nom + ' → Poubelle')); }
        else { S.sheet = null; render(true); }
        break;
      case 'msg': l = lead(curLeadId()); S.sheet = { k: 'msg', id: l.id, ch: v }; render(true); setTimeout(function () { var m = document.getElementById('pv2msg'); if (m) m.focus(); }, 30); break;
      case 'msgsend': l = lead(S.sheet.id); var tx = val('pv2msg'); if (!tx) { toast('Le message est vide'); break; } var ch = S.sheet.ch; S.sheet = null; H.sendMessage(l, ch, tx, done('Message envoyé')); break;
      case 'fu': l = lead(curLeadId()); S.sheet = { k: 'fu', id: l.id, q: 'd1' }; render(true); break;
      case 'fuq': S.sheet.q = v; S.sheet.dt = ''; S.sheet.note = val('pv2funote'); render(true); break;
      case 'fusave':
        l = lead(S.sheet.id); var dt = val('pv2fudt'), when = dt ? new Date(dt) : fuDate(S.sheet.q || 'd1');
        if (isNaN(when.getTime())) { toast('Date invalide'); break; }
        var note = val('pv2funote'), toFu = S.sheet.toFu; S.sheet = null;
        H.addFollowUp(l, { dateTime: localIso(when), note: note }, function (err) {
          if (err) { done()(err); return; }
          /* Glissé dans la colonne FU depuis une étape hors Lead / NRP : l'hôte ne bouge que les Lead / NRP */
          if (toFu && (l.stage || 'lead') !== 'follow_up_pm') H.setStage(l, 'follow_up_pm', done(l.nom + ' → FU · rappel ' + frel(when.getTime())));
          else done('Rappel prévu ' + frel(when.getTime()))();
        });
        break;
      case 'rdv': l = lead(curLeadId()); H.openBooking(l); break;
      case 'addnote': l = lead(curLeadId()); var nt = val('pv2note'); if (!nt) { toast('La note est vide'); break; } H.addNote(l, nt, done('Note ajoutée')); break;
      case 'cmpsend':
        l = lead(curLeadId()); var ct = val('pv2cmp'); if (!ct) { toast('Le message est vide'); break; }
        if (S.cmp === 'note') H.addNote(l, ct, done('Note ajoutée')); else H.sendMessage(l, S.cmp, ct, done('Message envoyé'));
        break;
      case 'setstage': l = lead(curLeadId()); moveTo(l, v); break;
      case 'tag': l = lead(curLeadId()); S.sheet = { k: 'tag', id: l.id }; render(true); setTimeout(function () { var x = document.getElementById('pv2tag'); if (x) x.focus(); }, 30); break;
      case 'tagsave': l = lead(S.sheet.id); var tg = val('pv2tag'); if (!tg) break; S.sheet = null; H.addTag(l, tg, done('Tag ajouté')); break;
      case 'bump': l = lead(curLeadId()); H.bump(l, done(l.nom + ' remonte en tête de Leads Live')); break;
      case 'aigen': l = lead(curLeadId()); toast('Génération du résumé…'); H.generateAi(l, done('Résumé IA à jour')); break;
      case 'labo': toast(v + ' : ouvrirait le vrai module'); break;
      case 'newlead': S.sheet = { k: 'new' }; render(); break;
      case 'newsave':
        var nn = val('pv2nn'); if (!nn) { toast('Le nom est obligatoire'); break; }
        S.sheet = null; H.createLead({ nom: nn, telephone: val('pv2nt'), email: val('pv2ne') }, done('Lead créé'));
        break;
      case 'sclose': S.sheet = null; render(true); break;
      case 'stg': var ix = S.keys.indexOf(v); if (ix > -1) S.keys.splice(ix, 1); else S.keys.push(v); render(true); break;
      case 'stgclear': S.keys = []; render(true); break;
      case 'll': l = lead(v || curLeadId()); if (l) H.openLeadsLive(l); break;
      case 'lost': l = lead(curLeadId()); S.sheet = { k: 'lost', id: l.id }; render(true); break;
      case 'lostpick': S.sheet.pick = v; S.sheet.why = val('pv2lostwhy'); render(true); break;
      case 'lostsave':
        p = S.sheet; l = lead(p.id); var lx = lostDef(p.pick), why = val('pv2lostwhy'), tb = lostTarget(derive(l));
        if (lx.why && !why) { toast('Le motif est obligatoire quand l\'équipe est en cause'); break; }
        S.sheet = null; popAfterWrite();
        if (tb) H.setOutcome(l, tb, lx.outcome, { origin: lx.origin || null, kind: lx.kind || null, note: why }, done(l.nom + ' → ' + lx.t));
        else H.setStage(l, lostStage(lx, l), function (err) { if (err || !why) { done(l.nom + ' → ' + lx.t)(err); return; } H.addNote(l, lx.t + ' : ' + why, done(l.nom + ' → ' + lx.t)); });
        break;
      case 'stages': S.sheet = { k: 'stages' }; render(true); break;
      case 'take': l = lead(curLeadId()); H.setAssigned(l, H.me.slug, done('Tu suis maintenant ' + l.nom)); break;
      case 'assignto': S.sheet = { k: 'assign', id: curLeadId() }; render(true); break;
      case 'assignset': l = lead(S.sheet.id); S.sheet = null; H.setAssigned(l, v, done(v ? l.nom + ' → ' + memberName(v) : l.nom + ' n\'est plus attribué')); break;
      case 'askyes':
        p = S.sheet; S.sheet = null; S.okOther[p.id] = true; l = lead(p.id);
        H.setAssigned(l, H.me.slug, function (err) { if (err) { done()(err); return; } toast('Tu suis maintenant ' + l.nom); act(p.a, p.v); });
        break;
      case 'askno': p = S.sheet; S.sheet = null; S.okOther[p.id] = true; act(p.a, p.v); break;
      case 'bulktake': var bc = bulkCandidates(sortLeads(filtered())); S.sheet = { k: 'bulk', ids: bc.ok, kept: bc.kept }; render(true); break;
      case 'bulkyes':
        var ids = S.sheet.ids, n = 0; S.sheet = null; render(true);
        ids.forEach(function (id) { H.setAssigned(lead(id), H.me.slug, function () { n++; if (n === ids.length) { toast(plural(n, 'lead repris', 'leads repris')); render(true); } }); });
        break;
      case 'bk': S.rap.push({ s: 'list', bk: v }); render(); window.scrollTo(0, 0); break;
      case 'rlead': S.rap.push({ s: 'fiche', id: v }); render(); window.scrollTo(0, 0); break;
      case 'rback': if (S.rap[S.rap.length - 1].s === 'sess') S.sess = null; S.rap.pop(); if (!S.rap.length) S.rap = [{ s: 'home' }]; render(); window.scrollTo(0, 0); break;
      case 'rhome': S.sess = null; S.rap = [{ s: 'home' }]; render(); window.scrollTo(0, 0); break;
      case 'sess': S.sess = { bk: v, ids: basketGroups(v).flat.map(function (x) { return x.id; }), i: 0, called: 0 }; S.rap.push({ s: 'sess' }); render(); window.scrollTo(0, 0); break;
      case 'next': S.sess.i++; render(); window.scrollTo(0, 0); break;
      case 'later': var id = S.sess.ids.splice(S.sess.i, 1)[0]; S.sess.ids.push(id); if (S.sess.ids.length === 1) S.sess.i++; render(); window.scrollTo(0, 0); toast('Remis en fin de séance'); break;
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'pv2sort') { S.sort = t.value; savePrefs(); render(); return; }
    if (t.id === 'pv2who') { S.who = t.value || null; render(); return; }
    var l = lead(curLeadId());
    if (!l) return;
    var f = t.getAttribute('data-field');
    if (f && !t.readOnly) H.update(l, f, t.value, done('Enregistré'));
  }
  function onInput(e) { if (e.target.id === 'pv2q') { S.q = e.target.value; render(); } }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (S.sheet) { S.sheet = null; render(true); }
    else if (S.full) { S.full = null; render(); }
    else if (S.drawer) { if (S.drawer.length > 1) S.drawer.pop(); else S.drawer = null; render(); }
  }
  /* Glisser-déposer (souris uniquement ; au doigt, l'étape se change dans la fiche) */
  function onDragStart(e) { var c = e.target.closest && e.target.closest('.pv2-card'); if (!c) return; S.drag = c.getAttribute('data-id'); c.className += ' pv2-drag'; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', S.drag); } catch (x) {} }
  function clearOver() { var o = APP.querySelectorAll('.pv2-over'); for (var i = 0; i < o.length; i++) o[i].className = o[i].className.replace(/\s*pv2-over/g, ''); }
  function onDragEnd() { S.drag = null; clearOver(); var d = APP.querySelectorAll('.pv2-drag'); for (var i = 0; i < d.length; i++) d[i].className = d[i].className.replace(/\s*pv2-drag/g, ''); }
  function onDragOver(e) { var col = e.target.closest && e.target.closest('[data-col]'); if (!col || !S.drag) return; e.preventDefault(); if (col.className.indexOf('pv2-over') < 0) { clearOver(); col.className += ' pv2-over'; } }
  function onDrop(e) {
    var col = e.target.closest && e.target.closest('[data-col]'); if (!col || !S.drag) return;
    e.preventDefault(); var to = col.getAttribute('data-col'), l = lead(S.drag); S.drag = null; clearOver();
    if (!l || derive(l).col === to) { render(); return; }
    if (to === 'closing') { render(); H.openClose(l); return; }
    if (to === 'sb') { render(); toast('Seul le prospect entre en Self booking, en réservant lui-même'); return; }
    if (to === 'set') { render(); H.openBooking(l); return; }
    if (to === 'perdu') { S.sheet = { k: 'lost', id: l.id }; render(); return; }
    if (to === 'fu') { S.sheet = { k: 'fu', id: l.id, q: 'd1', toFu: true }; render(); return; }
    var f = colDef(to);
    if (f.st.length === 1) { moveTo(l, f.st[0]); return; }
    S.sheet = { k: 'move', id: l.id, to: to }; render();
  }

  /* ═══ 8. Démarrage ═══ */
  function start(root, host) {
    ROOT = root; H = host;
    BOOK = H.bookings() || {};
    loadPrefs(); applyTheme();
    ROOT.innerHTML = '<div class="pv2-app"></div><div class="pv2-toast" role="status" aria-live="polite"></div>';
    APP = ROOT.firstChild; TOAST = ROOT.lastChild;
    ROOT.addEventListener('click', onClick);
    ROOT.addEventListener('change', onChange);
    ROOT.addEventListener('input', onInput);
    ROOT.addEventListener('dragstart', onDragStart);
    ROOT.addEventListener('dragend', onDragEnd);
    ROOT.addEventListener('dragover', onDragOver);
    ROOT.addEventListener('drop', onDrop);
    document.addEventListener('keydown', onKey);
    render();
  }
  /* L'hôte prévient quand les données changent hors du module (ex. réinitialisation). */
  function refresh() { BOOK = H.bookings() || {}; CACHE = {}; render(true); }

  window.PipelineV2 = {
    start: start, refresh: refresh,
    canTake: function (l) { return canTake(l); }, toast: function (m) { if (TOAST) toast(m); },
    COLS: COLS, STAGE_LABEL: STAGE_LABEL,
    /* exposés pour les tests */
    _derive: derive, _feed: feed, _toMs: toMs
  };
})();
