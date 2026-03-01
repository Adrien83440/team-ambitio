/**
 * mod-equipe.js — Module Équipe
 * Comparatif Guillaume vs Elodie, taux de performance
 */

const ModEquipe = (() => {

  /* ── HTML ── */
  const HTML = `
    <div class="sh">
      <div>
        <div class="st">Équipe — Performance comparée</div>
        <div class="ss">Guillaume vs Elodie</div>
      </div>
      <div class="itabs" id="eq-tabs">
        <div class="itab active" onclick="ModEquipe.setView('week')">Cette semaine</div>
        <div class="itab"        onclick="ModEquipe.setView('month')">Ce mois</div>
      </div>
    </div>

    <div class="g4 mb13" id="eq-kpis"></div>

    <div class="g21">
      <div class="card">
        <div class="ch"><span class="ct">Comparatif détaillé</span></div>
        <div id="eq-table"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Taux de performance</span></div>
        <div id="eq-perf"></div>
      </div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const team = DB.team[STATE.equipeView === 'week' ? 'week' : 'month'];
    _renderKpis(team);
    _renderTable(team);
    _renderPerf(team);
  }

  function _renderKpis(team) {
    const tot = {
      contracte: team.reduce((s,m) => s + m.contracte, 0),
      collecte:  team.reduce((s,m) => s + m.collecte,  0),
      calls:     team.reduce((s,m) => s + m.calls,     0),
      closes:    team.reduce((s,m) => s + m.closes,    0),
    };
    U.g('eq-kpis').innerHTML = [
      { label:'Contracté total', val:U.euro(tot.contracte), color:'#ef4444' },
      { label:'Collecté total',  val:U.euro(tot.collecte),  color:'#10b981' },
      { label:'Total calls',     val:tot.calls,              color:'#3b82f6' },
      { label:'Total closes',    val:tot.closes,             color:'#f59e0b' },
    ].map(k => U.kpiCard({ label:k.label, val:k.val, color:k.color })).join('');
  }

  function _renderTable(team) {
    const tot = {
      contracte: team.reduce((s,m) => s + m.contracte, 0),
      collecte:  team.reduce((s,m) => s + m.collecte,  0),
      calls:     team.reduce((s,m) => s + m.calls,     0),
      lives:     team.reduce((s,m) => s + m.lives,     0),
      offres:    team.reduce((s,m) => s + m.offres,    0),
      closes:    team.reduce((s,m) => s + m.closes,    0),
    };

    U.g('eq-table').innerHTML = `
      <table class="ttbl" style="width:100%">
        <thead>
          <tr>
            <th>Commercial</th><th>Contracté</th><th>Collecté</th>
            <th>Calls</th><th>Lives</th><th>Offres</th><th>Closes</th>
            <th>Show-up</th><th>CA/Call</th>
          </tr>
        </thead>
        <tbody>
          ${team.map(m => `
            <tr>
              <td>
                <div class="tac">
                  <div class="tav" style="background:linear-gradient(135deg,${m.color}88,${m.color})">${m.name[0]}</div>
                  <div>
                    <div class="tnm">${m.name}</div>
                    <div class="trt">${m.role}</div>
                  </div>
                </div>
              </td>
              <td class="tn">${U.euro(m.contracte)}</td>
              <td class="tn ${m.collecte > 5000 ? 'ok' : 'wn'}">${U.euro(m.collecte)}</td>
              <td class="tn">${m.calls}</td>
              <td class="tn">${m.lives}</td>
              <td class="tn">${m.offres}</td>
              <td class="tn ${m.closes >= 5 ? 'ok' : 'wn'}">${m.closes}</td>
              <td class="tn ${m.showup >= 0.7 ? 'ok' : 'wn'}">${U.pct(m.showup)}</td>
              <td class="tn">${U.euro(m.caCall)}</td>
            </tr>`).join('')}
          <tr style="border-top:1px solid var(--border2);font-weight:700">
            <td><b>Total</b></td>
            <td class="tn">${U.euro(tot.contracte)}</td>
            <td class="tn">${U.euro(tot.collecte)}</td>
            <td class="tn">${tot.calls}</td>
            <td class="tn">${tot.lives}</td>
            <td class="tn">${tot.offres}</td>
            <td class="tn">${tot.closes}</td>
            <td class="tn">—</td>
            <td class="tn">—</td>
          </tr>
        </tbody>
      </table>`;
  }

  function _renderPerf(team) {
    const metrics = [
      { l:"Show-up",         k:'showup',         ref:0.75 },
      { l:"Tx d'offre",      k:'txOffre',         ref:0.70 },
      { l:"Tx transfo show", k:'txTransfoShow',   ref:0.30 },
      { l:"Tx transfo offre",k:'txTransfoOffre',  ref:0.40 },
    ];

    U.g('eq-perf').innerHTML = metrics.map(m => `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:6px">${m.l}</div>
        ${team.map(t => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div style="width:68px;font-size:11px;color:var(--muted)">${t.name}</div>
            <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
              <div style="width:${Math.min((t[m.k]/m.ref)*100,100)}%;height:100%;background:${t.color};border-radius:99px;opacity:0.75"></div>
            </div>
            <div style="font-size:11px;font-family:var(--font-m);min-width:40px;text-align:right;color:${U.cb(t[m.k],m.ref)}">
              ${U.pct(t[m.k])}
            </div>
          </div>`).join('')}
      </div>`).join('');
  }

  /* ── VIEW SELECTOR ── */
  function setView(v) {
    STATE.equipeView = v;
    document.querySelectorAll('#eq-tabs .itab').forEach((t,i) =>
      t.classList.toggle('active', (i===0 && v==='week') || (i===1 && v==='month')));
    render();
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;
    Bus.on('monthChange', () => { if (STATE.activeModule === 'equipe') render(); });
    // When a deal is added (new close), refresh performance
    Bus.on('dealAdded', () => { if (STATE.activeModule === 'equipe') render(); });
  }

  return { init, render, setView };
})();

window.ModEquipe = ModEquipe;
