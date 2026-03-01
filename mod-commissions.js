/**
 * mod-commissions.js — Module Commissions
 * Tracking deal par deal, résumé mensuel, historique, ajout de deal
 */

const ModCommissions = (() => {

  /* ── HTML ── */
  const HTML = `
    <div class="sh">
      <div>
        <div class="st">Commissions — Tracking</div>
        <div class="ss">Guillaume Bilcke · <span id="cm-mo-lbl">Février 2026</span></div>
      </div>
      <div class="sa">
        <button class="btn btn-ghost" onclick="ModCommissions.openAddDeal()">+ Ajouter deal</button>
        <button class="btn btn-red"   onclick="ModCommissions.submit()">📤 Soumettre</button>
      </div>
    </div>

    <div class="g12">
      <div style="display:flex;flex-direction:column;gap:13px">
        <div class="cs" id="cm-summary"></div>
        <div class="card">
          <div class="ch"><span class="ct">Historique mensuel</span></div>
          <div id="cm-history"></div>
        </div>
      </div>
      <div class="card">
        <div class="ch">
          <span class="ct" id="cm-tbl-title">Deals — Février 2026</span>
        </div>
        <div style="overflow-x:auto">
          <table class="ctbl">
            <thead>
              <tr>
                <th>Client</th><th>Offre</th><th>Type</th><th>Date</th>
                <th>Contracté HT</th><th>Collecté HT</th><th>Commission</th><th>Bonus</th><th>Statut</th>
              </tr>
            </thead>
            <tbody id="cm-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>`;

  /* ── RENDER ── */
  function render() {
    const mk   = U.currentMonthKey();
    const data = DB.commissions[mk] || { sales:'—', contracte:0, collecte:0, totalComm:0, statut:'—', deals:[] };

    U.g('cm-mo-lbl').textContent    = mk;
    U.g('cm-tbl-title').textContent = `Deals — ${mk}`;

    // Sync badge in topbar
    const badge = document.getElementById('comm-badge');
    if (badge) badge.textContent = U.euro(data.totalComm);

    _renderSummary(data);
    _renderHistory();
    _renderTable(data);
  }

  function _renderSummary(data) {
    U.g('cm-summary').innerHTML = `
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.35);margin-bottom:7px">${data.sales}</div>
      <div class="csv">${U.euro(data.totalComm)}</div>
      <div class="csr"><span style="color:var(--muted)">Cash contracté</span><span style="font-weight:600">${U.euro(data.contracte)}</span></div>
      <div class="csr"><span style="color:var(--muted)">Cash collecté</span><span style="font-weight:600">${U.euro(data.collecte)}</span></div>
      <div class="csr"><span style="color:var(--muted)">Nombre de deals</span><span style="font-weight:600">${data.deals.length}</span></div>
      <div class="csr tot"><span>Total commissions</span><span>${U.euro(data.totalComm)}</span></div>
      <div class="cst ${data.statut === 'Validé' ? 'paid' : 'due'}">
        ${data.statut === 'Validé' ? '✅ Validé' : '⏳ ' + data.statut} · Paiement max le 5 du mois
      </div>`;
  }

  function _renderHistory() {
    U.g('cm-history').innerHTML = Object.entries(DB.commissions).map(([k, v]) => `
      <div class="pr" style="cursor:pointer" onclick="ModCommissions.jumpToMonth('${k}')">
        <div class="pr-l" style="font-size:12px">${k}</div>
        <div class="tn" style="font-size:12px;margin-left:auto;color:${v.totalComm > 0 ? 'var(--gold)' : 'var(--muted)'}">${U.euro(v.totalComm)}</div>
        <div style="margin-left:8px">
          <span class="bdg ${v.statut === 'Validé' ? 'bdg-ok' : 'bdg-pd'}">${v.statut === 'Validé' ? '✓ Validé' : 'En attente'}</span>
        </div>
      </div>`).join('');
  }

  function _renderTable(data) {
    if (data.deals.length === 0) {
      U.g('cm-tbody').innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--muted)">Aucun deal enregistré pour ce mois</td></tr>`;
      return;
    }
    U.g('cm-tbody').innerHTML = data.deals.map((d, i) => `
      <tr onclick="ModCommissions.selectDeal(${i})" class="${STATE.selectedDeal === i ? 'sel' : ''}">
        <td>
          <div style="font-weight:600">${d.client}</div>
          <div style="font-size:10px;color:var(--muted)">${d.email}</div>
        </td>
        <td>${d.offre}</td>
        <td><span class="bdg ${d.type === 'Closing' ? 'bdg-cl' : 'bdg-st'}">${d.type}</span></td>
        <td style="font-family:var(--font-m);font-size:11px">${d.date}</td>
        <td class="tn">${d.cHT  ? U.euro(d.cHT)  : '—'}</td>
        <td class="tn">${d.coHT ? U.euro(d.coHT) : '—'}</td>
        <td class="tn" style="color:var(--gold);font-weight:700">${U.euro(d.comm)}</td>
        <td class="tn">${d.bonus ? U.euro(d.bonus) : '—'}</td>
        <td><span class="bdg ${d.ok ? 'bdg-ok' : 'bdg-pd'}">${d.ok ? '✓ Vérifié' : 'En attente'}</span></td>
      </tr>`).join('');
  }

  /* ── ACTIONS ── */
  function jumpToMonth(key) {
    const parts = key.split(' ');
    const mIdx  = DB.months.indexOf(parts[0]);
    const yr    = parseInt(parts[1]);
    if (mIdx >= 0) { DB.cm.month = mIdx; DB.cm.year = yr; }
    document.getElementById('month-lbl').textContent = key;
    Bus.emit('monthChange', DB.cm);
    render();
  }

  function selectDeal(i) {
    STATE.selectedDeal = STATE.selectedDeal === i ? null : i;
    const mk   = U.currentMonthKey();
    const data = DB.commissions[mk];
    if (data) _renderTable(data);
  }

  function submit() {
    const mk = U.currentMonthKey();
    if (DB.commissions[mk]) DB.commissions[mk].statut = 'Soumis';
    U.toast('📤 Commissions soumises pour validation !');
    render();
    Bus.emit('commissionSubmitted', mk);
  }

  function openAddDeal() {
    const bd = document.createElement('div');
    bd.className = 'mbk';
    bd.innerHTML = `
      <div class="mdl">
        <div class="mh">
          <div class="mti">Nouveau deal</div>
          <button class="mc" onclick="this.closest('.mbk').remove()">✕</button>
        </div>
        <div class="mb">
          <div class="fr">
            <div class="ff"><label class="fl">Client</label><input class="fi" id="nd-c" placeholder="Nom du client"/></div>
            <div class="ff"><label class="fl">Email</label><input class="fi" id="nd-e" type="email" placeholder="email@..."/></div>
          </div>
          <div class="fr">
            <div class="ff"><label class="fl">Offre</label><input class="fi" id="nd-o" placeholder="BP 12, Mentor..."/></div>
            <div class="ff"><label class="fl">Type</label>
              <select class="fi" id="nd-t"><option>Closing</option><option>Setting</option></select>
            </div>
          </div>
          <div class="fr">
            <div class="ff"><label class="fl">Date du close</label><input class="fi" id="nd-d" type="date"/></div>
            <div class="ff"><label class="fl">Contracté HT (€)</label><input class="fi" id="nd-ct" type="number" placeholder="6000"/></div>
          </div>
          <div class="fr">
            <div class="ff"><label class="fl">Collecté HT (€)</label><input class="fi" id="nd-co" type="number" placeholder="500"/></div>
            <div class="ff"><label class="fl">Commission (€)</label><input class="fi" id="nd-cm" type="number" placeholder="500"/></div>
          </div>
          <div class="ff"><label class="fl">Notes</label><input class="fi" id="nd-n" placeholder="Contexte du close..."/></div>
          <div style="display:flex;gap:9px;margin-top:16px">
            <button class="btn btn-ghost" style="flex:1" onclick="this.closest('.mbk').remove()">Annuler</button>
            <button class="btn btn-red"   style="flex:1" onclick="ModCommissions._saveDeal(this)">💾 Ajouter</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(bd);
    bd.addEventListener('click', e => { if (e.target === bd) bd.remove(); });
  }

  function _saveDeal(btn) {
    const mk = U.currentMonthKey();
    if (!DB.commissions[mk]) {
      DB.commissions[mk] = { sales:'GUILLAUME', contracte:0, collecte:0, totalComm:0, statut:'En attente', deals:[] };
    }
    const deal = {
      client: U.g('nd-c').value || 'Client',
      email:  U.g('nd-e').value || '',
      offre:  U.g('nd-o').value || 'BP 12',
      type:   U.g('nd-t').value,
      date:   U.g('nd-d').value || new Date().toLocaleDateString('fr-FR'),
      cHT:    parseFloat(U.g('nd-ct').value) || null,
      coHT:   parseFloat(U.g('nd-co').value) || null,
      comm:   parseFloat(U.g('nd-cm').value) || 0,
      bonus:  0,
      notes:  U.g('nd-n').value,
      ok:     false,
    };
    DB.commissions[mk].deals.push(deal);
    DB.commissions[mk].totalComm  += deal.comm;
    DB.commissions[mk].contracte  += deal.cHT  || 0;
    DB.commissions[mk].collecte   += deal.coHT || 0;

    btn.closest('.mbk').remove();
    U.toast('✅ Deal ajouté !');
    Bus.emit('dealAdded', deal);   // ← notifie Dashboard + Projections
    render();
  }

  /* ── INIT ── */
  function init(container) {
    container.innerHTML = HTML;
    Bus.on('monthChange', () => { if (STATE.activeModule === 'commissions') render(); });
  }

  return { init, render, openAddDeal, _saveDeal, submit, jumpToMonth, selectDeal };
})();

window.ModCommissions = ModCommissions;
