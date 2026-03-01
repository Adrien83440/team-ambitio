/**
 * mod-projections.js — Module Projections
 * Analyse des écarts actuel vs projection, graphes, note manager
 */

const ModProjections = (() => {

  /* ── HTML ── */
  const HTML = `
    <div class="sh">
      <div>
        <div class="st">Projections — Analyse & Tendances</div>
        <div class="ss">Objectifs vs réalisé · <span id="pr-mo-lbl">Février 2026</span></div>
      </div>
      <div class="itabs" id="pr-tabs">
        <div class="itab active" onclick="ModProjections.setView('closing')">Closing</div>
        <div class="itab"        onclick="ModProjections.setView('setting')">Setting</div>
        <div class="itab"        onclick="ModProjections.setView('revenue')">Revenus</div>
      </div>
    </div>

    <div class="g4 mb13" id="pr-kpis"></div>

    <div class="g2 mb13">
      <div class="card">
        <div class="ch"><span class="ct">Progression hebdomadaire</span></div>
        <div id="pr-chart"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Analyse des écarts</span></div>
        <div id="pr-gap"></div>
      </div>
    </div>

    <div class="card">
      <div class="ch"><span class="ct">Note du manager</span></div>
      <div id="pr-msg"></div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const el = U.g('pr-mo-lbl');
    if (el) el.textContent = U.currentMonthKey();

    const { kpis, actuals, projs, labels, gaps } = _buildData();
    _renderKpis(kpis);
    _renderChart(labels, actuals, projs);
    _renderGaps(gaps);
    _renderMessage();
  }

  function _buildData() {
    const v  = STATE.projView;
    const c  = DB.closing.mois;
    const s  = DB.setting.mois;
    const cm = DB.commissions[U.currentMonthKey()] || { totalComm: 0 };

    if (v === 'closing') {
      return {
        kpis: [
          { label:'Atteinte objectif', val:(c.atteinte*100).toFixed(0)+'%', color: c.atteinte < 0.5 ? '#ef4444' : '#f59e0b' },
          { label:'Delta contracté',   val:U.euro(c.delta),                  color:'#ef4444' },
          { label:'Cash / Live call',  val:U.euro(c.cashLive.a),  sub:'Proj: '+U.euro(c.cashLive.p), color:'#8b5cf6' },
          { label:'Closes restants',   val:(c.closes.p - c.closes.a)+' closes', sub:'pour atteindre proj.', color:'#f59e0b' },
        ],
        labels:  ['S1','S2','S3','S4'],
        actuals: [DB.closing.s1.closes.a, DB.closing.s2.closes.a, DB.closing.s3.closes.a, DB.closing.s4.closes.a],
        projs:   [DB.closing.s1.closes.p, DB.closing.s2.closes.p, DB.closing.s3.closes.p, DB.closing.s4.closes.p],
        gaps: [
          { l:'Calls',      a:c.calls.a,      p:c.calls.p      },
          { l:'Lives',      a:c.lives.a,      p:c.lives.p      },
          { l:'Offres',     a:c.offres.a,     p:c.offres.p     },
          { l:'Closes',     a:c.closes.a,     p:c.closes.p     },
          { l:'Contracté',  a:c.contracte.a,  p:c.contracte.p,  eu:true },
        ],
      };
    }

    if (v === 'setting') {
      return {
        kpis: [
          { label:'Calls vs proj.',  val:U.ppv(s.calls.a, s.calls.p),          color:'#3b82f6' },
          { label:'Sets obtenus',    val:`${s.sets.a} / ${s.sets.p}`,            color:'#8b5cf6' },
          { label:'Show-up rate',    val:U.pct(s.showupP.a), sub:'Proj: '+U.pct(s.showupP.p), color: s.showupP.a >= s.showupP.p ? '#10b981' : '#f59e0b' },
          { label:'Leads traités',   val:U.num(s.leads.a),                        color:'#3b82f6' },
        ],
        labels:  ['S1','S2','S3','S4'],
        actuals: [DB.setting.s1.calls.a, DB.setting.s2.calls.a, DB.setting.s3.calls.a, DB.setting.s4.calls.a],
        projs:   [DB.setting.s1.calls.p, DB.setting.s2.calls.p, DB.setting.s3.calls.p, DB.setting.s4.calls.p],
        gaps: [
          { l:'Leads',    a:s.leads.a,    p:s.leads.p    },
          { l:'Calls',    a:s.calls.a,    p:s.calls.p    },
          { l:'Sets',     a:s.sets.a,     p:s.sets.p     },
          { l:'Show-up',  a:s.presents.a, p:s.presents.p },
          { l:'Closes',   a:s.closes.a,   p:s.closes.p   },
        ],
      };
    }

    // Revenue view
    return {
      kpis: [
        { label:'Contracté',    val:U.euro(c.contracte.a), sub:'Proj: '+U.euro(c.contracte.p),                             color:'#ef4444' },
        { label:'Collecté',     val:U.euro(c.collecte.a),  sub:'Proj: '+U.euro(c.collecte.p),                              color:'#10b981' },
        { label:'Commissions',  val:U.euro(cm.totalComm),                                                                   color:'#f59e0b' },
        { label:'Taux collecte',val:U.pct(c.contracte.a > 0 ? c.collecte.a / c.contracte.a : 0), sub:'8.3% standard',      color:'#8b5cf6' },
      ],
      labels:  ['S1','S2','S3','S4'],
      actuals: [DB.closing.s1.contracte.a, DB.closing.s2.contracte.a, DB.closing.s3.contracte.a, DB.closing.s4.contracte.a],
      projs:   [DB.closing.s1.contracte.p, DB.closing.s2.contracte.p, DB.closing.s3.contracte.p, DB.closing.s4.contracte.p],
      gaps: [
        { l:'Contracté', a:c.contracte.a, p:c.contracte.p, eu:true },
        { l:'Collecté',  a:c.collecte.a,  p:c.collecte.p,  eu:true },
      ],
    };
  }

  function _renderKpis(kpis) {
    U.g('pr-kpis').innerHTML = kpis.map(k => U.kpiCard({ label:k.label, val:k.val, sub:k.sub, color:k.color })).join('');
  }

  function _renderChart(labels, actuals, projs) {
    U.g('pr-chart').innerHTML = U.barChart(labels, actuals, projs);
  }

  function _renderGaps(gaps) {
    U.g('pr-gap').innerHTML = gaps.map(g => {
      const ecart   = g.p - g.a;
      const isGood  = ecart <= 0;
      const sign    = ecart > 0 ? '−' : '+';
      const display = g.eu ? U.euro(Math.abs(ecart)) : Math.abs(ecart);
      return `
        <div class="pr">
          <div class="pr-l">${g.l}</div>
          <div class="pr-v">${g.eu ? U.euro(g.a) : g.a} / ${g.eu ? U.euro(g.p) : g.p}</div>
          <div class="pr-p" style="color:${isGood ? 'var(--green2)' : 'var(--red2)'};font-weight:700">
            ${sign} ${display}
          </div>
        </div>`;
    }).join('');
  }

  function _renderMessage() {
    U.g('pr-msg').innerHTML = `
      <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:16px 18px;border-left:3px solid var(--red)">
        <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.8px">
          Message du manager
        </div>
        <div style="font-size:13px;line-height:1.75;color:rgba(255,255,255,0.65)">
          Ce que tu as écrit, ce sont tes <b style="color:var(--text)">projections</b>, pas tes objectifs.<br><br>
          Une projection, c'est ce que tu es censé atteindre dans 75 à 80% des cas.
          C'est ce que tu atteins sans te forcer.<br><br>
          Un objectif, c'est ta projection augmentée de <b style="color:var(--gold)">33 à 50%</b>.
          C'est ce que tu vises pour sortir de ta zone de confort.<br><br>
          <span style="color:var(--red3)">
            Projection = zone de confort &nbsp;·&nbsp; Objectif = zone de progression
          </span>
        </div>
      </div>`;
  }

  /* ── VIEW SELECTOR ── */
  function setView(v) {
    STATE.projView = v;
    document.querySelectorAll('#pr-tabs .itab').forEach((t, i) =>
      t.classList.toggle('active', ['closing','setting','revenue'][i] === v));
    render();
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;
    Bus.on('monthChange', () => { if (STATE.activeModule === 'projections') render(); });
    // Refresh revenue view if a deal is added
    Bus.on('dealAdded', () => {
      if (STATE.activeModule === 'projections' && STATE.projView === 'revenue') render();
    });
  }

  return { init, render, setView };
})();

window.ModProjections = ModProjections;
