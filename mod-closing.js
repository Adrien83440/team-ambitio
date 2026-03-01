/**
 * mod-closing.js — Module Closing
 * KPIs vs projections, taux de conversion, breakdown hebdomadaire, graphe contracté
 */

const ModClosing = (() => {

  /* ── HTML ── */
  const HTML = `
    <div class="sh">
      <div>
        <div class="st">Closing — KPIs & Pipeline</div>
        <div class="ss">Projections vs Réel · <span id="cl-month-lbl">Février 2026</span></div>
      </div>
      <div class="itabs" id="cl-tabs">
        <div class="itab active" data-w="mois" onclick="ModClosing.setWeek('mois')">Mois</div>
        <div class="itab" data-w="s1"   onclick="ModClosing.setWeek('s1')">Sem 1</div>
        <div class="itab" data-w="s2"   onclick="ModClosing.setWeek('s2')">Sem 2</div>
        <div class="itab" data-w="s3"   onclick="ModClosing.setWeek('s3')">Sem 3</div>
        <div class="itab" data-w="s4"   onclick="ModClosing.setWeek('s4')">Sem 4</div>
      </div>
    </div>

    <div class="g4 mb13" id="cl-kpis"></div>

    <div class="g21 mb13">
      <div class="card">
        <div class="ch"><span class="ct">Actuel vs Projection</span></div>
        <div id="cl-prog"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Taux de conversion</span></div>
        <div id="cl-rates"></div>
      </div>
    </div>

    <div class="g2">
      <div class="card">
        <div class="ch"><span class="ct">Breakdown hebdomadaire</span></div>
        <div class="wg" id="cl-weeks"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Évolution contracté</span></div>
        <div id="cl-chart"></div>
      </div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const d   = DB.closing[STATE.closingWeek] || DB.closing.mois;
    const isM = STATE.closingWeek === 'mois';

    _updateMonthLabel();
    _renderKpis(d);
    _renderProgBars(d, isM);
    _renderRates(d, isM);
    _renderWeeks();
    _renderChart();
  }

  function _updateMonthLabel() {
    const el = U.g('cl-month-lbl');
    if (el) el.textContent = U.currentMonthKey();
  }

  function _renderKpis(d) {
    U.g('cl-kpis').innerHTML = [
      { label:'Calls',      val:d.calls.a,             sub:`Proj: ${d.calls.p}`,             rawA:d.calls.a,      proj:d.calls.p,      color:'#3b82f6' },
      { label:'Lives',      val:d.lives.a,             sub:`Proj: ${d.lives.p}`,             rawA:d.lives.a,      proj:d.lives.p,      color:'#8b5cf6' },
      { label:'Closes',     val:d.closes.a,            sub:`Proj: ${d.closes.p}`,            rawA:d.closes.a,     proj:d.closes.p,     color:'#f59e0b' },
      { label:'Contracté',  val:U.euro(d.contracte.a), sub:`Proj: ${U.euro(d.contracte.p)}`, rawA:d.contracte.a,  proj:d.contracte.p,  color:'#ef4444' },
    ].map(U.kpiCard).join('');
  }

  function _renderProgBars(d, isM) {
    if (isM) {
      U.g('cl-prog').innerHTML = [
        { l:'Calls',          a:d.calls.a,      p:d.calls.p      },
        { l:'Lives',          a:d.lives.a,      p:d.lives.p      },
        { l:'Offres faites',  a:d.offres.a,     p:d.offres.p     },
        { l:'Closes total',   a:d.closes.a,     p:d.closes.p     },
        { l:'Hard close',     a:d.hc.a,         p:d.hc.p         },
        { l:'Follow-up close',a:d.fu.a,         p:d.fu.p         },
        { l:'Contracté (€)',  a:d.contracte.a,  p:d.contracte.p, eu:true },
        { l:'Collecté (€)',   a:d.collecte.a,   p:d.collecte.p,  eu:true },
      ].map(r => U.progRow(r.l, r.a, r.p, r.eu)).join('');
    } else {
      U.g('cl-prog').innerHTML = [
        { l:'Calls',  a:d.calls.a,  p:d.calls.p  },
        { l:'Lives',  a:d.lives.a,  p:d.lives.p  },
        { l:'Offres', a:d.offres.a, p:d.offres.p },
        { l:'Closes', a:d.closes.a, p:d.closes.p },
      ].map(r => U.progRow(r.l, r.a, r.p)).join('');
    }
  }

  function _renderRates(d, isM) {
    if (!isM) {
      U.g('cl-rates').innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">Taux détaillés disponibles en vue Mois</div>`;
      return;
    }
    U.g('cl-rates').innerHTML = [
      { l:'Lives / Calls',     a:d.livesP.a, p:d.livesP.p },
      { l:'Offres / Lives',    a:d.offresP.a,p:d.offresP.p},
      { l:'Engagement offres', a:d.engP.a,   p:d.engP.p   },
      { l:'Close / Offres',    a:d.cOffP.a,  p:d.cOffP.p  },
      { l:'Close / Calls',     a:d.cCallP.a, p:d.cCallP.p },
    ].map(r => U.progRow(r.l, r.a, r.p)).join('');
  }

  function _renderWeeks() {
    U.g('cl-weeks').innerHTML = ['s1','s2','s3','s4'].map((w, i) => {
      const wd = DB.closing[w];
      return U.weekCard(w, `Semaine ${i+1}`, wd.closes.a, 'closes', [
        { val: wd.calls.a,                         label: 'Calls'      },
        { val: wd.lives.a,                         label: 'Lives'      },
        { val: wd.offres.a,                        label: 'Offres'     },
        { val: U.euro(wd.contracte.a), color:'var(--gold)', label: 'Contracté' },
      ], STATE.closingWeek === w);
    }).join('');
  }

  function _renderChart() {
    U.g('cl-chart').innerHTML = U.barChart(
      ['S1','S2','S3','S4'],
      [DB.closing.s1.contracte.a, DB.closing.s2.contracte.a, DB.closing.s3.contracte.a, DB.closing.s4.contracte.a],
      [DB.closing.s1.contracte.p, DB.closing.s2.contracte.p, DB.closing.s3.contracte.p, DB.closing.s4.contracte.p],
    );
  }

  /* ── WEEK SELECTOR ── */
  function setWeek(w) {
    STATE.closingWeek = w;
    document.querySelectorAll('#cl-tabs .itab').forEach(t => t.classList.toggle('active', t.dataset.w === w));
    render();
    Bus.emit('closingWeekChange', w);
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;
    Bus.on('monthChange', () => { if (STATE.activeModule === 'closing') render(); });
  }

  return { init, render, setWeek };
})();

window.ModClosing = ModClosing;
