/**
 * sales-data.js — Data Store + Firebase + Utilitaires
 * Les données "a" (actuelles) viennent de Firestore en temps réel.
 * Les données "p" (projections) sont les références fixes.
 */

/* ═══════════════════════════════════════════════════════════
   PROJECTIONS FIXES — modifier ici pour changer les cibles
═══════════════════════════════════════════════════════════ */
const PROJECTIONS = {
  closing: {
    s1: { calls:20, lives:15, offres:10, closes:4, contracte:24000, collecte:2000 },
    s2: { calls:20, lives:15, offres:10, closes:4, contracte:24000, collecte:2000 },
    s3: { calls:20, lives:15, offres:10, closes:4, contracte:24000, collecte:2000 },
    s4: { calls:20, lives:15, offres:10, closes:4, contracte:24000, collecte:2000 },
    livesP:0.75, offresP:0.667, engP:0.5, cOffP:0.4, cCallP:0.2, cashLive:666.7,
  },
  setting: {
    s1: { leads:130, calls:375, decroches:45, propRdv:10, sets:5, presents:4, closes:4 },
    s2: { leads:130, calls:375, decroches:45, propRdv:10, sets:5, presents:4, closes:4 },
    s3: { leads:130, calls:375, decroches:45, propRdv:10, sets:5, presents:4, closes:4 },
    s4: { leads:130, calls:375, decroches:45, propRdv:10, sets:5, presents:4, closes:4 },
    decrochesP:0.12, engP:0.222, setP:0.5, showupP:0.8, cCallP:0.8,
  },
};

