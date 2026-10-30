/* ═══════════════════════════════════════════════════════════════════════════
   pipeline-v2-prod.js — Le nouveau Pipeline en production (29/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Chargé par sales-crm.html, à la place de sales-crm-app.js. Actif pour
   TOUT LE MONDE (demande d'Adrien du 29/10/2026). Repli sur l'ancien
   Pipeline, appareil par appareil : sales-crm.html?v2=0 (mémorisé dans
   localStorage crm_v2_force, même clé que Leads Live ; ?v2=1 pour revenir).

   Branche pipeline-v2.js sur Firestore via pipeline-v2-host.js :
     - leads : toute la collection (≈ 8 500, les anciens imports sont légers),
       bookings : toute la collection (coaching / CSM écartés par l'hôte) ;
     - Appeler → Dialer (DialerBridge.callLead), le résultat se note ensuite ;
       les appels eux-mêmes arrivent par Ringover (aucune fausse communication) ;
     - RDV → booking.html dans une fenêtre (attribution setter), puis même
       mise à jour du lead que Leads Live (stage set / statut rdv_pose,
       journal set_booking ; rien pour un client déjà signé) ;
     - Il a signé → cartes du close (CloseWizard) ;
     - SMS / WhatsApp / e-mail → la fiche s'ouvre dans Leads Live ;
     - conversation / écoute d'un appel → CallDetailModal ;
     - résumé IA → /api/ai-lead.
   ES5 strict. Dépend de : pipeline-etapes.js, pipeline-v2.js,
   pipeline-v2-host.js, alteore-flow.js, close-wizard.js, nav.js (roster).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var FORCE_KEY = 'crm_v2_force';
  try {
    var v = new URLSearchParams(window.location.search).get('v2');
    if (v === '1' || v === '0') localStorage.setItem(FORCE_KEY, v);
  } catch (e) {}
  var force = null;
  try { force = localStorage.getItem(FORCE_KEY); } catch (e) {}
  window.PV2_ON = force !== '0' && !!(window.PipelineEtapes && window.PipelineV2 && window.PipelineV2Host);
  if (!window.PV2_ON) return;

  /* ── Page : l'ancien Pipeline n'est pas chargé, on masque sa coquille ── */
  document.body.classList.add('pv2-prod');
  document.documentElement.classList.add('pv2-prod');   /* sales-crm.css bloque le défilement de html */
  var st = document.createElement('style');
  st.textContent =
    'html.pv2-prod{overflow-y:auto!important;height:auto!important}' +
    'body.pv2-prod{display:block!important;height:auto!important;min-height:100vh;overflow:auto!important}' +
    'body.pv2-prod .crm-header,body.pv2-prod .fb-backdrop,body.pv2-prod .filter-bar,body.pv2-prod .crm-result-bar,body.pv2-prod .crm-limit-banner,' +
    'body.pv2-prod .crm-stage-strip,body.pv2-prod .crm-views-container,body.pv2-prod .bulk-bar,body.pv2-prod .crm-modal-bg,body.pv2-prod .qv-overlay,' +
    'body.pv2-prod .qv-panel,body.pv2-prod .cv-backdrop,body.pv2-prod .colcfg-panel,body.pv2-prod .settings-overlay,body.pv2-prod .settings-panel{display:none!important}' +
    'body.pv2-prod .pv2-head,body.pv2-prod .pv2-dbar{padding-right:52px}' +   /* la cloche flottante (#alteoInfosBell) en haut à droite */
    '.pv2-wait{font:600 15px/1.4 "Plus Jakarta Sans",system-ui,sans-serif;color:#5b6276;text-align:center;padding:80px 20px}' +
    '.pv2bk{position:fixed;inset:0;z-index:4000;background:rgba(8,10,20,.55);display:none;align-items:center;justify-content:center;padding:16px}' +
    '.pv2bk.on{display:flex}' +
    '.pv2bk-box{background:#fff;border-radius:18px;width:min(760px,100%);height:min(860px,calc(var(--al-vh,100vh) - 32px));display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.35)}' +
    '.pv2bk-hd{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e3e6ef;font:700 14px "Plus Jakarta Sans",system-ui,sans-serif;color:#111216}' +
    '.pv2bk-hd span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.pv2bk-hd button{border:0;background:#eef0f6;border-radius:10px;padding:6px 12px;font:700 13px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}' +
    '.pv2bk iframe{flex:1;border:0;width:100%}';
  document.head.appendChild(st);
  var root = document.createElement('div');
  root.id = 'pv2root'; root.className = 'pv2';
  root.innerHTML = '<div class="pv2-wait">Chargement du Pipeline…</div>';
  setTimeout(function () {
    var w = root.querySelector('.pv2-wait');
    if (w) w.textContent = 'Connexion lente : le Pipeline attend encore les données du serveur…';
  }, 15000);
  document.body.appendChild(root);

  var db = firebase.firestore(), FV = firebase.firestore.FieldValue;
  var host = null, me = null;
  function toast(m) { if (window.PipelineV2) window.PipelineV2.toast(m); }
  function paris() { return window.PipelineV2Host.frNowParis(); }

  /* ── Roster (nav.js) ── */
  function attendreEquipe(cb) {
    var fait = false;
    function go() { if (fait) return; fait = true; cb(); }
    if (window.TEAM_MEMBERS_LIST && window.TEAM_MEMBERS_LIST.length) { go(); return; }
    window.addEventListener('team-members-loaded', go);
    setTimeout(go, 8000);
  }

  firebase.auth().onAuthStateChanged(function (u) {
    if (!u) { root.innerHTML = '<div class="pv2-wait">🔒 Connexion requise</div>'; return; }
    if (host) return;
    db.collection('users').doc(u.uid).get().then(function (s) { return (s.exists && s.data()) || {}; }, function () { return {}; }).then(function (ud) {
      attendreEquipe(function () { lancer(u, ud); });
    });
  });

  function lancer(u, ud) {
    var list = window.TEAM_MEMBERS_LIST || [], dep = window.TEAM_DEPARTED || {}, moi = null;
    list.forEach(function (m) { if (m && (m.firebaseUid === u.uid || m.uid === u.uid)) moi = m; });
    var team = list.filter(function (m) { return m && m.slug && m.role !== 'coach' && m.role !== 'csm'; }).map(function (m) {
      return { slug: m.slug, name: m.shortName || m.displayName || m.name || m.slug, color: m.color || '#9096ad', pipeline: m.active !== false && !dep[m.slug] };
    });
    me = {
      slug: (moi && moi.slug) || window.myIdentitySlug || (u.email || 'moi').split('@')[0],
      name: (moi && (moi.shortName || moi.displayName || moi.name)) || u.displayName || (u.email || '').split('@')[0],
      uid: u.uid, role: ud.role === 'admin' ? 'admin' : 'sales'
    };
    var limite60 = firebase.firestore.Timestamp.fromDate(new Date(Date.now() - 60 * 864e5));
    host = window.PipelineV2Host.create({
      db: db, FV: FV, me: me, team: team,
      /* 30/10/2026 : plus de requête unique sur les 8 500 fiches (17 Mo) —
         d'abord les récents et ce qui bouge pendant la session, en direct,
         puis l'historique par pages de 1 000 en arrière-plan. */
      leadsLive: [
        db.collection('leads').where('createdAt', '>=', limite60),
        db.collection('leads').where('updatedAt', '>=', firebase.firestore.Timestamp.fromDate(new Date(Date.now() - 15 * 60000)))
      ],
      leadsPage: function (n, dernier) {
        var q = db.collection('leads').where('createdAt', '<', limite60).orderBy('createdAt', 'desc').limit(1000);
        return dernier ? q.startAfter(dernier) : q;
      },
      pageSize: 1000,
      bookingsQuery: db.collection('bookings'),
      leadsLiveUrl: 'sales-leads.html',
      logCalls: false,
      messagesInLeadsLive: true,
      ui: {
        call: function (l) {
          if (!l.telephone) { toast('Pas de numéro sur cette fiche'); return; }
          if (window.DialerBridge && window.DialerBridge.callLead) window.DialerBridge.callLead(l.id, l.telephone, l.nom || null);
          else window.location.href = 'tel:' + String(l.telephone).replace(/\s/g, '');
        },
        listen: function (l, c) { ouvrirAppel(c); },
        callDetail: function (l, c, cb) {
          if (ouvrirAppel(c)) cb(null, { summary: 'Conversation ouverte dans la fenêtre de l\'appel.', speeches: [] });
          else cb(new Error('aucun enregistrement relié à cet appel'));
        },
        openClose: function (l) {
          if (!window.CloseWizard) { toast('Cartes du close indisponibles : recharge la page'); return; }
          window.CloseWizard.open({ leadId: l.id, lead: l, bookings: (host.bookings()[l.id] || null) });
        },
        openBooking: ouvrirRdv,
        generateAi: function (l, cb) {
          u.getIdToken().then(function (tok) {
            return fetch('/api/ai-lead', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: l.id, force: true }) });
          }).then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status)); }); })
            .then(function () { cb(null); }, function (e) { cb(e); });
        }
      },
      onReady: function (h) { window.PipelineV2.start(root, h); }
    });
  }

  function ouvrirAppel(c) {
    if (c && c.callLogId && window.CallDetailModal) { window.CallDetailModal.open(c.callLogId); return true; }
    return false;
  }

  /* ── Prise de RDV : booking.html dans une fenêtre, comme Leads Live ── */
  var bkLead = null, bkBox = null;
  function ouvrirRdv(l) {
    bkLead = l;
    if (!bkBox) {
      bkBox = document.createElement('div');
      bkBox.className = 'pv2bk';
      bkBox.innerHTML = '<div class="pv2bk-box" role="dialog" aria-label="Poser un RDV"><div class="pv2bk-hd"><span></span><button type="button" data-pv2bk="x">Fermer</button></div><iframe title="Prise de RDV"></iframe></div>';
      bkBox.addEventListener('click', function (e) { if (e.target === bkBox || (e.target.closest && e.target.closest('[data-pv2bk="x"]'))) fermerRdv(); });
      document.body.appendChild(bkBox);
    }
    var parts = String(l.nom || '').split(' ');
    var url = 'booking.html?embed=1&by=setter&leadId=' + encodeURIComponent(l.id) +
      '&prenom=' + encodeURIComponent(parts[0] || '') + '&nom=' + encodeURIComponent(parts.slice(1).join(' ')) +
      '&email=' + encodeURIComponent(l.email || '') + '&tel=' + encodeURIComponent(String(l.telephone || '').replace(/\s/g, '')) +
      '&setter=' + encodeURIComponent(me.slug) + '&setterUid=' + encodeURIComponent(me.uid || '') + '&setterName=' + encodeURIComponent(me.name || '');
    bkBox.querySelector('.pv2bk-hd span').textContent = 'RDV pour ' + (l.nom || '—');
    var fr = bkBox.querySelector('iframe');
    if (!fr) { fr = document.createElement('iframe'); fr.title = 'Prise de RDV'; bkBox.firstChild.appendChild(fr); }
    fr.src = url;
    bkBox.className = 'pv2bk on';
  }
  function fermerRdv() { if (!bkBox) return; bkBox.className = 'pv2bk'; var fr = bkBox.querySelector('iframe'); if (fr) fr.src = 'about:blank'; }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'booking_confirmed' || d.rescheduledFromId) return;
    var leadId = d.leadId || (bkLead && bkLead.id);
    if (!leadId) return;
    var dateFr = d.date ? d.date.split('-').reverse().join('/') : '';
    var ref = db.collection('leads').doc(leadId);
    /* Même règle que Leads Live (13/10/2026) : un RDV pour un client déjà
       signé (RDV 72 h) n'est ni un SET ni un RDV commercial. */
    ref.get().then(function (snap) {
      var fresh = snap.exists ? (snap.data() || {}) : {};
      var isClient = fresh.isClient === true || fresh.status === 'client' || String(fresh.stage || '').indexOf('closed_won') === 0;
      if (!isClient && window.AlteoreFlow) {
        fresh.id = leadId;
        window.AlteoreFlow.recordLeadAction(leadId, fresh, 'set_booking', { prevStatus: fresh.status || null, origin: 'pipeline', bookingId: d.bookingId || null });
      }
      var up = { updatedAt: FV.serverTimestamp(), notesHistory: FV.arrayUnion({ text: '📅 RDV posé — ' + (d.typeLabel || '') + ' avec ' + (d.personName || '') + ' le ' + dateFr + ' à ' + (d.time || '') + ' (' + (d.duration || 30) + 'min)', date: paris(), authorName: me.name, authorSlug: me.slug }) };
      if (!isClient) {
        up.status = 'rdv_pose'; up.stage = 'set';
        up.rdvDate = d.date || ''; up.rdvHeure = d.time || ''; up.dateRdv = dateFr + ' à ' + (d.time || '');
      }
      return ref.update(up);
    }).then(function () { toast('RDV confirmé : ' + (d.personName || '') + ' le ' + dateFr + ' à ' + (d.time || '')); }, function (err) { toast('Erreur : ' + (err && err.message || err)); });
    setTimeout(fermerRdv, 1500);
  });
})();
