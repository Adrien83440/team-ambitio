// ============================================================================
// api/ai-admin.js — RÉGLAGES IA (page admin-ia.html) — admin uniquement
// ----------------------------------------------------------------------------
// GET  → { config, defaults, context, usage: {mois courant, mois précédent},
//          recent: 40 derniers appels ai_usage }
// GET ?report=month|prev|7d|30d → tableau de bord Dépenses (onglet 💶) :
//          agrégats de ai_usage par tâche, personne, modèle, jour, source,
//          projection de fin de mois. Lecture seule.
// POST { config?: {enabled, monthlyBudgetEur, alertPct, autoStopPct, eurPerUsd,
//                  emailAccount, extraEmails, tasks},
//        context?: string }
//
// Passe par l'Admin SDK : aucune règle Firestore à ouvrir pour _config/ai,
// _config/ai_context, ai_usage, ai_usage_months.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { getMonthUsage, monthKey, DEFAULT_TASKS, DEFAULT_CONFIG, PRICING } = require('./_ai');

function prevMonthKey() {
  const k = monthKey().split('-').map(Number);
  const d = new Date(Date.UTC(k[0], k[1] - 2, 15));
  return d.toISOString().slice(0, 7);
}

// ─── Rapport Dépenses ──────────────────────────────────────────────────────
const DAY_MS = 86400000;

function parisDay(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }

function daysInMonth(key) {
  const k = key.split('-').map(Number);
  return new Date(Date.UTC(k[0], k[1], 0)).getUTCDate();
}

// Membres d'équipe reliés par firebaseUid, puis users/{uid} en secours.
async function namesFor(uids) {
  const out = {};
  if (!uids.length) return out;
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw).map(function (k) { return Object.assign({ slug: k }, raw[k]); }) : []);
    list.forEach(function (m) {
      if (m && m.firebaseUid && uids.indexOf(m.firebaseUid) >= 0) out[m.firebaseUid] = { name: m.displayName || m.shortName || m.slug, role: m.role || '' };
    });
  } catch (e) { /* noms best-effort */ }
  const missing = uids.filter(function (u) { return !out[u]; });
  if (missing.length) {
    try {
      const snaps = await db.getAll.apply(db, missing.map(function (u) { return db.collection('users').doc(u); }));
      snaps.forEach(function (d) {
        if (!d.exists) return;
        const u = d.data() || {};
        out[d.id] = { name: u.displayName || u.name || u.prenom || u.email || d.id, role: u.role || '' };
      });
    } catch (e) { /* idem */ }
  }
  return out;
}

function bump(map, key, init) {
  if (!map[key]) map[key] = Object.assign({ calls: 0, costUsd: 0 }, init || {});
  return map[key];
}

