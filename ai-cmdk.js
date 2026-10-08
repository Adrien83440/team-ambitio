/* ═══════════════════════════════════════════════════════════════════════════
   ai-cmdk.js — BARRE DE COMMANDE ⌘K / Ctrl+K (programme IA, Lot 5)
   ─────────────────────────────────────────────────────────────────────────
   Injectée par nav.js sur toutes les pages internes (rôles admin, sales,
   csm, coach). Deux étages :
   1. instantané, sans IA : les pages du menu (lues dans la sidebar → mêmes
      droits que le menu) filtrées pendant la frappe ; Entrée = y aller ;
   2. phrase libre → « ✨ Demander à l'IA » (api/ai-command.js) : ouvrir la
      fiche d'un prospect, ajouter une note (toujours confirmée d'un clic),
      ou question sur les chiffres (admins : réponse de « Demande à Alteore »).
   ES5, sans SDK (jeton compat ou window._auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__aiCmdk) return;
  window.__aiCmdk = true;
  var root = null, input = null, list = null, items = [], idx = 0, busy = false;

  function role() { try { return localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function post(url, body) {
    var u = user();
    if (!u) return Promise.reject(new Error('Session non prête'));
    return u.getIdToken().then(function (tok) {
      return fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || 'Erreur'); return j; });
  }

  function pages() {
    var out = [], seen = {};
    var as = document.querySelectorAll('#ambitio-sidebar a[href]');
    for (var i = 0; i < as.length; i++) {
      var h = as[i].getAttribute('href') || '';
      var l = as[i].getAttribute('data-label') || as[i].textContent.trim();
      if (!h || h === '#' || /^https?:/.test(h) || seen[h]) continue;
      seen[h] = 1;
      out.push({ label: l.replace(/\s+/g, ' ').trim(), href: h });
    }
    return out;
  }

  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.ck-bg{position:fixed;inset:0;z-index:9400;background:rgba(3,6,20,.55);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;padding-top:12vh}' +
      '.ck-bg.on{display:flex}' +
      '.ck-box{width:min(640px,92vw);background:#0e1224;border:1px solid rgba(125,211,252,.25);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(99,102,241,.15);overflow:hidden;color:#e6f0ff;font-family:inherit}' +
      '.ck-in{width:100%;box-sizing:border-box;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.08);padding:16px 18px;font-size:16px;color:#fff;outline:0;font-family:inherit}' +
      '.ck-list{max-height:52vh;overflow-y:auto;padding:6px}' +
      '.ck-it{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:13.5px}' +
      '.ck-it.sel{background:rgba(99,102,241,.22)}' +
      '.ck-it small{margin-left:auto;font-size:11px;color:#94a3b8}' +
      '.ck-ai{color:#c4b5fd}' +
      '.ck-res{padding:12px 16px;font-size:13.5px;line-height:1.55;border-top:1px solid rgba(255,255,255,.06)}' +
      '.ck-res textarea{width:100%;box-sizing:border-box;min-height:70px;background:#0a0d1c;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#fff;padding:8px;font-family:inherit;font-size:13px;margin:6px 0}' +
      '.ck-btn{display:inline-block;margin:4px 6px 0 0;padding:7px 12px;border-radius:9px;border:1px solid rgba(125,211,252,.3);background:rgba(125,211,252,.08);color:#dbeafe;font-size:12.5px;font-weight:700;cursor:pointer;text-decoration:none}' +
      '.ck-btn:hover{background:rgba(125,211,252,.18)}' +
      '.ck-ft{padding:8px 14px;font-size:11px;color:#64748b;border-top:1px solid rgba(255,255,255,.06)}';
    document.head.appendChild(s);
  }

  function build() {
    css();
    root = document.createElement('div');
    root.className = 'ck-bg';
    root.innerHTML = '<div class="ck-box"><input class="ck-in" placeholder="Aller à… ou demande à l\'IA (« ouvre la fiche de Martin », « note sur Dupont : rappeler jeudi »)"/>' +
      '<div class="ck-list"></div><div class="ck-res" style="display:none"></div><div class="ck-ft">↑↓ naviguer · Entrée valider · Échap fermer · ⌘/Ctrl + K</div></div>';
    document.body.appendChild(root);
    input = root.querySelector('.ck-in');
    list = root.querySelector('.ck-list');
    root.addEventListener('click', function (e) {
      if (e.target === root) { close(); return; }
      var it = e.target.closest ? e.target.closest('[data-ck]') : null;
      if (it) run(Number(it.getAttribute('data-ck')));
      var b = e.target.closest ? e.target.closest('[data-ckact]') : null;
      if (b) act(b);
    });
    input.addEventListener('input', function () { idx = 0; filter(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(idx); }
      else if (e.key === 'Escape') close();
    });
  }

  function filter() {
    var q = norm(input.value.trim());
    var ps = pages().filter(function (p) { return !q || norm(p.label).indexOf(q) >= 0; }).slice(0, 8);
    items = ps.map(function (p) { return { kind: 'page', label: p.label, href: p.href }; });
    if (q.length >= 3) items.push({ kind: 'ai', label: '✨ Demander à l\'IA : « ' + input.value.trim() + ' »' });
    if (!q) items = items.slice(0, 8);
    paint();
    root.querySelector('.ck-res').style.display = 'none';
  }
  function paint() {
    list.innerHTML = items.map(function (it, i) {
      return '<div class="ck-it' + (i === idx ? ' sel' : '') + (it.kind === 'ai' ? ' ck-ai' : '') + '" data-ck="' + i + '">' + esc(it.label) + (it.kind === 'page' ? '<small>page</small>' : '') + '</div>';
    }).join('') || '<div class="ck-it" style="color:#64748b">Aucune page — tape une phrase pour demander à l\'IA</div>';
  }

  function result(html) { var r = root.querySelector('.ck-res'); r.style.display = ''; r.innerHTML = html; }

  function run(i) {
    var it = items[i];
    if (!it) { if (input.value.trim().length >= 3) interpret(); return; }
    if (it.kind === 'page') { location.href = it.href; return; }
    interpret();
  }

  function interpret() {
    if (busy) return;
    busy = true;
    result('⏳ L\'IA interprète…');
    post('/api/ai-command', { action: 'interpret', text: input.value.trim(), pages: pages() }).then(function (j) {
      busy = false;
      var t = j.intent || {};
      if (t.type === 'naviguer' && t.href) { result('➡️ <a class="ck-btn" href="' + esc(t.href) + '">Aller sur cette page</a>'); return; }
      if ((t.type === 'ouvrir_lead' || t.type === 'note_lead') && t.leads) {
        if (!t.leads.length) { result('Aucun prospect trouvé pour « ' + esc(t.recherche) + ' ».'); return; }
        var h = '';
        if (t.type === 'note_lead') h += 'Note proposée (modifiable) :<textarea id="ckNote">' + esc(t.note) + '</textarea>Ajouter à :<br/>';
        t.leads.forEach(function (l) {
          h += t.type === 'ouvrir_lead'
            ? '<a class="ck-btn" href="sales-leads.html?leadId=' + encodeURIComponent(l.id) + '">👤 ' + esc(l.nom) + ' · ' + esc(l.statut || '') + '</a>'
            : '<span class="ck-btn" data-ckact="note" data-id="' + esc(l.id) + '">📝 ' + esc(l.nom) + '</span>';
        });
        result(h);
        return;
      }
      if (t.type === 'question' && role() === 'admin') {
        result('⏳ Je cherche dans les données…');
        post('/api/ai-ask', { question: t.question || input.value.trim(), history: [] })
          .then(function (a) { result(esc(a.answer).replace(/\n/g, '<br/>')); })
          .catch(function (e) { result('⚠️ ' + esc(e.message)); });
        return;
      }
      result('Je n\'ai pas compris — essaie « ouvre la fiche de … », « note sur … : … » ou le nom d\'une page.');
    }).catch(function (e) { busy = false; result('⚠️ ' + esc(e.message)); });
  }

  function act(b) {
    if (b.getAttribute('data-ckact') !== 'note') return;
    var txt = (document.getElementById('ckNote') || {}).value || '';
    if (!txt.trim()) return;
    b.textContent = '⏳';
    post('/api/ai-command', { action: 'addNote', leadId: b.getAttribute('data-id'), text: txt.trim() })
      .then(function () { result('✅ Note ajoutée. <a class="ck-btn" href="sales-leads.html?leadId=' + encodeURIComponent(b.getAttribute('data-id')) + '">Ouvrir la fiche</a>'); })
      .catch(function (e) { result('⚠️ ' + esc(e.message)); });
  }

  function open() { if (!root) build(); root.classList.add('on'); input.value = ''; idx = 0; filter(); setTimeout(function () { input.focus(); }, 20); }
  function close() { if (root) root.classList.remove('on'); }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      var r = role();
      if (['admin', 'sales', 'csm', 'coach'].indexOf(r) < 0) return;
      e.preventDefault();
      if (root && root.classList.contains('on')) close(); else open();
    }
  });
})();
