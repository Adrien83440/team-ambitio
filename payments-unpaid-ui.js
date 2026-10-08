/* ═══════════════════════════════════════════════════════════════════════════
   payments-unpaid-ui.js — onglet « Impayés » de payments.html (programme IA, Lot 3)
   ─────────────────────────────────────────────────────────────────────────
   Admin uniquement. Liste les dossiers à problème (api/payments-unpaid.js),
   déplie l'historique LIVE des prélèvements GoCardless (avec la cause des
   rejets) et permet de tracer l'état du recouvrement (cabinet externe —
   aucune relance automatique). ?tab=impayes ouvre directement l'onglet.
   ES5, compat SDK (firebase global).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var API = '/api/payments-unpaid';
  var data = null, loaded = false, histories = {};
  var REC = { '': '— Pas de recouvrement —', a_transmettre: '📤 À transmettre au cabinet', transmis: '⚖️ Transmis au cabinet', en_cours: '⏳ Recouvrement en cours', regle: '✅ Réglé', abandonne: '🗂 Abandonné' };
  var GC = { failed: 'Rejeté', charged_back: 'Contesté (chargeback)', cancelled: 'Annulé', customer_approval_denied: 'Refusé', paid_out: 'Versé', confirmed: 'Confirmé', submitted: 'Soumis', pending_submission: 'Programmé', pending_customer_approval: 'En attente client' };
  var CAUSE = { insufficient_funds: 'Provision insuffisante', mandate_cancelled: 'Mandat annulé', bank_account_closed: 'Compte bancaire clôturé', refer_to_payer: 'Refus de la banque (contacter le client)', authorisation_disputed: 'Contestation de l\'autorisation', invalid_bank_details: 'Coordonnées bancaires invalides', direct_debit_not_enabled: 'Prélèvement non autorisé sur ce compte' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function eur(n) { return (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €'; }
  function dFr(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : '—'; }
  function isAdmin() { try { return localStorage.getItem('ambitio_role') === 'admin'; } catch (e) { return false; } }
  function note(msg, err) { if (typeof window.toast === 'function') window.toast(msg, !err); } // toast(msg, ok) de payments.html

  function call(method, body) {
    var u = firebase.auth().currentUser;
    if (!u) return Promise.reject(new Error('Session expirée'));
    return u.getIdToken().then(function (tok) {
      var opt = { method: method, headers: { 'Authorization': 'Bearer ' + tok } };
      if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      return fetch(API, opt);
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || 'Erreur'); return j; });
  }

  function show(tab) {
    var list = $('payPaneList'), up = $('payPaneUnpaid');
    if (!list || !up) return;
    list.style.display = tab === 'unpaid' ? 'none' : '';
    up.style.display = tab === 'unpaid' ? '' : 'none';
    var bs = document.querySelectorAll('[data-paytab]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-paytab') === tab);
    if (tab === 'unpaid' && !loaded) load();
    try {
      var u = new URL(location.href);
      if (tab === 'unpaid') u.searchParams.set('tab', 'impayes'); else u.searchParams.delete('tab');
      history.replaceState(null, '', u.toString());
    } catch (e) {}
  }

  function load() {
    loaded = true;
    $('payPaneUnpaid').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Chargement des impayés…</div>';
    call('GET').then(function (j) { data = j; render(); })
      .catch(function (e) { loaded = false; $('payPaneUnpaid').innerHTML = '<div style="padding:40px;text-align:center;color:var(--pay-red)">⚠️ ' + esc(e.message) + '</div>'; });
  }

  function historyHtml(id) {
    var h = histories[id];
    if (!h) return '<div style="font-size:12px;color:var(--muted)">⏳ Lecture de l\'historique GoCardless…</div>';
    if (h.error) return '<div style="font-size:12px;color:var(--pay-red)">⚠️ ' + esc(h.error) + '</div>';
    if (!h.events.length) return '<div style="font-size:12px;color:var(--muted)">' + esc(h.note || 'Aucun prélèvement chez GoCardless.') + '</div>';
    var out = '';
    h.events.forEach(function (ev) {
      var bad = ['failed', 'charged_back', 'cancelled', 'customer_approval_denied'].indexOf(ev.status) >= 0;
      out += '<div class="up-ev"><span>' + dFr(ev.chargeDate) + '</span><span class="' + (bad ? 'ko' : (ev.status === 'paid_out' || ev.status === 'confirmed' ? 'ok' : '')) + '">' + esc(GC[ev.status] || ev.status) + '</span><span>' + eur(ev.amount) + '</span><span>' +
        (bad ? esc(CAUSE[ev.cause] || ev.cause || '') + (ev.detail ? ' — <span style="color:var(--muted)">' + esc(ev.detail) + '</span>' : '') : esc(ev.description || '')) + '</span></div>';
    });
    return out;
  }

  function render() {
    var k = data.kpis || {};
    var cnt = $('unpaidCount'); if (cnt) cnt.textContent = k.critiques ? String(k.critiques) : '';
    var h = '<div class="pay-stats">' +
      '<div class="pay-stat"><div class="pay-stat-l">Dossiers suivis</div><div class="pay-stat-v">' + (k.dossiers || 0) + '</div></div>' +
      '<div class="pay-stat"><div class="pay-stat-l">Critiques</div><div class="pay-stat-v" style="color:var(--pay-red)">' + (k.critiques || 0) + '</div></div>' +
      '<div class="pay-stat"><div class="pay-stat-l">Reste dû (plans concernés)</div><div class="pay-stat-v">' + eur(k.montantRestant) + '</div></div>' +
      '<div class="pay-stat"><div class="pay-stat-l">Chez le cabinet</div><div class="pay-stat-v" style="color:var(--pay-purple)">' + (k.chezCabinet || 0) + '</div></div></div>';
    if (!data.items.length) h += '<div style="padding:40px;text-align:center;color:var(--muted)">🎉 Aucun impayé détecté.</div>';
    data.items.forEach(function (it) {
      var rec = it.recouvrement || {};
      h += '<div class="up-row' + (it.severity >= 2 ? ' crit' : '') + '" data-up="' + esc(it.id) + '"><div class="up-hd" data-upact="toggle">';
      h += '<span class="up-nm">' + esc(it.client) + '</span><span class="pay-badge ' + esc(it.status) + '">' + esc(it.status) + '</span>';
      h += '<span class="up-amt">' + eur(it.dueAmount) + ' restant</span></div>';
      h += '<div class="up-iss">' + it.issues.map(function (x) { return '<span class="up-chip">' + esc(x) + '</span>'; }).join('') +
        (rec.status ? '<span class="up-chip rec">' + esc(REC[rec.status] || rec.status) + '</span>' : '') + '</div>';
      h += '<div class="up-meta">' + esc([it.description, it.installmentsCount > 1 ? it.paidCount + '/' + it.installmentsCount + ' échéances de ' + eur(it.installmentAmount) : '', eur(it.paidAmount) + ' encaissés sur ' + eur(it.totalAmount), it.closer ? 'closer ' + it.closer : '', it.phone, it.email].filter(Boolean).join(' · ')) + '</div>';
      h += '<div class="up-body"><div style="font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Historique GoCardless</div><div data-uphist="' + esc(it.id) + '">' + historyHtml(it.id) + '</div>';
      h += '<div class="up-rec"><select data-uprec="' + esc(it.id) + '">';
      Object.keys(REC).forEach(function (s) { h += '<option value="' + s + '"' + ((rec.status || '') === s ? ' selected' : '') + '>' + REC[s] + '</option>'; });
      h += '</select><input data-upnote="' + esc(it.id) + '" placeholder="Note (cabinet, référence dossier, échéancier…)" value="' + esc(rec.note || '') + '"/>' +
        '<button type="button" class="pay-btn pay-btn-primary" data-upact="save" data-id="' + esc(it.id) + '">Enregistrer</button>' +
        (it.leadId ? '<a class="pay-btn" href="sales-leads.html?leadId=' + encodeURIComponent(it.leadId) + '" target="_blank" rel="noopener">👁 Fiche</a>' : '') + '</div>';
      if (rec.history && rec.history.length) {
        h += '<div class="up-meta">' + rec.history.slice(-5).reverse().map(function (e) { return esc(new Date(e.at).toLocaleDateString('fr-FR') + ' · ' + (REC[e.status] || e.status || '—') + (e.note ? ' — ' + e.note : '') + ' (' + e.by + ')'); }).join('<br/>') + '</div>';
      }
      h += '</div></div>';
    });
    $('payPaneUnpaid').innerHTML = h;
  }

  function loadHistory(id) {
    if (histories[id]) return;
    call('POST', { action: 'history', paymentId: id })
      .then(function (j) { histories[id] = { events: j.events || [], note: j.note }; })
      .catch(function (e) { histories[id] = { error: e.message }; })
      .then(function () { var el = document.querySelector('[data-uphist="' + id + '"]'); if (el) el.innerHTML = historyHtml(id); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-paytab],[data-upact]') : null;
    if (!t) return;
    if (t.hasAttribute('data-paytab')) { show(t.getAttribute('data-paytab')); return; }
    var a = t.getAttribute('data-upact');
    var row = t.closest('[data-up]');
    if (a === 'toggle' && row) { row.classList.toggle('open'); if (row.classList.contains('open')) loadHistory(row.getAttribute('data-up')); return; }
    if (a === 'save') {
      var id = t.getAttribute('data-id');
      var st = document.querySelector('[data-uprec="' + id + '"]').value;
      var nt = document.querySelector('[data-upnote="' + id + '"]').value;
      t.disabled = true;
      call('POST', { action: 'recouvrement', paymentId: id, status: st, note: nt })
        .then(function () { note('Recouvrement mis à jour'); loaded = false; load(); })
        .catch(function (er) { t.disabled = false; note(er.message, true); });
    }
  });

  function start() {
    var tries = 0;
    (function wait() {
      var u = window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser;
      if (u) {
        if (!isAdmin()) return;
        var tabs = $('payTabs'); if (tabs) tabs.style.display = '';
        var p = new URLSearchParams(location.search);
        if (p.get('tab') === 'impayes') show('unpaid');
        else call('GET').then(function (j) { data = j; var c = $('unpaidCount'); if (c) c.textContent = j.kpis && j.kpis.critiques ? String(j.kpis.critiques) : ''; }).catch(function () {});
        return;
      }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
