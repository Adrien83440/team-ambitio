/**
 * mod-dashboard.js — Module Dashboard
 * Vue d'ensemble : alertes, KPIs, funnel, équipe, setting, commissions
 */

const ModDashboard = (() => {

  /* ── HTML ── */
  const HTML = `
    <div id="dash-alerts"></div>
    <div class="g4 mb13" id="dash-kpis"></div>
    <div class="g21 mb13">
      <div class="card">
        <div class="ch"><span class="ct">Funnel Closing — Mois</span>
          <span class="ca" onclick="SalesApp.switchMod('closing')">Détails →</span></div>
        <div class="fnl" id="dash-funnel"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:13px">
        <div class="card" style="flex:1">
          <div class="ch"><span class="ct">Commissions dues</span></div>
          <div id="dash-comm"></div>
        </div>
        <div class="card" style="flex:1">
          <div class="ch"><span class="ct">Objectif mensuel</span></div>
          <div id="dash-obj"></div>
        </div>
      </div>
    </div>
    <div class="g2">
      <div class="card">
        <div class="ch"><span class="ct">Setting — Résumé</span>
          <span class="ca" onclick="SalesApp.switchMod('setting')">Détails →</span></div>
        <div id="dash-setting"></div>
      </div>
      <div class="card">
        <div class="ch"><span class="ct">Équipe — Semaine</span>
          <span class="ca" onclick="SalesApp.switchMod('equipe')">Équipe →</span></div>
        <div id="dash-team"></div>
      </div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const c = DB.closing.mois;
    const s = DB.setting.mois;

    _renderAlerts(c, s);
    _renderKpis(c, s);
    _renderFunnel(c);
    _renderCommSummary();
    _renderObjectif(c);
    _renderSettingMini(s);
    _renderTeamMini();
  }

  function _renderAlerts(c, s) {
    const alerts = [];

    if (c.atteinte < 0.2)
      alerts.push({ cls:'rd', ic:'🚨', ti:'Objectif closing critique',
        tx:`${U.pct(c.atteinte)} atteint. ${U.euro(c.delta)} à récupérer ce mois.` });

    if (s.showupP.a < 0.5)
      alerts.push({ cls:'', ic:'⚠️', ti:'Taux de show-up faible',
        tx:`Show-up à ${U.pct(s.showupP.a)} vs ${U.pct(s.showupP.p)} projeté. Requalifier les RDVs.` });

    if (c.lives.a > 0 && c.cLiveP && c.cLiveP.a === 0)
      alerts.push({ cls:'', ic:'💡', ti:'0 close généré depuis les lives',
        tx:'Aucun close direct depuis les lives ce mois. Revoir le pitch en live.' });

    const chip = document.getElementById('alert-chip');
    if (alerts.length && chip) {
      chip.style.display = 'flex';
      document.getElementById('alert-txt').textContent = alerts.length + ' alerte' + (alerts.length > 1 ? 's' : '');
    }

    U.g('dash-alerts').innerHTML = alerts.map(a => `
      <div class="ap ${a.cls}">
        <div class="ap-ic">${a.ic}</div>
        <div><div class="ap-ti">${a.ti}</div><div class="ap-tx">${a.tx}</div></div>
      </div>`).join('');
  }

  function _renderKpis(c, s) {
    U.g('dash-kpis').innerHTML = [
      { label:'Contracté',    val:U.euro(c.contracte.a), sub:`/ ${U.euro(c.contracte.p)}`,  rawA:c.contracte.a, proj:c.contracte.p, color:'#ef4444' },
      { label:'Closes',       val:c.closes.a,            sub:`/ ${c.closes.p} proj.`,        rawA:c.closes.a,    proj:c.closes.p,    color:'#f59e0b' },
      { label:'Calls Setting',val:U.num(s.calls.a),      sub:`/ ${U.num(s.calls.p)} proj.`,  rawA:s.calls.a,     proj:s.calls.p,     color:'#3b82f6' },
      { label:'Commissions',  val:U.euro(DB.commissions[U.currentMonthKey()]?.totalComm || 0), sub:'Ce mois', pct:100, color:'#10b981' },
    ].map(U.kpiCard).join('');
  }

  function _renderFunnel(c) {
    U.g('dash-funnel').innerHTML = [
      U.funnelStep('Calls',    c.calls.a,    c.calls.p,    true),
      U.funnelStep('Lives',    c.lives.a,    c.calls.a),
      U.funnelStep('Offres',   c.offres.a,   c.lives.a),
      U.funnelStep('Closes',   c.closes.a,   c.offres.a),
      U.funnelStep('Collecté', c.collecte.a, c.contracte.a, false, true),
    ].join('');
  }

  function _renderCommSummary() {
    const cm = DB.commissions[U.currentMonthKey()] || { totalComm:0, contracte:0, collecte:0, statut:'—' };
    U.g('dash-comm').innerHTML = `
      <div style="font-size:24px;font-weight:800;font-family:var(--font-d);color:var(--gold);margin-bottom:8px">${U.euro(cm.totalComm)}</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Contracté: <b style="color:var(--text)">${U.euro(cm.contracte)}</b></div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Collecté: <b style="color:var(--text)">${U.euro(cm.collecte)}</b></div>
      <div class="cst ${cm.statut === 'Validé' ? 'paid' : 'due'}">
        ${cm.statut === 'Validé' ? '✅ Validé' : '⏳ ' + cm.statut} · Max le 5 du mois
      </div>`;
  }

  function _renderObjectif(c) {
    const at = c.atteinte * 100;
    const col = at >= 80 ? 'var(--green2)' : at >= 50 ? 'var(--gold)' : 'var(--red2)';
    U.g('dash-obj').innerHTML = `
      <div style="display:flex;align-items:center;gap:13px">
        <div style="font-size:30px;font-weight:800;font-family:var(--font-d);color:${col}">${at.toFixed(0)}%</div>
        <div style="flex:1">
          <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
            <div style="height:100%;width:${Math.min(at,100)}%;background:linear-gradient(90deg,#b91c1c,#ef4444);border-radius:99px"></div>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px">
            Delta: <b style="color:var(--red2)">${U.euro(c.delta)}</b>
          </div>
        </div>
      </div>`;
  }

  function _renderSettingMini(s) {
    U.g('dash-setting').innerHTML = [
      { l:'Calls',          a:s.calls.a,    p:s.calls.p    },
      { l:'Sets',           a:s.sets.a,     p:s.sets.p     },
      { l:'Show-up',        a:s.presents.a, p:s.presents.p },
      { l:'Closes setting', a:s.closes.a,   p:s.closes.p   },
    ].map(r => U.progRow(r.l, r.a, r.p)).join('');
  }

  function _renderTeamMini() {
    U.g('dash-team').innerHTML = `
      <table class="ttbl" style="width:100%">
        <thead><tr><th>Commercial</th><th>Closes</th><th>Contracté</th><th>Show-up</th></tr></thead>
        <tbody>
          ${DB.team.week.map(m => `
            <tr>
              <td><div class="tac">
                <div class="tav" style="background:linear-gradient(135deg,${m.color}88,${m.color})">${m.name[0]}</div>
                <span class="tnm">${m.name}</span>
              </div></td>
              <td class="tn ${m.closes >= 5 ? 'ok' : 'wn'}">${m.closes}</td>
              <td class="tn">${U.euro(m.contracte)}</td>
              <td class="tn ${m.showup >= 0.7 ? 'ok' : 'wn'}">${U.pct(m.showup)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;

    // Re-render when month changes or a deal is added
    Bus.on('monthChange', () => { if (STATE.activeModule === 'dashboard') render(); });
    Bus.on('dealAdded',   () => { if (STATE.activeModule === 'dashboard') _renderCommSummary(); });
  }

  return { init, render };
})();

window.ModDashboard = ModDashboard;
