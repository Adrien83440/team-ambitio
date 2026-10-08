/* ═══════════════════════════════════════════════════════════════════════════
   ai-followup-popup.js — pop-up « Relance proposée » (programme IA, Lot 2)
   ─────────────────────────────────────────────────────────────────────────
   Injecté par nav.js sur toutes les pages internes ; ne s'active que pour
   les rôles sales / admin. Interroge /api/ai-followup (action 'mine') au
   chargement puis toutes les 3 minutes. Pour chaque relance en attente, le
   closer du deal voit le message proposé par l'IA, peut le MODIFIER, choisir
   SMS ou email, puis : Envoyer · Pas cette fois · Ne plus relancer · Plus tard.
   Rien ne part sans ce clic (règle d'or du programme IA).
   Admin : bascule « Équipe » pour voir les relances en attente des autres.
   Repli en pastille mémorisé (sessionStorage). ES5, sans SDK (jeton Auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__aiFollowupPopup) return;
  window.__aiFollowupPopup = true;

  var API = '/api/ai-followup';
  var POLL_MS = 3 * 60 * 1000;
  var items = [], idx = 0, teamPending = 0, showAll = false, busy = false, channel = 'sms';
  var root = null;

  function role() { try { return localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function minimized() { try { return sessionStorage.getItem('aifu_min') === '1'; } catch (e) { return false; } }
  function setMin(v) { try { sessionStorage.setItem('aifu_min', v ? '1' : '0'); } catch (e) {} }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }

  function call(body) {
    var u = user();
    if (!u) return Promise.reject(new Error('Session non prête'));
    return u.getIdToken().then(function (tok) {
      return fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.message || j.error || ('Erreur ' + r.status));
        return j;
      });
    });
  }

  function css() {
    if (document.getElementById('aifu-css')) return;
    var s = document.createElement('style');
    s.id = 'aifu-css';
    s.textContent =
      '.aifu{position:fixed;left:18px;bottom:18px;z-index:2500;width:380px;max-width:calc(100vw - 32px);font-family:inherit;color:#eef0ff}' +
      '.aifu-card{background:#12121e;border:1px solid rgba(129,140,248,.35);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden}' +
      '.aifu-hd{display:flex;align-items:center;gap:8px;padding:11px 13px;background:linear-gradient(135deg,rgba(99,102,241,.2),rgba(168,85,247,.1));border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.aifu-hd b{flex:1;font-size:13px}' +
      '.aifu-x{background:none;border:0;color:inherit;opacity:.6;cursor:pointer;font-size:14px;padding:2px 6px}' +
      '.aifu-bd{padding:12px 13px}' +
      '.aifu-who{font-size:14px;font-weight:800}.aifu-sub{font-size:11.5px;opacity:.6;margin-top:2px}' +
      '.aifu-angle{font-size:12px;line-height:1.45;margin:8px 0;padding:7px 9px;border-radius:9px;background:rgba(129,140,248,.1);color:#c7d2fe}' +
      '.aifu-tabs{display:flex;gap:6px;margin:8px 0 6px}' +
      '.aifu-tab{flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:none;color:inherit;font-size:12px;font-weight:700;cursor:pointer;opacity:.65}' +
      '.aifu-tab.on{opacity:1;border-color:rgba(129,140,248,.6);background:rgba(129,140,248,.12)}' +
      '.aifu input,.aifu textarea{width:100%;box-sizing:border-box;background:#0b0b14;border:1px solid rgba(255,255,255,.1);border-radius:9px;color:inherit;font-family:inherit;font-size:12.5px;line-height:1.5;padding:8px 9px;outline:0}' +
      '.aifu textarea{min-height:110px;resize:vertical}.aifu input{margin-bottom:6px}' +
      '.aifu input:focus,.aifu textarea:focus{border-color:#818cf8}' +
      '.aifu-cnt{font-size:10.5px;opacity:.5;text-align:right;margin-top:3px}' +
      '.aifu-acts{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}' +
      '.aifu-b{padding:8px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:inherit;font-size:12px;font-weight:700;cursor:pointer}' +
      '.aifu-b.go{grid-column:1/-1;background:linear-gradient(135deg,#6366f1,#a855f7);border:0;color:#fff;font-size:13px;padding:10px}' +
      '.aifu-b[disabled]{opacity:.5;cursor:wait}' +
      '.aifu-nav{display:flex;align-items:center;gap:8px;font-size:11px;opacity:.7;margin-top:8px}.aifu-nav .sp{flex:1}' +
      '.aifu-nav button{background:none;border:1px solid rgba(255,255,255,.15);color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer}' +
      '.aifu-pill{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:1px solid rgba(129,140,248,.45);background:#12121e;box-shadow:0 10px 30px rgba(0,0,0,.4);cursor:pointer;font-size:12.5px;font-weight:800;color:#eef0ff}' +
      '.aifu-pill i{font-style:normal;background:#a855f7;color:#fff;border-radius:999px;padding:1px 7px;font-size:11px}' +
      '.aifu-err{font-size:11.5px;color:#fca5a5;margin-top:6px}' +
      'body.light-theme .aifu{color:#1f2140}body.light-theme .aifu-card,body.light-theme .aifu-pill{background:#fff;color:#1f2140}' +
      'body.light-theme .aifu input,body.light-theme .aifu textarea{background:#f6f6fb;border-color:rgba(99,102,241,.2)}' +
      'body.light-theme .aifu-angle{color:#4338ca}' +
      '@media (max-width:640px){.aifu{left:12px;right:12px;bottom:12px;width:auto}}';
    document.head.appendChild(s);
  }

  function outcomeLabel(o) { return o === 'offre' ? 'offre faite, en réflexion' : 'non closé'; }
  function dueLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function render(err) {
    if (!root) return;
    if (!items.length) { root.innerHTML = ''; return; }
    if (minimized()) {
      root.innerHTML = '<div class="aifu-pill" data-fu="open">🤖 Relance' + (items.length > 1 ? 's' : '') + ' à valider <i>' + items.length + '</i></div>';
      return;
    }
    if (idx >= items.length) idx = 0;
    var it = items[idx];
    var st = it.step || {};
    var h = '<div class="aifu-card"><div class="aifu-hd"><span>🤖</span><b>Relance proposée · étape ' + st.n + '/' + it.totalSteps + '</b>';
    if (role() === 'admin') h += '<button type="button" class="aifu-x" data-fu="team" title="Basculer mes relances / toute l\'équipe">' + (showAll ? '👥' : '👤') + '</button>';
    h += '<button type="button" class="aifu-x" data-fu="min" title="Réduire">—</button></div>';
    h += '<div class="aifu-bd"><div class="aifu-who">' + esc(it.prospectName) + '</div>';
    h += '<div class="aifu-sub">RDV ' + esc(outcomeLabel(it.outcome)) + (it.mine ? '' : ' · closer : ' + esc(it.closerName || '?')) + (st.dueAt ? ' · prévue le ' + dueLabel(st.dueAt) : '') + '</div>';
    if (st.angle) h += '<div class="aifu-angle">💡 ' + esc(st.angle) + '</div>';
    h += '<div class="aifu-tabs"><button type="button" class="aifu-tab' + (channel === 'sms' ? ' on' : '') + '" data-fu="ch" data-ch="sms">💬 SMS</button>' +
         '<button type="button" class="aifu-tab' + (channel === 'email' ? ' on' : '') + '" data-fu="ch" data-ch="email">✉️ Email</button></div>';
    if (channel === 'sms') {
      h += '<textarea id="aifuSms">' + esc(st.sms || '') + '</textarea><div class="aifu-cnt" id="aifuCnt"></div>';
    } else {
      h += '<input id="aifuSubj" value="' + esc(st.emailSubject || '') + '"/><textarea id="aifuBody" style="min-height:160px">' + esc(st.emailBody || '') + '</textarea>';
    }
    h += '<div class="aifu-acts"><button type="button" class="aifu-b go" data-fu="send"' + (busy ? ' disabled' : '') + '>' + (busy ? '⏳ Envoi…' : '✅ Envoyer ' + (channel === 'sms' ? 'le SMS' : 'l\'email')) + '</button>' +
         '<button type="button" class="aifu-b" data-fu="skip"' + (busy ? ' disabled' : '') + '>⏭ Pas cette fois</button>' +
         '<button type="button" class="aifu-b" data-fu="stop"' + (busy ? ' disabled' : '') + '>🛑 Ne plus relancer</button>' +
         '<button type="button" class="aifu-b" data-fu="later"' + (busy ? ' disabled' : '') + '>⏰ Dans 3 h</button>' +
         (it.leadId ? '<a class="aifu-b" style="text-align:center;text-decoration:none" href="sales-leads.html?leadId=' + encodeURIComponent(it.leadId) + '" target="_blank" rel="noopener">👁 Fiche</a>' : '<span></span>') + '</div>';
    if (err) h += '<div class="aifu-err">⚠️ ' + esc(err) + '</div>';
    if (items.length > 1) h += '<div class="aifu-nav"><button type="button" data-fu="prev">‹</button><span>' + (idx + 1) + ' / ' + items.length + '</span><button type="button" data-fu="next">›</button><span class="sp"></span></div>';
    h += '</div></div>';
    root.innerHTML = h;
    updCount();
  }

  function updCount() {
    var ta = document.getElementById('aifuSms'), c = document.getElementById('aifuCnt');
    if (ta && c) { var n = ta.value.length; c.textContent = n + ' caractères' + (n > 160 ? ' · ' + Math.ceil(n / 153) + ' SMS' : ''); }
  }

  // Les modifications à la main sont conservées en changeant d'onglet.
  function captureEdits() {
    var it = items[idx]; if (!it) return;
    var a = document.getElementById('aifuSms'); if (a) it.step.sms = a.value;
    var b = document.getElementById('aifuSubj'); if (b) it.step.emailSubject = b.value;
    var c = document.getElementById('aifuBody'); if (c) it.step.emailBody = c.value;
  }

  function load() {
    call({ action: 'mine', all: showAll }).then(function (j) {
      var prevId = items[idx] && items[idx].id;
      items = j.items || [];
      teamPending = j.teamPending || 0;
      var k = -1;
      for (var i = 0; i < items.length; i++) if (items[i].id === prevId) k = i;
      idx = k >= 0 ? k : 0;
      if (!busy && !(document.activeElement && root && root.contains(document.activeElement))) render();
    }).catch(function () { /* silencieux : réessai au prochain cycle */ });
  }

  function decide(decision) {
    var it = items[idx]; if (!it || busy) return;
    captureEdits();
    if (decision === 'stop' && !confirm('Ne plus proposer de relance pour ' + it.prospectName + ' ?')) return;
    busy = true; render();
    var body = { action: 'decide', id: it.id, decision: decision, channel: channel };
    if (decision === 'send') { body.sms = it.step.sms; body.emailSubject = it.step.emailSubject; body.emailBody = it.step.emailBody; }
    call(body).then(function () {
      busy = false;
      items.splice(idx, 1);
      if (idx >= items.length) idx = 0;
      channel = 'sms';
      render();
    }).catch(function (e) { busy = false; render(e.message); });
  }

  function start() {
    var r = role();
    if (r !== 'sales' && r !== 'admin') return;
    css();
    root = document.createElement('div');
    root.className = 'aifu';
    document.body.appendChild(root);
    root.addEventListener('input', function (e) { if (e.target && e.target.id === 'aifuSms') updCount(); });
    root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-fu]') : null;
      if (!t) return;
      var a = t.getAttribute('data-fu');
      if (a === 'open') { setMin(false); render(); return; }
      if (a === 'min') { captureEdits(); setMin(true); render(); return; }
      if (a === 'ch') { captureEdits(); channel = t.getAttribute('data-ch'); render(); return; }
      if (a === 'prev' || a === 'next') { captureEdits(); idx = (idx + (a === 'next' ? 1 : -1) + items.length) % items.length; channel = 'sms'; render(); return; }
      if (a === 'team') { showAll = !showAll; load(); return; }
      if (a === 'send' || a === 'skip' || a === 'stop' || a === 'later') decide(a);
    });
    var tries = 0;
    (function wait() {
      if (user()) { load(); setInterval(load, POLL_MS); return; }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