/* ═══════════════════════════════════════════════════════════
   DATA STORE
═══════════════════════════════════════════════════════════ */
const DB = {
  months: ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'],

  // Données brutes saisies (remplacées par Firestore)
  _raw: {
    closing: {
      s1: { calls:8,  lives:2, offres:1, closes:0, hc:0, fu:0, contracte:0,     collecte:0    },
      s2: { calls:8,  lives:4, offres:2, closes:2, hc:2, fu:0, contracte:12000, collecte:1000 },
      s3: { calls:9,  lives:6, offres:3, closes:1, hc:1, fu:0, contracte:5400,  collecte:400  },
      s4: { calls:9,  lives:7, offres:2, closes:0, hc:0, fu:0, contracte:1800,  collecte:200  },
    },
    setting: {
      s1: { leads:133, calls:231, decroches:56, propRdv:13, sets:9,  presents:2, closes:0 },
      s2: { leads:191, calls:324, decroches:54, propRdv:17, sets:11, presents:4, closes:2 },
      s3: { leads:127, calls:178, decroches:38, propRdv:16, sets:11, presents:4, closes:1 },
      s4: { leads:100, calls:150, decroches:28, propRdv:15, sets:10, presents:4, closes:0 },
    },
    deals: [
      { client:'Julie Berchoux',     email:'julieberchoux@icloud.com',         offre:'BP 12', type:'Closing', date:'24/01/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting après self booking', ok:true  },
      { client:'Corinne Alaga',      email:'contact@lestabliersgourmands.com', offre:'BP 12', type:'Setting', date:'27/01/2026', cHT:null, coHT:null,  comm:125, bonus:0, notes:"Setting d'un close d'Elodie", ok:true  },
      { client:'Belinda Giangiulio', email:'lesdemoisellesduvrac@gmail.com',   offre:'BP 12', type:'Closing', date:'30/01/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',         ok:true  },
      { client:'Cecile Auneau',      email:'domcecile@gmail.com',              offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',         ok:true  },
      { client:'Justine Biton',      email:'lephildesidees@hotmail.com',       offre:'BP 12', type:'Closing', date:'09/02/2026', cHT:6000, coHT:500,  comm:500, bonus:0, notes:'Setting no-booking',         ok:true  },
    ],
  },

  // Calculé depuis _raw
  closing: null,
  setting: null,
  commissions: {
    'Janvier 2026': { contracte:12000, collecte:0,    totalComm:0,    statut:'Validé',     deals:[] },
    'Février 2026': { contracte:24000, collecte:2000, totalComm:2125, statut:'En attente', deals:[] },
    'Mars 2026':    { contracte:0,     collecte:0,    totalComm:1625, statut:'En attente', deals:[] },
  },
  team: {
    week: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444', contracte:33020, collecte:3342,  calls:23, lives:20, offres:14, closes:6, showup:0.87, txOffre:0.70,  txTransfoShow:0.30,  txTransfoOffre:0.429, caCall:1435.7 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa', contracte:22748, collecte:13629, calls:29, lives:24, offres:19, closes:7, showup:0.83, txOffre:0.792, txTransfoShow:0.292, txTransfoOffre:0.368, caCall:784.4  },
    ],
    month: [
      { name:'Guillaume', role:'Closing + Setting', color:'#ef4444', contracte:48469, collecte:4686, calls:56, lives:33, offres:17, closes:9, showup:0.589, txOffre:0.515, txTransfoShow:0.273, txTransfoOffre:0.529, caCall:721.3 },
      { name:'Elodie',    role:'Closing',           color:'#60a5fa', contracte:34069, collecte:3966, calls:46, lives:28, offres:13, closes:7, showup:0.609, txOffre:0.464, txTransfoShow:0.25,  txTransfoOffre:0.538, caCall:617.2 },
    ],
  },

  // Recalcule toutes les métriques depuis _raw
  compute() {
    const rc = DB._raw.closing;
    const rs = DB._raw.setting;
    const pc = PROJECTIONS.closing;
    const ps = PROJECTIONS.setting;

    const sumC  = k => ['s1','s2','s3','s4'].reduce((t,w) => t + (rc[w][k]||0), 0);
    const sumS  = k => ['s1','s2','s3','s4'].reduce((t,w) => t + (rs[w][k]||0), 0);
    const projC = k => ['s1','s2','s3','s4'].reduce((t,w) => t + (pc[w][k]||0), 0);
    const projS = k => ['s1','s2','s3','s4'].reduce((t,w) => t + (ps[w][k]||0), 0);

    const ca=sumC('calls'), la=sumC('lives'), oa=sumC('offres'), cla=sumC('closes');
    const cta=sumC('contracte'), cola=sumC('collecte');
    const cp=projC('calls'), lp=projC('lives'), op=projC('offres'), clp=projC('closes');
    const ctp=projC('contracte'), colp=projC('collecte');

    DB.closing = {
      mois: {
        calls:     {a:ca,  p:cp  },
        lives:     {a:la,  p:lp  },
        offres:    {a:oa,  p:op  },
        closes:    {a:cla, p:clp },
        hc:        {a:sumC('hc'), p:clp},
        fu:        {a:sumC('fu'), p:0  },
        contracte: {a:cta, p:ctp },
        collecte:  {a:cola,p:colp},
        livesP:  {a:ca>0  ? la/ca   : 0, p:pc.livesP  },
        offresP: {a:la>0  ? oa/la   : 0, p:pc.offresP },
        engP:    {a:oa>0  ? cla/oa  : 0, p:pc.engP    },
        cOffP:   {a:oa>0  ? cla/oa  : 0, p:pc.cOffP   },
        cCallP:  {a:ca>0  ? cla/ca  : 0, p:pc.cCallP  },
        cashLive:{a:la>0  ? cta/la  : 0, p:pc.cashLive},
        atteinte: ctp>0 ? cta/ctp : 0,
        delta:    Math.max(0, ctp-cta),
      },
      s1: DB._cw('s1'), s2: DB._cw('s2'), s3: DB._cw('s3'), s4: DB._cw('s4'),
    };

    const sca=sumS('calls'), da=sumS('decroches'), pa=sumS('propRdv');
    const sa=sumS('sets'), pra=sumS('presents'), sca2=sumS('closes');

    DB.setting = {
      mois: {
        leads:     {a:sumS('leads'),  p:projS('leads')    },
        calls:     {a:sca,            p:projS('calls')    },
        decroches: {a:da,             p:projS('decroches')},
        propRdv:   {a:pa,             p:projS('propRdv')  },
        sets:      {a:sa,             p:projS('sets')     },
        presents:  {a:pra,            p:projS('presents') },
        closes:    {a:sca2,           p:projS('closes')   },
        decrochesP:{a:sca>0?da/sca:0,  p:ps.decrochesP },
        engP:      {a:da>0 ?pa/da:0,    p:ps.engP       },
        setP:      {a:pa>0 ?sa/pa:0,    p:ps.setP       },
        showupP:   {a:sa>0 ?pra/sa:0,   p:ps.showupP    },
        cCallP:    {a:sca>0?sca2/sca:0, p:ps.cCallP     },
      },
      s1: DB._sw('s1'), s2: DB._sw('s2'), s3: DB._sw('s3'), s4: DB._sw('s4'),
    };

    // Sync deals dans commissions
    try {
      const cmk = (typeof localStorage !== 'undefined' && localStorage.getItem('sales_month')) || 'Février 2026';
      if (DB.commissions[cmk]) DB.commissions[cmk].deals = DB._raw.deals;
    } catch(e) {}
  },

  _cw(w) {
    const d=DB._raw.closing[w], p=PROJECTIONS.closing[w];
    return {
      calls:{a:d.calls||0,p:p.calls}, lives:{a:d.lives||0,p:p.lives},
      offres:{a:d.offres||0,p:p.offres}, closes:{a:d.closes||0,p:p.closes},
      hc:{a:d.hc||0,p:p.closes}, fu:{a:d.fu||0,p:0},
      contracte:{a:d.contracte||0,p:p.contracte}, collecte:{a:d.collecte||0,p:p.collecte},
    };
  },
  _sw(w) {
    const d=DB._raw.setting[w], p=PROJECTIONS.setting[w];
    return {
      leads:{a:d.leads||0,p:p.leads}, calls:{a:d.calls||0,p:p.calls},
      decroches:{a:d.decroches||0,p:p.decroches}, propRdv:{a:d.propRdv||0,p:p.propRdv},
      sets:{a:d.sets||0,p:p.sets}, presents:{a:d.presents||0,p:p.presents},
      closes:{a:d.closes||0,p:p.closes},
    };
  },
};

