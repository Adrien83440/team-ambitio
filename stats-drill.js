/* ═══════════════════════════════════════════════════════════════════════
   stats-drill.js — listes nominatives derrière les chiffres (21/11/2026)
   ───────────────────────────────────────────────────────────────────────
   Demande Vincent : « je clique sur les 7 et je vois de qui c'était ».
   Partagé par Set NB (sales-setting.html), Close SB (sales-closing.html)
   et le Stats funnel (sales-funnel.html). LECTURE SEULE : rien n'est écrit,
   aucune requête — la page appelante fournit les lignes déjà chargées.

   Une ligne (« item ») :
     { name, leadId, date ('AAAA-MM-JJ'), time, status (texte), statusColor,
       setter, closer, info, con, paid, pending, flag }
   Les montants (con / paid / pending) sont en HT, déjà calculés par la règle
   REVENUE de funnel-core.js (FunnelCore.revClient) — jamais recalculés ici.

   API :
     StatsDrill.cell(html, ref)        → enveloppe un chiffre cliquable
     StatsDrill.bind(root, resolver)   → délégation : resolver(ref) → options
     StatsDrill.open(options)          → ouvre la liste
     StatsDrill.bookingItem(b, ctx)    → ligne normalisée depuis un RDV
   ES5 strict, aucune dépendance.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var STYLE_ID = 'sdStyle';
  var MODAL_ID = 'sdModal';

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtEuro(n) { return (Math.round(Number(n) || 0)).toLocaleString('fr-FR') + ' €'; }
  function frDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7);
  }

  /* Peinture uniquement, par variables de thème (sombre et clair) : aucune
     couleur de surface codée en dur, donc rien à régénérer côté thème clair. */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.sd-click{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;text-decoration-color:var(--muted2,#596180)}' +
      '.sd-click:hover{text-decoration-style:solid;text-decoration-color:currentColor}' +
      '.sd-bg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(3,5,14,.72);z-index:9995;display:none;align-items:center;justify-content:center;padding:20px}' +
      '.sd-bg.show{display:flex}' +
      '.sd-box{background:var(--bg2,#0e111c);color:var(--text,#eef0f8);border:1px solid var(--border2,rgba(148,163,214,.22));border-radius:18px;width:100%;max-width:980px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 36px rgba(3,5,14,.55)}' +
      '.sd-head{padding:18px 22px 10px;display:flex;gap:12px;align-items:flex-start}' +
      '.sd-head h3{margin:0;font-size:16px;font-weight:700;flex:1;line-height:1.35}' +
      '.sd-x{background:none;border:1px solid var(--border2,rgba(148,163,214,.22));color:inherit;border-radius:9px;padding:4px 10px;font-size:13px;cursor:pointer}' +
      '.sd-sub{padding:0 22px 8px;font-size:12px;color:var(--muted,#8f97b2);line-height:1.5}' +
      '.sd-note{margin:0 22px 10px;padding:9px 12px;border:1px solid var(--gold,#fbbf24);border-radius:10px;font-size:12px;line-height:1.5;color:var(--gold,#fbbf24)}' +
      '.sd-body{overflow:auto;padding:0 22px 18px}' +
      '.sd-table{width:100%;border-collapse:collapse;font-size:12.5px}' +
      '.sd-table th{text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--muted,#8f97b2);padding:8px 10px 8px 0;border-bottom:1px solid var(--border2,rgba(148,163,214,.22));white-space:nowrap;position:sticky;top:0;background:var(--bg2,#0e111c)}' +
      '.sd-table td{padding:8px 10px 8px 0;border-bottom:1px solid var(--border,rgba(148,163,214,.11));vertical-align:top}' +
      '.sd-table td.num,.sd-table th.num{text-align:right;white-space:nowrap}' +
      '.sd-table tfoot td{font-weight:700;border-bottom:none;border-top:1px solid var(--border2,rgba(148,163,214,.22))}' +
      '.sd-table a{color:var(--blue,#5b7cfa);text-decoration:none;font-weight:600}' +
      '.sd-table a:hover{text-decoration:underline}' +
      '.sd-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
      '.sd-mut{color:var(--muted,#8f97b2)}' +
      '.sd-flag{display:block;font-size:11px;color:var(--gold,#fbbf24);margin-top:2px}' +
      '.sd-empty{padding:26px 0;text-align:center;color:var(--muted,#8f97b2);font-size:13px}' +
      '@media (max-width:640px){.sd-bg{padding:8px}.sd-head{padding:14px 14px 8px}.sd-sub{padding:0 14px 8px}.sd-note{margin:0 14px 10px}.sd-body{padding:0 14px 14px}}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  function ensureModal() {
    var bg = document.getElementById(MODAL_ID);
    if (bg) return bg;
    bg = document.createElement('div');
    bg.id = MODAL_ID;
    bg.className = 'sd-bg';
    bg.innerHTML = '<div class="sd-box" role="dialog" aria-modal="true"><div class="sd-head"><h3 id="sdTitle"></h3><button type="button" class="sd-x" data-sd-close="1">Fermer ✕</button></div><div class="sd-sub" id="sdSub"></div><div id="sdNote"></div><div class="sd-body" id="sdBody"></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      var t = e.target;
      if (t === bg || (t && t.getAttribute && t.getAttribute('data-sd-close'))) close();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && bg.className.indexOf('show') >= 0) close();
    });
    return bg;
  }
  function close() {
    var bg = document.getElementById(MODAL_ID);
    if (bg) bg.className = 'sd-bg';
  }

  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      var ka = (a.date || '') + ' ' + (a.time || ''), kb = (b.date || '') + ' ' + (b.time || '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  /* options : { title, sub, note, items, money, noLink, dateLabel, empty } */
  function open(o) {
    o = o || {};
    ensureStyle();
    var bg = ensureModal();
    var items = sortItems(o.items || []);
    var money = o.money === true;
    var showSetter = items.some(function (it) { return !!it.setter; });
    var showCloser = items.some(function (it) { return !!it.closer; });
    var showStatus = items.some(function (it) { return !!it.status; });
    var showInfo = items.some(function (it) { return !!it.info; });
    var showDate = items.some(function (it) { return !!it.date; });

    document.getElementById('sdTitle').innerHTML = esc(o.title || 'Détail') +
      ' <span class="sd-mut" style="font-weight:500">· ' + items.length + ' ligne' + (items.length > 1 ? 's' : '') + '</span>';
    document.getElementById('sdSub').innerHTML = o.sub ? esc(o.sub) : '';
    document.getElementById('sdNote').innerHTML = o.note ? '<div class="sd-note">' + esc(o.note) + '</div>' : '';

    var h = '';
    if (!items.length) {
      h = '<div class="sd-empty">' + esc(o.empty || 'Aucune ligne derrière ce chiffre.') + '</div>';
    } else {
      h = '<table class="sd-table"><thead><tr><th>Nom</th>';
      if (showDate) h += '<th>' + esc(o.dateLabel || 'Date') + '</th>';
      if (showStatus) h += '<th>Résultat</th>';
      if (showSetter) h += '<th>Setter</th>';
      if (showCloser) h += '<th>Closer</th>';
      if (showInfo) h += '<th>Précision</th>';
      if (money) h += '<th class="num">Contracté HT</th><th class="num">Encaissé HT</th><th class="num">1er prélèv. en attente</th>';
      h += '</tr></thead><tbody>';
      var tCon = 0, tPaid = 0, tPend = 0;
      items.forEach(function (it) {
        var nm = esc(it.name || '(sans nom)');
        if (it.leadId && !o.noLink) {
          nm = '<a href="sales-leads.html?leadId=' + encodeURIComponent(it.leadId) + '" target="_blank" rel="noopener" title="Ouvrir la fiche">' + nm + '</a>';
        }
        h += '<tr><td>' + nm + (it.flag ? '<span class="sd-flag">' + esc(it.flag) + '</span>' : '') + '</td>';
        if (showDate) h += '<td style="white-space:nowrap">' + esc(frDate(it.date)) + (it.time ? ' <span class="sd-mut">' + esc(it.time) + '</span>' : '') + '</td>';
        if (showStatus) h += '<td style="white-space:nowrap">' + (it.status ? '<span class="sd-dot" style="background:' + esc(it.statusColor || '#8f97b2') + '"></span>' + esc(it.status) : '') + '</td>';
        if (showSetter) h += '<td>' + (it.setter ? esc(it.setter) : '<span class="sd-mut">—</span>') + '</td>';
        if (showCloser) h += '<td>' + (it.closer ? esc(it.closer) : '<span class="sd-mut">—</span>') + '</td>';
        if (showInfo) h += '<td class="sd-mut">' + esc(it.info || '') + '</td>';
        if (money) {
          tCon += Number(it.con) || 0; tPaid += Number(it.paid) || 0; tPend += Number(it.pending) || 0;
          h += '<td class="num">' + (it.con > 0 ? fmtEuro(it.con) : '<span class="sd-mut">—</span>') + '</td>' +
            '<td class="num">' + (it.paid > 0 ? fmtEuro(it.paid) : '<span class="sd-mut">0 €</span>') + '</td>' +
            '<td class="num">' + (it.pending > 0 ? '⏳ ' + fmtEuro(it.pending) : '<span class="sd-mut">—</span>') + '</td>';
        }
        h += '</tr>';
      });
      h += '</tbody>';
      if (money) {
        var span = 1 + (showDate ? 1 : 0) + (showStatus ? 1 : 0) + (showSetter ? 1 : 0) + (showCloser ? 1 : 0) + (showInfo ? 1 : 0);
        h += '<tfoot><tr><td colspan="' + span + '">Total</td><td class="num">' + fmtEuro(tCon) + '</td><td class="num">' + fmtEuro(tPaid) + '</td><td class="num">' + (tPend > 0 ? '⏳ ' + fmtEuro(tPend) : '—') + '</td></tr></tfoot>';
      }
      h += '</table>';
    }
    var body = document.getElementById('sdBody');
    body.innerHTML = h;
    body.scrollTop = 0;
    bg.className = 'sd-bg show';
  }

  /* Chiffre cliquable : <span class="sd-click" data-sd="ref">…</span>. */
  function cell(html, ref) {
    ensureStyle();
    return '<span class="sd-click" data-sd="' + esc(ref) + '" role="button" tabindex="0" title="Voir la liste">' + html + '</span>';
  }

  /* Délégation sur un conteneur stable. resolver(ref, element) → options de
     open(), ou null. Posée UNE fois par conteneur. */
  function bind(root, resolver) {
    if (!root || root._sdBound) return;
    root._sdBound = true;
    ensureStyle();
    function fire(e) {
      var t = e.target;
      while (t && t !== root) {
        if (t.getAttribute && t.getAttribute('data-sd') != null) {
          var o = resolver(t.getAttribute('data-sd'), t);
          if (o) { e.preventDefault(); open(o); }
          return;
        }
        t = t.parentNode;
      }
    }
    root.addEventListener('click', fire);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) fire(e);
    });
  }

  /* Résultat lisible d'un RDV — mêmes prédicats que les rapports :
     l'outcome saisi fait foi, sinon le statut du RDV. */
  var OC = {
    close: ['Close', '#34d399'], non_close: ['Non close', '#f87171'], offre: ['Offre pitchée', '#5b7cfa'],
    disqualifie: ['Disqualifié', '#94a3b8'], no_show: ['No-show', '#fbbf24'], annule: ['Annulé', '#ef4444'],
    replanifie: ['Replanifié', '#a78bfa']
  };
  function bookingStatus(b, todayIso) {
    var oc = b.outcome || null;
    if (oc && OC[oc]) return OC[oc];
    if (b.status === 'cancelled') return b.rescheduled === true ? OC.replanifie : OC.annule;
    if (b.status === 'no_show') return OC.no_show;
    if (b.status === 'completed') return ['Tenu (sans détail)', '#2dd4bf'];
    if (b.status === 'confirmed' || b.status === 'pending') {
      return (b.date && todayIso && b.date < todayIso) ? ['À statuer', '#fbbf24'] : ['À venir', '#8f97b2'];
    }
    return [b.status || '—', '#8f97b2'];
  }

  /* ctx : { todayIso, setter, closer, rv, byCreation }
     rv = verdict FunnelCore.revClient du close (ou null). */
  function bookingItem(b, ctx) {
    ctx = ctx || {};
    var st = bookingStatus(b, ctx.todayIso);
    var pr = b.prospect || {};
    var it = {
      name: pr.nom || b.leadName || pr.email || b.id || b._id || '',
      leadId: b.leadId || null,
      date: b.date || '',
      time: b.time || '',
      status: st[0], statusColor: st[1],
      setter: ctx.setter || '',
      closer: ctx.closer || '',
      info: ctx.info || '',
      con: 0, paid: 0, pending: 0, flag: ''
    };
    var rv = ctx.rv || null;
    if (rv) {
      if (rv.cancelled) it.flag = 'Close annulé (' + (rv.reason || '') + ') — retiré des closes et des montants';
      else if (rv.dup) it.flag = 'Même client qu\'un autre RDV closé — montants comptés une seule fois';
      else {
        it.con = rv.con || 0; it.paid = rv.paid || 0; it.pending = rv.pending || 0;
        if (!rv.hasPay) it.flag = 'Aucun paiement dans le module Paiements' + (rv.declCol > 0 ? ' — encaissé déclaré ' + fmtEuro(rv.declCol) + ', non compté' : '');
      }
    } else if (ctx.decl) {
      it.con = Number(ctx.decl.contracte) || 0; it.paid = Number(ctx.decl.collecte) || 0;
      it.flag = 'Montants déclarés au close (module Paiements illisible)';
    }
    return it;
  }

  window.StatsDrill = {
    esc: esc, fmtEuro: fmtEuro, frDate: frDate,
    open: open, close: close, cell: cell, bind: bind,
    bookingItem: bookingItem, bookingStatus: bookingStatus
  };
})();
