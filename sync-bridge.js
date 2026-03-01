/**
 * sync-bridge.js — Bridge de synchronisation localStorage → DB
 * VERSION 2 — Robuste, source unique de vérité
 *
 * Lit les données saisies dans Closing, Setting, Commissions (par uid + mois)
 * et les injecte dans DB._raw + DB.commissions + DB.team pour que
 * Dashboard, Projections et Équipe soient toujours synchronisés.
 *
 * Clés localStorage :
 *   closing_{uid}_{monthKey}    → { s1..s5: {calls,lives,offres,closes,hardClose,followUp,contracte,collecte} }
 *   setting_{uid}_{monthKey}    → { s1..s5: {leads,calls,decroches,propRdv,sets,presents,closes} }
 *   comm_deals_{uid}_{monthKey} → [{client,offre,type,subtype,contracteHT,collecteHT,comm,bonus,ok,...}]
 *   comm_statut_{monthKey}      → 'Validé' | 'En attente' | 'Partiel'
 *
 * monthKey = "Février 2026" (identique à sales_month)
 */

const SYNC_UIDS = ['guillaume', 'elodie'];
const SYNC_MEMBERS = [
  { uid: 'guillaume', name: 'Guillaume', role: 'Closing + Setting', color: '#ef4444' },
  { uid: 'elodie',    name: 'Élodie',    role: 'Closing',           color: '#60a5fa' },
];

/* ──────────────────────────────────────────────────────────
   RÈGLES DE COMMISSION (miroir de sales-commissions.html)
────────────────────────────────────────────────────────── */
const _COMM_RULES = {
  closing: {
    'BP 6':  { mensualise: 250,  pif: 300  },
    'BP 12': { mensualise: 500,  pif: 600  },
    'Elite': { mensualise: 800,  pif: 900  },
    'Titan': { mensualise: 1200, pif: 1500 },
  },
  setting: {
    'BP 6':  { noBooking: 100, selfBooking: 50  },
    'BP 12': { noBooking: 250, selfBooking: 125 },
    'Elite': { noBooking: 300, selfBooking: 150 },
    'Titan': { noBooking: 500, selfBooking: 250 },
  },
};

function _calcDealComm(deal) {
  if (!deal.ok) return 0;
  // If comm already set manually, use it
  const t = (deal.type || '').toLowerCase();
  const rules = _COMM_RULES[t];
  if (!rules) return deal.comm || 0;
  const offre = deal.offre || 'BP 12';
  const r = rules[offre] || rules['BP 12'];
  if (!r) return deal.comm || 0;
  const sub = (deal.subtype || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'closing') {
    return sub.includes('pif') ? r.pif : r.mensualise;
  } else {
    return sub.includes('self') ? r.selfBooking : r.noBooking;
  }
}

