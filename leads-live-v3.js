/* ═══════════════════════════════════════════════════════════════════════════
   leads-live-v3.js — LEADS LIVE, NOUVELLE PRÉSENTATION (essai du 16/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Demande Adrien : « encore plus simple, qu'un enfant de 10 ans y arrive,
   sans rien enlever ». Ce fichier ne change QUE l'affichage de
   sales-leads.html : toutes les écritures passent par les gestionnaires
   historiques de la page (statut + journal d'actions + stage, follow-up +
   agenda Stratégie, notes, score, close, présence…). Aucune donnée, aucun
   champ Firestore, aucune règle n'est modifié.

   INTERRUPTEUR — l'ancienne vue reste intacte et reste la vue par défaut :
     • ?v3=1 dans l'URL  → nouvelle vue sur CE navigateur (mémorisé)
     • ?v3=0 dans l'URL  → retour à l'ancienne vue sur ce navigateur
     • _config/leads_live_v3 { enabled: true }        → toute l'équipe
       _config/leads_live_v3 { testeurs: ['slug', …] } → ces membres-là
       (lisible par les admins seulement tant que la règle Firestore n'est
       pas ouverte aux sales : sans elle, rien ne bascule pour l'équipe.)
     • Menu ⋯ → « Revenir à l'ancienne version ».

   Principe : les fonctions de rendu globales de la page (renderFeed,
   renderCard, l2RenderTriage, l2RenderSheet, l2SheetHeadHTML, l2SegAction,
   l2SegInfos, l2IsMobile) sont remplacées À L'ACTIVATION seulement. Les
   classes, data-action et sélecteurs dont dépendent le gestionnaire
   historique, DialerBridge, VoiceNotes, WhatsAppLead, RdvOutcome,
   ClosePilot, le journal Pilotage (nav.js) et les guides « Montre-moi »
   sont conservés.

   ES5 strict (convention du repo).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var FORCE_KEY = 'll3_force';
  var LIST_KEY = 'll3_list';
  var on = false;

  /* ═══ Interrupteur ═══════════════════════════════════════════════════ */
  (function lireUrl() {
    try {
      var v = new URLSearchParams(window.location.search).get('v3');
      if (v === '1' || v === '0') localStorage.setItem(FORCE_KEY, v);
    } catch (e) { /* stockage indisponible : on s'en tient à _config */ }
  })();
  function forcage() { try { return localStorage.getItem(FORCE_KEY); } catch (e) { return null; } }

  var cfg = null;
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
    if (f === '0') return;
    if (f === '1' || eligibleCfg()) activer();
  }
  function lireCfg() {
    try {
      firebase.auth().onAuthStateChanged(function (u) {
        if (!u || cfg) return;
        firebase.firestore().collection('_config').doc('leads_live_v3').get().then(function (s) {
          cfg = s.exists ? (s.data() || {}) : {};
          peutActiver();
          // L'identité (myIdentitySlug) peut arriver après la config.
          setTimeout(peutActiver, 2500);
          setTimeout(peutActiver, 8000);
        }).catch(function () { cfg = {}; });
      });
    } catch (e) { /* Firebase indisponible : ancienne vue */ }
  }
  window.addEventListener('team-members-loaded', function () { setTimeout(peutActiver, 0); });

  /* ═══ Vocabulaire et familles ════════════════════════════════════════ */
  var FAM = {
    nouveau: 'todo', appele: 'todo',
    decroche: 'talk', follow_up_pm: 'talk',
    messagerie: 'retry', nrp1: 'retry', nrp2: 'retry', nrp3: 'retry', all_nrp: 'retry',
    set: 'rdv', rdv_pose: 'rdv', rdv_self_booking: 'rdv',
    client: 'win',
    pas_interesse: 'done', disqualifie: 'done', faux_numero: 'done', poubelle: 'done'
  };
  var FAM_L = { todo: 'À contacter', retry: 'Pas joignable', talk: 'En discussion', rdv: 'Rendez-vous', win: 'Gagné', done: 'Terminé' };
  var FAM_COL = {
    todo:  ['#34d399', 'rgba(52,211,153,0.13)'],
    retry: ['#f59e0b', 'rgba(245,158,11,0.13)'],
    talk:  ['#60a5fa', 'rgba(96,165,250,0.13)'],
    rdv:   ['#a78bfa', 'rgba(167,139,250,0.14)'],
    win:   ['#fbbf24', 'rgba(251,191,36,0.16)'],
    done:  ['#8f97b2', 'rgba(143,151,178,0.14)']
  };
  var MOTS = {
    decroche: 'A répondu',
    nrp1: 'Pas répondu · 1ʳᵉ fois',
    nrp2: 'Pas répondu · 2ᵉ fois',
    nrp3: 'Pas répondu · 3ᵉ fois',
    all_nrp: 'Ne répond jamais',
    faux_numero: 'Mauvais numéro',
    follow_up_pm: 'Rappel convenu',
    set: 'RDV calé par l’équipe',
    rdv_self_booking: 'RDV pris par le prospect',
    disqualifie: 'Pas pour nous',
    client: 'Client signé'
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
    faire:  { t: 'À faire',     i: '⚡', d: 'Ce qui t’attend maintenant, du plus urgent au moins urgent.' },
    rappel: { t: 'À rappeler',  i: '🔁', d: 'Les pas joignables à retenter et les rappels programmés.' },
    rdv:    { t: 'Rendez-vous', i: '📅', d: 'Les leads avec un RDV, à venir ou à statuer.' },
    tous:   { t: 'Tous',        i: '📥', d: 'Toutes les arrivées, jour par jour.' }
  };
  var liste = 'faire';
  try { var lv = localStorage.getItem(LIST_KEY); if (lv && LISTS[lv]) liste = lv; } catch (e) {}
  var rdvSorte = 'all';

  /* ═══ Petits outils ══════════════════════════════════════════════════ */
  function leadDe(id) {
    for (var i = 0; i < allLeads.length; i++) if (allLeads[i].id === id) return allLeads[i];
    return null;
  }
  function prenom(l) { return String((l && l.nom) || '').trim().split(/\s+/)[0] || 'ce lead'; }
  function initiales(l) {
    var p = String((l && l.nom) || '?').trim().split(/\s+/);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function pastille(st) {
    var s = getStatusObj(st || 'nouveau');
    return '<span class="ll3pill f-' + (s.fam || 'done') + '">' + s.icon + ' ' + escHtml(s.label) + '</span>';
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
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' à ' + hm(d);
  }
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

  /* ═══ Découpage des 4 listes ═════════════════════════════════════════ */
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
      { t: '⏰ Rappels en retard', hot: true, list: late },
      { t: '📅 Présence à confirmer', list: pres },
      { t: '🆕 Jamais appelés', list: neu },
      { t: '⏳ En cours · à faire avancer', list: cours }
    ];
  }
  function groupesRappel(leads) {
    var retenter = [], prog = [];
    leads.forEach(function (l) {
      if (!dansRappel(l)) return;
      if (L2_RECALL[l.status || 'nouveau']) retenter.push(l); else prog.push(l);
    });
    prog.sort(function (a, b) {
      var ta = fuProchain(a, true) || fuProchain(a, false) || Infinity;
      var tb = fuProchain(b, true) || fuProchain(b, false) || Infinity;
      return ta - tb;
    });
    return [
      { t: '📵 Pas joignables · à retenter', list: retenter },
      { t: '🔔 Rappels programmés', list: prog }
    ];
  }
  function groupesRdv(leads) {
    var up = [], autres = [];
    leads.forEach(function (l) {
      if (!dansRdv(l)) return;
      if (rdvSorte !== 'all' && l2SbNb(l) !== rdvSorte) return;
      if (rdvAVenir(l).length) up.push(l); else autres.push(l);
    });
    up.sort(function (a, b) { return ldAgStartMs(rdvAVenir(a)[0]) - ldAgStartMs(rdvAVenir(b)[0]); });
    return [
      { t: '📅 RDV à venir', list: up },
      { t: '🗂 Autres RDV · passés ou à statuer', list: autres }
    ];
  }
  function compter(leads) {
    var n = function (gs) { var s = 0; gs.forEach(function (g) { s += g.list.length; }); return s; };
    var gf = groupesFaire(leads);
    var keep = rdvSorte; rdvSorte = 'all';
    var c = { faire: n(gf), late: gf[0].list.length, rappel: n(groupesRappel(leads)), rdv: n(groupesRdv(leads)), tous: leads.length };
    rdvSorte = keep;
    return c;
  }

  /* ═══ Carte de la file ═══════════════════════════════════════════════ */
  function prochaineEtape(l) {
    var st = l.status || 'nouveau';
    var late = fuProchain(l, true);
    if (late && !terminal(l)) return '<div class="ll3next late">⏰ Rappel prévu ' + quand(new Date(late)) + ' · en retard</div>';
    var b = rdvAVenir(l)[0];
    if (b) {
      var lbl = 'RDV ' + ldPresRdvLabel(b);
      if (b.presenceConfirmed) return '<div class="ll3next ok" data-pres="view" data-booking-id="' + escAttr(b.id) + '" role="button" tabindex="0">📅 ' + escHtml(lbl) + ' · présence confirmée</div>';
      return '<div class="ll3next warn" data-pres="confirm" data-booking-id="' + escAttr(b.id) + '" role="button" tabindex="0">📅 ' + escHtml(lbl) + ' · présence à confirmer ›</div>';
    }
    if (st === 'client') return '<div class="ll3next">🏆 Client signé</div>';
    if (l2IsUntouched(l)) {
      var arr = l2ArrivalLabel(_getLeadEffectiveDate(l) || l.createdAt);
      return '<div class="ll3next">🆕 Arrivé ' + (/^\d\d:\d\d$/.test(arr) ? 'à ' : '') + escHtml(arr) + ' · jamais appelé</div>';
    }
    var fut = fuProchain(l, false);
    if (fut && !terminal(l)) return '<div class="ll3next">🔔 Rappel ' + quand(new Date(fut)) + '</div>';
    var la = l2LastActivity(l);
    if (terminal(l)) return '<div class="ll3next muted">Terminé' + (la ? ' · ' + escHtml(la) : '') + '</div>';
    if (L2_RECALL[st]) return '<div class="ll3next">📞 À retenter' + (la ? ' · ' + escHtml(la) : '') + '</div>';
    return la ? '<div class="ll3next muted">' + escHtml(la) + '</div>' : '';
  }
  function carte(l) {
    var id = l.id;
    var so = SETTERS[l.assignedTo] || null;
    var tel = (l.telephone || '').toString().replace(/\s/g, '');
    var isTerm = L2_TERMINAL[l.status] && l.status !== 'client';
    var typ = LEAD_TYPES[l.type] || { label: l.type || 'Lead' };
    var h = '<div class="ld-card ll3card' + (l._isNew ? ' new' : '') + (openCardId === id ? ' is-open' : '') + (isTerm ? ' l2done' : '') +
      '" data-lead-id="' + id + '" data-phone="' + escAttr(tel) + '" data-name="' + escAttr(l.nom || '') + '">';
    h += '<div class="ld-card-head" data-action="toggle" data-id="' + id + '">';
    if (so) h += '<div class="ld-card-avatar" style="background:' + escAttr(so.color) + '" title="Suivi par ' + escAttr(so.name) + '">' + escHtml(so.initials) + '</div>';
    else h += '<div class="ld-card-avatar ll3nobody" title="Personne ne suit ce lead">?</div>';
    h += '<div class="ld-card-info">';
    h += '<div class="ld-card-name"><span class="ll3nm">' + escHtml(l.nom || '—') + '</span>' + l2AiBadgeHTML(l) + '</div>';
    h += '<div class="ll3meta">' + pastille(l.status) + '<span class="ll3tun">' + escHtml(typ.label) + '</span>' +
      (so && !(personalUser && l.assignedTo === personalUser) ? '<span class="ll3own" style="--o:' + escAttr(so.color) + '">' + escHtml(so.name) + '</span>' : '') + '</div>';
    h += prochaineEtape(l);
    h += '</div>';
    h += '<div class="l2side"><span class="l2cta"></span></div>';
    h += '</div></div>';
    return h;
  }

  /* ═══ Bandeau des 4 listes (remplace les 6 tuiles) ═══════════════════ */
  function rendreListes(leads) {
    var host = l2El('l2Triage');
    if (!host) return;
    var c = compter(leads);
    var cherche = !!filterSearch;
    var h = '';
    ['faire', 'rappel', 'rdv', 'tous'].forEach(function (k) {
      var L = LISTS[k];
      var hot = k === 'faire' && c.late > 0;
      h += '<button type="button" class="ll3list' + (liste === k && !cherche ? ' active' : '') + '" data-ll3="list" data-v="' + k + '">' +
        '<span class="i" aria-hidden="true">' + L.i + '</span><span class="l">' + L.t + '</span>' +
        '<span class="n' + (hot ? ' hot' : '') + '">' + c[k] + '</span></button>';
    });
    h += '<div class="ll3desc">' + (cherche ? '🔍 Recherche dans tous les leads (période, tunnel et statut ignorés).' : LISTS[liste].d + (liste === 'faire' && c.late ? ' <b class="late">' + c.late + ' rappel' + (c.late > 1 ? 's' : '') + ' en retard.</b>' : '')) + '</div>';
    host.innerHTML = h;

    document.body.classList.toggle('ll3-tous', liste === 'tous' && !cherche);
    var sb = l2El('l2SortBtn');
    if (sb) {
      sb.classList.toggle('on', l2Sort === 'proba');
      sb.textContent = l2Sort === 'proba' ? '🎯 Chance de RDV' : '📅 Plus récents';
    }
    var fc = l2FiltersActiveCount();
    var fb = l2El('l2FiltersBtn');
    if (fb) {
      fb.classList.toggle('on', fc > 0);
      var fn = l2El('l2FiltersCount');
      if (fn) fn.textContent = fc;
    }
  }

  /* ═══ File ═══════════════════════════════════════════════════════════ */
  function rendreFile() {
    var leads = getFilteredLeads();
    updateCounts();
    updatePeriodCounts();
    rebuildTypeFilters();
    l2RenderTriage(leads);
    var feed = l2El('ldFeed');

    var sections, entete = '';
    if (filterSearch) {
      sections = [{ t: '🔍 Résultats', list: leads }];
    } else if (liste === 'faire') {
      sections = groupesFaire(leads);
    } else if (liste === 'rappel') {
      sections = groupesRappel(leads);
    } else if (liste === 'rdv') {
      entete = '<div class="ll3chips" role="group" aria-label="Qui a posé le RDV">' +
        [['all', 'Tous'], ['sb', 'Pris par le prospect'], ['nb', 'Posés par l’équipe']].map(function (x) {
          return '<button type="button" class="ll3chip' + (rdvSorte === x[0] ? ' on' : '') + '" data-ll3="rdvkind" data-v="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>';
      sections = groupesRdv(leads);
    } else {
      sections = l2Sort === 'proba' ? [{ t: '🎯 Par chance de RDV (IA)', list: leads }] : l2ArriveesSections(leads);
    }

    var h = entete, total = 0;
    sections.forEach(function (sec) {
      if (!sec.list.length) return;
      total += sec.list.length;
      h += '<div class="l2grp' + (sec.hot ? ' hot' : '') + '"><span class="t">' + sec.t + '</span><span class="n">' + sec.list.length + '</span><span class="line"></span></div>';
      for (var i = 0; i < sec.list.length; i++) h += renderCard(sec.list[i]);
    });
    if (total === 0) {
      var msg = filterSearch ? 'Aucun lead ne correspond à « ' + escHtml(filterSearch) + ' ».'
        : (liste === 'faire' ? 'Rien d’urgent pour l’instant 👍' : 'Rien dans cette liste pour l’instant.');
      h += '<div class="ld-empty ll3empty"><b>' + msg + '</b>' + (filterSearch ? '' : '<span>Regarde la liste « Tous », une autre période, ou les Filtres.</span>') + '</div>';
    }
    feed.innerHTML = h;

    if (window.DialerBridge) {
      try {
        window.DialerBridge.attachButtons('#ldFeed', { cardSelector: '.ld-card', insertTarget: '.l2cta' });
        window.DialerBridge.enableMultiSelect('#ldFeed', { cardSelector: '.ld-card', maxSelection: 5 });
      } catch (e) { console.warn('[DialerBridge] attach failed', e); }
    }
    if (openCardId && !isEditingLead) {
      var openEl = document.querySelector('#ldFeed .ld-card[data-lead-id="' + openCardId + '"]');
      if (openEl) openEl.classList.add('is-open');
      l2RenderSheet(openCardId, true);
    }
    l2SyncHdH();
  }

  /* ═══ Fiche : en-tête ════════════════════════════════════════════════ */
  function entete(l, id) {
    var tel = (l.telephone || '').toString().replace(/\s/g, '');
    var so = SETTERS[l.assignedTo] || null;
    var typ = LEAD_TYPES[l.type] || { label: l.type || 'Lead' };
    var mine = myIdentitySlug || personalUser;
    var h = '<div class="l2sh-head ll3head">';
    h += '<div class="ll3bar"><button type="button" class="l2sh-close ll3back" data-l2="close" aria-label="Fermer la fiche"><span class="m">‹ Liste</span><span class="d">✕</span></button></div>';
    h += '<div class="ll3id"><div class="ll3av" aria-hidden="true">' + escHtml(initiales(l)) + '</div><div class="ll3idt">';
    h += '<div class="l2sh-name">' + escHtml(l.nom || '—') + '</div>';
    h += '<div class="ll3sub">' + pastille(l.status) + '<span>' + escHtml(typ.label) + '</span>' +
      (so ? '<span>· suivi par <b style="color:' + escAttr(so.color) + '">' + escHtml(so.name) + '</b></span>' : '<span>· personne ne le suit</span>') + '</div>';
    h += '</div></div>';
    h += '<div class="l2sh-phone ll3contact">';
    if (l.telephone) {
      var nt = normalizeTel(l.telephone);
      h += '<a href="#" class="ll3tel" data-action="dialerCall" data-phone="' + escAttr(tel) + '" data-lead-id="' + id + '" data-name="' + escAttr(l.nom || '') + '" title="Appeler via Ringover">' + escHtml(nt) + '</a>';
      h += '<button type="button" class="ll3mini" data-ll3="copy" data-v="' + escAttr(nt) + '">Copier</button>';
    } else {
      h += '<span class="ll3muted">Aucun téléphone</span>';
    }
    if (l.email) h += '<a class="ll3mail" href="mailto:' + escAttr(l.email) + '">' + escHtml(l.email) + '</a>';
    h += '</div>';
    h += '<div class="l2sh-tags">' + renderLeadTags(l, false) + '</div>';
    var la = l2LastActivity(l);
    if (la) h += '<div class="ll3last">Dernier contact : ' + escHtml(la) + '</div>';
    h += '<div class="ll3acts">';
    if (l.telephone) {
      h += '<a class="ll3big call" href="#" data-action="dialerCall" data-phone="' + escAttr(tel) + '" data-lead-id="' + id + '" data-name="' + escAttr(l.nom || '') + '"><span class="i">📞</span><span class="t">Appeler</span></a>';
    } else {
      h += '<span class="ll3big off"><span class="i">📞</span><span class="t">Pas de numéro</span></span>';
    }
    h += '<button type="button" class="ll3big" data-l2="gosms" data-id="' + id + '"><span class="i">💬</span><span class="t">Écrire</span></button>';
    h += '<button type="button" class="ll3big ld-booking-btn-v2" data-action="openBooking" data-id="' + id + '"><span class="i">📅</span><span class="t">Prendre RDV</span></button>';
    h += '<details class="ll3more"><summary class="ll3big" aria-label="Plus d’actions"><span class="i">⋯</span><span class="t">Plus</span></summary><div class="ll3menu">';
    h += '<a href="sales-contact.html?id=' + encodeURIComponent(id) + '">📋 Fiche CRM complète</a>';
    if (mine && l.assignedTo !== mine) h += '<button type="button" data-action="reassign" data-id="' + id + '">📥 M’attribuer ce lead</button>';
    h += '<button type="button" data-action="openModule" data-mod="sig" data-lead-id="' + escAttr(id) + '">📝 Signatures</button>';
    h += '<button type="button" data-action="openModule" data-mod="pay" data-lead-id="' + escAttr(id) + '">💳 Paiements</button>';
    h += '<button type="button" data-action="closerGuide">🎯 Je close (aide-mémoire)</button>';
    h += '</div></details>';
    h += '</div></div>';
    return h;
  }

  /* ═══ Fiche : onglet À faire ═════════════════════════════════════════ */
  function parcours(l, id) {
    var st = l.status || 'nouveau';
    var f = FAM[st] || 'done';
    if (f === 'done') {
      return '<div class="ll3row">' + pastille(st) + '<span class="ll3hint">Ce lead est sorti du parcours.</span>' +
        '<button type="button" class="ll3btn sm" data-ll3="openAll" data-id="' + id + '">Remettre en jeu</button></div>';
    }
    var gagne = !!(l.isClient === true || l.clientSince || String(l.stage || '').indexOf('closed_won') === 0);
    var idx = { todo: 0, retry: 0, talk: 1, rdv: 2, win: gagne ? 4 : 3 }[f];
    var etapes = ['À contacter', 'En contact', 'RDV', 'Closing', 'Client'];
    return '<div class="ll3journey">' + etapes.map(function (e, i) {
      return '<div class="' + (i < idx ? 'past' : (i === idx ? 'cur' : '')) + '">' + e + '</div>';
    }).join('') + '</div>' + (f === 'retry' ? '<p class="ll3hint">Pas encore joint : ' + escHtml(getStatusObj(st).label.toLowerCase()) + '.</p>' : '');
  }
  function boutonsQ1(id, st) {
    var suiv = NRP_SUIVANT[st] || 'nrp1';
    return '<div class="ll3choices">' +
      '<button type="button" class="ll3choice" data-ll3="r1" data-v="yes" data-id="' + id + '"><span class="ic">✅</span><span>Il a répondu</span></button>' +
      '<button type="button" class="ll3choice" data-ll3="r1" data-v="no" data-id="' + id + '"><span class="ic">📵</span><span>Pas de réponse<small>→ ' + escHtml(getStatusObj(suiv).label) + '</small></span></button>' +
      '<button type="button" class="ll3choice" data-ll3="r1" data-v="vm" data-id="' + id + '"><span class="ic">📩</span><span>Messagerie</span></button>' +
      '<button type="button" class="ll3choice" data-ll3="r1" data-v="bad" data-id="' + id + '"><span class="ic">⛔</span><span>Mauvais numéro</span></button>' +
      '</div>';
  }
  function grilleStatuts(l, id) {
    var h = '<div class="ld-status-grid">';
    for (var f = 0; f < L2_FAMILIES.length; f++) {
      var fam = L2_FAMILIES[f];
      h += '<div class="l2fam" data-fam="' + fam.l.toLowerCase() + '"><div class="l2fam-l">' + fam.l + '</div><div class="l2fam-row">';
      for (var si = 0; si < fam.k.length; si++) {
        var s = getStatusObj(fam.k[si]);
        var act = (l.status || 'nouveau') === s.key;
        h += '<button class="ld-status-btn' + (act ? ' active' : '') + '" style="' + (act ? 'color:' + s.color + ';border-color:' + s.color : '') + '" data-action="setStatus" data-id="' + id + '" data-status="' + s.key + '">' +
          s.icon + ' ' + escHtml(s.label) + (s.oldLabel && s.oldLabel !== s.label ? ' <small class="ll3old">' + escHtml(s.oldLabel) + '</small>' : '') + '</button>';
      }
      h += '</div></div>';
    }
    return h + '</div>';
  }
  function blocRappels(l, id) {
    var fus = l.followUps || [];
    var now = Date.now(), pend = 0, over = 0;
    fus.forEach(function (f) { if (!f.done) { pend++; if (new Date(f.dateTime).getTime() <= now) over++; } });
    var h = '<div class="ld-fu-section">';
    h += '<button class="ld-fu-toggle open" data-action="toggleFu" data-id="' + id + '">🔔 Rappels';
    if (over > 0) h += ' <span class="ld-fu-count ll3late">' + over + ' en retard</span>';
    else if (pend > 0) h += ' <span class="ld-fu-count">' + pend + ' programmé' + (pend > 1 ? 's' : '') + '</span>';
    h += '<span class="ct-arrow">▼</span></button>';
    h += '<div class="ld-fu-body" data-fu-body="' + id + '" style="display:block">';
    h += '<div class="ll3quick"><span class="ll3hint">Rappeler :</span>' +
      [['1h', 'Dans 1 h'], ['soir', 'Ce soir 18 h'], ['demain9', 'Demain 9 h'], ['demain14', 'Demain 14 h'], ['lundi9', 'Lundi 9 h']].map(function (q) {
        return '<button type="button" class="ll3chip" data-ll3="fuq" data-v="' + q[0] + '" data-id="' + id + '">' + q[1] + '</button>';
      }).join('') + '</div>';
    h += '<div class="ll3hint">Ou choisis la date et l’heure :</div>';
    h += '<div class="ld-fu-add">';
    h += '<input type="date" data-fu-field="date" data-id="' + id + '" aria-label="Date du rappel"/>';
    h += '<input type="time" data-fu-field="time" data-id="' + id + '" aria-label="Heure du rappel"/>';
    h += '<textarea data-fu-field="note" data-id="' + id + '" placeholder="Pourquoi rappeler ? (facultatif)" rows="1"></textarea>';
    h += '<button class="ld-fu-add-btn" data-action="addFu" data-id="' + id + '">🔔 Programmer</button>';
    h += '</div>';
    h += '<div class="ld-fu-add-row2">';
    h += '<span class="ld-fu-duration-label">Durée</span>';
    h += '<select class="ld-fu-duration-select" data-fu-field="duration" data-id="' + id + '">';
    h += '<option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1h</option>';
    h += '</select>';
    h += '<label class="ld-fu-cal-switch" title="Crée un événement sur le calendrier Google du closer assigné">';
    h += '<input type="checkbox" data-fu-field="pushCal" data-id="' + id + '" checked/>';
    h += '<span class="sw-track"></span><span class="sw-label">📅 Agenda Stratégie</span></label>';
    h += '</div>';
    if (!fus.length) {
      h += '<div class="ld-fu-empty">Aucun rappel programmé</div>';
    } else {
      h += '<div class="ld-fu-list">';
      var tri = fus.map(function (f, idx) { f._idx = idx; return f; }).sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime();
      });
      tri.forEach(function (fu) {
        var d = new Date(fu.dateTime), diff = d.getTime() - now, cls = '';
        if (!fu.done) { if (diff <= 0) cls = ' overdue'; else if (diff <= 3600000) cls = ' due-soon'; }
        h += '<div class="ld-fu-item' + (fu.done ? ' done' : '') + cls + '">';
        h += '<button class="ld-fu-check" data-action="toggleFuDone" data-id="' + id + '" data-fu-idx="' + fu._idx + '" aria-label="' + (fu.done ? 'Remettre à faire' : 'Marquer comme fait') + '">' + (fu.done ? '✓' : '') + '</button>';
        h += '<div class="ld-fu-info"><div class="ld-fu-datetime">' + (fu.done ? '✅ ' : (diff <= 0 ? '⚠️ ' : '🔔 ')) +
          deux(d.getDate()) + '/' + deux(d.getMonth() + 1) + '/' + d.getFullYear() + ' à ' + hm(d) + (!fu.done && diff <= 0 ? ' · en retard' : '');
        if (fu.calendarEventId && fu.calendarEventLink) h += '<a class="ld-fu-cal-badge" href="' + escAttr(fu.calendarEventLink) + '" target="_blank" rel="noopener">📅 Agenda</a>';
        else if (fu.calendarEventId) h += '<span class="ld-fu-cal-badge">📅</span>';
        h += '</div>';
        if (fu.note) h += '<div class="ld-fu-note">' + escHtml(fu.note) + '</div>';
        if (fu.createdBy) h += '<div class="ld-fu-by">par ' + escHtml(fu.createdBy) + '</div>';
        h += '</div>';
        h += '<button class="ld-fu-del" data-action="delFu" data-id="' + id + '" data-fu-idx="' + fu._idx + '" aria-label="Supprimer ce rappel">✕</button>';
        h += '</div>';
      });
      h += '</div>';
    }
    h += '</div></div>';
    return h;
  }
  function blocNotes(l, id) {
    var h = '<div class="ld-actions-title">📝 Notes</div>';
    h += '<div class="ld-notes-add-row">';
    h += '<textarea class="ld-notes-area" data-field="newNote" data-id="' + id + '" placeholder="Écris une note… (@prénom pour prévenir quelqu’un)" rows="2"></textarea>';
    h += '<button class="ld-notes-add-btn" data-action="addNote" data-id="' + id + '">Ajouter la note</button>';
    h += '</div>';
    var notes = l.notesHistory || [];
    if (notes.length) {
      h += '<div class="ld-notes-history">';
      for (var ni = notes.length - 1; ni >= 0; ni--) {
        var n = notes[ni];
        h += '<div class="ld-note-item"><div class="ld-note-item-head"><span class="ld-note-item-date">' + escHtml(n.date || '') + (n.authorName ? ' · ' + escHtml(n.authorName) : '') + '</span>';
        h += '<button class="ld-note-item-del" data-action="delNote" data-id="' + id + '" data-note-idx="' + ni + '" aria-label="Supprimer la note">✕</button></div>';
        h += '<div class="ld-note-item-text">' + highlightMentions(n.text || '') + '</div></div>';
      }
      h += '</div>';
    } else {
      h += '<div class="ll3hint">Pas encore de note.</div>';
    }
    return h;
  }
  function ongletFaire(l, id) {
    var st = l.status || 'nouveau';
    var h = '<div class="ld-rail-block" data-close-rail="' + id + '"></div>';
    h += l2AiBlockHTML(l, id);
    h += ldGroupeBlockHTML(l, id);
    h += '<div class="ld-actions">';
    h += '<section class="ll3box"><h3>Où en est ' + escHtml(prenom(l)) + ' ?</h3>' + parcours(l, id) + '</section>';
    h += '<section class="ll3box"><h3>Tu viens de l’appeler ?<span class="aside">2 questions, c’est tout</span></h3>';
    h += '<p class="ll3hint">Dis comment ça s’est passé : l’état se met à jour tout seul.</p>' + boutonsQ1(id, st);
    h += '<details class="ll3all" data-all="' + id + '"><summary>Changer l’état à la main · les 17 états</summary>' + grilleStatuts(l, id) + '</details></section>';
    h += '<section class="ll3box">' + blocRappels(l, id) + '</section>';
    h += '<section class="ll3box">' + ldScoreBlockHTML(l, id) + '</section>';
    h += '<section class="ll3box">' + blocNotes(l, id) + '</section>';
    h += '</div>';
    return h;
  }

  /* ═══ Fiche : onglets RDV et Dossier ═════════════════════════════════ */
  function ongletRdv(l, id) {
    var h = '<div class="ld-rdv-block" data-rdv-block="' + id + '"><div class="ld-rdv-block-title">📅 Rendez-vous</div><div class="ld-rdv-list" data-rdv-list="' + id + '"></div></div>';
    h += '<div class="ll3rdvempty"><div class="big">📅</div><b>Aucun rendez-vous</b><span>Quand ' + escHtml(prenom(l)) + ' est prêt, pose le RDV ici.</span></div>';
    h += '<button type="button" class="ll3btn pri" data-action="openBooking" data-id="' + id + '">📅 Prendre un RDV</button>';
    return h;
  }
  var ancienInfos = null;
  function ongletDossier(l, id) {
    var html = ancienInfos(l, id);
    var cut = html.indexOf('<div class="ld-bl-title">');
    if (cut < 0) cut = html.indexOf('<button class="ld-delete-btn"');
    if (cut < 0) return html;
    var avant = html.slice(0, cut), zone = html.slice(cut);
    if (!estAdmin()) {
      return avant + '<div class="ll3note">🔒 Blacklist et suppression de fiche : réservées aux admins.</div>';
    }
    return avant + '<details class="ll3danger"><summary>⚠️ Zone sensible <small>admins</small></summary><div class="in">' + zone + '</div></details>';
  }

  /* ═══ Fiche : assemblage (copie de l2RenderSheet, 4 onglets) ═════════ */
  function compterRdv(id) {
    var AF = window.AlteoreFlow;
    try {
      return ldRdvItemsFor(id).filter(function (b) { return !AF || AF.classifyBooking(b, _ldTypeMap || {}) !== 'excluded'; }).length;
    } catch (e) { return 0; }
  }
  function onglet(k, t, b) {
    return '<button type="button" class="l2seg' + (l2Seg === k ? ' active' : '') + '" data-l2="seg" data-seg="' + k + '">' + t + (b || '') + '</button>';
  }
  function rendreFiche(id, preserve) {
    var sheet = l2El('ldSheet');
    var inner = l2El('ldSheetInner');
    if (!sheet || !inner) return;
    var l = leadDe(id);
    if (!l) { l2CloseSheet(); return; }
    if (l2Seg !== 'action' && l2Seg !== 'rdv' && l2Seg !== 'ech' && l2Seg !== 'infos') l2Seg = 'action';

    var drafts = preserve ? l2CaptureDrafts(inner) : null;
    var scrollPos = preserve ? inner.scrollTop : 0;
    var oldVn = inner.querySelector('.vn-container');
    if (oldVn && window.VoiceNotes) { try { window.VoiceNotes.detach(oldVn); } catch (e) {} }

    var fuOver = l2FuStats(l).overdue;
    var commN = 0;
    (l.communications || []).forEach(function (c) { if (c && (c.type === 'call' || c.type === 'sms')) commN++; });
    var rdvN = compterRdv(id);

    var h = '';
    try { h = l2SheetHeadHTML(l, id); }
    catch (eHead) { console.error('[fiche v3] entête', id, eHead); h = '<div style="padding:14px 16px;font-weight:800">' + escHtml(l.nom || l.email || id) + '</div>'; }
    var presBn = '';
    try { presBn = ldPresBannerHTML(l); } catch (ePres) { console.error('[fiche v3] présence', id, ePres); }
    h += '<div class="ldpres-bnwrap" data-pres-banner="' + id + '">' + presBn + '</div>';
    h += '<div class="l2segs ll3segs">';
    h += onglet('action', 'À faire', fuOver ? ' <span class="b">' + fuOver + '</span>' : '');
    h += onglet('rdv', 'RDV', rdvN ? ' <span class="b blue">' + rdvN + '</span>' : '');
    h += onglet('ech', 'Messages', commN ? ' <span class="b blue">' + commN + '</span>' : '');
    h += onglet('infos', 'Dossier', '');
    h += '</div>';
    var seg = '';
    try {
      if (l2Seg === 'action') seg = l2SegAction(l, id);
      else if (l2Seg === 'rdv') seg = ongletRdv(l, id);
      else if (l2Seg === 'infos') seg = l2SegInfos(l, id);
      else seg = l2SegEch(l, id);
    } catch (eSeg) {
      console.error('[fiche v3] onglet ' + l2Seg, id, eSeg);
      seg = '<div class="ll3note">⚠️ Cet onglet n’a pas pu s’afficher, les autres restent accessibles.<br><small>' + escHtml(String((eSeg && eSeg.message) || eSeg)) + '</small></div>';
    }
    h += '<div class="l2body ld-card" data-lead-id="' + id + '">' + seg + '</div>';
    inner.innerHTML = h;
    sheet.classList.add('has-lead');

    try { if (l2Seg === 'action') l2AiEnsure(l); } catch (eAi) { console.warn('[IA] score', eAi); }
    if (drafts) l2RestoreDrafts(inner, drafts, id);
    inner.scrollTop = scrollPos;

    try {
      attachLeadRdvListener(id);
      paintLeadRdvBox(id, ldRdvItemsFor(id));
      ldRdvItemsFor(id).forEach(slCatchUpLeadId);
    } catch (eRdv) { console.error('[fiche v3] RDV', id, eRdv); }
    try {
      attachLeadDealListeners(id);
      paintCloseRail(id);
    } catch (eDeal) { console.error('[fiche v3] close', id, eDeal); }

    if (l2Seg === 'ech' && window.VoiceNotes) {
      var mount = inner.querySelector('[data-vn-mount="' + id + '"]');
      if (mount) window.VoiceNotes.attach(mount, id, getCurrentVoiceUser());
    }
    if (l2Seg === 'ech' && window.WhatsAppLead) {
      var wam = inner.querySelector('[data-wal-mount="' + id + '"]');
      var moi = null;
      try { moi = getCurrentVoiceUser(); } catch (e) { moi = null; }
      if (wam) window.WhatsAppLead.attach(wam, id, l.telephone, { nom: l.nom || '', assignedTo: l.assignedTo || '', moiNom: (moi && moi.name) || '' });
    } else if (window.WhatsAppLead) {
      window.WhatsAppLead.detach(id);
    }
  }

  /* ═══ « Comment ça s'est passé ? » ═══════════════════════════════════
     Les écritures passent par les vrais boutons du gestionnaire historique,
     posés dans une carte fantôme (le gestionnaire cherche .ld-card autour
     du bouton) : même journal d'actions, même synchro du stage, même toast,
     même follow-up + agenda Stratégie. */
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
    g.innerHTML = '<button type="button" class="ld-status-btn" data-action="setStatus" data-id="' + escAttr(id) + '" data-status="' + st + '">' + s.icon + ' ' + escHtml(s.label) + '</button>';
    g.firstChild.click();
  }
  function programmerRappel(id, ms, agenda) {
    var d = new Date(ms), g = fantome(), avant = openCardId;
    g.innerHTML = '<input data-fu-field="date" value="' + ymd(d) + '"/><input data-fu-field="time" value="' + hm(d) + '"/>' +
      '<textarea data-fu-field="note"></textarea><select data-fu-field="duration"><option value="30" selected>30</option></select>' +
      '<input type="checkbox" data-fu-field="pushCal"' + (agenda ? ' checked' : '') + '/>' +
      '<button type="button" data-action="addFu" data-id="' + escAttr(id) + '">🔔 Programmer le rappel</button>';
    g.querySelector('[data-action="addFu"]').click();
    /* Le gestionnaire ouvre la fiche du lead concerné : on rend la main sur
       ce qui était affiché avant. */
    if (avant !== id) {
      if (!avant) { l2CloseSheet(); renderFeed(); }
      else { try { l2DetachSheetModules(id); } catch (e) {} openCardId = avant; renderFeed(); }
    }
  }
  function heureRapide(k) {
    var d = new Date();
    if (k === '1h') { d = new Date(Date.now() + 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); return d.getTime(); }
    if (k === 'soir') { d.setHours(18, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }
    if (k === 'demain9' || k === 'demain14') { d.setDate(d.getDate() + 1); d.setHours(k === 'demain9' ? 9 : 14, 0, 0, 0); return d.getTime(); }
    if (k === 'lundi9') { var add = (8 - d.getDay()) % 7 || 7; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return d.getTime(); }
    return Date.now() + 3600000;
  }

  var ask = { id: null };
  function askDom() {
    if (document.getElementById('ll3Ask')) return;
    var bd = document.createElement('div');
    bd.className = 'll3ask-bd'; bd.id = 'll3AskBd';
    bd.addEventListener('click', fermerAsk);
    var p = document.createElement('section');
    p.className = 'll3ask'; p.id = 'll3Ask';
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-labelledby', 'll3AskT');
    p.innerHTML = '<div class="ll3ask-h"><div class="tt"><div class="t" id="ll3AskT"></div><div class="s" id="ll3AskS"></div></div>' +
      '<button type="button" class="ll3x" data-ll3="askClose" aria-label="Fermer">✕</button></div>' +
      '<div class="ll3ask-b" id="ll3AskB"></div><div class="ll3ask-f" id="ll3AskF"></div>';
    document.body.appendChild(bd);
    document.body.appendChild(p);
  }
  function ouvrirAsk(id, etape, info) {
    var l = leadDe(id);
    if (!l) return;
    askDom();
    ask.id = id;
    var T = l2El('ll3AskT'), S = l2El('ll3AskS'), B = l2El('ll3AskB'), F = l2El('ll3AskF');
    S.textContent = (l.nom || '') + (l.telephone ? ' · ' + normalizeTel(l.telephone) : '');
    var st = l.status || 'nouveau';
    if (etape === 'q2') {
      T.textContent = 'Il a répondu 👍 Qu’est-ce qu’il veut ?';
      B.innerHTML = '<p class="ll3hint">Question 2 sur 2.</p><div class="ll3choices c3">' +
        '<button type="button" class="ll3choice" data-ll3="r2" data-v="rdv" data-id="' + id + '"><span class="ic">📅</span><span>Un RDV<small>l’agenda s’ouvre</small></span></button>' +
        '<button type="button" class="ll3choice" data-ll3="r2" data-v="fu" data-id="' + id + '"><span class="ic">🔁</span><span>Être rappelé<small>tu choisis quand</small></span></button>' +
        '<button type="button" class="ll3choice" data-ll3="r2" data-v="talk" data-id="' + id + '"><span class="ic">💬</span><span>On a parlé<small>rien de décidé</small></span></button>' +
        '<button type="button" class="ll3choice" data-ll3="r2" data-v="no" data-id="' + id + '"><span class="ic">👎</span><span>Pas intéressé</span></button>' +
        '<button type="button" class="ll3choice" data-ll3="r2" data-v="dq" data-id="' + id + '"><span class="ic">🚫</span><span>Pas pour nous<small>hors cible</small></span></button>' +
        '<button type="button" class="ll3choice win" data-ll3="r2" data-v="win" data-id="' + id + '"><span class="ic">🏆</span><span>Il a signé<small>les cartes du close s’ouvrent</small></span></button>' +
        '</div>';
      F.innerHTML = '<button type="button" class="ll3btn" data-ll3="askBack" data-id="' + id + '">← Retour</button>';
    } else if (etape === 'fu') {
      T.textContent = 'Quand le rappeler ?';
      B.innerHTML = (info ? '<p class="ll3ok">✅ ' + escHtml(info) + '</p>' : '') +
        '<div class="ll3quick big">' + [['1h', 'Dans 1 h'], ['soir', 'Ce soir 18 h'], ['demain9', 'Demain 9 h'], ['demain14', 'Demain 14 h'], ['lundi9', 'Lundi 9 h']].map(function (q) {
          return '<button type="button" class="ll3chip" data-ll3="askFu" data-v="' + q[0] + '" data-id="' + id + '">' + q[1] + '</button>';
        }).join('') + '</div>' +
        '<label class="ll3toggle"><input type="checkbox" id="ll3AskCal" checked/> Ajouter à l’agenda Stratégie</label>' +
        '<p class="ll3hint">Pour une autre date : onglet « À faire » → Rappels.</p>';
      F.innerHTML = '<button type="button" class="ll3btn" data-ll3="askClose">Pas de rappel</button>';
    } else {
      T.textContent = 'Comment ça s’est passé ?';
      B.innerHTML = '<p class="ll3hint">Question 1 sur 2. Choisis, l’état se met à jour tout seul.</p>' + boutonsQ1(id, st).replace(/data-ll3="r1"/g, 'data-ll3="a1"');
      F.innerHTML = '<button type="button" class="ll3btn" data-ll3="askClose">Plus tard</button>';
    }
    l2El('ll3AskBd').classList.add('on');
    l2El('ll3Ask').classList.add('on');
    var x = l2El('ll3Ask').querySelector('.ll3x');
    if (x) x.focus();
  }
  function fermerAsk() {
    var a = l2El('ll3Ask'), b = l2El('ll3AskBd');
    if (a) a.classList.remove('on');
    if (b) b.classList.remove('on');
    ask.id = null;
  }
  function reponse1(id, v) {
    var l = leadDe(id);
    if (!l) return;
    var st = l.status || 'nouveau';
    if (v === 'yes') { ouvrirAsk(id, 'q2'); return; }
    if (v === 'no') { var n = NRP_SUIVANT[st] || 'nrp1'; poserStatut(id, n); ouvrirAsk(id, 'fu', getStatusObj(n).label); return; }
    if (v === 'vm') { poserStatut(id, 'messagerie'); ouvrirAsk(id, 'fu', 'Messagerie'); return; }
    if (v === 'bad') { poserStatut(id, 'faux_numero'); fermerAsk(); }
  }
  function reponse2(id, v) {
    var l = leadDe(id);
    if (!l) return;
    if (v === 'rdv') { fermerAsk(); if (typeof openBookingModal === 'function') openBookingModal(l); return; }
    if (v === 'fu') { poserStatut(id, 'follow_up_pm'); ouvrirAsk(id, 'fu', 'Rappel convenu'); return; }
    var map = { talk: 'decroche', no: 'pas_interesse', dq: 'disqualifie', win: 'client' };
    fermerAsk();
    if (map[v]) poserStatut(id, map[v]);
  }

  /* Ouverture automatique après un appel lancé depuis Leads Live : le Dialer
     embarqué prévient la page à la fin de l'appel (dialer:call-ended). Les
     sessions Power / vagues ne passent pas par ces boutons → pas de question
     entre deux appels automatiques. */
  var appelEnCours = null;
  function noterAppel(e) {
    if (!on) return;
    var b = e.target.closest && e.target.closest('.dbr-call-btn');
    if (b) {
      var c = b.closest('.ld-card');
      if (c && c.getAttribute('data-lead-id')) appelEnCours = { id: c.getAttribute('data-lead-id'), t: Date.now() };
      return;
    }
    var d = e.target.closest && e.target.closest('[data-action="dialerCall"]');
    if (d && d.getAttribute('data-lead-id')) appelEnCours = { id: d.getAttribute('data-lead-id'), t: Date.now() };
  }
  window.addEventListener('message', function (evt) {
    if (!on || evt.origin !== window.location.origin) return;
    var data = evt.data;
    if (!data || data.type !== 'dialer:call-ended' || !appelEnCours) return;
    if (Date.now() - appelEnCours.t > 3 * 3600000) { appelEnCours = null; return; }
    if (data.leadId && data.leadId !== appelEnCours.id) return;
    var id = appelEnCours.id;
    appelEnCours = null;
    setTimeout(function () { ouvrirAsk(id); }, 400);
  });

  /* ═══ Écouteurs ══════════════════════════════════════════════════════ */
  /* Phase de capture : avant DialerBridge (qui arrête la propagation sur son
     bouton) et avant le gestionnaire historique (suppression / blacklist). */
  document.addEventListener('click', function (e) {
    if (!on) return;
    noterAppel(e);
    var sens = e.target.closest && e.target.closest('[data-action="deleteLead"],[data-action="blockLead"],[data-action="unblockLead"]');
    if (sens && !estAdmin()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast('🔒 Réservé aux admins');
    }
  }, true);

  document.addEventListener('click', function (e) {
    if (!on) return;
    var t = e.target.closest ? e.target.closest('[data-ll3]') : null;
    if (!t) return;
    var a = t.getAttribute('data-ll3'), id = t.getAttribute('data-id'), v = t.getAttribute('data-v');
    if (a === 'list') {
      liste = v;
      try { localStorage.setItem(LIST_KEY, v); } catch (e2) {}
      if (filterSearch) {
        filterSearch = '';
        var si = l2El('ldSearchInput'); if (si) si.value = '';
        var sw = l2El('ldSearch'); if (sw) sw.classList.remove('has-value');
      }
      renderFeed();
      window.scrollTo(0, 0);
      return;
    }
    if (a === 'rdvkind') { rdvSorte = v; renderFeed(); return; }
    if (a === 'copy') {
      var ok = function () { var o = t.textContent; t.textContent = '✅ Copié'; setTimeout(function () { t.textContent = o; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(ok, function () { toast(v); });
      else toast(v);
      return;
    }
    if (a === 'r1' || a === 'a1') { reponse1(id, v); return; }
    if (a === 'r2') { reponse2(id, v); return; }
    if (a === 'askBack') { ouvrirAsk(id); return; }
    if (a === 'askClose') { fermerAsk(); return; }
    if (a === 'askFu') {
      var cal = l2El('ll3AskCal');
      programmerRappel(id, heureRapide(v), cal ? cal.checked : true);
      fermerAsk();
      return;
    }
    if (a === 'fuq') {
      var body = document.querySelector('.l2body[data-lead-id="' + id + '"]');
      if (!body) return;
      var d = new Date(heureRapide(v));
      var fd = body.querySelector('[data-fu-field="date"]'), ft = body.querySelector('[data-fu-field="time"]');
      var go = body.querySelector('[data-action="addFu"][data-id="' + id + '"]');
      if (!fd || !ft || !go) return;
      fd.value = ymd(d); ft.value = hm(d);
      go.click();
      return;
    }
    if (a === 'openAll') {
      var det = document.querySelector('[data-all="' + id + '"]');
      if (det) { det.open = true; det.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    if (a === 'oldui') {
      try { localStorage.setItem(FORCE_KEY, '0'); } catch (e3) {}
      var u = new URL(window.location.href);
      u.searchParams.delete('v3');
      window.location.href = u.pathname + (u.search ? u.search : '');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (!on || e.key !== 'Escape') return;
    var a = l2El('ll3Ask');
    if (a && a.classList.contains('on')) { e.stopImmediatePropagation(); fermerAsk(); }
  }, true);
  /* Les menus « Plus » de la fiche se referment au clic ailleurs. */
  document.addEventListener('click', function (e) {
    if (!on) return;
    var ouverts = document.querySelectorAll('details.ll3more[open]');
    for (var i = 0; i < ouverts.length; i++) {
      if (!ouverts[i].contains(e.target) || e.target.closest('.ll3menu [data-action], .ll3menu a')) ouverts[i].open = false;
    }
  });

  /* ═══ Éléments fixes de la page ══════════════════════════════════════ */
  function habillerPage() {
    var more = l2El('l2MoreBtn');
    if (more && !l2El('ll3New')) {
      var nb = document.createElement('button');
      nb.type = 'button'; nb.id = 'll3New'; nb.className = 'll3new';
      nb.setAttribute('aria-label', 'Créer une fiche');
      nb.innerHTML = '<span aria-hidden="true">＋</span><span class="t">Nouveau</span>';
      nb.addEventListener('click', function () { if (typeof openCreateLead === 'function') openCreateLead(); });
      more.parentNode.insertBefore(nb, more);
    }
    var menu = l2El('l2Menu');
    if (menu && !l2El('ll3Old')) {
      var ob = document.createElement('button');
      ob.className = 'l2mi'; ob.id = 'll3Old'; ob.type = 'button';
      ob.setAttribute('data-ll3', 'oldui');
      ob.innerHTML = '↩️ <span>Revenir à l’ancienne version</span>';
      var panel = l2El('sharePanel');
      menu.insertBefore(ob, panel || null);
    }
    var ap = l2El('l2fsApply');
    if (ap) ap.textContent = 'Fermer';
    var fb = l2El('l2FiltersBtn');
    if (fb && fb.firstChild && fb.firstChild.nodeType === 3) fb.firstChild.nodeValue = 'Filtres ';
    document.querySelectorAll('#ldFilters .ld-filter[data-status]').forEach(function (b) {
      var k = b.getAttribute('data-status');
      if (k === 'all') return;
      var s = getStatusObj(k);
      b.innerHTML = s.icon + ' ' + escHtml(s.label) + (s.oldLabel && s.oldLabel !== s.label ? ' <small class="ll3old">' + escHtml(s.oldLabel) + '</small>' : '');
    });
    var lbls = document.querySelectorAll('#l2fs .l2fs-l');
    var noms = { 'Attribution': 'Qui s’en occupe', 'Période': 'Arrivés quand', 'Tunnel': 'Par quel tunnel', 'Statut': 'Où il en est' };
    for (var i = 0; i < lbls.length; i++) { var tx = lbls[i].textContent.trim(); if (noms[tx]) lbls[i].textContent = noms[tx]; }
    /* Libellé du bouton de notifications : l'original remplace tout le
       contenu du bouton par l'icône seule et le libellé disparaît du menu. */
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
      try { window.updatePushBtn(('Notification' in window && Notification.permission === 'granted') ? 'granted' : (('Notification' in window) ? 'default' : 'error')); } catch (e4) {}
    }
  }

  /* ═══ Activation ═════════════════════════════════════════════════════ */
  function activer() {
    if (on) return;
    on = true;
    document.body.classList.add('ll3');
    patcherStatuts();
    ancienInfos = window.l2SegInfos;
    window.renderFeed = rendreFile;
    window.renderCard = carte;
    window.l2RenderTriage = rendreListes;
    window.l2RenderSheet = rendreFiche;
    window.l2SheetHeadHTML = entete;
    window.l2SegAction = ongletFaire;
    window.l2SegInfos = ongletDossier;
    window.l2IsMobile = function () { return window.matchMedia('(max-width: 719px)').matches; };
    habillerPage();
    if (typeof allLeads !== 'undefined' && allLeads && allLeads.length) renderFeed();
  }

  peutActiver();
  lireCfg();
  window.LeadsLiveV3 = { actif: function () { return on; }, demander: function (id) { if (on) ouvrirAsk(id); } };
})();
