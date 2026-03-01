/**
 * mod-setting.js — Module Setting
 * Funnel setting, taux, activité hebdomadaire
 */

const ModSetting = (() => {

  /* ── HTML ── */
  const HTML = `
    <div class="sh">
      <div>
        <div class="st">Setting — KPIs & Activité</div>
        <div class="ss">Projections vs Réel · <span id="se-month-lbl">Février 2026</span></div>
      </div>
      <div class="itabs" id="se-tabs">
        <div class="itab active" data-w="mois" onclick="ModSetting.setWeek('mois')">Mois</div>
        <div class="itab" data-w="s1"   onclick="ModSetting.setWeek('s1')">Sem 1</div>
        <div class="itab" data-w="s2"   onclick="ModSetting.setWeek('s2')">Sem 2</div>
        <div class="itab" data-w="s3"   onclick="ModSetting.setWeek('s3')">Sem 3</div>
        <div class="itab" data-w="s4"   onclick="ModSetting.setWeek('s4')">Sem 4</div>
      </div>
    </div>

    <div class="g4 mb13" id="se-kpis"></div>

    <div class="g21 mb13">
      <div class="card">
        <div class="ch"><span class="ct">Funnel Setting</span></div>
        <div class="fnl" id="se-funnel"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Taux clés</span></div>
        <div id="se-rates"></div>
      </div>
    </div>

    <div class="card">
      <div class="ch"><span class="ct">Breakdown hebdomadaire</span></div>
      <div class="wg" id="se-weeks"></div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const d   = DB.setting[STATE.settingWeek] || DB.setting.mois;
    const isM = STATE.settingWeek === 'mois';

    const el = U.g('se-month-lbl');
    if (el) el.textContent = U.currentMonthKey();

    _renderKpis(d);
    _renderFunnel(d);
    _renderRates(d, isM);
    _renderWeeks();
  }

  function _renderKpis(d) {
    U.g('se-kpis').innerHTML = [
      { label:'Calls passés', val:d.calls.a,    sub:`Proj: ${d.calls.p}`,    rawA:d.calls.a,    proj:d.calls.p,    color:'#3b82f6' },
      { label:'Sets',         val:d.sets.a,     sub:`Proj: ${d.sets.p}`,     rawA:d.sets.a,     proj:d.sets.p,     color:'#8b5cf6' },
      { label:'Show-up',      val:d.presents.a, sub:`Proj: ${d.presents.p}`, rawA:d.presents.a, proj:d.presents.p, color:'#f59e0b' },
      { label:'Closes',       val:d.closes.a,   sub:`Proj: ${d.closes.p}`,   rawA:d.closes.a,   proj:d.closes.p,   color:'#ef4444' },
    ].map(U.kpiCard).join('');
  }

  function _renderFunnel(d) {
    const steps = [
      { l:'Leads',           v:d.leads.a,    mx:d.leads.a,    first:true },
      { l:'Calls passés',    v:d.calls.a,    mx:d.leads.a              },
      { l:'Décrochés',       v:d.decroches.a,mx:d.calls.a              },
      { l:'Proposition RDV', v:d.propRdv.a,  mx:d.decroches.a          },
      { l:'Sets',            v:d.sets.a,     mx:d.propRdv.a            },
      { l:'Show-up',         v:d.presents.a, mx:d.sets.a               },
      { l:'Closes',          v:d.closes.a,   mx:d.presents.a           },
    ];
    U.g('se-funnel').innerHTML = steps.map(s =>
      U.funnelStep(s.l, s.v, s.mx, !!s.first)
    ).join('');
  }

  function _renderRates(d, isM) {
    if (!isM) {
      U.g('se-rates').innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">Taux disponibles en vue Mois</div>`;
      return;
    }
    U.g('se-rates').innerHTML = [
      { l:'Décrochés %',   a:d.decrochesP.a, p:d.decrochesP.p },
      { l:'Engagement %',  a:d.engP.a,       p:d.engP.p       },
      { l:'Set %',         a:d.setP.a,       p:d.setP.p       },
      { l:'Show-up %',     a:d.showupP.a,    p:d.showupP.p    },
      { l:'Close Calls %', a:d.cCallP.a,     p:d.cCallP.p     },
    ].map(r => U.progRow(r.l, r.a, r.p)).join('');
  }

  function _renderWeeks() {
    U.g('se-weeks').innerHTML = ['s1','s2','s3','s4'].map((w, i) => {
      const wd = DB.setting[w];
      return U.weekCard(w, `Semaine ${i+1}`, wd.calls.a, 'calls', [
        { val: wd.decroches.a,  label: 'Décrochés' },
        { val: wd.sets.a,       label: 'Sets'       },
        { val: wd.presents.a,   label: 'Show-up'    },
        { val: wd.closes.a, color:'var(--red2)', label: 'Closes' },
      ], STATE.settingWeek === w);
    }).join('');
  }

  /* ── WEEK SELECTOR ── */
  function setWeek(w) {
    STATE.settingWeek = w;
    document.querySelectorAll('#se-tabs .itab').forEach(t => t.classList.toggle('active', t.dataset.w === w));
    render();
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;
    Bus.on('monthChange', () => { if (STATE.activeModule === 'setting') render(); });
  }

  return { init, render, setWeek };
})();

window.ModSetting = ModSetting;
