/* ═══════════════════════════════════════════════════════════════════════
   CLOSE WIZARD — les cartes enchaînées du Close (refonte 14/07/2026)
   ═══════════════════════════════════════════════════════════════════════
   Demande Adrien : quand Élodie passe un lead en « Closing » (Leads Live,
   CRM, fiche) ou choisit Close sur un RDV, 4 cartes s'enchaînent :
     ① Type de contrat signé   : Elite / Business
     ② Paiement                : PIF / MENS
     ③ Booking                 : Self Booking / No Booking
     ④ Encaissé à la signature : montants suggérés (tarifs officiels HT)
     ⑤ Récap cliquable → Confirmer
   À la confirmation : stage fiche (closed_won_self / closed_won_setting),
   timeline, résultat « close » posé sur le RDV du lead s'il en reste un à
   statuer, et commissions auto (closer + setter résolus tout seuls).
   Les MONTANTS ne servent qu'aux rapports (encaissé déclaré) — la vérité
   du cash reste le module Paiements (GoCardless), croisé dans le funnel.

   API : CloseWizard.open({ leadId, lead, booking, typeMap, onDone })
     - booking fourni  → le close est posé sur CE RDV (carte ③ préréglée).
     - sinon           → AlteoreFlow.applyFicheClose (RDV à statuer ou direct).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var state = null;

  /* ── Styles ── */
  function ensureStyles() {
    if (document.getElementById('cwStyles')) return;
    var css = ''
      + '.cw-bg{position:fixed;inset:0;background:rgba(8,10,20,.72);backdrop-filter:blur(6px);z-index:10050;display:none;align-items:center;justify-content:center;padding:18px}'
      + '.cw-bg.show{display:flex}'
      + '.cw-modal{width:min(480px,96vw);background:linear-gradient(165deg,#171c2e,#10141f);border:1px solid rgba(255,255,255,.09);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden;font-family:inherit;color:#eef1fa}'
      + '.cw-head{padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,.07)}'
      + '.cw-title{font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}'
      + '.cw-sub{font-size:11px;color:#8d93a8;margin-top:3px}'
      + '.cw-dots{display:flex;gap:6px;margin-top:10px}'
      + '.cw-dot{height:4px;flex:1;border-radius:99px;background:rgba(255,255,255,.10);transition:background .2s}'
      + '.cw-dot.on{background:#5b7cfa}.cw-dot.done{background:rgba(91,124,250,.45)}'
      + '.cw-body{padding:18px 20px 20px;min-height:190px}'
      + '.cw-q{font-size:13px;font-weight:700;margin-bottom:12px}'
      + '.cw-q small{display:block;font-weight:500;color:#8d93a8;font-size:11px;margin-top:3px}'
      + '.cw-opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}'
      + '.cw-opt{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);border-radius:13px;padding:16px 12px;text-align:center;cursor:pointer;transition:all .13s;font-family:inherit;color:#eef1fa}'
      + '.cw-opt:hover{border-color:#5b7cfa;background:rgba(91,124,250,.08);transform:translateY(-1px)}'
      + '.cw-opt.sel{border-color:#5b7cfa;background:rgba(91,124,250,.14);box-shadow:0 0 0 1px #5b7cfa inset}'
      + '.cw-opt .ic{font-size:22px;display:block;margin-bottom:6px}'
      + '.cw-opt .lb{font-size:13.5px;font-weight:800}'
      + '.cw-opt .pr{font-size:10.5px;color:#8d93a8;margin-top:4px;line-height:1.45}'
      + '.cw-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}'
      + '.cw-chip{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);border-radius:99px;padding:8px 14px;font-size:12.5px;font-weight:700;cursor:pointer;color:#eef1fa;font-family:inherit;transition:all .12s}'
      + '.cw-chip:hover{border-color:#5b7cfa}.cw-chip.sel{border-color:#5b7cfa;background:rgba(91,124,250,.16)}'
      + '.cw-chip small{font-weight:500;color:#8d93a8;margin-left:4px}'
      + '.cw-input-row{display:flex;align-items:center;gap:8px}'
      + '.cw-input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:10px 12px;font-size:14px;font-weight:700;color:#eef1fa;font-family:inherit;outline:none}'
      + '.cw-input:focus{border-color:#5b7cfa}'
      + '.cw-hint{font-size:10.5px;color:#8d93a8;margin-top:8px;line-height:1.5}'
      + '.cw-sugg{font-size:10.5px;color:#fbbf24;margin-top:8px}'
      + '.cw-recap{display:flex;flex-direction:column;gap:8px}'
      + '.cw-r{display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);border-radius:11px;padding:10px 13px;cursor:pointer;transition:border-color .12s}'
      + '.cw-r:hover{border-color:#5b7cfa}'
      + '.cw-r .k{font-size:10.5px;color:#8d93a8;font-weight:700;text-transform:uppercase;letter-spacing:.5px}'
      + '.cw-r .v{font-size:13px;font-weight:800}'
      + '.cw-r .e{font-size:10px;color:#5b7cfa;margin-left:8px}'
      + '.cw-comm{border:1px solid rgba(16,185,129,.25);background:rgba(16,185,129,.07);border-radius:11px;padding:10px 13px;font-size:11.5px;color:#7ee2b8;line-height:1.55;margin-top:2px}'
      + '.cw-warn{border:1px solid rgba(251,191,36,.3);background:rgba(251,191,36,.07);border-radius:11px;padding:9px 13px;font-size:11px;color:#fbd982;line-height:1.5;margin-top:2px}'
      + '.cw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 20px 18px}'
      + '.cw-back{background:transparent;border:1px solid rgba(255,255,255,.14);color:#aab0c4;border-radius:10px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}'
      + '.cw-back:hover{border-color:#8d93a8;color:#eef1fa}'
      + '.cw-ok{background:linear-gradient(135deg,#10b981,#0d9f6f);border:none;color:#04120c;border-radius:10px;padding:11px 20px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 6px 18px rgba(16,185,129,.25)}'
      + '.cw-ok:disabled{opacity:.45;cursor:default;box-shadow:none}'
      + '.cw-x{position:absolute;background:transparent;border:none;color:#8d93a8;font-size:17px;cursor:pointer;padding:6px;line-height:1}'
      + '.cw-done{text-align:center;padding:8px 0 2px}'
      + '.cw-done .big{font-size:38px;margin-bottom:8px}'
      + '.cw-done .t{font-size:15px;font-weight:800;margin-bottom:6px}'
      + '.cw-done .d{font-size:11.5px;color:#8d93a8;line-height:1.6;margin-bottom:14px}'
      + '.cw-done .d strong{color:#eef1fa}'
      + '.cw-pay{display:inline-block;background:linear-gradient(135deg,#5b7cfa,#4a63d8);color:#fff;border:none;border-radius:10px;padding:11px 18px;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;text-decoration:none;margin:0 5px 8px}'
      + '.cw-ghost{display:inline-block;background:transparent;border:1px solid rgba(255,255,255,.16);color:#aab0c4;border-radius:10px;padding:10px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;margin:0 5px}'
      + '#cwToast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(70px);background:#171c2e;border:1px solid rgba(255,255,255,.14);color:#eef1fa;border-radius:12px;padding:12px 18px;font-size:12.5px;font-weight:600;z-index:10060;opacity:0;transition:all .25s;max-width:min(520px,92vw);box-shadow:0 14px 40px rgba(0,0,0,.5)}'
      + '#cwToast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
    var st = document.createElement('style');
    st.id = 'cwStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toastMsg(msg, ms) {
    var t = document.getElementById('cwToast');
    if (!t) { t = document.createElement('div'); t.id = 'cwToast'; document.body.appendChild(t); }
    t.innerHTML = msg;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, ms || 5200);
  }

  function ensureDom() {
    ensureStyles();
    if (document.getElementById('cwBg')) return;
    var bg = document.createElement('div');
    bg.id = 'cwBg'; bg.className = 'cw-bg';
    bg.innerHTML =
      '<div class="cw-modal" style="position:relative">' +
        '<button class="cw-x" id="cwX" style="top:10px;right:12px">✕</button>' +
        '<div class="cw-head">' +
          '<div class="cw-title">🏆 <span id="cwTitle">Close</span></div>' +
          '<div class="cw-sub" id="cwSub"></div>' +
          '<div class="cw-dots" id="cwDots"></div>' +
        '</div>' +
        '<div class="cw-body" id="cwBody"></div>' +
        '<div class="cw-foot" id="cwFoot"></div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) askAbort(); });
    document.getElementById('cwX').addEventListener('click', askAbort);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && bg.classList.contains('show') && state && !state.saving) askAbort();
    });
  }

  function askAbort() {
    if (state && state.saving) return; /* enregistrement en cours — on ne ferme pas */
    if (!state || state.finished) { close(); return; }
    close();
    toastMsg('Cartes fermées — <strong>rien n\'a été enregistré</strong>. Repasse le lead en Closing pour reprendre.');
  }
  function close() {
    var bg = document.getElementById('cwBg');
    if (bg) bg.classList.remove('show');
    state = null;
  }

  /* ── Helpers pricing ── */
  function pricing() { return (window.AlteoreFlow && window.AlteoreFlow.WIZARD_PRICING) || {}; }
  function offerCfg() { return pricing()[state.a.contrat] || null; }
  function payCfg() {
    var oc = offerCfg();
    if (!oc) return null;
    return state.a.paiement === 'pif' ? oc.pif : oc.mensualise;
  }
  function euro(n) { return (Number(n) || 0).toLocaleString('fr-FR') + ' €'; }

  /* ── Rendu des cartes ── */
  var STEPS = ['contrat', 'paiement', 'booking', 'encaisse', 'recap'];

  function render() {
    var dots = '';
    for (var i = 0; i < STEPS.length; i++) {
      dots += '<div class="cw-dot' + (i < state.step ? ' done' : (i === state.step ? ' on' : '')) + '"></div>';
    }
    document.getElementById('cwDots').innerHTML = dots;
    var name = state.leadName || (state.lead && (state.lead.nom || state.lead.email)) || 'Prospect';
    document.getElementById('cwSub').textContent = name + (state.booking ? ' · RDV ' + (state.booking.date || '').split('-').reverse().join('/') + ' ' + (state.booking.time || '') : '');

    var body = document.getElementById('cwBody');
    var foot = document.getElementById('cwFoot');
    var key = STEPS[state.step];
    var h = '';

    if (key === 'contrat') {
      document.getElementById('cwTitle').textContent = 'Close — contrat signé';
      h += '<div class="cw-q">Quel type de contrat a été signé ?</div>';
      h += '<div class="cw-opts">';
      h += opt('contrat', 'Elite', '👑', 'ELITE', 'PIF 12 000 € HT<br>MENS 13 000 € HT (≤ 4×)');
      h += opt('contrat', 'Business', '🚀', 'BUSINESS', 'PIF 5 000 € HT<br>MENS 6 000 € HT (≤ 10×)');
      h += '</div>';
    } else if (key === 'paiement') {
      document.getElementById('cwTitle').textContent = 'Close — paiement';
      var oc = offerCfg();
      h += '<div class="cw-q">Paiement intégral ou mensualisé ?</div>';
      h += '<div class="cw-opts">';
      h += opt('paiement', 'pif', '💎', 'PIF', oc ? euro(oc.pif.contracte) + ' HT comptant' : 'comptant');
      h += opt('paiement', 'mensualise', '📅', 'MENS', oc ? euro(oc.mensualise.contracte) + ' HT · jusqu\'à ' + oc.mensualise.maxX + ' fois' : 'mensualisé');
      h += '</div>';
    } else if (key === 'booking') {
      document.getElementById('cwTitle').textContent = 'Close — booking';
      h += '<div class="cw-q">Le prospect venait de quel booking ?<small>Self Booking = il a pris son RDV seul · No Booking = travaillé par le setting</small></div>';
      h += '<div class="cw-opts">';
      h += opt('booking', 'sb', '🔗', 'SELF BOOKING', 'commission setting SB');
      h += opt('booking', 'nb', '📞', 'NO BOOKING', 'commission setting NB');
      h += '</div>';
      if (state.sbSuggest !== null) {
        h += '<div class="cw-sugg">💡 Suggestion : ' + (state.sbSuggest ? 'Self Booking' : 'No Booking') + ' (détecté depuis ' + (state.booking ? 'le RDV' : 'la fiche') + ')</div>';
      }
    } else if (key === 'encaisse') {
      document.getElementById('cwTitle').textContent = 'Close — encaissé';
      var pc = payCfg();
      h += '<div class="cw-q">Combien a été encaissé à la signature ? <small>Montant HT — ' + (state.a.paiement === 'pif' ? 'PIF : la totalité' : '1ʳᵉ échéance (mensualité)') + '. La vérité du cash reste le module Paiements, le funnel croisera.</small></div>';
      h += '<div class="cw-chips">';
      (pc ? pc.encaisse : []).forEach(function (v) {
        var lbl = euro(v) + (state.a.paiement === 'mensualise' && pc ? '<small>(' + Math.round(pc.contracte / v) + '×)</small>' : '');
        h += '<button class="cw-chip' + (state.a.encaisse === v ? ' sel' : '') + '" data-enc="' + v + '">' + lbl + '</button>';
      });
      h += '</div>';
      h += '<div class="cw-input-row"><input class="cw-input" id="cwEnc" type="number" min="0" step="50" placeholder="Autre montant HT…" value="' + (state.a.encaisse != null && !(payCfg() && payCfg().encaisse.indexOf(state.a.encaisse) >= 0) ? state.a.encaisse : '') + '"><span style="font-weight:800">€ HT</span></div>';
      h += '<div class="cw-hint">Contracté auto : <strong>' + (pc ? euro(pc.contracte) : '—') + ' HT</strong> (' + (state.a.contrat || '') + ' ' + (state.a.paiement === 'pif' ? 'PIF' : 'MENS') + ')</div>';
    } else if (key === 'recap') {
      document.getElementById('cwTitle').textContent = 'Close — confirmation';
      var pc2 = payCfg();
      var AF = window.AlteoreFlow;
      var commOffre = offerCfg() ? offerCfg().commOffre : 'BP 12';
      var cComm = AF ? AF.calcClosingComm(commOffre, state.a.paiement) : 0;
      var cBonus = AF ? AF.calcClosingBonus(commOffre, state.a.paiement) : 0;
      var sComm = AF ? AF.calcSettingComm(commOffre, state.a.booking === 'sb') : 0;
      h += '<div class="cw-recap">';
      h += rrow(0, 'Contrat', (state.a.contrat === 'Elite' ? '👑 Elite' : '🚀 Business'));
      h += rrow(1, 'Paiement', (state.a.paiement === 'pif' ? '💎 PIF' : '📅 Mensualisé') + ' — contracté ' + (pc2 ? euro(pc2.contracte) : '—') + ' HT');
      h += rrow(2, 'Booking', state.a.booking === 'sb' ? '🔗 Self Booking' : '📞 No Booking');
      h += rrow(3, 'Encaissé à la signature', euro(state.a.encaisse) + ' HT');
      h += '<div class="cw-comm">⚡ Commissions auto — Closing <strong>' + euro(cComm) + '</strong>'
        + (cBonus ? ' + prime PIF <strong>' + euro(cBonus) + '</strong>' : '')
        + ' · Setting ' + (state.a.booking === 'sb' ? 'SB' : 'NB') + ' <strong>' + euro(sComm) + '</strong>'
        + '<br><span style="color:#5fae8d">Validées à l\'encaissement dans le module Commissions.</span></div>';
      if (state.lead && (state.lead.isClient || state.lead.stage === 'closed_won_self' || state.lead.stage === 'closed_won_setting')) {
        h += '<div class="cw-warn">⚠ Cette fiche est déjà marquée client — confirmer mettra à jour le close (aucune commission ne sera dupliquée).</div>';
      }
      h += '</div>';
    }

    body.innerHTML = h;

    /* footer */
    var f = '';
    f += state.step > 0 ? '<button class="cw-back" id="cwBack">← Retour</button>' : '<span></span>';
    if (key === 'encaisse') f += '<button class="cw-ok" id="cwNext" ' + (state.a.encaisse == null ? 'disabled' : '') + '>Continuer →</button>';
    else if (key === 'recap') f += '<button class="cw-ok" id="cwConfirm">✅ Confirmer le close</button>';
    else f += '<span></span>';
    foot.innerHTML = f;

    /* listeners */
    body.querySelectorAll('[data-pick]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fkey = btn.getAttribute('data-pick'), val = btn.getAttribute('data-val');
        if (fkey === 'contrat') { state.a.contrat = val; state.a.encaisse = null; }
        if (fkey === 'paiement') { state.a.paiement = val; state.a.encaisse = null; }
        if (fkey === 'booking') state.a.booking = val;
        state.step = Math.min(state.step + 1, STEPS.length - 1);
        /* PIF → l'encaissé est connu (la totalité) : pré-sélectionné, un clic pour passer. */
        if (STEPS[state.step] === 'encaisse' && state.a.paiement === 'pif' && payCfg()) state.a.encaisse = payCfg().contracte;
        render();
      });
    });
    body.querySelectorAll('[data-enc]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.a.encaisse = Number(btn.getAttribute('data-enc'));
        state.step++; render();
      });
    });
    var encIn = document.getElementById('cwEnc');
    if (encIn) {
      encIn.addEventListener('input', function () {
        var v = parseFloat(encIn.value);
        state.a.encaisse = isNaN(v) ? null : v;
        var nx = document.getElementById('cwNext');
        if (nx) nx.disabled = state.a.encaisse == null;
      });
      encIn.addEventListener('keydown', function (e) { if (e.key === 'Enter' && state.a.encaisse != null) { state.step++; render(); } });
    }
    body.querySelectorAll('[data-goto]').forEach(function (row) {
      row.addEventListener('click', function () { state.step = Number(row.getAttribute('data-goto')); render(); });
    });
    var back = document.getElementById('cwBack');
    if (back) back.addEventListener('click', function () { state.step = Math.max(0, state.step - 1); render(); });
    var next = document.getElementById('cwNext');
    if (next) next.addEventListener('click', function () { if (state.a.encaisse != null) { state.step++; render(); } });
    var conf = document.getElementById('cwConfirm');
    if (conf) conf.addEventListener('click', confirmClose);
  }

  function opt(field, val, ic, lb, pr) {
    var sel = state.a[field] === val ? ' sel' : '';
    return '<button class="cw-opt' + sel + '" data-pick="' + field + '" data-val="' + val + '"><span class="ic">' + ic + '</span><span class="lb">' + lb + '</span><div class="pr">' + pr + '</div></button>';
  }
  function rrow(step, k, v) {
    return '<div class="cw-r" data-goto="' + step + '"><span class="k">' + k + '</span><span><span class="v">' + v + '</span><span class="e">✎ modifier</span></span></div>';
  }

  /* ── Confirmation ── */
  function confirmClose() {
    if (state.saving) return;
    var AF = window.AlteoreFlow;
    if (!AF) { toastMsg('❌ alteore-flow.js manquant'); return; }
    state.saving = true;
    var btn = document.getElementById('cwConfirm');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enregistrement…'; }

    var sb = state.a.booking === 'sb';
    var actors = AF.resolveClosingActors(state.lead, state.booking);
    var oc = offerCfg();
    var pc = payCfg();
    var closeData = {
      offre: oc ? oc.commOffre : 'BP 12',                 // clé COMM_RULES ('Elite' | 'BP 12')
      offreLabel: state.a.contrat,                        // libellé carte ('Elite' | 'Business')
      subtype: state.a.paiement === 'pif' ? 'pif' : 'mensualise',
      contracte: pc ? pc.contracte : 0,
      collecte: Number(state.a.encaisse) || 0,
      paiement: 'prelevement',
      closerSlug: actors.closerSlug,
      setterSlug: actors.setterSlug,
      sb: sb
    };

    var p;
    if (state.booking) {
      p = AF.setOutcome(state.booking, 'close', { closeData: closeData, lead: state.lead, typeMap: state.typeMap || {} });
    } else {
      p = AF.applyFicheClose(state.leadId, state.lead, closeData, { typeMap: state.typeMap, bookings: state.bookings });
    }

    p.then(function (res) {
      if (!state) return;
      state.finished = true;
      state.saving = false;
      var deals = (res && res.deals) || [];
      var errs = deals.filter(function (d) { return d && d.error; });
      var okDeals = deals.filter(function (d) { return d && d.created; });
      renderDone(res, okDeals.length, errs);
      if (errs.length) {
        toastMsg('⚠️ ' + errs.length + ' commission(s) NON créée(s) : ' + errs[0].error + ' — à saisir manuellement dans Commissions.', 9000);
      }
      if (typeof state.onDoneCb === 'function') { try { state.onDoneCb(res); } catch (e) {} }
    }).catch(function (e) {
      if (state) state.saving = false;
      if (btn) { btn.disabled = false; btn.textContent = '✅ Confirmer le close'; }
      toastMsg('❌ ' + ((e && e.message) || 'Erreur d\'enregistrement'), 7000);
    });
  }

  function renderDone(res, nbDeals, errs) {
    var name = state.leadName || (state.lead && (state.lead.nom || state.lead.email)) || 'le prospect';
    var via = res && res.viaBookingId ? 'Résultat « Close » posé sur le RDV du lead.' : (state.booking ? 'Résultat « Close » posé sur le RDV.' : 'Fiche fermée en direct (aucun RDV à statuer).');
    document.getElementById('cwDots').innerHTML = '';
    document.getElementById('cwTitle').textContent = 'Client gagné !';
    var payUrl = 'payments.html' + (state.leadId ? '?leadId=' + encodeURIComponent(state.leadId) : '');
    document.getElementById('cwBody').innerHTML =
      '<div class="cw-done">' +
        '<div class="big">🎉</div>' +
        '<div class="t">' + esc(name) + ' est client(e)</div>' +
        '<div class="d">' + via + '<br>Fiche passée en <strong>Closing</strong> · ' +
          (errs && errs.length ? '<span style="color:#fbbf24">⚠ commissions à saisir manuellement</span>'
            : (res && res.updated ? 'close mis à jour — commissions existantes conservées'
              : (nbDeals ? nbDeals + ' commission(s) créée(s) automatiquement' : 'commissions déjà en place'))) +
          ' · encaissé déclaré <strong>' + euro(state.a.encaisse) + ' HT</strong></div>' +
        '<a class="cw-pay" href="' + payUrl + '" target="_blank">💳 Créer le paiement GoCardless</a>' +
        '<button class="cw-ghost" id="cwDoneClose">Fermer</button>' +
        '<div class="cw-hint" style="margin-top:10px">Le module Paiements est la vérité du cash — le funnel croise automatiquement encaissé déclaré ↔ prélèvements réels.</div>' +
      '</div>';
    document.getElementById('cwFoot').innerHTML = '';
    var b = document.getElementById('cwDoneClose');
    if (b) b.addEventListener('click', close);
  }

  /* ── Ouverture ── */
  function open(opts) {
    opts = opts || {};
    var AF = window.AlteoreFlow;
    if (!AF) { alert('alteore-flow.js manquant'); return; }
    ensureDom();

    /* Garde-fou périmètre : jamais de close sur un RDV coaching/client. */
    if (opts.booking && AF.classifyBooking(opts.booking, opts.typeMap || {}) === 'excluded') {
      toastMsg('🎓 RDV coaching / client — hors périmètre Setting & Sales, pas de close ici.');
      return;
    }
    /* typeMap vide → rechargé en fond : re-contrôle un coaching détectable
       uniquement via son type de consultation (même garde que RdvOutcome). */
    var tmEmpty = !(opts.typeMap && Object.keys(opts.typeMap).length);
    if (opts.booking && tmEmpty) {
      var bkId = opts.booking.id;
      AF.loadTypeMap().then(function (m) {
        if (!state || !state.booking || state.booking.id !== bkId) return;
        state.typeMap = m || {};
        if (AF.classifyBooking(state.booking, state.typeMap) === 'excluded') {
          close();
          toastMsg('🎓 RDV coaching / client — hors périmètre Setting & Sales, close annulé.');
        }
      });
    }

    var sbSuggest = null;
    if (opts.booking) sbSuggest = AF.isSB(opts.booking, opts.typeMap || {});
    else if (opts.lead) {
      if (opts.lead.stage === 'rdv_self_booking' || opts.lead.status === 'rdv_self_booking' || opts.lead.type === 'self_booking') sbSuggest = true;
      else if (opts.lead.assignedTo) sbSuggest = false;
    }

    state = {
      leadId: opts.leadId || (opts.booking && opts.booking.leadId) || (opts.lead && (opts.lead.id || opts.lead._id)) || null,
      lead: opts.lead || null,
      leadName: opts.leadName || (opts.booking && opts.booking.prospect ? ((opts.booking.prospect.prenom || '') + ' ' + (opts.booking.prospect.nom || '')).trim() : null),
      booking: opts.booking || null,
      bookings: opts.bookings || null,
      typeMap: tmEmpty ? null : opts.typeMap,
      onDoneCb: opts.onDone || null,
      sbSuggest: sbSuggest,
      step: 0,
      saving: false,
      finished: false,
      a: { contrat: null, paiement: null, booking: sbSuggest === null ? null : (sbSuggest ? 'sb' : 'nb'), encaisse: null }
    };

    /* Lead pas encore chargé → on va le chercher (nom + setter pour les commissions). */
    if (!state.lead && state.leadId && window.firebase && firebase.firestore) {
      firebase.firestore().collection('leads').doc(state.leadId).get().then(function (s) {
        /* garde d'identité : le wizard a pu être rouvert pour un autre lead */
        if (s.exists && state && state.leadId === s.id) { state.lead = s.data(); state.lead.id = s.id; if (STEPS[state.step] !== 'recap') render(); }
      }).catch(function () {});
    }

    document.getElementById('cwBg').classList.add('show');
    render();
  }

  window.CloseWizard = { open: open, close: close };
})();
