/* ═══════════════════════════════════════════════════════════════════════════
   aide-widget.js — AIDE TEAM : la bulle « ? » des setters / closers (14/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Injecté par nav.js ; s'active UNIQUEMENT pour les rôles sales et admin
   (jamais coach / CSM), jamais dans une iframe.
   • Bulle flottante en bas à droite (au-dessus de l'Inbox, et de l'orbe IA
     chez les admins) → panneau de discussion.
   • Questions techniques → api/aide-ask (Sonnet 5.5 + fiches pratiques).
   • 📎 ou coller (⌘/Ctrl + V) une capture d'écran : réduite à 1600 px dans le
     navigateur avant l'envoi.
   • Réponse : fiches citées (ouvrables dans le panneau), bouton « 👉
     Montre-moi » (aide-guide.js), 👍 / 👎.
   • Conversation gardée le temps de la session (sessionStorage) pour
     survivre aux changements de page.
   • aide.html monte le même chat dans la page : AideTeam.mountInline(el).
   ES5, sans SDK (jeton compat ou window._auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.AideTeam) return;
  try { if (window.self !== window.top) return; } catch (eTop) { return; }

  var API = '/api/aide-ask';
  var SKEY = 'aide_chat_v1', CKEY = 'aide_catalog_v1', OKEY = 'aide_open_v1';
  var C = { history: [], convId: null };   // history : [{role,text,meta}]
  var CAT = null, catP = null;
  var el = {}, pendingImg = null, busy = false, inline = false, built = false;

  /* ═══ Utilitaires ═══ */
  function role() { try { return window._currentRole || localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function allowed() { var r = role(); return r === 'sales' || r === 'admin'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function post(body) {
    var u = user();
    if (!u) return Promise.reject(new Error('Session pas encore prête, réessaie dans une seconde.'));
    return u.getIdToken().then(function (tok) {
      return fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'http_' + r.status }; }); })
      .then(function (j) { if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || 'Erreur'); return j; });
  }
  function pageName() { var p = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, ''); return p || 'index'; }
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }
  function saveChat() { try { sessionStorage.setItem(SKEY, JSON.stringify({ history: C.history.slice(-40), convId: C.convId })); } catch (e) {} }
  function loadChat() { try { var d = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); if (d) { C.history = d.history || []; C.convId = d.convId || null; } } catch (e) {} }

  // Markdown léger : **gras**, listes « 1. » / « - », liens http(s), `code`.
  function md(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var out = [], list = null;
    function inl(t) {
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/(https?:\/\/[^\s<)»]+[^\s<)».,;:!?])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return t;
    }
    function close() { if (list) { out.push('</' + list + '>'); list = null; } }
    lines.forEach(function (l) {
      var m;
      if ((m = l.match(/^\s*(\d+)[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inl(m[2]) + '</li>'); return; }
      if ((m = l.match(/^\s*[-•*]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inl(m[1]) + '</li>'); return; }
      close();
      if (!l.trim()) { out.push('<div class="sp"></div>'); return; }
      if ((m = l.match(/^#{1,4}\s+(.*)$/))) { out.push('<div class="hd">' + inl(m[1]) + '</div>'); return; }
      out.push('<p>' + inl(l) + '</p>');
    });
    close();
    return out.join('');
  }

  /* ═══ Catalogue des fiches (suggestions + lecture) ═══ */
  function catalog() {
    if (CAT) return Promise.resolve(CAT);
    try {
      var c = JSON.parse(sessionStorage.getItem(CKEY) || 'null');
      if (c && c.at && Date.now() - c.at < 10 * 60 * 1000) { CAT = c.data; return Promise.resolve(CAT); }
    } catch (e) {}
    if (catP) return catP;
    catP = post({ action: 'catalog' }).then(function (j) {
      CAT = j; catP = null;
      try { sessionStorage.setItem(CKEY, JSON.stringify({ at: Date.now(), data: j })); } catch (e) {}
      return j;
    }).catch(function (e) { catP = null; throw e; });
    return catP;
  }
  function ficheById(id) {
    var l = (CAT && CAT.fiches) || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function suggestionsFor(page) {
    var l = (CAT && CAT.fiches) || [], here = [], gen = [];
    l.forEach(function (f) { if ((f.pages || []).indexOf(page) >= 0) here.push(f); });
    if (here.length < 4) {
      ['compte-mot-de-passe-oublie', 'booking-connecter-google-agenda', 'booking-regler-mes-horaires', 'agenda-strategie-ajouter', 'whatsapp-creer-groupe-client', 'leads-live-noter-resultat-rdv'].forEach(function (id) {
        var f = ficheById(id); if (f && here.indexOf(f) < 0) gen.push(f);
      });
    }
    return here.concat(gen).slice(0, 4);
  }

  /* ═══ Styles ═══ */
  function css() {
    if (document.getElementById('aideWidgetCss')) return;
    var s = document.createElement('style');
    s.id = 'aideWidgetCss';
    s.textContent =
      '.aidw-fab{position:fixed;right:22px;bottom:88px;z-index:2550;width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;padding:0;color:#fff;font:800 24px/52px Figtree,system-ui,sans-serif;' +
        'background:linear-gradient(135deg,#10b981,#0ea5e9);box-shadow:0 8px 24px rgba(14,165,233,.45),0 0 0 1px rgba(255,255,255,.12)}' +
      '.aidw-fab:hover{transform:scale(1.06)}.aidw-fab.admin{bottom:154px}' +
      '.aidw-fab .tip{position:absolute;right:62px;top:50%;transform:translateY(-50%);white-space:nowrap;background:#0f172a;color:#e2e8f0;font:700 12px Figtree,system-ui,sans-serif;padding:6px 10px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .15s;border:1px solid rgba(255,255,255,.1)}' +
      '.aidw-fab:hover .tip{opacity:1}' +
      '.aidw{position:fixed;right:22px;bottom:150px;z-index:2600;width:410px;max-width:calc(100vw - 24px);height:min(660px,calc(var(--al-vh,100vh) - 170px));display:none;flex-direction:column;' +
        'background:#0d1120;color:#e6ebf7;border:1px solid rgba(255,255,255,.1);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;font-family:Figtree,system-ui,-apple-system,sans-serif}' +
      '.aidw.on{display:flex;animation:aidwIn .18s ease}.aidw.admin{bottom:216px;height:min(660px,calc(var(--al-vh,100vh) - 236px))}' +
      '@keyframes aidwIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
      '.aidw.inline{position:relative;right:auto;bottom:auto;width:auto;max-width:none;height:100%;min-height:520px;display:flex;box-shadow:none;z-index:auto}' +
      '.aidw-h{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(14,165,233,.08))}' +
      '.aidw-h .ic{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#10b981,#0ea5e9);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#fff;flex:none}' +
      '.aidw-h .tt{flex:1;min-width:0}.aidw-h .tt b{display:block;font-size:14.5px}.aidw-h .tt small{display:block;font-size:11.5px;color:rgba(230,235,247,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.aidw-hb{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#cbd5e1;border-radius:9px;height:30px;min-width:30px;padding:0 8px;cursor:pointer;font:700 12px Figtree,system-ui,sans-serif;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}' +
      '.aidw-hb:hover{background:rgba(255,255,255,.12)}' +
      '.aidw-b{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}' +
      '.aidw-m{max-width:88%;padding:10px 12px;border-radius:14px;font-size:13.5px;line-height:1.55;word-wrap:break-word}' +
      '.aidw-m.u{align-self:flex-end;background:linear-gradient(135deg,rgba(16,185,129,.28),rgba(14,165,233,.22));border:1px solid rgba(14,165,233,.3);white-space:pre-wrap}' +
      '.aidw-m.a{align-self:flex-start;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08)}' +
      '.aidw-m.a p{margin:0 0 4px}.aidw-m.a ol,.aidw-m.a ul{margin:4px 0 6px;padding-left:20px}.aidw-m.a li{margin:3px 0}.aidw-m.a .sp{height:4px}.aidw-m.a .hd{font-weight:800;margin:4px 0}' +
      '.aidw-m a{color:#5eead4;word-break:break-all}.aidw-m code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:5px;font-size:12px}' +
      '.aidw-m.err{border-color:rgba(248,113,113,.4);color:#fecaca}' +
      '.aidw-m .img{display:block;max-width:100%;max-height:160px;border-radius:9px;margin-bottom:6px;border:1px solid rgba(255,255,255,.12)}' +
      '.aidw-x{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}' +
      '.aidw-chip{background:rgba(94,234,212,.08);border:1px solid rgba(94,234,212,.25);color:#99f6e4;border-radius:999px;padding:4px 10px;font:700 11.5px Figtree,system-ui,sans-serif;cursor:pointer;text-align:left}' +
      '.aidw-chip:hover{background:rgba(94,234,212,.16)}' +
      '.aidw-show{background:linear-gradient(135deg,#10b981,#0ea5e9);border:0;color:#fff;border-radius:999px;padding:6px 13px;font:800 12px Figtree,system-ui,sans-serif;cursor:pointer}' +
      '.aidw-fb{margin-left:auto;display:flex;gap:4px}.aidw-fb button{background:0;border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;font-size:13px;padding:2px 7px;color:#cbd5e1}' +
      '.aidw-fb button.on{background:rgba(94,234,212,.15);border-color:rgba(94,234,212,.4)}.aidw-fb button:disabled{opacity:.5;cursor:default}' +
      '.aidw-typing{align-self:flex-start;font-size:12.5px;color:rgba(230,235,247,.55);display:flex;gap:6px;align-items:center}' +
      '.aidw-typing i{width:6px;height:6px;border-radius:50%;background:#5eead4;animation:aidwDot 1s infinite}.aidw-typing i:nth-child(2){animation-delay:.15s}.aidw-typing i:nth-child(3){animation-delay:.3s}' +
      '@keyframes aidwDot{50%{opacity:.25}}' +
      '.aidw-empty{color:rgba(230,235,247,.7);font-size:13px;line-height:1.6}' +
      '.aidw-empty h4{margin:0 0 4px;font-size:15px;color:#fff}.aidw-empty .sg{display:flex;flex-direction:column;gap:6px;margin-top:10px}' +
      '.aidw-empty .sg .aidw-chip{border-radius:10px;padding:8px 11px;font-size:12.5px}' +
      '.aidw-f{border-top:1px solid rgba(255,255,255,.08);padding:10px 12px 8px}' +
      '.aidw-pv{display:none;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:rgba(230,235,247,.7)}.aidw-pv.on{display:flex}' +
      '.aidw-pv img{height:44px;border-radius:7px;border:1px solid rgba(255,255,255,.15)}' +
      '.aidw-row{display:flex;gap:7px;align-items:flex-end}' +
      '.aidw-in{flex:1;resize:none;min-height:42px;max-height:130px;background:rgba(255,255,255,.05);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;padding:10px 12px;font:14px/1.45 Figtree,system-ui,sans-serif;outline:0}' +
      '.aidw-in:focus{border-color:#14b8a6}' +
      '.aidw-ib{flex:none;width:42px;height:42px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#e2e8f0;font-size:17px;cursor:pointer}' +
      '.aidw-ib.send{background:linear-gradient(135deg,#10b981,#0ea5e9);border:0;color:#fff}.aidw-ib:disabled{opacity:.45;cursor:default}' +
      '.aidw-hint{margin-top:6px;font-size:10.5px;color:rgba(230,235,247,.38);display:flex;justify-content:space-between;gap:8px}' +
      '.aidw-fv{position:absolute;inset:0;background:#0d1120;display:none;flex-direction:column;z-index:3}.aidw-fv.on{display:flex}' +
      '.aidw-fv .fvh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.aidw-fv .fvh b{flex:1;font-size:14px;line-height:1.3}.aidw-fv .fvb{flex:1;overflow-y:auto;padding:14px;font-size:13.5px;line-height:1.6}' +
      '.aidw-fv .fvb .cat{font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#5eead4;margin-bottom:6px}' +
      '.aidw-fv .fvb p{margin:0 0 6px}.aidw-fv .fvb ol,.aidw-fv .fvb ul{padding-left:20px;margin:4px 0 8px}.aidw-fv .fvb li{margin:3px 0}.aidw-fv .fvb .sp{height:4px}.aidw-fv .fvb .hd{font-weight:800;margin:8px 0 4px}' +
      '.aidw-fv .fvb a{color:#5eead4;word-break:break-all}.aidw-fv .fvb img{max-width:100%;border-radius:10px;margin:8px 0;border:1px solid rgba(255,255,255,.12)}' +
      '.aidw-fv .fvf{padding:10px 14px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px;justify-content:flex-end}' +
      '@media (max-width:640px){.aidw-fab{right:14px;bottom:80px}.aidw-fab.admin{bottom:146px}.aidw-fab .tip{display:none}' +
        '.aidw:not(.inline){right:0;left:0;bottom:0;top:0;width:auto;max-width:none;height:auto;border-radius:0}.aidw.admin:not(.inline){bottom:0;height:auto}}' +
      /* Thème clair */
      'body.light-theme .aidw{background:#fbfcff;color:#111324;border-color:rgba(17,19,36,.12);box-shadow:0 24px 60px rgba(24,28,52,.22)}' +
      'body.light-theme .aidw-h{border-color:rgba(17,19,36,.08);background:linear-gradient(135deg,rgba(16,185,129,.1),rgba(14,165,233,.07))}' +
      'body.light-theme .aidw-h .tt small,body.light-theme .aidw-hint,body.light-theme .aidw-typing,body.light-theme .aidw-pv{color:rgba(17,19,36,.55)}' +
      'body.light-theme .aidw-hb,body.light-theme .aidw-ib:not(.send){background:rgba(17,19,36,.04);border-color:rgba(17,19,36,.12);color:#334155}' +
      'body.light-theme .aidw-m.a{background:#fff;border-color:rgba(17,19,36,.1)}' +
      'body.light-theme .aidw-m.u{background:linear-gradient(135deg,rgba(16,185,129,.14),rgba(14,165,233,.12));border-color:rgba(14,165,233,.3)}' +
      'body.light-theme .aidw-m a,body.light-theme .aidw-fv .fvb a{color:#0f766e}body.light-theme .aidw-m code{background:rgba(17,19,36,.06)}' +
      'body.light-theme .aidw-chip{background:rgba(13,148,136,.07);border-color:rgba(13,148,136,.3);color:#0f766e}' +
      'body.light-theme .aidw-fb button{border-color:rgba(17,19,36,.12);color:#334155}' +
      'body.light-theme .aidw-empty{color:rgba(17,19,36,.7)}body.light-theme .aidw-empty h4{color:#111324}' +
      'body.light-theme .aidw-f,body.light-theme .aidw-fv .fvh,body.light-theme .aidw-fv .fvf{border-color:rgba(17,19,36,.08)}' +
      'body.light-theme .aidw-in{background:#fff;border-color:rgba(17,19,36,.14);color:#111324}' +
      'body.light-theme .aidw-fv{background:#fbfcff}body.light-theme .aidw-fv .fvb .cat{color:#0f766e}' +
      'body.light-theme .aidw-m.err{color:#b91c1c}';
    document.head.appendChild(s);
  }

  /* ═══ Construction ═══ */
  function build(container) {
    css();
    var isAdm = role() === 'admin';
    var root = document.createElement('div');
    root.className = 'aidw' + (container ? ' inline' : (isAdm ? ' admin' : ''));
    root.innerHTML =
      '<div class="aidw-h"><div class="ic">?</div><div class="tt"><b>Aide Team</b><small>Où cliquer, comment régler, comment connecter…</small></div>' +
        (container ? '' : '<a class="aidw-hb" href="aide.html" title="Toutes les fiches pratiques">📚</a>') +
        '<button type="button" class="aidw-hb" data-aw="new" title="Nouvelle conversation">↺</button>' +
        (container ? '' : '<button type="button" class="aidw-hb" data-aw="close" title="Fermer">✕</button>') + '</div>' +
      '<div class="aidw-b" data-aw-body></div>' +
      '<div class="aidw-f"><div class="aidw-pv" data-aw-pv><img alt=""/><span>Capture jointe</span><button type="button" class="aidw-hb" data-aw="unimg" title="Retirer">✕</button></div>' +
        '<div class="aidw-row"><button type="button" class="aidw-ib" data-aw="img" title="Joindre une capture d\'écran">📎</button>' +
        '<textarea class="aidw-in" data-aw-in rows="1" placeholder="Pose ta question technique…"></textarea>' +
        '<button type="button" class="aidw-ib send" data-aw="send" title="Envoyer">➤</button></div>' +
        '<div class="aidw-hint"><span>Entrée pour envoyer · tu peux coller une capture (⌘/Ctrl + V)</span><span data-aw-rem></span></div>' +
        '<input type="file" accept="image/*" data-aw-file style="display:none"/></div>' +
      '<div class="aidw-fv" data-aw-fv></div>';
    (container || document.body).appendChild(root);
    el.root = root;
    el.body = root.querySelector('[data-aw-body]');
    el.input = root.querySelector('[data-aw-in]');
    el.file = root.querySelector('[data-aw-file]');
    el.pv = root.querySelector('[data-aw-pv]');
    el.fv = root.querySelector('[data-aw-fv]');
    el.rem = root.querySelector('[data-aw-rem]');
    el.send = root.querySelector('[data-aw="send"]');

    root.addEventListener('click', onClick);
    el.input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    el.input.addEventListener('input', autosize);
    el.input.addEventListener('paste', onPaste);
    el.file.addEventListener('change', function () { if (el.file.files && el.file.files[0]) takeImage(el.file.files[0]); el.file.value = ''; });

    if (!container) {
      var fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'aidw-fab' + (isAdm ? ' admin' : '');
      fab.setAttribute('aria-label', 'Aide Team');
      fab.innerHTML = '?<span class="tip">Une question technique ? Aide Team</span>';
      fab.addEventListener('click', toggle);
      document.body.appendChild(fab);
      el.fab = fab;
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.root.classList.contains('on') && !el.fv.classList.contains('on')) close(); });
    }
    built = true;
    render();
  }

  function autosize() { el.input.style.height = 'auto'; el.input.style.height = Math.min(130, el.input.scrollHeight) + 'px'; }

  function open() {
    if (!built) return;
    el.root.classList.add('on');
    try { sessionStorage.setItem(OKEY, '1'); } catch (e) {}
    catalog().then(function () { if (!C.history.length) render(); }).catch(function () {});
    setTimeout(function () { el.input.focus(); }, 60);
  }
  function close() { el.root.classList.remove('on'); try { sessionStorage.removeItem(OKEY); } catch (e) {} }
  function toggle() { if (el.root.classList.contains('on')) close(); else open(); }

  /* ═══ Rendu ═══ */
  function render(typing) {
    var h = '';
    if (!C.history.length) {
      var sg = CAT ? suggestionsFor(pageName()) : [];
      var welcome = (CAT && CAT.welcome) || '';
      h += '<div class="aidw-empty"><h4>Salut 👋 Comment je peux t\'aider ?</h4>' +
        (welcome ? '<div>' + esc(welcome) + '</div>' : '<div>Pose-moi n\'importe quelle question <b>technique</b> : où cliquer dans Team, connecter ton agenda Google, régler tes horaires dans Booking, créer un groupe WhatsApp, un message d\'erreur… Tu peux aussi joindre une capture d\'écran 📎.</div>') +
        (sg.length ? '<div class="sg">' + sg.map(function (f) { return '<button type="button" class="aidw-chip" data-aw="fiche" data-id="' + esc(f.id) + '">📖 ' + esc(f.title) + '</button>'; }).join('') + '</div>' : '') +
        '</div>';
    }
    C.history.forEach(function (m, i) {
      if (m.role === 'user') {
        h += '<div class="aidw-m u">' + (m.img ? '<img class="img" src="' + esc(m.img) + '" alt="capture"/>' : (m.hadImg ? '<i>📎 capture jointe</i>\n' : '')) + esc(m.text) + '</div>';
        return;
      }
      var meta = m.meta || {};
      h += '<div class="aidw-m a' + (meta.error ? ' err' : '') + '">' + md(m.text);
      var x = '';
      (meta.fiches || []).forEach(function (f) { x += '<button type="button" class="aidw-chip" data-aw="fiche" data-id="' + esc(f.id) + '">📖 ' + esc(f.title) + '</button>'; });
      if (meta.montreMoi) x += '<button type="button" class="aidw-show" data-aw="show" data-i="' + i + '">👉 Montre-moi</button>';
      if (meta.index >= 0 && meta.convId) {
        x += '<span class="aidw-fb"><button type="button" data-aw="fb" data-v="up" data-i="' + i + '" title="Ça m\'a aidé"' + (meta.fb ? ' disabled' : '') + (meta.fb === 'up' ? ' class="on"' : '') + '>👍</button>' +
          '<button type="button" data-aw="fb" data-v="down" data-i="' + i + '" title="Pas utile"' + (meta.fb ? ' disabled' : '') + (meta.fb === 'down' ? ' class="on"' : '') + '>👎</button></span>';
      }
      if (x) h += '<div class="aidw-x">' + x + '</div>';
      h += '</div>';
    });
    if (typing) h += '<div class="aidw-typing"><i></i><i></i><i></i> Je cherche la bonne procédure…</div>';
    el.body.innerHTML = h;
    el.body.scrollTop = el.body.scrollHeight;
  }

  /* ═══ Capture d'écran ═══ */
  function takeImage(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, hh = img.naturalHeight, k = Math.min(1, max / Math.max(w, hh));
        var cv = document.createElement('canvas');
        cv.width = Math.round(w * k); cv.height = Math.round(hh * k);
        var g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        var url = cv.toDataURL('image/jpeg', 0.85);
        pendingImg = { mediaType: 'image/jpeg', data: url.split(',')[1], url: url };
        el.pv.querySelector('img').src = url;
        el.pv.classList.add('on');
        el.input.focus();
      };
      img.onerror = function () { alert('Image illisible. Essaie une capture en PNG ou JPEG.'); };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }
  function onPaste(e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { e.preventDefault(); takeImage(items[i].getAsFile()); return; }
    }
  }

  /* ═══ Envoi ═══ */
  function send() {
    var q = el.input.value.trim();
    if (busy || (!q && !pendingImg)) return;
    busy = true; el.send.disabled = true;
    var img = pendingImg;
    pendingImg = null; el.pv.classList.remove('on');
    var history = C.history.filter(function (m) { return m.role === 'user' || (m.meta && !m.meta.error); }).slice(-8).map(function (m) { return { role: m.role, text: m.text }; });
    C.history.push({ role: 'user', text: q, img: img ? img.url : null });
    el.input.value = ''; autosize();
    render(true);
    var body = {
      action: 'ask', question: q, history: history, convId: C.convId,
      client: { page: pageName(), title: document.title || '', tz: tz(), mobile: window.innerWidth < 700 },
    };
    if (img) body.image = { mediaType: img.mediaType, data: img.data };
    post(body).then(function (j) {
      C.convId = j.convId || C.convId;
      C.history.push({ role: 'assistant', text: j.answer, meta: { fiches: j.fiches || [], montreMoi: j.montreMoi || null, statut: j.statut, index: j.index, convId: j.convId } });
      if (el.rem) el.rem.textContent = (j.remaining !== null && j.remaining !== undefined && j.remaining <= 10) ? j.remaining + ' question(s) restante(s) aujourd\'hui' : '';
    }).catch(function (e) {
      C.history.push({ role: 'assistant', text: '⚠️ ' + e.message, meta: { error: true } });
    }).then(function () {
      // On ne garde pas l'image elle-même en session (taille) : juste la mention.
      C.history.forEach(function (m) { if (m.img) { m.hadImg = true; delete m.img; } });
      busy = false; el.send.disabled = false;
      saveChat(); render(); el.input.focus();
    });
  }

  /* ═══ Fiche dans le panneau ═══ */
  function showFiche(id) {
    catalog().then(function () {
      var f = ficheById(id);
      if (!f) { alert('Fiche introuvable.'); return; }
      el.fv.innerHTML = '<div class="fvh"><button type="button" class="aidw-hb" data-aw="fvclose">←</button><b>' + esc(f.title) + '</b></div>' +
        '<div class="fvb"><div class="cat">' + esc(f.cat) + (f.adminOnly ? ' · admins' : '') + '</div>' + md(f.body) + '<div data-aw-imgs></div></div>' +
        '<div class="fvf">' + ((f.guide || []).length ? '<button type="button" class="aidw-show" data-aw="showf" data-id="' + esc(f.id) + '">👉 Montre-moi</button>' : '') +
        '<button type="button" class="aidw-hb" data-aw="fvclose">Retour</button></div>';
      el.fv.classList.add('on');
      loadImages(f.images || [], el.fv.querySelector('[data-aw-imgs]'));
    }).catch(function (e) { alert(e.message); });
  }
  var imgCache = {};
  function loadImages(ids, box) {
    ids.forEach(function (id) {
      var put = function (src) { var im = document.createElement('img'); im.src = src; im.alt = 'capture'; box.appendChild(im); };
      if (imgCache[id]) { put(imgCache[id]); return; }
      post({ action: 'image', id: id }).then(function (j) { imgCache[id] = 'data:' + j.mediaType + ';base64,' + j.data; put(imgCache[id]); }).catch(function () {});
    });
  }

  function startGuide(mm) {
    if (!mm || !mm.guide || !mm.guide.length) return;
    if (!window.AideGuide) { alert('Le guidage n\'est pas encore chargé, recharge la page.'); return; }
    if (!inline) close();
    el.fv.classList.remove('on');
    window.AideGuide.start(mm.guide, { ficheId: mm.id, title: mm.title });
  }

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-aw]') : null;
    if (!b) return;
    var a = b.getAttribute('data-aw');
    if (a === 'close') close();
    else if (a === 'new') {
      if (C.history.length && !confirm('Commencer une nouvelle conversation ?')) return;
      C.history = []; C.convId = null; saveChat(); render(); el.input.focus();
    }
    else if (a === 'send') send();
    else if (a === 'img') el.file.click();
    else if (a === 'unimg') { pendingImg = null; el.pv.classList.remove('on'); }
    else if (a === 'fiche') showFiche(b.getAttribute('data-id'));
    else if (a === 'fvclose') el.fv.classList.remove('on');
    else if (a === 'show') { var m = C.history[Number(b.getAttribute('data-i'))]; if (m && m.meta) startGuide(m.meta.montreMoi); }
    else if (a === 'showf') {
      var f = ficheById(b.getAttribute('data-id'));
      if (f) startGuide({ id: f.id, title: f.title, guide: f.guide });
    }
    else if (a === 'fb') {
      var i = Number(b.getAttribute('data-i')), v = b.getAttribute('data-v');
      var msg = C.history[i];
      if (!msg || !msg.meta || msg.meta.fb) return;
      var comment = '';
      if (v === 'down') { comment = window.prompt('Merci ! Qu\'est-ce qui manquait ou n\'allait pas ? (facultatif — ça aide à améliorer la fiche)') || ''; }
      msg.meta.fb = v; saveChat(); render();
      post({ action: 'feedback', convId: msg.meta.convId, index: msg.meta.index, value: v, comment: comment }).catch(function () {});
    }
  }

  /* ═══ Démarrage ═══ */
  window.AideTeam = {
    md: md,
    catalog: catalog,
    open: function () { if (built && !inline) open(); },
    showFiche: function (id) { if (built) { if (!inline) open(); showFiche(id); } },
    startGuide: startGuide,
    mountInline: function (container) {
      inline = true;
      var tries = 0;
      (function wait() {
        if (built) return;
        if (user() && allowed()) { loadChat(); build(container); catalog().then(function () { render(); }).catch(function () {}); return; }
        if (++tries > 60) return;
        setTimeout(wait, 400);
      })();
    },
  };

  function start() {
    // aide.html monte le chat dans la page : pas de bulle en plus.
    if (document.body && document.body.getAttribute('data-aide-inline') === '1') return;
    var tries = 0;
    (function wait() {
      if (built || inline) return;
      if (user()) {
        if (!allowed()) return;
        loadChat();
        build(null);
        try { if (sessionStorage.getItem(OKEY) === '1' && !(window.AideGuide && window.AideGuide.active())) open(); } catch (e) {}
        return;
      }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
