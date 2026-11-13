/* ============================================================================
   lqs-dossier.js — DOSSIERS PAR PROSPECT + EXPORT PDF (13/11/2026)
   ----------------------------------------------------------------------------
   Demande d'Adrien pour Vincent (Head of Sales) : depuis l'onglet « ⭐ Qualité
   leads », cliquer un chiffre (ex. les 3 présents notés 5, ou le total) ouvre
   la liste NOMINATIVE des prospects concernés. Chaque nom se déplie en un
   dossier complet :
     · son questionnaire tel qu'il l'a rempli (toutes les questions) ;
     · sa note LQS et le détail des points ;
     · son issue : closé ou non, offre, signé, encaissé, closer ;
     · ses appels de vente, avec la TRANSCRIPTION de la visio Google Meet de
       closing (résumé et analyse IA quand ils existent).
   Tout ce qui est affiché s'exporte en PDF (impression du navigateur →
   « Enregistrer au format PDF »), sans limite de pages.

   Transcriptions : lues à la demande par GET /api/replay-closing?action=get
   (Admin SDK, jeton Firebase d'un admin) — bookings/{id}/replay_transcript
   n'est pas lisible depuis le navigateur. Un appel sans replay importé est
   signalé tel quel, jamais remplacé par autre chose.

   ADMIN uniquement, comme tout l'onglet. Aucune écriture.
   API : LqsDossier.open(opts) · LqsDossier.loadTranscripts(rows, onProgress)
         LqsDossier.dossiersHtml(rows) · LqsDossier.print(title, html)
   ES5 strict, délégation d'événements, aucun onclick inline.
   ============================================================================ */
