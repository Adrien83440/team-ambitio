/* ============================================================================
   funnel-pages-table.js — étape « Pages du tunnel » (rendu seul)
   ----------------------------------------------------------------------------
   Partagé par sales-funnel.html et agency-funnel.html. Les chiffres sortent
   de funnel-core.js (k.vslFunnels, k.vslLegacy) : ici, ZÉRO calcul métier,
   seulement la mise en forme.

   Lecture (refonte lisibilité 19/10/2026) :
   - un bloc par tunnel, pages dans l'ordre du parcours (Admin → Tunnels) ;
   - 6 colonnes chiffrées, le taux en petit sous chaque chiffre, calculé
     par rapport à l'étape nommée dans l'en-tête (« % des vues »…) ;
   - un taux au-dessus de 100 % s'affiche « — » avec une info-bulle ;
   - variantes en retrait sous leur page, verdict A/B en une phrase ;
   - adresses absentes du tunnel (page renommée ou supprimée) regroupées
     sur une ligne repliable, toujours comptées dans le total.
   CSS injecté une fois, couleurs en variables uniquement (thème clair OK).
   ============================================================================ */
(function (root) {
  'use strict';

  var OPEN = {};   // tunnels dont les anciennes adresses sont dépliées

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtNum(v) { if (v == null || isNaN(v) || !isFinite(v)) return '—'; return Math.round(v).toLocaleString('fr-FR'); }
  function fmtPct(v, dec) {
    if (v == null || isNaN(v) || !isFinite(v)) return '—';
    var f = dec == null ? (v > 0 && v < 1 ? 2 : 1) : dec;
    return (Math.round(v * Math.pow(10, f)) / Math.pow(10, f)).toLocaleString('fr-FR') + ' %';
  }
  function fmtP(p, dec) { return p.toFixed(dec).replace('.', ','); }

  /* Loi normale (approx. Zelen & Severo) + z-test 2 proportions — même
     calcul que l'A/B test opt-in de sales-funnel.html. */
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var pr = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - pr : pr;
  }
  function abSignif(vRef, oRef, vChal, oChal) {
    if (vRef < 30 || vChal < 30) return null;
    var pp = (oRef + oChal) / (vRef + vChal);
    var se = Math.sqrt(pp * (1 - pp) * (1 / vRef + 1 / vChal));
    if (!se) return null;
    var z = (oChal / vChal - oRef / vRef) / se;
    return { z: z, p: 2 * (1 - normCdf(Math.abs(z))) };
  }

  var CSS = ''
    + '.fpt-f{margin-top:18px}'
    + '.fpt-h{display:flex;align-items:baseline;justify-content:space-between;gap:6px 14px;flex-wrap:wrap;margin-bottom:8px}'
    + '.fpt-name{font-size:13px;font-weight:800;color:var(--text)}'
    + '.fpt-flow{font-size:11.5px;color:var(--muted);font-family:var(--font-m)}'
    + '.fpt-flow b{color:var(--text);font-weight:700}'
    + '.fpt-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--bg2)}'
    + 'table.fpt{width:100%;border-collapse:collapse;font-size:12.5px;min-width:720px}'
    + '.fpt th{text-align:right;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);border-bottom:1px solid var(--border2);white-space:nowrap;font-weight:700;vertical-align:bottom}'
    + '.fpt th:first-child{text-align:left}'
    + '.fpt-hs{text-transform:none;letter-spacing:0;font-weight:500;font-size:10px;margin-top:2px;opacity:.75}'
    + '.fpt td{padding:9px 14px;border-bottom:1px solid var(--border);vertical-align:top;text-align:left}'
    + '.fpt tr:last-child td{border-bottom:none}'
    + '.fpt-l{min-width:230px}'
    + 'td.fpt-n{text-align:right;white-space:nowrap}'
    + '.fpt-v{font-family:var(--font-m);font-size:12.5px;color:var(--text);font-weight:600}'
    + '.fpt-v.z{color:var(--muted);font-weight:400;opacity:.6}'
    + '.fpt-r{font-family:var(--font-m);font-size:10.5px;color:var(--muted);margin-top:1px}'
    + '.fpt-r[title]{cursor:help;text-decoration:underline dotted}'
    + '.fpt-page .fpt-l{font-weight:700;color:var(--text)}'
    + '.fpt-var td{padding-top:6px;padding-bottom:6px}'
    + '.fpt-var .fpt-l{padding-left:30px;color:var(--muted);font-size:12px}'
    + '.fpt-var.paused td{opacity:.5}'
    + '.fpt-vid{display:inline-block;min-width:16px;font-weight:800;color:var(--text);font-family:var(--font-m)}'
    + '.fpt-tag{display:inline-block;margin-left:6px;font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid var(--border2);color:var(--muted);white-space:nowrap}'
    + '.fpt-ab td{font-size:11.5px;color:var(--muted);padding:4px 14px 12px 30px;line-height:1.55}'
    + '.fpt-ab b{color:var(--text)}'
    + '.fpt-old{background:none;border:none;padding:0;color:var(--text);font:inherit;font-weight:700;cursor:pointer}'
    + '.fpt-hint{font-size:10.5px;color:var(--muted);font-weight:400;margin-top:2px;line-height:1.4;white-space:normal}'
    + '.fpt-oldrow .fpt-v{color:var(--muted)}'
    + '.fpt-slug{font-family:var(--font-m);font-size:11px}'
    + '.fpt-tot td{border-top:1px solid var(--border2)}'
    + '.fpt-tot .fpt-l{font-weight:800;color:var(--gold)}'
    + '.fpt-legend{font-size:11px;color:var(--muted);margin-top:12px;line-height:1.5}';
  function injectCss() {
    if (typeof document === 'undefined' || document.getElementById('fptCss')) return;
    var st = document.createElement('style');
    st.id = 'fptCss';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var FIELDS = ['views', 'ctas', 'leads', 'bookings', 'present', 'closes'];
  function zero() { var o = {}; FIELDS.forEach(function (f) { o[f] = 0; }); return o; }
  function addTo(o, c) { FIELDS.forEach(function (f) { o[f] += c[f] || 0; }); }
  function hasData(c) { var n = 0; FIELDS.forEach(function (f) { n += c[f] || 0; }); return n > 0; }

  var OVER_TIP = 'Plus de RDV que de formulaires sur la période : une partie des RDV vient de leads entrés avant la période, ou de prospects qui ont réservé sans remplir le formulaire. Le taux n\'aurait pas de sens.';

  /* Colonnes : base = étape de référence du taux affiché sous le chiffre. */
  function columns(withForms) {
    var c = [
      { f: 'views', t: 'Vues', sub: 'visites de la page' },
      { f: 'ctas', t: 'Clics', sub: '% des vues', base: 'views', tip: 'Clics sur le bouton principal de la page (réserver, commencer le quiz…)' }
    ];
    if (withForms) c.push({ f: 'leads', t: 'Formulaires', sub: '% des vues', base: 'views', tip: 'Formulaires remplis (opt-in) depuis la page' });
    c.push({ f: 'bookings', t: 'RDV pris', sub: withForms ? '% des formulaires' : '% des vues', base: withForms ? 'leads' : 'views', tip: 'RDV créés sur la période, replanifications exclues' });
    c.push({ f: 'present', t: 'Présents', sub: '% des RDV', base: 'bookings' });
    c.push({ f: 'closes', t: 'Closes', sub: '% des RDV', base: 'bookings' });
    return c;
  }
  function head(cols) {
    var h = '<thead><tr><th>Page</th>';
    cols.forEach(function (c) {
      h += '<th' + (c.tip ? ' title="' + esc(c.tip) + '"' : '') + '>' + c.t + '<div class="fpt-hs">' + c.sub + '</div></th>';
    });
    return h + '</tr></thead>';
  }
  function cell(c, col) {
    var v = c[col.f] || 0;
    var h = '<td class="fpt-n"><div class="fpt-v' + (v === 0 ? ' z' : '') + '">' + fmtNum(v) + '</div>';
    var txt = '&nbsp;', tip = '';
    if (col.base) {
      var b = c[col.base] || 0;
      if (b > 0) {
        var r = v / b * 100;
        if (r > 100) { txt = '—'; tip = OVER_TIP; }
        else txt = fmtPct(r);
      }
    }
    return h + '<div class="fpt-r"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + txt + '</div></td>';
  }
  function row(label, c, cls, cols, title) {
    var h = '<tr class="' + cls + '"><td class="fpt-l"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</td>';
    cols.forEach(function (col) { h += cell(c, col); });
    return h + '</tr>';
  }

  function isLive(v) { return !v.status || v.status === 'live'; }
  function vid(v) { return String(v.id).toUpperCase(); }
  function variantLabel(v) {
    if (v.id === '_') return '<span class="fpt-vid">·</span> Avant le test A/B <span class="fpt-tag">sans version</span>';
    var n = '<span class="fpt-vid">' + esc(vid(v)) + '</span> ' + (v.label ? esc(v.label) : 'Version ' + esc(vid(v)));
    if (!isLive(v)) n += '<span class="fpt-tag">⏸ en pause</span>';
    else if (v.weight != null && v.weight > 0) n += '<span class="fpt-tag">' + v.weight + ' % du trafic</span>';
    return n;
  }

  /* Verdict A/B en une phrase : la version la plus convertissante en RDV par
     vue, comparée à chacune des autres (z-test, seuil 95 %). */
  function abVerdict(named) {
    var live = named.filter(isLive);
    if (live.length < 2) live = named;
    live = live.filter(function (v) { return (v.views || 0) > 0; });
    if (live.length < 2) return '';
    function br(v) { return v.bookings / v.views * 100; }
    function cr(v) { return v.ctas / v.views * 100; }
    function list(fn) { return live.map(function (v) { return esc(vid(v)) + ' ' + fmtPct(fn(v)); }).join(' · '); }
    var ids = live.map(function (v) { return esc(vid(v)); });
    var idsTxt = ids.slice(0, -1).join(', ') + ' et ' + ids[ids.length - 1];
    var clicks = 'Clics : ' + list(cr) + '.';
    var totalB = 0;
    live.forEach(function (v) { totalB += v.bookings || 0; });
    if (totalB === 0) return '⏳ <b>Pas encore de RDV</b> sur les versions en test — impossible de départager ' + idsTxt + '. ' + clicks;
    var best = live[0];
    live.forEach(function (v) { if (br(v) > br(best)) best = v; });
    var worstP = 0, insufficient = false, allSig = true;
    live.forEach(function (v) {
      if (v === best) return;
      var st = abSignif(v.views, v.bookings, best.views, best.bookings);
      if (!st) { insufficient = true; allSig = false; return; }
      if (st.p >= 0.05) allSig = false;
      if (st.p > worstP) worstP = st.p;
    });
    var rdv = 'RDV pris par vue : ' + list(br) + '.';
    if (insufficient) return '⏳ <b>Pas encore assez de visites</b> pour conclure (30 minimum par version). ' + rdv + ' ' + clicks;
    if (allSig) return '✅ <b>La version ' + esc(vid(best)) + ' gagne</b> — écart de RDV par vue fiable à 95 % (p = ' + fmtP(worstP, 3) + '). ' + rdv + ' ' + clicks;
    return '⏳ <b>Test en cours</b> — ' + esc(vid(best)) + ' est devant pour l\'instant, mais l\'écart n\'est pas encore fiable (p = ' + fmtP(worstP, 2) + ', il faut moins de 0,05). ' + rdv + ' ' + clicks;
  }

  function flowLine(f, withForms) {
    var parts = [
      '<b>' + fmtNum(f.views) + '</b> vues',
      '<b>' + fmtNum(f.ctas) + '</b> clics'
    ];
    if (withForms) parts.push('<b>' + fmtNum(f.leads) + '</b> formulaires');
    parts.push('<b>' + fmtNum(f.bookings) + '</b> RDV');
    parts.push('<b>' + fmtNum(f.present) + '</b> présents');
    parts.push('<b>' + fmtNum(f.closes) + '</b> close' + (f.closes > 1 ? 's' : ''));
    return parts.join(' → ');
  }

  function renderFunnel(f) {
    var withForms = (f.leads || 0) > 0;
    var cols = columns(withForms);
    var pages = [], orph = [];
    (f.steps || []).forEach(function (s) { (s.orphan ? orph : pages).push(s); });
    var h = '<div class="fpt-f"><div class="fpt-h"><div class="fpt-name">🧭 ' + esc(f.name) + '</div>'
      + '<div class="fpt-flow">' + flowLine(f, withForms) + '</div></div>';
    h += '<div class="fpt-wrap"><table class="fpt">' + head(cols) + '<tbody>';
    pages.forEach(function (s) {
      h += row(esc(s.name), s, 'fpt-page', cols, 'Adresse : /' + s.slug);
      var vars = (s.variants || []).filter(function (v) { return v.id !== '_' || hasData(v); });
      var named = vars.filter(function (v) { return v.id !== '_'; });
      if (vars.length >= 2) {
        /* Versions en ligne d'abord, en pause ensuite, « avant le test » en dernier. */
        vars.sort(function (a, b) {
          var ra = a.id === '_' ? 2 : isLive(a) ? 0 : 1, rb = b.id === '_' ? 2 : isLive(b) ? 0 : 1;
          return (ra - rb) || (a.id < b.id ? -1 : 1);
        });
        vars.forEach(function (v) { h += row(variantLabel(v), v, 'fpt-var' + (v.id !== '_' && !isLive(v) ? ' paused' : ''), cols); });
        if (named.length >= 2) {
          var verdict = abVerdict(named);
          if (verdict) h += '<tr class="fpt-ab"><td colspan="' + (cols.length + 1) + '">🧪 ' + verdict + '</td></tr>';
        }
      }
    });
    if (orph.length) {
      var og = zero();
      orph.forEach(function (s) { addTo(og, s); });
      var open = !!OPEN[f.slug];
      h += row('<button type="button" class="fpt-old" data-fpt-old="' + esc(f.slug) + '">' + (open ? '▾' : '▸') + ' Anciennes adresses (' + orph.length + ')</button>'
        + '<div class="fpt-hint">Pages renommées ou retirées du tunnel. Leurs leads et RDV sont réels et restent comptés dans le total.</div>', og, 'fpt-oldrow', cols);
      if (open) orph.forEach(function (s) { h += row('<span class="fpt-slug">/' + esc(s.slug) + '</span>', s, 'fpt-var', cols); });
    }
    if (pages.length + (orph.length ? 1 : 0) > 1) h += row('Total', f, 'fpt-tot', cols);
    return h + '</tbody></table></div></div>';
  }

  /* Tous les tunnels de k.vslFunnels. */
  function render(k) {
    injectCss();
    var h = '';
    (k.vslFunnels || []).forEach(function (f) { h += renderFunnel(f); });
    if (h) h += '<div class="fpt-legend">Sous chaque chiffre : le taux par rapport à l\'étape indiquée dans l\'en-tête. Survolez un nom de page pour voir son adresse.</div>';
    return h;
  }

  /* Historique System.io : mêmes colonnes, une ligne par page. */
  function legacy(list, labelOf) {
    injectCss();
    var withForms = false;
    list.forEach(function (c) { if ((c.leads || 0) > 0) withForms = true; });
    var cols = columns(withForms);
    var h = '<div class="fpt-wrap" style="margin-top:8px"><table class="fpt">' + head(cols) + '<tbody>';
    list.forEach(function (c) { h += row(esc(labelOf(c.page)), c, 'fpt-page', cols); });
    return h + '</tbody></table></div>';
  }

  function toggleOld(slug) { OPEN[slug] = !OPEN[slug]; }

  root.FunnelPagesTable = { render: render, legacy: legacy, toggleOld: toggleOld };
})(typeof window !== 'undefined' ? window : this);
