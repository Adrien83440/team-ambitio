/* ═══════════════════════════════════════════════════════════════════════════
   leads-live-v3.js — LEADS LIVE, NOUVELLE PRÉSENTATION « ÉPURÉE » (essai)
   ─────────────────────────────────────────────────────────────────────────
   Proposition 3 validée par Adrien le 16/10/2026 : une appli grand public,
   un écran = une seule chose à faire, un seul gros bouton par écran, tout le
   reste rangé à un toucher derrière des lignes simples.

   Ce fichier ne change QUE l'affichage de sales-leads.html. Toutes les
   écritures passent par les gestionnaires historiques de la page (statut +
   journal d'actions + stage, follow-up + agenda Stratégie, notes, score,
   SMS, WhatsApp, vocaux, close, présence…). Aucun champ Firestore, aucune
   règle, aucune configuration n'est modifié.

   OUVERTURE À L'ÉQUIPE (17/10/2026, demande Adrien) — chacun à son rythme :
     • admins (users/{uid}.role === 'admin') → nouvelle vue d'office ;
     • sales → ancienne vue, avec un bouton « ✨ Nouvelle version » dans
       l'en-tête, une entrée de menu et un bandeau (refermable) qui propose
       de s'entraîner d'abord dans le bac à sable (sandbox-leads-live.html) ;
     • le choix est mémorisé sur l'appareil (clé ll3_choix_v2 : les choix
       faits pendant les tests sont oubliés) et prime sur la règle par défaut :
       Menu → « Revenir à l'ancienne version » / bouton « Nouvelle version » ;
     • ?v3=1 / ?v3=0 dans l'URL forcent toujours l'une ou l'autre ;
     • _config/leads_live_v3 { enabled: true } → toute l'équipe d'un coup,
       { testeurs: ['slug', …] } → ces membres-là (lisible par les admins
       seulement tant que la règle Firestore n'est pas ouverte aux sales).
   Première arrivée sur la nouvelle vue (réel comme bac à sable) : guide pas
   à pas en deux temps — la liste, puis la première fiche ouverte — via le
   moteur « Montre-moi » (aide-guide.js). Menu → « Revoir le guide ».

   Mécanique : à l'activation seulement, les fonctions globales de rendu
   (renderFeed, renderCard, l2RenderTriage, l2RenderSheet, l2SheetHeadHTML,
   l2SegAction, l2SegInfos, l2IsMobile) sont remplacées. La fiche devient une
   PILE d'écrans (accueil du lead → Écrire → SMS…) dessinée dans
   #ldSheetInner. Les classes, data-action et sélecteurs dont dépendent le
   gestionnaire historique, DialerBridge, VoiceNotes, WhatsAppLead,
   RdvOutcome, ClosePilot, le journal Pilotage (nav.js) et les guides
   « Montre-moi » sont conservés.

   ES5 strict (convention du repo).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var FORCE_KEY = 'll3_choix_v2'; // v2 (17/10) : ouverture à l'équipe, les choix des tests sont oubliés
  var TUTO_KEY = 'll5_tuto_v1';
  var INVIT_KEY = 'll5_invit_fermee_v1';
  var LIST_KEY = 'll3_list';
  var THEME_KEY = 'll5_theme_v3'; // v3 (17/10) : clair par défaut pour le test, les anciens choix sont oubliés
  var on = false;

  /* ═══ Interrupteur ═══════════════════════════════════════════════════ */
  (function lireUrl() {
    try {
      var v = new URLSearchParams(window.location.search).get('v3');
      if (v === '1' || v === '0') localStorage.setItem(FORCE_KEY, v);
    } catch (e) { /* stockage indisponible : on s'en tient à _config */ }
  })();
  function forcage() { try { return localStorage.getItem(FORCE_KEY); } catch (e) { return null; } }

  var cfg = null, role = null;
  function eligibleCfg() {
    if (!cfg) return false;
    if (cfg.enabled === true) return true;
    var me = window.myIdentitySlug || null;
    var t = cfg.testeurs || [];
    return !!(me && t.indexOf && t.indexOf(me) >= 0);
  }
  function peutActiver() {
    if (on) return;
    var f = forcage();
    if (f === '0') { proposer(); return; }
    if (f === '1' || eligibleCfg() || role === 'admin') { activer(); return; }
    if (role) proposer();
  }
  function lireCfg() {
    try {
      firebase.auth().onAuthStateChanged(function (u) {
        if (!u) return;
        /* Rôle lu à la source : en mode application (?app) la page force
           d'abord « sales » dans window._currentRole. */
        if (!role) {
          firebase.firestore().collection('users').doc(u.uid).get().then(function (s) {
            role = (s.exists && s.data() && s.data().role) || 'sales';
            peutActiver();
          }).catch(function () { role = 'sales'; peutActiver(); });
        }
        if (cfg) return;
        firebase.firestore().collection('_config').doc('leads_live_v3').get().then(function (s) {
          cfg = s.exists ? (s.data() || {}) : {};
          peutActiver();
          setTimeout(peutActiver, 2500);
          setTimeout(peutActiver, 8000);
        }).catch(function () { cfg = {}; });
      });
    } catch (e) { /* Firebase indisponible : ancienne vue */ }
  }

  /* ═══ Invitation sur l'ancienne vue (sales) ══════════════════════════ */
  var invite = false;
  function invitFermee() { try { return localStorage.getItem(INVIT_KEY) === '1'; } catch (e) { return false; } }
  function proposer() {
    if (on || invite) return;
    var hd = l2El('l2hd'), row = document.querySelector('#l2hd .l2hd-row1');
    if (!hd || !row) return;
    invite = true;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'll5try'; b.id = 'll5Try';
    b.setAttribute('data-ll5i', 'passer');
    b.title = 'Passer à la nouvelle version de Leads Live';
    b.innerHTML = '✨ <span>Nouvelle version</span>';
    row.insertBefore(b, l2El('l2AgBtn') || null);
    var menu = l2El('l2Menu');
    if (menu) {
      var mi = document.createElement('button');
      mi.type = 'button'; mi.className = 'l2mi'; mi.id = 'll5TryMenu';
      mi.setAttribute('data-ll5i', 'passer');
      mi.innerHTML = '✨ <span>Passer à la nouvelle version</span>';
      menu.insertBefore(mi, menu.firstChild);
    }
    if (!invitFermee()) {
      var bd = document.createElement('div');
      bd.className = 'll5invit'; bd.id = 'll5Invit';
      bd.innerHTML = '<span class="t"><b>✨ Une nouvelle version de Leads Live est prête.</b> ' +
        'Entraîne-toi d’abord dans le bac à sable, sur de faux leads (rien de réel ne part), puis passe dessus quand tu te sens à l’aise. Tu pourras toujours revenir à celle-ci.</span>' +
        '<span class="b"><button type="button" data-ll5i="labo">🧪 M’entraîner</button>' +
        '<button type="button" class="p" data-ll5i="passer">Passer à la nouvelle version</button>' +
        '<button type="button" class="x" data-ll5i="fermer" aria-label="Fermer ce message" title="Fermer">✕</button></span>';
      hd.appendChild(bd);
    }
  }
  function retirerInvitation() {
    ['ll5Try', 'll5TryMenu', 'll5Invit'].forEach(function (k) { var o = l2El(k); if (o && o.parentNode) o.parentNode.removeChild(o); });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-ll5i]') : null;
    if (!t || on) return;
    var a = t.getAttribute('data-ll5i');
    if (a === 'labo') { window.open('sandbox-leads-live.html', '_blank'); return; }
    if (a === 'fermer') {
      try { localStorage.setItem(INVIT_KEY, '1'); } catch (e1) {}
      var bd = l2El('ll5Invit'); if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
      return;
    }
    if (a === 'passer') {
      try { localStorage.setItem(FORCE_KEY, '1'); } catch (e2) {}
      var m = l2El('l2Menu'); if (m) m.classList.remove('on');
      retirerInvitation();
      activer();
    }
  });
  window.addEventListener('team-members-loaded', function () {
    setTimeout(peutActiver, 0);
    if (on) setTimeout(function () { appliquerTheme(); if (allLeads && allLeads.length) renderFeed(); }, 0);
  });

  /* ═══ Icônes au trait ════════════════════════════════════════════════ */
  var IC = {
    phone: '<path d="M5 4h3.2l1.6 4.2-2.1 1.3a11 11 0 0 0 5.8 5.8l1.3-2.1L19 14.8V18a2 2 0 0 1-2 2C9.3 20 4 14.7 4 7a2 2 0 0 1 1-3z"/>',
    msg: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/>',
    dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
    chev: '<path d="M9.5 6l6 6-6 6"/>',
    back: '<path d="M14.5 6l-6 6 6 6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    hist: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v3.5h3.5"/><path d="M12 8v4l2.5 1.5"/>',
    note: '<path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2H10l2 2h6.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
    wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.8z"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    sign: '<path d="M4 19c3 0 3-4 6-4s2 4 5 4 3-3 5-3M14 5l5 5-7 7H7v-5z"/>',
    card: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17M7 14.5h3"/>',
    team: '<circle cx="9" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.5"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M14.5 15c2.6-.4 4.6.9 5.2 3.5"/>',
    sort: '<path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'
  };
  function ic(n) { return '<svg class="ll5i" viewBox="0 0 24 24" aria-hidden="true">' + (IC[n] || '') + '</svg>'; }

  /* ═══ Vocabulaire ════════════════════════════════════════════════════ */
  var FAM = {
    nouveau: 'todo', appele: 'todo', decroche: 'talk', follow_up_pm: 'talk',
    messagerie: 'retry', nrp1: 'retry', nrp2: 'retry', nrp3: 'retry', all_nrp: 'retry',
    set: 'rdv', rdv_pose: 'rdv', rdv_self_booking: 'rdv', client: 'win',
    pas_interesse: 'done', disqualifie: 'done', faux_numero: 'done', poubelle: 'done'
  };
  var FAM_COL = {
    todo: ['#34d399', 'rgba(52,211,153,0.13)'], retry: ['#f59e0b', 'rgba(245,158,11,0.13)'],
    talk: ['#60a5fa', 'rgba(96,165,250,0.13)'], rdv: ['#a78bfa', 'rgba(167,139,250,0.14)'],
    win: ['#fbbf24', 'rgba(251,191,36,0.16)'], done: ['#8f97b2', 'rgba(143,151,178,0.14)']
  };
  var MOTS = {
    decroche: 'A répondu', nrp1: 'Pas répondu · 1ʳᵉ fois', nrp2: 'Pas répondu · 2ᵉ fois',
    nrp3: 'Pas répondu · 3ᵉ fois', all_nrp: 'Ne répond jamais', faux_numero: 'Mauvais numéro',
    follow_up_pm: 'Rappel convenu', set: 'RDV calé par l’équipe', rdv_self_booking: 'RDV pris par le prospect',
    disqualifie: 'Pas pour nous', client: 'Client signé'
  };
  var NRP_SUIVANT = { nrp1: 'nrp2', nrp2: 'nrp3', nrp3: 'all_nrp', all_nrp: 'all_nrp' };
  function patcherStatuts() {
    for (var i = 0; i < STATUSES.length; i++) {
      var s = STATUSES[i];
      s.oldLabel = s.label;
      if (MOTS[s.key]) s.label = MOTS[s.key];
      s.fam = FAM[s.key] || 'done';
      s.color = FAM_COL[s.fam][0];
      s.bg = FAM_COL[s.fam][1];
    }
  }

  var LISTS = {
    faire: { t: 'À faire', d: 'Ce qui t’attend maintenant, du plus urgent au moins urgent.' },
    rappel: { t: 'À rappeler', d: 'Les pas joignables et les rappels programmés.' },
    rdv: { t: 'RDV', d: 'Les leads avec un rendez-vous.' },
    tous: { t: 'Tous', d: 'Toutes les arrivées, jour par jour.' }
  };
  var liste = 'faire';
  try { var lv = localStorage.getItem(LIST_KEY); if (lv && LISTS[lv]) liste = lv; } catch (e) {}
  var rdvSorte = 'all';
  var recherche = false;
  var serie = false;

  /* ═══ Petits outils ══════════════════════════════════════════════════ */
  function leadDe(id) { for (var i = 0; i < allLeads.length; i++) if (allLeads[i].id === id) return allLeads[i]; return null; }
  function prenom(l) { return String((l && l.nom) || '').trim().split(/\s+/)[0] || 'ce lead'; }
  function initiales(l) {
    var p = String((l && l.nom) || '?').trim().split(/\s+/);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function deux(n) { return String(n).padStart(2, '0'); }
  function hm(d) { return deux(d.getHours()) + ':' + deux(d.getMinutes()); }
  function ymd(d) { return d.getFullYear() + '-' + deux(d.getMonth() + 1) + '-' + deux(d.getDate()); }
  function quand(d) {
    var now = new Date();
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diff = Math.round((dd - d0) / 86400000);
    if (diff === 0) return 'aujourd’hui à ' + hm(d);
    if (diff === 1) return 'demain à ' + hm(d);
    if (diff === -1) return 'hier à ' + hm(d);
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' à ' + hm(d);
  }
  function majuscule(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function terminal(l) { return !!L2_TERMINAL[(l && l.status) || 'nouveau']; }
  function fuProchain(l, enRetard) {
    var now = Date.now(), best = null;
    (l.followUps || []).forEach(function (f) {
      if (!f || f.done) return;
      var t = new Date(f.dateTime).getTime();
      if (isNaN(t)) return;
      if (enRetard ? t <= now : t > now) { if (!best || t < best) best = t; }
    });
    return best;
  }
  function rdvAVenir(l) { try { return ldPresUpcoming(l); } catch (e) { return []; } }
  function presAConfirmer(l) { return rdvAVenir(l).some(function (b) { return !b.presenceConfirmed; }); }
  function dansRappel(l) {
    if (terminal(l)) return false;
    var st = l.status || 'nouveau';
    return !!L2_RECALL[st] || st === 'follow_up_pm' || l2HasPendingFu(l);
  }
  function dansRdv(l) { return !!l2SbNb(l) || rdvAVenir(l).length > 0; }
  function estAdmin() { return window._currentRole === 'admin'; }
  function estClient(l) { return !!(l.isClient || l.clientSince || l.stage === 'closed_won_self' || l.stage === 'closed_won_setting' || l.status === 'client'); }
  function stopSms(l) { return !!(l.smsOptedOut || l.smsOptOut); }
  function waOuvert(l) { return Number(l.whatsappFenetre || 0) > Date.now(); }
  function waReste(l) {
    var m = Math.floor((Number(l.whatsappFenetre || 0) - Date.now()) / 60000);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h';
  }
  function telLien(l, id, cls, contenu) {
    var tel = (l.telephone || '').toString().replace(/\s/g, '');
    return '<a href="#" class="' + cls + '" data-action="dialerCall" data-phone="' + escAttr(tel) + '" data-lead-id="' + escAttr(id) + '" data-name="' + escAttr(l.nom || '') + '">' + contenu + '</a>';
  }
  function moi() { try { return getCurrentVoiceUser(); } catch (e) { return null; } }

  /* ═══ Découpage des listes ═══════════════════════════════════════════ */
  function groupesFaire(leads) {
    var late = [], pres = [], neu = [], cours = [];
    leads.forEach(function (l) {
      if (terminal(l)) return;
      var st = l.status || 'nouveau';
      if (l2HasOverdueFu(l)) late.push(l);
      else if (presAConfirmer(l)) pres.push(l);
      else if (l2IsUntouched(l)) neu.push(l);
      else if (!L2_RECALL[st] && st !== 'follow_up_pm' && !l2HasPendingFu(l) && !dansRdv(l)) cours.push(l);
    });
    return [
      { t: 'Rappels en retard', list: late },
      { t: 'Présence à confirmer', list: pres },
      { t: 'Jamais appelés', list: neu },
      { t: 'En cours, à faire avancer', list: cours }
    ];
  }
  function groupesRappel(leads) {
    var retenter = [], prog = [];
    leads.forEach(function (l) {
      if (!dansRappel(l)) return;
      if (L2_RECALL[l.status || 'nouveau']) retenter.push(l); else prog.push(l);
    });
    prog.sort(function (a, b) {
      return (fuProchain(a, true) || fuProchain(a, false) || Infinity) - (fuProchain(b, true) || fuProchain(b, false) || Infinity);
    });
    return [{ t: 'Rappels programmés', list: prog }, { t: 'Pas joignables, à retenter', list: retenter }];
  }
  function groupesRdv(leads) {
    var up = [], autres = [];
    leads.forEach(function (l) {
      if (!dansRdv(l)) return;
      if (rdvSorte !== 'all' && l2SbNb(l) !== rdvSorte) return;
      if (rdvAVenir(l).length) up.push(l); else autres.push(l);
    });
    up.sort(function (a, b) { return ldAgStartMs(rdvAVenir(a)[0]) - ldAgStartMs(rdvAVenir(b)[0]); });
    return [{ t: 'RDV à venir', list: up }, { t: 'RDV passés ou à statuer', list: autres }];
  }
  function compter(leads) {
    var n = function (gs) { var s = 0; gs.forEach(function (g) { s += g.list.length; }); return s; };
    var keep = rdvSorte; rdvSorte = 'all';
    var c = { faire: n(groupesFaire(leads)), rappel: n(groupesRappel(leads)), rdv: n(groupesRdv(leads)), tous: leads.length };
    rdvSorte = keep;
    return c;
  }

  /* ═══ Une phrase pour dire où en est le lead ═════════════════════════ */
  function situation(l) {
    var st = l.status || 'nouveau', so = getStatusObj(st);
    var late = fuProchain(l, true), b = rdvAVenir(l)[0], fut = fuProchain(l, false), la = l2LastActivity(l);
    if (late && !terminal(l)) return { dot: 'late', ligne: 'Rappel prévu ' + quand(new Date(late)) + ' · en retard', titre: so.label, detail: 'Rappel prévu ' + quand(new Date(late)) + ', en retard', retard: true };
    if (b && !b.presenceConfirmed) return { dot: 'warn', ligne: 'RDV ' + ldPresRdvLabel(b) + ' · présence à confirmer', titre: 'RDV ' + ldPresRdvLabel(b), detail: 'Présence pas encore confirmée' + (b.personName ? ' · avec ' + b.personName : '') };
    if (b) return { dot: 'ok', ligne: 'RDV ' + ldPresRdvLabel(b) + ' · présence confirmée', titre: 'RDV ' + ldPresRdvLabel(b), detail: 'Présence confirmée' + (b.personName ? ' · avec ' + b.personName : '') };
    if (estClient(l)) return { dot: 'ok', ligne: 'Client · closing en cours', titre: 'Client signé', detail: 'Suis le closing jusqu’au bout' };
    if (l2IsUntouched(l)) {
      var arr = l2ArrivalLabel(_getLeadEffectiveDate(l) || l.createdAt);
      var a = (/^\d\d:\d\d$/.test(arr) ? 'à ' : '') + arr;
      return { dot: 'new', ligne: 'Arrivé ' + a + ' · jamais appelé', titre: 'Nouveau', detail: 'Jamais appelé · arrivé ' + a };
    }
    if (fut && !terminal(l)) return { dot: 'ok', ligne: 'Rappel ' + quand(new Date(fut)), titre: so.label, detail: 'Rappel prévu ' + quand(new Date(fut)) };
    if (terminal(l)) return { dot: 'off', ligne: so.label, titre: so.label, detail: 'Ce lead est sorti du parcours' + (la ? ' · ' + la : '') };
    if (L2_RECALL[st]) return { dot: 'warn', ligne: so.label + ' · à retenter', titre: so.label, detail: la || 'À retenter' };
    return { dot: 'off', ligne: so.label + (la ? ' · ' + la : ''), titre: so.label, detail: la || '' };
  }

  /* ═══ Liste (accueil) ════════════════════════════════════════════════ */
  function ligneLead(l) {
    var s = situation(l);
    var tel = (l.telephone || '').toString().replace(/\s/g, '');
    var cls = s.dot === 'late' ? 'late' : (s.dot === 'warn' ? 'warn' : (s.dot === 'ok' ? 'ok' : ''));
    var h = '<div class="ld-card ll5card' + (openCardId === l.id ? ' is-open' : '') + (terminal(l) && l.status !== 'client' ? ' l2done' : '') + (l._isNew ? ' new' : '') +
      '" data-lead-id="' + l.id + '" data-phone="' + escAttr(tel) + '" data-name="' + escAttr(l.nom || '') + '">';
    h += '<div class="ld-card-head ll5row" data-action="toggle" data-id="' + l.id + '" role="button" tabindex="0">';
    h += '<span class="ll5av">' + escHtml(initiales(l)) + '<i class="ll5dot ' + s.dot + '"></i></span>';
    h += '<span class="ll5tx"><b>' + escHtml(l.nom || '—') + '</b><span class="' + cls + '">' + escHtml(s.ligne) + '</span></span>';
    h += '<span class="ll5chev">' + ic('chev') + '</span>';
    h += '</div></div>';
    return h;
  }
  function heros(leads) {
    var g = groupesFaire(leads), l = null, quoi = '';
    for (var i = 0; i < g.length && !l; i++) if (g[i].list.length) { l = g[i].list[0]; quoi = ['late', 'pres', 'new', 'cours'][i]; }
    if (!l) return '<div class="ll5hero calm"><span class="k">Rien d’urgent pour l’instant</span><b>Tout est à jour 👍</b><span class="ll5muted">Regarde « À rappeler » ou « Tous » si tu veux avancer.</span></div>';
    var s = situation(l), titre, bouton;
    if (quoi === 'late') titre = 'Rappeler ' + l.nom;
    else if (quoi === 'pres') titre = 'Confirmer la présence de ' + l.nom;
    else if (quoi === 'new') titre = 'Appeler ' + l.nom;
    else titre = 'Faire avancer ' + l.nom;
    if (quoi === 'pres') {
      var b = rdvAVenir(l)[0];
      bouton = '<button type="button" class="ll5big go" data-pres="confirm" data-booking-id="' + escAttr(b.id) + '">' + ic('check') + 'Confirmer la présence</button>';
    } else if (l.telephone) {
      bouton = telLien(l, l.id, 'll5big go', ic('phone') + 'Appeler ' + escHtml(prenom(l)));
    } else {
      bouton = '<button type="button" class="ll5big pri" data-ll5="open" data-id="' + l.id + '">Ouvrir la fiche</button>';
    }
    var tel = (l.telephone || '').toString().replace(/\s/g, '');
    return '<div class="ld-card ll5hero" data-lead-id="' + l.id + '" data-phone="' + escAttr(tel) + '" data-name="' + escAttr(l.nom || '') + '">' +
      '<div class="ld-card-head" data-action="toggle" data-id="' + l.id + '" role="button" tabindex="0"><span class="k">À faire en premier</span>' +
      '<span class="who"><span class="ll5av">' + escHtml(initiales(l)) + '</span><span><b>' + escHtml(titre) + '</b><span class="' + (s.dot === 'late' ? 'late' : (s.dot === 'warn' ? 'warn' : '')) + '">' + escHtml(s.ligne) + '</span></span></span>' +
      '<span class="l2side">' + bouton + '</span></div></div>';
  }
  function rendreFile() {
    var leads = getFilteredLeads();
    updateCounts();
    updatePeriodCounts();
    rebuildTypeFilters();
    var feed = l2El('ldFeed');
    var c = compter(leads);
    var u = moi();
    var so = SETTERS[myIdentitySlug || personalUser] || null;
    var nomMoi = majuscule(String((so && so.name) || (u && u.name) || '').split(/\s+/)[0]);
    var aujourd = majuscule(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
    var fc = l2FiltersActiveCount();

    var h = '<div class="ll5nav">';
    h += '<button type="button" class="ll5me" data-ll5="menu" aria-label="Menu : notifications, liens, réglages">' + escHtml((nomMoi || '?').charAt(0).toUpperCase()) + '</button>';
    h += '<span class="ll5grow"></span>';
    var clair = document.body.classList.contains('light-theme');
    h += '<button type="button" class="ll5ib" data-ll5="theme" aria-label="' + (clair ? 'Passer en thème sombre' : 'Passer en thème clair') + '" title="' + (clair ? 'Thème sombre' : 'Thème clair') + '">' + ic(clair ? 'moon' : 'sun') + '</button>';
    h += '<button type="button" class="ll5ib" data-ll5="agenda" aria-label="Mes RDV du jour">' + ic('cal') + '<span class="ll5badge" id="ll5AgN"></span></button>';
    h += '<button type="button" class="ll5ib" data-ll5="search" aria-label="Rechercher">' + ic('search') + '</button>';
    h += '<button type="button" class="ll5ib" data-ll5="new" aria-label="Créer une fiche">' + ic('plus') + '</button>';
    h += '</div>';

    if (recherche || filterSearch) {
      h += '<h1 class="ll5h1">Rechercher</h1>';
      h += '<div class="ll5search"><span>' + ic('search') + '</span><input id="ll5Q" type="search" placeholder="Nom, téléphone, e-mail, secteur…" value="' + escAttr(filterSearch) + '" autocomplete="off" aria-label="Rechercher un lead"/>' +
        '<button type="button" class="ll5ib" data-ll5="searchoff" aria-label="Fermer la recherche">' + ic('x') + '</button></div>';
      h += '<p class="ll5sub">La recherche regarde dans tous les leads, sans tenir compte des filtres.</p>';
    } else {
      h += '<h1 class="ll5h1">' + (nomMoi ? 'Bonjour ' + escHtml(nomMoi) : 'Bonjour') + '</h1>';
      h += '<p class="ll5sub">' + escHtml(aujourd) + ' · ' + (c.faire ? c.faire + ' chose' + (c.faire > 1 ? 's' : '') + ' à faire' : 'rien d’urgent') + '</p>';
      h += heros(leads);
    }

    if (!filterSearch) {
      h += '<div class="ll5tabs" role="group" aria-label="Mes listes" id="l2Triage">';
      ['faire', 'rappel', 'rdv', 'tous'].forEach(function (k) {
        h += '<button type="button" data-ll5="list" data-v="' + k + '" aria-pressed="' + (liste === k) + '">' + LISTS[k].t + '<span class="n">' + c[k] + '</span></button>';
      });
      h += '</div>';
      h += '<div class="ll5pills">';
      h += '<button type="button" class="ll5pill' + (fc ? ' on' : '') + '" id="l2FiltersBtn" data-ll5="filters">' + ic('filter') + 'Filtres' + (fc ? ' · ' + fc : '') + '</button>';
      if (liste === 'tous') h += '<button type="button" class="ll5pill" id="l2SortBtn" data-l2="sort">' + ic('sort') + (l2Sort === 'proba' ? 'Plus de chances de RDV' : 'Plus récents') + '</button>';
      if (liste === 'rdv') {
        [['all', 'Tous'], ['sb', 'Pris par le prospect'], ['nb', 'Posés par l’équipe']].forEach(function (x) {
          h += '<button type="button" class="ll5pill' + (rdvSorte === x[0] ? ' on' : '') + '" data-ll5="rdvkind" data-v="' + x[0] + '">' + x[1] + '</button>';
        });
      }
      if (serie) h += '<button type="button" class="ll5pill on" data-ll5="serie">Appel en série · terminer</button>';
      h += '</div>';
    }

    var sections;
    if (filterSearch) sections = [{ t: leads.length + ' résultat' + (leads.length > 1 ? 's' : ''), list: leads }];
    else if (liste === 'faire') sections = groupesFaire(leads);
    else if (liste === 'rappel') sections = groupesRappel(leads);
    else if (liste === 'rdv') sections = groupesRdv(leads);
    else sections = l2Sort === 'proba' ? [{ t: 'Par chance de RDV', list: leads }] : l2ArriveesSections(leads).map(function (s) { return { t: s.t.replace(/^📥\s*/, ''), list: s.list }; });

    var total = 0;
    sections.forEach(function (sec) {
      if (!sec.list.length) return;
      total += sec.list.length;
      h += '<div class="ll5gt">' + escHtml(sec.t) + '</div><div class="ll5group">';
      for (var i = 0; i < sec.list.length; i++) h += renderCard(sec.list[i]);
      h += '</div>';
    });
    if (!total) h += '<div class="ll5empty">' + (filterSearch ? 'Aucun lead ne correspond à « ' + escHtml(filterSearch) + ' ».' : (liste === 'faire' ? 'Rien d’urgent pour l’instant 👍' : 'Rien dans cette liste pour l’instant.')) + '</div>';

    var focus = document.activeElement && document.activeElement.id === 'll5Q';
    var caret = focus ? document.activeElement.selectionStart : 0;
    feed.innerHTML = '<div class="ll5list">' + h + '</div>';
    if (focus) { var qi = l2El('ll5Q'); if (qi) { qi.focus(); try { qi.setSelectionRange(caret, caret); } catch (e) {} } }
    peindreAgenda();

    if (window.DialerBridge) {
      try { window.DialerBridge.enableMultiSelect('#ldFeed', { cardSelector: '.ll5card', maxSelection: 5 }); } catch (e) { console.warn('[DialerBridge] attach failed', e); }
    }
    if (openCardId && !isEditingLead) l2RenderSheet(openCardId, true);
    l2SyncHdH();
  }
  function peindreAgenda() {
    var src = l2El('l2AgCount'), dst = l2El('ll5AgN');
    if (src && dst) { dst.textContent = src.textContent || ''; dst.style.display = src.textContent ? '' : 'none'; }
  }

  /* ═══ Fiche : une pile d'écrans ══════════════════════════════════════ */
  var pile = ['lead'], pileLead = null, anime = false, peinture = false;
  var waCache = {};
  function ecran() { return pile[pile.length - 1] || 'lead'; }
  function aller(e) { pile.push(e); anime = true; if (openCardId) l2RenderSheet(openCardId, false); }
  function retour() { if (pile.length > 1) pile.pop(); anime = true; if (openCardId) l2RenderSheet(openCardId, false); }
  function accueilLead(msg) { pile = ['lead']; anime = true; if (openCardId) l2RenderSheet(openCardId, false); if (msg) toast(msg); }

  var TITRES = { write: 'Écrire', 'c-sms': 'SMS', 'c-wa': 'WhatsApp', 'c-mail': 'E-mail', 'c-note': 'Note pour l’équipe', voice: 'Vocaux', fu: 'Rappel', rdv: 'Rendez-vous', hist: 'Historique', info: 'Infos et dossier', ai: 'Conseil de l’IA', stars: 'Qualité du lead', notes: 'Notes', more: 'Plus', state: 'Changer l’état', closing: 'Closing', result: 'Résultat de l’appel', result2: 'Résultat de l’appel', fuask: 'Rappel', incall: 'Appel' };

  function barre(l, e) {
    var premier = e === 'lead';
    return '<div class="ll5bar">' +
      '<button type="button" class="ll5ib' + (premier ? ' ll5back-list' : '') + '" ' + (premier ? 'data-l2="close"' : 'data-ll5="back"') + ' aria-label="' + (premier ? 'Revenir à la liste' : 'Retour') + '">' + ic(premier ? 'back' : 'back') + '</button>' +
      '<span class="t">' + escHtml(premier ? (l.nom || '') : (TITRES[e] || '')) + '</span>' +
      (premier ? '<button type="button" class="ll5ib" data-ll5="go" data-v="more" aria-label="Plus d’options">' + ic('dots') + '</button>' : '<span class="ll5ib ll5ghost"></span>') +
      '</div>';
  }
  function ligne(icon, cls, titre, valeur, attrs) {
    return '<button type="button" class="ll5line" ' + attrs + '><span class="ll5ric ' + (cls || '') + '">' + ic(icon) + '</span><span class="ll5tx"><b>' + titre + '</b>' +
      (valeur && valeur.charAt(0) === '\u0001' ? '<span>' + valeur.slice(1) + '</span>' : '') + '</span>' +
      (valeur && valeur.charAt(0) !== '\u0001' ? '<span class="ll5val">' + valeur + '</span>' : '') + '<span class="ll5chev">' + ic('chev') + '</span></button>';
  }
  function sous(t) { return '\u0001' + t; }

  /* Accueil du lead */
  function boutonPrincipal(l, id) {
    var b = rdvAVenir(l)[0], wa = waCache[id];
    if (fuProchain(l, true) && !terminal(l) && l.telephone) return telLien(l, id, 'll5big go', ic('phone') + 'Appeler ' + escHtml(prenom(l))) + '<p class="ll5under">' + escHtml(normalizeTel(l.telephone)) + '</p>';
    if (b && !b.presenceConfirmed) return '<button type="button" class="ll5big go" data-pres="confirm" data-booking-id="' + escAttr(b.id) + '">' + ic('check') + 'Confirmer sa présence</button><p class="ll5under">RDV ' + escHtml(ldPresRdvLabel(b)) + '</p>';
    if (wa && wa.dernierIn && waOuvert(l)) return '<button type="button" class="ll5big go" data-ll5="go" data-v="c-wa">' + ic('wa') + 'Répondre sur WhatsApp</button><p class="ll5under">Réponse libre encore ' + escHtml(waReste(l)) + '</p>';
    if (estClient(l)) return '<button type="button" class="ll5big pri" data-ll5="go" data-v="closing">' + ic('trophy') + 'Suivre le closing</button>';
    if (terminal(l)) return '<button type="button" class="ll5big soft" data-ll5="go" data-v="state">Remettre ce lead en jeu</button>';
    if (b) return '<button type="button" class="ll5big pri" data-ai-prep="' + escAttr(b.id) + '">' + ic('spark') + 'Préparer le RDV</button><p class="ll5under">RDV ' + escHtml(ldPresRdvLabel(b)) + '</p>';
    if (l.telephone) return telLien(l, id, 'll5big go', ic('phone') + 'Appeler ' + escHtml(prenom(l))) + '<p class="ll5under">' + escHtml(normalizeTel(l.telephone)) + '</p>';
    return '<button type="button" class="ll5big pri" data-ll5="go" data-v="write">' + ic('msg') + 'Écrire à ' + escHtml(prenom(l)) + '</button><p class="ll5under">Pas de numéro sur cette fiche</p>';
  }
  function ecranLead(l, id) {
    var s = situation(l);
    var typ = LEAD_TYPES[l.type] || { label: l.type || '' };
    var bits = [l.secteur, l.ca, typ.label].filter(function (x) { return x && String(x).trim(); });
    var so = SETTERS[l.assignedTo] || null;
    var h = '<h1 class="ll5h1 l2sh-name">' + escHtml(l.nom || '—') + '</h1>';
    h += '<p class="ll5sub">' + escHtml(bits.join(' · ')) + (so ? (bits.length ? ' · ' : '') + 'suivi par ' + escHtml(so.name) : '') + '</p>';
    h += '<div class="ll5status ' + (s.retard ? 'late' : '') + '"><i class="ll5dot ' + s.dot + '"></i><span><b>' + escHtml(s.titre) + '</b><span>' + escHtml(s.detail) + '</span></span></div>';
    var wa = waCache[id];
    if (wa && wa.dernierIn && wa.texte) {
      h += '<button type="button" class="ll5msg" data-ll5="go" data-v="c-wa"><span class="k">' + escHtml(prenom(l)) + ' t’a écrit sur WhatsApp' + (wa.quand ? ' · ' + escHtml(wa.quand) : '') + '</span><span class="x">« ' + escHtml(wa.texte) + ' »</span></button>';
    }
    h += boutonPrincipal(l, id);
    h += '<div class="ll5acts">';
    h += l.telephone ? telLien(l, id, 'll5act call', '<span class="c">' + ic('phone') + '</span>Appeler') : '<span class="ll5act off"><span class="c">' + ic('phone') + '</span>Appeler</span>';
    h += '<button type="button" class="ll5act" data-ll5="go" data-v="write"><span class="c">' + ic('msg') + '</span>Écrire</button>';
    h += '<button type="button" class="ll5act" data-ll5="go" data-v="fu"><span class="c">' + ic('clock') + '</span>Rappel</button>';
    h += '<button type="button" class="ll5act" data-ll5="go" data-v="rdv"><span class="c">' + ic('cal') + '</span>RDV</button>';
    h += '<button type="button" class="ll5act" data-ll5="go" data-v="more"><span class="c">' + ic('dots') + '</span>Plus</button>';
    h += '</div>';

    var a = l.aiLead, nRdv = compterRdv(id), b = rdvAVenir(l)[0], fut = fuProchain(l, true) || fuProchain(l, false);
    var nHist = (l.communications || []).length + (l.notesHistory || []).length;
    if (!terminal(l) && (dansRdv(l) || estClient(l) || l.closePilot)) {
      /* Pilote de closing (_config/sales_close_pilot) : « OK pour le closing,
         c'est parti » ou la reprise des cartes, peint par paintCloseRail.
         Masqué tant que le pilote n'est pas actif (le rail historique reste
         dans l'écran Closing). */
      h += '<div class="ld-rail-block ll5rail ll5railhome" data-close-rail="' + id + '"></div>';
    }
    h += '<div class="ll5gt">Sur ' + escHtml(prenom(l)) + '</div><div class="ll5group">';
    h += ligne('spark', '', 'Conseil de l’IA', a && typeof a.proba === 'number' ? a.proba + ' % de chances de RDV' : 'À lancer', 'data-ll5="go" data-v="ai"');
    h += ligne('hist', 'grey', 'Historique', nHist ? nHist + ' élément' + (nHist > 1 ? 's' : '') : 'Rien encore', 'data-ll5="go" data-v="hist"');
    h += ligne('cal', b && !b.presenceConfirmed ? 'warn' : 'grey', 'Rendez-vous', b ? 'RDV ' + ldPresRdvLabel(b) : (nRdv ? nRdv + ' passé' + (nRdv > 1 ? 's' : '') : 'Aucun'), 'data-ll5="go" data-v="rdv"');
    h += ligne('clock', fuProchain(l, true) ? 'late' : 'grey', 'Rappels', fut ? majuscule(quand(new Date(fut))) : 'Aucun', 'data-ll5="go" data-v="fu"');
    h += ligne('note', 'grey', 'Notes', (l.notesHistory || []).length ? (l.notesHistory.length + ' note' + (l.notesHistory.length > 1 ? 's' : '')) : 'Aucune', 'data-ll5="go" data-v="notes"');
    h += ligne('star', 'grey', 'Qualité du lead', l.leadScore >= 1 ? l.leadScore + ' sur 5' : 'Pas notée', 'data-ll5="go" data-v="stars"');
    h += ligne('user', 'grey', 'Infos et dossier', 'Coordonnées, quiz, formulaire…', 'data-ll5="go" data-v="info"');
    h += '</div>';
    return h;
  }

  /* Écrire */
  function ecranEcrire(l, id) {
    var h = '<h1 class="ll5h1">Écrire à ' + escHtml(prenom(l)) + '</h1><p class="ll5sub">Par quel moyen ?</p><div class="ll5group ll5mt">';
    var waConseil = !!l.telephone && waOuvert(l);
    if (l.telephone) h += choix('wa', 'go', 'WhatsApp', waOuvert(l) ? 'Réponse libre encore ' + waReste(l) : 'Un modèle validé par WhatsApp sera proposé', waConseil, 'data-ll5="go" data-v="c-wa"');
    if (l.telephone && !stopSms(l)) h += choix('msg', '', 'SMS', normalizeTel(l.telephone), !waConseil, 'data-ll5="go" data-v="c-sms"');
    if (stopSms(l)) h += choix('msg', 'grey', 'SMS impossible', prenom(l) + ' a répondu STOP', false, 'disabled');
    if (l.email) h += choix('mail', '', 'E-mail', l.email, !l.telephone, 'data-ll5="go" data-v="c-mail"');
    h += choix('note', 'grey', 'Note pour l’équipe', 'Jamais envoyée à ' + prenom(l), false, 'data-ll5="go" data-v="c-note"');
    h += choix('mic', 'grey', 'Vocal pour l’équipe', 'Enregistré, transcrit et résumé', false, 'data-ll5="go" data-v="voice"');
    return h + '</div>';
  }
  function choix(icon, cls, titre, sousTitre, conseille, attrs) {
    return '<button type="button" class="ll5line big" ' + attrs + '><span class="ll5ric ' + cls + '">' + ic(icon) + '</span><span class="ll5tx"><b>' + escHtml(titre) + '</b><span>' + escHtml(sousTitre) + '</span></span>' +
      (conseille ? '<span class="ll5reco">Conseillé</span>' : '<span class="ll5chev">' + ic('chev') + '</span>') + '</button>';
  }
  function ecranSms(l, id) {
    var h = '<h1 class="ll5h1">SMS</h1><p class="ll5sub">À ' + escHtml(l.nom || '') + ' · ' + escHtml(normalizeTel(l.telephone || '')) + '</p>';
    h += '<div class="ld-sms-composer ll5compose">';
    h += '<div class="l2tpl-row ll5pills">';
    h += '<button type="button" class="ll5pill ai" data-l2="aiMsg" data-id="' + id + '">' + ic('spark') + 'Écrire avec l’IA</button>';
    h += '<button type="button" class="ll5pill" data-l2="tpl" data-tpl="rate" data-id="' + id + '">Je vous ai manqué</button>';
    h += '<button type="button" class="ll5pill" data-l2="tpl" data-tpl="confirm" data-id="' + id + '">Confirmer le RDV</button>';
    h += '<button type="button" class="ll5pill" data-l2="tpl" data-tpl="veille" data-id="' + id + '">Rappel la veille</button>';
    h += '<button type="button" class="ll5pill" data-l2="aiDm" data-id="' + id + '">Réponse à un DM Insta</button>';
    h += '</div>';
    h += l2AiSuggHTML(id);
    h += '<textarea class="ll5ta" data-sms-input="' + id + '" placeholder="Ton message, signé de ton prénom…" maxlength="1530" aria-label="Message"></textarea>';
    h += '<div class="ld-sms-composer-counter" data-sms-counter="' + id + '">0 / 160</div>';
    h += '<div class="ld-sms-composer-error" data-sms-error="' + id + '" style="display:none"></div>';
    h += '</div>';
    h += '<div class="ll5foot"><button type="button" class="ll5big pri" data-action="sendSms" data-id="' + id + '">Envoyer le SMS</button></div>';
    return h;
  }
  function ecranWa(l, id) {
    return '<h1 class="ll5h1">WhatsApp</h1><p class="ll5sub">' + escHtml(l.nom || '') + ' · ' + (waOuvert(l) ? 'réponse libre encore ' + escHtml(waReste(l)) : 'fenêtre fermée : modèles validés seulement') + '</p>' +
      '<div class="ll5wa" data-wal-mount="' + id + '"></div>';
  }
  var mailEtat = {};
  function ecranMail(l, id) {
    var m = mailEtat[id] || { objet: 'Suite à votre demande, ' + prenom(l), corps: '' };
    var h = '<h1 class="ll5h1">E-mail</h1><p class="ll5sub">À ' + escHtml(l.email || '') + '</p>';
    h += '<div class="ll5compose"><div class="ll5pills"><button type="button" class="ll5pill ai" data-ll5="mailai" data-id="' + id + '">' + ic('spark') + (m.busy ? 'L’IA rédige…' : 'Écrire avec l’IA') + '</button></div>';
    if (m.err) h += '<p class="ll5err">' + escHtml(m.err) + '</p>';
    h += '<input class="ll5in" id="ll5MailSubj" value="' + escAttr(m.objet) + '" placeholder="Objet" aria-label="Objet"/>';
    h += '<textarea class="ll5ta" id="ll5MailBody" placeholder="Ton e-mail…" aria-label="Texte de l’e-mail">' + escHtml(m.corps) + '</textarea>';
    h += '<p class="ll5note">Envoyé depuis la boîte Alteore de l’équipe et tracé dans l’historique.</p></div>';
    h += '<div class="ll5foot"><button type="button" class="ll5big pri" data-ll5="mailsend" data-id="' + id + '"' + (m.sending ? ' disabled' : '') + '>' + (m.sending ? 'Envoi…' : 'Envoyer l’e-mail') + '</button></div>';
    return h;
  }
  function ecranNoteCompose(l, id) {
    var h = '<h1 class="ll5h1">Note pour l’équipe</h1><p class="ll5sub">Visible seulement par l’équipe, jamais envoyée à ' + escHtml(prenom(l)) + '. Tape @ pour prévenir quelqu’un.</p>';
    h += '<div class="ll5compose"><div class="ll5pills">';
    (window.TEAM_MEMBERS_ACTIVE || []).slice(0, 8).forEach(function (m) {
      if (!m || !m.slug) return;
      h += '<button type="button" class="ll5pill" data-ll5="mention" data-v="' + escAttr(m.slug) + '">@' + escHtml(m.shortName || m.displayName || m.slug) + '</button>';
    });
    h += '</div><textarea class="ll5ta ld-notes-area" data-field="newNote" data-id="' + id + '" placeholder="Ta note…" aria-label="Note"></textarea></div>';
    h += '<div class="ll5foot"><button type="button" class="ll5big pri" data-action="addNote" data-id="' + id + '">Enregistrer la note</button></div>';
    return h;
  }
  function ecranVocaux(l, id) {
    return '<h1 class="ll5h1">Vocaux</h1><p class="ll5sub">Pour l’équipe : enregistré, transcrit puis résumé automatiquement (3 min maximum).</p><div class="vn-container ll5vn" data-vn-mount="' + id + '"></div>';
  }

  /* Rappel */
  var CHOIX_RAPPEL = [['1h', 'Dans 1 heure'], ['soir', 'Ce soir à 18:00'], ['demain9', 'Demain à 9:00'], ['demain14', 'Demain à 14:00'], ['lundi9', 'Lundi à 9:00']];
  function heureRapide(k) {
    var d = new Date();
    if (k === '1h') { d = new Date(Date.now() + 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); return d.getTime(); }
    if (k === 'soir') { d.setHours(18, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }
    if (k === 'demain9' || k === 'demain14') { d.setDate(d.getDate() + 1); d.setHours(k === 'demain9' ? 9 : 14, 0, 0, 0); return d.getTime(); }
    if (k === 'lundi9') { var add = (8 - d.getDay()) % 7 || 7; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return d.getTime(); }
    return Date.now() + 3600000;
  }
  function listeRappels(l, id) {
    var fus = l.followUps || [], now = Date.now();
    if (!fus.length) return '';
    var tri = fus.map(function (f, idx) { f._idx = idx; return f; }).sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime();
    });
    var h = '<div class="ll5gt">Déjà prévus</div><div class="ll5group">';
    tri.forEach(function (fu) {
      var d = new Date(fu.dateTime), late = !fu.done && d.getTime() <= now;
      h += '<div class="ll5line static' + (fu.done ? ' done' : '') + '"><span class="ll5ric ' + (late ? 'late' : (fu.done ? 'grey' : '')) + '">' + ic(fu.done ? 'check' : 'clock') + '</span>';
      h += '<span class="ll5tx"><b>' + escHtml(majuscule(quand(d))) + '</b><span class="' + (late ? 'late' : '') + '">' + (late ? 'En retard · ' : (fu.done ? 'Fait · ' : '')) + escHtml(fu.note || 'Sans note') + (fu.createdBy ? ' · par ' + escHtml(fu.createdBy) : '') + (fu.calendarEventId ? ' · dans l’agenda' : '') + '</span></span>';
      h += '<button type="button" class="ll5pill" data-action="toggleFuDone" data-id="' + id + '" data-fu-idx="' + fu._idx + '">' + (fu.done ? 'Remettre' : ic('check') + 'Fait') + '</button>';
      h += '<button type="button" class="ll5ib" data-action="delFu" data-id="' + id + '" data-fu-idx="' + fu._idx + '" aria-label="Supprimer ce rappel">' + ic('x') + '</button></div>';
    });
    return h + '</div>';
  }
  function ecranRappel(l, id) {
    var h = '<h1 class="ll5h1">Quand rappeler ' + escHtml(prenom(l)) + ' ?</h1>';
    h += '<div class="ld-fu-section">' + listeRappels(l, id);
    h += '<div class="ll5gt">' + ((l.followUps || []).length ? 'Programmer un autre rappel' : 'Choisis un moment') + '</div><div class="ll5group">';
    CHOIX_RAPPEL.forEach(function (q) {
      h += '<button type="button" class="ll5line big" data-ll5="fuq" data-v="' + q[0] + '" data-id="' + id + '"><span class="ll5ric">' + ic('clock') + '</span><span class="ll5tx"><b>' + q[1] + '</b></span></button>';
    });
    h += '</div>';
    h += '<details class="ll5more" id="ll5FuMore"><summary class="ll5line big"><span class="ll5ric grey">' + ic('cal') + '</span><span class="ll5tx"><b>Choisir une date et une heure</b><span>Avec une durée et une note</span></span><span class="ll5chev">' + ic('chev') + '</span></summary>';
    h += '<div class="ll5form"><div class="ll5row2"><label>Date<input type="date" data-fu-field="date" data-id="' + id + '"/></label><label>Heure<input type="time" data-fu-field="time" data-id="' + id + '"/></label></div>';
    h += '<label>Durée<select data-fu-field="duration" data-id="' + id + '"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 h</option></select></label>';
    h += '<label>Pourquoi ? (facultatif)<textarea data-fu-field="note" data-id="' + id + '" rows="2" placeholder="ex. elle en parle à son associée"></textarea></label>';
    h += '<button type="button" class="ll5big pri" data-action="addFu" data-id="' + id + '">Programmer le rappel</button></div></details>';
    h += '<div class="ll5group ll5mt"><label class="ll5switch"><span>Ajouter à mon agenda</span><input type="checkbox" data-fu-field="pushCal" data-id="' + id + '" checked/><span class="ll5sw" aria-hidden="true"></span></label></div>';
    h += '</div>';
    return h;
  }

  /* RDV, closing */
  function compterRdv(id) {
    var AF = window.AlteoreFlow;
    try { return ldRdvItemsFor(id).filter(function (b) { return !AF || AF.classifyBooking(b, _ldTypeMap || {}) !== 'excluded'; }).length; } catch (e) { return 0; }
  }
  function ecranRdv(l, id) {
    var h = '<h1 class="ll5h1">Rendez-vous</h1>';
    h += '<div class="ld-rdv-block ll5rdv" data-rdv-block="' + id + '"><div class="ld-rdv-list" data-rdv-list="' + id + '"></div></div>';
    h += '<p class="ll5sub ll5rdvempty">Aucun rendez-vous avec ' + escHtml(prenom(l)) + ' pour l’instant.</p>';
    h += '<div class="ll5foot"><button type="button" class="ll5big pri" data-action="openBooking" data-id="' + id + '">' + ic('plus') + 'Prendre un RDV</button></div>';
    return h;
  }
  function ecranClosing(l, id) {
    var h = '<h1 class="ll5h1">Closing</h1><p class="ll5sub">Contrat, paiement, coach, RDV 72 h, groupe WhatsApp : les étapes s’enchaînent.</p>';
    h += '<div class="ld-rail-block ll5rail" data-close-rail="' + id + '"></div>';
    h += ldGroupeBlockHTML(l, id);
    if (!estClient(l)) h += '<div class="ll5group ll5mt"><button type="button" class="ll5line big" data-action="setStatus" data-id="' + id + '" data-status="client"><span class="ll5ric">' + ic('trophy') + '</span><span class="ll5tx"><b>Il a signé</b><span>Ouvrir les étapes du close</span></span><span class="ll5chev">' + ic('chev') + '</span></button></div>';
    h += '<div class="ll5group ll5mt">';
    h += ligne('sign', 'grey', 'Signatures', '', 'data-action="openModule" data-mod="sig" data-lead-id="' + escAttr(id) + '"');
    h += ligne('card', 'grey', 'Paiements', '', 'data-action="openModule" data-mod="pay" data-lead-id="' + escAttr(id) + '"');
    return h + '</div>';
  }

  /* Historique */
  function dateNote(s) {
    var m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\D+(\d{1,2}):(\d{2})/);
    if (!m) { var t = Date.parse(s); return isNaN(t) ? 0 : t; }
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
  }
  function ecranHistorique(l, id) {
    var items = [], vus = [];
    (l.communications || []).forEach(function (c) {
      if (!c || (c.type !== 'call' && c.type !== 'sms' && c.type !== 'email')) return;
      var t = c.date ? new Date(c.date).getTime() : 0;
      var sortant = !!c.ownerName || /^(out|sort)/.test(String(c.direction || '').toLowerCase());
      if (c.type === 'sms') {
        var k = String(c.content || '').replace(/^\s*message\s*:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
        for (var i = 0; i < vus.length; i++) if (vus[i].k === k && vus[i].s === sortant && Math.abs(vus[i].t - t) < 600000) return;
        vus.push({ k: k, s: sortant, t: t });
      }
      items.push({ t: t, c: c, sortant: sortant });
    });
    (l.notesHistory || []).forEach(function (n, i) { items.push({ t: dateNote(n.date), note: n, idx: i }); });
    items.sort(function (a, b) { return b.t - a.t; });

    var h = '<h1 class="ll5h1">Historique</h1><p class="ll5sub">Appels, SMS, e-mails et notes, du plus récent au plus ancien.</p>';
    h += '<div class="ll5group ll5mt">';
    if (l.telephone) h += ligne('wa', 'go', 'Conversation WhatsApp', sous('Messages et modèles'), 'data-ll5="go" data-v="c-wa"');
    h += ligne('mic', 'grey', 'Vocaux de l’équipe', sous('Avec transcription et résumé'), 'data-ll5="go" data-v="voice"');
    h += '</div>';
    if (!items.length) return h + '<p class="ll5sub ll5mt">Rien pour l’instant. Les appels Ringover, SMS et e-mails apparaîtront ici.</p>';
    var jour = '';
    items.forEach(function (it) {
      var d = it.t ? new Date(it.t) : null;
      var j = d ? majuscule(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })) : 'Date inconnue';
      if (j !== jour) { h += (jour ? '</div>' : '') + '<div class="ll5gt">' + escHtml(j) + '</div><div class="ll5group">'; jour = j; }
      var heure = d && !(it.c && ldDayOnlyDate(it.c.date)) ? hm(d) : '';
      if (it.note) {
        h += '<div class="ll5hist"><span class="ll5ric grey">' + ic('note') + '</span><span class="ll5tx"><b>Note' + (it.note.authorName ? ' de ' + escHtml(it.note.authorName) : '') + '</b><span class="q">' + highlightMentions(it.note.text || '') + '</span></span><span class="tm">' + heure + '</span></div>';
        return;
      }
      var c = it.c, titre, icone = 'msg', q = '', extra = '';
      if (c.type === 'call') {
        icone = 'phone';
        var dur = c.duration ? (Math.floor(c.duration / 60) ? Math.floor(c.duration / 60) + ' min ' + deux(c.duration % 60) : (c.duration % 60) + ' s') : '';
        titre = (it.sortant ? 'Appel' + (c.ownerName ? ' de ' + c.ownerName : '') : 'Appel reçu') + ' · ' + (dur || (it.sortant ? 'pas de réponse' : 'manqué'));
        if (c.callLogId) extra = '<button type="button" class="ll5pill" data-action="callDetail" data-cid="' + escAttr(c.callLogId) + '">Écouter, lire, analyse</button>';
      } else if (c.type === 'sms') {
        titre = it.sortant ? 'SMS envoyé' + (c.ownerName ? ' par ' + c.ownerName : '') : 'SMS reçu';
        q = sanitizeCommContent(c.content || '');
      } else {
        icone = 'mail';
        titre = it.sortant ? 'E-mail envoyé' + (c.ownerName ? ' par ' + c.ownerName : '') : 'E-mail reçu';
        q = escHtml(c.subject ? c.subject : String(c.content || '').split('\n')[0]);
      }
      h += '<div class="ll5hist"><span class="ll5ric ' + (it.sortant ? 'grey' : 'go') + '">' + ic(icone) + '</span><span class="ll5tx"><b>' + escHtml(titre) + '</b>' + (q ? '<span class="q">' + q + '</span>' : '') + extra + '</span><span class="tm">' + heure + '</span></div>';
    });
    return h + '</div>';
  }

  /* Notes, IA, qualité, infos, état, plus */
  function ecranNotes(l, id) {
    var notes = l.notesHistory || [];
    var h = '<h1 class="ll5h1">Notes</h1><p class="ll5sub">Visibles seulement par l’équipe.</p>';
    if (notes.length) {
      h += '<div class="ll5group ll5mt">';
      for (var ni = notes.length - 1; ni >= 0; ni--) {
        var n = notes[ni];
        h += '<div class="ll5hist"><span class="ll5tx"><span class="ll5meta">' + escHtml(n.date || '') + (n.authorName ? ' · ' + escHtml(n.authorName) : '') + '</span><span class="q plain">' + highlightMentions(n.text || '') + '</span></span>' +
          '<button type="button" class="ll5ib" data-action="delNote" data-id="' + id + '" data-note-idx="' + ni + '" aria-label="Supprimer la note">' + ic('x') + '</button></div>';
      }
      h += '</div>';
    }
    h += '<div class="ll5foot"><button type="button" class="ll5big pri" data-ll5="go" data-v="c-note">' + ic('plus') + 'Ajouter une note</button></div>';
    return h;
  }
  function ecranIa(l, id) { return '<h1 class="ll5h1">Conseil de l’IA</h1>' + l2AiBlockHTML(l, id); }
  function ecranQualite(l, id) {
    return '<h1 class="ll5h1">Qualité du lead</h1><p class="ll5sub">À remplir après l’avoir eu au téléphone. Touche la même note pour l’effacer.</p><div class="ll5group ll5mt ll5score">' + ldScoreBlockHTML(l, id) + '</div>';
  }
  var ancienInfos = null;
  function ecranInfos(l, id) {
    var html = ancienInfos(l, id);
    var cut = html.indexOf('<div class="ld-bl-title">');
    if (cut < 0) cut = html.indexOf('<button class="ld-delete-btn"');
    if (cut >= 0) {
      var avant = html.slice(0, cut), zone = html.slice(cut);
      html = avant + (estAdmin()
        ? '<details class="ll5danger"><summary>Zone sensible · admins</summary><div class="in">' + zone + '</div></details>'
        : '<p class="ll5note">Blacklist et suppression de fiche : réservées aux admins.</p>');
    }
    return '<h1 class="ll5h1">Infos et dossier</h1><div class="ll5infos">' + html + '</div>';
  }
  function grilleStatuts(l, id) {
    var h = '<div class="ld-status-grid">';
    for (var f = 0; f < L2_FAMILIES.length; f++) {
      var fam = L2_FAMILIES[f];
      h += '<div class="l2fam" data-fam="' + fam.l.toLowerCase() + '"><div class="ll5gt">' + fam.l + '</div><div class="ll5group">';
      for (var si = 0; si < fam.k.length; si++) {
        var s = getStatusObj(fam.k[si]);
        var act = (l.status || 'nouveau') === s.key;
        h += '<button class="ll5line' + (act ? ' active' : '') + '" data-action="setStatus" data-id="' + id + '" data-status="' + s.key + '"><span class="ll5tx"><b>' + escHtml(s.label) + '</b>' +
          (s.oldLabel && s.oldLabel !== s.label ? '<span>avant : ' + escHtml(s.oldLabel) + '</span>' : '') + '</span>' + (act ? '<span class="ll5reco">Actuel</span>' : '') + '</button>';
      }
      h += '</div></div>';
    }
    return h + '</div>';
  }
  function ecranEtat(l, id) { return '<h1 class="ll5h1">Changer l’état</h1><p class="ll5sub">Où en est ' + escHtml(prenom(l)) + ' ?</p>' + grilleStatuts(l, id); }
  function ecranPlus(l, id) {
    var mine = myIdentitySlug || personalUser;
    var h = '<h1 class="ll5h1">Plus</h1><div class="ll5group ll5mt">';
    h += ligne('flag', '', 'Noter le résultat d’un appel', sous('Il a répondu, pas de réponse…'), 'data-ll5="go" data-v="result"');
    h += ligne('flag', 'grey', 'Changer l’état à la main', sous('Les 17 états'), 'data-ll5="go" data-v="state"');
    h += ligne('trophy', '', 'Closing', sous('Contrat, paiement, coach'), 'data-ll5="go" data-v="closing"');
    h += '</div><div class="ll5group ll5mt">';
    if (mine && l.assignedTo !== mine) h += ligne('user', 'grey', 'M’attribuer ce lead', '', 'data-action="reassign" data-id="' + id + '"');
    h += '<a class="ll5line" href="sales-contact.html?id=' + encodeURIComponent(id) + '"><span class="ll5ric grey">' + ic('folder') + '</span><span class="ll5tx"><b>Fiche CRM complète</b></span><span class="ll5chev">' + ic('chev') + '</span></a>';
    h += ligne('mic', 'grey', 'Vocaux', '', 'data-ll5="go" data-v="voice"');
    h += ligne('copy', 'grey', 'Copier le numéro', l.telephone ? escHtml(normalizeTel(l.telephone)) : 'Aucun', l.telephone ? 'data-ll5="copy" data-v="' + escAttr(normalizeTel(l.telephone)) + '"' : 'disabled');
    return h + '</div>';
  }

  /* Résultat d'un appel (2 questions) */
  function ecranResultat(l, id) {
    var st = l.status || 'nouveau', suiv = NRP_SUIVANT[st] || 'nrp1';
    return '<h1 class="ll5h1">Comment ça s’est passé ?</h1><p class="ll5sub">Question 1 sur 2</p><div class="ll5group ll5mt">' +
      choixR('check', 'go', 'Il a répondu', '', 'data-ll5="r1" data-v="yes" data-id="' + id + '"') +
      choixR('phone', 'grey', 'Pas de réponse', 'Ce sera « ' + getStatusObj(suiv).label + ' »', 'data-ll5="r1" data-v="no" data-id="' + id + '"') +
      choixR('msg', 'grey', 'Messagerie', '', 'data-ll5="r1" data-v="vm" data-id="' + id + '"') +
      choixR('x', 'grey', 'Mauvais numéro', '', 'data-ll5="r1" data-v="bad" data-id="' + id + '"') + '</div>';
  }
  function ecranResultat2(l, id) {
    return '<h1 class="ll5h1">Qu’est-ce qu’il veut ?</h1><p class="ll5sub">Question 2 sur 2</p><div class="ll5group ll5mt">' +
      choixR('cal', 'go', 'Un rendez-vous', 'L’agenda s’ouvre', 'data-ll5="r2" data-v="rdv" data-id="' + id + '"') +
      choixR('clock', '', 'Être rappelé', 'Tu choisis quand', 'data-ll5="r2" data-v="fu" data-id="' + id + '"') +
      choixR('msg', 'grey', 'Rien de décidé', 'On a juste parlé', 'data-ll5="r2" data-v="talk" data-id="' + id + '"') +
      choixR('x', 'grey', 'Pas intéressé', '', 'data-ll5="r2" data-v="no" data-id="' + id + '"') +
      choixR('x', 'grey', 'Pas pour nous', 'Hors cible', 'data-ll5="r2" data-v="dq" data-id="' + id + '"') +
      choixR('trophy', '', 'Il a signé', 'Les étapes du close s’ouvrent', 'data-ll5="r2" data-v="win" data-id="' + id + '"') + '</div>';
  }
  var appelTermine = false;
  function ecranEnAppel(l, id) {
    var a = l.aiLead || {};
    var bits = [l.secteur, l.ca, l.defi].filter(function (x) { return x && String(x).trim(); });
    var h = '<h1 class="ll5h1">' + (appelTermine ? 'Appel terminé' : 'En appel avec ' + escHtml(prenom(l))) + '</h1>';
    h += '<p class="ll5sub">' + escHtml(l.nom || '') + (l.telephone ? ' · ' + escHtml(normalizeTel(l.telephone)) : '') + '</p>';
    if (a.ouverture && !appelTermine) h += '<div class="ll5group ll5mt ll5incall"><div class="ll5para"><small>Pour commencer, dis</small>« ' + escHtml(a.ouverture) + ' »</div>' + (bits.length ? '<div class="ll5para"><small>À savoir</small>' + escHtml(bits.join(' · ')) + '</div>' : '') + '</div>';
    else if (bits.length && !appelTermine) h += '<div class="ll5group ll5mt ll5incall"><div class="ll5para"><small>À savoir</small>' + escHtml(bits.join(' · ')) + '</div></div>';
    h += '<div class="ll5gt">' + (appelTermine ? 'Il a répondu ?' : 'Il a décroché') + '</div><div class="ll5group">';
    h += choixR('cal', 'go', 'Il veut un rendez-vous', 'L’agenda s’ouvre, l’appel continue', 'data-ll5="r2" data-v="rdv" data-id="' + id + '"');
    h += choixR('clock', '', 'Il veut être rappelé', 'Tu choisis quand', 'data-ll5="r2" data-v="fu" data-id="' + id + '"');
    h += choixR('msg', 'grey', 'Rien de décidé', 'On a juste parlé', 'data-ll5="r2" data-v="talk" data-id="' + id + '"');
    h += choixR('x', 'grey', 'Pas intéressé', '', 'data-ll5="r2" data-v="no" data-id="' + id + '"');
    h += choixR('x', 'grey', 'Pas pour nous', 'Hors cible', 'data-ll5="r2" data-v="dq" data-id="' + id + '"');
    h += choixR('trophy', '', 'Il a signé', 'Les étapes du close s’ouvrent', 'data-ll5="r2" data-v="win" data-id="' + id + '"');
    h += '</div><div class="ll5gt">Il n’a pas décroché</div><div class="ll5group">';
    var suiv = NRP_SUIVANT[l.status || 'nouveau'] || 'nrp1';
    h += choixR('phone', 'grey', 'Pas de réponse', 'Ce sera « ' + getStatusObj(suiv).label + ' »', 'data-ll5="r1" data-v="no" data-id="' + id + '"');
    h += choixR('msg', 'grey', 'Messagerie', '', 'data-ll5="r1" data-v="vm" data-id="' + id + '"');
    h += choixR('x', 'grey', 'Mauvais numéro', '', 'data-ll5="r1" data-v="bad" data-id="' + id + '"');
    h += '</div>';
    return h;
  }
  var infoRappel = '';
  function ecranRappelApres(l, id) {
    var h = '<h1 class="ll5h1">Quand le rappeler ?</h1>' + (infoRappel ? '<p class="ll5ok">' + ic('check') + escHtml(infoRappel) + '</p>' : '') + '<div class="ll5group ll5mt">';
    CHOIX_RAPPEL.forEach(function (q) {
      h += '<button type="button" class="ll5line big" data-ll5="fuask" data-v="' + q[0] + '" data-id="' + id + '"><span class="ll5ric">' + ic('clock') + '</span><span class="ll5tx"><b>' + q[1] + '</b></span></button>';
    });
    var dem = new Date(); dem.setDate(dem.getDate() + 1);
    h += '</div><details class="ll5more ll5mt" id="ll5AskMore"><summary class="ll5line big"><span class="ll5ric">' + ic('cal') + '</span><span class="ll5tx"><b>Personnalisé</b><span>Choisis le jour et l’heure</span></span><span class="ll5chev">' + ic('chev') + '</span></summary>';
    h += '<div class="ll5form"><div class="ll5row2"><label>Date<input type="date" id="ll5AskDate" min="' + ymd(new Date()) + '" value="' + ymd(dem) + '"/></label><label>Heure<input type="time" id="ll5AskTime" step="300" value="10:00"/></label></div>';
    h += '<label>Durée<select id="ll5AskDur"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 h</option></select></label>';
    h += '<label>Pourquoi ? (facultatif)<textarea id="ll5AskNote" rows="2" placeholder="ex. il en parle à son associé"></textarea></label>';
    h += '<button type="button" class="ll5big pri" data-ll5="fuperso" data-id="' + id + '">Programmer le rappel</button></div></details>';
    h += '<div class="ll5group ll5mt"><label class="ll5switch"><span>Ajouter à mon agenda</span><input type="checkbox" id="ll5AskCal" checked/><span class="ll5sw" aria-hidden="true"></span></label></div>';
    h += '<div class="ll5foot"><button type="button" class="ll5big soft" data-ll5="home">Pas de rappel</button></div>';
    return h;
  }
  function choixR(icon, cls, titre, sousTitre, attrs) {
    return '<button type="button" class="ll5line big" ' + attrs + '><span class="ll5ric ' + cls + '">' + ic(icon) + '</span><span class="ll5tx"><b>' + escHtml(titre) + '</b>' + (sousTitre ? '<span>' + escHtml(sousTitre) + '</span>' : '') + '</span></button>';
  }

  var ECRANS = {
    lead: ecranLead, write: ecranEcrire, 'c-sms': ecranSms, 'c-wa': ecranWa, 'c-mail': ecranMail, 'c-note': ecranNoteCompose, voice: ecranVocaux,
    fu: ecranRappel, rdv: ecranRdv, closing: ecranClosing, hist: ecranHistorique, notes: ecranNotes, ai: ecranIa, stars: ecranQualite,
    info: ecranInfos, state: ecranEtat, more: ecranPlus, result: ecranResultat, result2: ecranResultat2, fuask: ecranRappelApres, incall: ecranEnAppel
  };

  /* Assemblage (remplace l2RenderSheet) */
  function rendreFiche(id, preserve) {
    var sheet = l2El('ldSheet'), inner = l2El('ldSheetInner');
    if (!sheet || !inner) return;
    var l = leadDe(id);
    if (!l) { l2CloseSheet(); return; }
    if (pileLead !== id) { pileLead = id; pile = ['lead']; preserve = false; anime = false; }
    var e = ecran();
    if (!ECRANS[e]) { pile = ['lead']; e = 'lead'; }
    var memeEcran = inner.getAttribute('data-ll5-ecran') === e + '|' + id;
    var drafts = (preserve && memeEcran) ? l2CaptureDrafts(inner) : null;
    var scroller = inner.querySelector('.ll5scroll');
    var pos = (preserve && memeEcran && scroller) ? scroller.scrollTop : 0;

    var oldVn = inner.querySelector('.vn-container');
    if (oldVn && window.VoiceNotes) { try { window.VoiceNotes.detach(oldVn); } catch (er) {} }

    var corps = '';
    try { corps = ECRANS[e](l, id); }
    catch (eSeg) {
      console.error('[fiche v5] écran ' + e, id, eSeg);
      corps = '<p class="ll5note">Cet écran n’a pas pu s’afficher. ' + escHtml(String((eSeg && eSeg.message) || eSeg)) + '</p>';
    }
    inner.innerHTML = '<div class="ll5screen' + (anime ? ' enter' : '') + '">' + barre(l, e) +
      '<div class="ll5scroll"><div class="l2body ld-card ll5wrap" data-lead-id="' + id + '">' + corps + '</div></div></div>';
    inner.setAttribute('data-ll5-ecran', e + '|' + id);
    anime = false;
    if (e === 'lead' && !tutoVu('fiche')) setTimeout(function () { lancerTuto('fiche', false); }, 700);
    sheet.classList.add('has-lead');

    if (drafts) l2RestoreDrafts(inner, drafts, id);
    var sc = inner.querySelector('.ll5scroll');
    if (sc) sc.scrollTop = pos;

    if (e === 'ai') { try { l2AiEnsure(l); } catch (eAi) { console.warn('[IA] score', eAi); } }
    peinture = true;
    try {
      attachLeadRdvListener(id);
      paintLeadRdvBox(id, ldRdvItemsFor(id));
      ldRdvItemsFor(id).forEach(slCatchUpLeadId);
    } catch (eRdv) { console.error('[fiche v5] RDV', id, eRdv); }
    try {
      attachLeadDealListeners(id);
      paintCloseRail(id);
    } catch (eDeal) { console.error('[fiche v5] close', id, eDeal); }
    peinture = false;
    signatureRdv[id] = sigRdv(l);

    if (e === 'voice' && window.VoiceNotes) {
      var mount = inner.querySelector('[data-vn-mount="' + id + '"]');
      if (mount) window.VoiceNotes.attach(mount, id, getCurrentVoiceUser());
    }
    if (e === 'c-wa' && window.WhatsAppLead) {
      var wam = inner.querySelector('[data-wal-mount="' + id + '"]');
      var u = moi();
      if (wam) window.WhatsAppLead.attach(wam, id, l.telephone, { nom: l.nom || '', assignedTo: l.assignedTo || '', moiNom: (u && u.name) || '' });
    } else if (window.WhatsAppLead) {
      try { window.WhatsAppLead.detach(id); } catch (er2) {}
    }
    if (e === 'lead') chargerWa(l);
  }

  /* Présence / RDV : repeindre l'accueil du lead quand ses RDV changent. */
  var signatureRdv = {};
  function sigRdv(l) { return rdvAVenir(l).map(function (b) { return b.id + (b.presenceConfirmed ? '+' : '-'); }).join(','); }

  /* Dernier message WhatsApp du lead (pour « X t'a écrit »). */
  function chargerWa(l) {
    var id = l.id;
    var c = waCache[id];
    if (c && Date.now() - c.lu < 60000) return;
    var num = String(l.telephone || '').replace(/\D/g, '');
    if (num.indexOf('0') === 0 && num.length === 10) num = '33' + num.slice(1);
    if (!num) return;
    waCache[id] = { lu: Date.now() };
    try {
      db.collection('whatsapp_conversations').doc(num).get().then(function (s) {
        var d = s.exists ? (s.data() || {}) : {};
        var dm = d.dernierMessage || null;
        var res = { lu: Date.now() };
        if (dm && dm.sens === 'in') {
          res.dernierIn = true;
          res.texte = String(dm.texte || '').slice(0, 220);
          res.quand = dm.at ? timeAgo(new Date(dm.at)) : '';
        }
        var avant = JSON.stringify(waCache[id] && waCache[id].texte);
        waCache[id] = res;
        if (openCardId === id && ecran() === 'lead' && JSON.stringify(res.texte) !== avant) l2RenderSheet(id, true);
      }).catch(function () { /* droits ou réseau : on n'affiche simplement rien */ });
    } catch (e) {}
  }

  /* ═══ Écritures via les vrais boutons (carte fantôme) ════════════════ */
  function fantome() {
    var g = document.getElementById('ll3Ghost');
    if (!g) {
      g = document.createElement('div');
      g.id = 'll3Ghost';
      g.className = 'ld-card';
      g.hidden = true;
      g.setAttribute('aria-hidden', 'true');
      document.body.appendChild(g);
    }
    return g;
  }
  function poserStatut(id, st) {
    var g = fantome(), s = getStatusObj(st);
    g.innerHTML = '<button type="button" class="ld-status-btn" data-action="setStatus" data-id="' + escAttr(id) + '" data-status="' + st + '">' + escHtml(s.label) + '</button>';
    g.firstChild.click();
  }
  function programmerRappel(id, ms, agenda, note, duree) {
    var d = new Date(ms), g = fantome(), avant = openCardId, ecr = pile.slice(), dur = String(duree || 30);
    g.innerHTML = '<input data-fu-field="date" value="' + ymd(d) + '"/><input data-fu-field="time" value="' + hm(d) + '"/>' +
      '<textarea data-fu-field="note"></textarea><select data-fu-field="duration"><option value="' + escAttr(dur) + '" selected>' + escHtml(dur) + '</option></select>' +
      '<input type="checkbox" data-fu-field="pushCal"' + (agenda ? ' checked' : '') + '/>' +
      '<button type="button" data-action="addFu" data-id="' + escAttr(id) + '">Programmer le rappel</button>';
    if (note) g.querySelector('[data-fu-field="note"]').value = note;
    g.querySelector('[data-action="addFu"]').click();
    if (avant !== id) {
      if (!avant) { l2CloseSheet(); renderFeed(); }
      else { try { l2DetachSheetModules(id); } catch (e) {} openCardId = avant; pileLead = avant; pile = ecr; renderFeed(); }
    }
  }
  function reponse1(id, v) {
    var l = leadDe(id);
    if (!l) return;
    var st = l.status || 'nouveau';
    if (v === 'yes') { aller('result2'); return; }
    if (v === 'no') { var n = NRP_SUIVANT[st] || 'nrp1'; poserStatut(id, n); infoRappel = getStatusObj(n).label; pile = ['lead', 'fuask']; anime = true; l2RenderSheet(id, false); return; }
    if (v === 'vm') { poserStatut(id, 'messagerie'); infoRappel = 'Messagerie'; pile = ['lead', 'fuask']; anime = true; l2RenderSheet(id, false); return; }
    if (v === 'bad') { poserStatut(id, 'faux_numero'); accueilLead(); }
  }
  function reponse2(id, v) {
    var l = leadDe(id);
    if (!l) return;
    if (v === 'rdv') { accueilLead(); if (typeof openBookingModal === 'function') openBookingModal(l); return; }
    if (v === 'fu') { poserStatut(id, 'follow_up_pm'); infoRappel = 'Rappel convenu'; pile = ['lead', 'fuask']; anime = true; l2RenderSheet(id, false); return; }
    var map = { talk: 'decroche', no: 'pas_interesse', dq: 'disqualifie', win: 'client' };
    accueilLead();
    if (map[v]) poserStatut(id, map[v]);
  }

  /* Question automatique à la fin d'un appel lancé depuis Leads Live. Les
     sessions Power / vagues ne passent pas par ces boutons. */
  var appelEnCours = null;
  function noterAppel(e) {
    var d = e.target.closest && e.target.closest('[data-action="dialerCall"], .dbr-call-btn');
    if (!d) return;
    var lid = d.getAttribute('data-lead-id');
    if (!lid) { var c = d.closest('.ld-card'); lid = c && c.getAttribute('data-lead-id'); }
    if (!lid) return;
    appelEnCours = { id: lid, t: Date.now() };
    appelTermine = false;
    setTimeout(function () {
      if (openCardId !== lid) l2OpenLead(lid);
      pile = ['lead', 'incall'];
      anime = true;
      l2RenderSheet(lid, false);
    }, 80);
  }
  window.addEventListener('message', function (evt) {
    if (!on || evt.origin !== window.location.origin) return;
    var data = evt.data;
    if (!data || data.type !== 'dialer:call-ended' || !appelEnCours) return;
    if (Date.now() - appelEnCours.t > 3 * 3600000) { appelEnCours = null; return; }
    if (data.leadId && data.leadId !== appelEnCours.id) return;
    var id = appelEnCours.id;
    appelEnCours = null;
    appelTermine = true;
    setTimeout(function () {
      if (openCardId === id && ecran() === 'incall') l2RenderSheet(id, true);
    }, 300);
  });

  /* ═══ Écouteurs ══════════════════════════════════════════════════════ */
  var noteAvant = '';
  document.addEventListener('click', function (e) {
    if (!on) return;
    noterAppel(e);
    var an = e.target.closest && e.target.closest('[data-action="addNote"]');
    if (an) { var tn = document.querySelector('#ldSheetInner [data-field="newNote"]'); noteAvant = tn ? tn.value.trim() : ''; }
    var sens = e.target.closest && e.target.closest('[data-action="deleteLead"],[data-action="blockLead"],[data-action="unblockLead"]');
    if (sens && !estAdmin()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast('🔒 Réservé aux admins');
    }
  }, true);

  document.addEventListener('click', function (e) {
    if (!on) return;
    /* Après les gestionnaires historiques : revenir au bon écran. */
    var hist = e.target.closest && e.target.closest('[data-action]');
    if (hist && !hist.closest('#ll3Ghost')) {
      var act = hist.getAttribute('data-action');
      if (act === 'addNote' && ecran() === 'c-note' && noteAvant) { noteAvant = ''; setTimeout(function () { pile = ['lead', 'notes']; anime = true; if (openCardId) l2RenderSheet(openCardId, false); }, 60); }
      if (act === 'setStatus' && ecran() === 'state' && hist.getAttribute('data-status') !== 'client') setTimeout(function () { accueilLead(); }, 60);
      if (act === 'addFu' && ecran() === 'fu') setTimeout(function () { accueilLead(); }, 120);
    }
    var t = e.target.closest ? e.target.closest('[data-ll5]') : null;
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-ll5'), id = t.getAttribute('data-id') || openCardId, v = t.getAttribute('data-v');
    switch (a) {
      case 'open': l2OpenLead(id); return;
      case 'go': aller(v); return;
      case 'back': retour(); return;
      case 'home': accueilLead(); return;
      case 'list':
        liste = v;
        try { localStorage.setItem(LIST_KEY, v); } catch (e2) {}
        renderFeed();
        return;
      case 'rdvkind': rdvSorte = v; renderFeed(); return;
      case 'filters': l2OpenFilters(); return;
      case 'search': recherche = true; renderFeed(); var q = l2El('ll5Q'); if (q) q.focus(); return;
      case 'searchoff': recherche = false; filterSearch = ''; var si = l2El('ldSearchInput'); if (si) si.value = ''; renderFeed(); return;
      case 'new': if (typeof openCreateLead === 'function') openCreateLead(); return;
      case 'agenda': if (typeof ldAgOpen === 'function') ldAgOpen(); return;
      case 'theme':
        try { localStorage.setItem(THEME_KEY, document.body.classList.contains('light-theme') ? 'dark' : 'light'); } catch (e7) {}
        appliquerTheme();
        renderFeed();
        return;
      case 'menu': e.stopPropagation(); var m = l2El('l2Menu'); if (m) m.classList.toggle('on'); return;
      case 'serie':
        serie = !serie;
        document.body.classList.toggle('ll5-serie', serie);
        var mm = l2El('l2Menu'); if (mm) mm.classList.remove('on');
        if (!serie && window.DialerBridge && window.DialerBridge.clearSelection) { try { window.DialerBridge.clearSelection(); } catch (e3) {} }
        renderFeed();
        if (serie) toast('Coche jusqu’à 5 leads, puis lance les appels en bas');
        return;
      case 'tuto':
        var mt = l2El('l2Menu'); if (mt) mt.classList.remove('on');
        if (openCardId && typeof l2CloseSheet === 'function' && l2IsMobile()) l2CloseSheet();
        lancerTuto('liste', true);
        return;
      case 'oldui':
        try { localStorage.setItem(FORCE_KEY, '0'); } catch (e4) {}
        var u = new URL(window.location.href);
        u.searchParams.delete('v3');
        window.location.href = u.pathname + (u.search ? u.search : '');
        return;
      case 'copy':
        var ok = function () { toast('Copié'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(ok, function () { toast(v); });
        else toast(v);
        return;
      case 'r1': reponse1(id, v); return;
      case 'r2': reponse2(id, v); return;
      case 'fuask':
        var cal = l2El('ll5AskCal');
        programmerRappel(id, heureRapide(v), cal ? cal.checked : true);
        accueilLead();
        return;
      case 'fuperso':
        var pd = l2El('ll5AskDate'), pt = l2El('ll5AskTime'), pc = l2El('ll5AskCal'), pn = l2El('ll5AskNote'), pu = l2El('ll5AskDur');
        if (!pd || !pd.value || !pt || !pt.value) { toast('Choisis une date et une heure'); return; }
        var pms = new Date(pd.value + 'T' + pt.value).getTime();
        if (isNaN(pms)) { toast('Date ou heure invalide'); return; }
        if (pms <= Date.now()) { toast('Choisis un moment à venir'); return; }
        programmerRappel(id, pms, pc ? pc.checked : true, pn ? pn.value.trim() : '', pu ? pu.value : 30);
        accueilLead();
        return;
      case 'fuq':
        var body = document.querySelector('#ldSheetInner .l2body[data-lead-id="' + id + '"]');
        if (!body) return;
        var d = new Date(heureRapide(v));
        var fd = body.querySelector('[data-fu-field="date"]'), ft = body.querySelector('[data-fu-field="time"]');
        var go = body.querySelector('[data-action="addFu"][data-id="' + id + '"]');
        if (!fd || !ft || !go) return;
        fd.value = ymd(d); ft.value = hm(d);
        go.click();
        setTimeout(function () { accueilLead(); }, 150);
        return;
      case 'mention':
        var nt = document.querySelector('#ldSheetInner [data-field="newNote"]');
        if (nt) { nt.value = (nt.value && !/\s$/.test(nt.value) ? nt.value + ' ' : nt.value) + '@' + v + ' '; nt.focus(); }
        return;
      case 'mailai':
        var st = mailEtat[id] = mailEtat[id] || {};
        capterMail(id);
        if (st.busy) return;
        st.busy = true; st.err = null; l2RenderSheet(id, true);
        l2AiPost({ leadId: id, channel: 'sms', context: '' }).then(function (j) {
          st.busy = false;
          if (j.email) { st.objet = j.email.objet || st.objet; st.corps = j.email.corps || st.corps; }
          l2RenderSheet(id, true);
        }).catch(function (er) { st.busy = false; st.err = er.message; l2RenderSheet(id, true); });
        return;
      case 'mailsend':
        var ms = mailEtat[id] = mailEtat[id] || {};
        capterMail(id);
        if (!ms.corps || !ms.corps.trim()) { toast('Écris d’abord ton e-mail'); return; }
        if (ms.sending) return;
        ms.sending = true; l2RenderSheet(id, true);
        l2AiPost({ action: 'sendEmail', leadId: id, subject: ms.objet || '', body: ms.corps })
          .then(function () { delete mailEtat[id]; accueilLead('✅ E-mail envoyé et tracé dans l’historique'); })
          .catch(function (er) { ms.sending = false; ms.err = er.message; l2RenderSheet(id, true); });
        return;
    }
  });
  function capterMail(id) {
    var st = mailEtat[id] = mailEtat[id] || {};
    var s = l2El('ll5MailSubj'), b = l2El('ll5MailBody');
    if (s) st.objet = s.value;
    if (b) st.corps = b.value;
  }
  document.addEventListener('input', function (e) {
    if (!on || !e.target) return;
    if (e.target.id === 'll5Q') { filterSearch = e.target.value.trim(); renderFeed(); }
    if (e.target.id === 'll5MailSubj' || e.target.id === 'll5MailBody') capterMail(openCardId);
  });
  document.addEventListener('keydown', function (e) {
    if (!on) return;
    if (e.key === 'Escape' && openCardId && pile.length > 1 && !document.querySelector('.l2fs.on, .ldpres.on, #rvoBg.on, .cw-bg.show, #ldFrameBg.show')) { e.stopImmediatePropagation(); retour(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ld-card-head') && !e.target.closest('.l2side')) {
      e.preventDefault();
      var c = e.target.closest('.ld-card');
      if (c && c.getAttribute('data-lead-id')) l2OpenLead(c.getAttribute('data-lead-id'));
    }
  }, true);

  /* ═══ Thème : clair par défaut (demande Adrien 17/10), bascule mémorisée ═══ */
  function themeVoulu() { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; } }
  function appliquerTheme() { if (on) document.body.classList.toggle('light-theme', themeVoulu() === 'light'); }
  document.addEventListener('click', function (e) {
    if (!on || !e.target.closest || !e.target.closest('#navThemeToggle')) return;
    setTimeout(function () { try { localStorage.setItem(THEME_KEY, document.body.classList.contains('light-theme') ? 'light' : 'dark'); } catch (er) {} }, 50);
  });

  /* ═══ Éléments fixes de la page ══════════════════════════════════════ */
  function habillerPage() {
    var menu = l2El('l2Menu');
    if (menu && !l2El('ll5Serie')) {
      var panel = l2El('sharePanel');
      var sb = document.createElement('button');
      sb.className = 'l2mi'; sb.id = 'll5Serie'; sb.type = 'button';
      sb.setAttribute('data-ll5', 'serie');
      sb.innerHTML = '📞 <span>Appeler plusieurs leads à la suite</span>';
      menu.insertBefore(sb, panel || null);
      var tb = document.createElement('button');
      tb.className = 'l2mi'; tb.id = 'll5Theme'; tb.type = 'button';
      tb.innerHTML = '🌗 <span>Thème clair / sombre</span>';
      tb.addEventListener('click', function () {
        var clair = !document.body.classList.contains('light-theme');
        try { localStorage.setItem(THEME_KEY, clair ? 'light' : 'dark'); } catch (er) {}
        appliquerTheme();
        renderFeed();
      });
      menu.insertBefore(tb, panel || null);
      var ob = document.createElement('button');
      ob.className = 'l2mi'; ob.id = 'll3Old'; ob.type = 'button';
      ob.setAttribute('data-ll5', 'oldui');
      ob.innerHTML = '↩️ <span>Revenir à l’ancienne version</span>';
      menu.insertBefore(ob, panel || null);
      var gb = document.createElement('button');
      gb.className = 'l2mi'; gb.id = 'll5Tuto'; gb.type = 'button';
      gb.setAttribute('data-ll5', 'tuto');
      gb.innerHTML = '🎓 <span>Revoir le guide</span>';
      menu.insertBefore(gb, ob);
    }
    var ap = l2El('l2fsApply');
    if (ap) ap.textContent = 'Fermer';
    document.querySelectorAll('#ldFilters .ld-filter[data-status]').forEach(function (b) {
      var k = b.getAttribute('data-status');
      if (k === 'all') return;
      var s = getStatusObj(k);
      b.textContent = s.label;
    });
    var lbls = document.querySelectorAll('#l2fs .l2fs-l');
    var noms = { 'Attribution': 'Qui s’en occupe', 'Période': 'Arrivés quand', 'Tunnel': 'Par quel tunnel', 'Statut': 'Où il en est' };
    for (var i = 0; i < lbls.length; i++) { var tx = lbls[i].textContent.trim(); if (noms[tx]) lbls[i].textContent = noms[tx]; }
    if (typeof window.updatePushBtn === 'function' && !window.updatePushBtn._ll3) {
      var orig = window.updatePushBtn;
      window.updatePushBtn = function (state) {
        orig(state);
        var btn = l2El('pushBtn');
        if (!btn) return;
        var txt = { granted: 'Notifications activées', active: 'Notifications activées', denied: 'Notifications bloquées', loading: 'Activation…', error: 'Notifications indisponibles' }[state] || 'Activer les notifications';
        if (!btn.querySelector('span')) btn.innerHTML = btn.innerHTML + ' <span>' + txt + '</span>';
      };
      window.updatePushBtn._ll3 = true;
      try { window.updatePushBtn(('Notification' in window && Notification.permission === 'granted') ? 'granted' : (('Notification' in window) ? 'default' : 'error')); } catch (e5) {}
    }
    /* La pastille « mes RDV restants » vit dans l'en-tête historique (masqué) : on la recopie. */
    var src = l2El('l2AgCount');
    if (src && window.MutationObserver) { try { new MutationObserver(peindreAgenda).observe(src, { childList: true, characterData: true, subtree: true }); } catch (e6) {} }
    brancherModules();
  }
  /* Les modules chargés en `defer` (SalesDialerAPI…) arrivent après ce fichier :
     on les branche dès qu'ils existent. */
  function brancherModules() {
    if (!on) return;
    /* Après un SMS envoyé, retour à l'accueil du lead. */
    if (window.SalesDialerAPI && window.SalesDialerAPI.sendSms && !window.SalesDialerAPI.sendSms._ll5) {
      var envoi = window.SalesDialerAPI.sendSms;
      window.SalesDialerAPI.sendSms = function (o) {
        return envoi.apply(this, arguments).then(function (r) {
          if (on && openCardId && ecran() === 'c-sms') setTimeout(function () { accueilLead(); }, 200);
          return r;
        });
      };
      window.SalesDialerAPI.sendSms._ll5 = true;
    }
    /* Les RDV arrivent en temps réel : repeindre l'accueil du lead si leur état change. */
    if (typeof window.paintLeadRdvBox === 'function' && !window.paintLeadRdvBox._ll5) {
      var peindre = window.paintLeadRdvBox;
      window.paintLeadRdvBox = function (leadId, items) {
        peindre(leadId, items);
        if (!on) return;
        var p = document.querySelector('#ldSheetInner .ll5rdvempty');
        if (p) p.style.display = document.querySelector('#ldSheetInner .ld-rdv-block.has-rdv') ? 'none' : '';
        if (peinture || leadId !== openCardId) return;
        var l = leadDe(leadId);
        if (!l) return;
        var sg = sigRdv(l);
        if (sg !== signatureRdv[leadId] && (ecran() === 'lead' || ecran() === 'rdv')) { signatureRdv[leadId] = sg; l2RenderSheet(leadId, true); }
      };
      window.paintLeadRdvBox._ll5 = true;
    }
  }

  /* ═══ Activation ═════════════════════════════════════════════════════ */
  function activer() {
    if (on) return;
    on = true;
    document.body.classList.add('ll3', 'll5');
    patcherStatuts();
    /* L'en-tête historique est masqué : ses identifiants passent à la nouvelle liste. */
    ['l2Triage', 'l2FiltersBtn', 'l2SortBtn'].forEach(function (k) { var o = l2El(k); if (o) o.id = k + 'Ancien'; });
    ancienInfos = window.l2SegInfos;
    window.renderFeed = rendreFile;
    window.renderCard = ligneLead;
    window.l2RenderTriage = function () {};
    window.l2RenderSheet = rendreFiche;
    window.l2SegInfos = function (l, id) { return ecranInfos(l, id); };
    window.l2IsMobile = function () { return window.matchMedia('(max-width: 719px)').matches; };
    habillerPage();
    appliquerTheme();
    setTimeout(appliquerTheme, 400);
    setTimeout(appliquerTheme, 1500);
    if (typeof allLeads !== 'undefined' && allLeads && allLeads.length) renderFeed();
    retirerInvitation();
    setTimeout(function () { lancerTuto('liste', false); }, 1200);
  }

  /* ═══ Guide de première visite (17/10/2026) ══════════════════════════
     Deux temps : la liste à l'arrivée, puis la fiche au premier lead ouvert.
     Mémorisé sur l'appareil ; le bac à sable a son propre stockage (préfixe
     sbxll:), donc le guide s'y montre aussi une fois. */
  var tutoAttente = {};
  function tutoVu(k) { try { return localStorage.getItem(TUTO_KEY + ':' + k) === '1'; } catch (e) { return true; } }
  function tutoMarquer(k) { try { localStorage.setItem(TUTO_KEY + ':' + k, '1'); } catch (e) {} }
  function voit(sel) {
    var n = document.querySelector(sel);
    if (!n || !n.getClientRects || !n.getClientRects().length) return false;
    var r = n.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  function etapesListe() {
    var F = '#ldFeed ', s = [];
    s.push({ text: 'Bienvenue dans la **nouvelle version de Leads Live** 👋 En une minute, je te montre où tout se trouve. Touche « Suivant » pour avancer, ✕ pour arrêter.' });
    if (voit(F + '.ll5hero')) s.push({ sel: F + '.ll5hero', text: '**À faire en premier** : le lead le plus urgent du moment (rappel en retard, présence à confirmer, nouveau lead…), avec le bouton pour agir tout de suite.' });
    s.push({ sel: F + '.ll5tabs', text: 'Tes **4 listes** : « À faire » (ce qui t’attend maintenant), « À rappeler » (pas joignables et rappels programmés), « RDV » et « Tous » (toutes les arrivées). Le chiffre = le nombre de leads dedans.' });
    s.push({ sel: F + '#l2FiltersBtn', text: 'Les **Filtres** : qui s’en occupe, arrivés quand, par quel tunnel, où il en est.' });
    s.push({ sel: F + '[data-ll5="agenda"]', text: '**Mes RDV du jour** : ton agenda. La pastille donne le nombre de RDV qui restent aujourd’hui.' });
    s.push({ sel: F + '[data-ll5="search"]', text: '**Rechercher** un lead par nom, téléphone, e-mail ou secteur, parmi tous les leads.' });
    s.push({ sel: F + '[data-ll5="new"]', text: '**Créer une fiche** à la main (quelqu’un qui t’appelle, un contact Instagram…).' });
    s.push({ sel: F + '.ll5me', text: 'Le **menu** (ton initiale) : notifications, appeler plusieurs leads à la suite, thème clair / sombre, « Revoir le guide » et « Revenir à l’ancienne version ».' });
    if (voit(F + '.ll5card')) s.push({ sel: F + '.ll5card', text: 'Touche un lead pour **ouvrir sa fiche** : la suite du guide t’y attend.' });
    else s.push({ text: 'C’est tout pour la liste ! Ouvre un lead : la suite du guide t’attend dans sa fiche.' });
    return s;
  }
  function etapesFiche() {
    var S = '#ldSheetInner ', s = [];
    s.push({ sel: S + '.ll5status', text: 'Voici la **fiche du lead**. En haut : où il en est et ce qui s’est passé en dernier.' });
    if (voit(S + '.ll5big')) s.push({ sel: S + '.ll5big', text: 'Le **gros bouton** = la prochaine chose à faire pour ce lead : l’appeler, confirmer sa présence, préparer le RDV, répondre sur WhatsApp… Il change tout seul selon la situation.' });
    s.push({ sel: S + '.ll5acts', text: 'Toutes les actions à portée de main : **Appeler**, **Écrire** (SMS, WhatsApp, e-mail, vocal, note pour l’équipe), programmer un **Rappel**, poser un **RDV**, et **Plus** (changer l’état, résultat d’un appel, closing…).' });
    s.push({ text: 'Quand tu appelles, la fiche passe sur l’écran **« En appel »** : tu y notes comment ça s’est passé (a répondu, pas de réponse…) ou tu poses le RDV en deux touches. Le statut, le rappel et l’historique suivent tout seuls.' });
    if (voit(S + '[data-close-rail]')) s.push({ sel: S + '[data-close-rail]', text: 'Le **pilote de closing** : quand c’est OK pour le closing, il te guide carte par carte (contrat, paiement, RDV 72 h…).' });
    s.push({ sel: S + '.ll5group', text: 'Tout ce qu’on sait sur le lead : **conseil de l’IA**, historique, RDV, rappels, notes, qualité du lead et son dossier. Touche une ligne pour l’ouvrir.' });
    s.push({ sel: S + '.ll5bar .ll5ib', text: 'La **flèche** ramène à la liste (ou à l’écran précédent). C’est parti ! Tu peux revoir ce guide à tout moment depuis le menu.' });
    return s;
  }
  function lancerTuto(k, force) {
    if (!on || tutoAttente[k]) return;
    if (!force && tutoVu(k)) return;
    tutoAttente[k] = true;
    var t0 = Date.now();
    (function attendre() {
      var G = window.AideGuide;
      var pret = k === 'liste' ? voit('#ldFeed .ll5tabs') : voit('#ldSheetInner .ll5acts');
      if (!on || (!force && tutoVu(k)) || (k === 'fiche' && !openCardId)) { tutoAttente[k] = false; return; }
      if (!G || !pret || (G.active() && !force)) {
        if (Date.now() - t0 < 30000) setTimeout(attendre, 400);
        else tutoAttente[k] = false;
        return;
      }
      tutoAttente[k] = false;
      if (G.active()) G.stop();
      tutoMarquer(k);
      if (force && k === 'liste') { try { localStorage.removeItem(TUTO_KEY + ':fiche'); } catch (e) {} }
      G.start(k === 'liste' ? etapesListe() : etapesFiche(), { title: k === 'liste' ? 'Leads Live' : 'La fiche' });
    })();
  }

  document.addEventListener('DOMContentLoaded', brancherModules);
  window.addEventListener('load', brancherModules);
  peutActiver();
  lireCfg();
  window.LeadsLiveV3 = {
    actif: function () { return on; },
    demander: function (id) { if (!on) return; if (openCardId !== id) l2OpenLead(id); pile = ['lead', 'result']; anime = true; l2RenderSheet(id, false); }
  };
})();