async function buildReport(period) {
  const now = Date.now();
  const cur = monthKey();
  let q, label, monthForProjection = null, since = 0;
  if (period === 'prev') { const k = prevMonthKey(); q = db.collection('ai_usage').where('month', '==', k); label = k; }
  else if (period === '7d' || period === '30d') {
    since = now - (period === '7d' ? 7 : 30) * DAY_MS;
    q = db.collection('ai_usage').where('at', '>=', since); label = period === '7d' ? '7 derniers jours' : '30 derniers jours';
  } else { q = db.collection('ai_usage').where('month', '==', cur); label = cur; monthForProjection = cur; }

  const snap = await q.select('task', 'model', 'ok', 'error', 'costUsd', 'uid', 'source', 'at',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens').limit(30000).get();

  const tot = { calls: 0, costUsd: 0, autoCostUsd: 0, autoCalls: 0, errors: 0 };
  const byTask = {}, byUser = {}, byModel = {}, byDay = {};
  snap.forEach(function (d) {
    const u = d.data() || {};
    if (String(u.task || '').indexOf('mcp:') === 0) return; // lectures MCP, coût nul
    const cost = Number(u.costUsd) || 0;
    const auto = !u.uid;
    const task = u.task || '?';
    tot.calls++; tot.costUsd += cost;
    if (auto) { tot.autoCalls++; tot.autoCostUsd += cost; }
    if (u.ok === false) tot.errors++;

    const t = bump(byTask, task, { autoCalls: 0, autoCostUsd: 0, errors: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, models: {}, users: {}, lastAt: 0 });
    t.calls++; t.costUsd += cost;
    if (auto) { t.autoCalls++; t.autoCostUsd += cost; }
    if (u.ok === false) t.errors++;
    t.inTok += Number(u.inputTokens) || 0; t.outTok += Number(u.outputTokens) || 0;
    t.cacheRead += Number(u.cacheReadTokens) || 0; t.cacheWrite += Number(u.cacheWriteTokens) || 0;
    if (u.model) t.models[u.model] = (t.models[u.model] || 0) + 1;
    if (u.uid) t.users[u.uid] = (t.users[u.uid] || 0) + 1;
    if ((u.at || 0) > t.lastAt) { t.lastAt = u.at || 0; t.lastError = u.ok === false ? String(u.error || '').slice(0, 160) : null; }

    const who = bump(byUser, u.uid || '_auto', { tasks: {} });
    who.calls++; who.costUsd += cost;
    const wt = bump(who.tasks, task); wt.calls++; wt.costUsd += cost;

    const m = bump(byModel, u.model || '?'); m.calls++; m.costUsd += cost;

    if (u.at) { const dd = bump(byDay, parisDay(u.at), { autoCostUsd: 0 }); dd.calls++; dd.costUsd += cost; if (auto) dd.autoCostUsd += cost; }
  });

  const names = await namesFor(Object.keys(byUser).filter(function (k) { return k !== '_auto'; }));
  Object.keys(byUser).forEach(function (k) {
    byUser[k].name = k === '_auto' ? 'Automatique (crons)' : ((names[k] && names[k].name) || k);
    byUser[k].role = k === '_auto' ? '' : ((names[k] && names[k].role) || '');
  });
  Object.keys(byTask).forEach(function (k) {
    const t = byTask[k];
    t.users = Object.keys(t.users).map(function (uid) { return { name: (names[uid] && names[uid].name) || uid, calls: t.users[uid] }; })
      .sort(function (a, b) { return b.calls - a.calls; }).slice(0, 5);
  });

  // Jours couverts (pour la courbe) : du 1er du mois (ou de since) à aujourd'hui.
  const days = [];
  let start;
  if (period === 'prev') { const k = label.split('-').map(Number); start = Date.UTC(k[0], k[1] - 1, 1, 12); }
  else if (since) start = since;
  else { const k = cur.split('-').map(Number); start = Date.UTC(k[0], k[1] - 1, 1, 12); }
  // +12 h : le pas est calé sur midi UTC, aujourd'hui doit figurer même le matin.
  const end = period === 'prev' ? (function () { const k = label.split('-').map(Number); return Date.UTC(k[0], k[1], 0, 12); })() : now + DAY_MS / 2;
  for (let t = start; t <= end; t += DAY_MS) { const dk = parisDay(t); if (days.indexOf(dk) < 0) days.push(dk); }

  let projection = null;
  if (monthForProjection) {
    const dim = daysInMonth(monthForProjection);
    const today = Number(parisDay(now).slice(8, 10));
    const parisH = Number(new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false })) || 0;
    const elapsed = Math.max(0.25, (today - 1) + parisH / 24);
    // Rythme des 7 derniers jours pleins (plus parlant qu'une moyenne depuis
    // le 1er quand un réglage vient de changer), à défaut moyenne du mois.
    const last7 = days.slice(-8, -1);
    const sum7 = last7.reduce(function (s, dk) { return s + ((byDay[dk] && byDay[dk].costUsd) || 0); }, 0);
    const perDay = last7.length >= 3 ? sum7 / last7.length : tot.costUsd / elapsed;
    projection = { costUsd: tot.costUsd + perDay * Math.max(0, dim - elapsed), perDayUsd: perDay, daysInMonth: dim, elapsedDays: elapsed };
  }

  return {
    period: period || 'month', label: label, generatedAt: now,
    totals: tot, projection: projection,
    byTask: byTask, byUser: byUser, byModel: byModel, byDay: byDay, days: days,
    pricing: PRICING,
  };
}

