/* ═══════════════════════════════════════════════════════════════════════════
   rdv-history.js — Historique des rendez-vous d'un prospect (21/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Demande Adrien : savoir exactement QUAND chaque RDV a été pris, quand il a
   été replanifié, s'il y a eu un deuxième RDV, etc. — dans la fiche Leads
   Live, la fiche CRM et Booking.

   Rien n'est écrit en base : tout se reconstitue depuis les documents
   `bookings` existants, donc rétroactivement sur tout l'historique.
     · date de prise      → createdAt du RDV (posé par tous les créateurs)
     · qui l'a pris       → source + bookedByName (setter) / prospect / admin
     · replanification    → une replanification ne déplace JAMAIS un RDV :
                            elle crée un nouveau document chaîné
                            (ancien.rescheduledToId ↔ nouveau.rescheduledFromId).
                            Date = createdAt du remplaçant, auteur = bloc
                            `cancellation` de l'ancien (via 'reschedule').

   Numérotation « par rendez-vous » (validée le 21/10/2026) :
     · une chaîne de replanifications = UN rendez-vous (RDV n°1, 3 créneaux) ;
     · un RDV indépendant (R2 après un R1, ou RDV repris après annulation sans
       chaînage) = rendez-vous suivant (RDV n°2), rangé par date de prise.
   Périmètre : Setting & Sales uniquement (coaching / CSM exclus, même
   classement que AlteoreFlow.classifyBooking).

   API (ES5, window.RdvHistory) :
     analyze(bookings, typeMap)   → { chains, info, total, resched }
     indexAll(bookings, typeMap)  → info { bookingId: {...} } pour une liste
                                    multi-prospects (regroupement leadId /
                                    e-mail / téléphone / chaînage)
     takenText(b, info)           → « Pris le … par … · RDV n°1 · 2e créneau »
     takenHTML(b, info)           → même texte, en ligne stylée
     badgeHTML(b, info)           → pastilles « RDV n°2 » / « 🔄 2e créneau »
     timelineHTML(analysis, opts) → frise complète
   Les RDV sont lus avec `id` (Leads Live, fiche CRM) ou `_id` (Booking).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CSS = [
    '.rdvh-taken{font-size:10.5px;color:var(--muted,#8f97b2);margin:2px 0 4px;line-height:1.45}',
    '.rdvh-taken b{color:var(--text,#eef0f8);font-weight:700}',
    '.rdvh-badge{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.3px;padding:1px 7px;border-radius:999px;margin-left:4px;vertical-align:middle;white-space:nowrap}',
    '.rdvh-badge.n{color:#60a5fa;border:1px solid rgba(96,165,250,.4);background:rgba(96,165,250,.1)}',
    '.rdvh-badge.r{color:#a78bfa;border:1px solid rgba(167,139,250,.4);background:rgba(167,139,250,.1)}',
    '.rdvh{margin:10px 0 4px;border:1px solid var(--border,rgba(148,163,214,.14));border-radius:12px;padding:10px 12px}',
    '.rdvh-title{font-size:12px;font-weight:800;color:var(--text,#eef0f8);margin-bottom:6px;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}',
    '.rdvh-title span{font-size:10.5px;font-weight:600;color:var(--muted,#8f97b2)}',
    '.rdvh-chain{padding:6px 0;border-top:1px dashed var(--border,rgba(148,163,214,.14))}',
    '.rdvh-chain:first-of-type{border-top:0}',
    '.rdvh-head{font-size:11.5px;font-weight:800;color:var(--text,#eef0f8);margin-bottom:3px}',
    '.rdvh-head span{font-weight:600;color:var(--muted,#8f97b2);font-size:10.5px}',
    '.rdvh-ev{list-style:none;margin:0;padding:0 0 0 10px;border-left:2px solid rgba(167,139,250,.35)}',
    '.rdvh-ev li{font-size:11px;line-height:1.45;color:var(--text,#eef0f8);padding:2px 0 2px 8px;position:relative}',
    '.rdvh-ev li:before{content:"";position:absolute;left:-15px;top:8px;width:8px;height:8px;border-radius:50%;background:#a78bfa}',
    '.rdvh-ev li.cx:before{background:#f87171}',
    '.rdvh-ev li.ok:before{background:#34d399}',
    '.rdvh-ev li.wait:before{background:#fbbf24}',
    '.rdvh-d{display:inline-block;min-width:108px;font-weight:700;color:var(--muted,#8f97b2);font-variant-numeric:tabular-nums}',
    '.rdvh-s{color:var(--muted,#8f97b2)}'
  ].join('\n');

  function ensureStyles() {
    if (document.getElementById('rdvhStyles')) return;
    var st = document.createElement('style');
    st.id = 'rdvhStyles';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  var JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function AF() { return window.AlteoreFlow || null; }
  function idOf(b) { return b ? (b.id || b._id || '') : ''; }

  /* Timestamp Firestore (compat ou sérialisé), ISO, Date, millisecondes. */
  function toDate(v) {
    if (!v) return null;
    try {
      if (typeof v.toDate === 'function') return v.toDate();
      if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
      if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
      if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
      var d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    } catch (e) { return null; }
  }
  /* Toujours l'heure de Paris (règle du 20/10/2026). */
  function fmtDT(d) {
    if (!d) return '';
    var A = AF();
    if (A && A.frDateTime) return A.frDateTime(d);
    return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  /* Créneau du RDV : date / heure déjà en heure de Paris dans le document. */
  function fmtSlot(b) {
    var m = String(b.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return (b.date || '?') + (b.time ? ' à ' + b.time : '');
    var wd = new Date(+m[1], +m[2] - 1, +m[3]).getDay();
    return JOURS[wd] + ' ' + m[3] + '/' + m[2] + '/' + m[1] + (b.time ? ' à ' + b.time : '');
  }
  function slotMs(b) {
    var m = String(b.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return 0;
    var t = String(b.time || '00:00').split(':');
    return new Date(+m[1], +m[2] - 1, +m[3], +t[0] || 0, +t[1] || 0).getTime();
  }
  function createdMs(b) { var d = toDate(b.createdAt); return d ? d.getTime() : 0; }
  function ordinal(n) { return n === 1 ? '1er' : n + 'e'; }

  function isExcluded(b, typeMap) {
    var A = AF();
    if (A && A.classifyBooking) return A.classifyBooking(b, typeMap || {}) === 'excluded';
    return b.isCoaching === true || b.source === 'csm_manual' || b.skipLeadCreation === true || !!b.clientId;
  }
  function isCancelled(b) { return b.outcome === 'annule' || (b.status === 'cancelled' && b.rescheduled !== true && b.outcome !== 'replanifie'); }

  /* Qui a pris le RDV (premier créneau d'une chaîne). */
  function takenBy(b) {
    if (b.source === 'admin_manual') return 'l’équipe (création manuelle dans Booking)';
    if (b.source === 'setter_booking') {
      if (b.setterLinkSlug) return 'le prospect' + (b.bookedByName ? ' (lien de ' + b.bookedByName + ')' : '');
      return b.bookedByName ? b.bookedByName : 'un setter';
    }
    return 'le prospect';
  }
  /* Qui a replanifié `prev` vers son remplaçant. */
  function reschedBy(prev) {
    var c = prev.cancellation || {};
    return c.byName || prev.outcomeByName || prev.cancelledByName || '';
  }
  function reschedAt(prev, next) {
    return toDate(next.createdAt) || toDate((prev.cancellation || {}).at) || toDate(prev.outcomeAt);
  }

  /* ── Chaînage d'un seul prospect ───────────────────────────────────── */
  function analyze(bookings, typeMap) {
    var list = [], byId = {};
    (bookings || []).forEach(function (b) {
      var id = idOf(b);
      if (!b || !id || byId[id] || isExcluded(b, typeMap)) return;
      byId[id] = b; list.push(b);
    });
    var next = {}, prev = {};
    list.forEach(function (b) {
      var from = b.rescheduledFromId;
      if (from && byId[from] && !next[from] && from !== idOf(b)) { next[from] = idOf(b); prev[idOf(b)] = from; }
    });
    list.forEach(function (b) {
      var id = idOf(b), to = b.rescheduledToId;
      if (to && byId[to] && !next[id] && !prev[to] && to !== id) { next[id] = to; prev[to] = id; }
    });
    var seen = {}, chains = [];
    function walk(rootId) {
      var items = [], cur = rootId;
      while (cur && !seen[cur] && byId[cur]) { seen[cur] = true; items.push(byId[cur]); cur = next[cur]; }
      if (items.length) chains.push({ items: items });
    }
    list.forEach(function (b) { if (!prev[idOf(b)]) walk(idOf(b)); });
    list.forEach(function (b) { if (!seen[idOf(b)]) walk(idOf(b)); }); // cycle éventuel : jamais perdu
    chains.forEach(function (c) { var r = c.items[0]; c.key = createdMs(r) || slotMs(r); });
    chains.sort(function (a, b) { return a.key - b.key; });
    var info = {}, resched = 0;
    chains.forEach(function (c, i) {
      c.rank = i + 1;
      var p = i > 0 ? chains[i - 1].items[chains[i - 1].items.length - 1] : null;
      c.after = p ? (isCancelled(p) ? 'annulation' : (p.outcome === 'no_show' || p.status === 'no_show' ? 'no-show' : '')) : '';
      resched += c.items.length - 1;
      c.items.forEach(function (b, k) {
        info[idOf(b)] = { rank: c.rank, slot: k + 1, slots: c.items.length, chain: c, prev: k > 0 ? c.items[k - 1] : null };
      });
    });
    return { chains: chains, info: info, total: chains.length, resched: resched };
  }

  /* ── Liste multi-prospects (Booking) : regroupe puis chaîne ────────── */
  function indexAll(bookings, typeMap) {
    var parent = {};
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    var keyOwner = {}, list = [];
    (bookings || []).forEach(function (b) {
      var id = idOf(b);
      if (!b || !id || parent[id] || isExcluded(b, typeMap)) return;
      parent[id] = id; list.push(b);
    });
    list.forEach(function (b) {
      var id = idOf(b), pr = b.prospect || {};
      var em = String(pr.email || b.email || '').trim().toLowerCase();
      var tel = String(pr.telephone || pr.phone || '').replace(/\D/g, '').slice(-9);
      var keys = [];
      if (b.leadId) keys.push('l:' + b.leadId);
      if (em) keys.push('e:' + em);
      if (tel.length === 9) keys.push('t:' + tel);
      keys.forEach(function (k) { if (keyOwner[k]) union(id, keyOwner[k]); else keyOwner[k] = id; });
      if (b.rescheduledFromId && parent[b.rescheduledFromId]) union(id, b.rescheduledFromId);
      if (b.rescheduledToId && parent[b.rescheduledToId]) union(id, b.rescheduledToId);
    });
    var groups = {};
    list.forEach(function (b) { var r = find(idOf(b)); (groups[r] = groups[r] || []).push(b); });
    var all = {};
    Object.keys(groups).forEach(function (g) {
      var inf = analyze(groups[g], typeMap).info;
      Object.keys(inf).forEach(function (k) { all[k] = inf[k]; });
    });
    return all;
  }

  /* ── Rendus ────────────────────────────────────────────────────────── */
  function infoFor(b, info) {
    if (!info) return null;
    if (info.info) info = info.info; // accepte le résultat d'analyze()
    return info[idOf(b)] || null;
  }

  function takenText(b, info) {
    var i = infoFor(b, info);
    var d = toDate(b.createdAt);
    var parts = [];
    if (i && i.slot > 1 && i.prev) {
      var root = i.chain.items[0], rd = toDate(root.createdAt);
      parts.push('Pris le ' + (rd ? fmtDT(rd) : 'date inconnue') + ' par ' + takenBy(root));
      var who = reschedBy(i.prev);
      parts.push('replanifié le ' + (d ? fmtDT(d) : 'date inconnue') + (who ? ' par ' + who : ''));
    } else {
      parts.push((d ? 'Pris le ' + fmtDT(d) : 'Date de prise inconnue') + ' par ' + takenBy(b));
    }
    if (i) {
      parts.push('RDV n°' + i.rank + (i.slots > 1 ? ' · ' + ordinal(i.slot) + ' créneau sur ' + i.slots : ''));
      if (i.slot === 1 && i.chain.after) parts.push('après ' + i.chain.after + ' du RDV n°' + (i.rank - 1));
    }
    return parts.join(' · ');
  }
  function takenHTML(b, info) {
    ensureStyles();
    return '<div class="rdvh-taken">🗓️ ' + esc(takenText(b, info)) + '</div>';
  }
  function badgeHTML(b, info) {
    ensureStyles();
    var i = infoFor(b, info), h = '';
    if (i && i.rank > 1) h += '<span class="rdvh-badge n" title="' + esc(takenText(b, info)) + '">RDV n°' + i.rank + '</span>';
    if (i && i.slot > 1) h += '<span class="rdvh-badge r" title="' + esc(takenText(b, info)) + '">🔄 ' + ordinal(i.slot) + ' créneau</span>';
    else if (!i && b.rescheduledFromId) h += '<span class="rdvh-badge r">🔄 Replanifié</span>';
    return h;
  }

  function isPast(b) {
    if (window.RdvOutcome && window.RdvOutcome.isPastBooking) { try { return window.RdvOutcome.isPastBooking(b); } catch (e) {} }
    return slotMs(b) < Date.now();
  }

  /* État final du dernier créneau d'une chaîne. */
  function endEvent(b) {
    var A = AF();
    if (b.outcome && b.outcome !== 'replanifie' && b.outcome !== 'annule') {
      var o = (A && A.OUTCOMES && A.OUTCOMES[b.outcome]) || { icon: '🎯', label: b.outcome };
      return { d: toDate(b.outcomeAt), cls: b.outcome === 'close' ? 'ok' : '', txt: (o.icon || '🎯') + ' Résultat : ' + o.label + (b.outcomeByName ? ' — saisi par ' + b.outcomeByName : '') + (b.outcomeNote ? ' — ' + b.outcomeNote : '') };
    }
    if (isCancelled(b)) {
      var ci = (A && A.cancellationInfo) ? A.cancellationInfo(b) : null;
      var lbl = ci && ci.origin === 'prospect' ? 'Annulé par le prospect' : (ci && ci.origin === 'equipe' ? 'Annulé par l’équipe' : 'Annulé');
      if (ci && ci.byName) lbl += (ci.origin === 'prospect' ? ' — enregistré par ' : ' — ') + ci.byName;
      if (ci && ci.reason) lbl += ' — ' + ci.reason;
      return { d: ci && ci.at ? toDate(ci.at) : null, cls: 'cx', txt: '🔴 ' + lbl };
    }
    if (b.status === 'no_show') return { d: null, cls: 'cx', txt: '🚫 No-show' };
    if (b.status === 'completed') return { d: null, cls: 'ok', txt: '✅ Terminé' };
    if (isPast(b)) return { d: null, cls: 'wait', txt: '⚠️ RDV passé, résultat pas encore saisi' };
    return { d: null, cls: 'wait', txt: '⏳ À venir' };
  }

  /* opts : { title, personName: function(b) → nom de l'expert } */
  function timelineHTML(an, opts) {
    ensureStyles();
    opts = opts || {};
    if (!an || !an.total) return '';
    function who(b) {
      var n = opts.personName ? opts.personName(b) : (b.personName || '');
      var t = (b.consultation && b.consultation.label) || b.typeLabel || b.typeName || '';
      return [t, n].filter(Boolean).join(' · ');
    }
    var h = '<div class="rdvh">';
    h += '<div class="rdvh-title">' + esc(opts.title || '📜 Historique des RDV') + '<span>' + an.total + ' RDV' + (an.resched ? ' · ' + an.resched + ' replanification' + (an.resched > 1 ? 's' : '') : '') + '</span></div>';
    an.chains.forEach(function (c) {
      h += '<div class="rdvh-chain"><div class="rdvh-head">RDV n°' + c.rank;
      h += '<span>' + (c.items.length > 1 ? ' · ' + c.items.length + ' créneaux' : '') + (c.after ? ' · après ' + c.after + ' du RDV n°' + (c.rank - 1) : '') + '</span></div>';
      h += '<ol class="rdvh-ev">';
      c.items.forEach(function (b, k) {
        var d, txt, w = who(b);
        if (k === 0) {
          d = toDate(b.createdAt);
          txt = '📌 Pris par ' + esc(takenBy(b)) + ' — pour le <b>' + esc(fmtSlot(b)) + '</b>' + (w ? ' <span class="rdvh-s">· ' + esc(w) + '</span>' : '');
        } else {
          var p = c.items[k - 1], by = reschedBy(p);
          d = reschedAt(p, b);
          txt = '📅 Replanifié' + (by ? ' par ' + esc(by) : '') + ' — <span class="rdvh-s">' + esc(fmtSlot(p)) + '</span> → <b>' + esc(fmtSlot(b)) + '</b>' + (w ? ' <span class="rdvh-s">· ' + esc(w) + '</span>' : '');
        }
        h += '<li><span class="rdvh-d">' + esc(d ? fmtDT(d) : 'date inconnue') + '</span> ' + txt + '</li>';
      });
      var e = endEvent(c.items[c.items.length - 1]);
      h += '<li class="' + e.cls + '"><span class="rdvh-d">' + esc(e.d ? fmtDT(e.d) : '') + '</span> ' + esc(e.txt) + '</li>';
      h += '</ol></div>';
    });
    return h + '</div>';
  }

  window.RdvHistory = {
    analyze: analyze,
    indexAll: indexAll,
    takenText: takenText,
    takenHTML: takenHTML,
    badgeHTML: badgeHTML,
    timelineHTML: timelineHTML,
    toDate: toDate,
    fmtDateTime: fmtDT
  };
})();
