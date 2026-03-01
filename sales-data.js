/**
 * sales-data.js — Données partagées & utilitaires
 * Chargé en premier par chaque page du dashboard Sales
 */

/* ═══ DATA STORE ═══ */
const DB = {
  months: ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'],

  closing: {
    mois: {
      calls:     { a: 34,    p: 100    },
      lives:     { a: 19,    p: 75     },
      offres:    { a: 8,     p: 50     },
      closes:    { a: 3,     p: 20     },
      hc:        { a: 3,     p: 20     },
      fu:        { a: 0,     p: 0      },
      contracte: { a: 19200, p: 120000 },
      collecte:  { a: 1600,  p: 10000  },
      livesP:    { a: 0.559, p: 0.75   },
      offresP:   { a: 0.421, p: 0.667  },
      engP:      { a: 0.375, p: 0.5    },
      cOffP:     { a: 0.375, p: 0.4    },
      cCallP:    { a: 0.088, p: 0.2    },
      cashLive:  { a: 84.2,  p: 666.7  },
      atteinte:  0.16,
      delta:     100800,
    },
    s1: { calls:{a:8,p:20},  lives:{a:2,p:15},  offres:{a:1,p:10}, closes:{a:0,p:4}, contracte:{a:0,p:24000},    collecte:{a:0,p:2000}    },
    s2: { calls:{a:8,p:20},  lives:{a:4,p:15},  offres:{a:2,p:10}, closes:{a:2,p:4}, contracte:{a:12000,p:24000}, collecte:{a:1000,p:2000}  },
    s3: { calls:{a:9,p:20},  lives:{a:6,p:15},  offres:{a:3,p:10}, closes:{a:1,p:4}, contracte:{a:5400,p:24000},  collecte:{a:400,p:2000}   },
    s4: { calls:{a:9,p:20},  lives:{a:7,p:15},  offres:{a:2,p:10}, closes:{a:0,p:4}, contracte:{a:1800,p:24000},  collecte:{a:200,p:2000}   },
  },

  setting: {
    mois: {
      leads:      { a: 551, p: 520  },
      calls:      { a: 883, p: 1500 },
      decroches:  { a: 176, p: 180  },
      propRdv:    { a: 61,  p: 40   },
      sets:       { a: 41,  p: 20   },
      presents:   { a: 14,  p: 16   },
      closes:     { a: 3,   p: 16   },
      decrochesP: { a: 0.199, p: 0.12  },
      engP:       { a: 0.347, p: 0.222 },
      setP:       { a: 0.672, p: 0.5   },
      showupP:    { a: 0.341, p: 0.8   },
      cCallP:     { a: 0.073, p: 0.8   },
    },
    s1: { leads:{a:133,p:130}, calls:{a:231,p:375}, decroches:{a:56,p:45}, propRdv:{a:13,p:10}, sets:{a:9,p:5},  presents:{a:2,p:4},  closes:{a:0,p:4} },
    s2: { leads:{a:191,p:130}, calls:{a:324,p:375}, decroches:{a:54,p:45}, propRdv:{a:17,p:10}, sets:{a:11,p:5}, presents:{a:4,p:4},  closes:{a:2,p:4} },
    s3: { leads:{a:127,p:130}, calls:{a:178,p:375}, decroches:{a:38,p:45}, propRdv:{a:16,p:10}, sets:{a:11,p:5}, presents:{a:4,p:4},  closes:{a:1,p:4} },
    s4: { leads:{a:100,p:130}, calls:{a:150,p:375}, decroches:{a:28,p:45}, propRdv:{a:15,p:10}, sets:{a:10,p:5}, presents:{a:4,p:4},  closes:{a:0,p:4} },
  },

  team: {
    week: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444',
        contracte:33020, collecte:3342,  calls:23, lives:20, offres:14, closes:6,
        showup:0.87, txOffre:0.70,  txTransfoShow:0.30,  txTransfoOffre:0.429, caCall:1435.7 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa',
        contracte:22748, collecte:13629, calls:29, lives:24, offres:19, closes:7,
        showup:0.83, txOffre:0.792, txTransfoShow:0.292, txTransfoOffre:0.368, caCall:784.4  },
    ],
    month: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444',
        contracte:48469, collecte:4686, calls:56, lives:33, offres:17, closes:9,
        showup:0.589, txOffre:0.515, txTransfoShow:0.273, txTransfoOffre:0.529, caCall:721.3 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa',
        contracte:34069, collecte:3966, calls:46, lives:28, offres:13, closes:7,
        showup:0.609, txOffre:0.464, txTransfoShow:0.25,  txTransfoOffre:0.538, caCall:617.2 },
    ],
  },

  commissions: {
    'Janvier 2026':  { contracte:12000, collecte:0,    totalComm:0,    statut:'Validé',     deals:[] },
    'Février 2026':  {
      contracte:24000, collecte:2000, totalComm:2125, statut:'En attente',
      deals: [
        { client:'Julie Berchoux',     email:'julieberchoux@icloud.com',         offre:'BP 12', type:'Closing', date:'24/01/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting qualification après self booking', ok:true  },
        { client:'Corinne Alaga',      email:'contact@lestabliersgourmands.com', offre:'BP 12', type:'Setting', date:'27/01/2026', cHT:null, coHT:null,  comm:125, bonus:0, notes:"Setting d'un close d'Elodie",            ok:true  },
        { client:'Belinda Giangiulio', email:'lesdemoisellesduvrac@gmail.com',   offre:'BP 12', type:'Closing', date:'30/01/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
        { client:'Cecile Auneau',      email:'domcecile@gmail.com',              offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
        { client:'Justine Biton',      email:'lephildesidees@hotmail.com',       offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
      ],
    },
    'Mars 2026':     { contracte:0, collecte:0, totalComm:1625, statut:'En attente', deals:[] },
  },
};

/* ═══ UTILITIES ═══ */
const U = {
  euro:  v => v == null ? '—' : '€\u202f' + Number(v).toLocaleString('fr-FR'),
  pct:   v => v == null ? '—' : (v * 100).toFixed(1) + '%',
  num:   v => v == null ? '—' : Number(v).toLocaleString('fr-FR'),
  pp:  (a, p) => p > 0 ? Math.min((a / p) * 100, 200) : 0,
  ppv: (a, p) => p > 0 ? ((a / p) * 100).toFixed(0) + '%' : '—',
  cb:  (a, p) => { const r = p > 0 ? a / p : 0; return r >= 1 ? '#34d399' : r >= 0.65 ? '#f59e0b' : '#ef4444'; },
  g:   id   => document.getElementById(id),

  getCurrentMonth: () => {
    const raw = localStorage.getItem('sales_month') || 'Février 2026';
    return raw;
  },

  setCurrentMonth: (label) => {
    localStorage.setItem('sales_month', label);
  },

  // Render a progress bar row
  progRow: (label, a, p, isEuro = false) => {
    const pct = U.pp(a, p);
    const col = U.cb(a, p);
    const valStr = isEuro ? `${U.euro(a)} / ${U.euro(p)}` : `${a} / ${p}`;
    return `
      <div class="pr">
        <div class="pr-l">${label}</div>
        <div class="pr-track"><div class="pr-fill" style="width:${Math.min(pct,100)}%;background:${col}"></div></div>
        <div class="pr-val">${valStr}</div>
        <div class="pr-pct" style="color:${col}">${U.ppv(a,p)}</div>
      </div>`;
  },

  // Render a KPI card
  kpiCard: ({ label, val, sub, rawA, proj, color = '#ef4444', pct: forcePct }) => {
    const pc = forcePct != null ? forcePct : (proj != null ? U.pp(rawA ?? 0, proj) : null);
    return `
      <div class="kpi" style="--kc:${color}">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${val}</div>
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
        ${pc != null ? `
          <div class="kpi-prog">
            <div class="kpi-prog-row"><span>Atteinte</span><span>${pc.toFixed(0)}%</span></div>
            <div class="kpi-prog-track"><div class="kpi-prog-fill" style="width:${Math.min(pc,100)}%;background:${color}"></div></div>
          </div>` : ''}
      </div>`;
  },

  // Funnel step
  funnelStep: (label, val, max, isFirst = false, isEuro = false) => {
    const ratio = max > 0 ? val / max : 0;
    return `
      <div class="fs">
        <div class="fs-label">${label}</div>
        <div class="fs-track"><div class="fs-fill" style="width:${Math.min(ratio*100,100)}%"></div></div>
        <div class="fs-val">${isEuro ? U.euro(val) : val}</div>
        <div class="fs-rate">${!isFirst ? U.pct(ratio) : ''}</div>
      </div>`;
  },

  // Week card
  weekCard: (label, mainVal, mainLabel, minis, isCurrent) => `
    <div class="wc${isCurrent ? ' wc-active' : ''}">
      <div class="wc-label">${label}</div>
      <div class="wc-main">${mainVal}</div>
      <div class="wc-sub">${mainLabel}</div>
      <div class="wc-grid">
        ${minis.map(m => `
          <div class="wc-mini">
            <div class="wc-mini-v" ${m.color ? `style="color:${m.color}"` : ''}>${m.val}</div>
            <div class="wc-mini-l">${m.label}</div>
          </div>`).join('')}
      </div>
    </div>`,

  // Bar chart
  barChart: (labels, actuals, projs, unitLabel = '') => {
    const mx = Math.max(...actuals, ...projs, 1);
    return `
      <div class="chart-legend">
        <span class="cl-dot cl-real"></span>Réel
        <span class="cl-dot cl-proj" style="margin-left:14px"></span>Projection
      </div>
      <div class="chart-bars">
        ${labels.map((l, i) => `
          <div class="chart-col">
            <div class="chart-pair">
              <div class="chart-bar bar-real" style="height:${(actuals[i]/mx*100).toFixed(1)}%" title="${actuals[i]}${unitLabel}"></div>
              <div class="chart-bar bar-proj" style="height:${(projs[i]/mx*100).toFixed(1)}%" title="Proj: ${projs[i]}${unitLabel}"></div>
            </div>
            <div class="chart-lbl">${l}</div>
          </div>`).join('')}
      </div>`;
  },

  toast: msg => {
    let t = document.getElementById('_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = '_toast';
      t.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:#1a2e1a;border:1px solid rgba(52,211,153,0.3);color:#6ee7b7;font-size:12px;font-weight:600;padding:9px 18px;border-radius:10px;z-index:9999;opacity:0;transition:all 0.28s;white-space:nowrap;font-family:var(--font-b)';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(20px)'; }, 2600);
  },
};


window.DB = DB;
window.U  = U;