/* ──────────────────────────────────────────────────────────
   FONCTION PRINCIPALE
────────────────────────────────────────────────────────── */
function syncBridge_loadMonth(monthKey) {
  if (!monthKey) monthKey = (typeof localStorage !== 'undefined' && localStorage.getItem('sales_month')) || 'Février 2026';
  if (typeof DB === 'undefined') return; // DB pas encore chargé

  /* ── 1. Agréger closing et setting par semaine (tous membres) ── */
  const closingAgg = { s1: {}, s2: {}, s3: {}, s4: {}, s5: {} };
  const settingAgg = { s1: {}, s2: {}, s3: {}, s4: {}, s5: {} };
  const closingPerMember = {};
  const settingPerMember = {};

  SYNC_UIDS.forEach(uid => {
    /* ── Closing ── */
    let cr = null;
    try {
      const v = localStorage.getItem(`closing_${uid}_${monthKey}`);
      cr = v ? JSON.parse(v) : null;
    } catch (e) {}
    closingPerMember[uid] = cr;

    if (cr) {
      ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
        const d = cr[w] || {};
        const a = closingAgg[w];
        ['calls', 'lives', 'offres', 'closes', 'hardClose', 'followUp', 'contracte', 'collecte'].forEach(k => {
          a[k] = (a[k] || 0) + (d[k] || 0);
        });
        // Alias hc/fu
        a.hc = (a.hc || 0) + (d.hardClose || d.hc || 0);
        a.fu = (a.fu || 0) + (d.followUp  || d.fu  || 0);
      });
    }

    /* ── Setting ── */
    let sr = null;
    try {
      const v = localStorage.getItem(`setting_${uid}_${monthKey}`);
      sr = v ? JSON.parse(v) : null;
    } catch (e) {}
    settingPerMember[uid] = sr;

    if (sr) {
      ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
        const d = sr[w] || {};
        const a = settingAgg[w];
        ['leads', 'calls', 'decroches', 'propRdv', 'sets', 'presents', 'closes'].forEach(k => {
          a[k] = (a[k] || 0) + (d[k] || 0);
        });
      });
    }
  });

  /* ── Détecter si des données localStorage existent pour ce mois ── */
  const hasClosingData = SYNC_UIDS.some(uid => closingPerMember[uid] !== null);
  const hasSettingData = SYNC_UIDS.some(uid => settingPerMember[uid] !== null);

  /* ── 2. Injecter dans DB._raw seulement si des données existent ── */
  if (hasClosingData) {
    ['s1', 's2', 's3', 's4'].forEach(w => {
      const ca = closingAgg[w] || {};
      DB._raw.closing[w] = {
        calls:     ca.calls     || 0,
        lives:     ca.lives     || 0,
        offres:    ca.offres    || 0,
        closes:    ca.closes    || 0,
        hc:        ca.hc        || 0,
        fu:        ca.fu        || 0,
        contracte: ca.contracte || 0,
        collecte:  ca.collecte  || 0,
      };
    });
    // Fusionner s5 dans s4
    const s5c = closingAgg.s5 || {};
    if (Object.values(s5c).some(v => v > 0)) {
      Object.keys(DB._raw.closing.s4).forEach(k => {
        DB._raw.closing.s4[k] = (DB._raw.closing.s4[k] || 0) + (s5c[k] || 0);
      });
    }
  }

  if (hasSettingData) {
    ['s1', 's2', 's3', 's4'].forEach(w => {
      const sa = settingAgg[w] || {};
      DB._raw.setting[w] = {
        leads:     sa.leads     || 0,
        calls:     sa.calls     || 0,
        decroches: sa.decroches || 0,
        propRdv:   sa.propRdv   || 0,
        sets:      sa.sets      || 0,
        presents:  sa.presents  || 0,
        closes:    sa.closes    || 0,
      };
    });
    // Fusionner s5 dans s4
    const s5s = settingAgg.s5 || {};
    if (Object.values(s5s).some(v => v > 0)) {
      Object.keys(DB._raw.setting.s4).forEach(k => {
        DB._raw.setting.s4[k] = (DB._raw.setting.s4[k] || 0) + (s5s[k] || 0);
      });
    }
  }

  /* ── 3. Agréger les deals de commissions ── */
  let totalComm      = 0;
  let totalContracte = 0;
  let totalCollecte  = 0;
  const allDeals     = [];
  const commPerMember = {};
  let hasDealsData = false;

  SYNC_UIDS.forEach(uid => {
    let deals = null;
    try {
      const v = localStorage.getItem(`comm_deals_${uid}_${monthKey}`);
      deals = v ? JSON.parse(v) : null;
    } catch (e) {}

    if (deals && Array.isArray(deals) && deals.length > 0) {
      hasDealsData = true;
      const comm      = deals.reduce((t, d) => t + _calcDealComm(d), 0);
      const contracte = deals.filter(d => d.ok).reduce((t, d) => t + (d.contracteHT || d.cHT || 0), 0);
      const collecte  = deals.filter(d => d.ok).reduce((t, d) => t + (d.collecteHT  || d.coHT || 0), 0);
      commPerMember[uid] = { comm, contracte, collecte, deals };
      totalComm      += comm;
      totalContracte += contracte;
      totalCollecte  += collecte;
      allDeals.push(...deals);
    } else {
      commPerMember[uid] = { comm: 0, contracte: 0, collecte: 0, deals: [] };
    }
  });

  /* ── 4. Statut commission (persisté séparément) ── */
  let statut = 'En attente';
  try {
    const savedStatut = localStorage.getItem(`comm_statut_${monthKey}`);
    if (savedStatut) statut = savedStatut;
  } catch (e) {}

  /* ── 5. Mettre à jour DB.commissions ── */
  // Toujours créer l'entrée pour ce mois
  if (hasDealsData || hasClosingData) {
    DB.commissions[monthKey] = {
      totalComm,
      contracte: totalContracte || (hasClosingData ? DB._raw.closing.s1.contracte + DB._raw.closing.s2.contracte + DB._raw.closing.s3.contracte + DB._raw.closing.s4.contracte : 0),
      collecte:  totalCollecte,
      statut,
      deals:     allDeals,
      perMember: commPerMember,
    };
  } else if (!DB.commissions[monthKey]) {
    // Créer une entrée vide pour éviter les erreurs
    DB.commissions[monthKey] = {
      totalComm: 0, contracte: 0, collecte: 0,
      statut: 'En attente', deals: [], perMember: {},
    };
  }

  /* ── 6. Mettre à jour DB.team par membre ── */
  const teamWeek  = [];
  const teamMonth = [];

  SYNC_MEMBERS.forEach(m => {
    const cr   = closingPerMember[m.uid];
    const sr   = settingPerMember[m.uid];
    const comm = commPerMember[m.uid] || { comm: 0, contracte: 0, collecte: 0 };

    function sumCk(k) {
      if (!cr) return 0;
      return ['s1', 's2', 's3', 's4', 's5'].reduce((t, w) => t + ((cr[w] || {})[k] || 0), 0);
    }
    function sumSk(k) {
      if (!sr) return 0;
      return ['s1', 's2', 's3', 's4', 's5'].reduce((t, w) => t + ((sr[w] || {})[k] || 0), 0);
    }

    const calls     = sumCk('calls');
    const lives     = sumCk('lives');
    const offres    = sumCk('offres');
    const closes    = sumCk('closes');
    const contracte = sumCk('contracte');
    const collecte  = sumCk('collecte');
    const sets      = sumSk('sets');
    const presents  = sumSk('presents');

    const entry = {
      name:            m.name,
      role:            m.role,
      color:           m.color,
      uid:             m.uid,
      contracte,
      collecte,
      calls,
      lives,
      offres,
      closes,
      sets,
      presents,
      showup:          calls  > 0 ? lives  / calls  : 0,
      txOffre:         lives  > 0 ? offres / lives  : 0,
      txTransfoShow:   lives  > 0 ? closes / lives  : 0,
      txTransfoOffre:  offres > 0 ? closes / offres : 0,
      caCall:          calls  > 0 ? contracte / calls : 0,
      comm:            comm.comm || 0,
    };

    teamMonth.push(entry);

    // Semaine la plus récente avec données
    const lastW = ['s4', 's3', 's2', 's1'].find(w => {
      const d = (cr || {})[w] || {};
      return Object.values(d).some(v => v > 0);
    });

    if (lastW) {
      const wd = (cr || {})[lastW] || {};
      const ws = (sr || {})[lastW] || {};
      const wc = wd.calls || 0;
      const wl = wd.lives || 0;
      const wo = wd.offres || 0;
      const wcl = wd.closes || 0;
      const wct = wd.contracte || 0;
      teamWeek.push({
        ...entry,
        calls:          wc,
        lives:          wl,
        offres:         wo,
        closes:         wcl,
        contracte:      wct,
        collecte:       wd.collecte  || 0,
        sets:           ws.sets      || 0,
        presents:       ws.presents  || 0,
        showup:         wc  > 0 ? wl  / wc  : 0,
        txOffre:        wl  > 0 ? wo  / wl  : 0,
        txTransfoShow:  wl  > 0 ? wcl / wl  : 0,
        txTransfoOffre: wo  > 0 ? wcl / wo  : 0,
        caCall:         wc  > 0 ? wct / wc  : 0,
      });
    } else {
      teamWeek.push({
        ...entry,
        calls: 0, lives: 0, offres: 0, closes: 0, contracte: 0, collecte: 0,
        sets: 0, presents: 0,
        showup: 0, txOffre: 0, txTransfoShow: 0, txTransfoOffre: 0, caCall: 0,
      });
    }
  });

  if (teamWeek.length)  DB.team.week  = teamWeek;
  if (teamMonth.length) DB.team.month = teamMonth;

  /* ── 7. Recalculer toutes les métriques ── */
  DB.compute();

  /* ── 8. Notifier tous les modules ── */
  document.dispatchEvent(new CustomEvent('db:updated', { detail: { monthKey } }));
}