DB.compute();

/* ═══════════════════════════════════════════════════════════
   FIREBASE — couche temps réel
   Initialisé après que firebase SDK soit chargé + auth ready
═══════════════════════════════════════════════════════════ */
const Fire = {
  db:  null,
  uid: null,
  _unsubs: [],

  init(firestore, uid) {
    Fire.db  = firestore;
    Fire.uid = uid;
  },

  _key(label) {
    const p = label.split(' ');
    const m = DB.months.indexOf(p[0]);
    return `${p[1]}-${String(m+1).padStart(2,'0')}`;
  },

  // Écoute en temps réel les données d'un user pour un mois
  watchUser(userId, monthLabel, callback) {
    if (!Fire.db) return () => {};
    const ref = Fire.db
      .collection('saisies').doc(userId)
      .collection('mois').doc(Fire._key(monthLabel));
    const unsub = ref.onSnapshot(snap => callback(snap.exists ? snap.data() : null));
    Fire._unsubs.push(unsub);
    return unsub;
  },

  // Sauvegarde une semaine de closing
  async saveClosing(userId, monthLabel, week, data) {
    if (!Fire.db) throw new Error('Firebase non init');
    const ref = Fire.db.collection('saisies').doc(userId)
      .collection('mois').doc(Fire._key(monthLabel));
    await ref.set({ closing: { [week]: data } }, { merge: true });
  },

  // Sauvegarde une semaine de setting
  async saveSetting(userId, monthLabel, week, data) {
    if (!Fire.db) throw new Error('Firebase non init');
    const ref = Fire.db.collection('saisies').doc(userId)
      .collection('mois').doc(Fire._key(monthLabel));
    await ref.set({ setting: { [week]: data } }, { merge: true });
  },

  // Sauvegarde un deal (append)
  async saveDeal(userId, monthLabel, deal) {
    if (!Fire.db) throw new Error('Firebase non init');
    const ref = Fire.db.collection('saisies').doc(userId)
      .collection('mois').doc(Fire._key(monthLabel));
    const snap = await ref.get();
    const deals = snap.exists ? (snap.data().deals || []) : [];
    deals.push({ ...deal, _ts: Date.now() });
    await ref.set({ deals }, { merge: true });
  },

  // Applique un snapshot Firestore dans DB puis recalcule
  apply(data) {
    if (!data) return;
    if (data.closing) ['s1','s2','s3','s4'].forEach(w => {
      if (data.closing[w]) Object.assign(DB._raw.closing[w], data.closing[w]);
    });
    if (data.setting) ['s1','s2','s3','s4'].forEach(w => {
      if (data.setting[w]) Object.assign(DB._raw.setting[w], data.setting[w]);
    });
    if (data.deals) DB._raw.deals = data.deals;
    DB.compute();
    document.dispatchEvent(new CustomEvent('db:updated'));
  },

  stop() { Fire._unsubs.forEach(u => u()); Fire._unsubs = []; },
};

