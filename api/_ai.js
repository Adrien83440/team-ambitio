// ============================================================================
// api/_ai.js — SOCLE IA ALTEORE (helper partagé, exclu du routing Vercel)
// ----------------------------------------------------------------------------
// Point d'entrée UNIQUE pour tout appel à Claude depuis les Vercel Functions.
// Ne jamais appeler https://api.anthropic.com directement ailleurs : passer
// par callClaude() pour bénéficier de :
//
//   • choix du modèle / effort / max_tokens PAR TÂCHE (DEFAULT_TASKS, surchargé
//     par _config/ai.tasks) ;
//   • interrupteur global (_config/ai.enabled === false → plus aucun appel) ;
//   • plafond de budget mensuel en euros (_config/ai.monthlyBudgetEur) et
//     alerte email aux admins au franchissement de alertPct (une fois / mois) ;
//   • traçabilité : chaque appel écrit un doc ai_usage/{auto} et incrémente
//     l'agrégat ai_usage_months/{YYYY-MM} (coût total, par tâche) ;
//   • « cerveau Alteore » : _config/ai_context.text injecté en tête du system
//     prompt (mis en cache côté Anthropic → ~90 % moins cher en relecture) ;
//   • sorties JSON structurées (output_config.format json_schema) ;
//   • repli serveur sur refus (fallbacks: "default") pour Opus 5.5.
//
// Règle d'or du programme IA (validée par Adrien le 08/10/2026) : l'IA
// PROPOSE, l'humain valide. Aucun endpoint ne doit envoyer quoi que ce soit
// à un prospect sur la seule base d'une sortie de callClaude().
//
// Variables Vercel : ANTHROPIC_API_KEY (déjà en place).
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');

const API_URL = 'https://api.anthropic.com/v1/messages';

const OPUS  = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';

// Tarifs en $ par million de tokens (entrée / sortie). Lecture de cache =
// 10 % du tarif d'entrée, écriture de cache (TTL 5 min) = 125 %.
const PRICING = {
  'claude-opus-5-5':   { inp: 4, out: 20 },
  'claude-sonnet-5-5': { inp: 2, out: 10 },
  'claude-haiku-4-5':  { inp: 1, out: 5 },
};

// Modèle par tâche. Opus pour ce qui rapporte (closing, chat, prépa, synthèse),
// Haiku pour le volume (score de lead, résumés, notation d'appels).
// Surchargeable tâche par tâche via _config/ai.tasks.<task>.
const DEFAULT_TASKS = {
  lead_score:       { model: HAIKU, maxTokens: 1500 },
  morning_brief:    { model: OPUS,  effort: 'medium', maxTokens: 6000 },
  closing_prep:     { model: OPUS,  effort: 'medium', maxTokens: 6000 },
  closing_analysis: { model: OPUS,  effort: 'medium', maxTokens: 8000 },
  closing_followup: { model: OPUS,  effort: 'medium', maxTokens: 3000 },
  objection_playbook: { model: OPUS, effort: 'medium', maxTokens: 4000 },
  close_probability:{ model: HAIKU, maxTokens: 800 },
  call_summary:     { model: HAIKU, maxTokens: 2000 },
  call_rating:      { model: HAIKU, maxTokens: 2000 },
  message_assist:   { model: HAIKU, maxTokens: 1500 },
  client_risk:      { model: HAIKU, maxTokens: 1200 },
  session_report:   { model: OPUS,  effort: 'medium', maxTokens: 4000 },
  csm_diagnostic:   { model: OPUS,  effort: 'medium', maxTokens: 4000 },
  invoice_check:    { model: HAIKU, maxTokens: 1000 },
  ask_alteore:      { model: OPUS,  effort: 'medium', maxTokens: 4000 },
  watchdog:         { model: OPUS,  effort: 'medium', maxTokens: 6000 },
  attribution:      { model: OPUS,  effort: 'medium', maxTokens: 6000 },
  training:         { model: OPUS,  effort: 'low',    maxTokens: 1500 },
  command:          { model: HAIKU, maxTokens: 600 },
  training_debrief: { model: OPUS,  effort: 'medium', maxTokens: 4000 },
  // Atelier de contrats (contract-studio.html) : réécriture et import PDF.
  contract_edit:    { model: OPUS,  effort: 'medium', maxTokens: 16000 },
  contract_import:  { model: OPUS,  effort: 'medium', maxTokens: 32000 },
};

const DEFAULT_CONFIG = {
  enabled: true,
  monthlyBudgetEur: 50,
  alertPct: 80,
  eurPerUsd: 0.86,   // taux de conversion indicatif, modifiable dans _config/ai
  tasks: {},
};

// ---------------------------------------------------------------------------
//  Lecture config / contexte (cache mémoire 60 s par instance)
// ---------------------------------------------------------------------------

let _cfgCache = null, _cfgAt = 0;
let _ctxCache = null, _ctxAt = 0;
const CACHE_MS = 60 * 1000;

