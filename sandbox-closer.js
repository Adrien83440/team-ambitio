/* ═══════════════════════════════════════════════════════════════════════
   sandbox-closer.js — BAC À SABLE CLOSER : l'application
   ─────────────────────────────────────────────────────────────────────────
   Copie fidèle, mais 100 % locale, du parcours réel du closer :
     ⚡ Leads Live (sales-leads.html) — cartes, fiche, RDV, rail « Parcours
        de close », statuts ;
     📹 Meet simulé — le prospect donne ses conditions pendant l'appel ;
     🎯 Résultat du RDV (rdv-outcome.js) → 🏆 cartes du Close (close-wizard.js) ;
     ✍️ Signatures et 💳 Paiements — les VRAIES pages (sales-signatures.html,
        payments.html), lancées par sandbox-frame.html derrière un pare-feu,
        sur la fausse base (sandbox-db.js) et le vrai code serveur
        (sandbox-server.js) : miroir vivant, refonte du 09/10/2026 ;
     📱 Téléphone du client — SMS / e-mails reçus ; les liens ouvrent la
        VRAIE page de signature (sign.html) ou le mandat GoCardless simulé ;
     🏁 Bilan — ce qui a été bien fait, et ce qui aurait cassé en vrai.
   Seul appel réel : la LECTURE des modèles de contrat (signature_templates)
   au démarrage, pour envoyer les vrais contrats du moment. Aucune écriture.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var X = window.SBX, esc = X.esc, euro = X.euro;

  /* ═══ Référentiels (miroirs des vrais modules) ═══════════════════════ */
  var STATUSES = {
    nouveau: { l: 'Nouveau', i: '🆕', c: '#93c5fd' }, appele: { l: 'Appelé', i: '📞', c: '#93c5fd' },
    decroche: { l: 'Décroché', i: '✅', c: '#6ee7b7' }, messagerie: { l: 'Messagerie', i: '📩', c: '#fbbf24' },
    nrp1: { l: 'NRP 1', i: '📵', c: '#fbbf24' }, nrp2: { l: 'NRP 2', i: '📵', c: '#fbbf24' }, nrp3: { l: 'NRP 3', i: '📵', c: '#fb923c' },
    all_nrp: { l: 'All NRP', i: '🔕', c: '#fb923c' }, faux_numero: { l: 'Faux numéro', i: '⛔', c: '#f87171' }, follow_up_pm: { l: 'Follow Up PM', i: '🔁', c: '#c4b5fd' },
    set: { l: 'SET', i: '🎯', c: '#a78bfa' }, rdv_self_booking: { l: 'RDV Self Booking', i: '📆', c: '#fbbf24' }, rdv_pose: { l: 'RDV posé', i: '📅', c: '#a78bfa' },
    pas_interesse: { l: 'Pas intéressé', i: '👎', c: '#94a3b8' }, disqualifie: { l: 'Disqualifié', i: '🚫', c: '#94a3b8' }, poubelle: { l: 'Poubelle', i: '🗑️', c: '#64748b' },
    client: { l: 'Closing', i: '🏆', c: '#34d399' }
  };
  var FAMILIES = [
    { t: 'Contact', k: ['nouveau', 'appele', 'decroche', 'messagerie'] },
    { t: 'Relances', k: ['nrp1', 'nrp2', 'nrp3', 'all_nrp', 'faux_numero', 'follow_up_pm'] },
    { t: 'Avancée', k: ['set', 'rdv_self_booking', 'rdv_pose'] },
    { t: 'Sortie', k: ['pas_interesse', 'disqualifie', 'poubelle'] }
    /* Plus de ligne « Closing » (09/10/2026) : le gros bouton du pilote la
       remplace, comme dans Leads Live. */
  ];
  var LEAD_TYPES = { vsl_elite: { l: 'VSL ÉLITE', c: '#fbbf24' }, self_booking: { l: 'Self-Booking', c: '#60a5fa' } };
  /* AlteoreFlow.OUTCOMES (alteore-flow.js:26) */
  var OUTCOMES = {
    close: { label: 'Close', icon: '🏆', color: '#34d399', desc: 'Vente conclue — génère les commissions' },
    non_close: { label: 'Non close', icon: '❌', color: '#f87171', desc: 'RDV tenu, offre refusée' },
    offre: { label: 'Offre', icon: '💬', color: '#5b7cfa', desc: 'Offre pitchée — en réflexion / follow-up' },
    disqualifie: { label: 'Disqua', icon: '🚫', color: '#94a3b8', desc: 'Présent mais hors cible — pas d’offre' },
    no_show: { label: 'No-show', icon: '👻', color: '#fbbf24', desc: 'Prospect absent au RDV' },
    annule: { label: 'Annulé', icon: '🔴', color: '#ef4444', desc: 'RDV annulé — lead à récupérer côté Setting' },
    replanifie: { label: 'Replanifié', icon: '📅', color: '#a78bfa', desc: 'Déplacé — un nouveau RDV remplace celui-ci' }
  };
  var OUTCOME_ORDER = ['close', 'non_close', 'offre', 'disqualifie', 'no_show', 'annule', 'replanifie'];
  var PRESENT = { disqualifie: 1, offre: 1, close: 1, non_close: 1 };
  var PITCHED = { offre: 1, close: 1, non_close: 1 };
  var JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  var MOIS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

  /* ═══ État d'interface (jamais persisté) ═════════════════════════════ */
  var ui = {
    view: 'leads', filter: 'all', sheetLead: null, sheetTab: 'action',
    sigTab: 'tpl', modSigTab: 'tpl', payDetail: null, modPayDetail: null,
    module: null, phoneOpen: false, phoneContact: null, phoneBrowser: null,
    knownMsgs: null, meet: null, ro: null, cw: null, send: null, payNew: null, bilanLead: null
  };

  function $(id) { return document.getElementById(id); }
  function S() { return X.load(); }
  function val(id) { var e = $(id); return e ? String(e.value || '').trim() : ''; }
  function toast(msg, ms) {
    var t = $('toast'); t.innerHTML = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, ms || 4200);
  }
  function initials(n) { var p = String(n || '?').split(/\s+/); return ((p[0] || '').charAt(0) + (p[1] || '').charAt(0)).toUpperCase(); }
  function ago(ts) {
    var d = Math.max(0, Date.now() - ts), m = Math.floor(d / 60000);
    if (m < 1) return 'à l\'instant'; if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.floor(m / 60); if (h < 24) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.floor(h / 24) + ' j';
  }
  function when(rdv) { var d = new Date(rdv.date + 'T' + rdv.time + ':00'); return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()]; }
  function show(id, on) { var e = $(id); if (e) e.classList[on === false ? 'remove' : 'add']('show'); }
  function store() { return window.__SBX_STORE; }

  /* ═══ Rail « Parcours de close » (sales-leads.html ldCloseSteps) ═════ */
  function closeSteps(s, l) {
    var sigs = X.leadSigs(l.id), pays = X.leadPays(l.id);
    var signed = sigs.some(function (x) { return x.status === 'signed'; });
    var mandat = pays.some(function (p) { return p.status === 'active' || p.status === 'mandate_active' || p.status === 'completed'; });
    var held = !!PRESENT[l.rdv.outcome], pitched = !!PITCHED[l.rdv.outcome];
    return [
      { k: 'rdv', l: 'RDV tenu', done: held, hint: 'statue le RDV ci-dessous' },
      { k: 'offre', l: 'Offre pitchée', done: pitched, hint: 'résultat « Offre » ou « Close »' },
      { k: 'contrat', l: 'Contrat envoyé', done: sigs.length > 0, act: 'sig', actLabel: 'Envoyer' },
      { k: 'signe', l: 'Signé', done: signed, act: sigs.length && !signed ? 'sig' : null, actLabel: 'Relancer' },
      { k: 'pay', l: 'Paiement créé', done: pays.length > 0, act: 'pay', actLabel: 'Créer' },
      { k: 'mandat', l: 'Mandat actif', done: mandat, act: pays.length && !mandat ? 'pay' : null, actLabel: 'Suivre' },
      { k: 'close', l: 'Close', done: !!l.isClient, hint: 'cartes du Close sur le RDV' }
    ];
  }

  /* ═══ RENDU GLOBAL ═══════════════════════════════════════════════════ */
  function renderAll() {
    var navs = document.querySelectorAll('[data-a="view"]');
    for (var i = 0; i < navs.length; i++) navs[i].classList.toggle('on', navs[i].getAttribute('data-v') === ui.view);
    renderMain(); renderSheet(); renderModule(); renderPhone(); renderBadge();
  }
  function renderMain() {
    if (ui.view === 'sig' || ui.view === 'pay') {
      var src = mirrorSrc(ui.view === 'sig' ? 'sales-signatures.html' : 'payments.html', {});
      var fr = $('main').querySelector('iframe.mirror');
      if (fr && fr.getAttribute('data-src') === src) return;
      $('main').innerHTML = '<div class="mirror-wrap">' + mirrorFrame(src) + '</div>';
      guardFrame($('main').querySelector('iframe.mirror'));
      return;
    }
    $('main').innerHTML = leadsHTML();
  }

  /* ═══ LEADS LIVE ═════════════════════════════════════════════════════ */
  function leadsHTML() {
    var s = S();
    var h = '<div class="vh"><div class="vh-ic ll-ic">⚡</div><div><h1>Leads Live</h1><small>Les leads entrants, en temps réel · ' + s.leads.length + ' leads</small></div></div>';
    h += '<div class="ll-filters">'
      + '<button class="chipf' + (ui.filter === 'all' ? ' on' : '') + '" data-a="filter" data-f="all">Tous</button>'
      + '<button class="chipf' + (ui.filter === 'rdv' ? ' on' : '') + '" data-a="filter" data-f="rdv">📅 RDV du jour</button>'
      + '<button class="chipf' + (ui.filter === 'client' ? ' on' : '') + '" data-a="filter" data-f="client">🏆 Closing</button></div>';
    var list = s.leads.filter(function (l) {
      if (ui.filter === 'rdv') return !l.isClient;
      if (ui.filter === 'client') return !!l.isClient;
      return true;
    });
    if (!list.length) return h + '<div class="empty"><div class="i">🗂️</div>Aucun lead dans ce filtre.</div>';
    h += '<div class="ll-grid">';
    list.forEach(function (l) {
      var st = STATUSES[l.status] || STATUSES.nouveau, ty = LEAD_TYPES[l.type];
      var steps = closeSteps(s, l), done = steps.filter(function (x) { return x.done; }).length;
      var last = l.timeline[l.timeline.length - 1];
      h += '<div class="lcard' + (ui.sheetLead === l.id ? ' sel' : '') + '" data-a="openLead" data-id="' + l.id + '">';
      h += '<div class="lc-top"><div class="av" style="background:' + (l.setter ? 'linear-gradient(135deg,#7c3aed,#a78bfa)' : 'linear-gradient(135deg,#475569,#64748b)') + '" title="' + esc(l.setter ? 'Setter : ' + l.setter.name : 'Aucun setter — Self Booking') + '">' + (l.setter ? initials(l.setter.name) : '—') + '</div>';
      h += '<div class="lc-name">' + esc(l.nom) + '</div><div class="lc-ago">' + ago(l.createdAt) + '</div></div>';
      h += '<div class="lc-tags">';
      h += '<span class="pill" style="color:' + ty.c + ';border-color:' + ty.c + '55">' + esc(ty.l) + '</span>';
      h += '<span class="pill" style="color:' + (l.sb ? '#fbbf24' : '#a78bfa') + ';border-color:' + (l.sb ? 'rgba(251,191,36,.4)' : 'rgba(167,139,250,.4)') + '">' + (l.sb ? 'Self Booking' : 'No Booking') + '</span>';
      h += '<span class="pill" style="color:' + st.c + ';border-color:' + st.c + '55">' + st.i + ' ' + esc(st.l) + '</span>';
      h += '<span class="pill" style="color:#fbbf24">★ ' + l.leadScore + '</span>';
      if (l.random) h += '<span class="pill" style="color:#f0abfc;border-color:rgba(240,171,252,.4)" title="Profil tiré au hasard à chaque réinitialisation">🎲 Aléatoire</span>';
      h += '</div>';
      h += '<div class="lc-last">' + esc(last ? last.txt : '') + '</div>';
      h += '<div class="lc-foot"><span class="lc-rdv">📅 ' + (l.rdv.past ? 'RDV tenu' : 'RDV ' + esc(when(l.rdv)) + ' ' + esc(l.rdv.time)) + '</span>';
      h += '<button class="btn-q" data-a="quickStatus" data-id="' + l.id + '">⚡ Statut rapide</button></div>';
      h += '<div class="lc-prog" title="Parcours de close : ' + done + '/7"><i style="width:' + Math.round(100 * done / 7) + '%"></i></div>';
      h += '</div>';
    });
    return h + '</div>';
  }

  /* ── Fiche lead ── */
  function openLead(id, tab) {
    ui.sheetLead = id; ui.sheetTab = tab || ui.sheetTab || 'action';
    if (!ui.phoneBrowser && (!ui.phoneContact || ui.phoneContact.indexOf(id + ':') !== 0)) { ui.phoneContact = id + ':main'; renderPhone(true); }
    show('sheetBg'); show('sheet'); renderAll();
  }
  function closeSheet() { ui.sheetLead = null; show('sheetBg', false); show('sheet', false); renderMain(); }

  function renderSheet() {
    if (!ui.sheetLead) return;
    var s = S(), l = X.leadById(s, ui.sheetLead);
    if (!l) { closeSheet(); return; }
    var body = $('sheet').querySelector('.sh-body');
    var scroll = body ? body.scrollTop : 0;
    var h = '<div class="sh-head"><div class="sh-top"><div class="av" style="width:42px;height:42px;font-size:14px;background:linear-gradient(135deg,#b91c1c,#f97316)">' + initials(l.nom) + '</div>';
    h += '<div style="min-width:0"><div class="sh-name">' + esc(l.nom) + '</div><div class="sh-sub"><a data-a="nosim" data-m="call">📞 ' + esc(X.fmtPhone(l.telephone)) + '</a><span>✉️ ' + esc(l.email) + '</span></div></div>';
    h += '<button class="sh-x" data-a="sheetClose" title="Fermer">✕</button></div>';
    h += '<div class="sh-acts"><button class="sh-act" data-a="nosim" data-m="call">📞 Appeler</button><button class="sh-act" data-a="nosim" data-m="sms">💬 SMS</button><button class="sh-act" data-a="nosim" data-m="rdv">📅 RDV</button><button class="sh-act" data-a="nosim" data-m="crm">📋 Fiche CRM</button><button class="sh-act" data-a="phoneTo" data-c="' + l.id + ':main" style="border-color:rgba(245,158,11,.4);color:#fde68a">📱 Téléphone du client</button><button class="sh-act" data-a="resetLead" data-id="' + l.id + '" style="margin-left:auto;border-color:rgba(245,158,11,.4);color:#fde68a">↺ Recommencer ce lead</button></div>';
    h += '<div class="sh-tabs">' + tabBtn('action', '⚡ Action') + tabBtn('infos', '👤 Infos') + tabBtn('ech', '💬 Échanges') + '</div></div>';
    h += '<div class="sh-body">';
    if (ui.sheetTab === 'infos') h += sheetInfos(l);
    else if (ui.sheetTab === 'ech') h += sheetEch(s, l);
    else h += sheetAction(s, l);
    h += '</div>';
    $('sheet').innerHTML = h;
    var cpHost = $('sheet').querySelector('[data-cp-host]');
    if (cpHost && window.ClosePilot) window.ClosePilot.paint(l.id, cpHost);
    var nb = $('sheet').querySelector('.sh-body'); if (nb) nb.scrollTop = scroll;
  }
  function tabBtn(k, lbl) { return '<button class="sh-tab' + (ui.sheetTab === k ? ' on' : '') + '" data-a="sheetTab" data-t="' + k + '">' + lbl + '</button>'; }

  function sheetAction(s, l) {
    var r = l.rdv, h = '';
    /* Bloc RDV (paintLeadRdvBox) */
    h += '<div class="blk"><div class="blk-t">📅 Rendez-vous</div>';
    h += '<div class="ld-rdvx-row' + (r.past ? ' past' : '') + '">';
    h += '<span class="ld-rdvx-when">' + esc(when(r)) + ' <span class="d">à</span> ' + esc(r.time) + '</span>';
    if (r.outcome) { var o = OUTCOMES[r.outcome]; h += '<span class="oc-chip" style="color:' + o.color + ';border-color:' + o.color + '66;background:' + o.color + '14">' + o.icon + ' ' + o.label + '</span>'; }
    h += '<span class="oc-chip" style="color:' + (l.sb ? '#fbbf24' : '#a78bfa') + ';border-color:' + (l.sb ? 'rgba(251,191,36,.4)' : 'rgba(167,139,250,.4)') + '">' + (l.sb ? 'SB' : 'NB') + '</span>';
    h += '<span class="ld-rdvx-meta">' + esc(r.typeName) + ' · ' + esc(r.personName) + (r.outcomeNote ? ' — <em>' + esc(r.outcomeNote) + '</em>' : '') + '</span>';
    h += '</div><div class="ld-rdvx-row" style="padding-top:0">';
    h += '<button class="ld-rdvx-btn meet" data-a="meet" data-id="' + l.id + '" title="Rejoindre la visio">📹 Meet</button>';
    h += '<button class="ld-rdvx-btn ghost" data-a="copyMeet" data-id="' + l.id + '" title="Copier le lien de la visio">📋</button>';
    h += '<button class="ld-rdvx-btn ghost" data-a="nosim" data-m="ia">📋 Dossier IA</button>';
    if (r.past) h += '<button class="ld-rdvx-btn" data-a="outcome" data-id="' + l.id + '">' + (r.outcome ? '✎ Modifier' : '🎯 Résultat') + '</button>';
    else h += '<button class="ld-rdvx-btn ghost" data-a="nosim" data-m="resched">📅 Replanifier</button><button class="ld-rdvx-btn ghost" data-a="outcome" data-id="' + l.id + '">🎯 Statut</button>';
    h += '</div><div class="ld-rdvx-info">⏱ 45 min · Europe/Paris' + (l.sb ? ' · réservé par le prospect' : ' · posé par ' + esc(l.setter.name)) + '<div class="url">' + esc(r.meetLink) + '</div></div></div>';

    /* Pilote de closing (close-pilot.js) — comme Leads Live quand
       _config/sales_close_pilot.enabled est actif : le gros bouton remplace
       le rail « Parcours de close ». Peint par renderSheet. */
    h += '<div data-cp-host="' + l.id + '"></div>';

    /* Statut */
    h += '<div class="blk"><div class="blk-t">Statut</div>';
    FAMILIES.forEach(function (f) {
      h += '<div class="st-fam"><div class="st-fam-t">' + f.t + '</div><div class="st-grid">';
      f.k.forEach(function (k) { var st = STATUSES[k]; h += '<button class="st-b' + (l.status === k ? ' on' : '') + (k === 'client' ? ' win' : '') + '" data-a="setStatus" data-id="' + l.id + '" data-s="' + k + '">' + st.i + ' ' + esc(st.l) + '</button>'; });
      h += '</div></div>';
    });
    h += '</div>';
    h += '<div class="blk"><div class="blk-t">⭐ Qualité du lead</div><span class="stars">' + new Array(l.leadScore + 1).join('★') + '<span style="opacity:.25">' + new Array(6 - l.leadScore).join('★') + '</span></span></div>';
    h += '<div class="blk"><div class="blk-t">📝 Notes <button class="ld-rail-btn ghost r" data-a="addNote" data-id="' + l.id + '">+ Ajouter</button></div>';
    if (!l.notes.length) h += '<div style="font-size:12px;color:var(--muted)">Aucune note.</div>';
    l.notes.slice().reverse().forEach(function (n) { h += '<div class="note"><small>' + esc(n.by) + ' · ' + X.frDate(n.at) + ' ' + X.frTime(n.at) + '</small>' + esc(n.txt) + '</div>'; });
    return h + '</div>';
  }
  function sheetInfos(l) {
    function row(k, v) { return '<div class="k">' + k + '</div><div class="v">' + esc(v || '—') + '</div>'; }
    var h = '<div class="blk"><div class="kv">';
    h += row('Nom', l.nom) + row('Téléphone', X.fmtPhone(l.telephone)) + row('Email', l.email) + row('Entreprise', l.entreprise);
    h += row('UTM / Source', l.source + ' · ' + l.utm) + row('🧭 Tunnel', l.tunnel) + row('Secteur', l.secteur) + row('CA actuel', l.ca);
    h += row('Défi', l.defi) + row('Dispo', l.dispo) + row('Mise en place', l.timeline) + row('Entrée initiale', LEAD_TYPES[l.type].l);
    h += row('Reçu le', X.frDate(l.createdAt) + ' à ' + X.frTime(l.createdAt)) + row('Setter', l.setter ? l.setter.name : 'Aucun (Self Booking)');
    h += '</div></div><div class="blk"><div class="blk-t">🧩 Réponses au quiz</div>';
    l.quiz.forEach(function (q) { h += '<div style="margin-bottom:8px"><div style="font-size:11.5px;color:var(--muted)">' + esc(q.q) + '</div><div style="font-size:13px;font-weight:600">' + esc(q.a) + '</div></div>'; });
    return h + '</div>';
  }
  function sheetEch(s, l) {
    var h = '<div class="blk"><div class="blk-t">📹 Notes de l\'appel Meet</div>';
    if (!l.call.done) h += '<div style="font-size:12px;color:var(--muted)">Pas encore d\'appel. Rejoins le RDV avec 📹 Meet.</div>';
    else l.call.lines.forEach(function (x) { h += '<div class="bub ' + x.who + '">' + esc(x.t) + '</div>'; });
    h += '</div><div class="blk"><div class="blk-t">🕓 Historique</div>';
    l.timeline.slice().reverse().forEach(function (t) { h += '<div class="tl-it"><span class="d">' + X.frDate(t.at) + ' ' + X.frTime(t.at) + '</span><span>' + esc(t.txt) + '</span></div>'; });
    return h + '</div>';
  }

  function setStatus(id, k) {
    if (k === 'client') { startPilot(id); return; }
    X.update(function (s) { var l = X.leadById(s, id); if (!l || l.status === k) return; l.status = k; X.log(s, id, 'status', '→ Statut ' + STATUSES[k].i + ' ' + STATUSES[k].l); });
    renderAll();
  }
  function quickStatus(id) {
    var s = S(), l = X.leadById(s, id), keys = ['nrp1', 'nrp2', 'nrp3', 'messagerie', 'set', 'pas_interesse'];
    var h = '<div class="mo-h"><b>⚡ Statut rapide<small>' + esc(l.nom) + '</small></b><button class="mo-x" data-a="formClose">✕</button></div><div class="mo-b"><div class="st-grid">';
    keys.forEach(function (k) { var st = STATUSES[k]; h += '<button class="st-b' + (l.status === k ? ' on' : '') + (k === 'client' ? ' win' : '') + '" data-a="setStatusQ" data-id="' + id + '" data-s="' + k + '">' + st.i + ' ' + esc(st.l) + '</button>'; });
    h += '</div></div>';
    openForm(h);
  }

  /* ═══ MEET SIMULÉ ════════════════════════════════════════════════════ */
  function openMeet(id) {
    var s = S(), l = X.leadById(s, id);
    if (!l) return;
    var replay = l.call.done;
    if (!replay) X.update(function (st) { var x = X.leadById(st, id); if (!x.call.startedAt) { x.call.startedAt = Date.now(); X.log(st, id, 'meet', '📹 Meet rejoint'); } });
    ui.meet = { id: id, i: replay ? l.call.lines.length : 0, t0: Date.now(), typing: false, mic: true, cam: true, replay: replay, timers: [] };
    show('meet'); renderMeet(); if (!replay) meetStep();
    ui.meet.clock = setInterval(function () { var c = $('meetClock'); if (c && ui.meet) { var sec = Math.floor((Date.now() - ui.meet.t0) / 1000); c.textContent = X.pad2(Math.floor(sec / 60)) + ':' + X.pad2(sec % 60); } }, 1000);
  }
  function meetStep() {
    var m = ui.meet; if (!m) return;
    var l = X.leadById(S(), m.id);
    if (m.i >= l.call.lines.length) return;
    m.typing = l.call.lines[m.i].who === 'p'; renderMeet();
    m.timers.push(setTimeout(function () {
      if (!ui.meet) return; m.typing = false; m.i++; renderMeet();
      m.timers.push(setTimeout(meetStep, 900));
    }, l.call.lines[m.i].who === 'p' ? 1700 : 900));
  }
  function renderMeet() {
    var m = ui.meet; if (!m) return;
    var l = X.leadById(S(), m.id), lines = l.call.lines.slice(0, m.i), fin = m.i >= l.call.lines.length;
    var h = '<div class="meet-top"><span style="font-weight:600">' + esc(l.rdv.typeName) + '</span><span class="u">' + esc(l.rdv.meetLink.replace('https://', '')) + '</span><span class="tag">BAC À SABLE</span><span style="margin-left:auto;color:#9aa0a6">' + (m.replay ? 'Relecture de l\'appel' : 'Appel simulé') + '</span></div>';
    h += '<div class="meet-mid"><div class="meet-stage"><div class="meet-av' + (m.typing ? ' talk' : '') + '">' + initials(l.nom) + '</div><div class="meet-nm">' + esc(l.nom) + (m.typing ? ' · parle…' : '') + '</div><div class="meet-me">' + (m.cam ? 'Toi' : '📷 Caméra coupée') + (m.mic ? '' : ' · 🔇') + '</div></div>';
    h += '<div class="meet-side"><h3>💬 Ce que dit ' + esc(l.prenom) + '</h3><div class="sub">Retiens bien les conditions du client : tu devras les reporter toi-même dans le contrat, le paiement et les cartes du Close.</div><div class="meet-tr" id="meetTr">';
    lines.forEach(function (x) { h += '<div class="mt ' + x.who + '"><b>' + (x.who === 'p' ? esc(l.prenom) : 'Toi') + '</b>' + esc(x.t) + '</div>'; });
    if (m.typing) h += '<div class="mt typing">' + esc(l.prenom) + ' parle…</div>';
    if (fin) h += '<div class="mt" style="background:#e8f0fe;border-radius:10px;padding:8px 10px;color:#174ea6"><b style="color:#174ea6">Fin de l\'échange</b>Le client est d\'accord. Quitte l\'appel, saisis le résultat du RDV puis déroule le parcours de close.</div>';
    h += '</div></div></div>';
    h += '<div class="meet-bar"><span class="meet-clock" id="meetClock">00:00</span>';
    h += '<button class="mbtn' + (m.mic ? '' : ' off') + '" data-a="meetMic" title="Micro">' + (m.mic ? '🎤' : '🔇') + '</button>';
    h += '<button class="mbtn' + (m.cam ? '' : ' off') + '" data-a="meetCam" title="Caméra">📷</button>';
    if (!fin) h += '<button class="mbtn fast" data-a="meetFast">⏩ Accélérer</button>';
    h += '<button class="mbtn end" data-a="meetEnd" title="Quitter l\'appel">📵</button></div>';
    $('meet').innerHTML = h;
    var tr = $('meetTr'); if (tr) tr.scrollTop = tr.scrollHeight;
  }
  function endMeet() {
    var m = ui.meet; if (!m) return;
    m.timers.forEach(clearTimeout); clearInterval(m.clock);
    var id = m.id, dur = Math.round((Date.now() - m.t0) / 1000);
    if (!m.replay) X.update(function (s) {
      var l = X.leadById(s, id);
      l.call.done = true; l.call.endedAt = Date.now(); l.rdv.past = true;
      X.log(s, id, 'meet_end', '📵 Meet terminé (' + Math.floor(dur / 60) + ' min ' + (dur % 60) + ' s) — notes d\'appel dans « Échanges »');
    });
    ui.meet = null; show('meet', false);
    openLead(id, 'action');
    if (!m.replay) toast('📵 Appel terminé — saisis maintenant le <strong>résultat du RDV</strong> (🎯 Résultat). Les notes de l\'appel restent dans l\'onglet 💬 Échanges.', 6500);
  }

  /* ═══ MODALES — couches ══════════════════════════════════════════════ */
  function openForm(html) { $('moFormIn').innerHTML = html; show('moForm'); }
  function closeForm() { show('moForm', false); $('moFormIn').innerHTML = ''; ui.ro = null; ui.send = null; ui.payNew = null; if (ui.cw && !ui.cw.finished && !ui.cw.closing) toast('Cartes fermées — <strong>rien n\'a été enregistré</strong>. Repasse le lead en Closing pour reprendre.'); ui.cw = null; }
  function openTop(html) { $('moTopIn').innerHTML = html; show('moTop'); }
  function closeTop() { show('moTop', false); $('moTopIn').innerHTML = ''; ui.bilanLead = null; }

  /* ═══ RÉSULTAT DU RDV (rdv-outcome.js) ═══════════════════════════════ */
  function openOutcome(id) {
    var l = X.leadById(S(), id);
    ui.ro = { id: id, sel: l.rdv.outcome || null };
    renderOutcome();
  }
  function renderOutcome() {
    var r = ui.ro, l = X.leadById(S(), r.id);
    var h = '<div class="mo-h"><b>🎯 Résultat du RDV<small>' + esc(l.nom) + ' · ' + esc(when(l.rdv)) + ' ' + esc(l.rdv.time) + '</small></b><button class="mo-x" data-a="formClose">✕</button></div><div class="mo-b"><div class="ro-grid">';
    OUTCOME_ORDER.forEach(function (k) { var o = OUTCOMES[k]; h += '<button class="ro-opt' + (r.sel === k ? ' sel' : '') + '" style="--oc:' + o.color + '" data-a="roPick" data-k="' + k + '"><div class="i">' + o.icon + '</div><div class="l">' + o.label + '</div><div class="d">' + esc(o.desc) + '</div></button>'; });
    h += '</div><div class="ro-extra">';
    if (r.sel === 'non_close') h += '<div class="lb">Raison du non-close</div><textarea class="in" id="roNote" rows="2"></textarea>';
    else if (r.sel === 'annule') h += '<div class="lb">Annulé par</div><div class="cw-chips"><button class="cw-chip">👤 Le prospect</button><button class="cw-chip">👥 L\'équipe</button></div><div class="lb">Raison</div><textarea class="in" id="roNote" rows="2"></textarea>';
    else if (r.sel && r.sel !== 'close') h += '<div class="lb">Note (facultatif)</div><textarea class="in" id="roNote" rows="2"></textarea>';
    else if (r.sel === 'close') h += '<div class="cw-comm">🏆 Enregistrer ouvre les <strong>cartes du Close</strong> : contrat, paiement, booking, coach, encaissé.</div>';
    h += '</div></div><div class="mo-f">';
    if (l.rdv.outcome) h += '<button class="b b-gh" data-a="roReset" style="margin-right:auto">↩︎ Réinitialiser</button>';
    h += '<button class="b b-gh" data-a="formClose">Annuler</button><button class="b b-ok" data-a="roSave">Enregistrer</button></div>';
    openForm(h);
  }
  function saveOutcome() {
    var r = ui.ro; if (!r) return;
    if (!r.sel) { toast('Choisis un résultat.'); return; }
    if (r.sel === 'close') { var id = r.id; ui.ro = null; closeForm(); startPilot(id); return; }
    if (r.sel === 'replanifie') { toast('📅 La replanification ouvre l\'agenda en production — non simulée dans le bac à sable.'); return; }
    var note = val('roNote'), k = r.sel, lid = r.id;
    X.update(function (s) {
      var l = X.leadById(s, lid); l.rdv.outcome = k; l.rdv.outcomeNote = note; l.rdv.past = true;
      X.log(s, lid, 'outcome_' + k, '🎯 Résultat du RDV : ' + OUTCOMES[k].icon + ' ' + OUTCOMES[k].label + (note ? ' — ' + note : ''));
    });
    closeForm(); renderAll();
    toast('✅ Résultat enregistré : ' + OUTCOMES[k].icon + ' ' + OUTCOMES[k].label);
  }

  /* « Close » d'un RDV / statut Closing → pilote de closing, comme en
     production quand _config/sales_close_pilot est actif (close-wizard.js
     renvoie alors au pilote). Les cartes restent le secours sans pilote. */
  function startPilot(id) {
    if (!window.ClosePilot) { openWizard(id); return; }
    var b = document.createElement('button');
    b.setAttribute('data-cp', 'start');
    b.setAttribute('data-cp-lead', id);
    window.ClosePilot.handle(b);
  }

  /* ═══ CARTES DU CLOSE (close-wizard.js) ══════════════════════════════ */
  var CW_STEPS = ['contrat', 'paiement', 'booking', 'coach', 'encaisse'];
  function openWizard(id) {
    var l = X.leadById(S(), id);
    ui.ro = null;
    ui.cw = { id: id, step: 0, sbSuggest: l.sb, finished: false, a: { contrat: null, paiement: null, booking: l.sb ? 'sb' : 'nb', coachSlug: null, coachNom: null, encaisse: null } };
    renderWizard();
  }
  function cwPay() { var c = ui.cw, oc = X.PRICING[c.a.contrat]; if (!oc) return null; return c.a.paiement === 'pif' ? oc.pif : oc.mensualise; }
  function cwOpt(field, v, ic, lb, pr) { return '<button class="cw-opt' + (ui.cw.a[field] === v ? ' sel' : '') + '" data-a="cwPick" data-f="' + field + '" data-v="' + v + '"><span class="ic">' + ic + '</span><span class="lb2">' + lb + '</span><div class="pr">' + pr + '</div></button>'; }
  function renderWizard() {
    var c = ui.cw, l = X.leadById(S(), c.id), key = CW_STEPS[c.step], h = '', title = '';
    if (key === 'contrat') {
      title = 'Close — contrat signé';
      h += '<div class="cw-q">Quel type de contrat a été signé ?</div><div class="cw-opts">' + cwOpt('contrat', 'Elite', '👑', 'ELITE', 'PIF 12 000 € HT<br>MENS 13 000 € HT (≤ 4×)') + cwOpt('contrat', 'Business', '🚀', 'BUSINESS', 'PIF 5 000 € HT<br>MENS 6 000 € HT (≤ 10×)') + '</div>';
    } else if (key === 'paiement') {
      title = 'Close — paiement';
      var oc = X.PRICING[c.a.contrat];
      h += '<div class="cw-q">Paiement intégral ou mensualisé ?</div><div class="cw-opts">' + cwOpt('paiement', 'pif', '💎', 'PIF', euro(oc.pif.contracte) + ' HT comptant') + cwOpt('paiement', 'mensualise', '📅', 'MENS', euro(oc.mensualise.contracte) + ' HT · jusqu\'à ' + oc.mensualise.maxX + ' fois') + '</div>';
    } else if (key === 'booking') {
      title = 'Close — booking';
      h += '<div class="cw-q">Le prospect venait de quel booking ?<small>Self Booking = il a pris son RDV seul · No Booking = travaillé par le setting</small></div><div class="cw-opts">' + cwOpt('booking', 'sb', '🔗', 'SELF BOOKING', 'commission setting SB') + cwOpt('booking', 'nb', '📞', 'NO BOOKING', 'commission setting NB') + '</div>';
      h += '<div class="cw-sugg">💡 Suggestion : ' + (c.sbSuggest ? 'Self Booking' : 'No Booking') + ' (détecté depuis le RDV)</div>';
    } else if (key === 'coach') {
      title = 'Close — coach référent';
      h += '<div class="cw-q">Qui sera le coach référent ?<small>Il est prévenu sur WhatsApp dès la confirmation, et c\'est lui qui rejoindra le groupe de suivi.</small></div><div class="cw-chips">';
      X.COACHS.forEach(function (co) { h += '<button class="cw-chip' + (c.a.coachSlug === co.slug ? ' sel' : '') + '" data-a="cwCoach" data-s="' + co.slug + '" data-n="' + esc(co.nom) + '">🎓 ' + esc(co.nom) + '</button>'; });
      h += '</div><div class="cw-hint">Le coach peut aussi être décidé plus tard, depuis le plan d\'action.</div>';
    } else {
      title = 'Close — encaissé & signature';
      var pc = cwPay(), offre = X.PRICING[c.a.contrat].commOffre;
      var cComm = X.COMM.closing[offre] || 0, cBonus = c.a.paiement === 'pif' ? (X.COMM.pifBonus[offre] || 0) : 0, sComm = (X.COMM.setting[offre] || {})[c.a.booking] || 0;
      h += '<div class="cw-chips" style="margin-bottom:14px">'
        + '<button class="cw-chip sel" data-a="cwGoto" data-g="0">' + (c.a.contrat === 'Elite' ? '👑 Elite' : '🚀 Business') + '<small>✎</small></button>'
        + '<button class="cw-chip sel" data-a="cwGoto" data-g="1">' + (c.a.paiement === 'pif' ? '💎 PIF' : '📅 MENS') + '<small>✎</small></button>'
        + '<button class="cw-chip sel" data-a="cwGoto" data-g="2">' + (c.a.booking === 'sb' ? '🔗 Self Booking' : '📞 No Booking') + '<small>✎</small></button>'
        + '<button class="cw-chip' + (c.a.coachNom ? ' sel' : '') + '" data-a="cwGoto" data-g="3">' + (c.a.coachNom ? '🎓 ' + esc(c.a.coachNom) : '🎓 Coach à décider') + '<small>✎</small></button></div>';
      h += '<div class="cw-q">Combien a été encaissé à la signature ? <small>Montant HT — ' + (c.a.paiement === 'pif' ? 'PIF : la totalité' : '1ʳᵉ échéance (mensualité)') + '. La vérité du cash reste le module Paiements, le funnel croisera.</small></div><div class="cw-chips">';
      pc.encaisse.forEach(function (v) { h += '<button class="cw-chip' + (c.a.encaisse === v ? ' sel' : '') + '" data-a="cwEnc" data-v="' + v + '">' + euro(v) + (c.a.paiement === 'mensualise' ? '<small>(' + Math.round(pc.contracte / v) + '×)</small>' : '') + '</button>'; });
      var free = c.a.encaisse != null && pc.encaisse.indexOf(c.a.encaisse) < 0 ? c.a.encaisse : '';
      h += '</div><div class="cw-input-row"><input class="in" id="cwEnc" type="number" min="0" step="50" placeholder="Autre montant HT…" value="' + free + '" style="font-weight:700"><span style="font-weight:800">€ HT</span></div>';
      h += '<div class="cw-hint">Contracté auto : <strong>' + euro(pc.contracte) + ' HT</strong> · ⚡ Commissions — Closing <strong>' + euro(cComm) + '</strong>' + (cBonus ? ' + prime PIF <strong>' + euro(cBonus) + '</strong>' : '') + ' · Setting ' + (c.a.booking === 'sb' ? 'SB' : 'NB') + ' <strong>' + euro(sComm) + '</strong> (validées à l\'encaissement)</div>';
      if (l.isClient) h += '<div class="cw-warn" style="margin-top:8px">⚠ Cette fiche est déjà marquée client — confirmer mettra à jour le close (aucune commission ne sera dupliquée).</div>';
    }
    var dots = ''; for (var i = 0; i < CW_STEPS.length; i++) dots += '<div class="cw-dot' + (i < c.step ? ' done' : (i === c.step ? ' on' : '')) + '"></div>';
    var f = c.step > 0 ? '<button class="b b-gh" data-a="cwBack">← Retour</button>' : '<span></span>';
    if (key === 'encaisse') f += '<button class="b b-ok" id="cwConfirm" data-a="cwConfirm"' + (c.a.encaisse == null ? ' disabled' : '') + '>✅ Confirmer le close</button>';
    else if (key === 'coach') f += '<button class="b b-gh" data-a="cwSkip">Décider plus tard →</button>';
    else f += '<span></span>';
    openForm('<button class="mo-x" data-a="formClose" style="position:absolute;top:10px;right:12px">✕</button><div class="mo-h" style="display:block"><b style="display:flex;gap:8px">🏆 <span>' + title + '</span></b><div style="font-size:11px;color:#8d93a8;margin-top:3px">' + esc(l.nom) + ' · RDV ' + esc(l.rdv.date.split('-').reverse().join('/')) + ' ' + esc(l.rdv.time) + '</div><div class="cw-dots">' + dots + '</div></div><div class="cw-body">' + h + '</div><div class="cw-foot">' + f + '</div>');
  }
  function cwAdvance() {
    var c = ui.cw;
    c.step = Math.min(c.step + 1, CW_STEPS.length - 1);
    if (CW_STEPS[c.step] === 'encaisse' && c.a.paiement === 'pif' && cwPay()) c.a.encaisse = cwPay().contracte;
    renderWizard();
  }
  function cwConfirm() {
    var c = ui.cw; if (!c || c.a.encaisse == null) return;
    var a = c.a, id = c.id;
    X.update(function (s) {
      var l = X.leadById(s, id);
      var upd = !!l.isClient;
      l.close = { contrat: a.contrat, paiement: a.paiement, booking: a.booking, coachSlug: a.coachSlug, coachNom: a.coachNom, encaisse: a.encaisse, contracte: cwPay().contracte, at: Date.now() };
      l.isClient = true; l.status = 'client'; l.stage = a.booking === 'sb' ? 'closed_won_self' : 'closed_won_setting';
      l.rdv.outcome = 'close'; l.rdv.past = true;
      X.log(s, id, 'close', '🏆 Close ' + (upd ? 'mis à jour' : 'confirmé') + ' — ' + a.contrat + ' ' + (a.paiement === 'pif' ? 'PIF' : 'MENS') + ' · encaissé ' + euro(a.encaisse) + ' HT' + (a.coachNom ? ' · coach ' + a.coachNom : ''));
    });
    c.finished = true;
    var l = X.leadById(S(), id);
    var h = '<div class="mo-h"><b>🏆 Client gagné !</b><button class="mo-x" data-a="formClose">✕</button></div><div class="cw-body"><div class="cw-done"><div class="big">🎉</div><div class="t">' + esc(l.nom) + ' est client(e)</div>';
    h += '<div class="d">Résultat « Close » posé sur le RDV.<br>Fiche passée en <strong>Closing</strong> · 2 commission(s) créée(s) automatiquement <em>(simulé)</em> · encaissé déclaré <strong>' + euro(a.encaisse) + ' HT</strong></div>';
    h += a.coachNom ? '<div class="cw-comm" style="margin-bottom:12px">🎓 Coach référent : <strong>' + esc(a.coachNom) + '</strong> — prévenu sur WhatsApp <em>(simulé)</em>.<br>Le groupe de suivi se crée depuis la fiche du client, quand tu veux.</div>' : '<div class="cw-warn" style="margin-bottom:12px">Aucun coach attribué — à faire depuis le plan d\'action.</div>';
    h += '<button class="b b-pri" data-a="module" data-k="pay" data-id="' + id + '" data-new="1" style="margin:0 5px 8px">💳 Créer le paiement GoCardless</button><button class="b b-gh" data-a="formClose">Fermer</button>';
    h += '<div class="cw-hint" style="margin-top:10px">Le module Paiements est la vérité du cash — le funnel croise automatiquement encaissé déclaré ↔ prélèvements réels.</div></div></div>';
    openForm(h);
    renderAll();
  }

  /* ═══ LES VRAIES PAGES (miroir vivant) ══════════════════════════════
     sales-signatures.html et payments.html tournent tels quels dans un
     cadre sandbox-frame.html : pare-feu, fausse base, vrai code serveur. */
  function mirrorSrc(page, params) {
    var q = new URLSearchParams(params || {}); q.set('page', page);
    return 'sandbox-frame.html?' + q.toString();
  }
  function mirrorFrame(src) { return '<iframe class="mirror" data-src="' + esc(src) + '" src="' + esc(src) + '" title="Page du logiciel (bac à sable)"></iframe>'; }
  /* Filet de sécurité : si un cadre atterrit sur une page qui n'est pas une
     page du bac à sable (navigation par script non interceptée), on le vide
     aussitôt — cette page chargerait le VRAI Firebase. */
  var SAFE_PATHS = /\/(sandbox-frame|sandbox-gc)\.html$/;
  function guardFrame(fr) {
    if (!fr) return;
    fr.addEventListener('load', function () {
      var p = '';
      try { p = fr.contentWindow.location.pathname; } catch (e) { p = '?'; }
      if (p && p !== 'blank' && !SAFE_PATHS.test(p) && fr.contentWindow.location.href !== 'about:blank') {
        fr.src = 'about:blank';
        toast('🧱 Page hors bac à sable bloquée (' + esc(p) + ').', 6000);
      }
    });
  }
  /* Comme ?embed=1 depuis la fiche Leads Live (iframe de LD_MODULES). */
  var MODULE_PAGES = { sig: ['sales-signatures.html', '📝 Signatures'], pay: ['payments.html', '💳 Paiements'], book: ['booking.html', '📅 Réserver le RDV'] };
  function openModule(kind, leadId, params) {
    if (ui.cw) { ui.cw.closing = true; }
    closeForm();
    var l = X.leadById(S(), leadId), M = MODULE_PAGES[kind] || MODULE_PAGES.sig;
    ui.module = { kind: kind, leadId: leadId };
    var q = { embed: '1', leadId: leadId };
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== '' && params[k] != null) q[k] = String(params[k]); });
    var src = mirrorSrc(M[0], q);
    $('moModuleIn').innerHTML = '<div class="mo-h"><b>' + M[1] + '<small>' + esc(l ? l.nom : '') + '</small></b><button class="mo-x" data-a="moduleClose">✕</button></div>'
      + '<div class="mo-b" style="padding:0">' + mirrorFrame(src) + '</div>';
    guardFrame($('moModuleIn').querySelector('iframe.mirror'));
    show('moModule');
  }
  function closeModule() { ui.module = null; show('moModule', false); $('moModuleIn').innerHTML = ''; renderAll(); }
  function renderModule() { /* la vraie page se met à jour seule (onSnapshot) */ }

  /* ═══ TÉLÉPHONE DU CLIENT ════════════════════════════════════════════ */
  function renderBadge() {
    var n = S().inbox.filter(function (m) { return !m.read; }).length;
    $('phBadge').textContent = n ? n : ''; $('phBadgeM').textContent = n ? n : '';
  }
  function renderPhone(force) {
    if (!ui.phoneOpen) return;
    var s = S(), cs = X.contacts(s);
    if (!ui.phoneContact) ui.phoneContact = cs[0].key;
    var opts = '';
    cs.forEach(function (c) { var n = s.inbox.filter(function (m) { return m.contactKey === c.key && !m.read; }).length; opts += '<option value="' + c.key + '"' + (c.key === ui.phoneContact ? ' selected' : '') + '>' + esc(c.name) + ' — ' + c.role + (n ? ' (' + n + ')' : '') + '</option>'; });
    $('phContact').innerHTML = opts;
    var scr = $('phScreen');
    if (ui.phoneBrowser) {
      var fr = scr.querySelector('iframe');
      if (!force && fr && fr.getAttribute('data-src') === ui.phoneBrowser.src) return;
      scr.innerHTML = '<div class="ph-browser"><div class="ph-url"><button data-a="phBack">‹ Messages</button><span>🔒 ' + esc(ui.phoneBrowser.label) + '</span></div><iframe data-src="' + esc(ui.phoneBrowser.src) + '" src="' + esc(ui.phoneBrowser.src) + '" title="Écran du client"></iframe></div>';
      return;
    }
    var c = null; cs.forEach(function (x) { if (x.key === ui.phoneContact) c = x; });
    if (!c) { c = cs[0]; ui.phoneContact = c.key; }
    var msgs = s.inbox.filter(function (m) { return m.contactKey === ui.phoneContact; }).slice().reverse();
    var h = '<div class="ph-title">Messages</div><div class="ph-who">📱 ' + esc(X.fmtPhone(c.telephone)) + ' · ✉️ ' + esc(c.email) + '</div>';
    if (!msgs.length) h += '<div class="ph-empty">Aucun message reçu.<br><br>Ici s\'affiche tout ce que <strong>' + esc(c.name) + '</strong> reçoit : SMS et e-mails envoyés depuis le logiciel.<br><br>Si rien n\'arrive alors que tu as envoyé quelque chose, vérifie le numéro et l\'adresse saisis.</div>';
    msgs.forEach(function (m) {
      h += '<div class="ph-msg' + (m.read ? '' : ' unread') + '"><div class="h"><span class="ch">' + (m.channel === 'sms' ? '💬 SMS' : '✉️ E-mail') + '</span><span>' + esc(m.from) + '</span><span style="margin-left:auto">' + X.frTime(m.at) + '</span></div>';
      if (m.subject) h += '<div class="s">' + esc(m.subject) + '</div>';
      h += '<div class="x">' + linkify(m.text) + '</div>';
      if (m.attachments && m.attachments.length) h += '<div class="h" style="margin-top:6px">📎 ' + esc(m.attachments.join(', ')) + '</div>';
      h += '</div>';
    });
    scr.innerHTML = h;
    var unread = msgs.filter(function (m) { return !m.read; });
    if (unread.length) setTimeout(function () { X.update(function (st) { st.inbox.forEach(function (m) { if (m.contactKey === ui.phoneContact) m.read = true; }); }); renderBadge(); }, 1500);
  }
  /* Les liens du message deviennent cliquables ; ceux que le bac à sable
     sait ouvrir (signature, mandat GoCardless) s'ouvrent dans le téléphone. */
  function linkify(txt) {
    var out = '', last = 0, re = /https?:\/\/[^\s<>"')]+/g, m;
    txt = String(txt || '');
    while ((m = re.exec(txt))) {
      out += esc(txt.slice(last, m.index));
      var r = X.routeLink(m[0]);
      out += r ? '<span class="ph-link" data-a="phOpen" data-u="' + esc(m[0]) + '">' + esc(m[0]) + '</span>' : '<span style="color:#6b7280;text-decoration:underline" title="Lien hors bac à sable">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(txt.slice(last));
  }
  function openPhone(contactKey) {
    ui.phoneOpen = true;
    if (contactKey) { ui.phoneContact = contactKey; ui.phoneBrowser = null; }
    /* Un message non lu attend ce contact (nouveau lien) : on rouvre sur la
       messagerie plutôt que sur la dernière page consultée. */
    else if (ui.phoneBrowser && S().inbox.some(function (m) { return m.contactKey === ui.phoneContact && !m.read; })) ui.phoneBrowser = null;
    show('phone'); renderPhone(true);
  }
  function phoneNotify(m) {
    var n = $('phNotif');
    n.innerHTML = '<b>' + (m.channel === 'sms' ? '💬 MESSAGES' : '✉️ MAIL') + ' · maintenant</b>' + esc((m.subject ? m.subject + ' — ' : '') + m.text).slice(0, 180);
    n.classList.add('show'); clearTimeout(n._h); n._h = setTimeout(function () { n.classList.remove('show'); }, 7000);
  }
  /* Nouveaux messages (déposés par cette page ou par l'iframe du client) :
     notification dans le téléphone s'il affiche ce contact, sinon toast. */
  function checkNewMessages() {
    var s = S();
    if (!ui.knownMsgs) { ui.knownMsgs = {}; s.inbox.forEach(function (m) { ui.knownMsgs[m.id] = 1; }); return; }
    s.inbox.forEach(function (m) {
      if (ui.knownMsgs[m.id]) return;
      ui.knownMsgs[m.id] = 1;
      var c = null; X.contacts(s).forEach(function (x) { if (x.key === m.contactKey) c = x; });
      if (ui.phoneOpen && ui.phoneContact === m.contactKey) phoneNotify(m);
      else toast('📱 ' + esc(c ? c.name : 'Le client') + ' a reçu ' + (m.channel === 'sms' ? 'un SMS' : 'un e-mail') + ' — <a style="color:#93c5fd;cursor:pointer;pointer-events:auto" data-a="phoneTo" data-c="' + m.contactKey + '">voir le téléphone</a>', 5000);
    });
  }

  /* ═══ BILAN ══════════════════════════════════════════════════════════ */
  function fmtDur(ms) { var s = Math.round(ms / 1000), m = Math.floor(s / 60); return (m ? m + ' min ' : '') + (s % 60) + ' s'; }
  function openBilan(leadId) {
    var s = S();
    ui.bilanLead = leadId || ui.bilanLead || (ui.sheetLead || s.leads[0].id);
    var b = X.bilan(ui.bilanLead), l = b.lead, E = b.expected;
    var h = '<div class="mo-h"><b>🏁 Bilan du parcours<small>Ce que tu as fait juste, et ce qui aurait cassé en production</small></b><button class="mo-x" data-a="topClose">✕</button></div><div class="mo-b">';
    h += '<div class="bl-tabs">';
    s.leads.forEach(function (x) { var bx = X.bilan(x.id); h += '<button class="bl-tab' + (x.id === l.id ? ' on' : '') + '" data-a="bilanLead" data-id="' + x.id + '">' + esc(x.nom) + ' · ' + (bx.done ? bx.score + '/100' : 'en cours') + '</button>'; });
    h += '</div>';
    var col = b.score >= 85 ? '#34d399' : (b.score >= 60 ? '#fbbf24' : '#f87171');
    h += '<div class="bl-head"><div class="bl-score" style="color:' + (b.done ? col : 'var(--muted)') + '">' + b.score + '<small>/100</small></div><div class="bl-sum">';
    h += b.done ? (b.errors ? '<b>Parcours terminé avec ' + b.errors + ' erreur' + (b.errors > 1 ? 's' : '') + '.</b> Lis le détail : en production, chacune aurait coûté une correction manuelle, un litige ou une commission fausse.' : '<b>Parcours parfait.</b> Contrat, signature, paiement et close sont cohérents de bout en bout.') : '<b>Parcours en cours.</b> Les étapes grisées restent à faire ; les erreurs déjà commises apparaissent en rouge.';
    if (b.durationMs) h += '<br>⏱ Durée depuis l\'entrée dans le Meet : <b>' + fmtDur(b.durationMs) + '</b>';
    h += '</div></div>';
    b.items.forEach(function (it) {
      var cls = it.ok === true ? 'ok' : (it.ok === false ? 'ko' : (it.ok === 'warn' ? 'wa' : 'todo'));
      h += '<div class="bl-it ' + cls + '"><span class="m">' + (it.ok === true ? '✓' : (it.ok === false ? '✕' : (it.ok === 'warn' ? '!' : ''))) + '</span><div><div class="t">' + esc(it.label) + '</div>' + (it.detail ? '<div class="d">' + esc(it.detail) + '</div>' : '') + '</div></div>';
    });
    if (b.done || l.call.done) {
      h += '<div class="bl-exp"><b>Ce que le client avait demandé pendant le Meet</b><br>' + (l.sb ? '🔗 Self Booking' : '📞 No Booking (setter : ' + esc(l.setter.name) + ')') + ' · 👑 Elite · ' + (E.paiement === 'pif' ? '💎 paiement intégral : ' + euro(E.ht) + ' HT = <b>' + euro(E.ttc) + ' TTC</b> sur GoCardless, encaissé déclaré ' + euro(E.encaisseHT) + ' HT' : '📅 ' + E.nbMens + ' mensualités : ' + euro(E.ht) + ' HT = <b>' + euro(E.ttc) + ' TTC</b>, soit ' + E.nbMens + ' × ' + euro(E.mensTTC) + ' TTC sur GoCardless ; contrat « Nombre de mensualités » = ' + E.nbMens + ' ; encaissé déclaré ' + euro(E.encaisseHT) + ' HT') + (E.cosigner ? ' · 👥 second signataire : ' + esc(E.cosigner.name) + ' (' + esc(E.cosigner.qualite) + ')' : ' · un seul signataire') + '.</div>';
    }
    h += '</div><div class="mo-f"><button class="b b-gh" data-a="resetLead" data-id="' + l.id + '" style="margin-right:auto">↺ Recommencer ce lead</button><button class="b b-pri" data-a="topClose">Fermer</button></div>';
    openTop(h);
  }

  function welcome() {
    var h = '<div class="mo-h"><b>🧪 Bac à sable closer<small>Entraîne-toi sur le parcours complet, sans rien risquer</small></b><button class="mo-x" data-a="topClose">✕</button></div><div class="mo-b welcome">';
    h += '<p style="font-size:13px;line-height:1.6;margin-bottom:12px">Les modules <strong>Signatures</strong> et <strong>Paiements</strong> et la page de signature du client sont <strong>les vraies pages du logiciel</strong>, avec <strong>les vrais contrats du moment</strong>. Mais tout tourne dans ton navigateur : aucun SMS, e-mail, mandat ou prélèvement ne part, rien n\'est écrit dans la vraie base. Tu peux te tromper autant que tu veux.</p>';
    h += '<div class="lb">Tes 3 leads Elite</div><ul><li><strong>Self Booking</strong> — il a pris son RDV seul.</li><li><strong>No Booking</strong> — travaillé par Élodie au setting.</li><li><strong>🎲 Aléatoire</strong> — un profil tiré au hasard à chaque réinitialisation (parfois avec un associé qui doit signer aussi).</li></ul>';
    h += '<div class="lb">Le parcours</div><ul><li>Ouvre la fiche dans <strong>⚡ Leads Live</strong> et rejoins le RDV avec <strong>📹 Meet</strong>. Écoute bien : le client y donne ses conditions (formule de paiement, associé, coordonnées).</li><li>Saisis le résultat du RDV, envoie le contrat (<strong>📝 Signatures</strong>) en remplissant les conditions comme en vrai, puis fais signer le client. Le suivi en direct de l\'onglet Envois fonctionne.</li><li>Une fois le contrat signé — pas avant — crée le paiement (<strong>💳 Paiements</strong>), envoie le lien mandat, fais saisir l\'IBAN, déclenche le prélèvement.</li><li>Termine par les <strong>cartes du Close</strong>.</li></ul>';
    h += '<div class="lb">Le téléphone du client</div><ul><li><strong>📱 Téléphone du client</strong> montre ce que reçoit le client. C\'est toi qui joues le client : ouvre ses liens, saisis son code SMS, signe, entre son IBAN (un IBAN de test est fourni sur la page GoCardless).</li><li>Si tu te trompes de numéro ou d\'e-mail, rien n\'arrive — comme en vrai.</li></ul>';
    h += '<div class="lb">Après</div><ul><li><strong>🏁 Bilan</strong> te dit ce que tu as fait juste et ce qui aurait cassé en production. <strong>↺</strong> pour recommencer un lead ou tout le bac à sable.</li></ul>';
    h += '</div><div class="mo-f"><button class="b b-ok" data-a="welcomeOk">C\'est parti</button></div>';
    openTop(h);
  }

  /* ═══ Outils divers ══════════════════════════════════════════════════ */
  function copy(txt, msg) {
    try { navigator.clipboard.writeText(txt).then(function () { toast(msg); }, function () { toast('❌ Impossible de copier'); }); } catch (e) { toast('❌ Impossible de copier'); }
  }
  var NOSIM = {
    call: '📞 Dans le bac à sable, l\'échange se fait en visio : rejoins le RDV avec <strong>📹 Meet</strong>.',
    sms: '💬 Les SMS libres au prospect ne sont pas simulés ici.',
    rdv: '📅 La prise de RDV n\'est pas simulée : le RDV de ce lead est déjà posé.',
    crm: '📋 La fiche CRM complète n\'existe pas dans le bac à sable.',
    ia: '📋 Le dossier de préparation IA n\'est pas généré dans le bac à sable.',
    resched: '📅 La replanification n\'est pas simulée dans le bac à sable.',
    secours: '🆘 Secours = contrat par e-mail, sans signature électronique. Réservé aux pannes : à ne pas utiliser ici.',
    pdf: '📥 Le PDF scellé n\'est pas généré dans le bac à sable.',
    academy: '🎓 L\'accès Academy n\'est pas ouvert depuis le bac à sable.'
  };

  /* ═══ Horloge : les « webhooks » GoCardless ════════════════════════
     En production, GoCardless prévient le serveur (webhook_inbox → Cloud
     Function onWebhookInbox) : mandat actif, prélèvement encaissé
     (paid_out), abonnement terminé. Ici on rejoue ces mises à jour du doc
     payments, avec les mêmes champs, quelques secondes après l'événement. */
  var gcBusy = false;
  function gcWebhooks() {
    if (gcBusy) return;
    var now = Date.now(), A = window.SBXDB.encode, w = [], msgs = [];
    var gc = X.dbList('_sandbox_gc'), pays = X.dbList('payments');
    function payBy(field, val) { for (var i = 0; i < pays.length; i++) if (pays[i][field] === val) return pays[i]; return null; }
    gc.forEach(function (g) {
      if (g.kind === 'billing_request' && g.status === 'fulfilled' && !g.webhooked && now - Date.parse(g.fulfilled_at || 0) > 4000) {
        var p = payBy('gcBillingRequestId', g.id);
        w.push({ op: 'set', merge: true, path: '_sandbox_gc/' + g.id, data: { webhooked: true } });
        if (p) {
          w.push({ op: 'update', path: 'payments/' + p.id, data: A({ gcLastSyncAt: new Date(), updatedAt: new Date(), gcCustomerId: g.links.customer, gcMandateId: g.links.mandate_request_mandate, status: 'mandate_active', mandateCreatedAt: new Date() }) });
          msgs.push('✅ Webhook GoCardless : mandat actif pour <strong>' + esc(p.leadName) + '</strong>');
        }
      }
      var ready = now - Date.parse(g.created_at || 0) > 6000;
      if (g.kind === 'payment' && g.status === 'pending_submission' && ready) {
        var p2 = payBy('gcPaymentId', g.id);
        w.push({ op: 'set', merge: true, path: '_sandbox_gc/' + g.id, data: { status: 'paid_out' } });
        if (p2) { w.push(paidOut(p2, g.id, g.amount / 100, g.charge_date)); msgs.push('💰 Prélèvement reçu — <strong>' + euro(g.amount / 100) + '</strong> (' + esc(p2.leadName) + ')'); }
      }
      if (g.kind === 'subscription' && g.status === 'active' && !g.paid && ready) {
        var p3 = payBy('gcSubscriptionId', g.id);
        w.push({ op: 'set', merge: true, path: '_sandbox_gc/' + g.id, data: { paid: 1, status: g.count > 1 ? 'active' : 'finished' } });
        if (p3) {
          w.push(paidOut(p3, g.id + '-1', g.amount / 100, g.start_date));
          if (g.count <= 1) w.push({ op: 'update', path: 'payments/' + p3.id, data: { status: 'completed' } });
          msgs.push('💰 1ʳᵉ mensualité reçue — <strong>' + euro(g.amount / 100) + '</strong> (' + esc(p3.leadName) + ') · les suivantes suivront l\'échéancier');
        }
      }
    });
    if (w.length) { try { store().commit(w); } catch (e) { if (window.console) console.warn('[sandbox] webhook', e && e.message); } }
    if (msgs.length) toast(msgs.join('<br>'), 5500);
  }
  /* Miroir de createInvoiceFromGcPayment (étape 10) — sans la facture. */
  function paidOut(p, gcPaymentId, amount, date) {
    return { op: 'update', path: 'payments/' + p.id, data: {
      paidCount: { __fv: 'increment', v: 1 }, paidAmount: { __fv: 'increment', v: amount },
      paymentsHistory: { __fv: 'arrayUnion', v: [{ amount: amount, date: date, gcPaymentId: gcPaymentId, status: 'paid_out', invoiceId: null, invoiceNumber: 'facture non générée (bac à sable)', eventAt: new Date().toISOString() }] },
      updatedAt: { __fv: 'serverTimestamp' }
    } };
  }
  function tick() {
    var c = $('phClock'); if (c) c.textContent = X.frTime();
    gcWebhooks();
    simCheck();
    var s = S(), openBl = null, changed = false;
    s.leads.forEach(function (l) {
      if (l.bilanShown) return;
      var b = X.bilan(l.id);
      if (b && b.done) { l.bilanShown = true; changed = true; if (!openBl) openBl = l.id; }
    });
    if (changed) { X.save(s); renderAll(); }
    if (openBl && !$('moTop').classList.contains('show')) setTimeout(function () { openBilan(openBl); }, 1200);
  }

  /* ═══ ÉVÉNEMENTS ═════════════════════════════════════════════════════ */
  document.addEventListener('click', function (e) {
    var bg = e.target;
    if (bg.classList && bg.classList.contains('mo-bg')) {
      if (bg.id === 'moForm') closeForm(); else if (bg.id === 'moModule') closeModule(); else if (bg.id === 'moTop') closeTop();
      return;
    }
    var cpBtn = e.target.closest ? e.target.closest('[data-cp-lead]') : null;
    if (cpBtn && window.ClosePilot && window.ClosePilot.handle(cpBtn)) { e.preventDefault(); return; }
    var t = e.target.closest ? e.target.closest('[data-a]') : null;
    if (!t) return;
    var a = t.getAttribute('data-a'), id = t.getAttribute('data-id');
    switch (a) {
      case 'view': ui.view = t.getAttribute('data-v'); window.scrollTo(0, 0); renderAll(); break;
      case 'filter': ui.filter = t.getAttribute('data-f'); renderMain(); break;
      case 'openLead': if (e.target.closest('[data-a="quickStatus"]')) return; openLead(id); break;
      case 'quickStatus': e.stopPropagation(); quickStatus(id); break;
      case 'setStatusQ': closeForm(); setStatus(id, t.getAttribute('data-s')); break;
      case 'setStatus': setStatus(id, t.getAttribute('data-s')); break;
      case 'sheetClose': closeSheet(); break;
      case 'sheetTab': ui.sheetTab = t.getAttribute('data-t'); renderSheet(); break;
      case 'nosim': toast(NOSIM[t.getAttribute('data-m')] || 'Non simulé dans le bac à sable.'); break;
      case 'guide': window.open('process-onboarding-elite-closer.html', '_blank', 'noopener'); break;
      case 'copyMeet': copy(X.leadById(S(), id).rdv.meetLink, '📋 Lien Meet copié'); break;
      case 'addNote':
        var txt = prompt('Nouvelle note');
        if (txt && txt.trim()) { X.update(function (s) { var l = X.leadById(s, id); l.notes.push({ at: Date.now(), by: window._sbxUser || 'Toi', txt: txt.trim() }); }); renderSheet(); }
        break;
      case 'resetLead':
        if (!confirm('Recommencer ce lead depuis le début ? Contrats, paiements et messages de ce lead seront effacés du bac à sable.')) return;
        X.resetLead(id, store().identity); closeTop(); closeForm(); if (ui.module) closeModule(); ui.phoneBrowser = null; ui.knownMsgs = null; checkNewMessages(); renderAll(); toast('↺ Lead remis à zéro — à toi de jouer.');
        break;
      case 'resetAll':
        if (!confirm('Tout réinitialiser ? Les 3 leads repartent de zéro et un nouveau profil aléatoire est tiré.')) return;
        X.resetAll(store().identity); closeTop(); closeForm(); if (ui.module) closeModule(); closeSheet(); reloadMain(); ui.phoneBrowser = null; ui.phoneContact = null; ui.knownMsgs = null; checkNewMessages(); renderAll(); toast('↺ Bac à sable réinitialisé.');
        break;
      case 'welcome': welcome(); break;
      case 'welcomeOk': X.update(function (s) { s.welcomed = true; }); closeTop(); break;
      case 'bilan': openBilan(ui.sheetLead); break;
      case 'bilanLead': openBilan(id); break;
      case 'topClose': closeTop(); break;
      case 'formClose': closeForm(); break;
      case 'moduleClose': closeModule(); break;
      /* Meet */
      case 'meet': openMeet(id); break;
      case 'meetMic': ui.meet.mic = !ui.meet.mic; renderMeet(); break;
      case 'meetCam': ui.meet.cam = !ui.meet.cam; renderMeet(); break;
      case 'meetFast': ui.meet.timers.forEach(clearTimeout); ui.meet.typing = false; ui.meet.i = X.leadById(S(), ui.meet.id).call.lines.length; renderMeet(); break;
      case 'meetEnd': endMeet(); break;
      /* Résultat du RDV + cartes du Close */
      case 'outcome': openOutcome(id); break;
      case 'roPick': ui.ro.sel = t.getAttribute('data-k'); renderOutcome(); break;
      case 'roSave': saveOutcome(); break;
      case 'roReset':
        var rid = ui.ro.id;
        X.update(function (s) { var l = X.leadById(s, rid); l.rdv.outcome = null; l.rdv.outcomeNote = ''; X.log(s, rid, 'outcome_reset', '↩︎ Résultat du RDV réinitialisé'); });
        closeForm(); renderAll(); break;
      case 'cwPick':
        var f = t.getAttribute('data-f'), v = t.getAttribute('data-v');
        ui.cw.a[f] = v; if (f !== 'booking') ui.cw.a.encaisse = null;
        cwAdvance(); break;
      case 'cwCoach': ui.cw.a.coachSlug = t.getAttribute('data-s'); ui.cw.a.coachNom = t.getAttribute('data-n'); cwAdvance(); break;
      case 'cwSkip': ui.cw.a.coachSlug = null; ui.cw.a.coachNom = null; cwAdvance(); break;
      case 'cwEnc': ui.cw.a.encaisse = Number(t.getAttribute('data-v')); renderWizard(); break;
      case 'cwGoto': ui.cw.step = Number(t.getAttribute('data-g')); renderWizard(); break;
      case 'cwBack': ui.cw.step = Math.max(0, ui.cw.step - 1); renderWizard(); break;
      case 'cwConfirm': cwConfirm(); break;
      /* Modules */
      case 'module': openModule(t.getAttribute('data-k'), id); break;
      /* Téléphone */
      case 'phone': if (ui.phoneOpen) { ui.phoneOpen = false; show('phone', false); } else openPhone(); break;
      case 'phoneClose': ui.phoneOpen = false; show('phone', false); break;
      case 'phoneTo': openPhone(t.getAttribute('data-c')); break;
      case 'phOpen':
        var route = X.routeLink(t.getAttribute('data-u') || '');
        if (route) { ui.phoneBrowser = route; renderPhone(true); guardFrame($('phScreen').querySelector('iframe')); }
        break;
      case 'phBack': ui.phoneBrowser = null; renderPhone(true); break;
      case 'phNotif': $('phNotif').classList.remove('show'); break;
      case 'simGo': simGo(); break;
      case 'simLater': simLater(); break;
    }
  });
  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'cwEnc' && ui.cw) {
      var v = parseFloat(e.target.value); ui.cw.a.encaisse = isNaN(v) ? null : v;
      var ok = $('cwConfirm'); if (ok) ok.disabled = ui.cw.a.encaisse == null;
      var cs = document.querySelectorAll('#moFormIn [data-a="cwEnc"]');
      for (var i = 0; i < cs.length; i++) cs[i].classList.toggle('sel', Number(cs[i].getAttribute('data-v')) === ui.cw.a.encaisse);
    }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'phContact') { ui.phoneContact = e.target.value; ui.phoneBrowser = null; renderPhone(true); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (ui.meet) return;
    if ($('moTop').classList.contains('show')) closeTop();
    else if ($('moForm').classList.contains('show')) closeForm();
    else if (ui.module) closeModule();
    else if (ui.sheetLead) closeSheet();
  });

  /* Changement venu d'un autre document (l'iframe du client) : on rafraîchit
     tout sauf l'iframe elle-même (renderPhone ne la recharge pas). */
  X.onChange(function (st, local) { if (!local) { checkNewMessages(); renderAll(); } else checkNewMessages(); });

  /* ═══ PILOTE DE CLOSING (close-pilot.js) — hôte du bac à sable ═══════
     Même module que Leads Live ; seules les données viennent d'ici : la
     fiche (état local), la fausse base (contrats, paiements, RDV) et les
     vraies pages en miroir. */
  function bookingTypeMap() {
    var t = store().read('booking_config/_types'), map = {};
    ((t && t.list) || []).forEach(function (x) { if (x && x.id) map[x.id] = { label: x.label || x.id, isCoaching: x.isCoaching === true, isSetterOnly: x.isSetterOnly === true }; });
    return map;
  }
  function deepMerge(dst, src) {
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; deepMerge(dst[k], v); }
      else dst[k] = v;
    });
    return dst;
  }
  /* La carte 🏆 du pilote enregistre le close comme les cartes du Close. */
  function pilotRecordClose(leadId, a) {
    var pc = X.PRICING[a.contrat] ? (a.paiement === 'pif' ? X.PRICING[a.contrat].pif : X.PRICING[a.contrat].mensualise) : { contracte: 0 };
    X.update(function (s) {
      var l = X.leadById(s, leadId); if (!l) return;
      var upd = !!l.isClient;
      l.close = { contrat: a.contrat, paiement: a.paiement, booking: a.booking, coachSlug: a.coachSlug || (l.close && l.close.coachSlug) || null, coachNom: a.coachNom || (l.close && l.close.coachNom) || null, encaisse: Number(a.encaisse) || 0, contracte: pc.contracte, at: (l.close && l.close.at) || Date.now() };
      l.isClient = true; l.status = 'client'; l.stage = a.booking === 'sb' ? 'closed_won_self' : 'closed_won_setting';
      l.rdv.outcome = 'close'; l.rdv.past = true;
      X.log(s, leadId, 'close', '🏆 Close ' + (upd ? 'mis à jour' : 'enregistré') + ' (pilote) — ' + a.contrat + ' ' + (a.paiement === 'pif' ? 'PIF' : 'MENS') + ' · encaissé ' + euro(a.encaisse) + ' HT' + (a.coachNom ? ' · coach ' + a.coachNom + ' prévenu (simulé)' : ''));
    });
    renderAll();
    return Promise.resolve();
  }
  function setupPilot() {
    if (!window.ClosePilot) return;
    window.ClosePilot.configure({
      lead: function (id) {
        var l = X.leadById(S(), id); if (!l) return null;
        var o = JSON.parse(JSON.stringify(l));
        o.utm = l.utm; o.assignedTo = l.setter ? l.setter.slug : '';
        if (l.close && l.close.coachNom) o.coachAssigne = { slug: l.close.coachSlug, nom: l.close.coachNom };
        return o;
      },
      sigs: function (id) { return X.leadSigs(id); },
      pays: function (id) { return X.leadPays(id); },
      bookings: function (id) { return X.dbList('bookings', 'leadId', id); },
      typeMap: bookingTypeMap,
      cfg: function () { return { enabled: true }; },
      coaches: function () { return X.COACHS.map(function (c) { return { slug: c.slug, nom: c.nom }; }); },
      me: function () { return { nom: window._sbxUser || '' }; },
      setterName: function (l) { return l && l.setter ? l.setter.name : ''; },
      origin: function (l) { return l.source || ''; },
      sbSuggest: function (l) { return !!l.sb; },
      openModule: function (kind, leadId, params) { openModule(kind, leadId, params); },
      moduleOpen: function () { return !!ui.module; },
      save: function (leadId, patch) {
        X.update(function (s) { var l = X.leadById(s, leadId); if (l) { l.closePilot = deepMerge(l.closePilot || {}, JSON.parse(JSON.stringify(patch))); if (patch.startedAt) X.log(s, leadId, 'pilot_start', '🏆 Pilote de closing lancé'); if (patch.doneAt) X.log(s, leadId, 'pilot_done', '🎉 Closing validé (checklist)'); } });
        renderSheet();
        return Promise.resolve();
      },
      recordClose: function (leadId, a) { return pilotRecordClose(leadId, a); },
      bookingLink: function (typeId, l) {
        var parts = String(l.nom || '').trim().split(/\s+/);
        return 'https://team.alteore.com/booking.html?' + (typeId ? 'type=' + encodeURIComponent(typeId) + '&' : '') + 'leadId=' + encodeURIComponent(l.id) + '&prenom=' + encodeURIComponent(parts[0] || '') + '&nom=' + encodeURIComponent(parts.slice(1).join(' ')) + '&email=' + encodeURIComponent(l.email || '') + '&tel=' + encodeURIComponent(l.telephone || '');
      },
      toast: toast
    });
  }

  /* ═══ « SIMULER LE CLIENT » (demande Adrien 09/10/2026) ═════════════
     Dès qu'un contrat part en signature (ou que c'est au tour de l'associé)
     et dès qu'un lien mandat GoCardless est envoyé, une carte propose
     d'ouvrir directement l'écran du client dans le téléphone simulé — même
     si les coordonnées saisies sont fausses (le bilan le relève, la carte
     le dit). */
  var simSeen = null, simQueue = [];
  function simKeys() {
    var out = [];
    X.dbList('signature_requests').forEach(function (r) {
      if (r.status === 'signed' || r.status === 'cancelled' || !Array.isArray(r.signers)) return;
      var idx = -1;
      for (var i = 0; i < r.signers.length; i++) if (r.signers[i].status !== 'signed') { idx = i; break; }
      if (idx < 0 || !r.signers[idx].token) return;
      var d = r.dernierEnvoi || null, at = d && (d.signerIndex == null || d.signerIndex === idx) ? JSON.stringify(d.at || '') : '';
      /* Sans trace d'envoi (lien pas encore parti, ou envoi en échec), on
         propose quand même la simulation après 4 s. */
      var age = Date.now() - X.tsMs(r.createdAt);
      out.push({ base: 'sig:' + r.id + ':' + idx, at: at, ready: !!at || age > 4000, kind: 'sig', r: r, idx: idx });
    });
    X.dbList('payments').forEach(function (p) {
      if (!p.gcBillingRequestFlowUrl || !p.mandateSentVia || p.status !== 'pending_mandate') return;
      out.push({ base: 'pay:' + p.id, at: JSON.stringify(p.mandateSentAt || ''), ready: true, kind: 'pay', p: p });
    });
    return out;
  }
  function simCheck() {
    var list = simKeys();
    if (!simSeen) { simSeen = {}; list.forEach(function (x) { simSeen[x.base] = x.at || '-'; }); return; }
    list.forEach(function (x) {
      if (!x.ready) return;
      var prev = simSeen[x.base];
      /* Nouveau, ou RENVOI (nouvelle date d'envoi après une première). */
      if (prev === undefined || (x.at && prev !== '-' && prev !== x.at)) { simQueue.push(x); }
      simSeen[x.base] = x.at || prev || '-';
    });
    if (simQueue.length && !$('simPop').classList.contains('show')) simShow(simQueue.shift());
  }
  function simShow(x) {
    var s = S(), h = '', target = null, contact = null, who = '', ok = true;
    if (x.kind === 'sig') {
      var sg = x.r.signers[x.idx];
      contact = X.findContact(s, sg.phone, sg.email);
      ok = !!(contact && X.samePhone(sg.phone, contact.telephone) && X.sameEmail(sg.email, contact.email));
      who = sg.name || 'le client';
      target = { src: 'sandbox-frame.html?page=sign.html&t=' + encodeURIComponent(sg.token), label: 'team.alteore.com/sign.html?t=' + sg.token };
      h += '<div class="sp-t">📨 ' + (x.idx ? 'Au tour du 2ᵉ signataire' : 'Contrat envoyé') + '</div>';
      h += '<div class="sp-d"><b>' + esc(x.r.templateName || 'Contrat') + '</b> → ' + esc(who) + '<br>En vrai, il reçoit maintenant le lien par SMS' + (x.idx ? '' : ' et par e-mail') + '.</div>';
    } else {
      var p = x.p, mailOk = X.sameEmail(p.leadEmail, (X.findContact(s, null, p.leadEmail) || {}).email);
      contact = X.findContact(s, p.mandateSentVia === 'sms' ? p.leadPhone : null, p.mandateSentVia === 'email' ? p.leadEmail : null);
      ok = !!contact; who = p.leadName || 'le client';
      target = X.routeLink(p.gcBillingRequestFlowUrl);
      h += '<div class="sp-t">🔗 Lien mandat envoyé</div>';
      h += '<div class="sp-d">→ ' + esc(who) + ' par ' + (p.mandateSentVia === 'sms' ? 'SMS' : 'e-mail') + '.<br>En vrai, il ouvre la page GoCardless et saisit son IBAN.</div>';
      if (!mailOk && p.mandateSentVia === 'email') ok = false;
    }
    if (!ok) h += '<div class="sp-w">⚠️ Le numéro ou l\'e-mail saisi ne correspond pas au client : <b>en vrai, il n\'aurait rien reçu</b>. Tu peux quand même simuler pour continuer — l\'erreur sera notée au bilan.</div>';
    else h += '<div class="sp-ok">📱 Le message est aussi arrivé dans le téléphone du client.</div>';
    h += '<div class="sp-b"><button class="b b-ok" data-a="simGo">👉 Simuler le client' + (x.kind === 'sig' ? ' : remplir et signer' : ' : saisir son IBAN') + '</button><button class="b b-gh" data-a="simLater">Plus tard</button></div>';
    $('simPop').innerHTML = '<button class="mo-x" data-a="simLater" style="position:absolute;top:8px;right:8px">✕</button>' + h;
    $('simPop')._target = target; $('simPop')._contact = contact ? contact.key : null;
    show('simPop');
  }
  function simGo() {
    var pop = $('simPop'), t = pop._target, c = pop._contact;
    show('simPop', false);
    if (!t) return;
    ui.phoneOpen = true;
    if (c) ui.phoneContact = c;
    ui.phoneBrowser = t;
    show('phone'); renderPhone(true); guardFrame($('phScreen').querySelector('iframe'));
    setTimeout(function () { if (simQueue.length) simShow(simQueue.shift()); }, 400);
  }
  function simLater() {
    show('simPop', false);
    setTimeout(function () { if (simQueue.length) simShow(simQueue.shift()); }, 400);
  }

  /* Les vraies pages et le serveur écrivent dans la fausse base : la fiche,
     le rail et les cartes suivent (rendu regroupé). */
  var dbRender = null;
  function onDbChange() {
    clearTimeout(dbRender);
    dbRender = setTimeout(function () { renderSheet(); if (ui.view === 'leads') renderMain(); renderBadge(); simCheck(); if (window.ClosePilot) window.ClosePilot.refresh(); }, 150);
  }
  function reloadMain() { var fr = $('main').querySelector('iframe.mirror'); if (fr) fr.removeAttribute('data-src'); }

  /* ═══ DÉMARRAGE — réservé aux membres sales / admin connectés ════════
     1. la fausse base se recharge (IndexedDB du navigateur) ;
     2. les modèles de contrat RÉELS sont LUS (lecture seule, get()) et
        posés dans la base en surcouche — c'est le seul accès au vrai
        Firestore, et il n'écrit jamais ;
     3. le compte, l'annuaire de l'équipe et les leads sont semés. */
  function readRealTemplates() {
    var real = firebase.firestore();
    var st = store();
    st.addOverlayLoader(function (colPath) {
      var m = /^signature_templates\/([^/]+)\/pdf$/.exec(colPath);
      if (!m) return Promise.resolve();
      return real.collection('signature_templates').doc(m[1]).collection('pdf').orderBy('chunk').get().then(function (sn) {
        sn.forEach(function (d) { st.setOverlay(colPath + '/' + d.id, window.SBXDB.encode(d.data())); });
      });
    });
    /* booking.html (RDV 72 h du pilote) : agendas et types de RDV réels, en
       lecture seule — sinon la page de réservation n'aurait aucun créneau.
       Les créneaux occupés (calendar_busy) suivent à la demande. */
    st.addOverlayLoader(function (colPath) {
      if (colPath !== 'calendar_busy') return Promise.resolve();
      return real.collection('calendar_busy').get().then(function (sn) {
        sn.forEach(function (d) { st.setOverlay('calendar_busy/' + d.id, window.SBXDB.encode(d.data())); });
      }).catch(function () {});
    });
    var cfgP = real.collection('booking_config').get().then(function (sn) {
      sn.forEach(function (d) { st.setOverlay('booking_config/' + d.id, window.SBXDB.encode(d.data())); });
    }).catch(function (e) { if (window.console) console.warn('[sandbox] agendas illisibles', e && e.message); });
    return real.collection('signature_templates').get().then(function (sn) {
      var n = 0;
      sn.forEach(function (d) { st.setOverlay('signature_templates/' + d.id, window.SBXDB.encode(d.data())); n++; });
      return cfgP.then(function () { return n; });
    });
  }
  function start(user) {
    var role = localStorage.getItem('ambitio_role') || 'sales';
    window._sbxUser = localStorage.getItem('ambitio_name') || (user && (user.displayName || user.email)) || 'Toi';
    var st = store();
    st.identity = { uid: user.uid, email: user.email || localStorage.getItem('ambitio_email') || '', name: window._sbxUser, role: role === 'admin' ? 'admin' : 'sales' };
    st.host = { deliver: X.deliver, registry: X.registry };
    $('sideMe').textContent = '👤 ' + window._sbxUser;
    $('vLock').innerHTML = 'Chargement des contrats du moment…';
    st.load().then(readRealTemplates).then(function (n) {
      X.seed(st.identity);
      setupPilot();
      st.listen(onDbChange, window);
      simCheck();
      $('vLock').style.display = 'none'; $('vApp').style.display = '';
      checkNewMessages();
      renderAll();
      setInterval(tick, 1000);
      if (!S().welcomed) welcome();
      if (!n) toast('⚠️ Aucun modèle de contrat lu : vérifie ton accès au module Signatures.', 7000);
    }).catch(function (e) {
      $('vLock').innerHTML = '⚠️ Impossible de lire les modèles de contrat (' + esc((e && e.message) || 'erreur') + '). Recharge la page.';
    });
  }
  window.SBX.toast = toast;
  firebase.auth().onAuthStateChanged(function (u) {
    if (!u) { window.location.href = 'login.html'; return; }
    var r = localStorage.getItem('ambitio_role') || '';
    if (r !== 'admin' && r !== 'sales') { $('vLock').innerHTML = '🔒 Le bac à sable closer est réservé à l\'équipe Sales et aux admins.'; return; }
    start(u);
  });
})();