function num(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function cleanTasks(t) {
  const out = {};
  if (!t || typeof t !== 'object') return out;
  Object.keys(t).forEach(function (k) {
    if (!DEFAULT_TASKS[k]) return;
    const v = t[k] || {};
    const o = {};
    if (v.enabled === false) o.enabled = false;
    if (v.model && /^claude-[a-z0-9.-]+$/.test(String(v.model))) o.model = String(v.model);
    if (v.effort && ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(v.effort) >= 0) o.effort = v.effort;
    if (Object.keys(o).length) out[k] = o;
  });
  return out;
}

module.exports = async function (req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    if (req.method === 'GET' && req.query && req.query.report) {
      const period = ['month', 'prev', '7d', '30d'].indexOf(String(req.query.report)) >= 0 ? String(req.query.report) : 'month';
      res.status(200).json(Object.assign({ ok: true }, await buildReport(period)));
      return;
    }

    if (req.method === 'GET') {
      const [cfgSnap, ctxSnap, cur, prev, recentSnap] = await Promise.all([
        db.collection('_config').doc('ai').get(),
        db.collection('_config').doc('ai_context').get(),
        getMonthUsage(monthKey()),
        getMonthUsage(prevMonthKey()),
        db.collection('ai_usage').orderBy('at', 'desc').limit(40).get(),
      ]);
      const recent = [];
      recentSnap.forEach(function (d) {
        const u = d.data() || {};
        recent.push({ task: u.task, model: u.model, ok: u.ok, error: u.error || null, costUsd: u.costUsd || 0, at: u.at, ref: u.ref || null,
          tokens: (u.inputTokens || 0) + (u.outputTokens || 0) });
      });
      res.status(200).json({
        ok: true,
        config: Object.assign({}, DEFAULT_CONFIG, cfgSnap.exists ? cfgSnap.data() : {}),
        defaults: { tasks: DEFAULT_TASKS },
        context: ctxSnap.exists ? String((ctxSnap.data() || {}).text || '') : '',
        contextUpdatedAt: ctxSnap.exists ? ((ctxSnap.data() || {}).updatedAt || null) : null,
        usage: { current: Object.assign({ month: monthKey() }, cur), previous: Object.assign({ month: prevMonthKey() }, prev) },
        recent: recent,
      });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
    const body = parseBody(req);
    const writes = [];

    if (body.config && typeof body.config === 'object') {
      const c = body.config;
      const patch = { updatedAt: Date.now(), updatedBy: auth.uid };
      if (typeof c.enabled === 'boolean') patch.enabled = c.enabled;
      if (c.monthlyBudgetEur != null) patch.monthlyBudgetEur = num(c.monthlyBudgetEur, 0, 5000, DEFAULT_CONFIG.monthlyBudgetEur);
      if (c.alertPct != null) patch.alertPct = num(c.alertPct, 10, 100, DEFAULT_CONFIG.alertPct);
      if (c.autoStopPct != null) patch.autoStopPct = num(c.autoStopPct, 10, 100, DEFAULT_CONFIG.autoStopPct);
      if (c.eurPerUsd != null) patch.eurPerUsd = num(c.eurPerUsd, 0.5, 1.5, DEFAULT_CONFIG.eurPerUsd);
      if (c.emailAccount && ['strategie', 'coaching', 'contact'].indexOf(c.emailAccount) >= 0) patch.emailAccount = c.emailAccount;
      if (Array.isArray(c.extraEmails)) patch.extraEmails = c.extraEmails.map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(function (e) { return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e); }).slice(0, 10);
      const ref = db.collection('_config').doc('ai');
      // tasks remplacé en bloc via update() (set+merge fusionnerait en
      // profondeur et empêcherait de retirer une surcharge).
      writes.push(ref.set(patch, { merge: true }).then(function () {
        if (c.tasks) return ref.update({ tasks: cleanTasks(c.tasks) });
        return null;
      }));
    }

    if (typeof body.context === 'string') {
      writes.push(db.collection('_config').doc('ai_context').set({
        text: body.context.slice(0, 60000),
        updatedAt: Date.now(),
        updatedBy: auth.uid,
      }, { merge: true }));
    }

    await Promise.all(writes);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[ai-admin]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
