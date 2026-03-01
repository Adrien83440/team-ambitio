/**
 * sales-core.js — Data Store + Event Bus + Utilities
 * Partagé par tous les modules du dashboard Sales
 */

/* ═══════════════════════ EVENT BUS ═══════════════════════ */
const Bus = {
  _l: {},
  on(event, cb) { (this._l[event] = this._l[event] || []).push(cb); },
  emit(event, data) { (this._l[event] || []).forEach(cb => cb(data)); },
};

/* ═══════════════════════ SHARED STATE ═══════════════════════ */
const STATE = {
  activeModule: 'dashboard',
  closingWeek:  'mois',
  settingWeek:  'mois',
  equipeView:   'week',
  projView:     'closing',
  selectedDeal: null,
};

/* ═══════════════════════ DATA STORE ═══════════════════════ */
const DB = {
  cm: { year: 2026, month: 1 }, // 0-indexed, 1 = Février
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
      cLiveP:    { a: 0.0,   p: 0.267  },
      cashLive:  { a: 84.2,  p: 666.7  },
      atteinte: 0.16,
      delta: 100800,
    },
    s1: { calls:{a:8,p:20}, lives:{a:2,p:15}, offres:{a:1,p:10}, closes:{a:0,p:4}, contracte:{a:0,p:24000},    collecte:{a:0,p:2000},    atteinte:0,     delta:24000 },
    s2: { calls:{a:8,p:20}, lives:{a:4,p:15}, offres:{a:2,p:10}, closes:{a:2,p:4}, contracte:{a:12000,p:24000}, collecte:{a:1000,p:2000}, atteinte:0.5,   delta:12000 },
    s3: { calls:{a:9,p:20}, lives:{a:6,p:15}, offres:{a:3,p:10}, closes:{a:1,p:4}, contracte:{a:5400,p:24000},  collecte:{a:400,p:2000},  atteinte:0.225, delta:18600 },
    s4: { calls:{a:9,p:20}, lives:{a:7,p:15}, offres:{a:2,p:10}, closes:{a:0,p:4}, contracte:{a:1800,p:24000},  collecte:{a:200,p:2000},  atteinte:0.075, delta:22200 },
  },

  setting: {
    mois: {
      tempsAppel: { a: 18,  p: 28   },
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
      collecte:      { a: 1600, p: 8000 },
      collecteCall:  { a: 39,   p: 400  },
      collecteLive:  { a: 114,  p: 500  },
    },
    s1: { tempsAppel:{a:5,p:7}, leads:{a:133,p:130}, calls:{a:231,p:375}, decroches:{a:56,p:45}, propRdv:{a:13,p:10}, sets:{a:9,p:5},  presents:{a:2,p:4}, closes:{a:0,p:4}, collecte:{a:0,p:2000}    },
    s2: { tempsAppel:{a:7,p:7}, leads:{a:191,p:130}, calls:{a:324,p:375}, decroches:{a:54,p:45}, propRdv:{a:17,p:10}, sets:{a:11,p:5}, presents:{a:4,p:4}, closes:{a:2,p:4}, collecte:{a:1000,p:2000}  },
    s3: { tempsAppel:{a:4,p:7}, leads:{a:127,p:130}, calls:{a:178,p:375}, decroches:{a:38,p:45}, propRdv:{a:16,p:10}, sets:{a:11,p:5}, presents:{a:4,p:4}, closes:{a:1,p:4}, collecte:{a:400,p:2000}   },
    s4: { tempsAppel:{a:2,p:7}, leads:{a:100,p:130}, calls:{a:150,p:375}, decroches:{a:28,p:45}, propRdv:{a:15,p:10}, sets:{a:10,p:5}, presents:{a:4,p:4}, closes:{a:0,p:4}, collecte:{a:200,p:2000}   },
  },

  team: {
    week: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444',
        contracte:33020, collecte:3342,  calls:23, lives:20, offres:14, closes:6, fu:1,
        showup:0.87, txOffre:0.70,  txTransfoShow:0.30,  txTransfoOffre:0.429, caCall:1435.7 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa',
        contracte:22748, collecte:13629, calls:29, lives:24, offres:19, closes:7, fu:1,
        showup:0.83, txOffre:0.792, txTransfoShow:0.292, txTransfoOffre:0.368, caCall:784.4  },
    ],
    month: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444',
        contracte:48469, collecte:4686, calls:56, lives:33, offres:17, closes:9, fu:2,
        showup:0.589, txOffre:0.515, txTransfoShow:0.273, txTransfoOffre:0.529, caCall:721.3 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa',
        contracte:34069, collecte:3966, calls:46, lives:28, offres:13, closes:7, fu:0,
        showup:0.609, txOffre:0.464, txTransfoShow:0.25,  txTransfoOffre:0.538, caCall:617.2 },
    ],
  },

  commissions: {
    'Janvier 2026': {
      sales:'GUILLAUME', contracte:12000, collecte:0, totalComm:0, statut:'Validé', deals:[],
    },
    'Février 2026': {
      sales:'GUILLAUME', contracte:24000, collecte:2000, totalComm:2125, statut:'En attente',
      deals: [
        { client:'Julie Berchoux',    email:'julieberchoux@icloud.com',             offre:'BP 12', type:'Closing', date:'24/01/2026', cHT:6000, coHT:500, comm:500, bonus:0, notes:"Setting qualification après self booking", ok:true  },
        { client:'Corinne Alaga',     email:'contact@lestabliersgourmands.com',     offre:'BP 12', type:'Setting', date:'27/01/2026', cHT:null, coHT:null,comm:125, bonus:0, notes:"Setting d'un close d'Elodie",            ok:true  },
        { client:'Belinda Giangiulio',email:'lesdemoisellesduvrac@gmail.com',       offre:'BP 12', type:'Closing', date:'30/01/2026', cHT:6000, coHT:500, comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
        { client:'Cecile Auneau',     email:'domcecile@gmail.com',                  offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500, comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
        { client:'Justine Biton',     email:'lephildesidees@hotmail.com',           offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500, comm:500, bonus:0, notes:'Setting no-booking',                    ok:true  },
      ],
    },
    'Mars 2026': {
      sales:'GUILLAUME', contracte:0, collecte:0, totalComm:1625, statut:'En attente', deals:[],
    },
  },
};

/* ═══════════════════════ UTILITIES ═══════════════════════ */
const U = {
  euro:  v => v == null ? '—' : '€\u00a0' + Number(v).toLocaleString('fr-FR'),
  pct:   v => v == null ? '—' : (v * 100).toFixed(1) + '%',
  num:   v => v == null ? '—' : Number(v).toLocaleString('fr-FR'),
  pp:  (a, p) => p > 0 ? Math.min((a / p) * 100, 200) : 0,
  ppv: (a, p) => p > 0 ? ((a / p) * 100).toFixed(0) + '%' : '—',
  cb:  (a, p) => { const r = p > 0 ? a / p : 0; return r >= 1 ? '#10b981' : r >= 0.7 ? '#f59e0b' : '#ef4444'; },
  g:   id   => document.getElementById(id),
  currentMonthKey: () => DB.months[DB.cm.month] + ' ' + DB.cm.year,

  progRow: (label, a, p, euro = false) => `
    <div class="pr">
      <div class="pr-l">${label}</div>
      <div class="pr-b"><div class="pr-f" style="width:${Math.min(U.pp(a,p),100)}%;background:${U.cb(a,p)}"></div></div>
      <div class="pr-v">${euro ? U.euro(a)+' / '+U.euro(p) : a+' / '+p}</div>
      <div class="pr-p" style="color:${U.cb(a,p)}">${U.ppv(a,p)}</div>
    </div>`,

  kpiCard: ({label, val, sub, pct, rawA, proj, color}) => {
    const pc = pct != null ? pct : U.pp(rawA ?? val, proj ?? 1);
    return `<div class="kpi" style="--kc:${color}">
      <div class="kpi-l">${label}</div>
      <div class="kpi-v">${val}</div>
      ${sub ? `<div class="kpi-s">${sub}</div>` : ''}
      ${proj != null ? `<div class="kpi-pg">
        <div class="kpi-pl"><span>Atteinte</span><span>${pc.toFixed(0)}%</span></div>
        <div class="kpi-pb"><div class="kpi-pf" style="width:${Math.min(pc,100)}%;background:${color}"></div></div>
      </div>` : ''}
    </div>`;
  },

  funnelStep: (label, val, max, isFirst = false, euro = false) => {
    const r = max > 0 ? val / max : 0;
    return `<div class="fs">
      <div class="fs-l">${label}</div>
      <div class="fs-b"><div class="fs-f" style="width:${Math.min(r*100,100)}%"></div></div>
      <div class="fs-v">${euro ? U.euro(val) : val}</div>
      <div class="fs-r">${!isFirst ? U.pct(r) : ''}</div>
    </div>`;
  },

  weekCard: (weekKey, label, mainVal, mainLabel, minis, isCurrent) => `
    <div class="wc ${isCurrent ? 'cur' : ''}">
      <div class="wl"><span>${label}</span></div>
      <div class="wv">${mainVal}</div>
      <div class="wvl">${mainLabel}</div>
      <div class="wmg">${minis.map(m => `
        <div class="wm">
          <div class="wmv" style="${m.color ? 'color:'+m.color : ''}">${m.val}</div>
          <div class="wml">${m.label}</div>
        </div>`).join('')}
      </div>
    </div>`,

  barChart: (labels, actuals, projs) => `
    <div style="display:flex;gap:10px;margin-bottom:8px;font-size:11px;color:var(--muted)">
      <div style="display:flex;align-items:center;gap:4px"><div style="width:9px;height:9px;border-radius:2px;background:linear-gradient(180deg,#ef4444,#b91c1c)"></div> Réel</div>
      <div style="display:flex;align-items:center;gap:4px"><div style="width:9px;height:9px;border-radius:2px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.18)"></div> Projection</div>
    </div>
    <div class="chrt">
      ${(() => { const mx = Math.max(...actuals, ...projs, 1);
        return labels.map((l,i) => `
        <div style="flex:1;display:flex;flex-direction:column">
          <div style="display:flex;gap:2px;align-items:flex-end;height:130px">
            <div class="chrt-bar chrt-a" style="flex:1;height:${(actuals[i]/mx*100).toFixed(1)}%" title="${actuals[i]}"></div>
            <div class="chrt-bar chrt-p" style="flex:1;height:${(projs[i]/mx*100).toFixed(1)}%" title="Proj: ${projs[i]}"></div>
          </div>
          <div class="chrt-lbl">${l}</div>
        </div>`).join('');
      })()}
    </div>`,

  toast: msg => {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.cssText = 'opacity:1;transform:translateX(-50%) translateY(0)';
    setTimeout(() => { t.style.cssText = 'opacity:0;transform:translateX(-50%) translateY(18px)'; }, 2500);
  },
};

/* Expose globally */
window.Bus   = Bus;
window.STATE = STATE;
window.DB    = DB;
window.U     = U;
