/* ═══════════════════════════════════════════════════════════════════════════
   lead-routing-card.js — carte « 🎯 Répartition des leads » (09/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Montée dans <div id="leadRoutingMount"></div> (page Équipe Sales), ADMINS
   uniquement. Deux règles :
     • Leads (opt-in, quiz, tunnels…) : round-robin, 100 % à une personne,
       ou pourcentages (total 100) ;
     • Self-bookings (RDV pris par le prospect) : une personne, ou
       round-robin entre plusieurs.
   À côté : la répartition RÉELLE des 30 derniers jours pour vérifier.
   Données : api/lead-routing.js. La page ne charge pas Firebase : la carte
   charge le SDK compat elle-même si besoin (session restaurée depuis le
   navigateur). ES5.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var API = '/api/lead-routing';
  var FB_CFG = { apiKey: 'AIzaSyDo30FASeWnhvx4mYWYungKOu4AMhyJz6o', authDomain: 'ambitio-team.firebaseapp.com', projectId: 'ambitio-team', storageBucket: 'ambitio-team.firebasestorage.app', messagingSenderId: '1079366902268', appId: '1:1079366902268:web:b4ec1691dba54230339279' };
  var mount, data, draft;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function loadScript(src) {
    return new Promise(function (ok, ko) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
  }
  function ensureUser() {
    var ready = function () {
      return new Promise(function (ok) {
        var u = firebase.auth().currentUser;
        if (u) { ok(u); return; }
        var off = firebase.auth().onAuthStateChanged(function (x) { off(); ok(x); });
      });
    };
    if (window._auth && window._auth.currentUser) return Promise.resolve(window._auth.currentUser);
    if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth) return ready();
    return loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js')
      .then(function () { return loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js'); })
      .then(function () { if (!firebase.apps.length) firebase.initializeApp(FB_CFG); return ready(); });
  }
  function api(method, body) {
    return ensureUser().then(function (u) {
      if (!u) throw new Error('Session expirée — reconnecte-toi');
      return u.getIdToken();
    }).then(function (tok) {
      var o = { method: method, headers: { Authorization: 'Bearer ' + tok } };
      if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(API, o);
    }).then(function (r) { return r.json(); }).then(function (j) { if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || 'Erreur'); return j; });
  }

  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.lr{margin:0 0 18px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:16px;background:var(--bg2,#0f0f1a);padding:16px 18px;color:inherit;font-family:inherit}' +
      '.lr h3{margin:0 0 4px;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}.lr h3 .sp{flex:1}' +
      '.lr .sub{font-size:12px;opacity:.6;margin-bottom:14px}' +
      '.lr-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}' +
      '.lr-box{border:1px solid var(--border,rgba(255,255,255,.08));border-radius:12px;padding:12px 14px;background:rgba(255,255,255,.02)}' +
      '.lr-box h4{margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;opacity:.75}' +
      '.lr-seg{display:inline-flex;gap:4px;padding:3px;border-radius:10px;background:rgba(255,255,255,.05);margin-bottom:10px;flex-wrap:wrap}' +
      '.lr-seg button{border:0;background:none;color:inherit;opacity:.65;padding:6px 10px;border-radius:7px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}' +
      '.lr-seg button.on{opacity:1;background:rgba(99,102,241,.35)}' +
      '.lr-row{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05)}.lr-row:last-child{border-bottom:0}' +
      '.lr-row .n{flex:1}.lr-row small{opacity:.55}' +
      '.lr-row input[type=number]{width:70px;padding:5px 8px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;text-align:right;font:inherit}' +
      '.lr-tot{font-size:12px;font-weight:700;margin-top:8px}.lr-tot.bad{color:#f87171}.lr-tot.ok{color:#34d399}' +
      '.lr-stat{margin-top:12px;padding-top:10px;border-top:1px dashed rgba(255,255,255,.12);font-size:12px}' +
      '.lr-stat .bar{display:flex;align-items:center;gap:8px;margin:4px 0}.lr-stat .bar i{display:block;height:6px;border-radius:999px;background:linear-gradient(90deg,#6366f1,#a855f7)}' +
      '.lr-btn{padding:8px 14px;border:0;border-radius:9px;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}.lr-btn[disabled]{opacity:.5}' +
      '.lr-msg{font-size:12px;margin-left:8px}' +
      'body.light-theme .lr-box{background:rgba(99,102,241,.03)}body.light-theme .lr-row input[type=number]{background:#fff;border-color:rgba(0,0,0,.15)}' +
      '@media (max-width:820px){.lr-grid{grid-template-columns:minmax(0,1fr)}}';
    document.head.appendChild(s);
  }

  function nameOf(slug) {
    var m = (data.members || []).filter(function (x) { return x.slug === slug; })[0];
    return m ? m.name : (slug === '(non attribué)' ? 'Non attribué' : slug);
  }

  function ruleHtml(kind, rule, allowWeighted) {
    var modes = [['round_robin', '🔄 Round-robin'], ['single', '👤 Une personne']];
    if (allowWeighted) modes.push(['weighted', '% Pourcentages']);
    var h = '<div class="lr-seg">';
    modes.forEach(function (m) { h += '<button type="button" class="' + (rule.mode === m[0] ? 'on' : '') + '" data-lr="mode" data-kind="' + kind + '" data-mode="' + m[0] + '">' + m[1] + '</button>'; });
    h += '</div>';
    var total = 0;
    (data.members || []).forEach(function (m) {
      h += '<div class="lr-row"><span class="n">' + esc(m.name) + ' <small>' + esc(m.role) + '</small></span>';
      if (rule.mode === 'single') {
        h += '<input type="radio" name="lr-single-' + kind + '" data-lr="single" data-kind="' + kind + '" value="' + esc(m.slug) + '"' + (rule.single === m.slug ? ' checked' : '') + '/>';
      } else if (rule.mode === 'weighted') {
        var v = Number((rule.weights || {})[m.slug]) || 0;
        total += v;
        h += '<input type="number" min="0" max="100" step="5" data-lr="weight" data-kind="' + kind + '" data-slug="' + esc(m.slug) + '" value="' + (v || '') + '" placeholder="0"/> %';
      } else {
        h += '<input type="checkbox" data-lr="member" data-kind="' + kind + '" value="' + esc(m.slug) + '"' + ((rule.members || []).indexOf(m.slug) >= 0 ? ' checked' : '') + '/>';
      }
      h += '</div>';
    });
    if (rule.mode === 'weighted') h += '<div class="lr-tot ' + (total === 100 ? 'ok' : 'bad') + '">Total : ' + total + ' %' + (total === 100 ? ' ✓' : ' (doit faire 100 %)') + '</div>';
    if (rule.mode === 'round_robin') h += '<div class="lr-tot" style="opacity:.65">À tour de rôle entre les personnes cochées (une absente est sautée).</div>';
    var st = data.stats[kind] || { total: 0, by: {} };
    h += '<div class="lr-stat"><b>30 derniers jours :</b> ' + st.total + ' lead' + (st.total > 1 ? 's' : '');
    Object.keys(st.by).sort(function (a, b) { return st.by[b] - st.by[a]; }).forEach(function (k) {
      var pct = st.total ? Math.round(st.by[k] / st.total * 100) : 0;
      h += '<div class="bar"><span style="min-width:110px">' + esc(nameOf(k)) + '</span><i style="width:' + Math.max(4, pct * 1.6) + 'px"></i><span>' + st.by[k] + ' · ' + pct + ' %</span></div>';
    });
    h += '</div>';
    return h;
  }

  function render(msg, err) {
    var cfgInfo = data.config && data.config.updatedAt ? 'Modifiée le ' + new Date(data.config.updatedAt).toLocaleString('fr-FR') : 'Aucune règle enregistrée — comportement actuel conservé';
    var h = '<div class="lr"><h3>🎯 Répartition des leads<span class="sp"></span><button type="button" class="lr-btn" data-lr="save">Enregistrer</button></h3>';
    h += '<div class="sub">' + esc(cfgInfo) + ' · s\'applique aux NOUVEAUX leads non attribués ; un lead qui revient garde sa personne.' + (msg ? '<span class="lr-msg" style="color:' + (err ? '#f87171' : '#34d399') + '">' + esc(msg) + '</span>' : '') + '</div>';
    h += '<div class="lr-grid"><div class="lr-box"><h4>📥 Leads (opt-in, quiz, tunnels…)</h4>' + ruleHtml('leads', draft.leads, true) + '</div>';
    h += '<div class="lr-box"><h4>📅 Self-bookings (RDV pris par le prospect)</h4>' + ruleHtml('selfBooking', draft.selfBooking, false) + '</div></div></div>';
    mount.innerHTML = h;
  }

  function defaults() {
    var c = data.config || {};
    var elig = (data.members || []).filter(function (m) { return m.eligibleForLeads; }).map(function (m) { return m.slug; });
    var owner = (data.members || []).filter(function (m) { return m.selfBookingOwner; }).map(function (m) { return m.slug; });
    draft = {
      leads: c.leads ? JSON.parse(JSON.stringify(c.leads)) : { mode: 'round_robin', members: elig },
      selfBooking: c.selfBooking ? JSON.parse(JSON.stringify(c.selfBooking)) : { mode: 'single', single: owner[0] || '' },
    };
  }

  function load() {
    mount.innerHTML = '<div class="lr"><h3>🎯 Répartition des leads</h3><div class="sub">Chargement…</div></div>';
    api('GET').then(function (j) { data = j; defaults(); render(); })
      .catch(function (e) { mount.innerHTML = '<div class="lr"><h3>🎯 Répartition des leads</h3><div class="sub" style="color:#f87171">⚠️ ' + esc(e.message) + '</div></div>'; });
  }

  function start() {
    mount = document.getElementById('leadRoutingMount');
    var role = ''; try { role = localStorage.getItem('ambitio_role') || ''; } catch (e) {}
    if (!mount || role !== 'admin') return;
    css();
    mount.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-lr]') : null;
      if (!t || !draft) return;
      var a = t.getAttribute('data-lr'), kind = t.getAttribute('data-kind');
      if (a === 'mode') {
        var r = draft[kind];
        r.mode = t.getAttribute('data-mode');
        if (r.mode === 'round_robin' && !r.members) r.members = [];
        if (r.mode === 'weighted' && !r.weights) r.weights = {};
        render();
      } else if (a === 'save') {
        t.disabled = true;
        api('POST', { action: 'save', config: draft }).then(function () { return api('GET'); })
          .then(function (j) { data = j; defaults(); render('✓ Enregistré'); })
          .catch(function (er) { t.disabled = false; render(er.message, true); });
      }
    });
    mount.addEventListener('change', function (e) {
      var t = e.target, a = t.getAttribute && t.getAttribute('data-lr'), kind = t.getAttribute && t.getAttribute('data-kind');
      if (!a || !draft) return;
      var r = draft[kind];
      if (a === 'single') r.single = t.value;
      else if (a === 'member') {
        r.members = r.members || [];
        var i = r.members.indexOf(t.value);
        if (t.checked && i < 0) r.members.push(t.value);
        if (!t.checked && i >= 0) r.members.splice(i, 1);
      } else if (a === 'weight') {
        r.weights = r.weights || {};
        var v = Math.max(0, Math.min(100, Math.round(Number(t.value) || 0)));
        if (v) r.weights[t.getAttribute('data-slug')] = v; else delete r.weights[t.getAttribute('data-slug')];
        render();
      }
    });
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
