/**
 * sync-bridge.js — Bridge de synchronisation Firestore → DB
 * VERSION 3 — Firestore = source de vérité
 *
 * Lit les données saisies dans Firestore (saisies/{uid}/mois/{key})
 * pour tous les membres, et les injecte dans DB._raw + DB.commissions + DB.team
 * pour que Dashboard, Projections et Équipe soient toujours synchronisés.
 *
 * Firestore path : saisies/{uid}/mois/{YYYY-MM}
 *   → closing: { s1..s5: {calls,lives,offres,closes,hardClose,followUp,contracte,collecte} }
 *   → setting: { s1..s5: {leads,calls,decroches,propRdv,sets,presents,closes,collecte} }
 *   → closing_total / setting_total : données mensuelles agrégées (mois historiques)
 *   → deals: [{client,offre,type,...}]
 *
 * Fallback localStorage si Firestore indisponible.
 */

const SYNC_UIDS = ['guillaume', 'elodie'];
const SYNC_MEMBERS = [
  { uid: 'guillaume', name: 'Guillaume', role: 'Closing + Setting', color: '#ef4444' },
  { uid: 'elodie',    name: 'Élodie',    role: 'Closing',           color: '#60a5fa' },
];

/* ──────────────────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────────────────── */
const MONTHS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function _monthKeyToFirestore(monthKey) {
  // "Février 2026" → "2026-02"
  const parts = monthKey.split(' ');
  const m = MONTHS_FR.indexOf(parts[0]);
  if (m < 0) return null;
  return `${parts[1]}-${String(m + 1).padStart(2, '0')}`;
}

function _getDb() {
  // Fire.db est défini dans chaque page (sales-data.js inlined)
  if (typeof Fire !== 'undefined' && Fire.db) return Fire.db;
  if (typeof firebase !== 'undefined' && firebase.firestore) return firebase.firestore();
  return null;
}

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
   LIRE DONNÉES D'UN MEMBRE DEPUIS FIRESTORE
   Retourne { closing: {s1..s5}, setting: {s1..s5}, deals: [...] }
   ou null si pas de données
