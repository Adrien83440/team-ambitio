/* ═══════════════════════════════════════════════════════════════════════════
   rdv-outcome.js — MODALE « RÉSULTAT DU RDV » PARTAGÉE (refonte 07/2026)
   ─────────────────────────────────────────────────────────────────────────
   Une seule UI pour statuer un RDV depuis n'importe quelle page :
   sales-rdv.html, sales-leads.html (fiche Leads Live), sales-contact.html
   (fiche CRM), booking-admin.html.

   API :
     RdvOutcome.open(booking, opts)
        booking : doc bookings complet ({id, ...data})
        opts    : { preselect: 'close'|..., typeMap, onDone(result) }
     RdvOutcome.chip(booking)        → HTML badge du résultat (ou à statuer)
     RdvOutcome.openReschedule(booking, opts) → replanification directe

   Dépend de : alteore-flow.js (AlteoreFlow), firebase compat, nav.js
   (TEAM_MEMBERS_LIST pour les sélecteurs closer/setter).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CSS = [
    '#rvoBg{position:fixed;inset:0;background:rgba(3,5,14,.72);backdrop-filter:blur(6px);z-index:99990;display:none;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow-y:auto}',
    '#rvoBg.show{display:flex}',
    '.rvo{background:var(--bg2,#0e111c);border:1px solid var(--border,rgba(148,163,214,.14));border-radius:18px;max-width:560px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.55);font-family:var(--fb,"Plus Jakarta Sans",system-ui,sans-serif);color:var(--text,#eef0f8);overflow:hidden;animation:rvoIn .18s ease}',
    '@keyframes rvoIn{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}',
    '.rvo-head{padding:18px 20px 14px;border-bottom:1px solid var(--border,rgba(148,163,214,.12));display:flex;align-items:center;gap:12px}',
    '.rvo-head-ico{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:rgba(91,124,250,.14);border:1px solid rgba(91,124,250,.3);flex:none}',
    '.rvo-head-t{font-size:16px;font-weight:800;font-family:var(--fh,inherit)}',
    '.rvo-head-s{font-size:12px;color:var(--muted,#8f97b2);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.rvo-close{margin-left:auto;background:none;border:none;color:var(--muted,#8f97b2);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:8px}',
    '.rvo-close:hover{color:var(--text,#fff);background:rgba(148,163,214,.1)}',
    '.rvo-sbchip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.4px;text-transform:uppercase}',
    '.rvo-sbchip.sb{background:rgba(251,191,36,.13);color:#fbbf24;border:1px solid rgba(251,191,36,.35)}',
    '.rvo-sbchip.nb{background:rgba(167,139,250,.13);color:#a78bfa;border:1px solid rgba(167,139,250,.35)}',
    '.rvo-body{padding:16px 20px 20px}',
    '.rvo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;margin-bottom:14px}',
    '.rvo-opt{background:var(--bg3,#151928);border:1px solid var(--border,rgba(148,163,214,.14));border-radius:12px;padding:10px 8px;cursor:pointer;text-align:center;transition:all .13s;font-family:inherit;color:var(--text,#eef0f8)}',
    '.rvo-opt:hover{border-color:var(--rvo-c,rgba(148,163,214,.4));transform:translateY(-1px)}',
    '.rvo-opt.sel{border-color:var(--rvo-c);background:color-mix(in srgb,var(--rvo-c) 12%,transparent);box-shadow:0 0 0 1px var(--rvo-c) inset}',
    '.rvo-opt .i{font-size:19px;display:block}',
    '.rvo-opt .l{font-size:11.5px;font-weight:700;margin-top:4px;display:block}',
    '.rvo-desc{font-size:12px;color:var(--muted,#8f97b2);min-height:16px;margin-bottom:12px}',
    '.rvo-panel{background:var(--bg3,#151928);border:1px solid var(--border,rgba(148,163,214,.12));border-radius:14px;padding:14px;margin-bottom:14px;display:none}',
    '.rvo-panel.show{display:block}',
    '.rvo-frow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}',
    '.rvo-frow.single{grid-template-columns:1fr}',
    '.rvo-f label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted,#8f97b2);margin-bottom:4px}',
    '.rvo-f input,.rvo-f select,.rvo-f textarea{width:100%;box-sizing:border-box;background:var(--bg,#07080f);border:1px solid var(--border,rgba(148,163,214,.16));border-radius:9px;color:var(--text,#eef0f8);padding:9px 10px;font-size:13px;font-family:inherit;outline:none}',
    '.rvo-f input:focus,.rvo-f select:focus,.rvo-f textarea:focus{border-color:rgba(91,124,250,.55)}',
    '.rvo-f textarea{resize:vertical;min-height:56px}',
    '.rvo-commprev{display:flex;gap:14px;align-items:center;background:rgba(52,211,153,.07);border:1px dashed rgba(52,211,153,.3);border-radius:10px;padding:9px 12px;font-size:12px;margin-top:2px}',
    '.rvo-commprev b{font-family:var(--fm,ui-monospace,monospace);font-size:13px;color:#34d399}',
    '.rvo-radio{display:flex;gap:8px}',
    '.rvo-radio button{flex:1;background:var(--bg,#07080f);border:1px solid var(--border,rgba(148,163,214,.16));color:var(--muted,#8f97b2);border-radius:9px;padding:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}',
    '.rvo-radio button.sel{border-color:rgba(91,124,250,.6);color:var(--text,#fff);background:rgba(91,124,250,.12)}',
    '.rvo-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.rvo-btn{background:var(--bg3,#151928);border:1px solid var(--border,rgba(148,163,214,.16));color:var(--text,#eef0f8);border-radius:10px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .13s}',
    '.rvo-btn:hover{border-color:rgba(148,163,214,.35)}',
    '.rvo-btn.primary{background:linear-gradient(135deg,rgba(91,124,250,.28),rgba(91,124,250,.14));border-color:rgba(91,124,250,.5);color:#c3cdff}',
    '.rvo-btn.primary:hover{box-shadow:0 6px 18px rgba(91,124,250,.25)}',
    '.rvo-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.rvo-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.3px;white-space:nowrap;border:1px solid}',
    '#rvoToast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--bg3,#151928);border:1px solid var(--border,rgba(148,163,214,.25));color:var(--text,#eef0f8);padding:11px 18px;border-radius:12px;font-size:13px;font-weight:600;z-index:99999;opacity:0;transition:all .25s;box-shadow:0 14px 40px rgba(0,0,0,.5);font-family:var(--fb,system-ui)}',
    '#rvoToast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
    /* Iframe replanification */
    '#rvoReschedBg{position:fixed;inset:0;background:rgba(3,5,14,.8);z-index:99995;display:none;align-items:center;justify-content:center;padding:20px}',
    '#rvoReschedBg.show{display:flex}',
    '.rvo-resched{background:var(--bg2,#0e111c);border:1px solid var(--border,rgba(148,163,214,.16));border-radius:16px;width:min(1040px,96vw);height:min(760px,92vh);display:flex;flex-direction:column;overflow:hidden}',
    '.rvo-resched-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border,rgba(148,163,214,.12));font-size:13px;font-weight:700;font-family:var(--fb,system-ui);color:var(--text,#eef0f8)}',
    '.rvo-resched iframe{flex:1;border:none;width:100%;background:#fff}',
    'body.light-theme .rvo,body.light-theme .rvo-panel,body.light-theme .rvo-opt{background:#fff;color:#111827}',
    'body.light-theme .rvo-f input,body.light-theme .rvo-f select,body.light-theme .rvo-f textarea{background:#f8fafc;color:#111827}'
  ].join('\n');

  var state = { booking: null, lead: null, outcome: null, opts: {}, personsMap: null, saving: false };

  function esc(s) { if (s == null) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }

  /* Styles injectés dès le chargement : RdvOutcome.chip() est utilisé par
     les listes (RDV, fiches) avant la première ouverture de la modale. */
  function ensureStyles() {
    if (document.getElementById('rvoStyles')) return;
    var st = document.createElement('style');
    st.id = 'rvoStyles';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  ensureStyles();

  function ensureDom() {
    if ($('rvoBg')) return;
    ensureStyles();

    var wrap = document.createElement('div');
    wrap.id = 'rvoBg';
    wrap.innerHTML =
      '<div class="rvo">' +
        '<div class="rvo-head">' +
          '<div class="rvo-head-ico">🎯</div>' +
          '<div><div class="rvo-head-t">Résultat du RDV</div><div class="rvo-head-s" id="rvoSub"></div></div>' +
          '<button class="rvo-close" id="rvoX">✕</button>' +
        '</div>' +
        '<div class="rvo-body">' +
          '<div class="rvo-grid" id="rvoGrid"></div>' +
          '<div class="rvo-desc" id="rvoDesc"></div>' +
          '<div class="rvo-panel" id="rvoPanel"></div>' +
          '<div class="rvo-actions">' +
            '<button class="rvo-btn" id="rvoCancel">Annuler</button>' +
            '<button class="rvo-btn primary" id="rvoOk" disabled>Enregistrer</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var toast = document.createElement('div');
    toast.id = 'rvoToast';
    document.body.appendChild(toast);

    var rb = document.createElement('div');
    rb.id = 'rvoReschedBg';
    rb.innerHTML =
      '<div class="rvo-resched">' +
        '<div class="rvo-resched-head">📅 Replanifier le RDV — choisis un nouveau créneau' +
          '<button class="rvo-close" id="rvoReschedX" style="margin-left:auto">✕</button></div>' +
        '<iframe id="rvoReschedIframe" src="about:blank"></iframe>' +
      '</div>';
    document.body.appendChild(rb);

    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('rvoX').addEventListener('click', close);
    $('rvoCancel').addEventListener('click', close);
    $('rvoOk').addEventListener('click', confirmOutcome);
    $('rvoReschedX').addEventListener('click', closeResched);
    rb.addEventListener('click', function (e) { if (e.target === rb) closeResched(); });

    /* Roster équipe chargé après ouverture → reconstruit les sélecteurs */
    window.addEventListener('team-members-loaded', function () { refreshSelectsOnly(); });

    /* Confirmation de replanification en provenance de booking.html */
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type !== 'booking_confirmed' || !d.rescheduledFromId) return;
      if (!state.booking || d.rescheduledFromId !== state.booking.id) return;
      closeResched();
      toastMsg('📅 RDV replanifié au ' + (d.date ? d.date.split('-').reverse().join('/') : '') + ' à ' + (d.time || ''));
      var cb = state.opts && state.opts.onDone;
      var res = { ok: true, outcome: 'replanifie', rescheduledToId: d.bookingId || null };
      state.booking = null;
      if (typeof cb === 'function') cb(res);
    });
  }

  function toastMsg(msg) {
    var t = $('rvoToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window.__rvoToastTo);
    window.__rvoToastTo = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }

  function membersOptions(selected, withNone, noneLabel) {
    var list = (window.TEAM_MEMBERS_LIST || []).filter(function (m) { return m && m.slug && m.active !== false; });
    var h = withNone ? '<option value=""' + (!selected ? ' selected' : '') + '>' + esc(noneLabel || '— aucun —') + '</option>' : '';
    list.forEach(function (m) {
      var name = m.shortName || m.displayName || m.slug;
      h += '<option value="' + esc(m.slug) + '"' + (m.slug === selected ? ' selected' : '') + '>' + esc(name) + '</option>';
    });
    if (selected && !list.some(function (m) { return m.slug === selected; })) {
      h += '<option value="' + esc(selected) + '" selected>' + esc(selected) + '</option>';
    }
    return h;
  }

  function bookingName(b) {
    var p = b.prospect || {};
    return ((p.prenom || '') + ' ' + (p.nom || '')).trim() || p.email || (state.lead && state.lead.nom) || 'Prospect';
  }

  function chip(b) {
    var AF = window.AlteoreFlow;
    if (b && b.outcome && AF && AF.OUTCOMES[b.outcome]) {
      var o = AF.OUTCOMES[b.outcome];
      return '<span class="rvo-chip" style="color:' + o.color + ';border-color:' + o.color + '55;background:' + o.color + '1c">' + o.icon + ' ' + o.label + '</span>';
    }
    if (!b) return '';
    if (b.status === 'cancelled') return '<span class="rvo-chip" style="color:#ef4444;border-color:#ef444455;background:#ef44441c">🔴 Annulé</span>';
    if (b.status === 'no_show') return '<span class="rvo-chip" style="color:#fbbf24;border-color:#fbbf2455;background:#fbbf241c">👻 No-show</span>';
    if (b.status === 'completed') return '<span class="rvo-chip" style="color:#34d399;border-color:#34d39955;background:#34d3991c">✅ Tenu</span>';
    var past = isPastBooking(b);
    if (past) return '<span class="rvo-chip" style="color:#fbbf24;border-color:#fbbf2455;background:#fbbf241c">⏳ À statuer</span>';
    return '<span class="rvo-chip" style="color:#8f97b2;border-color:#8f97b255;background:#8f97b21c">🔒 À venir</span>';
  }

  function isPastBooking(b) {
    if (!b || !b.date || !b.time) return false;
    var d = new Date(b.date + 'T' + b.time + ':00');
    if (isNaN(d)) return false;
    return Date.now() > d.getTime() + (b.duration || 30) * 60000;
  }

  /* ── Ouverture ── */
  function open(booking, opts) {
    var AF = window.AlteoreFlow;
    if (!AF) { alert('alteore-flow.js manquant'); return; }
    ensureDom();
    /* ── GARDE-FOU PÉRIMÈTRE (validé Adrien 07/2026) ──
       Le résultat d'appel ne s'applique QU'AUX RDV setting/closing.
       Coaching / csm_manual / clientId / skipLeadCreation → refus net :
       pas d'outcome, pas de propagation fiche, pas de commission. */
    if (AF.classifyBooking(booking, (opts && opts.typeMap) || {}) === 'excluded') {
      toastMsg('🎓 RDV coaching / client — hors périmètre Setting & Sales, pas de résultat d\'appel ici.');
      return;
    }
    state.booking = booking;
    state.opts = opts || {};
    state.outcome = null;
    state.lead = null;
    state.saving = false;

    var sb = AF.isSB(booking, state.opts.typeMap);
    var dateFr = booking.date ? booking.date.split('-').reverse().join('/') : '';
    $('rvoSub').innerHTML =
      '<strong style="color:var(--text,#fff)">' + esc(bookingName(booking)) + '</strong>' +
      '<span>·</span><span>' + esc(dateFr) + ' à ' + esc(booking.time || '') + '</span>' +
      '<span>·</span><span>' + esc(booking.typeLabel || booking.typeName || booking.type || 'RDV') + '</span>' +
      '<span class="rvo-sbchip ' + (sb ? 'sb' : 'nb') + '">' + (sb ? 'Self Booking' : 'Setting NB') + '</span>';

    renderGrid();
    $('rvoPanel').className = 'rvo-panel';
    $('rvoPanel').innerHTML = '';
    $('rvoDesc').textContent = 'Choisis le résultat de l’appel — tout se propage automatiquement (fiche, rapports, tunnel' + (sb ? ', commissions' : ', commissions') + ').';
    $('rvoOk').disabled = true;
    $('rvoBg').classList.add('show');

    /* Charge le lead (setter attribué) + la map des experts en parallèle.
       À l'arrivée : on ne RE-REND PAS le panneau (l'utilisateur peut être en
       train de saisir) — on met seulement à jour les sélecteurs closer/setter
       s'ils sont encore sur leur valeur par défaut. */
    if (booking.leadId) {
      firebase.firestore().collection('leads').doc(booking.leadId).get().then(function (s) {
        if (s.exists) { state.lead = s.data(); state.lead.id = s.id; refreshSelectsOnly(); }
      }).catch(function () {});
    }
    if (!state.personsMap) {
      AF.loadPersonsMap().then(function (map) { state.personsMap = map; refreshSelectsOnly(); });
    }
    /* typeMap absent (ex : booking-admin) → chargé ici pour que SB/NB soit
       juste même sur un vieux booking sans champ source (type isSetterOnly),
       et pour attraper un RDV coaching détectable uniquement via son type. */
    if (!state.opts.typeMap) {
      AF.loadTypeMap().then(function (m) {
        if (!state.booking || state.booking.id !== booking.id) return;
        state.opts.typeMap = m || {};
        if (AF.classifyBooking(state.booking, state.opts.typeMap) === 'excluded') {
          close();
          toastMsg('🎓 RDV coaching / client — hors périmètre Setting & Sales, résultat d\'appel annulé.');
          return;
        }
        var sb2 = AF.isSB(state.booking, state.opts.typeMap);
        var chipEl = document.querySelector('#rvoSub .rvo-sbchip');
        if (chipEl) {
          chipEl.className = 'rvo-sbchip ' + (sb2 ? 'sb' : 'nb');
          chipEl.textContent = sb2 ? 'Self Booking' : 'Setting NB';
        }
        if (state.outcome === 'close') updateCommPrev();
      });
    }

    if (state.opts.preselect && AF.OUTCOMES[state.opts.preselect]) selectOutcome(state.opts.preselect);
  }

  function close() {
    var bg = $('rvoBg');
    if (bg) bg.classList.remove('show');
    state.booking = null;
    state.outcome = null;
  }

  function renderGrid() {
    var AF = window.AlteoreFlow;
    var h = '';
    AF.OUTCOME_ORDER.forEach(function (k) {
      var o = AF.OUTCOMES[k];
      var sel = state.outcome === k;
      var cur = state.booking && state.booking.outcome === k;
      h += '<button type="button" class="rvo-opt' + (sel ? ' sel' : '') + '" style="--rvo-c:' + o.color + '" data-outcome="' + k + '">' +
        '<span class="i">' + o.icon + '</span><span class="l">' + o.label + (cur ? ' ✓' : '') + '</span></button>';
    });
    var grid = $('rvoGrid');
    grid.innerHTML = h;
    grid.querySelectorAll('.rvo-opt').forEach(function (btn) {
      btn.addEventListener('click', function () { selectOutcome(btn.getAttribute('data-outcome')); });
    });
  }

  function selectOutcome(k) {
    var AF = window.AlteoreFlow;
    state.outcome = k;
    renderGrid();
    $('rvoDesc').textContent = AF.OUTCOMES[k].desc;

    if (k === 'replanifie') {
      /* Pas de formulaire : on ouvre directement l'agenda de replanification.
         booking.html crée le nouveau RDV (même source SB/NB, même lead) et
         passe l'ancien en `replanifie` — voir mode ?reschedule=. */
      openResched();
      return;
    }
    renderPanel();
    $('rvoOk').disabled = false;
  }

  /* Met à jour les sélecteurs closer/setter quand les données asynchrones
     (lead, experts, roster équipe) arrivent — sans re-render le panneau
     (l'utilisateur peut être en train de saisir). Reconstruit les OPTIONS
     depuis le roster en préservant la valeur courante. */
  function refreshSelectsOnly() {
    if (state.outcome !== 'close' || !state.booking) return;
    var selC = $('rvoCloser'), selS = $('rvoSetter');
    if (selS && document.activeElement !== selS) {
      var curS = selS.value;
      selS.innerHTML = membersOptions(curS || prefillSetter(), true, '— aucun (pas de commission setting) —');
    }
    if (selC && document.activeElement !== selC) {
      var curC = selC.dataset.touched ? selC.value : (selC.value || prefillCloser());
      selC.innerHTML = membersOptions(curC || prefillCloser(), true, '— aucun —');
    }
  }

  /* ── Panneaux par résultat ── */
  function prefillCloser() {
    var AF = window.AlteoreFlow;
    var b = state.booking || {};
    if (b.closeData && b.closeData.closerSlug) return b.closeData.closerSlug;
    if (state.personsMap && b.personId && state.personsMap[b.personId]) {
      var fu = state.personsMap[b.personId].firebaseUid;
      var m = fu ? AF.memberByFirebaseUid(fu) : null;
      if (m) return m.slug;
    }
    var meM = AF.me();
    /* Jamais de slug fallback email : une commission écrite sous un slug
       inconnu du module Commissions serait invisible. */
    return (meM && meM.resolved !== false) ? meM.slug : '';
  }
  function prefillSetter() {
    var b = state.booking || {};
    if (b.closeData && b.closeData.setterSlug) return b.closeData.setterSlug;
    if (b.bookedBySlug) return b.bookedBySlug;
    if (state.lead && state.lead.assignedTo) return state.lead.assignedTo;
    return '';
  }

  function renderPanel() {
    var AF = window.AlteoreFlow;
    var k = state.outcome;
    var panel = $('rvoPanel');
    if (!k || k === 'replanifie') { panel.className = 'rvo-panel'; return; }
    var b = state.booking || {};
    var cd = b.closeData || {};
    var h = '';

    if (k === 'close') {
      var offres = AF.OFFRES.map(function (o) { return '<option' + ((cd.offre || 'BP 12') === o ? ' selected' : '') + '>' + o + '</option>'; }).join('');
      var paiements = AF.PAIEMENTS.map(function (p) { return '<option value="' + p.key + '"' + (cd.paiement === p.key ? ' selected' : '') + '>' + p.label + '</option>'; }).join('');
      h +=
        '<div class="rvo-frow">' +
          '<div class="rvo-f"><label>Offre</label><select id="rvoOffre">' + offres + '</select></div>' +
          '<div class="rvo-f"><label>Règlement</label><select id="rvoSubtype">' +
            '<option value="mensualise"' + (cd.subtype !== 'pif' ? ' selected' : '') + '>Mensualisé</option>' +
            '<option value="pif"' + (cd.subtype === 'pif' ? ' selected' : '') + '>PIF (comptant)</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="rvo-frow">' +
          '<div class="rvo-f"><label>Contracté € HT</label><input type="number" id="rvoContracte" min="0" step="1" value="' + (cd.contracte != null ? cd.contracte : 6000) + '"/></div>' +
          '<div class="rvo-f"><label>Collecté € HT</label><input type="number" id="rvoCollecte" min="0" step="0.01" value="' + (cd.collecte != null ? cd.collecte : '') + '" placeholder="0"/></div>' +
        '</div>' +
        '<div class="rvo-frow">' +
          '<div class="rvo-f"><label>Paiement (carte…)</label><select id="rvoPaiement"><option value="">— non précisé —</option>' + paiements + '</select></div>' +
          '<div class="rvo-f"><label>Closer (commission Closing)</label><select id="rvoCloser">' + membersOptions(prefillCloser(), true, '— aucun —') + '</select></div>' +
        '</div>' +
        '<div class="rvo-frow">' +
          '<div class="rvo-f"><label>Setter (commission Setting ' + (AF.isSB(b, state.opts.typeMap) ? 'SB' : 'NB') + ')</label><select id="rvoSetter">' + membersOptions(prefillSetter(), true, '— aucun (pas de commission setting) —') + '</select></div>' +
          '<div class="rvo-f"><label>Note</label><input type="text" id="rvoNote" placeholder="optionnel" value="' + esc(b.outcomeNote || '') + '"/></div>' +
        '</div>' +
        '<div class="rvo-commprev" id="rvoCommPrev"></div>';
    } else if (k === 'annule') {
      h +=
        '<div class="rvo-frow single"><div class="rvo-f"><label>Annulé par</label>' +
          '<div class="rvo-radio" id="rvoCancelBy">' +
            '<button type="button" data-v="prospect" class="sel">👤 Le prospect</button>' +
            '<button type="button" data-v="equipe">👥 L’équipe</button>' +
          '</div></div></div>' +
        '<div class="rvo-frow single"><div class="rvo-f"><label>Raison</label><textarea id="rvoNote" placeholder="ex : plus disponible, a demandé à être rappelé…"></textarea></div></div>' +
        '<div style="font-size:11.5px;color:var(--muted,#8f97b2)">ℹ️ Le lead retombe automatiquement dans le périmètre Setting (à récupérer → taux de récupération).</div>';
    } else {
      var ph = k === 'non_close' ? 'Pourquoi le prospect n’a pas signé ? (objection prix, timing, concurrent…)'
        : k === 'offre' ? 'Détails de l’offre pitchée / prochaine étape (follow-up)…'
        : k === 'disqualifie' ? 'Pourquoi hors cible ?'
        : 'Note (optionnel)…';
      h += '<div class="rvo-frow single"><div class="rvo-f"><label>' + (k === 'non_close' ? 'Raison du non-close' : 'Note') + '</label><textarea id="rvoNote" placeholder="' + esc(ph) + '">' + esc(k === b.outcome ? (b.outcomeNote || '') : '') + '</textarea></div></div>';
      if (k === 'no_show') h += '<div style="font-size:11.5px;color:var(--muted,#8f97b2)">ℹ️ Le lead repasse en Follow Up côté Setting pour être rappelé.</div>';
    }

    panel.innerHTML = h;
    panel.className = 'rvo-panel show';

    if (k === 'close') {
      ['rvoOffre', 'rvoSubtype'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('change', updateCommPrev); });
      var selC = $('rvoCloser');
      if (selC) selC.addEventListener('change', function () { selC.dataset.touched = '1'; });
      updateCommPrev();
    }
    if (k === 'annule') {
      var box = $('rvoCancelBy');
      box.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          box.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
          btn.classList.add('sel');
        });
      });
    }
  }

  function updateCommPrev() {
    var AF = window.AlteoreFlow;
    var prev = $('rvoCommPrev');
    if (!prev) return;
    var offre = $('rvoOffre').value;
    var subtype = $('rvoSubtype').value;
    var sb = AF.isSB(state.booking || {}, state.opts.typeMap);
    var cc = AF.calcClosingComm(offre, subtype);
    var cb = AF.calcClosingBonus(offre, subtype);
    var sc = AF.calcSettingComm(offre, sb);
    prev.innerHTML =
      '<span>Commissions auto :</span>' +
      '<span>Closing <b>' + cc + '€' + (cb ? ' +' + cb + '€ PIF' : '') + '</b></span>' +
      '<span>Setting ' + (sb ? 'SB' : 'NB') + ' <b>' + sc + '€</b></span>';
  }

  /* ── Confirmation ── */
  function confirmOutcome() {
    var AF = window.AlteoreFlow;
    if (!state.booking || !state.outcome || state.saving) return;
    var k = state.outcome;
    var opts = { typeMap: state.opts.typeMap, lead: state.lead };
    var noteEl = $('rvoNote');
    if (noteEl) opts.note = noteEl.value.trim() || null;

    if (k === 'close') {
      opts.closeData = {
        offre: $('rvoOffre').value,
        subtype: $('rvoSubtype').value,
        contracte: parseFloat($('rvoContracte').value) || 0,
        collecte: parseFloat($('rvoCollecte').value) || 0,
        paiement: $('rvoPaiement').value || null,
        closerSlug: $('rvoCloser').value || null,
        setterSlug: $('rvoSetter').value || null
      };
    }
    if (k === 'annule') {
      var selBtn = document.querySelector('#rvoCancelBy button.sel');
      opts.cancelledBy = selBtn ? selBtn.getAttribute('data-v') : 'prospect';
    }

    state.saving = true;
    var okBtn = $('rvoOk');
    okBtn.disabled = true;
    okBtn.textContent = 'Enregistrement…';

    AF.setOutcome(state.booking, k, opts).then(function (res) {
      var o = AF.OUTCOMES[k];
      var msg = o.icon + ' ' + o.label + ' enregistré';
      if (k === 'close') {
        var jobs = res.deals || [];
        var created = jobs.filter(function (d) { return d && d.created; }).length;
        var errors = jobs.filter(function (d) { return d && d.error; });
        if (errors.length) {
          msg += ' · ⚠️ ' + errors.length + ' commission(s) NON créée(s) : ' + errors[0].error + ' — à saisir manuellement dans Commissions';
        } else if (created) {
          msg += ' · ' + created + ' commission(s) créée(s)';
        } else if (jobs.length) {
          msg += ' · commissions déjà en place';
        }
      }
      toastMsg(msg);
      var cb = state.opts.onDone;
      close();
      okBtn.textContent = 'Enregistrer';
      state.saving = false;
      if (typeof cb === 'function') cb({ ok: true, outcome: k, result: res });
    }).catch(function (e) {
      state.saving = false;
      okBtn.disabled = false;
      okBtn.textContent = 'Enregistrer';
      toastMsg('❌ ' + (e && e.message || 'Erreur'));
    });
  }

  /* ── Replanification (iframe booking.html?reschedule=) ── */
  function openResched() {
    if (!state.booking) return;
    ensureDom();
    $('rvoBg').classList.remove('show');
    $('rvoReschedIframe').src = 'booking.html?embed=1&reschedule=' + encodeURIComponent(state.booking.id);
    $('rvoReschedBg').classList.add('show');
  }
  function closeResched() {
    var bg = $('rvoReschedBg');
    if (!bg) return;
    bg.classList.remove('show');
    setTimeout(function () { var f = $('rvoReschedIframe'); if (f) f.src = 'about:blank'; }, 250);
  }
  function openReschedule(booking, opts) {
    ensureDom();
    state.booking = booking;
    state.opts = opts || {};
    openResched();
  }

  window.RdvOutcome = { open: open, chip: chip, openReschedule: openReschedule, isPastBooking: isPastBooking };
})();
