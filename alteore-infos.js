/* ═══════════════════════════════════════════════════════════════════════════
   alteore-infos.js — INFOS ÉQUIPE (annonces internes) — 10/09/2026
   ─────────────────────────────────────────────────────────────────────────
   Un admin (Adrien, Emily, Vincent) publie une information — nouveauté,
   consigne, lien… — et toute l'équipe la reçoit :
     • en POPUP à l'ouverture d'une page tant qu'elle n'est pas lue ;
     • dans la CLOCHE en haut à droite (discrète, présente sur toutes les
       pages), avec le compteur de non-lus et l'historique.

   Injecté par nav.js sur toutes les pages internes. Aucune dépendance à un
   SDK Firebase précis : les pages sales tournent en compat v9, les pages
   coaching en modulaire v10, et les deux ne doivent jamais se mélanger
   (CLAUDE.md). On passe donc par l'API REST Firestore avec le jeton de
   l'utilisateur connecté — les règles de sécurité s'appliquent à
   l'identique.

   Données :
     announcements/{id}        { title, body, links:[{label,url}], audience:
                                 ['all'|'sales'|'coach'|'csm'|'admin'], popup,
                                 active, createdAt, createdBy, createdByName }
     announcements_reads/{uid} { read: { annId: true }, updatedAt }
   Rien n'est supprimé : une info retirée passe active:false.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__alteoInfosLoaded) return;
  window.__alteoInfosLoaded = true;

  var PROJECT = 'ambitio-team';
  var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  var ROLE_LABELS = { all: 'Toute l\'équipe', admin: 'Admins', sales: 'Sales', coach: 'Coachs', csm: 'CSM' };
  var SNOOZE_MS = 60 * 60 * 1000;   // « Plus tard » : pas de nouveau popup pendant 1 h dans cet onglet
  var POLL_MS = 10 * 60 * 1000;     // rafraîchissement silencieux

  var S = { user: null, role: '', name: '', items: [], read: {}, open: false, composing: false, queue: [], queueIdx: 0, loaded: false, error: null };

  /* ── Auth : compat (sales) ou modulaire (coaching / admin) ────────────── */
  function getAuthUser() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function getToken() {
    var u = getAuthUser();
    if (!u) return Promise.reject(new Error('Non connecté'));
    return u.getIdToken();
  }
  function api(method, path, body, query) {
    return getToken().then(function (t) {
      var opts = { method: method, headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      return fetch(BASE + path + (query || ''), opts);
    }).then(function (r) {
      if (r.status === 404) { var e404 = new Error('HTTP 404'); e404.status = 404; throw e404; }
      if (!r.ok) return r.text().then(function (tx) { var e = new Error('HTTP ' + r.status + ' ' + tx.slice(0, 200)); e.status = r.status; throw e; });
      return r.json();
    });
  }

  /* ── (Dé)sérialisation des valeurs Firestore REST ─────────────────────── */
  function fromVal(v) {
    if (v == null) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.timestampValue !== undefined) return v.timestampValue;
    if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fromVal);
    if (v.mapValue !== undefined) return fromFields(v.mapValue.fields || {});
    return null;
  }
  function fromFields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = fromVal(f[k]); }); return o; }
  function toVal(x) {
    if (x === null || x === undefined) return { nullValue: null };
    if (typeof x === 'boolean') return { booleanValue: x };
    if (typeof x === 'number') return (x % 1 === 0) ? { integerValue: String(x) } : { doubleValue: x };
    if (typeof x === 'string') return { stringValue: x };
    if (x instanceof Date) return { timestampValue: x.toISOString() };
    if (Array.isArray(x)) return { arrayValue: { values: x.map(toVal) } };
    if (typeof x === 'object') return { mapValue: { fields: toFields(x) } };
    return { stringValue: String(x) };
  }
  function toFields(o) { var f = {}; Object.keys(o).forEach(function (k) { f[k] = toVal(o[k]); }); return f; }

  /* ── Utilitaires ──────────────────────────────────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function linkify(text) {
    var h = esc(text);
    h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
    return h.replace(/\n/g, '<br/>');
  }
  function frDate(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function isAdmin() { return S.role === 'admin'; }
  function localReadKey() { return 'alteo_infos_read_' + (S.user ? S.user.uid : 'x'); }
  function localRead() { try { return JSON.parse(localStorage.getItem(localReadKey()) || '{}') || {}; } catch (e) { return {}; } }
  function saveLocalRead() { try { localStorage.setItem(localReadKey(), JSON.stringify(S.read)); } catch (e) {} }
  function visibleFor(d) {
    if (isAdmin()) return true;
    var aud = Array.isArray(d.audience) && d.audience.length ? d.audience : ['all'];
    return aud.indexOf('all') >= 0 || aud.indexOf(S.role) >= 0;
  }
  function unread() { return S.items.filter(function (d) { return !S.read[d.id]; }); }
  function toast(msg, err) {
    var t = document.getElementById('alteoInfosToast');
    if (!t) { t = document.createElement('div'); t.id = 'alteoInfosToast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = ''; }, 3200);
  }

  /* ── Données ──────────────────────────────────────────────────────────── */
  function loadAll() {
    var q = { structuredQuery: { from: [{ collectionId: 'announcements' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], limit: 100 } };
    return Promise.all([
      api('POST', ':runQuery', q),
      api('GET', '/announcements_reads/' + encodeURIComponent(S.user.uid)).catch(function (e) { if (e.status === 404) return null; throw e; })
    ]).then(function (r) {
      var docs = (r[0] || []).filter(function (x) { return x.document; }).map(function (x) {
        var d = fromFields(x.document.fields || {});
        d.id = x.document.name.split('/').pop();
        return d;
      });
      S.items = docs.filter(function (d) { return d.active !== false && visibleFor(d); });
      var remote = r[1] ? fromFields(r[1].fields || {}) : {};
      S.read = Object.assign({}, localRead(), (remote.read && typeof remote.read === 'object') ? remote.read : {});
      saveLocalRead();
      S.loaded = true; S.error = null;
    }).catch(function (e) {
      console.warn('[infos] chargement :', e && e.message);
      S.error = (e && e.message) || 'Erreur';
      S.read = localRead();
      S.loaded = true;
    });
  }
  function markRead(id) {
    if (S.read[id]) return Promise.resolve();
    S.read[id] = true; saveLocalRead(); renderBell();
    var fields = { read: { mapValue: { fields: {} } }, updatedAt: toVal(new Date()) };
    fields.read.mapValue.fields[id] = { booleanValue: true };
    return api('PATCH', '/announcements_reads/' + encodeURIComponent(S.user.uid), { fields: fields },
      '?updateMask.fieldPaths=read.' + encodeURIComponent(id) + '&updateMask.fieldPaths=updatedAt')
      .catch(function (e) { console.warn('[infos] accusé de lecture :', e && e.message); });
  }
  function markAllRead() {
    var todo = unread();
    return Promise.all(todo.map(function (d) { return markRead(d.id); })).then(function () { renderPanel(); renderBell(); });
  }
  function publish(data) {
    var doc = {
      title: data.title, body: data.body, links: data.links, audience: data.audience,
      popup: data.popup !== false, active: true,
      createdAt: new Date(), createdBy: S.user.uid, createdByName: S.name
    };
    return api('POST', '/announcements', { fields: toFields(doc) });
  }
  function archive(id) {
    return api('PATCH', '/announcements/' + encodeURIComponent(id), { fields: { active: { booleanValue: false }, archivedAt: toVal(new Date()), archivedBy: toVal(S.user.uid) } },
      '?updateMask.fieldPaths=active&updateMask.fieldPaths=archivedAt&updateMask.fieldPaths=archivedBy');
  }

  /* ── UI : styles ──────────────────────────────────────────────────────── */
  function injectCss() {
    if (document.getElementById('alteoInfosCss')) return;
    var css = '' +
      '#alteoInfosBell{position:fixed;top:10px;right:14px;z-index:1300;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(15,17,28,.86);color:#e5e7eb;font-size:16px;line-height:32px;text-align:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(6px);opacity:.82;transition:opacity .15s,transform .15s;padding:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '#alteoInfosBell:hover{opacity:1;transform:scale(1.06)}' +
      '#alteoInfosBell .n{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ef4444;color:#fff;font-size:10.5px;font-weight:800;line-height:18px;text-align:center;box-shadow:0 0 0 2px rgba(15,17,28,.9)}' +
      '#alteoInfosBell.has-new{opacity:1;animation:alteoInfosPulse 2.4s ease-in-out infinite}' +
      '@keyframes alteoInfosPulse{0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.35)}50%{box-shadow:0 0 0 6px rgba(239,68,68,.18),0 4px 14px rgba(0,0,0,.35)}}' +
      '#alteoInfosPanel{position:fixed;top:52px;right:14px;z-index:1301;width:380px;max-width:calc(100vw - 28px);max-height:min(72vh,640px);display:none;flex-direction:column;background:#0f111c;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;overflow:hidden}' +
      '#alteoInfosPanel.open{display:flex}' +
      '#alteoInfosPanel .hd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:800;font-size:13.5px}' +
      '#alteoInfosPanel .hd .sp{flex:1}' +
      '#alteoInfosPanel .hd button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#cbd5e1;border-radius:8px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer}' +
      '#alteoInfosPanel .hd button.pri{background:#5b7cfa;border-color:#5b7cfa;color:#fff}' +
      '#alteoInfosPanel .ls{overflow-y:auto;flex:1}' +
      '#alteoInfosPanel .it{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.06)}' +
      '#alteoInfosPanel .it.unread{background:rgba(91,124,250,.08);border-left:3px solid #5b7cfa}' +
      '#alteoInfosPanel .it .t{font-weight:800;font-size:13px;margin-bottom:3px;display:flex;align-items:center;gap:6px}' +
      '#alteoInfosPanel .it .m{font-size:10.5px;color:rgba(255,255,255,.42);margin-bottom:6px}' +
      '#alteoInfosPanel .it .b{font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.85);word-break:break-word}' +
      '#alteoInfosPanel .it .b a,#alteoInfosModal .b a{color:#93c5fd}' +
      '#alteoInfosPanel .it .lk,#alteoInfosModal .lk{margin-top:7px;display:flex;flex-wrap:wrap;gap:6px}' +
      '#alteoInfosPanel .lk a,#alteoInfosModal .lk a{display:inline-block;padding:4px 9px;border-radius:7px;background:rgba(91,124,250,.14);border:1px solid rgba(91,124,250,.35);color:#c7d2fe;text-decoration:none;font-size:11.5px;font-weight:700}' +
      '#alteoInfosPanel .it .ac{margin-top:7px;display:flex;gap:6px}' +
      '#alteoInfosPanel .it .ac button{background:none;border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.55);border-radius:6px;padding:3px 8px;font-size:10.5px;cursor:pointer}' +
      '#alteoInfosPanel .empty{padding:26px 14px;text-align:center;color:rgba(255,255,255,.4);font-size:12.5px}' +
      '#alteoInfosPanel .aud{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.07);color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.3px}' +
      '#alteoInfosPanel .cf{padding:12px 14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}' +
      '#alteoInfosPanel .cf label{font-size:10.5px;font-weight:700;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.4px}' +
      '#alteoInfosPanel .cf input[type=text],#alteoInfosPanel .cf textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e5e7eb;padding:7px 9px;font:inherit;font-size:12.5px}' +
      '#alteoInfosPanel .cf textarea{min-height:88px;resize:vertical}' +
      '#alteoInfosPanel .cf .chk{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:rgba(255,255,255,.8)}' +
      '#alteoInfosPanel .cf .chk label{text-transform:none;letter-spacing:0;font-weight:600;color:rgba(255,255,255,.8);display:flex;align-items:center;gap:5px;cursor:pointer}' +
      '#alteoInfosPanel .cf .bt{display:flex;gap:8px;justify-content:flex-end}' +
      '#alteoInfosPanel .cf .bt button{border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#cbd5e1}' +
      '#alteoInfosPanel .cf .bt button.pri{background:#5b7cfa;border-color:#5b7cfa;color:#fff}' +
      '#alteoInfosPanel .cf .hint{font-size:10.5px;color:rgba(255,255,255,.38);line-height:1.4}' +
      '#alteoInfosModalBg{position:fixed;inset:0;z-index:1400;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:20px}' +
      '#alteoInfosModalBg.show{display:flex}' +
      '#alteoInfosModal{width:100%;max-width:520px;max-height:85vh;overflow-y:auto;background:#0f111c;color:#e5e7eb;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '#alteoInfosModal .mh{padding:16px 20px 10px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '#alteoInfosModal .k{font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#93c5fd;margin-bottom:6px}' +
      '#alteoInfosModal .t{font-size:18px;font-weight:800;line-height:1.3}' +
      '#alteoInfosModal .m{font-size:11px;color:rgba(255,255,255,.45);margin-top:4px}' +
      '#alteoInfosModal .b{padding:14px 20px;font-size:14px;line-height:1.6;word-break:break-word}' +
      '#alteoInfosModal .mf{padding:12px 20px 16px;display:flex;gap:8px;justify-content:flex-end;align-items:center;border-top:1px solid rgba(255,255,255,.08)}' +
      '#alteoInfosModal .mf .cnt{flex:1;font-size:11px;color:rgba(255,255,255,.4)}' +
      '#alteoInfosModal .mf button{border-radius:9px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#cbd5e1}' +
      '#alteoInfosModal .mf button.pri{background:#5b7cfa;border-color:#5b7cfa;color:#fff}' +
      '#alteoInfosToast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(16px);z-index:1500;background:#1a2e1a;border:1px solid rgba(52,211,153,.35);color:#6ee7b7;font:600 12.5px system-ui,sans-serif;padding:9px 16px;border-radius:10px;opacity:0;transition:all .25s;pointer-events:none}' +
      '#alteoInfosToast.show{opacity:1;transform:translateX(-50%) translateY(0)}' +
      '#alteoInfosToast.err{background:#2e1a1a;border-color:rgba(239,68,68,.35);color:#fca5a5}' +
      '@media(max-width:640px){#alteoInfosBell{top:8px;right:10px;width:30px;height:30px;line-height:28px;font-size:14px}#alteoInfosPanel{top:46px;right:8px}}';
    var st = document.createElement('style'); st.id = 'alteoInfosCss'; st.textContent = css; document.head.appendChild(st);
  }

  /* ── UI : cloche + panneau ────────────────────────────────────────────── */
  function buildDom() {
    if (document.getElementById('alteoInfosBell')) return;
    var bell = document.createElement('button');
    bell.id = 'alteoInfosBell'; bell.type = 'button'; bell.title = 'Infos équipe';
    bell.innerHTML = '🔔';
    bell.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
    document.body.appendChild(bell);

    var panel = document.createElement('div');
    panel.id = 'alteoInfosPanel';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(panel);

    var bg = document.createElement('div');
    bg.id = 'alteoInfosModalBg';
    bg.innerHTML = '<div id="alteoInfosModal"></div>';
    document.body.appendChild(bg);

    document.addEventListener('click', function () { if (S.open) { S.open = false; renderPanel(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) { S.open = false; renderPanel(); } });

    panel.addEventListener('click', onPanelClick);
    document.getElementById('alteoInfosModal').addEventListener('click', onModalClick);
  }
  function renderBell() {
    var bell = document.getElementById('alteoInfosBell');
    if (!bell) return;
    var n = unread().length;
    bell.innerHTML = '🔔' + (n ? '<span class="n">' + (n > 9 ? '9+' : n) + '</span>' : '');
    bell.classList.toggle('has-new', n > 0);
    bell.title = n ? n + ' info(s) non lue(s)' : 'Infos équipe';
  }
  function togglePanel() {
    S.open = !S.open;
    if (S.open) { S.composing = false; renderPanel(); loadAll().then(function () { renderPanel(); renderBell(); }); }
    else renderPanel();
  }
  function renderPanel() {
    var p = document.getElementById('alteoInfosPanel');
    if (!p) return;
    p.classList.toggle('open', S.open);
    if (!S.open) return;
    var h = '<div class="hd">📣 Infos équipe<span class="sp"></span>';
    if (isAdmin()) h += '<button type="button" data-act="' + (S.composing ? 'cancel' : 'compose') + '" class="pri">' + (S.composing ? '← Retour' : '+ Nouvelle info') + '</button>';
    if (!S.composing && unread().length) h += '<button type="button" data-act="readall">Tout marquer lu</button>';
    h += '</div>';
    if (S.composing) {
      h += renderComposer();
    } else {
      h += '<div class="ls">';
      if (S.error && !S.items.length) h += '<div class="empty">⚠️ ' + esc(S.error) + '<br/><span style="font-size:11px">Si le message parle de permissions, les règles Firestore <code>announcements</code> ne sont pas déployées.</span></div>';
      else if (!S.items.length) h += '<div class="empty">Aucune info pour le moment.</div>';
      S.items.forEach(function (d) {
        var isUnread = !S.read[d.id];
        var aud = Array.isArray(d.audience) && d.audience.length ? d.audience : ['all'];
        h += '<div class="it' + (isUnread ? ' unread' : '') + '" data-id="' + esc(d.id) + '">';
        h += '<div class="t">' + (isUnread ? '🔵 ' : '') + esc(d.title || '(sans titre)') + (isAdmin() && aud.indexOf('all') < 0 ? ' <span class="aud">' + esc(aud.map(function (a) { return ROLE_LABELS[a] || a; }).join(' · ')) + '</span>' : '') + '</div>';
        h += '<div class="m">' + esc(frDate(d.createdAt)) + (d.createdByName ? ' · ' + esc(d.createdByName) : '') + '</div>';
        h += '<div class="b">' + linkify(d.body || '') + '</div>';
        h += renderLinks(d.links);
        h += '<div class="ac">' + (isUnread ? '<button type="button" data-act="read" data-id="' + esc(d.id) + '">✓ Marquer lu</button>' : '') +
          (isAdmin() ? '<button type="button" data-act="archive" data-id="' + esc(d.id) + '" title="Retirer cette info (conservée en base)">🗄 Retirer</button>' : '') + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    p.innerHTML = h;
  }
  function renderLinks(links) {
    if (!Array.isArray(links) || !links.length) return '';
    var h = '<div class="lk">';
    links.forEach(function (l) {
      if (!l || !l.url) return;
      h += '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">🔗 ' + esc(l.label || l.url) + '</a>';
    });
    return h + '</div>';
  }
  function renderComposer() {
    var h = '<div class="cf">';
    h += '<div><label>Titre</label><input type="text" id="aiTitle" maxlength="120" placeholder="Ex : Nouveau process de relance"/></div>';
    h += '<div><label>Message</label><textarea id="aiBody" placeholder="Le texte de l\'info. Les liens collés dans le texte deviennent cliquables."></textarea></div>';
    h += '<div><label>Liens (optionnel, un par ligne)</label><textarea id="aiLinks" style="min-height:52px" placeholder="Libellé | https://…&#10;ou simplement https://…"></textarea></div>';
    h += '<div><label>Destinataires</label><div class="chk">';
    [['all', 'Toute l\'équipe'], ['sales', 'Sales'], ['coach', 'Coachs'], ['csm', 'CSM'], ['admin', 'Admins']].forEach(function (r) {
      h += '<label><input type="checkbox" class="aiAud" value="' + r[0] + '"' + (r[0] === 'all' ? ' checked' : '') + '/> ' + r[1] + '</label>';
    });
    h += '</div></div>';
    h += '<div class="chk"><label><input type="checkbox" id="aiPopup" checked/> Afficher en popup à l\'ouverture (tant que non lu)</label></div>';
    h += '<div class="hint">Publié au nom de ' + esc(S.name) + '. Chacun la reçoit à sa prochaine page ouverte, puis la retrouve dans la cloche. Une info retirée reste en base.</div>';
    h += '<div class="bt"><button type="button" data-act="cancel">Annuler</button><button type="button" class="pri" data-act="publish">📣 Publier</button></div>';
    return h + '</div>';
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'compose') { S.composing = true; renderPanel(); var t = document.getElementById('aiTitle'); if (t) t.focus(); }
    else if (act === 'cancel') { S.composing = false; renderPanel(); }
    else if (act === 'readall') { markAllRead(); }
    else if (act === 'read' && id) { markRead(id).then(function () { renderPanel(); renderBell(); }); }
    else if (act === 'archive' && id) {
      var d = S.items.find(function (x) { return x.id === id; });
      if (!d || !confirm('Retirer « ' + (d.title || '') + ' » ?\n\nElle disparaît de la cloche de toute l\'équipe ; elle reste conservée en base.')) return;
      b.disabled = true;
      archive(id).then(function () { toast('🗄 Info retirée'); return loadAll(); }).then(function () { renderPanel(); renderBell(); })
        .catch(function (err) { toast('❌ ' + err.message, true); b.disabled = false; });
    }
    else if (act === 'publish') {
      var title = (document.getElementById('aiTitle').value || '').trim();
      var body = (document.getElementById('aiBody').value || '').trim();
      if (!title && !body) { toast('Un titre ou un message est nécessaire', true); return; }
      var links = [];
      (document.getElementById('aiLinks').value || '').split('\n').forEach(function (line) {
        line = line.trim(); if (!line) return;
        var parts = line.split('|');
        var url = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
        var label = parts.length > 1 ? parts.slice(0, -1).join('|').trim() : '';
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        links.push({ label: label || url.replace(/^https?:\/\//i, ''), url: url });
      });
      var aud = [];
      Array.prototype.forEach.call(document.querySelectorAll('.aiAud:checked'), function (c) { aud.push(c.value); });
      if (!aud.length || aud.indexOf('all') >= 0) aud = ['all'];
      var popup = !!document.getElementById('aiPopup').checked;
      b.disabled = true; b.textContent = '⏳ Publication…';
      publish({ title: title || 'Info équipe', body: body, links: links, audience: aud, popup: popup })
        .then(function (res) {
          /* L'auteur n'a pas besoin de lire sa propre info. */
          var newId = res && res.name ? res.name.split('/').pop() : null;
          if (newId) { S.read[newId] = true; saveLocalRead(); markRead(newId); }
          toast('📣 Info publiée');
          S.composing = false;
          return loadAll();
        })
        .then(function () { renderPanel(); renderBell(); })
        .catch(function (err) { toast('❌ ' + err.message, true); b.disabled = false; b.textContent = '📣 Publier'; });
    }
  }

  /* ── UI : popup des non-lus ───────────────────────────────────────────── */
  function snoozed() { try { var t = Number(sessionStorage.getItem('alteo_infos_snooze') || 0); return t && (Date.now() - t) < SNOOZE_MS; } catch (e) { return false; } }
  function startPopups() {
    if (snoozed()) return;
    S.queue = unread().filter(function (d) { return d.popup !== false; });
    S.queueIdx = 0;
    if (S.queue.length) renderModal();
  }
  function renderModal() {
    var bg = document.getElementById('alteoInfosModalBg'), m = document.getElementById('alteoInfosModal');
    if (!bg || !m) return;
    var d = S.queue[S.queueIdx];
    if (!d) { bg.classList.remove('show'); return; }
    var h = '<div class="mh"><div class="k">📣 Info équipe</div><div class="t">' + esc(d.title || '(sans titre)') + '</div>' +
      '<div class="m">' + esc(frDate(d.createdAt)) + (d.createdByName ? ' · ' + esc(d.createdByName) : '') + '</div></div>';
    h += '<div class="b">' + linkify(d.body || '') + renderLinks(d.links) + '</div>';
    h += '<div class="mf"><span class="cnt">' + (S.queue.length > 1 ? (S.queueIdx + 1) + ' / ' + S.queue.length : '') + '</span>' +
      '<button type="button" data-act="later">Plus tard</button><button type="button" class="pri" data-act="ok">✓ J\'ai lu</button></div>';
    m.innerHTML = h;
    bg.classList.add('show');
  }
  function onModalClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var d = S.queue[S.queueIdx];
    if (act === 'ok' && d) { markRead(d.id); S.queueIdx++; renderModal(); }
    else if (act === 'later') { try { sessionStorage.setItem('alteo_infos_snooze', String(Date.now())); } catch (e2) {} document.getElementById('alteoInfosModalBg').classList.remove('show'); }
    renderBell();
  }

  /* ── Démarrage : attend l'auth (compat ou modulaire) ──────────────────── */
  function boot() {
    S.role = localStorage.getItem('ambitio_role') || '';
    if (!S.role) return;   // page publique / non connecté : rien à afficher
    var t0 = Date.now();
    var iv = setInterval(function () {
      var u = getAuthUser();
      if (!u) { if (Date.now() - t0 > 40000) clearInterval(iv); return; }
      clearInterval(iv);
      S.user = u;
      S.role = window._currentRole || localStorage.getItem('ambitio_role') || S.role;
      S.name = window._currentUserName || localStorage.getItem('ambitio_name') || u.displayName || (u.email ? u.email.split('@')[0] : 'Membre');
      injectCss(); buildDom(); renderBell();
      loadAll().then(function () { renderBell(); startPopups(); });
      setInterval(function () { if (!S.open) loadAll().then(renderBell); }, POLL_MS);
    }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
