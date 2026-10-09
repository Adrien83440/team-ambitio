/* ═══════════════════════════════════════════════════════════════════════
   close-pilot.js — PILOTE DE CLOSING (demande Adrien 09/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Dans la fiche Leads Live, un gros bouton « 🏆 OK pour le closing, c'est
   parti » remplace le rail « Parcours de close ». Il ouvre une suite de
   cartes qui mènent le closer, pendant la visio, de « le client dit oui »
   jusqu'à l'annonce de la vente :

     ① Le deal          offre, paiement, mensualités, booking, encaissé
     ② Le contrat       pré-rempli (signataire, formule, mensualités) —
                        on attend la signature, en direct
     ③ Le paiement      GoCardless pré-rempli (TTC, type, mensualités)
     ④ Le close         enregistré (fiche, commissions) + coach référent
                        (Elite), prévenu sur WhatsApp
     ⑤ Le RDV 72 h      RDV Plan d'Action (Elite) / RDV Urgent 72h
                        (Business) — ou « le client choisira lui-même »
     ⑥ WhatsApp         (Elite) groupe à créer à la main + messages
                        WA-CLO-01 / WA-PIN-01 pré-remplis à copier
     ⑦ La checklist     tout est vérifié depuis les vraies données
     ⑧ Bravo !          annonce à copier pour le canal WhatsApp closing

   Chaque carte se coche à partir des VRAIES données (signature_requests,
   payments, bookings, fiche) ; seuls les gestes WhatsApp sont déclaratifs.
   L'avancement est posé sur la fiche : leads/{id}.closePilot.
   Les modules Signatures / Paiements / Booking ne sont jamais réécrits : on
   les ouvre (iframe ?embed=1) avec des paramètres de pré-remplissage.

   Partagé par Leads Live (sales-leads.html) et le bac à sable closer
   (sandbox-closer.js) : chacun fournit un HÔTE via ClosePilot.configure().
   Interface de l'hôte :
     lead(id) → fiche   ·  sigs(id) / pays(id) / bookings(id) → tableaux
     typeMap() → { typeId: { label } }  ·  cfg() → réglages (_config)
     coaches() → [{ slug, nom }]  ·  me() → { nom }  ·  setterName(lead)
     origin(lead) → texte  ·  sbSuggest(lead) → true | false | null
     openModule('sig'|'pay'|'book', leadId, params)  ·  closeModule()
     save(leadId, patch) → Promise (fusion dans leads/{id}.closePilot)
     recordClose(leadId, answers) → Promise (CloseWizard.commit en prod)
     bookingLink(typeId, lead) → URL  ·  toast(msg)  ·  moduleOpen() → bool
   ES5 strict (convention du repo).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TVA = 0.2;
  var FALLBACK_PRICING = {
    'Elite': { commOffre: 'Elite', pif: { contracte: 12000 }, mensualise: { contracte: 13000, maxX: 4 } },
    'Business': { commOffre: 'BP 12', pif: { contracte: 5000 }, mensualise: { contracte: 6000, maxX: 10 } }
  };
  var LIENS = {
    espace: 'https://www.ambitiocorp.com/ressources-elitev2',
    questionnaire: 'https://team.alteore.com/alteoforms-render.html?id=6sYCUup0lDdz6mWAPlIg',
    plateforme: 'https://academy.adrienemily.com',
    cercle: 'https://chat.whatsapp.com/K2tb386twjj280vgIsqu8f'
  };
  /* Numéros de l'équipe à ajouter au groupe — process-onboarding-elite-closer.html. */
  var EQUIPE = [
    { nom: 'Adrien', role: 'Mentor · co-fondateur', tel: '07 66 83 36 32' },
    { nom: 'Emily', role: 'Mentor · co-fondatrice', tel: '07 67 11 63 82' },
    { nom: 'Marine', role: 'Customer Satisfaction Manager', tel: '07 72 08 97 92' }
  ];
  var COACH_TELS = { 'edouard': '06 08 95 18 50', 'thomas': '06 15 29 66 82', 'flore': '07 56 82 60 05', 'vincent': '07 51 36 47 77' };

  var H = null;            // l'hôte
  var ui = { leadId: null, step: null, busy: false, local: {} };

  /* ═══ Outils ═══════════════════════════════════════════════════════ */
  function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function euro(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('fr-FR').replace(/ | /g, ' ') + ' €'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function frDate(d, short) { d = d ? new Date(d) : new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + (short ? String(d.getFullYear()).slice(2) : d.getFullYear()); }
  function ms(v) { if (!v) return 0; if (typeof v === 'number') return v; if (v.toMillis) return v.toMillis(); if (v.seconds) return v.seconds * 1000; var t = Date.parse(v); return isNaN(t) ? 0 : t; }
  function prenomOf(nom) { return String(nom || '').trim().split(/\s+/)[0] || ''; }
  function telFr(t) { var d = String(t || '').replace(/\D/g, ''); if (d.indexOf('33') === 0 && d.length === 11) d = '0' + d.slice(2); return d; }
  function pricing() { return (window.AlteoreFlow && window.AlteoreFlow.WIZARD_PRICING) || FALLBACK_PRICING; }
  function copyText(txt) {
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta);
    }
    try { navigator.clipboard.writeText(txt).then(function () {}, fallback); } catch (e) { fallback(); }
    H.toast('📋 Copié !');
  }

  /* ═══ État du pilote d'un lead ═════════════════════════════════════ */
  function cpOf(leadId) {
    var l = H.lead(leadId) || {};
    var base = l.closePilot || {};
    var loc = ui.local[leadId] || {};
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(loc).forEach(function (k) {
      if (loc[k] && typeof loc[k] === 'object' && !Array.isArray(loc[k])) { out[k] = out[k] || {}; Object.keys(loc[k]).forEach(function (kk) { out[k][kk] = loc[k][kk]; }); }
      else out[k] = loc[k];
    });
    return out;
  }
  function save(leadId, patch) {
    var loc = ui.local[leadId] = ui.local[leadId] || {};
    Object.keys(patch).forEach(function (k) {
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) { loc[k] = loc[k] || {}; Object.keys(patch[k]).forEach(function (kk) { loc[k][kk] = patch[k][kk]; }); }
      else loc[k] = patch[k];
    });
    return Promise.resolve(H.save(leadId, patch)).catch(function (e) { H.toast('❌ Enregistrement impossible : ' + ((e && e.message) || 'erreur')); });
  }

  function deal(cp) {
    var c = cp.choix || {}, P = pricing()[c.offre];
    if (!P || !c.paiement) return null;
    var pc = c.paiement === 'pif' ? P.pif : P.mensualise;
    var n = c.paiement === 'pif' ? 1 : (Number(c.nmens) || 0);
    var ttc = Math.round(pc.contracte * (1 + TVA) * 100) / 100;
    var encaisse = c.encaisse != null && c.encaisse !== '' ? Number(c.encaisse) : (c.paiement === 'pif' ? pc.contracte : (n ? Math.round(pc.contracte / n) : 0));
    return { offre: c.offre, label: c.offre === 'Elite' ? 'Élite Phénix' : 'Business Phénix', paiement: c.paiement, n: n, ht: pc.contracte, ttc: ttc,
      mensTTC: n > 1 ? Math.round(ttc / n * 100) / 100 : ttc, encaisse: encaisse, booking: c.booking };
  }
  function lastSig(leadId) {
    var list = (H.sigs(leadId) || []).filter(function (r) { return r.status !== 'cancelled'; });
    var signed = list.filter(function (r) { return r.status === 'signed'; });
    if (signed.length) return signed[signed.length - 1];
    return list.sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); })[list.length - 1] || null;
  }
  function lastPay(leadId) {
    var list = (H.pays(leadId) || []).filter(function (p) { return p.status !== 'cancelled'; });
    return list.sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); })[list.length - 1] || null;
  }
  /* Le type de RDV 72 h : réglage (_config) sinon détection par libellé. */
  function rdvType(offre) {
    var cfg = H.cfg() || {}, tm = H.typeMap() || {};
    var forced = offre === 'Business' ? cfg.typeBusiness : cfg.typeElite;
    if (forced) return forced;
    var ids = Object.keys(tm), i;
    if (offre === 'Business') { for (i = 0; i < ids.length; i++) if (/urgent/.test(fold(tm[ids[i]].label)) && /72/.test(tm[ids[i]].label)) return ids[i]; for (i = 0; i < ids.length; i++) if (/urgent/.test(fold(tm[ids[i]].label))) return ids[i]; return ''; }
    if (tm.rdv_plan_action_adrien || !ids.length) return 'rdv_plan_action_adrien';
    for (i = 0; i < ids.length; i++) if (/plan d.?action/.test(fold(tm[ids[i]].label))) return ids[i];
    return 'rdv_plan_action_adrien';
  }
  function rdvLabel(offre) { return offre === 'Business' ? 'RDV Urgent 72h' : 'RDV Plan d\'Action'; }
  function rdvBooking(leadId, offre) {
    var t = rdvType(offre);
    var list = (H.bookings(leadId) || []).filter(function (b) { return b && b.status !== 'cancelled' && b.outcome !== 'annule' && (t ? b.type === t : false); });
    return list[list.length - 1] || null;
  }

  /* ═══ Les étapes ═══════════════════════════════════════════════════ */
  function steps(leadId) {
    var l = H.lead(leadId) || {}, cp = cpOf(leadId), d = deal(cp);
    var elite = !d || d.offre === 'Elite';
    var sig = lastSig(leadId), pay = lastPay(leadId);
    var paid = pay && (pay.status === 'active' || pay.status === 'completed');
    var closed = !!(cp.closeAt || l.isClient === true || String(l.stage || '').indexOf('closed_won') === 0);
    var coach = (cp.coach && cp.coach.nom) || (l.coachAssigne && l.coachAssigne.nom) || '';
    var wa = cp.wa || {};
    var list = [
      { k: 'deal', ic: '🤝', l: 'Le deal', done: !!(d && d.booking && (d.paiement === 'pif' || d.n)) },
      { k: 'contrat', ic: '📝', l: 'Contrat', done: !!(sig && sig.status === 'signed') },
      { k: 'paiement', ic: '💳', l: 'Paiement', done: !!(paid || (pay && cp.payLater)) },
      { k: 'close', ic: '🏆', l: 'Close', done: closed && (!elite || !!coach) },
      { k: 'rdv', ic: '📅', l: 'RDV 72 h', done: !!(rdvBooking(leadId, d ? d.offre : 'Elite') || cp.rdvClient) }
    ];
    if (elite) list.push({ k: 'wa', ic: '💬', l: 'WhatsApp', done: !!(wa.groupe && wa.bienvenue && wa.liens && wa.espace) });
    list.push({ k: 'check', ic: '✅', l: 'Checklist', done: !!cp.doneAt });
    list.push({ k: 'bravo', ic: '🎉', l: 'Bravo', done: !!cp.doneAt });
    return list;
  }
  function firstTodo(list) { for (var i = 0; i < list.length; i++) if (!list[i].done) return list[i].k; return 'bravo'; }

  /* ═══ Styles ═══════════════════════════════════════════════════════ */
  function ensureStyles() {
    if (document.getElementById('cpStyles')) return;
    var css = ''
      + '.cp-strip{background:linear-gradient(135deg,rgba(16,185,129,.08),rgba(91,124,250,.06));border:1px solid rgba(52,211,153,.28);border-radius:14px;padding:12px;margin:10px 0}'
      + '.cp-go{width:100%;border:none;border-radius:14px;padding:16px 14px;font-size:16px;font-weight:900;cursor:pointer;font-family:inherit;color:#04120c;background:linear-gradient(135deg,#34d399,#10b981);box-shadow:0 10px 26px rgba(16,185,129,.28);letter-spacing:.2px}'
      + '.cp-go:hover{filter:brightness(1.06);transform:translateY(-1px)}'
      + '.cp-go small{display:block;font-size:11px;font-weight:700;opacity:.75;margin-top:3px}'
      + '.cp-prog{display:flex;gap:4px;margin:2px 0 10px}'
      + '.cp-prog i{flex:1;height:6px;border-radius:99px;background:rgba(255,255,255,.1)}'
      + '.cp-prog i.d{background:#34d399}.cp-prog i.n{background:#fbbf24}'
      + '.cp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
      + '.cp-row .t{font-size:12.5px;font-weight:800;color:#eef1fa;flex:1;min-width:150px}'
      + '.cp-row .t small{display:block;font-size:11px;font-weight:600;color:#8d93a8}'
      + '.cp-btn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#eef1fa;border-radius:10px;padding:8px 13px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}'
      + '.cp-btn:hover{border-color:#5b7cfa}.cp-btn[disabled]{opacity:.45;cursor:default}'
      + '.cp-btn.pri{background:linear-gradient(135deg,#5b7cfa,#4a63d8);border-color:transparent;color:#fff}'
      + '.cp-btn.ok{background:linear-gradient(135deg,#10b981,#0d9f6f);border-color:transparent;color:#04120c}'
      + '.cp-btn.big{padding:12px 18px;font-size:13.5px}'
      + '#cpBg{position:fixed;inset:0;background:rgba(6,8,16,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:99990;display:none;align-items:center;justify-content:center;padding:16px}'
      + '#cpBg.show{display:flex}'
      + '.cp-mo{width:min(620px,97vw);max-height:94vh;display:flex;flex-direction:column;background:linear-gradient(165deg,#171c2e,#0f131f);border:1px solid rgba(255,255,255,.1);border-radius:20px;box-shadow:0 30px 90px rgba(0,0,0,.6);color:#eef1fa;font-family:inherit;overflow:hidden}'
      + '.cp-hd{padding:14px 18px 10px;border-bottom:1px solid rgba(255,255,255,.07)}'
      + '.cp-hd .ti{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:900}'
      + '.cp-hd .ti span{flex:1}'
      + '.cp-x{background:none;border:none;color:#8d93a8;font-size:18px;cursor:pointer;padding:4px 6px}'
      + '.cp-steps{display:flex;gap:4px;margin-top:10px;overflow-x:auto;padding-bottom:2px}'
      + '.cp-st{flex:1;min-width:58px;border:none;background:none;cursor:pointer;color:#8d93a8;font-family:inherit;padding:0;text-align:center}'
      + '.cp-st i{display:block;height:4px;border-radius:99px;background:rgba(255,255,255,.1);margin-bottom:5px}'
      + '.cp-st b{font-size:10px;font-weight:800;white-space:nowrap}'
      + '.cp-st.d i{background:#34d399}.cp-st.d{color:#6ee7b7}'
      + '.cp-st.on i{background:#5b7cfa}.cp-st.on{color:#fff}'
      + '.cp-bd{padding:16px 18px;overflow-y:auto;flex:1}'
      + '.cp-ft{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,.06)}'
      + '.cp-h{font-size:17px;font-weight:900;margin-bottom:4px}'
      + '.cp-sub{font-size:12px;color:#8d93a8;line-height:1.55;margin-bottom:14px}'
      + '.cp-lb{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#8d93a8;margin:14px 0 7px}'
      + '.cp-opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
      + '.cp-opt{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);border-radius:13px;padding:12px;text-align:left;cursor:pointer;color:#eef1fa;font-family:inherit}'
      + '.cp-opt:hover{border-color:#5b7cfa}.cp-opt.sel{border-color:#5b7cfa;background:rgba(91,124,250,.15);box-shadow:0 0 0 1px #5b7cfa inset}'
      + '.cp-opt b{display:block;font-size:13.5px}.cp-opt small{display:block;font-size:11px;color:#8d93a8;margin-top:3px;line-height:1.4}'
      + '.cp-chips{display:flex;flex-wrap:wrap;gap:6px}'
      + '.cp-chip{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);border-radius:99px;padding:7px 13px;font-size:12.5px;font-weight:800;cursor:pointer;color:#eef1fa;font-family:inherit}'
      + '.cp-chip.sel{border-color:#5b7cfa;background:rgba(91,124,250,.18)}'
      + '.cp-in{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:9px 12px;font-size:14px;font-weight:700;color:#eef1fa;font-family:inherit;outline:none}'
      + '.cp-box{border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);border-radius:12px;padding:11px 13px;font-size:12.5px;line-height:1.6;margin-top:12px}'
      + '.cp-box.g{border-color:rgba(52,211,153,.35);background:rgba(16,185,129,.07);color:#a7f3d0}'
      + '.cp-box.y{border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.07);color:#fde68a}'
      + '.cp-box.r{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.07);color:#fecaca}'
      + '.cp-box b{color:#fff}'
      + '.cp-wait{display:flex;align-items:center;gap:10px}'
      + '.cp-dot{width:10px;height:10px;border-radius:50%;background:#fbbf24;animation:cpP 1.2s infinite}'
      + '@keyframes cpP{0%,100%{opacity:.3}50%{opacity:1}}'
      + '.cp-chk{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border:1px solid rgba(255,255,255,.08);border-radius:11px;margin-top:7px;cursor:pointer;font-size:12.5px;line-height:1.45}'
      + '.cp-chk input{margin-top:2px;width:17px;height:17px;accent-color:#10b981;flex:none}'
      + '.cp-chk.on{border-color:rgba(52,211,153,.4);background:rgba(16,185,129,.06)}'
      + '.cp-msg{white-space:pre-wrap;font-size:12px;line-height:1.55;background:#0b0e18;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;margin-top:6px;font-family:inherit;color:#e2e8f0;max-height:220px;overflow:auto}'
      + '.cp-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}'
      + '.cp-tbl td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.06)}'
      + '.cp-tbl td:last-child{text-align:right;font-weight:800;white-space:nowrap}'
      + '.cp-li{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed rgba(255,255,255,.07);font-size:12.5px}'
      + '.cp-li .m{width:20px;height:20px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900}'
      + '.cp-li.ok .m{background:rgba(52,211,153,.18);color:#34d399}.cp-li.ko .m{background:rgba(239,68,68,.18);color:#f87171}.cp-li.wa .m{background:rgba(251,191,36,.18);color:#fbbf24}'
      + '.cp-li small{display:block;color:#8d93a8;font-size:11px}'
      + '.cp-win{text-align:center;padding:6px 0 4px}'
      + '.cp-win .big{font-size:58px;line-height:1;animation:cpB .9s ease}'
      + '@keyframes cpB{0%{transform:scale(.3) rotate(-20deg);opacity:0}70%{transform:scale(1.15) rotate(6deg);opacity:1}100%{transform:scale(1)}}'
      + '.cp-win h2{font-size:24px;font-weight:900;margin:10px 0 4px;background:linear-gradient(90deg,#fbbf24,#34d399,#5b7cfa);-webkit-background-clip:text;background-clip:text;color:transparent}'
      + '.cp-confetti{position:fixed;top:-12px;width:9px;height:14px;z-index:99999;pointer-events:none;animation:cpF 2.6s linear forwards}'
      + '@keyframes cpF{to{transform:translateY(105vh) rotate(720deg);opacity:.8}}'
      + '#cpNotice{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:100002;width:min(440px,92vw);background:linear-gradient(165deg,#12301f,#0f1a16);border:1px solid rgba(52,211,153,.55);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.65),0 0 0 4px rgba(52,211,153,.12);padding:18px 18px 16px;color:#eef1fa;text-align:center;opacity:0;pointer-events:none;transition:all .25s ease;font-family:inherit}'
      + '#cpNotice.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}'
      + '#cpNotice .ic{font-size:34px;line-height:1;animation:cpB .7s ease}'
      + '#cpNotice .t{font-size:16px;font-weight:900;margin:8px 0 4px}'
      + '#cpNotice .d{font-size:12.5px;color:#a7b0c4;line-height:1.5;margin-bottom:14px}'
      + '#cpNotice .cp-btn{width:100%;justify-content:center}'
      + '@media(max-width:560px){.cp-opts{grid-template-columns:1fr}.cp-mo{max-height:100vh;border-radius:0}#cpBg{padding:0}}';
    var st = document.createElement('style'); st.id = 'cpStyles'; st.textContent = css; document.head.appendChild(st);
  }

  /* ═══ Le bandeau dans la fiche ═════════════════════════════════════ */
  function stripHTML(leadId) {
    var l = H.lead(leadId) || {}, cp = cpOf(leadId);
    var list = steps(leadId), done = list.filter(function (s) { return s.done; }).length;
    if (!cp.startedAt) {
      var already = l.isClient === true || String(l.stage || '').indexOf('closed_won') === 0;
      return '<div class="cp-strip"><button class="cp-go" data-cp="start" data-cp-lead="' + esc(leadId) + '">' + (already ? '🏆 Onboarding du client — c\'est parti' : '🏆 OK pour le closing, c\'est parti')
        + '<small>' + (already ? 'Paiement, RDV 72 h, WhatsApp, checklist' : 'Le client a dit oui ? Les cartes te guident jusqu\'à l\'annonce.') + '</small></button></div>';
    }
    var next = firstTodo(list), cur = null;
    list.forEach(function (s) { if (s.k === next) cur = s; });
    var h = '<div class="cp-strip"><div class="cp-prog">';
    list.forEach(function (s) { h += '<i class="' + (s.done ? 'd' : (s.k === next ? 'n' : '')) + '" title="' + esc(s.l) + '"></i>'; });
    h += '</div><div class="cp-row"><div class="t">' + (cp.doneAt ? '🎉 Closing bouclé' : '🏆 Closing en cours · ' + done + '/' + list.length)
      + '<small>' + (cp.doneAt ? 'Validé le ' + frDate(cp.doneAt) + (cp.byName ? ' par ' + esc(cp.byName) : '') : 'Prochaine étape : ' + esc(cur ? cur.ic + ' ' + cur.l : '')) + '</small></div>'
      + '<button class="cp-btn ' + (cp.doneAt ? '' : 'ok big') + '" data-cp="open" data-cp-lead="' + esc(leadId) + '">' + (cp.doneAt ? 'Revoir' : '▶ Reprendre') + '</button></div></div>';
    return h;
  }

  /* ═══ « Tu peux fermer cette fenêtre » (Adrien 09/10/2026) ═════════
     Quand une carte ouvre un module (contrat, paiement, RDV) et que l'étape
     se valide pendant qu'il est ouvert, une pop-up le dit et le ferme d'un
     clic : retour à la carte, puis « Continuer ». Elle disparaît seule si
     le module est fermé autrement (✕, Échap). Hôte : closeModule(). */
  var NOTICE = {
    contrat: { ic: '✍️', t: 'Contrat signé !', d: 'Le client a signé. Tu peux maintenant fermer cette fenêtre et revenir aux cartes.' },
    paiement: { ic: '💳', t: 'Prélèvement déclenché !', d: 'Le paiement est en place. Tu peux maintenant fermer cette fenêtre et revenir aux cartes.' },
    rdv: { ic: '📅', t: 'RDV 72 h réservé !', d: 'Le rendez-vous est calé. Tu peux maintenant fermer cette fenêtre et revenir aux cartes.' }
  };
  var noticeWatch = null;
  function showNotice(k) {
    var n = NOTICE[k]; if (!n) return;
    var el = document.getElementById('cpNotice');
    if (!el) {
      el = document.createElement('div'); el.id = 'cpNotice';
      el.addEventListener('click', function (e) {
        if (!e.target.closest || !e.target.closest('[data-cp-notice]')) return;
        hideNotice();
        if (H && H.closeModule) H.closeModule();
        render();
      });
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="ic">' + n.ic + '</div><div class="t">' + esc(n.t) + '</div><div class="d">' + esc(n.d) + '</div>'
      + '<button class="cp-btn ok big" data-cp-notice="1">Fermer et revenir aux cartes</button>';
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearInterval(noticeWatch);
    noticeWatch = setInterval(function () { if (!(H && H.moduleOpen && H.moduleOpen())) hideNotice(); }, 500);
  }
  function hideNotice() {
    clearInterval(noticeWatch); noticeWatch = null;
    var el = document.getElementById('cpNotice'); if (el) el.classList.remove('show');
  }
  /* Module ouvert depuis une carte : on retient l'étape et son état à
     l'ouverture — la pop-up ne salue qu'un passage « à faire » → « fait ». */
  var MOD_STEP = { sig: 'contrat', pay: 'paiement', book: 'rdv' };
  function stepDone(leadId, k) {
    var r = false; steps(leadId).forEach(function (s) { if (s.k === k) r = s.done; }); return r;
  }

  /* ═══ La modale ════════════════════════════════════════════════════ */
  function ensureDom() {
    ensureStyles();
    if (document.getElementById('cpBg')) return;
    var bg = document.createElement('div'); bg.id = 'cpBg';
    bg.innerHTML = '<div class="cp-mo" id="cpMo"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && bg.classList.contains('show') && !(H.moduleOpen && H.moduleOpen())) closeModal(); });
    bg.addEventListener('click', onClick);
    bg.addEventListener('input', onInput);
    bg.addEventListener('change', onInput);
  }
  function openModal(leadId, step) {
    ensureDom();
    if (ui.leadId !== leadId) { ui.coachSlug = null; ui.coachNom = null; ui.auto_contrat = false; ui.auto_paiement = false; }
    ui.leadId = leadId;
    ui.step = step || firstTodo(steps(leadId));
    document.getElementById('cpBg').classList.add('show');
    render();
  }
  function closeModal() { var bg = document.getElementById('cpBg'); if (bg) bg.classList.remove('show'); ui.leadId = null; ui.modStep = null; hideNotice(); }

  function render() {
    if (!ui.leadId) return;
    var leadId = ui.leadId, l = H.lead(leadId) || {}, list = steps(leadId);
    var keys = list.map(function (s) { return s.k; });
    if (keys.indexOf(ui.step) < 0) ui.step = firstTodo(list);
    var idx = keys.indexOf(ui.step), cur = list[idx];
    var bd = document.querySelector('#cpMo .cp-bd'), sc = bd ? bd.scrollTop : 0;
    var h = '<div class="cp-hd"><div class="ti">🏆 <span>Closing — ' + esc(l.nom || 'Client') + '</span><button class="cp-x" data-cp="close" title="Fermer (Échap) — tout est enregistré">✕</button></div><div class="cp-steps">';
    list.forEach(function (s, i) {
      h += '<button class="cp-st' + (s.done ? ' d' : '') + (i === idx ? ' on' : '') + '" data-cp="goto" data-k="' + s.k + '"><i></i><b>' + s.ic + ' ' + esc(s.l) + '</b></button>';
    });
    h += '</div></div><div class="cp-bd">' + card(cur.k, leadId) + '</div>';
    var nextOk = cur.done || cur.k === 'bravo';
    h += '<div class="cp-ft">' + (idx > 0 ? '<button class="cp-btn" data-cp="prev">← Retour</button>' : '<span></span>');
    if (cur.k === 'bravo') h += '<button class="cp-btn ok" data-cp="close">Fermer</button>';
    else if (cur.k === 'check') h += '<span></span>';
    else h += '<button class="cp-btn ok big" data-cp="next"' + (nextOk ? '' : ' disabled') + '>Continuer →</button>';
    h += '</div>';
    document.getElementById('cpMo').innerHTML = h;
    var nb = document.querySelector('#cpMo .cp-bd'); if (nb) nb.scrollTop = sc;
  }

  /* ═══ Les cartes ═══════════════════════════════════════════════════ */
  function card(k, leadId) {
    var l = H.lead(leadId) || {}, cp = cpOf(leadId), d = deal(cp);
    if (k === 'deal') return cardDeal(l, cp, d);
    if (k === 'contrat') return cardContrat(leadId, l, cp, d);
    if (k === 'paiement') return cardPaiement(leadId, l, cp, d);
    if (k === 'close') return cardClose(leadId, l, cp, d);
    if (k === 'rdv') return cardRdv(leadId, l, cp, d);
    if (k === 'wa') return cardWa(leadId, l, cp, d);
    if (k === 'check') return cardCheck(leadId, l, cp, d);
    return cardBravo(leadId, l, cp, d);
  }

  function cardDeal(l, cp, d) {
    var c = cp.choix || {}, P = pricing(), h = '';
    h += '<div class="cp-h">🤝 Ce que le client a choisi</div><div class="cp-sub">Tout le reste se pré-remplit à partir d\'ici : le contrat, le paiement, l\'annonce.</div>';
    h += '<div class="cp-lb">Offre</div><div class="cp-opts">'
      + opt('offre', 'Elite', c.offre, '👑 Élite Phénix', 'Intégral ' + euro(P.Elite.pif.contracte) + ' HT · échelonné ' + euro(P.Elite.mensualise.contracte) + ' HT (≤ ' + (P.Elite.mensualise.maxX || 4) + '×)')
      + opt('offre', 'Business', c.offre, '🚀 Business Phénix', 'Intégral ' + euro(P.Business.pif.contracte) + ' HT · échelonné ' + euro(P.Business.mensualise.contracte) + ' HT (≤ ' + (P.Business.mensualise.maxX || 10) + '×)') + '</div>';
    if (c.offre) {
      h += '<div class="cp-lb">Paiement</div><div class="cp-opts">'
        + opt('paiement', 'pif', c.paiement, '💎 En une fois', euro(P[c.offre].pif.contracte) + ' HT — le meilleur tarif')
        + opt('paiement', 'mensualise', c.paiement, '📅 Échelonné', euro(P[c.offre].mensualise.contracte) + ' HT, prélevé chaque mois') + '</div>';
    }
    if (c.offre && c.paiement === 'mensualise') {
      var max = P[c.offre].mensualise.maxX || 4;
      h += '<div class="cp-lb">Nombre de mensualités</div><div class="cp-chips">';
      for (var n = 2; n <= max; n++) h += '<button class="cp-chip' + (Number(c.nmens) === n ? ' sel' : '') + '" data-cp="set" data-f="nmens" data-v="' + n + '">' + n + ' ×</button>';
      h += '</div>';
    }
    if (c.offre && c.paiement) {
      var sug = H.sbSuggest(l);
      h += '<div class="cp-lb">Le RDV venait de…</div><div class="cp-opts">'
        + opt('booking', 'sb', c.booking, '🔗 Self Booking', 'Il a pris son RDV seul' + (sug === true ? ' · 💡 détecté' : ''))
        + opt('booking', 'nb', c.booking, '📞 No Booking', 'Travaillé par le setting' + (sug === false ? ' · 💡 détecté' : '') + (H.setterName(l) ? ' (' + esc(H.setterName(l)) + ')' : '')) + '</div>';
    }
    if (d && (d.paiement === 'pif' || d.n)) {
      h += '<div class="cp-lb">Encaissé à la signature (HT)</div><input class="cp-in" type="number" min="0" step="50" data-cp-in="encaisse" value="' + esc(c.encaisse != null && c.encaisse !== '' ? c.encaisse : d.encaisse) + '">';
      h += '<div class="cp-box g">Contrat : <b>' + euro(d.ht) + ' HT</b> (' + euro(d.ttc) + ' TTC)'
        + (d.paiement === 'pif' ? ' · prélevé en une fois : <b>' + euro(d.ttc) + ' TTC</b>' : ' · GoCardless : <b>' + d.n + ' × ' + euro(d.mensTTC) + ' TTC</b>')
        + '<br>Encaissé déclaré : <b>' + euro(d.encaisse) + ' HT</b> — ce montant est en HT, GoCardless est en TTC.</div>';
    }
    return h;
  }
  function opt(f, v, cur, title, sub) {
    return '<button class="cp-opt' + (cur === v ? ' sel' : '') + '" data-cp="set" data-f="' + f + '" data-v="' + v + '"><b>' + title + '</b><small>' + sub + '</small></button>';
  }

  function cardContrat(leadId, l, cp, d) {
    var r = lastSig(leadId), h = '<div class="cp-h">📝 Le contrat</div>';
    h += '<div class="cp-sub">Reste en visio pendant qu\'il signe : on n\'envoie jamais un contrat « pour plus tard ».</div>';
    if (!r) {
      h += '<div class="cp-box">La fenêtre d\'envoi s\'ouvre avec <b>' + esc(l.nom || 'le client') + '</b>, son e-mail, son téléphone' + (d ? ', la formule <b>' + (d.paiement === 'pif' ? 'en une fois' : 'échelonnée en ' + d.n + ' fois') + '</b>' : '') + ' déjà remplis. Choisis le modèle <b>' + esc(d ? d.label : '') + '</b>, vérifie, envoie.</div>';
      h += '<div style="margin-top:14px"><button class="cp-btn pri big" data-cp="mod" data-m="sig">📨 Préparer le contrat</button></div>';
      return h;
    }
    var signed = r.status === 'signed', pg = r.progress || {};
    if (signed) {
      h += '<div class="cp-box g">✅ <b>Contrat signé</b> — « ' + esc(r.templateName || '') + ' »' + (r.certificateId ? ' · réf. ' + esc(r.certificateId) : '') + '<br>'
        + (r.signers || []).map(function (s) { return esc(s.name) + ' ✍️'; }).join(' · ') + '</div>';
    } else {
      h += '<div class="cp-box"><div class="cp-wait"><span class="cp-dot"></span><div><b>En attente de la signature</b> — « ' + esc(r.templateName || '') + ' »<br>'
        + '<span style="color:#8d93a8">' + esc(pg.nom || 'Lien envoyé') + (pg.lectureTotal ? ' · lecture ' + (pg.lectureVues || 0) + '/' + pg.lectureTotal : '') + (pg.derniere ? ' · ' + esc(pg.derniere) : '') + '</span></div></div>'
        + '<div style="margin-top:8px;font-size:11.5px;color:#8d93a8">' + (r.signers || []).map(function (s, i) { return (i ? '② ' : '① ') + esc(s.name) + ' : ' + (s.status === 'signed' ? '✅ signé' : (s.status === 'opened' ? '👁 ouvert' : '⏳ en attente')); }).join(' · ') + '</div></div>';
      h += '<div class="cp-sub" style="margin-top:10px">La carte avance toute seule dès que le contrat est signé.</div>';
    }
    h += '<div style="margin-top:12px"><button class="cp-btn" data-cp="mod" data-m="sig">📝 Ouvrir les signatures</button></div>';
    return h;
  }

  var PAY_LBL = { draft: '📝 Paiement créé — génère le lien mandat et envoie-le au client', pending_mandate: '⏳ Lien mandat envoyé — le client saisit son IBAN', mandate_active: '✅ Mandat actif — déclenche le prélèvement', active: '💸 Prélèvement déclenché', completed: '🎉 Paiement terminé', failed: '❌ Échec du prélèvement', mandate_failed: '❌ Mandat refusé' };
  function cardPaiement(leadId, l, cp, d) {
    var p = lastPay(leadId), sig = lastSig(leadId), h = '<div class="cp-h">💳 Le paiement</div>';
    h += '<div class="cp-sub">Mandat GoCardless dans la foulée de la signature : le premier prélèvement part le jour même.</div>';
    if (!sig || sig.status !== 'signed') h += '<div class="cp-box y">🔒 Le contrat n\'est pas encore signé : le paiement ne peut pas être créé avant.</div>';
    if (!p) {
      if (d) h += '<div class="cp-box">Se pré-remplit avec <b>' + euro(d.ttc) + ' TTC</b>' + (d.n > 1 ? ' en <b>' + d.n + ' × ' + euro(d.mensTTC) + '</b>' : ' en une fois') + '. Vérifie et crée.</div>';
      h += '<div style="margin-top:14px"><button class="cp-btn pri big" data-cp="mod" data-m="pay"' + (sig && sig.status === 'signed' ? '' : ' disabled') + '>💳 Créer le paiement</button></div>';
      return h;
    }
    var ok = p.status === 'active' || p.status === 'completed';
    h += '<div class="cp-box ' + (ok ? 'g' : '') + '">' + esc(PAY_LBL[p.status] || p.status) + '<br><span style="color:#8d93a8">' + euro(p.totalAmount) + ' TTC · ' + (p.type === 'installments' ? p.installmentsCount + ' mensualités' : 'intégral') + '</span></div>';
    if (d && Math.abs(Number(p.totalAmount) - d.ttc) > 0.01) h += '<div class="cp-box r">⚠️ Montant ' + euro(p.totalAmount) + ' — le deal prévoit <b>' + euro(d.ttc) + ' TTC</b>.</div>';
    if (d && d.n > 1 && Number(p.installmentsCount) !== d.n) h += '<div class="cp-box r">⚠️ ' + p.installmentsCount + ' mensualités — le deal prévoit <b>' + d.n + '</b>.</div>';
    h += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="cp-btn pri" data-cp="mod" data-m="pay">💳 Ouvrir les paiements</button>';
    if (!ok) h += '<button class="cp-btn" data-cp="payLater">' + (cp.payLater ? '✓ Le client finira plus tard' : 'Le client finira son IBAN plus tard →') + '</button>';
    h += '</div>';
    if (cp.payLater && !ok) h += '<div class="cp-box y">Noté : le mandat reste à finaliser. Ce point restera en orange dans la checklist — relance le client.</div>';
    return h;
  }

  function cardClose(leadId, l, cp, d) {
    var elite = !d || d.offre === 'Elite', h = '<div class="cp-h">🏆 ' + (elite ? 'Le close et le coach référent' : 'Le close') + '</div>';
    var closed = !!(cp.closeAt || l.isClient === true || String(l.stage || '').indexOf('closed_won') === 0);
    var coach = (cp.coach && cp.coach.nom) || (l.coachAssigne && l.coachAssigne.nom) || '';
    if (closed && (!elite || coach)) {
      h += '<div class="cp-box g">✅ <b>Close enregistré</b>' + (cp.closeAt ? ' le ' + frDate(cp.closeAt) : '') + ' — fiche passée en Closing, commissions créées.'
        + (elite ? '<br>🎓 Coach référent : <b>' + esc(coach) + '</b> — prévenu sur WhatsApp.' : '') + '</div>';
      return h;
    }
    h += '<div class="cp-sub">Enregistre la vente : la fiche passe en Closing et les commissions se créent' + (elite ? ', puis le coach est prévenu sur WhatsApp.' : '.') + '</div>';
    if (d) h += '<div class="cp-box">' + esc(d.label) + ' · ' + (d.paiement === 'pif' ? 'en une fois' : d.n + ' fois') + ' · ' + (d.booking === 'sb' ? 'Self Booking' : 'No Booking') + ' · encaissé ' + euro(d.encaisse) + ' HT</div>';
    if (elite) {
      var cs = H.coaches() || [], sel = (cp.coach && cp.coach.slug) || ui.coachSlug || '';
      h += '<div class="cp-lb">Coach référent</div>';
      if (!cs.length) h += '<div class="cp-box y">Aucun coach dans l\'annuaire de l\'équipe.</div>';
      else { h += '<div class="cp-chips">'; cs.forEach(function (c) { h += '<button class="cp-chip' + (sel === c.slug ? ' sel' : '') + '" data-cp="coach" data-s="' + esc(c.slug) + '" data-n="' + esc(c.nom) + '">🎓 ' + esc(c.nom) + '</button>'; }); h += '</div>'; }
    }
    if (closed && elite && !coach) h += '<div class="cp-box y">Le close est déjà enregistré : choisis le coach puis valide, il sera prévenu.</div>';
    var can = d && (!elite || ui.coachSlug || (cp.coach && cp.coach.slug));
    h += '<div style="margin-top:16px"><button class="cp-btn ok big" data-cp="record"' + (can && !ui.busy ? '' : ' disabled') + '>' + (ui.busy ? '⏳ Enregistrement…' : (closed ? '🎓 Valider le coach' : '🏆 Enregistrer le close')) + '</button></div>';
    return h;
  }

  function cardRdv(leadId, l, cp, d) {
    var offre = d ? d.offre : 'Elite', t = rdvType(offre), b = rdvBooking(leadId, offre), lab = rdvLabel(offre);
    var h = '<div class="cp-h">📅 ' + lab + '</div>';
    h += '<div class="cp-sub">' + (offre === 'Elite' ? 'Dans les 72 h, au plus tard avant J7. Tu ouvres l\'agenda et vous choisissez la date ensemble, pendant l\'appel. Un client qui raccroche sans date, c\'est un démarrage qui glisse d\'une semaine.' : 'Le RDV Urgent 72h se cale avant de raccrocher, ensemble.') + '</div>';
    if (b) {
      h += '<div class="cp-box g">✅ <b>Calé le ' + esc((b.date || '').split('-').reverse().join('/')) + ' à ' + esc(b.time || '') + '</b>' + (b.personName ? ' avec ' + esc(b.personName) : '') + '</div>';
      return h;
    }
    if (!t) h += '<div class="cp-box y">Type de RDV « ' + lab + ' » introuvable : choisis-le dans la page de réservation.</div>';
    h += '<div style="margin-top:6px"><button class="cp-btn pri big" data-cp="mod" data-m="book">📅 Caler le RDV avec le client</button></div>';
    h += '<label class="cp-chk' + (cp.rdvClient ? ' on' : '') + '" style="margin-top:14px"><input type="checkbox" data-cp-chk="rdvClient"' + (cp.rdvClient ? ' checked' : '') + '><span><b>Pas de créneau qui lui convient maintenant</b> — le client choisira lui-même. Envoie-lui le lien ci-dessous.</span></label>';
    if (cp.rdvClient) {
      var link = H.bookingLink(t, l);
      h += '<div class="cp-msg">' + esc(link) + '</div><div style="margin-top:6px"><button class="cp-btn" data-cp="copy" data-txt="' + esc(link) + '">📋 Copier le lien</button></div>';
      h += '<div class="cp-box y">À relancer : sans date, la checklist le signalera.</div>';
    }
    return h;
  }

  function waMessages(leadId, l, cp) {
    var d = deal(cp), b = rdvBooking(leadId, d ? d.offre : 'Elite');
    var coach = (cp.coach && cp.coach.nom) || (l.coachAssigne && l.coachAssigne.nom) || '[Prénom Coach]';
    var avec = b && b.personName ? (/emily/i.test(b.personName) ? 'Emily' : (/adrien/i.test(b.personName) ? 'Adrien' : b.personName)) : '[Adrien/Emily]';
    var date = b ? (b.date || '').split('-').reverse().join('/') : '[date]', heure = b ? (b.time || '[heure]') : '[heure]';
    var p = prenomOf(l.nom) || '[Prénom]';
    var clo = 'Bienvenue ' + p + ' 👋 Je te présente ton équipe Elite Phénix : ' + prenomOf(coach) + ', ton coach référent — Adrien et Emily, tes mentors — et Marine, qui veille au bon déroulement de ton accompagnement.\n\n'
      + 'Ce groupe est ton canal principal : tout se passe ici entre les séances.\n\n'
      + 'Ton RDV Plan d\'Action est calé le ' + date + ' à ' + heure + ' avec ' + avec + '. D\'ici là, une seule priorité : remplir le questionnaire de démarrage 👉 ' + LIENS.questionnaire + '\n\nÀ très vite !';
    var pin = '🔗 LES LIENS ESSENTIELS\n\nEspace de démarrage : ' + LIENS.espace + '\nQuestionnaire : ' + LIENS.questionnaire + '\nPlateforme de suivi : ' + LIENS.plateforme + '\nLe Cercle : ' + LIENS.cercle + '\nCoachings de groupe : liens sur l\'espace de démarrage';
    return { clo: clo, pin: pin, coach: coach, manque: !b };
  }
  function cardWa(leadId, l, cp) {
    var wa = cp.wa || {}, M = waMessages(leadId, l, cp), coachSlug = fold((cp.coach && cp.coach.slug) || (l.coachAssigne && l.coachAssigne.slug) || M.coach);
    var h = '<div class="cp-h">💬 Le groupe WhatsApp</div><div class="cp-sub">Juste après la signature — jamais avant. Ce groupe devient le canal principal du client pendant six mois.</div>';
    h += '<div class="cp-lb">1 · Crée le groupe « Elite Phénix — ' + esc(prenomOf(l.nom)) + ' »</div><table class="cp-tbl">'
      + '<tr><td>👤 ' + esc(l.nom || 'Client') + ' <small style="color:#8d93a8">client</small></td><td>' + esc(telFr(l.telephone)) + '</td></tr>'
      + '<tr><td>🎓 ' + esc(M.coach) + ' <small style="color:#8d93a8">coach référent</small></td><td>' + esc(COACH_TELS[coachSlug] || COACH_TELS[fold(prenomOf(M.coach))] || '—') + '</td></tr>';
    EQUIPE.forEach(function (m) { h += '<tr><td>' + esc(m.nom) + ' <small style="color:#8d93a8">' + esc(m.role) + '</small></td><td>' + esc(m.tel) + '</td></tr>'; });
    h += '</table>' + chk('wa.groupe', wa.groupe, 'Groupe créé avec tout le monde');
    h += '<div class="cp-lb">2 · Poste le message de bienvenue (WA-CLO-01)</div>';
    if (M.manque) h += '<div class="cp-box y" style="margin-top:0">Le RDV n\'est pas encore calé : complète [date] et [heure] avant de poster.</div>';
    h += '<div class="cp-msg">' + esc(M.clo) + '</div><div style="margin-top:6px"><button class="cp-btn" data-cp="copy" data-txt="' + esc(M.clo) + '">📋 Copier</button></div>' + chk('wa.bienvenue', wa.bienvenue, 'Message de bienvenue posté');
    h += '<div class="cp-lb">3 · Poste puis épingle les liens (WA-PIN-01)</div><div class="cp-msg">' + esc(M.pin) + '</div><div style="margin-top:6px"><button class="cp-btn" data-cp="copy" data-txt="' + esc(M.pin) + '">📋 Copier</button></div>' + chk('wa.liens', wa.liens, 'Liens postés et épinglés en haut du groupe');
    h += '<div class="cp-lb">4 · L\'espace de démarrage</div><div class="cp-sub" style="margin:0">Envoie-le pendant l\'appel pour qu\'il l\'ouvre avec toi. Une seule consigne d\'ici le RDV : remplir le questionnaire, le plus précisément possible.</div>'
      + '<div class="cp-msg">' + esc(LIENS.espace) + '</div><div style="margin-top:6px"><button class="cp-btn" data-cp="copy" data-txt="' + esc(LIENS.espace) + '">📋 Copier</button></div>' + chk('wa.espace', wa.espace, 'Lien de l\'espace de démarrage envoyé et consigne donnée');
    return h;
  }
  function chk(key, on, label) { return '<label class="cp-chk' + (on ? ' on' : '') + '"><input type="checkbox" data-cp-chk="' + key + '"' + (on ? ' checked' : '') + '><span>' + label + '</span></label>'; }

  function checklist(leadId, l, cp, d) {
    var sig = lastSig(leadId), p = lastPay(leadId), elite = !d || d.offre === 'Elite';
    var coach = (cp.coach && cp.coach.nom) || (l.coachAssigne && l.coachAssigne.nom) || '';
    var b = rdvBooking(leadId, d ? d.offre : 'Elite'), wa = cp.wa || {}, out = [];
    function it(ok, label, detail, soft) { out.push({ ok: ok ? 'ok' : (soft ? 'wa' : 'ko'), label: label, detail: detail || '' }); }
    it(!!d, 'Deal renseigné', d ? d.label + ' · ' + (d.paiement === 'pif' ? 'en une fois' : d.n + ' fois') : '');
    it(sig && sig.status === 'signed', 'Contrat signé', sig ? '« ' + (sig.templateName || '') + ' »' : 'pas encore envoyé');
    it(!!p, 'Paiement GoCardless créé', p ? euro(p.totalAmount) + ' TTC' : '');
    var mand = p && /mandate_active|active|completed/.test(p.status || '');
    it(mand, 'Mandat SEPA actif', mand ? '' : (cp.payLater ? 'le client finit son IBAN plus tard — à relancer' : ''), cp.payLater);
    var trig = p && (p.status === 'active' || p.status === 'completed');
    it(trig, 'Premier prélèvement déclenché', '', cp.payLater);
    it(!!(cp.closeAt || l.isClient === true), 'Close enregistré (fiche + commissions)', '');
    if (elite) it(!!coach, 'Coach référent attribué et prévenu', coach);
    it(!!(b || cp.rdvClient), rdvLabel(d ? d.offre : 'Elite') + ' calé', b ? (b.date || '').split('-').reverse().join('/') + ' à ' + (b.time || '') : (cp.rdvClient ? 'le client choisit lui-même — à relancer' : ''), !b && cp.rdvClient);
    if (elite) {
      it(!!wa.groupe, 'Groupe WhatsApp créé', '');
      it(!!wa.bienvenue, 'Message de bienvenue posté', '');
      it(!!wa.liens, 'Liens épinglés', '');
      it(!!wa.espace, 'Espace de démarrage envoyé', '');
    }
    return out;
  }
  function cardCheck(leadId, l, cp, d) {
    var list = checklist(leadId, l, cp, d), ko = list.filter(function (x) { return x.ok === 'ko'; }).length, warn = list.filter(function (x) { return x.ok === 'wa'; }).length;
    var h = '<div class="cp-h">✅ La checklist</div><div class="cp-sub">Tout est vérifié depuis les vraies données. Un point rouge ? Clique sur l\'étape en haut pour le reprendre.</div>';
    list.forEach(function (x) { h += '<div class="cp-li ' + x.ok + '"><span class="m">' + (x.ok === 'ok' ? '✓' : (x.ok === 'wa' ? '!' : '✕')) + '</span><div>' + esc(x.label) + (x.detail ? '<small>' + esc(x.detail) + '</small>' : '') + '</div></div>'; });
    if (cp.doneAt) h += '<div class="cp-box g">🎉 Closing validé le ' + frDate(cp.doneAt) + '.</div>';
    else {
      if (warn && !ko) h += '<div class="cp-box y">' + warn + ' point(s) à relancer : tu peux valider, mais n\'oublie pas de les suivre.</div>';
      h += '<div style="margin-top:14px"><button class="cp-btn ok big" data-cp="finish"' + (ko ? ' disabled' : '') + '>🏁 Valider le closing</button>' + (ko ? '<div class="cp-sub" style="margin-top:6px">Encore ' + ko + ' point(s) en rouge.</div>' : '') + '</div>';
    }
    return h;
  }

  function annonce(leadId, l, cp, d) {
    var sig = lastSig(leadId), p = lastPay(leadId);
    var dateEnc = p && p.type === 'installments' && p.startDate ? frDate(p.startDate + 'T12:00:00', true) : frDate(null, true);
    var setter = H.setterName(l);
    return 'Nouvelle vente ! 💰\n'
      + 'Client : ' + (l.nom || '') + '\n'
      + 'E mail: ' + (l.email || '') + '\n'
      + 'Tel : ' + telFr(l.telephone) + '\n'
      + 'Deal (offre & modalité) :   ' + (d ? d.label + (d.paiement === 'pif' ? ' en paiement intégral' : ' en ' + d.n + ' fois') : '') + '\n'
      + 'Date d’encaissement : ' + dateEnc + '\n'
      + 'Contrat (signé et rétractation ok) : ' + (sig && sig.status === 'signed' ? 'Oui' : 'Non') + '\n'
      + 'Origine du Lead: ' + (H.origin(l) || '—') + '\n\n'
      + 'Setting SB/NB : ' + (d && d.booking === 'sb' ? 'SB' : 'NB' + (setter ? ' ' + setter : '')) + '\n'
      + 'Moyen de paiement : prélèvement\n'
      + 'CA Contracté : ' + (d ? Math.round(d.ttc) : '') + ' TTC\n'
      + 'Total collecté aujourd\'hui : ' + (d ? Math.round(d.encaisse) : '') + ' HT';
  }
  function cardBravo(leadId, l, cp, d) {
    var me = (H.me() || {}).nom || '', txt = annonce(leadId, l, cp, d), url = (H.cfg() || {}).closingGroupUrl || '';
    var h = '<div class="cp-win"><div class="big">🏆</div><h2>Bravo' + (me ? ' ' + esc(prenomOf(me)) : '') + ', t\'es un winner !</h2>'
      + '<div class="cp-sub" style="margin:0">' + esc(l.nom || 'Ton client') + ' est client' + (d ? ' ' + esc(d.label) : '') + '. Contrat, paiement, RDV, groupe : tout est en place.</div></div>';
    h += '<div class="cp-box g" style="text-align:center;font-weight:800">📣 Va vite l\'annoncer dans le canal WhatsApp closing !</div>';
    h += '<div class="cp-msg">' + esc(txt) + '</div><div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="cp-btn pri big" data-cp="copy" data-txt="' + esc(txt) + '">📋 Copier l\'annonce</button>'
      + (url ? '<a class="cp-btn ok big" href="' + esc(url) + '" target="_blank" rel="noopener">💬 Ouvrir le canal closing</a>' : '') + '</div>';
    return h;
  }

  function confetti() {
    var colors = ['#34d399', '#fbbf24', '#5b7cfa', '#f472b6', '#a78bfa'];
    for (var i = 0; i < 70; i++) {
      (function (i) {
        var c = document.createElement('div'); c.className = 'cp-confetti';
        c.style.left = Math.random() * 100 + 'vw'; c.style.background = colors[i % colors.length];
        c.style.animationDelay = (Math.random() * 0.8) + 's'; c.style.animationDuration = (2 + Math.random() * 1.5) + 's';
        document.body.appendChild(c); setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 4200);
      })(i);
    }
  }

  /* ═══ Actions ══════════════════════════════════════════════════════ */
  function moduleParams(kind, leadId) {
    var l = H.lead(leadId) || {}, cp = cpOf(leadId), d = deal(cp);
    if (kind === 'sig') return { sn: l.nom || '', se: l.email || '', sp: l.telephone || '', formule: d ? d.paiement : '', nmens: d && d.n > 1 ? d.n : '' };
    if (kind === 'pay') return d ? { montant: d.ttc, ptype: d.paiement === 'pif' ? 'full' : 'installments', nmens: d.n > 1 ? d.n : '', desc: 'Programme ' + d.label } : {};
    var parts = String(l.nom || '').trim().split(/\s+/);
    return { type: rdvType(d ? d.offre : 'Elite'), prenom: parts[0] || '', nom: parts.slice(1).join(' '), email: l.email || '', tel: l.telephone || '' };
  }
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-cp],[data-cp-chk]') : null;
    if (!t || !ui.leadId) return;
    if (t.hasAttribute('data-cp-chk')) return; /* géré par onInput (change) */
    var a = t.getAttribute('data-cp'), leadId = ui.leadId, list = steps(leadId), keys = list.map(function (s) { return s.k; }), idx = keys.indexOf(ui.step);
    if (a === 'close') { closeModal(); return; }
    if (a === 'goto') { ui.step = t.getAttribute('data-k'); render(); return; }
    if (a === 'prev') { ui.step = keys[Math.max(0, idx - 1)]; render(); return; }
    if (a === 'next') { ui.step = keys[Math.min(keys.length - 1, idx + 1)]; render(); return; }
    if (a === 'copy') { copyText(t.getAttribute('data-txt') || ''); return; }
    if (a === 'mod') {
      var mk = t.getAttribute('data-m'), ms = MOD_STEP[mk] || null;
      ui.modStep = ms; ui.modWasDone = ms ? stepDone(leadId, ms) : true;
      hideNotice();
      H.openModule(mk, leadId, moduleParams(mk, leadId)); return;
    }
    if (a === 'set') {
      var f = t.getAttribute('data-f'), v = t.getAttribute('data-v'), c = cpOf(leadId).choix || {}, patch = {};
      patch[f] = f === 'nmens' ? Number(v) : v;
      if (f === 'offre' && c.offre !== v) { patch.paiement = ''; patch.nmens = ''; patch.encaisse = ''; }
      if (f === 'paiement' || f === 'nmens') patch.encaisse = '';
      if (f === 'paiement' && v === 'pif') patch.nmens = '';
      if (f === 'offre' && !c.booking) { var sg = H.sbSuggest(H.lead(leadId) || {}); if (sg !== null && sg !== undefined) patch.booking = sg ? 'sb' : 'nb'; }
      save(leadId, { choix: patch }); render(); return;
    }
    if (a === 'payLater') { save(leadId, { payLater: !cpOf(leadId).payLater }); render(); return; }
    if (a === 'coach') { ui.coachSlug = t.getAttribute('data-s'); ui.coachNom = t.getAttribute('data-n'); render(); return; }
    if (a === 'record') { record(leadId); return; }
    if (a === 'finish') {
      var me = H.me() || {};
      save(leadId, { doneAt: Date.now(), byName: me.nom || '' }).then(function () { ui.step = 'bravo'; render(); confetti(); });
      return;
    }
  }
  function onInput(e) {
    var t = e.target;
    if (!ui.leadId) return;
    if (t.getAttribute && t.getAttribute('data-cp-in') === 'encaisse') {
      var v = parseFloat(t.value);
      ui.local[ui.leadId] = ui.local[ui.leadId] || {};
      clearTimeout(ui.encT); var leadId = ui.leadId;
      ui.encT = setTimeout(function () { save(leadId, { choix: { encaisse: isNaN(v) ? '' : v } }); render(); }, 600);
      return;
    }
    if (e.type === 'change' && t.getAttribute && t.getAttribute('data-cp-chk')) {
      var key = t.getAttribute('data-cp-chk'), patch = {};
      if (key.indexOf('wa.') === 0) { patch.wa = {}; patch.wa[key.slice(3)] = !!t.checked; }
      else patch[key] = !!t.checked;
      save(ui.leadId, patch); render();
    }
  }
  function record(leadId) {
    if (ui.busy) return;
    var l = H.lead(leadId) || {}, cp = cpOf(leadId), d = deal(cp);
    if (!d) return;
    var elite = d.offre === 'Elite';
    var coachSlug = ui.coachSlug || (cp.coach && cp.coach.slug) || '', coachNom = ui.coachNom || (cp.coach && cp.coach.nom) || '';
    var already = !!(cp.closeAt || l.isClient === true || String(l.stage || '').indexOf('closed_won') === 0);
    ui.busy = true; render();
    var answers = { contrat: d.offre, paiement: d.paiement, booking: d.booking, encaisse: d.encaisse, coachSlug: elite ? coachSlug : null, coachNom: elite ? coachNom : null };
    Promise.resolve(already && !elite ? null : H.recordClose(leadId, answers, { coachOnly: already })).then(function () {
      return save(leadId, { closeAt: cp.closeAt || Date.now(), coach: elite ? { slug: coachSlug, nom: coachNom } : null });
    }).then(function () {
      ui.busy = false; H.toast(already ? '🎓 Coach validé' : '🏆 Close enregistré !'); ui.step = 'rdv'; render();
    }).catch(function (e) { ui.busy = false; render(); H.toast('❌ ' + ((e && e.message) || 'Erreur d\'enregistrement')); });
  }

  /* ═══ API ══════════════════════════════════════════════════════════ */
  window.ClosePilot = {
    configure: function (host) { H = host; ensureStyles(); },
    /* Peint le bandeau dans le conteneur de la fiche. */
    paint: function (leadId, el) { if (!H || !el) return; ensureStyles(); el.innerHTML = stripHTML(leadId); },
    /* Gère les clics du bandeau (délégation de l'hôte). Retourne true si traité. */
    handle: function (el) {
      if (!H || !el || !el.getAttribute) return false;
      var a = el.getAttribute('data-cp'), leadId = el.getAttribute('data-cp-lead');
      if (!leadId) return false;
      if (a === 'start') {
        var me = H.me() || {};
        if (!cpOf(leadId).startedAt) save(leadId, { startedAt: Date.now(), byName: me.nom || '' });
        openModal(leadId); return true;
      }
      if (a === 'open') { openModal(leadId); return true; }
      return false;
    },
    open: openModal,
    /* Les données ont bougé (signature, paiement, RDV, fiche) : la carte
       ouverte se met à jour ; un contrat qui vient d'être signé fait avancer. */
    refresh: function (leadId) {
      if (!ui.leadId || (leadId && leadId !== ui.leadId)) return;
      var list = steps(ui.leadId), cur = null;
      list.forEach(function (s) { if (s.k === ui.step) cur = s; });
      var modOpen = !!(H.moduleOpen && H.moduleOpen());
      if (ui.modStep && !ui.modWasDone && modOpen && stepDone(ui.leadId, ui.modStep)) {
        /* L'étape vient de se valider dans le module ouvert. */
        ui.modWasDone = true;
        ui['auto_' + ui.modStep] = true;
        showNotice(ui.modStep);
      } else if (cur && cur.done && (ui.step === 'contrat' || ui.step === 'paiement') && !ui['auto_' + ui.step]) {
        ui['auto_' + ui.step] = true;
        H.toast(ui.step === 'contrat' ? '✅ Contrat signé !' : '✅ Paiement en place !');
      }
      render();
    },
    isOpen: function () { return !!ui.leadId; },
    steps: steps, annonce: function (leadId) { var l = H.lead(leadId) || {}, cp = cpOf(leadId); return annonce(leadId, l, cp, deal(cp)); }
  };
})();