async function getAiConfig() {
  if (_cfgCache && Date.now() - _cfgAt < CACHE_MS) return _cfgCache;
  let d = {};
  try {
    const s = await db.collection('_config').doc('ai').get();
    if (s.exists) d = s.data() || {};
  } catch (e) { console.warn('[_ai] lecture _config/ai impossible', e.message); }
  const cfg = Object.assign({}, DEFAULT_CONFIG, d);
  cfg.tasks = Object.assign({}, d.tasks || {});
  _cfgCache = cfg; _cfgAt = Date.now();
  return cfg;
}

async function getAiContext() {
  if (_ctxCache !== null && Date.now() - _ctxAt < CACHE_MS) return _ctxCache;
  let text = '';
  try {
    const s = await db.collection('_config').doc('ai_context').get();
    if (s.exists) text = String((s.data() || {}).text || '');
  } catch (e) { console.warn('[_ai] lecture _config/ai_context impossible', e.message); }
  _ctxCache = text; _ctxAt = Date.now();
  return text;
}

function taskSettings(cfg, task) {
  const base = DEFAULT_TASKS[task] || { model: OPUS, effort: 'medium', maxTokens: 4000 };
  const over = (cfg.tasks && cfg.tasks[task]) || {};
  return Object.assign({}, base, over);
}

function monthKey(d) {
  d = d || new Date();
  // Mois calendaire en heure de Paris (l'équipe raisonne en mois français).
  const s = d.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // YYYY-MM-DD
  return s.slice(0, 7);
}

// ---------------------------------------------------------------------------
//  Budget
// ---------------------------------------------------------------------------

async function getMonthUsage(key) {
  try {
    const s = await db.collection('ai_usage_months').doc(key || monthKey()).get();
    return s.exists ? (s.data() || {}) : {};
  } catch (e) { return {}; }
}

function usdToEur(cfg, usd) { return (Number(usd) || 0) * (Number(cfg.eurPerUsd) || DEFAULT_CONFIG.eurPerUsd); }

function costUsd(model, usage) {
  const p = PRICING[model] || PRICING[OPUS];
  const u = usage || {};
  const inp   = Number(u.input_tokens) || 0;
  const out   = Number(u.output_tokens) || 0;
  const cRead = Number(u.cache_read_input_tokens) || 0;
  const cWrite = Number(u.cache_creation_input_tokens) || 0;
  return (inp * p.inp + out * p.out + cRead * p.inp * 0.1 + cWrite * p.inp * 1.25) / 1e6;
}

async function maybeSendBudgetAlert(cfg, key, month) {
  const budget = Number(cfg.monthlyBudgetEur) || 0;
  if (!budget || month.alertSentAt) return;
  const spentEur = usdToEur(cfg, month.costUsd);
  if (spentEur < budget * (Number(cfg.alertPct) || 80) / 100) return;
  try {
    await db.collection('ai_usage_months').doc(key).set({ alertSentAt: Date.now() }, { merge: true });
    const { sendToAdmins } = require('./_aiMail');
    await sendToAdmins(
      '⚠️ IA Alteore — ' + Math.round(spentEur * 100) / 100 + ' € consommés sur ' + budget + ' €',
      '<p>Le budget IA du mois <b>' + key + '</b> a atteint <b>' + Math.round(spentEur / budget * 100) + ' %</b> ' +
      '(' + (Math.round(spentEur * 100) / 100) + ' € sur ' + budget + ' €).</p>' +
      '<p>Au-delà du plafond, les fonctionnalités IA se mettent en pause jusqu\'au mois suivant. ' +
      'Le plafond se règle dans <a href="https://team.alteore.com/admin-ia.html">Réglages IA</a>.</p>'
    );
  } catch (e) { console.warn('[_ai] alerte budget non envoyée', e.message); }
}

// ---------------------------------------------------------------------------
//  Appel principal
// ---------------------------------------------------------------------------

/**
 * Appelle Claude pour une tâche donnée.
 *
 * @param {Object} o
 * @param {string} o.task          clé de DEFAULT_TASKS (obligatoire)
 * @param {string} [o.system]      consignes propres à la tâche
 * @param {string} [o.prompt]      message utilisateur (ou o.messages)
 * @param {Array}  [o.messages]    historique complet [{role, content}]
 * @param {Object} [o.schema]      JSON schema → réponse parsée dans .json
 * @param {Array}  [o.tools]       outils (tool use) — boucle gérée par l'appelant
 * @param {boolean}[o.noContext]   ne pas injecter le cerveau Alteore
 * @param {string} [o.uid]         utilisateur à l'origine (traçabilité)
 * @param {string} [o.ref]         référence métier (leadId, clientId…)
 * @returns {Promise<{ok, text, json, content, stopReason, costUsd, error}>}
 */
