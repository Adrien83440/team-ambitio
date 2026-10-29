/* ═══════════════════════════════════════════════════════════════════════════
   leads-live-etapes.js — Leads Live sur les ÉTAPES du Pipeline (29/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Mode « étapes » (CRMV2) : Leads Live et le nouveau Pipeline classent les
   leads avec la MÊME règle (pipeline-etapes.js). Un lead déplacé d'un côté
   est au bon endroit de l'autre.

   Ce que le mode change dans Leads Live (vue classique comme nouvelle vue) :
     - un filtre unique : une liste déroulante des colonnes du Pipeline et de
       leurs sous-filtres, avec compteurs. Les onglets (Arrivées, À traiter…),
       la barre de période et les filtres Période / Tunnel / Statut
       disparaissent. Restent la recherche et « Qui s'en occupe ».
     - « Messagerie » fait passer au NRP suivant ;
     - après « Décroché », on demande toujours la suite (RDV, FU,
       Disqualifié, Poubelle) ;
     - « Appelé » n'est plus proposé ;
     - programmer un rappel sur un lead Lead / NRP le passe en FU.
   Hors mode, rien ne change.

   Interrupteur : ACTIF POUR TOUT LE MONDE depuis le 29/10/2026 (demande
   d'Adrien). Repli : ?v2=0 sur un appareil (mémorisé dans localStorage
   crm_v2_force, ?v2=1 pour revenir) ; coupure générale pour les admins :
   _config/crm_v2 { enabled: false } (doc lisible des seuls admins — pour
   toute l'équipe, revenir en arrière par le code).

   Crochets posés dans sales-leads.html (tous tolèrent l'absence de ce
   fichier) : getBaseLeads, getFilteredLeads, l2FiltersActiveCount,
   l2RenderTriage, renderFeed, ldApplyStatus, addFu, listes de statuts.
   Dans leads-live-v3.js : rendreFile, grilleStatuts.

   API : window.LLEtapes
     on() · etape() · setEtape(cle) · bookingsOf(lead) · classify(lead)
     filter(liste) · wantsClients() · selectHTML(classe) · nextNrp(lead)
     hideStatus(cle) · askNext(leadId)
   ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var FORCE_KEY = 'crm_v2_force';
  var ETAPE_KEY = 'll_etape_v1';
  var on = false, cfg = null, cle = '';

  (function lireUrl() {
    try {
      var v = new URLSearchParams(window.location.search).get('v2');
      if (v === '1' || v === '0') localStorage.setItem(FORCE_KEY, v);
    } catch (e) { /* stockage indisponible : on s'en tient à _config */ }
  })();
  try { cle = localStorage.getItem(ETAPE_KEY) || ''; } catch (e) { cle = ''; }

  function PE() { return window.PipelineEtapes || null; }
  function forcage() { try { return localStorage.getItem(FORCE_KEY); } catch (e) { return null; } }
  function eligibleCfg() {
    if (!cfg) return false;
    if (cfg.enabled === true) return true;
    var me = window.myIdentitySlug || null, t = cfg.testeurs || [];
    return !!(me && t.indexOf && t.indexOf(me) >= 0);
  }
  function peutActiver() {
    if (on || !PE()) return;
    var f = forcage();
    if (f === '0') return;
    if (cfg && cfg.enabled === false && f !== '1') return;
    activer();
  }
  function lireCfg() {
    try {
      firebase.auth().onAuthStateChanged(function (u) {
        if (!u || cfg) return;
        firebase.firestore().collection('_config').doc('crm_v2').get().then(function (s) {
          cfg = s.exists ? (s.data() || {}) : {};
          peutActiver();
          /* myIdentitySlug arrive avec le roster : on réessaie un peu plus tard */
          setTimeout(peutActiver, 2500);
          setTimeout(peutActiver, 8000);
        }).catch(function () { cfg = {}; peutActiver(); });   /* sales : doc illisible → actif */
      });
    } catch (e) { /* Firebase indisponible : mode historique */ }
  }

  function activer() {
    if (on) return;
    on = true;
    document.body.classList.add('crmv2');
    injecterStyle();
    /* Les anciens filtres n'existent plus dans ce mode : on les neutralise */
    try {
      if (typeof filterPeriod !== 'undefined') { window.filterPeriod = 'all'; window.customDateFrom = null; window.customDateTo = null; }
      if (typeof filterType !== 'undefined') window.filterType = 'all';
      if (typeof filterStatus !== 'undefined') window.filterStatus = 'all';
    } catch (e) {}
    if (cle && !valide(cle)) cle = '';
    if (typeof window.renderFeed === 'function' && typeof allLeads !== 'undefined' && allLeads && allLeads.length) window.renderFeed();
  }
  function valide(k) {
    var o = PE() ? PE().options() : [];
    for (var i = 0; i < o.length; i++) if (o[i].key === k) return true;
    return false;
  }

  /* ── Données ── */
  function bookingsOf(l) {
    if (!l) return [];
    var seen = {}, out = [];
    function add(arr) { (arr || []).forEach(function (b) { if (!b) return; var k = b.id || JSON.stringify([b.date, b.time]); if (seen[k]) return; seen[k] = 1; out.push(b); }); }
    try { if (typeof _sbnbByLead !== 'undefined' && _sbnbByLead) add(_sbnbByLead[l.id]); } catch (e) {}
    try { if (typeof _ldRdvCache !== 'undefined' && _ldRdvCache) add(_ldRdvCache[l.id]); } catch (e) {}
    return out;
  }
  function typeMap() { try { return (typeof _ldTypeMap !== 'undefined' && _ldTypeMap) ? _ldTypeMap : {}; } catch (e) { return {}; } }
  function classify(l) { return PE().classify(l, bookingsOf(l), { typeMap: typeMap() }); }
  function matchCle(l, k) {
    if (!k) return true;
    var r = classify(l);
    return k.indexOf(':') > -1 ? r.key === k : r.col === k;
  }
  function filter(list) {
    if (!on || !cle || !PE()) return list;
    return list.filter(function (l) { return matchCle(l, cle); });
  }
  function wantsClients() { return on && /^closing/.test(cle); }

  /* Base des compteurs : même périmètre que la file (30 jours, membre), plus
     les clients signés pour la colonne Closing. */
  function baseCompteurs() {
    var base = [];
    try { base = getBaseLeads(); } catch (e) { base = []; }
    var vus = {};
    base.forEach(function (l) { vus[l.id] = 1; });
    if (!wantsClients() && typeof allLeads !== 'undefined' && typeof isCoachingOrClientLead === 'function') {
      var cutoff = Date.now() - 30 * 864e5;
      allLeads.forEach(function (l) {
        if (vus[l.id] || l.source === 'migration_suivi_client' || !isCoachingOrClientLead(l)) return;
        var d = typeof _getLeadEffectiveDate === 'function' ? _getLeadEffectiveDate(l) : null;
        if (!d || d.getTime() <= cutoff) return;
        if (classify(l).col === 'closing') base.push(l);
      });
    } else if (wantsClients()) {
      base = base.filter(function (l) { return !(typeof isCoachingOrClientLead === 'function' && isCoachingOrClientLead(l)) || classify(l).col === 'closing'; });
    }
    var fm = typeof filterMember !== 'undefined' ? filterMember : 'all';
    if (fm !== 'all') base = base.filter(function (l) { return l.assignedTo === fm; });
    return base;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function selectHTML(cls) {
    if (!PE()) return '';
    var base = baseCompteurs(), n = PE().count(base, bookingsOf, { typeMap: typeMap() }), tot = 0;
    /* « Toutes » = ce que la file montre sans étape : clients signés exclus, comme avant */
    base.forEach(function (l) { if (!(typeof isCoachingOrClientLead === 'function' && isCoachingOrClientLead(l))) tot++; });
    var h = '<label class="lletape' + (cls ? ' ' + cls : '') + (cle ? ' on' : '') + '"><span>Étape</span><select id="llEtapeSel" aria-label="Étape du pipeline">' +
      '<option value=""' + (cle ? '' : ' selected') + '>Toutes les étapes (' + tot + ')</option>';
    PE().options().forEach(function (o) {
      var c = n[o.key] || 0;
      if (o.sub && !c && o.key !== cle) return;
      h += '<option value="' + esc(o.key) + '"' + (o.key === cle ? ' selected' : '') + '>' + (o.sub ? '   ↳ ' : '') + esc(o.label) + ' (' + c + ')</option>';
    });
    return h + '</select></label>';
  }
  function setEtape(k) {
    cle = k || '';
    try { localStorage.setItem(ETAPE_KEY, cle); } catch (e) {}
    if (typeof window.renderFeed === 'function') window.renderFeed();
  }

  /* ── Statuts ── */
  function nextNrp(l) {
    /* Fiche encore « lead » déjà appelée : d'après le nombre d'essais (pipeline-etapes.js) */
    var nx = (l && PE()) ? PE().nrpApresAppel(l) : null;
    return nx || 'nrp1';
  }
  function hideStatus(k) { return on && k === 'appele'; }
  /* Pastille / ligne de carte : en mode étapes, on affiche l'ÉTAPE (même mot
     que la colonne du Pipeline) au lieu de l'ancien statut. Même forme que
     getStatusObj : { key, label, icon, color, bg }. null hors mode. */
  var COUL = { ancien: '#9096ad', lead: '#34d399', nrp1: '#f59e0b', nrp2: '#e67e22', nrp3: '#ef4444', all_nrp: '#6b7280', poubelle: '#64748b', disqua: '#6b7280', fu: '#60a5fa', set: '#a78bfa', sb: '#fbbf24', perdu: '#ef4444', closing: '#fbbf24' };
  function statusView(l) {
    if (!on || !l || !PE()) return null;
    var r = classify(l), c = COUL[r.col] || '#6b7280';
    var lab = (r.col === 'perdu' || r.col === 'poubelle' || r.col === 'disqua' || r.col === 'closing' || r.col === 'ancien') ? PE().label(r.key) : PE().colOf(r.col).t;
    return { key: r.key, label: lab, icon: '', color: c, bg: c + '22' };
  }

  /* Après « Décroché » : la suite est obligatoire, aucun lead ne reste en l'air */
  function askNext(leadId) {
    fermerNext();
    var l = null;
    if (typeof allLeads !== 'undefined') for (var i = 0; i < allLeads.length; i++) if (allLeads[i].id === leadId) { l = allLeads[i]; break; }
    var bg = document.createElement('div');
    bg.className = 'llnext-bg'; bg.id = 'llNextBg';
    bg.innerHTML = '<div class="llnext-box" role="dialog" aria-modal="true" aria-labelledby="llNextT">' +
      '<div class="llnext-t" id="llNextT">Et ensuite ?</div>' +
      '<div class="llnext-s">' + esc((l && l.nom) || 'Ce lead') + ' a décroché. Où le ranger ?</div>' +
      '<button type="button" data-llnext="rdv">🎯 <b>Poser un RDV</b><span>Il passe en SET NB</span></button>' +
      '<button type="button" data-llnext="follow_up_pm">🔔 <b>À rappeler</b><span>Il passe en FU, programme le rappel</span></button>' +
      '<button type="button" data-llnext="disqualifie">🚫 <b>Disqualifié</b><span>Hors cible</span></button>' +
      '<button type="button" data-llnext="poubelle">🗑️ <b>Poubelle</b><span>Ne veut plus être contacté</span></button>' +
      '<button type="button" class="llnext-later" data-llnext="later">Plus tard</button></div>';
    bg.addEventListener('click', function (e) {
      if (e.target === bg) { fermerNext(); return; }
      var b = e.target.closest ? e.target.closest('[data-llnext]') : null;
      if (!b) return;
      var k = b.getAttribute('data-llnext');
      fermerNext();
      if (k === 'later') return;
      if (k === 'rdv') { if (l && typeof openBookingModal === 'function') openBookingModal(l); return; }
      if (typeof ldApplyStatus === 'function') ldApplyStatus(leadId, k, null);
      if (k === 'follow_up_pm') ouvrirRappel(leadId);
    });
    document.body.appendChild(bg);
    var first = bg.querySelector('[data-llnext]');
    if (first) try { first.focus(); } catch (e) {}
  }
  function fermerNext() { var o = document.getElementById('llNextBg'); if (o && o.parentNode) o.parentNode.removeChild(o); }
  /* Ouvre la fiche et amène la saisie du rappel à l'écran (au mieux) */
  function ouvrirRappel(id) {
    try { if (typeof l2OpenLead === 'function') l2OpenLead(id); } catch (e) {}
    setTimeout(function () {
      var f = document.querySelector('[data-fu-field="date"][data-id="' + id + '"]');
      if (f) { try { f.scrollIntoView({ block: 'center' }); f.focus(); } catch (e) {} }
      else if (typeof toast === 'function') toast('🔔 Programme le rappel dans la fiche');
    }, 350);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById('llNextBg')) { e.stopPropagation(); fermerNext(); } }, true);
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'llEtapeSel') setEtape(e.target.value); });

  /* ── Style (inerte hors mode) ── */
  function injecterStyle() {
    if (document.getElementById('llEtapesCss')) return;
    var css =
      'body.crmv2 #l2PeriodBar,body.crmv2 #l2fsLPeriode,body.crmv2 #ldPeriodFilters,body.crmv2 #l2fsLTunnel,body.crmv2 #ldTypeFilters,body.crmv2 #l2fsLStatut,body.crmv2 #ldFilters{display:none!important}' +
      'body.crmv2 .l2tri-row{display:block}' +
      '.lletape{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 6px 6px 12px;border:1.5px solid var(--border,rgba(148,163,214,.2));border-radius:13px;background:var(--bg2,#0e111c);color:var(--text,#eef0f8);font-weight:700;font-size:13px}' +
      '.lletape.on{border-color:rgba(239,68,68,.55)}' +
      '.lletape>span{flex:none;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8f97b2)}' +
      '.lletape select{flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;font-size:15px;padding:6px 4px;cursor:pointer;outline:none}' +
      '.lletape select option{color:#0f1222;background:#fff}' +
      'html body.ll5 .lletape.ll5etape{margin:22px 0 10px;border:0;border-radius:16px;padding:6px 8px 6px 14px;background:var(--l5-card2);color:var(--l5-text)}' +
      'html body.ll5 .lletape.ll5etape.on{box-shadow:inset 0 0 0 1.5px var(--l5-sel)}' +
      'html body.ll5 .lletape.ll5etape>span{color:var(--l5-muted)}' +
      '.llnext-bg{position:fixed;inset:0;z-index:10050;background:rgba(5,6,12,.55);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.llnext-box{width:100%;max-width:380px;background:#141826;color:#eef0f8;border-radius:18px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.45);font-family:inherit}' +
      'body.light-theme .llnext-box{background:#fff;color:#0f1222}' +
      '.llnext-t{font-size:19px;font-weight:800}' +
      '.llnext-s{font-size:13px;opacity:.75;margin:4px 0 14px}' +
      '.llnext-box button{display:block;width:100%;text-align:left;margin-top:8px;padding:12px 14px;border-radius:12px;border:1.5px solid rgba(148,163,214,.22);background:transparent;color:inherit;font:inherit;font-size:15px;cursor:pointer}' +
      '.llnext-box button:hover,.llnext-box button:focus{border-color:#5b7cfa;outline:none}' +
      '.llnext-box button span{display:block;font-size:12px;opacity:.7;margin:2px 0 0 26px}' +
      '.llnext-box .llnext-later{text-align:center;border:0;opacity:.7;font-size:14px}';
    var st = document.createElement('style');
    st.id = 'llEtapesCss'; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  window.LLEtapes = {
    on: function () { return on; },
    etape: function () { return on ? cle : ''; },
    setEtape: setEtape, bookingsOf: bookingsOf,
    classify: function (l) { return PE() ? classify(l) : null; },
    filter: filter, wantsClients: wantsClients, selectHTML: selectHTML,
    nextNrp: nextNrp, hideStatus: hideStatus, askNext: askNext,
    label: function (k) { return PE() ? PE().label(k) : k; },
    statusView: statusView
  };

  function demarrer() {
    if (forcage() === '1') peutActiver();
    lireCfg();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
  else setTimeout(demarrer, 0);
})();
