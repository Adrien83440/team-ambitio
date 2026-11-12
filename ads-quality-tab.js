/* ============================================================================
   ads-quality-tab.js — « 🎯 QUALITÉ PAR PUB » (12/11/2026, brief « Outil 2 »)
   ----------------------------------------------------------------------------
   Rendu PARTAGÉ, aucune dépendance Firebase dans la partie tableau :
     · sales-funnel.html (admin) — données = K.utmRowsByAxis de funnel-core.js,
       plus deux encarts admin : lien de partage média buyeuse et
       « 📡 Événements renvoyés à Meta » (API Conversions) ;
     · ads-quality.html (média buyeuse, lecture seule) — données =
       api/ads-quality-share.js (mêmes lignes, liste blanche de champs).
   Les chiffres viennent TOUS de funnel-core.js (source unique) : ce fichier
   ne calcule que des sommes de colonnes et des pourcentages d'affichage.

   Colonnes (une ligne par pub, bascule ensemble / campagne) :
     ★ coût par lead qualifié · ★ coût par RDV honoré · ★ coût par vente
     (en tête, juste après le nom) · dépense · leads · coût par lead · qualifiés (CA déclaré ≥ 20 k€/mois,
     % sur les leads qui ont déclaré un CA) · faux numéros · disqualifiés ·
     jamais joints (% sur les leads entrés depuis > 48 h) · RDV posés ·
     honorés · annulés · no-show · ventes · contracté · encaissé.
   Tri par défaut : coût par RDV honoré, croissant (les « — » en bas). Pubs
   à moins de 10 leads : repère ⚠ (échantillon trop faible pour conclure).
   Les trois coûts sont masqués si la dépense Meta ne couvre pas la période
   (plus d'un jour manquant) — un coût trop beau fait monter un budget.

   API :
     AdsQualityTab.render(el, data, opts)
       data = { rowsByAxis: { creative, adset, campaign }, coverage: {…},
                periodLabel }
       opts = { admin: bool, adminCtx: { db, user, toast } }
     AdsQualityTab.fromKpis(K, periodLabel) → data
   ES5 strict (Safari ancien). Délégation d'événements, aucun onclick inline.
   ============================================================================ */
