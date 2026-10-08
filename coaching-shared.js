/**
 * coaching-shared.js
 * Fonctions utilitaires partagées entre toutes les pages coaching
 * (coaching.html, coaching-dashboard.html, coaching-analyse.html, coaching-agenda.html)
 */

// ── STATE GLOBAL ──
window._coachingClients = window._coachingClients || [];
window._coachingDataLoaded = window._coachingDataLoaded || false;

const ALERT_DAYS = 21;
const WARN_DAYS  = 14;

// ── QUOTA ──
/* Quota MENSUEL = nombre de séances ÷ durée du programme, lus sur le libellé.
   Règle unique du produit, alignée sur coaching.html:1529 et sur
   monthlyQuotaFromProgramme() dans api/_recurrence-core.js — c'est cette
   dernière qui décide du blocage réel à la réservation.

     BP 12 Mois - 12C         → 12/12 = 1
     BP 12 Mois - 24C         → 24/12 = 2
     BP 6 Mois - 6C           →  6/6  = 1   (programme arrêté le 13/08/2026)
     Elite - 12 Mois - 24C    → 24/12 = 2
     Elite NEW - 6 Mois - 24C → 24/6  = 4   ← était affiché 2 ici

   Ce fichier était resté sur l'ancienne règle « 24c → 2 » : les dashboards
   coach affichaient donc 2/mois à un Elite NEW qui a droit à 4, et le
   marquaient « quota atteint » dès sa 2e séance. Libellé non reconnu → repli
   sur l'ancienne table. */
function getMonthlyQuota(programme) {
  if (!programme) return 1;
  const p = String(programme).toLowerCase();
  const mMois = p.match(/(\d+)\s*mois/);
  const mSeances = p.match(/(\d+)\s*c\b/);
  if (mMois && mSeances) {
    const mois = parseInt(mMois[1], 10), seances = parseInt(mSeances[1], 10);
    if (mois > 0 && seances > 0) return Math.max(1, Math.round(seances / mois));
  }
  if (p.includes('24c')) return 2;
  if (p.includes('12c')) return 1;
  if (p.includes('6c'))  return 1;
  return 1;
}

/* Quota EFFECTIF d'un mois donné : l'override posé par un coach/admin sur la
   fiche client (clients/{id}.quotaOverrides["YYYY-MM"]) prime sur la règle
   dérivée du programme. Même arbitrage que api/booking-check-coaching-quota.js
   — sans lui, un mois d'exception accordé au client restait invisible ici. */
function getEffectiveQuota(c, year, month) {
  const derived = getMonthlyQuota(c && c.programme);
  if (!c || !c.quotaOverrides) return derived;
  const key = year + '-' + String(month + 1).padStart(2, '0');
  const ov = c.quotaOverrides[key];
  return (typeof ov === 'number' && ov >= 0) ? ov : derived;
}

/* Aplatit les séances d'un client, quelle que soit la forme de stockage.
   `years[].sessions[]` est la forme courante : coaching.html la crée pour
   tout nouveau client et migre les anciens au chargement. `sessions[]` à
   plat est la forme legacy, conservée en repli.
   Strictement identique à getAllSessions() de coaching.html:1545,
   getAllCoachingSessions() de csm-clients.html:1329 et flattenSessions()
   de api/booking-check-coaching-quota.js. */
function getAllSessions(c) {
  if (!c) return [];
  if (c.years && c.years.length) {
    const all = [];
    c.years.forEach(y => (y.sessions || []).forEach(s => all.push(s)));
    return all;
  }
  return c.sessions || [];
}

/* Séances RÉALISÉES d'un mois donné, au sens du quota.
   La séance 72 h (numero 0 / type 'rdv72h') est toujours exclue : elle
   n'entre pas dans le quota mensuel. Même filtre que coaching.html:1554. */
function getSessionsInMonth(c, year, month) {
  return getAllSessions(c).filter(s => {
    if (!s || s.statut !== 'fait' || !s.date) return false;
    if (s.numero === 0 || s.type === 'rdv72h') return false;
    const d = new Date(s.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

function getQuotaStatus(c, year, month) {
  const done  = c.nbCoachingsFaits || 0;
  const total = c.nbCoachingsTotal  || 12;
  if (done >= total) return { status: 'done', used: 0, max: 0, label: 'Terminé' };
  const quota    = getEffectiveQuota(c, year, month);
  const sessions = getSessionsInMonth(c, year, month);
  const used     = sessions.length;
  if (used >= quota) return { status: 'ok',      used, max: quota, label: `${used}/${quota}` };
  if (used > 0)      return { status: 'partial',  used, max: quota, label: `${used}/${quota}` };
  return               { status: 'empty',   used: 0, max: quota, label: `0/${quota}` };
}

function getQuotaHistory(c) {
  const months = [];
  const now    = new Date();
  const entry  = c.dateEntree ? new Date(c.dateEntree) : null;
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    if (entry && d < new Date(entry.getFullYear(), entry.getMonth(), 1)) continue;
    const q = getQuotaStatus(c, d.getFullYear(), d.getMonth());
    months.push({ year: d.getFullYear(), month: d.getMonth(),
      label: d.toLocaleDateString('fr-FR', { month: 'short' }), ...q });
  }
  return months;
}

// ── ALERT ──
function getAlertStatus(c) {
  const done  = c.nbCoachingsFaits || 0;
  const total = c.nbCoachingsTotal  || 12;
  if (done >= total) return 'ok';
  if (!c.lastSessionDate) return 'alert';
  const diff = (Date.now() - new Date(c.lastSessionDate).getTime()) / 86400000;
  if (diff > ALERT_DAYS) return 'alert';
  if (diff > WARN_DAYS)  return 'warning';
  return 'ok';
}

function getAlertText(c) {
  const done  = c.nbCoachingsFaits || 0;
  const total = c.nbCoachingsTotal  || 12;
  if (done >= total) return '';
  if (!c.lastSessionDate) return 'Aucune séance';
  const diff = Math.floor((Date.now() - new Date(c.lastSessionDate).getTime()) / 86400000);
  if (diff > ALERT_DAYS) return `${diff}j sans coaching`;
  if (diff > WARN_DAYS)  return `${diff}j depuis dernier`;
  return '';
}

// ── UTILS ──
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return d; }
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  setTimeout(() => t.className = 'toast', 3200);
}

// ── LOAD CLIENTS (shared, with cache) ──
window.loadCoachingClients = async function (callback) {
  if (!window._uid) return;

  // Already loaded this session — use cache
  if (window._coachingDataLoaded && window._coachingClients.length) {
    if (callback) callback(window._coachingClients);
    return;
  }

  try {
    const snap = await window._getDocs(window._collection(window._db, 'clients'));
    const clients = [];
    snap.forEach(d => {
      const data = d.data();
      data._id = d.id;
      clients.push(data);
    });
    window._coachingClients = clients;
    window._coachingDataLoaded = true;
  } catch (e) {
    console.warn('Load clients error:', e);
    window._coachingClients = [];
  }

  if (callback) callback(window._coachingClients);
};

// ── NAV TABS — active state based on current page ──
window.setCoachingNavActive = function () {
  const page = window.location.pathname.split('/').pop();
  document.querySelectorAll('.cnav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
};