(function () {
  'use strict';
  var LC = window.LqsCore;
  if (!LC) { if (window.console) console.error('[lqs-dossier] lqs-core.js manquant'); return; }

  var T = {};          // bookingId → { state: 'loading'|'ok'|'err', entries, speakers, error }
  var O = null;        // overlay ouvert : { el, opts, open: {id:1} }

  /* ══ FORMATS ══════════════════════════════════════════════════════════ */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ok(v) { return v != null && !isNaN(v) && isFinite(v); }
  function fNum(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') : '—'; }
  function fEur(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') + ' €' : '—'; }
  function fPts(v) { if (!ok(v)) return '—'; return (v > 0 ? '+' : '') + v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }); }
  function fDate(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '—'; }
  function fDay(ms) { if (ms == null) return '—'; var d = new Date(ms); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }
  function fClock(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' : '') + ('0' + m).slice(-2) + ':' + ('0' + r).slice(-2);
  }
  function fDur(sec) { if (!ok(sec) || !sec) return ''; var m = Math.round(sec / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + ('0' + (m % 60)).slice(-2) : m + ' min'; }
  var NOTE_LBL = { 5: 'Élite', 4: 'Très bon', 3: 'Bon', 2: 'Moyen', 1: 'Faible', 0: 'Non noté' };
  function noteBadge(n) { var k = n == null ? 0 : n; return '<span class="lq-note lq-n' + k + '" title="' + NOTE_LBL[k] + '">' + (k ? k : '–') + '</span>'; }
  function nameOf(r) { var l = r.lead || {}; return l.nom || [l.prenom, l.name].filter(Boolean).join(' ') || l.email || '(sans nom)'; }

  var OUTCOME = { close: '✅ Closé', non_close: '❌ Non closé', offre: '📨 Offre faite, en attente', disqualifie: '🚫 Disqualifié',
    no_show: '👻 Absent (no-show)', annule: 'Annulé', replanifie: 'Replanifié' };
  function callOutcome(c) {
    if (c.outcome && OUTCOME[c.outcome]) return OUTCOME[c.outcome];
    if (c.cancelled) return 'Annulé';
    if (c.noshow) return '👻 Absent (no-show)';
    if (c.present) return 'Présent (issue non détaillée)';
    if (c.status === 'confirmed' || c.status === 'pending') return 'À venir / à statuer';
    return '—';
  }
  function offerLbl(o) { return o === 'elite' ? 'Élite' : (o === 'business' ? 'Business' : 'offre non renseignée'); }
  /* Issue du prospect, en une phrase. */
  function statusOf(r) {
    if (r.closed) return { k: 'won', t: '✅ Closé — ' + offerLbl(r.offer) + ' · ' + fEur(r.con) + ' signé · ' + fEur(r.cash) + ' encaissé' };
    if (r.closeCancelled) return { k: 'lost', t: '↩️ Close annulé' };
    if (r.present) return { k: 'lost', t: '❌ Présent au RDV, non closé' };
    if (r.upcoming) return { k: 'wait', t: '🗓 RDV à venir' };
    if (r.noshow) return { k: 'lost', t: '👻 Absent au RDV (no-show)' };
    if (r.booked && r.allCancelled) return { k: 'lost', t: 'RDV annulé' };
    if (r.booked) return { k: 'wait', t: 'RDV pris, à statuer' };
    return { k: 'none', t: 'Pas de RDV' };
  }

  /* ══ TRANSCRIPTIONS ═══════════════════════════════════════════════════ */
  function token() {
    var u = window.firebase && firebase.auth && firebase.auth().currentUser;
    return u ? u.getIdToken() : Promise.reject(new Error('session expirée'));
  }
  function fetchTranscript(id) {
    if (T[id] && T[id].state !== 'err') return T[id].promise || Promise.resolve(T[id]);
    var rec = T[id] = { state: 'loading' };
    rec.promise = token().then(function (tk) {
      return fetch('/api/replay-closing?action=get&id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + tk } });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || !d.ok) throw new Error(d.error || ('HTTP ' + res.status));
        rec.state = 'ok';
        rec.entries = d.entries || [];
        rec.speakers = (d.replay && d.replay.speakers) || [];
        return rec;
      });
    }).catch(function (e) {
      rec.state = 'err'; rec.error = e && e.message ? e.message : 'erreur';
      return rec;
    });
    return rec.promise;
  }
  function readyCalls(r) { return (r.calls || []).filter(function (c) { return c.replay === 'ready'; }); }
  /* Charge les transcriptions de toutes les fiches (3 appels en parallèle). */
  function loadTranscripts(rows, onProgress) {
    var ids = [];
    rows.forEach(function (r) { readyCalls(r).forEach(function (c) { if (ids.indexOf(c.id) < 0) ids.push(c.id); }); });
    var done = 0, i = 0;
    if (onProgress) onProgress(0, ids.length);
    function worker() {
      if (i >= ids.length) return Promise.resolve();
      var id = ids[i++];
      return fetchTranscript(id).then(function () { done++; if (onProgress) onProgress(done, ids.length); return worker(); });
    }
    return Promise.all([worker(), worker(), worker()]).then(function () { return ids.length; });
  }
  /* Tours de parole regroupés par intervenant : « [mm:ss] Nom : texte ». */
  function transcriptHtml(rec) {
    if (!rec || rec.state === 'loading') return '<div class="lqd-muted">Chargement de la transcription…</div>';
    if (rec.state === 'err') return '<div class="lqd-warn">Transcription illisible (' + esc(rec.error) + ').</div>';
    if (!rec.entries.length) return '<div class="lqd-muted">Transcription vide.</div>';
    var h = '', cur = null;
    function flush() { if (cur) h += '<p class="lqd-turn"><span class="lqd-tc">[' + fClock(cur.s) + ']</span> <strong>' + esc(cur.who) + ' :</strong> ' + esc(cur.text) + '</p>'; }
    rec.entries.forEach(function (e) {
      var who = rec.speakers[e.p] || 'Participant';
      if (cur && cur.who === who && cur.text.length < 900) { cur.text += ' ' + (e.t || ''); return; }
      flush();
      cur = { who: who, s: e.s, text: e.t || '' };
    });
    flush();
    return h;
  }

  /* ══ DOSSIER D'UN PROSPECT ════════════════════════════════════════════ */
  function list(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="lqd-an"><strong>' + title + '</strong><ul>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
  }
  function analysisHtml(a) {
    if (!a) return '';
    var h = '<div class="lqd-analysis"><div class="lqd-h4">Analyse IA de l\'appel' + (ok(a.score) ? ' — ' + a.score + ' / 100' : '') + '</div>';
    if (a.verdict) h += '<p>' + esc(a.verdict) + '</p>';
    var p = a.prospect || {};
    h += list('Douleurs du prospect', p.douleurs) + list('Motivations', p.motivations) + list('Freins', p.freins);
    if (a.objections && a.objections.length) {
      h += '<div class="lqd-an"><strong>Objections</strong><ul>';
      a.objections.forEach(function (o) {
        if (!o) return;
        h += '<li>' + (o.label ? '<strong>' + esc(o.label) + '</strong> ' : '') + (o.quote ? '« ' + esc(o.quote) + ' »' : '') + (o.response ? ' → ' + esc(o.response) : '') + (o.worked === true ? ' <em>(levée)</em>' : (o.worked === false ? ' <em>(non levée)</em>' : '')) + '</li>';
      });
      h += '</ul></div>';
    }
    h += list('Points forts du closer', a.pointsForts) + list('Axes de progrès', a.axesProgres);
    if (a.conseilRelance) h += '<div class="lqd-an"><strong>Conseil de relance</strong><p>' + esc(a.conseilRelance) + '</p></div>';
    return h + '</div>';
  }
  function callHtml(c) {
    var h = '<div class="lqd-call"><div class="lqd-h4">📞 Appel du ' + fDate(c.date) + (c.time ? ' à ' + esc(c.time) : '') + ' — ' + callOutcome(c)
      + (c.closerName ? ' · closer : ' + esc(c.closerName) : '') + (c.durationSec ? ' · ' + fDur(c.durationSec) : '') + '</div>';
    if (c.replay === 'ready') {
      if (c.summary) h += '<p class="lqd-sum"><strong>Résumé :</strong> ' + esc(c.summary) + '</p>';
      h += analysisHtml(c.analysis);
      h += '<div class="lqd-h4">Transcription de la visio</div><div class="lqd-tr">' + transcriptHtml(T[c.id]) + '</div>';
    } else if (c.present) {
      h += '<div class="lqd-warn">Pas de transcription pour cet appel : '
        + (c.replay === 'video_only' ? 'la visio a été filmée mais Google n\'a pas fourni de transcription.'
          : (c.replay === 'pending' ? 'l\'import du replay est en cours.' : 'la visio n\'a pas été enregistrée sur le Meet de closing, ou le replay n\'a pas été importé.'))
        + (c.replayReason ? ' (' + esc(c.replayReason) + ')' : '') + '</div>';
    }
    return h + '</div>';
  }
  function bodyHtml(r) {
    var l = r.lead || {};
    var h = '<div class="lqd-meta">' + [l.email ? esc(l.email) : '', l.telephone ? esc(l.telephone) : '', 'entré le ' + fDay(r.entry),
      r.sourceLabel ? 'source : ' + esc(r.sourceLabel) : '', r.axes && r.axes.creative && r.axes.creative.label ? 'pub : ' + esc(r.axes.creative.label) : '',
      r.closerName ? 'closer : ' + esc(r.closerName) : '', r.team != null ? 'note équipe ★ ' + r.team : ''].filter(Boolean).join(' · ') + '</div>';
    var q = LC.questionnaireOf(l);
    h += '<div class="lqd-h3">📝 Questionnaire rempli</div>';
    if (!q.length) h += '<div class="lqd-muted">Aucune réponse enregistrée sur cette fiche (RDV direct, import ou ancien tunnel).</div>';
    else {
      h += '<table class="lqd-q"><tbody>';
      q.forEach(function (x, i) {
        h += '<tr' + (x.kind === 'resultat' ? ' class="res"' : '') + '><td class="n">' + (x.kind === 'resultat' ? '★' : (i + 1)) + '</td><td class="q">' + esc(x.q) + '</td><td class="a">' + esc(x.a) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '<div class="lqd-h3">⭐ Note LQS : ' + (r.note != null ? r.note + ' / 5 (' + fPts(r.pts) + ' points)' : 'non noté') + (r.ko ? ' — réponse éliminatoire' : '') + '</div>';
    var scored = (r.detail || []).filter(function (d) { return d.pts || d.ko; });
    if (scored.length) {
      h += '<table class="lqd-q"><tbody>';
      scored.forEach(function (d) { h += '<tr><td class="q">' + esc(d.ql) + '</td><td class="a">' + esc(d.al) + '</td><td class="p">' + (d.ko ? '⛔ éliminatoire' : fPts(d.pts)) + '</td></tr>'; });
      h += '</tbody></table>';
    } else if (r.note != null) h += '<div class="lqd-muted">Aucune de ses réponses ne porte de points dans le barème actuel.</div>';
    h += '<div class="lqd-h3">🎯 Issue : ' + statusOf(r).t + '</div>';
    var calls = (r.calls || []).filter(function (c) { return c.present || c.replay === 'ready' || c.noshow || c.outcome; });
    if (!calls.length) h += '<div class="lqd-muted">Aucun appel de vente tenu.</div>';
    calls.forEach(function (c) { h += callHtml(c); });
    return h;
  }
  function headHtml(r, i) {
    var st = statusOf(r);
    var nTr = readyCalls(r).length;
    return '<span class="lqd-i">' + (i + 1) + '</span>' + noteBadge(r.note) + '<span class="lqd-name">' + esc(nameOf(r)) + '</span>'
      + '<span class="lqd-st lqd-' + st.k + '">' + st.t + '</span>'
      + '<span class="lqd-tag">' + (nTr ? '🎙 ' + nTr + ' transcription' + (nTr > 1 ? 's' : '') : (r.present ? 'sans transcription' : '')) + '</span>';
  }
  /* HTML statique de tous les dossiers (export). Transcriptions = cache T. */
  function dossiersHtml(rows) {
    var h = '';
    rows.forEach(function (r, i) {
      h += '<section class="lqd-doc"><h2 class="lqd-doc-h">' + headHtml(r, i) + '</h2>' + bodyHtml(r) + '</section>';
    });
    return h;
  }
  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var na = a.note == null ? -1 : a.note, nb = b.note == null ? -1 : b.note;
      return (nb - na) || ((b.closed ? 1 : 0) - (a.closed ? 1 : 0)) || ((b.present ? 1 : 0) - (a.present ? 1 : 0)) || nameOf(a).localeCompare(nameOf(b));
    });
  }

  /* ══ IMPRESSION → PDF ═════════════════════════════════════════════════
     Le document à imprimer est posé dans #lqPrint, seul élément visible à
     l'impression (body.lq-printing). Les couleurs d'impression (encre noire
     sur blanc, A4 paysage) sont dans le CSS @media print de la page. */
  /* Le document s'ouvre dans un NOUVEL ONGLET autonome, qui s'imprime
     lui-même (même procédé que sign-certificate.html). Deux raisons, vues
     en production le 13/11/2026 sous Safari : window.print() est ignoré
     hors d'un geste de l'utilisateur, et il est mis en attente tant que la
     page a un chargement en cours — or cette page garde une connexion
     Firestore ouverte en permanence. D'où : une barre « Document prêt »
     (le clic ouvre l'onglet), et un document sans aucune connexion.
     L'onglet garde aussi un bouton d'impression et se relit à l'écran. */
  var PR = null;
  function closePrint() {
    if (!PR) return;
    if (PR.bar.parentNode) PR.bar.parentNode.removeChild(PR.bar);
    /* L'adresse du document reste valable une minute après la fermeture de
       la barre, le temps que l'onglet ouvert finisse de se charger. */
    if (PR.url) { var u = PR.url; setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) {} }, 60000); }
    PR = null;
  }
  function pageCss() {
    var css = '', links = '';
    Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
      if (l.href && /sales\.css/.test(l.href)) links += '<link rel="stylesheet" href="' + esc(l.href) + '">';
    });
    Array.prototype.forEach.call(document.querySelectorAll('style'), function (st) {
      var t = st.textContent || '';
      if (t.indexOf('lqd-doc') >= 0 || t.indexOf('.fn-igt') >= 0) css += t + '\n';
    });
    return links + '<style>' + css.replace(/<\/style/gi, '') + '</style>';
  }
  /* À l'écran, l'onglet montre le document comme il sortira (encre noire). */
  var SCREEN_CSS = '@media screen{html,body{background:#fff !important;margin:0;padding:0}'
    + 'body.lq-printing #lqPrint{display:block !important;padding:64px 28px 40px;color:#111;font-size:12px;font-family:Helvetica,Arial,sans-serif;'
    + '--text:#111;--muted:#444;--muted2:#6b7280;--bg:#fff;--bg2:#fff;--bg3:#f6f7f9;--bg4:#e9ebf0;--border:#d5d8e0;--border2:#b4b9c6;--blue:#1d4ed8;--green:#047857;--gold:#92400e;--red2:#b91c1c;--red3:#b91c1c}'
    + '#lqPrint button,#lqPrint .fn-seg,#lqPrint .fn-help,#lqPrint select,#lqPrint input,#lqPrint .lq-head,#lqPrint .fn-lt-toolbar,#lqPrint .lq-actions,#lqPrint .lq-draft{display:none !important}'
    + '#lqPrint .lqp-sec{margin-top:36px;padding-top:20px;border-top:3px solid #111}#lqPrint .lqp-h1{font-size:22px;margin:0 0 14px}'
    + '#lqPrint .lqd-doc{margin-top:28px;padding-top:14px;border-top:1px solid #999}#lqPrint .lqd-doc-h{font-size:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 6px}'
    + '#lqPrint .lqd-cover h1{font-size:30px;margin:8px 0 18px}#lqPrint .lqd-cover p{font-size:13px;margin:6px 0}'
    + '#lqPrint .fn-table-wrap{overflow:visible}#lqPrint th{position:static !important}'
    + '.lqp-bar{position:fixed;top:0;left:0;right:0;z-index:10;background:#111;color:#fff;padding:10px 18px;display:flex;gap:14px;align-items:center;font:14px Helvetica,Arial,sans-serif}'
    + '.lqp-bar button{font:600 14px Helvetica,Arial,sans-serif;padding:8px 16px;border-radius:8px;border:0;background:#3b82f6;color:#fff;cursor:pointer}'
    + '.lqp-bar span{opacity:.75;font-size:12.5px}}';
  function standaloneDoc(title, html) {
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>'
      + pageCss() + '<style>' + SCREEN_CSS + '</style></head><body class="lq-printing">'
      + '<div class="lqp-bar"><button id="lqpBtn">📄 Imprimer / Enregistrer en PDF</button><span>Dans la fenêtre d\'impression : « Enregistrer au format PDF ». Si elle ne s\'ouvre pas : menu Fichier → Imprimer (⌘P), ou Fichier → Exporter au format PDF.</span></div>'
      + '<div id="lqPrint">' + html + '</div>'
      + '<script>document.getElementById("lqpBtn").onclick=function(){window.print();};window.addEventListener("load",function(){setTimeout(function(){try{window.print();}catch(e){}},600);});<\/script>'
      + '</body></html>';
  }
  /* La barre propose de VRAIS LIENS (pas un script) vers le document, posé
     dans un fichier en mémoire (blob) : un clic sur un lien n'est jamais
     bloqué par le navigateur, contrairement à une fenêtre ouverte par code
     (constaté en production le 13/11/2026 : rien ne s'ouvrait). Deux liens :
     ouvrir dans un nouvel onglet (qui lance l'impression), ou télécharger le
     fichier pour l'ouvrir et l'imprimer depuis n'importe quel navigateur. */
  function print(title, html) {
    closePrint();
    var url = null;
    try { url = URL.createObjectURL(new Blob([standaloneDoc(title, html)], { type: 'text/html;charset=utf-8' })); } catch (e) { url = null; }
    var file = title.replace(/[^\w\u00C0-\u017F -]+/g, ' ').replace(/\s+/g, ' ').trim() + '.html';
    var bar = document.createElement('div');
    bar.className = 'lqd-ready';
    bar.innerHTML = '<div class="lqd-ready-in"><div><strong>📄 Document prêt</strong><div class="lqd-muted">'
      + (url ? 'Il s\'ouvre dans un nouvel onglet avec la fenêtre d\'impression : choisis « Enregistrer au format PDF ». Si rien ne s\'ouvre, télécharge le fichier et ouvre-le.'
        : 'Ce navigateur ne permet pas de préparer le document.') + '</div></div>'
      + '<div class="lqd-actions">'
      + (url ? '<a class="fn-btn primary" href="' + url + '" target="_blank" rel="noopener" data-lqd-open>📄 Ouvrir et enregistrer en PDF</a>'
          + '<a class="fn-btn" href="' + url + '" download="' + esc(file) + '">⬇ Télécharger le fichier</a>' : '')
      + '<button class="fn-btn" data-lqd-print-close>✕ Fermer</button></div></div>';
    document.body.appendChild(bar);
    PR = { bar: bar, url: url };
    bar.addEventListener('click', function (e) {
      if (e.target.closest('[data-lqd-print-close]')) closePrint();
    });
  }
  function coverHtml(title, lines) {
    return '<div class="lqd-cover"><div class="lqd-cover-k">Alteore · Qualité des leads</div><h1>' + esc(title) + '</h1>'
      + (lines || []).map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('')
      + '<p class="lqd-muted">Document interne, réservé à la direction : il contient des données nominatives et des transcriptions d\'appels.</p></div>';
  }

  /* ══ PANNEAU (clic sur un chiffre) ════════════════════════════════════ */
  function close() {
    if (!O) return;
    if (O.el.parentNode) O.el.parentNode.removeChild(O.el);
    document.removeEventListener('keydown', onKey);
    O = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function leadEl(id) { return O ? O.el.querySelector('[data-lqd-lead="' + id + '"]') : null; }
  function renderLead(r, i) {
    var open = !!O.open[r.id];
    return '<div class="lqd-lead' + (open ? ' open' : '') + '" data-lqd-lead="' + esc(r.id) + '">'
      + '<div class="lqd-lead-h" data-lqd-toggle="' + esc(r.id) + '"><span class="lqd-caret">' + (open ? '▾' : '▸') + '</span>' + headHtml(r, i)
      + '<a class="lqd-link" href="sales-contact.html?id=' + encodeURIComponent(r.id) + '" target="_blank" rel="noopener" title="Ouvrir la fiche">fiche ↗</a></div>'
      + (open ? '<div class="lqd-lead-b">' + bodyHtml(r) + '</div>' : '') + '</div>';
  }
  function refreshLead(r) {
    var el = leadEl(r.id);
    if (!el) return;
    var i = O.rows.indexOf(r);
    var tmp = document.createElement('div');
    tmp.innerHTML = renderLead(r, i);
    el.parentNode.replaceChild(tmp.firstChild, el);
  }
  function openLead(r) {
    O.open[r.id] = 1;
    refreshLead(r);
    readyCalls(r).forEach(function (c) {
      if (T[c.id] && T[c.id].state === 'ok') return;
      fetchTranscript(c.id).then(function () { if (O && O.open[r.id]) refreshLead(r); });
    });
  }
  function setBusy(txt) { var b = O && O.el.querySelector('[data-lqd-status]'); if (b) b.textContent = txt || ''; }
  function exportPanel() {
    if (!O || O.busy) return;
    O.busy = true;
    var rows = O.rows;
    loadTranscripts(rows, function (d, n) { setBusy(n ? 'Transcriptions : ' + d + ' / ' + n + '…' : 'Préparation…'); }).then(function () {
      if (!O) return;
      setBusy('');
      O.busy = false;
      print(O.opts.title + ' — ' + (O.opts.periodLabel || ''), coverHtml(O.opts.title, [
        'Période : ' + (O.opts.periodLabel || '—') + (O.opts.sub ? ' · ' + O.opts.sub : ''),
        rows.length + ' prospect' + (rows.length > 1 ? 's' : '') + ' · exporté le ' + fDay(Date.now())
      ]) + dossiersHtml(rows));
    });
  }
  function open(opts) {
    close();
    var rows = sortRows(opts.rows || []);
    var el = document.createElement('div');
    el.className = 'lqd-overlay';
    O = { el: el, opts: opts, rows: rows, open: {}, busy: false };
    var nTr = 0;
    rows.forEach(function (r) { nTr += readyCalls(r).length; });
    var h = '<div class="lqd-panel"><div class="lqd-top"><div><div class="lqd-title">' + esc(opts.title) + '</div>'
      + '<div class="lqd-sub">' + rows.length + ' prospect' + (rows.length > 1 ? 's' : '') + ' · ' + nTr + ' transcription' + (nTr > 1 ? 's' : '') + ' de visio disponible' + (nTr > 1 ? 's' : '')
      + (opts.periodLabel ? ' · ' + esc(opts.periodLabel) : '') + (opts.sub ? ' · ' + esc(opts.sub) : '') + '</div></div>'
      + '<div class="lqd-actions"><span class="lqd-muted" data-lqd-status></span>'
      + '<button class="fn-btn" data-lqd-all>▾ Tout déplier</button>'
      + '<button class="fn-btn primary" data-lqd-pdf>📄 Exporter en PDF</button>'
      + '<button class="fn-btn" data-lqd-close>✕ Fermer</button></div></div>'
      + '<div class="lqd-hint">Clique un nom pour voir son questionnaire, son issue et la transcription de sa visio de closing. « Exporter en PDF » prend tous les prospects de cette liste, transcriptions comprises.</div>'
      + '<div class="lqd-list">';
    if (!rows.length) h += '<div class="lqd-muted" style="padding:20px">Aucun prospect dans cette case.</div>';
    rows.forEach(function (r, i) { h += renderLead(r, i); });
    h += '</div></div>';
    el.innerHTML = h;
    document.body.appendChild(el);
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', function (e) {
      var t = e.target, x;
      if (t === el) { close(); return; }
      if (t.closest('[data-lqd-close]')) { close(); return; }
      if (t.closest('a')) return;
      if (t.closest('[data-lqd-pdf]')) { exportPanel(); return; }
      if (t.closest('[data-lqd-all]')) {
        var allOpen = rows.every(function (r) { return O.open[r.id]; });
        rows.forEach(function (r) { if (allOpen) { delete O.open[r.id]; refreshLead(r); } else if (!O.open[r.id]) openLead(r); });
        t.closest('[data-lqd-all]').textContent = allOpen ? '▾ Tout déplier' : '▸ Tout replier';
        return;
      }
      if ((x = t.closest('[data-lqd-toggle]'))) {
        var id = x.getAttribute('data-lqd-toggle');
        var r = rows.filter(function (y) { return y.id === id; })[0];
        if (!r) return;
        if (O.open[id]) { delete O.open[id]; refreshLead(r); } else openLead(r);
      }
    });
    if (rows.length === 1) openLead(rows[0]);
  }

  window.LqsDossier = {
    open: open, close: close, closePrint: closePrint, loadTranscripts: loadTranscripts, dossiersHtml: dossiersHtml,
    sortRows: sortRows, print: print, coverHtml: coverHtml, nameOf: nameOf, statusOf: statusOf
  };
})();
