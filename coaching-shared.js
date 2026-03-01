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
function getMonthlyQuota(programme) {
  if (!programme) return 1;
  const p = programme.toLowerCase();
  if (p.includes('24c')) return 2;
  if (p.includes('12c')) return 1;
  if (p.includes('6c'))  return 1;
  return 1;
}

function getSessionsInMonth(c, year, month) {
  return (c.sessions || []).filter(s => {
    if (s.statut !== 'fait' || !s.date) return false;
    const d = new Date(s.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

function getQuotaStatus(c, year, month) {
  const done  = c.nbCoachingsFaits || 0;
  const total = c.nbCoachingsTotal  || 12;
  if (done >= total) return { status: 'done', used: 0, max: 0, label: 'Terminé' };
  const quota    = getMonthlyQuota(c.programme);
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