────────────────────────────────────────────────────────── */
async function _loadMemberFromFirestore(db, uid, monthKey) {
  const fsKey = _monthKeyToFirestore(monthKey);
  if (!fsKey || !db) return null;

  try {
    const ref = db.collection('saisies').doc(uid).collection('mois').doc(fsKey);
    const snap = await ref.get();
    if (!snap.exists) return null;

    const data = snap.data();
    const result = { closing: null, setting: null, deals: null };

    // Closing : données hebdo ou total mensuel
    if (data.closing) {
      result.closing = {};
      ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
        result.closing[w] = data.closing[w] || null;
      });
    }
    if (data.closing_total) {
      result.closing = { _total: data.closing_total };
    }

    // Setting : données hebdo ou total mensuel
    if (data.setting) {
      result.setting = {};
      ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
        result.setting[w] = data.setting[w] || null;
      });
    }
    if (data.setting_total) {
      result.setting = { _total: data.setting_total };
    }

    // Deals
    if (data.deals && Array.isArray(data.deals)) {
      result.deals = data.deals;
    }

    return result;
  } catch (e) {
    console.warn('[sync-bridge] Firestore read failed for', uid, monthKey, e.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────
   LIRE DONNÉES D'UN MEMBRE DEPUIS LOCALSTORAGE (fallback)
────────────────────────────────────────────────────────── */
function _loadMemberFromLocalStorage(uid, monthKey) {
  let closing = null, setting = null, deals = null;
  try { const v = localStorage.getItem(`closing_${uid}_${monthKey}`);    closing = v ? JSON.parse(v) : null; } catch (e) {}
  try { const v = localStorage.getItem(`setting_${uid}_${monthKey}`);    setting = v ? JSON.parse(v) : null; } catch (e) {}
  try { const v = localStorage.getItem(`comm_deals_${uid}_${monthKey}`); deals   = v ? JSON.parse(v) : null; } catch (e) {}
  return (closing || setting || deals) ? { closing, setting, deals } : null;
}

/* ──────────────────────────────────────────────────────────
   EXTRAIRE LES SEMAINES POUR AGRÉGATION
   Gère les _total (mois historiques) et les s1-s5 (mois courants)
────────────────────────────────────────────────────────── */
function _extractWeeks(data, type) {
  // type = 'closing' ou 'setting'
  const bloc = data[type];
  if (!bloc) return null;

  // Mois historique avec _total → répartir uniformément dans s1-s4
  if (bloc._total) {
    // On retourne _total comme une pseudo-semaine unique pour l'agrégation du mois
    return { _total: bloc._total };
  }

  return bloc;
}

/* ──────────────────────────────────────────────────────────
   FONCTION PRINCIPALE — ASYNC (lit Firestore)
────────────────────────────────────────────────────────── */
async function syncBridge_loadMonth(monthKey) {
  if (!monthKey) monthKey = (typeof localStorage !== 'undefined' && localStorage.getItem('sales_month')) || 'Février 2026';
  if (typeof DB === 'undefined') return;

  const db = _getDb();

  /* ── 1. Charger données de tous les membres ── */
  const memberData = {};
  for (const uid of SYNC_UIDS) {
    // Essayer Firestore d'abord, fallback localStorage
    let data = null;
    if (db) {
      data = await _loadMemberFromFirestore(db, uid, monthKey);
    }
    if (!data) {
      data = _loadMemberFromLocalStorage(uid, monthKey);
      if (data) console.log('[sync-bridge] Fallback localStorage pour', uid, monthKey);
    }
    memberData[uid] = data;
  }

  /* ── 2. Agréger closing et setting par semaine (tous membres) ── */
  const closingAgg = { s1: {}, s2: {}, s3: {}, s4: {}, s5: {} };
  const settingAgg = { s1: {}, s2: {}, s3: {}, s4: {}, s5: {} };
  const closingFields = ['calls', 'lives', 'offres', 'closes', 'hardClose', 'followUp', 'contracte', 'collecte'];
  const settingFields = ['leads', 'calls', 'decroches', 'propRdv', 'sets', 'presents', 'closes', 'collecte'];

  SYNC_UIDS.forEach(uid => {
    const data = memberData[uid];
    if (!data) return;

    // Closing
    if (data.closing) {
      if (data.closing._total) {
        // Mois historique : mettre tout dans s1, le reste à 0
        const tot = data.closing._total;
        closingFields.forEach(k => {
          closingAgg.s1[k] = (closingAgg.s1[k] || 0) + (tot[k] || 0);
        });
        closingAgg.s1.hc = (closingAgg.s1.hc || 0) + (tot.hardClose || tot.hc || 0);
        closingAgg.s1.fu = (closingAgg.s1.fu || 0) + (tot.followUp || tot.fu || 0);
      } else {
        ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
          const d = data.closing[w] || {};
          const a = closingAgg[w];
          closingFields.forEach(k => {
            a[k] = (a[k] || 0) + (d[k] || 0);
          });
          a.hc = (a.hc || 0) + (d.hardClose || d.hc || 0);
          a.fu = (a.fu || 0) + (d.followUp || d.fu || 0);
        });
      }
    }

    // Setting
    if (data.setting) {
      if (data.setting._total) {
        const tot = data.setting._total;
        settingFields.forEach(k => {
          settingAgg.s1[k] = (settingAgg.s1[k] || 0) + (tot[k] || 0);
        });
      } else {
        ['s1', 's2', 's3', 's4', 's5'].forEach(w => {
          const d = data.setting[w] || {};
          const a = settingAgg[w];
          settingFields.forEach(k => {
            a[k] = (a[k] || 0) + (d[k] || 0);
          });
        });
      }
    }
  });

  /* ── 3. Détecter si des données existent pour ce mois ── */
  const hasClosingData = SYNC_UIDS.some(uid => memberData[uid] && memberData[uid].closing);
  const hasSettingData = SYNC_UIDS.some(uid => memberData[uid] && memberData[uid].setting);

  /* ── 4. Injecter dans DB._raw ── */
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

  /* ── 5. Agréger les deals de commissions ── */
  let totalComm      = 0;
  let totalContracte = 0;
  let totalCollecte  = 0;
  const allDeals     = [];
  const commPerMember = {};
  let hasDealsData = false;

  SYNC_UIDS.forEach(uid => {
    const data = memberData[uid];
    const deals = data && data.deals;

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

  /* ── 6. Statut commission ── */
  let statut = 'En attente';
  try {
    const savedStatut = localStorage.getItem(`comm_statut_${monthKey}`);
    if (savedStatut) statut = savedStatut;
  } catch (e) {}

  /* ── 7. Mettre à jour DB.commissions ── */
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
    DB.commissions[monthKey] = {
      totalComm: 0, contracte: 0, collecte: 0,
      statut: 'En attente', deals: [], perMember: {},
    };
  }

  /* ── 8. Mettre à jour DB.team par membre ── */
  const teamWeek  = [];
  const teamMonth = [];

  SYNC_MEMBERS.forEach(m => {
    const data = memberData[m.uid] || {};
    const cr   = data.closing;
    const sr   = data.setting;
    const comm = commPerMember[m.uid] || { comm: 0, contracte: 0, collecte: 0 };

    function sumCk(k) {
      if (!cr) return 0;
      if (cr._total) return cr._total[k] || 0;
      return ['s1', 's2', 's3', 's4', 's5'].reduce((t, w) => t + ((cr[w] || {})[k] || 0), 0);
    }
    function sumSk(k) {
      if (!sr) return 0;
      if (sr._total) return sr._total[k] || 0;
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
    if (cr && !cr._total) {
      const lastW = ['s5', 's4', 's3', 's2', 's1'].find(w => {
        const d = cr[w] || {};
        return Object.values(d).some(v => v > 0);
      });

      if (lastW) {
        const wd = cr[lastW] || {};
        const ws = (sr && !sr._total) ? (sr[lastW] || {}) : {};
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
    } else {
      // Mois historique — copier les données mois dans week aussi
      teamWeek.push({ ...entry });
    }
  });

  if (teamWeek.length)  DB.team.week  = teamWeek;
  if (teamMonth.length) DB.team.month = teamMonth;

  /* ── 9. Recalculer toutes les métriques ── */
  DB.compute();

  /* ── 10. Notifier tous les modules ── */
  document.dispatchEvent(new CustomEvent('db:updated', { detail: { monthKey } }));

  console.log('[sync-bridge] Données chargées pour', monthKey,
    hasClosingData ? '✅ closing' : '⚠️ pas de closing',
    hasSettingData ? '✅ setting' : '⚠️ pas de setting');
}

/* ──────────────────────────────────────────────────────────
   WATCH TEMPS RÉEL — Firestore listeners pour tous les membres
────────────────────────────────────────────────────────── */
let _syncUnsubs = [];

function syncBridge_watchMonth(monthKey) {
  const db = _getDb();
  if (!db) return;

  // Nettoyer les anciens listeners
  _syncUnsubs.forEach(u => u());
  _syncUnsubs = [];

  const fsKey = _monthKeyToFirestore(monthKey);
  if (!fsKey) return;

  SYNC_UIDS.forEach(uid => {
    const ref = db.collection('saisies').doc(uid).collection('mois').doc(fsKey);
    const unsub = ref.onSnapshot(snap => {
      if (snap.exists) {
        console.log('[sync-bridge] 🔄 Mise à jour temps réel', uid, monthKey);
        // Recharger toutes les données (pour re-agréger)
        syncBridge_loadMonth(monthKey);
      }
    }, err => {
      console.warn('[sync-bridge] Watch error for', uid, ':', err.message);
    });
    _syncUnsubs.push(unsub);
  });
}

function syncBridge_stopWatch() {
  _syncUnsubs.forEach(u => u());
  _syncUnsubs = [];
}

/* ──────────────────────────────────────────────────────────
   ÉCOUTE DES CHANGEMENTS CROSS-ONGLETS (localStorage fallback)
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
    if (typeof DB !== 'undefined' && DB.commissions[monthKey]) {
      DB.commissions[monthKey].statut = statut;
    }
    document.dispatchEvent(new CustomEvent('db:updated', { detail: { monthKey } }));
  } catch (e) {}
}

/* ──────────────────────────────────────────────────────────
   HELPER : obtenir les données d'un membre pour un mois
────────────────────────────────────────────────────────── */
async function syncBridge_getMemberData(uid, monthKey) {
  const db = _getDb();
  if (db) {
    const data = await _loadMemberFromFirestore(db, uid, monthKey);
    if (data) return data;
  }
  return _loadMemberFromLocalStorage(uid, monthKey);
}

/* ──────────────────────────────────────────────────────────
   EXPORT GLOBAL
────────────────────────────────────────────────────────── */
window.syncBridge_loadMonth      = syncBridge_loadMonth;
window.syncBridge_watchMonth     = syncBridge_watchMonth;
window.syncBridge_stopWatch      = syncBridge_stopWatch;
window.syncBridge_saveCommStatut = syncBridge_saveCommStatut;
window.syncBridge_getMemberData  = syncBridge_getMemberData;
window.SYNC_UIDS    = SYNC_UIDS;
window.SYNC_MEMBERS = SYNC_MEMBERS;