(function (root) {
  'use strict';

  var AXES = [
    { id: 'creative', label: 'Pub', name: 'Pub' },
    { id: 'adset', label: 'Ensemble', name: 'Ensemble de pubs' },
    { id: 'campaign', label: 'Campagne', name: 'Campagne' }
  ];
  var SMALL = 10;

  var state = { axis: 'creative', sort: 'cph', dir: 1, showOut: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function eur(v, dec) {
    if (v == null || !isFinite(v)) return '—';
    var d = dec == null ? 0 : dec;
    try { return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ /g, ' ') + ' €'; }
    catch (e) { return Math.round(v) + ' €'; }
  }
  function pct(n, base) { return base > 0 ? Math.round(n / base * 100) + ' %' : '—'; }
  function nPct(n, base) {
    if (!n) return '<span class="aq-z">0</span>';
    return '<b>' + n + '</b> <span class="aq-p">' + pct(n, base) + '</span>';
  }

  /* ── Colonnes ─────────────────────────────────────────────────────────── */
  var COLS = [
    { k: 'cpq', l: '€ / qualifié', t: 'Coût par lead qualifié (CA ≥ 20 k€/mois)', cost: true, star: true, v: function (r) { return r.cpq; }, f: function (r) { return eur(r.cpq); } },
    { k: 'cph', l: '€ / RDV honoré', t: 'Coût par RDV honoré — tri par défaut', cost: true, star: true, v: function (r) { return r.cph; }, f: function (r) { return eur(r.cph); } },
    { k: 'cpv', l: '€ / vente', t: 'Coût par vente', cost: true, star: true, v: function (r) { return r.cpv; }, f: function (r) { return eur(r.cpv); } },
    { k: 'spend', l: 'Dépense', t: 'Dépense Meta de la période (Make → ads_insights_ad)', v: function (r) { return r.hasSpend ? r.spend : null; }, f: function (r) { return r.hasSpend ? eur(r.spend) : '—'; } },
    { k: 'leads', l: 'Leads', t: 'Leads entrés sur la période', v: function (r) { return r.leads; }, f: function (r) { return '<b>' + r.leads + '</b>'; } },
    { k: 'cpl', l: '€ / lead', t: 'Coût par lead', cost: true, v: function (r) { return r.cpl; }, f: function (r) { return eur(r.cpl); } },
    { k: 'qualCa', l: 'Qualifiés', t: 'Chiffre d\'affaires déclaré au quiz ≥ 20 000 €/mois — part calculée sur les leads qui ont déclaré un CA', v: function (r) { return r.caKnown ? r.qualCa / r.caKnown : null; }, f: function (r) { return r.caKnown ? nPct(r.qualCa, r.caKnown) : '<span class="aq-z" title="aucun CA déclaré (VSL, formulaire)">n/a</span>'; } },
    { k: 'faux', l: 'Faux n°', t: 'Fiches en Faux numéro ou Poubelle (Pipeline) — part sur les leads', v: function (r) { return r.leads ? r.faux / r.leads : null; }, f: function (r) { return nPct(r.faux, r.leads); } },
    { k: 'disq', l: 'Disqualifiés', t: 'Disqualifiés au setting ou au closing — part sur les leads', v: function (r) { return r.leads ? r.disq / r.leads : null; }, f: function (r) { return nPct(r.disq, r.leads); } },
    { k: 'never', l: 'Jamais joints', t: 'Aucun appel décroché (répondeurs exclus) et aucun RDV — part sur les leads entrés depuis plus de 48 h, hors faux numéros, disqualifiés et clients', v: function (r) { return r.neverEligible ? r.neverReached / r.neverEligible : null; }, f: function (r) { return r.neverEligible ? nPct(r.neverReached, r.neverEligible) : '—'; } },
    { k: 'booked', l: 'RDV posés', t: 'RDV commerciaux pris sur la période (replanifications exclues)', v: function (r) { return r.booked; }, f: function (r) { return r.booked || '<span class="aq-z">0</span>'; } },
    { k: 'honored', l: 'Honorés', t: 'RDV ayant eu lieu sur la période avec une issue close, non close ou offre', v: function (r) { return r.honored; }, f: function (r) { return r.honored ? '<b>' + r.honored + '</b>' : '<span class="aq-z">0</span>'; } },
    { k: 'cancelled', l: 'Annulés', t: 'RDV de la période annulés', v: function (r) { return r.cancelled; }, f: function (r) { return r.cancelled || '<span class="aq-z">0</span>'; } },
    { k: 'noshow', l: 'No-show', t: 'RDV de la période non honorés par le prospect', v: function (r) { return r.noshow; }, f: function (r) { return r.noshow || '<span class="aq-z">0</span>'; } },
    { k: 'closes', l: 'Ventes', t: 'Clients gagnés sur la période (close annulé exclu)', v: function (r) { return r.closes; }, f: function (r) { return r.closes ? '<b>' + r.closes + '</b>' : '<span class="aq-z">0</span>'; } },
    { k: 'con', l: 'Contracté', t: 'Montant signé HT des ventes', v: function (r) { return r.con; }, f: function (r) { return r.con ? eur(r.con) : '—'; } },
    { k: 'col', l: 'Encaissé', t: 'Prélèvements réellement passés (HT)', v: function (r) { return r.col; }, f: function (r) { return r.col ? eur(r.col) : '—'; } }
  ];
  function colByKey(k) { for (var i = 0; i < COLS.length; i++) if (COLS[i].k === k) return COLS[i]; return null; }

  /* ── Données ──────────────────────────────────────────────────────────── */
  function fromKpis(K, periodLabel) {
    var by = (K && K.utmRowsByAxis) || {};
    return {
      rowsByAxis: { creative: by.creative || [], adset: by.adset || [], campaign: by.campaign || [] },
      coverage: {
        leads: K ? K.leads : 0, attributedLeads: K ? K.attributedLeads : 0, attributedPct: K ? K.attributedPct : null,
        hasAdLevelSpend: !!(K && K.hasAdLevelSpend), adLevelSpend: K ? K.adLevelSpend : 0,
        adSpendComplete: !!(K && K.adSpendComplete), adSpendDaysCovered: K ? K.adSpendDaysCovered : 0,
        adSpendDaysExpected: K ? K.adSpendDaysExpected : 0
      },
      periodLabel: periodLabel || ''
    };
  }
  /* Coûts affichables : dépense présente et au plus UN jour manquant (la
     dépense d'aujourd'hui n'arrive que demain matin — Make lit J-1). */
  function costsOk(cov) {
    if (!cov || !cov.hasAdLevelSpend) return false;
    var missing = (cov.adSpendDaysExpected || 0) - (cov.adSpendDaysCovered || 0);
    return missing <= 1;
  }
  function sortRows(rows) {
    var c = colByKey(state.sort) || colByKey('cph');
    var dir = state.dir;
    return rows.slice().sort(function (a, b) {
      if (!!a.outOfAds !== !!b.outOfAds) return a.outOfAds ? 1 : -1;
      var va = c.v(a), vb = c.v(b);
      var na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
      if (na !== nb) return na ? 1 : -1;                 // « — » toujours en bas
      if (!na && va !== vb) return (va - vb) * dir;
      return (b.leads - a.leads) || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    });
  }
  function totals(rows) {
    var t = { key: 'Total', leads: 0, caKnown: 0, qualCa: 0, faux: 0, disq: 0, neverReached: 0, neverEligible: 0,
      booked: 0, honored: 0, cancelled: 0, noshow: 0, closes: 0, con: 0, col: 0, spend: 0, hasSpend: false };
    rows.forEach(function (r) {
      ['leads', 'caKnown', 'qualCa', 'faux', 'disq', 'neverReached', 'neverEligible', 'booked', 'honored', 'cancelled', 'noshow', 'closes', 'con', 'col'].forEach(function (f) { t[f] += Number(r[f]) || 0; });
      if (r.hasSpend) { t.spend += Number(r.spend) || 0; t.hasSpend = true; }
    });
    t.cpl = t.hasSpend && t.leads ? t.spend / t.leads : null;
    t.cpq = t.hasSpend && t.qualCa ? t.spend / t.qualCa : null;
    t.cph = t.hasSpend && t.honored ? t.spend / t.honored : null;
    t.cpv = t.hasSpend && t.closes ? t.spend / t.closes : null;
    return t;
  }

  /* ── Styles (variables de thème des pages internes, repli sombre) ─────── */
  function injectCss() {
    if (document.getElementById('aqCss')) return;
    var st = document.createElement('style');
    st.id = 'aqCss';
    st.textContent = ''
      + '.aq-wrap{font-size:12.5px;color:var(--text,#e8eaf2)}'
      + '.aq-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}'
      + '.aq-title{font-size:15px;font-weight:800;letter-spacing:-.2px}'
      + '.aq-sub{color:var(--muted,#8f97b2);font-size:11.5px}'
      + '.aq-seg{display:flex;gap:3px;padding:3px;background:var(--bg3,#1a1d2b);border:1px solid var(--border,#2a2e40);border-radius:10px}'
      + '.aq-seg button{padding:5px 11px;border-radius:8px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--muted,#8f97b2);background:none;border:none}'
      + '.aq-seg button.on{background:var(--bg4,#23273a);color:var(--text,#e8eaf2)}'
      + '.aq-btn{padding:6px 11px;border-radius:9px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border,#2a2e40);background:var(--bg3,#1a1d2b);color:var(--text,#e8eaf2)}'
      + '.aq-btn:hover{background:var(--bg4,#23273a)}'
      + '.aq-btn.primary{color:var(--blue,#60a5fa);border-color:rgba(96,165,250,.35)}'
      + '.aq-btn.danger{color:var(--red3,#f87171)}'
      + '.aq-note{border:1px solid var(--border,#2a2e40);background:var(--bg2,#141724);border-radius:11px;padding:9px 13px;margin:0 0 10px;color:var(--muted,#8f97b2);line-height:1.55}'
      + '.aq-note.warn{border-color:rgba(245,158,11,.35);color:var(--gold,#f5b544)}'
      + '.aq-note b{color:var(--text,#e8eaf2)}'
      + '.aq-tw{overflow-x:auto;border:1px solid var(--border,#2a2e40);border-radius:14px;background:var(--bg2,#141724)}'
      + '.aq-t{width:100%;border-collapse:collapse;min-width:1500px}'
      + '.aq-t th{text-align:right;padding:9px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8f97b2);border-bottom:1px solid var(--border2,#353a52);white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg2,#141724)}'
      + '.aq-t th:first-child,.aq-t td:first-child{text-align:left;position:sticky;left:0;background:var(--bg2,#141724);z-index:1;min-width:230px;max-width:320px}'
      + '.aq-t th.star{color:var(--blue,#60a5fa)}'
      + '.aq-t th.sorted{color:var(--text,#e8eaf2)}'
      + '.aq-t td{padding:8px 10px;border-bottom:1px solid var(--border,#2a2e40);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}'
      + '.aq-t td.star{background:rgba(96,165,250,.07);font-weight:700}'
      + '.aq-t tr.small td{opacity:.62}'
      + '.aq-t tr.out td{opacity:.5}'
      + '.aq-t tr.tot td{font-weight:800;border-top:1px solid var(--border2,#353a52);border-bottom:none}'
      + '.aq-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.aq-tag{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:1px}'
      + '.aq-tag.small{color:var(--gold,#f5b544);background:rgba(245,158,11,.12)}'
      + '.aq-tag.leg{color:var(--muted,#8f97b2);background:rgba(143,151,178,.12)}'
      + '.aq-z{color:var(--muted2,#5d647e)}'
      + '.aq-p{color:var(--muted,#8f97b2);font-size:11px}'
      + '.aq-panel{margin-top:18px;border:1px solid var(--border,#2a2e40);border-radius:14px;background:var(--bg2,#141724);padding:14px 16px}'
      + '.aq-panel h4{margin:0 0 6px;font-size:13.5px}'
      + '.aq-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}'
      + '.aq-in{background:var(--bg3,#1a1d2b);border:1px solid var(--border,#2a2e40);border-radius:8px;color:var(--text,#e8eaf2);padding:6px 9px;font:inherit;font-size:12px;min-width:160px}'
      + '.aq-pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}'
      + '.aq-pill.ok{color:var(--green,#34d399);background:rgba(52,211,153,.12)}'
      + '.aq-pill.ko{color:var(--red3,#f87171);background:rgba(239,68,68,.12)}'
      + '.aq-pill.wait{color:var(--gold,#f5b544);background:rgba(245,158,11,.12)}'
      + '.aq-pill.off{color:var(--muted,#8f97b2);background:rgba(143,151,178,.12)}'
      + '.aq-jt{width:100%;border-collapse:collapse;min-width:900px;font-size:11.5px}'
      + '.aq-jt th{text-align:left;padding:6px 8px;color:var(--muted,#8f97b2);font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2,#353a52)}'
      + '.aq-jt td{padding:6px 8px;border-bottom:1px solid var(--border,#2a2e40);vertical-align:top}'
      + '.aq-link{word-break:break-all;font-family:var(--font-m,monospace);font-size:11px}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── Tableau ──────────────────────────────────────────────────────────── */
  function tableHtml(data) {
    var rowsAll = (data.rowsByAxis && data.rowsByAxis[state.axis]) || [];
    var ads = rowsAll.filter(function (r) { return !r.outOfAds; });
    var out = rowsAll.filter(function (r) { return r.outOfAds; });
    var rows = sortRows(state.showOut ? rowsAll : ads);
    var ok = costsOk(data.coverage);
    var axisName = AXES.filter(function (a) { return a.id === state.axis; })[0].name;

    var h = '<div class="aq-tw"><table class="aq-t"><thead><tr><th data-aq-sort="key">' + esc(axisName) + '</th>';
    COLS.forEach(function (c) {
      var cls = (c.star ? 'star ' : '') + (state.sort === c.k ? 'sorted' : '');
      var arrow = state.sort === c.k ? (state.dir > 0 ? ' ▲' : ' ▼') : '';
      h += '<th class="' + cls + '" data-aq-sort="' + c.k + '" title="' + esc(c.t) + '">' + (c.star ? '★ ' : '') + esc(c.l) + arrow + '</th>';
    });
    h += '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="' + (COLS.length + 1) + '" style="text-align:center;color:var(--muted,#8f97b2);padding:22px">Aucun lead attribué à une pub sur la période.</td></tr>';
    rows.forEach(function (r) {
      var cls = r.outOfAds ? 'out' : (r.leads < SMALL ? 'small' : '');
      h += '<tr class="' + cls + '"><td><span class="aq-name" title="' + esc(r.key) + (r.adIdList && r.adIdList.length ? ' · ' + esc(r.adIdList.join(', ')) : '') + '">' + esc(r.key)
        + (!r.outOfAds && r.leads < SMALL ? '<span class="aq-tag small" title="Moins de 10 leads : échantillon trop faible pour conclure">⚠ &lt; 10 leads</span>' : '')
        + (r.legacy && !r.outOfAds ? '<span class="aq-tag leg" title="Rattaché par le nom (ancien paramétrage d\'URL), pas par l\'identifiant de la pub">nom</span>' : '')
        + '</span></td>';
      COLS.forEach(function (c) {
        var txt = (c.cost && !ok) ? '—' : c.f(r);
        h += '<td class="' + (c.star ? 'star' : '') + '">' + txt + '</td>';
      });
      h += '</tr>';
    });
    if (rows.length) {
      var t = totals(ads);
      h += '<tr class="tot"><td>Total pubs (' + ads.length + ')</td>';
      COLS.forEach(function (c) { h += '<td class="' + (c.star ? 'star' : '') + '">' + ((c.cost && !ok) ? '—' : c.f(t)) + '</td>'; });
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    if (out.length) {
      h += '<div class="aq-row"><button type="button" class="aq-btn" data-aq-out="1">' + (state.showOut ? 'Masquer' : 'Afficher') + ' les ' + out.length + ' ligne(s) hors pub / pub inconnue</button></div>';
    }
    return h;
  }

  function headHtml(data, opts) {
    var cov = data.coverage || {};
    var h = '<div class="aq-head"><span class="aq-title">🎯 Qualité par pub</span>'
      + (data.periodLabel ? '<span class="aq-sub">' + esc(data.periodLabel) + '</span>' : '')
      + '<div style="flex:1"></div><div class="aq-seg">';
    AXES.forEach(function (a) { h += '<button type="button" data-aq-axis="' + a.id + '" class="' + (state.axis === a.id ? 'on' : '') + '">' + esc(a.label) + '</button>'; });
    h += '</div><button type="button" class="aq-btn" data-aq-csv="1">⬇ Export CSV</button>';
    if (opts.admin) h += '<button type="button" class="aq-btn primary" data-aq-share="1">🔗 Lien média buyeuse</button>';
    h += '</div>';
    var att = cov.attributedPct != null ? Math.round(cov.attributedPct) + ' %' : '—';
    h += '<div class="aq-note">Lecture : chaque lead est rattaché à la pub qui l\'a amené (premier passage), puis suivi jusqu\'au RDV et à la vente. '
      + '<b>' + att + '</b> des ' + (cov.leads || 0) + ' leads de la période portent une attribution publicitaire. '
      + 'Les leads d\'avant le nouveau paramétrage d\'URL restent rattachés par le nom de la pub (repère « nom ») ou « pub inconnue ». '
      + '<b>★</b> = les trois coûts à piloter. Colonnes triables (clic sur l\'en-tête).</div>';
    if (!cov.hasAdLevelSpend) {
      h += '<div class="aq-note warn">Aucune dépense par pub sur la période (scénario Make « FB insight ÉLITE — Créatives ») : les coûts sont masqués.</div>';
    } else if (!costsOk(cov)) {
      h += '<div class="aq-note warn">Dépense Meta reçue pour <b>' + cov.adSpendDaysCovered + ' jour(s) sur ' + cov.adSpendDaysExpected + '</b> : les coûts sont masqués tant que la période n\'est pas couverte (ils seraient faussement bas).</div>';
    }
    return h;
  }

  /* ── Export CSV (séparateur « ; », décimales à la virgule : Excel FR) ── */
  function csv(data) {
    var rows = sortRows((data.rowsByAxis && data.rowsByAxis[state.axis]) || []);
    var ok = costsOk(data.coverage);
    function num(v, dec) { if (v == null || !isFinite(v)) return ''; return Number(v).toFixed(dec == null ? 2 : dec).replace('.', ','); }
    function cell(s) { s = String(s == null ? '' : s); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var head = ['Ligne', 'Hors pub', 'Identifiants pub', 'Dépense', 'Leads', 'Coût par lead', 'Leads avec CA déclaré', 'Qualifiés', 'Part qualifiés',
      'Faux numéros', 'Part faux numéros', 'Disqualifiés', 'Part disqualifiés', 'Jamais joints', 'Leads > 48 h', 'Part jamais joints',
      'RDV posés', 'RDV honorés', 'Annulés', 'No-show', 'Ventes', 'Contracté HT', 'Encaissé HT',
      'Coût par lead qualifié', 'Coût par RDV honoré', 'Coût par vente', 'Moins de 10 leads'];
    var lines = [head.join(';')];
    rows.forEach(function (r) {
      lines.push([cell(r.key), r.outOfAds ? 'oui' : '', cell((r.adIdList || []).join(' ')), r.hasSpend ? num(r.spend) : '', r.leads, ok ? num(r.cpl) : '',
        r.caKnown, r.qualCa, r.caKnown ? num(r.qualCa / r.caKnown * 100, 1) : '',
        r.faux, r.leads ? num(r.faux / r.leads * 100, 1) : '', r.disq, r.leads ? num(r.disq / r.leads * 100, 1) : '',
        r.neverReached, r.neverEligible, r.neverEligible ? num(r.neverReached / r.neverEligible * 100, 1) : '',
        r.booked, r.honored, r.cancelled, r.noshow, r.closes, num(r.con), num(r.col),
        ok ? num(r.cpq) : '', ok ? num(r.cph) : '', ok ? num(r.cpv) : '', r.leads < SMALL ? 'oui' : ''].join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qualite-par-pub-' + state.axis + '-' + String(data.periodLabel || '').replace(/[^0-9A-Za-zÀ-ÿ_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
  }

  /* ══ ADMIN — lien de partage + API Conversions (sales-funnel.html) ══════ */
  function rndToken() {
    var b = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function shareUrl(tok) { return location.origin + '/ads-quality.html?t=' + encodeURIComponent(tok); }
  function copy(txt, toast) {
    function done() { if (toast) toast('📋 Lien copié'); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { if (toast) toast('Copie impossible — sélectionne le lien', true); });
    else if (toast) toast('Sélectionne le lien à la main', true);
  }
  function apiCall(ctx, method, url, body) {
    return ctx.user.getIdToken().then(function (tok) {
      var o = { method: method, headers: { Authorization: 'Bearer ' + tok } };
      if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(url, o).then(function (r) { return r.json().then(function (j) { if (!r.ok && j && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
    });
  }

  var admin = { share: null, capi: null, journal: null, open: false, busy: false, filter: '' };

  function sharePanelHtml() {
    var s = admin.share;
    var h = '<div class="aq-panel" id="aqSharePanel"><h4>🔗 Accès média buyeuse — lecture seule</h4>'
      + '<div class="aq-sub">Un lien secret : ce tableau seulement (pub, ensemble, campagne, coûts), sur la période de son choix, sans compte. Jamais un nom de lead, un contact, une commission. Chaque ouverture est journalisée. Distinct du lien Agence. Stocké dans <code>_config/ads_quality_access</code>.</div>';
    if (!s) h += '<div class="aq-row aq-sub">Chargement…</div>';
    else if (s.active && s.token) {
      h += '<div class="aq-row"><span class="aq-pill ok">actif</span><span class="aq-link">' + esc(shareUrl(s.token)) + '</span></div>'
        + '<div class="aq-row"><button type="button" class="aq-btn primary" data-aq-act="share-copy">📋 Copier</button>'
        + '<button type="button" class="aq-btn" data-aq-act="share-rotate">🔄 Nouveau lien (l\'ancien cesse de marcher)</button>'
        + '<button type="button" class="aq-btn danger" data-aq-act="share-off">⛔ Couper l\'accès</button></div>';
    } else {
      h += '<div class="aq-row"><span class="aq-pill off">aucun lien actif</span><button type="button" class="aq-btn primary" data-aq-act="share-new">Créer le lien</button></div>';
    }
    return h + '</div>';
  }

  var STATUS_PILL = { sent: ['ok', 'envoyé'], error: ['ko', 'erreur'], skipped: ['off', 'non envoyé'] };
  var REASONS = { faux_numero: 'faux numéro', youtube: 'visiteur YouTube', pixel_non_autorise: 'pixel non autorisé', hors_pub: 'hors pub (organique)',
    sans_contact: 'sans e-mail ni téléphone', contact_bloque: 'contact bloqué', telephone_invalide: 'téléphone invalide',
    trop_ancien: 'plus de 7 jours', fiche_introuvable: 'fiche introuvable' };

  function capiPanelHtml() {
    var c = admin.capi;
    var h = '<div class="aq-panel" id="aqCapiPanel"><h4>📡 Événements renvoyés à Meta (API Conversions)</h4>'
      + '<div class="aq-sub">LeadQualifie (CA ≥ 20 k€/mois) · RdvPose · RdvHonore (close, non close, offre) · Vente (montant contracté) — plus les jumeaux serveur de Lead et Schedule, avec le même identifiant que le pixel navigateur (Meta n\'en garde qu\'un). Jamais pour un faux numéro, un visiteur YouTube ou un pixel non autorisé. Envoi toutes les 10 min ; rien d\'antérieur à l\'activation.</div>';
    if (!c) return h + '<div class="aq-row aq-sub">Chargement…</div></div>';
    if (c.error) return h + '<div class="aq-row aq-note warn">' + esc(c.error) + '</div></div>';
    var mode = !c.enabled ? '<span class="aq-pill off">désactivé</span>'
      : (c.testMode ? '<span class="aq-pill wait">mode TEST</span>' : '<span class="aq-pill ok">RÉEL</span>');
    h += '<div class="aq-row">' + mode
      + ' <span class="aq-pill ' + (c.tokenSet ? 'ok' : 'ko') + '">jeton Meta ' + (c.tokenSet ? 'posé' : 'absent (variable Vercel META_CAPI_TOKEN)') + '</span>'
      + ' <span class="aq-sub">pixel ' + esc(c.pixelId) + ' · API ' + esc(c.apiVersion) + (c.lastRunAt ? ' · dernier passage ' + esc(new Date(c.lastRunAt).toLocaleString('fr-FR')) : '') + '</span></div>';
    h += '<div class="aq-row"><label class="aq-sub" for="aqTestCode">Code de test Meta</label><input class="aq-in" id="aqTestCode" placeholder="TEST12345" value="' + esc(c.testEventCode || '') + '">'
      + '<button type="button" class="aq-btn" data-aq-act="capi-save-code">Enregistrer</button>'
      + '<button type="button" class="aq-btn" data-aq-act="capi-probe" title="Envoie un exemplaire de chaque événement pour un contact fictif, avec le code de test">🧪 Envoyer les 6 événements de test</button></div>';
    h += '<div class="aq-row">';
    if (!c.enabled) h += '<button type="button" class="aq-btn primary" data-aq-act="capi-enable-test">Activer en mode test</button>';
    else {
      if (c.testMode) h += '<button type="button" class="aq-btn primary" data-aq-act="capi-prod">Passer en réel…</button>';
      else h += '<button type="button" class="aq-btn" data-aq-act="capi-back-test">Revenir en mode test</button>';
      h += '<button type="button" class="aq-btn danger" data-aq-act="capi-disable">Désactiver</button>';
    }
    h += '<button type="button" class="aq-btn" data-aq-act="capi-run">⟳ Lancer un passage maintenant</button>'
      + '<button type="button" class="aq-btn" data-aq-act="capi-dry">👁 Ce qui partirait (sans envoyer)</button></div>';
    if (admin.dry) {
      h += '<div class="aq-note">' + esc(admin.dry) + '</div>';
    }
    h += '<div class="aq-row"><b style="font-size:12px">Journal</b><select class="aq-in" id="aqJFilter" style="min-width:120px">'
      + ['', 'sent', 'error', 'skipped'].map(function (v) { return '<option value="' + v + '"' + (admin.filter === v ? ' selected' : '') + '>' + (v ? STATUS_PILL[v][1] : 'tous') + '</option>'; }).join('')
      + '</select><button type="button" class="aq-btn" data-aq-act="capi-journal">⟳</button></div>';
    var rows = admin.journal || [];
    if (!rows.length) h += '<div class="aq-sub">Aucune ligne.</div>';
    else {
      h += '<div class="aq-tw" style="max-height:420px;overflow:auto"><table class="aq-jt"><thead><tr><th>Date</th><th>Événement</th><th>Lead</th><th>Statut</th><th>Réponse de Meta</th><th>Correspondance</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var p = STATUS_PILL[r.status] || ['off', r.status];
        var resp = r.status === 'skipped' ? esc(REASONS[r.reason] || r.reason || '')
          : (r.response && r.response.ok ? 'reçu (' + (r.response.events_received != null ? r.response.events_received : '?') + ')' + (r.response.fbtrace_id ? ' · ' + esc(r.response.fbtrace_id) : '')
            : esc((r.response && r.response.error) || '') + (r.attempts ? ' · essai ' + r.attempts : ''));
        h += '<tr><td>' + esc(r.sentAt ? new Date(r.sentAt).toLocaleString('fr-FR') : '') + '</td>'
          + '<td><b>' + esc(r.event) + '</b>' + (r.value != null ? ' · ' + eur(r.value) : '') + (r.test ? ' <span class="aq-pill wait">test</span>' : '') + '</td>'
          + '<td>' + (r.leadId ? '<a href="sales-leads.html?lead=' + encodeURIComponent(r.leadId) + '" target="_blank" rel="noopener">' + esc(r.leadName || r.leadId) + '</a>' : '<span class="aq-z">' + esc(r.reason || '—') + '</span>') + '</td>'
          + '<td><span class="aq-pill ' + p[0] + '">' + esc(p[1]) + '</span></td>'
          + '<td>' + resp + '</td>'
          + '<td class="aq-sub">' + esc((r.matchKeys || []).join(', ')) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    return h + '</div>';
  }

  function adminLoad(ctx, repaint) {
    var db = ctx.db;
    db.collection('_config').doc('ads_quality_access').get().then(function (s) {
      admin.share = s.exists ? (s.data() || {}) : {};
      repaint();
    }).catch(function (e) { admin.share = {}; if (ctx.toast) ctx.toast('Lien média buyeuse : ' + e.message, true); repaint(); });
    capiReload(ctx, repaint);
  }
  function capiReload(ctx, repaint) {
    apiCall(ctx, 'GET', '/api/meta-capi?part=status').then(function (j) {
      admin.capi = j && j.ok ? j : { error: (j && j.error) || 'Statut indisponible' };
      repaint();
    }).catch(function (e) { admin.capi = { error: e.message }; repaint(); });
    apiCall(ctx, 'GET', '/api/meta-capi?part=journal&limit=200' + (admin.filter ? '&status=' + admin.filter : '')).then(function (j) {
      admin.journal = j && j.ok ? j.rows : [];
      repaint();
    }).catch(function () { admin.journal = []; repaint(); });
  }
  function saveCapi(ctx, patch, msg, repaint) {
    patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    patch.updatedBy = ctx.user.uid;
    return ctx.db.collection('_config').doc('meta_capi').set(patch, { merge: true }).then(function () {
      if (ctx.toast) ctx.toast(msg);
      capiReload(ctx, repaint);
    }).catch(function (e) { if (ctx.toast) ctx.toast('Erreur : ' + e.message, true); });
  }
  function adminAction(act, el, ctx, repaint) {
    var FV = firebase.firestore.FieldValue;
    var toast = ctx.toast || function () {};
    var ref = ctx.db.collection('_config').doc('ads_quality_access');
    if (act === 'share-copy') { copy(shareUrl(admin.share.token), toast); return; }
    if (act === 'share-new' || act === 'share-rotate') {
      if (act === 'share-rotate' && !confirm('Générer un nouveau lien ? L\'ancien cessera immédiatement de fonctionner.')) return;
      var tok = rndToken();
      ref.set({ active: true, token: tok, createdAt: FV.serverTimestamp(), createdBy: ctx.user.uid }, { merge: true }).then(function () {
        admin.share = { active: true, token: tok };
        copy(shareUrl(tok), toast);
        repaint();
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'share-off') {
      if (!confirm('Couper l\'accès de la média buyeuse ? Le lien cessera de fonctionner.')) return;
      ref.set({ active: false, token: FV.delete(), revokedAt: FV.serverTimestamp(), revokedBy: ctx.user.uid }, { merge: true }).then(function () {
        admin.share = { active: false }; toast('Accès coupé'); repaint();
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-save-code') {
      var code = String((document.getElementById('aqTestCode') || {}).value || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      saveCapi(ctx, { testEventCode: code }, code ? 'Code de test enregistré' : 'Code de test effacé', repaint);
      return;
    }
    if (act === 'capi-enable-test') {
      saveCapi(ctx, { enabled: true, testMode: true, testSince: FV.serverTimestamp() }, 'API Conversions activée en mode test', repaint);
      return;
    }
    if (act === 'capi-back-test') { saveCapi(ctx, { testMode: true, testSince: FV.serverTimestamp() }, 'Retour en mode test', repaint); return; }
    if (act === 'capi-disable') { saveCapi(ctx, { enabled: false }, 'API Conversions désactivée', repaint); return; }
    if (act === 'capi-prod') {
      var typed = prompt('Passage en RÉEL : les événements partiront vers Meta et nourriront l\'optimisation des pubs, à partir de maintenant (rien du passé).\n\nTape PRODUCTION pour confirmer.');
      if (typed !== 'PRODUCTION') { if (typed != null) toast('Non confirmé — toujours en mode test', true); return; }
      saveCapi(ctx, { enabled: true, testMode: false, productionSince: FV.serverTimestamp() }, 'API Conversions en RÉEL', repaint);
      return;
    }
    if (act === 'capi-run' || act === 'capi-dry') {
      if (admin.busy) return;
      admin.busy = true;
      toast(act === 'capi-dry' ? 'Calcul de ce qui partirait…' : 'Passage en cours…');
      apiCall(ctx, 'GET', '/api/meta-capi-cron' + (act === 'capi-dry' ? '?dry=1' : '')).then(function (j) {
        admin.busy = false;
        if (!j || !j.ok) { toast('Erreur : ' + ((j && j.error) || 'inconnue'), true); return; }
        if (j.skipped) admin.dry = 'Rien envoyé : ' + j.skipped + '.';
        else if (j.dry) {
          var by = {};
          (j.events || []).forEach(function (e) { by[e.event] = (by[e.event] || 0) + 1; });
          admin.dry = j.candidates + ' événement(s) candidat(s) depuis ' + new Date(j.from).toLocaleString('fr-FR') + ' : '
            + (Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join(' · ') || 'aucun') + '. Les exclusions (faux numéro, YouTube…) sont appliquées à l\'envoi.';
        } else admin.dry = 'Passage fait : ' + (j.sent || 0) + ' envoyé(s), ' + (j.errors || 0) + ' erreur(s), ' + (j.skippedOrDone || 0) + ' déjà traité(s) ou exclu(s).';
        capiReload(ctx, repaint);
      }).catch(function (e) { admin.busy = false; toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-probe') {
      if (!confirm('Envoyer à Meta un exemplaire de chacun des 6 événements, pour un contact fictif, avec le code de test (rien ne compte dans les pubs) ?')) return;
      apiCall(ctx, 'POST', '/api/meta-capi', { action: 'probe' }).then(function (j) {
        if (j && j.ok) { toast('Envoyé — regarde « Tester les événements » dans Meta'); admin.dry = 'Test envoyé : ' + (j.events || []).join(', ') + ' — Meta a reçu ' + (j.response && j.response.events_received) + ' événement(s).'; }
        else { toast('Erreur : ' + ((j && (j.error || (j.response && j.response.error))) || 'inconnue'), true); admin.dry = 'Test refusé : ' + ((j && (j.error || (j.response && j.response.error))) || 'inconnue'); }
        capiReload(ctx, repaint);
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-journal') { capiReload(ctx, repaint); }
  }

  /* ── Montage ──────────────────────────────────────────────────────────── */
  var _el = null, _data = null, _opts = {}, _loaded = false;
  function repaint() {
    if (!_el || !_data) return;
    var sx = _el.querySelector('.aq-tw') ? _el.querySelector('.aq-tw').scrollLeft : 0;
    var h = '<div class="aq-wrap">' + headHtml(_data, _opts) + tableHtml(_data);
    if (_opts.admin) h += (admin.open ? sharePanelHtml() : '') + capiPanelHtml();
    h += '</div>';
    _el.innerHTML = h;
    var tw = _el.querySelector('.aq-tw');
    if (tw && sx) tw.scrollLeft = sx;
  }
  function bind(el) {
    if (el.__aqBound) return;
    el.__aqBound = true;
    el.addEventListener('click', function (e) {
      var t = e.target;
      var ax = t.closest ? t.closest('[data-aq-axis]') : null;
      if (ax) { state.axis = ax.getAttribute('data-aq-axis'); repaint(); return; }
      var so = t.closest ? t.closest('[data-aq-sort]') : null;
      if (so) {
        var k = so.getAttribute('data-aq-sort');
        if (k === 'key') return;
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; var c = colByKey(k); state.dir = c && c.cost ? 1 : -1; }
        repaint(); return;
      }
      if (t.closest && t.closest('[data-aq-out]')) { state.showOut = !state.showOut; repaint(); return; }
      if (t.closest && t.closest('[data-aq-csv]')) { csv(_data); return; }
      if (t.closest && t.closest('[data-aq-share]')) { admin.open = !admin.open; repaint(); return; }
      var a = t.closest ? t.closest('[data-aq-act]') : null;
      if (a && _opts.admin && _opts.adminCtx) adminAction(a.getAttribute('data-aq-act'), a, _opts.adminCtx, repaint);
    });
    el.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'aqJFilter' && _opts.adminCtx) { admin.filter = e.target.value; capiReload(_opts.adminCtx, repaint); }
    });
  }
  function render(el, data, opts) {
    injectCss();
    _el = el; _data = data; _opts = opts || {};
    bind(el);
    if (_opts.admin && _opts.adminCtx && !_loaded) { _loaded = true; adminLoad(_opts.adminCtx, repaint); }
    repaint();
  }

  root.AdsQualityTab = { render: render, fromKpis: fromKpis, costsOk: costsOk, COLS: COLS };
})(typeof window !== 'undefined' ? window : this);
