// ============================================================================
// api/ai-admin.js — RÉGLAGES IA (page admin-ia.html) — admin uniquement
// ----------------------------------------------------------------------------
// GET  → { config, defaults, context, usage: {mois courant, mois précédent},
//          recent: 40 derniers appels ai_usage }
// POST { config?: {enabled, monthlyBudgetEur, alertPct, eurPerUsd,
//                  emailAccount, extraEmails, tasks},
//        context?: string }
//
// Passe par l'Admin SDK : aucune règle Firestore à ouvrir pour _config/ai,
// _config/ai_context, ai_usage, ai_usage_months.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { getMonthUsage, monthKey, DEFAULT_TASKS, DEFAULT_CONFIG } = require('./_ai');

function prevMonthKey() {
  const k = monthKey().split('-').map(Number);
  const d = new Date(Date.UTC(k[0], k[1] - 2, 15));
  return d.toISOString().slice(0, 7);
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