/* ═══════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════ */
const U = {
  euro:  v => v == null ? '—' : '€\u202f' + Number(v).toLocaleString('fr-FR'),
  pct:   v => v == null ? '—' : (v * 100).toFixed(1) + '%',
  num:   v => v == null ? '—' : Number(v).toLocaleString('fr-FR'),
  pp:  (a, p) => p > 0 ? Math.min((a / p) * 100, 200) : 0,
  ppv: (a, p) => p > 0 ? ((a / p) * 100).toFixed(0) + '%' : '—',
  cb:  (a, p) => { const r = p > 0 ? a / p : 0; return r >= 1 ? '#34d399' : r >= 0.65 ? '#f59e0b' : '#ef4444'; },
  g:   id => document.getElementById(id),
  getCurrentMonth: () => (typeof localStorage !== 'undefined' && localStorage.getItem('sales_month')) || 'Février 2026',
  getCurrentUser:  () => ({
    uid:  window._currentUserUid  || localStorage.getItem('ambitio_uid')  || 'guillaume',
    name: window._currentUserName || localStorage.getItem('ambitio_name') || 'Guillaume',
    role: window._currentRole     || localStorage.getItem('ambitio_role') || 'sales',
  }),

  progRow: (label, a, p, isEuro = false) => {
    const col = U.cb(a, p);
    return `<div class="pr">
      <div class="pr-l">${label}</div>
      <div class="pr-track"><div class="pr-fill" style="width:${Math.min(U.pp(a,p),100)}%;background:${col}"></div></div>
      <div class="pr-val">${isEuro ? `${U.euro(a)} / ${U.euro(p)}` : `${a} / ${p}`}</div>
      <div class="pr-pct" style="color:${col}">${U.ppv(a,p)}</div>
    </div>`;
  },

  kpiCard: ({ label, val, sub, rawA, proj, color='#ef4444', pct:fp }) => {
    const pc = fp!=null ? fp : (proj!=null ? U.pp(rawA??0, proj) : null);
    return `<div class="kpi" style="--kc:${color}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
      ${pc!=null ? `<div class="kpi-prog">
        <div class="kpi-prog-row"><span>Atteinte</span><span>${pc.toFixed(0)}%</span></div>
        <div class="kpi-prog-track"><div class="kpi-prog-fill" style="width:${Math.min(pc,100)}%;background:${color}"></div></div>
      </div>` : ''}
    </div>`;
  },

  funnelStep: (label, val, max, isFirst=false, isEuro=false) => {
    const ratio = max > 0 ? val / max : 0;
    return `<div class="fs">
      <div class="fs-label">${label}</div>
      <div class="fs-track"><div class="fs-fill" style="width:${Math.min(ratio*100,100)}%"></div></div>
      <div class="fs-val">${isEuro ? U.euro(val) : val}</div>
      <div class="fs-rate">${!isFirst ? U.pct(ratio) : ''}</div>
    </div>`;
  },

  weekCard: (label, mainVal, mainLabel, minis, isCurrent) => `
    <div class="wc${isCurrent?' wc-active':''}">
      <div class="wc-label">${label}</div>
      <div class="wc-main">${mainVal}</div>
      <div class="wc-sub">${mainLabel}</div>
      <div class="wc-grid">${minis.map(m=>`
        <div class="wc-mini">
          <div class="wc-mini-v"${m.color?` style="color:${m.color}"`:''} >${m.val}</div>
          <div class="wc-mini-l">${m.label}</div>
        </div>`).join('')}</div>
    </div>`,

  barChart: (labels, actuals, projs, unit='') => {
    const mx = Math.max(...actuals, ...projs, 1);
    return `<div class="chart-legend">
        <span class="cl-dot cl-real"></span>Réel
        <span class="cl-dot cl-proj" style="margin-left:14px"></span>Projection
      </div>
      <div class="chart-bars">
        ${labels.map((l,i)=>`<div class="chart-col">
          <div class="chart-pair">
            <div class="chart-bar bar-real" style="height:${(actuals[i]/mx*100).toFixed(1)}%" title="${actuals[i]}${unit}"></div>
            <div class="chart-bar bar-proj" style="height:${(projs[i]/mx*100).toFixed(1)}%" title="Proj:${projs[i]}${unit}"></div>
          </div>
          <div class="chart-lbl">${l}</div>
        </div>`).join('')}
      </div>`;
  },

  toast: (msg, type='success') => {
    let t = document.getElementById('_toast');
    if (!t) { t=document.createElement('div'); t.id='_toast'; document.body.appendChild(t); }
    const s = { success:'background:#1a2e1a;border:1px solid rgba(52,211,153,.3);color:#6ee7b7', error:'background:#2e1a1a;border:1px solid rgba(239,68,68,.3);color:#fca5a5', info:'background:#1a1a2e;border:1px solid rgba(96,165,250,.3);color:#93c5fd' };
    t.style.cssText = `position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(0);font-size:12px;font-weight:600;padding:9px 18px;border-radius:10px;z-index:9999;opacity:1;transition:all .28s;white-space:nowrap;font-family:var(--font-b);${s[type]||s.success}`;
    t.textContent = msg;
    clearTimeout(t._t);
    t._t = setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateX(-50%) translateY(20px)'; }, 2800);
  },
};

window.DB=DB; window.U=U; window.Fire=Fire; window.PROJECTIONS=PROJECTIONS;