async function callClaude(o) {
  const task = String(o && o.task || '');
  if (!task) return { ok: false, error: 'task_required' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'anthropic_not_configured' };

  const cfg = await getAiConfig();
  if (cfg.enabled === false) return { ok: false, error: 'ai_disabled' };
  if (cfg.tasks && cfg.tasks[task] && cfg.tasks[task].enabled === false) return { ok: false, error: 'ai_task_disabled' };

  const key = monthKey();
  const month = await getMonthUsage(key);
  const budget = Number(cfg.monthlyBudgetEur) || 0;
  if (budget && usdToEur(cfg, month.costUsd) >= budget) return { ok: false, error: 'ai_budget_exceeded' };

  const st = taskSettings(cfg, task);
  const model = st.model;

  // System : cerveau Alteore (stable → mis en cache) puis consignes de tâche.
  const system = [];
  if (!o.noContext) {
    const ctx = await getAiContext();
    if (ctx) system.push({ type: 'text', text: 'CONTEXTE ALTEORE (référence permanente) :\n' + ctx, cache_control: { type: 'ephemeral' } });
  }
  if (o.system) system.push({ type: 'text', text: String(o.system) });

  const body = {
    model: model,
    max_tokens: Number(o.maxTokens) || Number(st.maxTokens) || 4000,
    messages: Array.isArray(o.messages) && o.messages.length ? o.messages : [{ role: 'user', content: String(o.prompt || '') }],
  };
  if (system.length) body.system = system;
  if (Array.isArray(o.tools) && o.tools.length) body.tools = o.tools;

  const outputConfig = {};
  // Haiku 4.5 refuse le paramètre effort — on ne l'envoie qu'aux modèles 5.x.
  if (st.effort && model !== HAIKU) outputConfig.effort = st.effort;
  if (o.schema) outputConfig.format = { type: 'json_schema', schema: o.schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  // Repli serveur : si les filtres de sécurité d'Opus déclinent la demande,
  // Anthropic la rejoue sur le modèle de repli recommandé (même appel).
  if (model === OPUS) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let j = null, httpStatus = 0, err = null;
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    httpStatus = r.status;
    j = await r.json().catch(function () { return null; });
    if (!r.ok) err = (j && j.error && j.error.message) || ('http_' + r.status);
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }

  const usage = (j && j.usage) || {};
  const servedModel = (j && j.model) || model;
  const cost = j ? costUsd(servedModel, usage) : 0;

  // Traçabilité AVANT de rendre la main (Vercel coupe après res.end()).
  try {
    const inc = admin.firestore.FieldValue.increment;
    const taskInc = {};
    taskInc[task] = { costUsd: inc(cost), calls: inc(1) };
    await Promise.all([
      db.collection('ai_usage').add({
        task: task, model: servedModel, ok: !err,
        error: err ? String(err).slice(0, 300) : null,
        httpStatus: httpStatus,
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
        cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
        costUsd: cost,
        uid: o.uid || null,
        ref: o.ref || null,
        month: key,
        at: Date.now(),
      }),
      db.collection('ai_usage_months').doc(key).set({
        month: key,
        costUsd: inc(cost),
        calls: inc(1),
        byTask: taskInc,
        updatedAt: Date.now(),
      }, { merge: true }),
    ]);
    if (cost > 0) {
      month.costUsd = (Number(month.costUsd) || 0) + cost;
      await maybeSendBudgetAlert(cfg, key, month);
    }
  } catch (e) { console.warn('[_ai] journalisation ai_usage échouée', e.message); }

  if (err) return { ok: false, error: err, costUsd: cost };

  const stopReason = j.stop_reason;
  if (stopReason === 'refusal') return { ok: false, error: 'ai_refusal', stopReason: stopReason, costUsd: cost };

  const content = Array.isArray(j.content) ? j.content : [];
  const text = content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();

  let json = null;
  if (o.schema) {
    try { json = JSON.parse(text); }
    catch (e) { return { ok: false, error: 'ai_invalid_json', text: text, stopReason: stopReason, costUsd: cost }; }
  }

  return { ok: true, text: text, json: json, content: content, stopReason: stopReason, model: servedModel, costUsd: cost };
}

// ---------------------------------------------------------------------------
//  Helpers communs aux endpoints IA
// ---------------------------------------------------------------------------

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  if (v.seconds) return v.seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function frDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
}

// Message d'erreur lisible côté interface pour les codes du socle.
function humanError(code) {
  switch (code) {
    case 'ai_disabled': return 'IA désactivée dans les réglages';
    case 'ai_task_disabled': return 'Cette fonction IA est désactivée';
    case 'ai_budget_exceeded': return 'Budget IA du mois atteint';
    case 'anthropic_not_configured': return 'Clé Anthropic absente';
    case 'ai_refusal': return 'L\'IA a décliné cette demande';
    default: return 'Erreur IA : ' + code;
  }
}

module.exports = {
  callClaude: callClaude,
  getAiConfig: getAiConfig,
  getAiContext: getAiContext,
  getMonthUsage: getMonthUsage,
  monthKey: monthKey,
  usdToEur: usdToEur,
  cap: cap,
  tsToMs: tsToMs,
  frDate: frDate,
  humanError: humanError,
  DEFAULT_TASKS: DEFAULT_TASKS,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  OPUS: OPUS,
  HAIKU: HAIKU,
};