/* ──────────────────────────────────────────────────────────
   ÉCOUTE DES CHANGEMENTS CROSS-ONGLETS
────────────────────────────────────────────────────────── */
window.addEventListener('storage', function (e) {
  const k = e.key || '';
  if (k.startsWith('closing_') || k.startsWith('setting_') || k.startsWith('comm_deals_') || k.startsWith('comm_statut_')) {
    const monthKey = (typeof currentMonthKey === 'function')
      ? currentMonthKey()
      : localStorage.getItem('sales_month') || 'Février 2026';
    syncBridge_loadMonth(monthKey);
    if (typeof renderAll === 'function') renderAll();
  }
});

/* ──────────────────────────────────────────────────────────
   HELPER : sauvegarder le statut commission
────────────────────────────────────────────────────────── */
function syncBridge_saveCommStatut(monthKey, statut) {
  try {
    localStorage.setItem(`comm_statut_${monthKey}`, statut);
    // Mettre à jour en mémoire
    if (typeof DB !== 'undefined' && DB.commissions[monthKey]) {
      DB.commissions[monthKey].statut = statut;
    }
    document.dispatchEvent(new CustomEvent('db:updated', { detail: { monthKey } }));
  } catch (e) {}
}

/* ──────────────────────────────────────────────────────────
   HELPER : obtenir les données d'un membre pour un mois
────────────────────────────────────────────────────────── */
function syncBridge_getMemberData(uid, monthKey) {
  let closing = null, setting = null, deals = null;
  try { const v = localStorage.getItem(`closing_${uid}_${monthKey}`);    closing = v ? JSON.parse(v) : null; } catch (e) {}
  try { const v = localStorage.getItem(`setting_${uid}_${monthKey}`);    setting = v ? JSON.parse(v) : null; } catch (e) {}
  try { const v = localStorage.getItem(`comm_deals_${uid}_${monthKey}`); deals   = v ? JSON.parse(v) : null; } catch (e) {}
  return { closing, setting, deals };
}

/* ──────────────────────────────────────────────────────────
   EXPORT GLOBAL
────────────────────────────────────────────────────────── */
window.syncBridge_loadMonth   = syncBridge_loadMonth;
window.syncBridge_saveCommStatut = syncBridge_saveCommStatut;
window.syncBridge_getMemberData  = syncBridge_getMemberData;
window.SYNC_UIDS    = SYNC_UIDS;
window.SYNC_MEMBERS = SYNC_MEMBERS;
