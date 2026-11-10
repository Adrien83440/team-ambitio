// ============================================================================
// api/quiz-maintenance.js — CORRECTIONS DE PROVENANCE DES QUIZ (10/11/2026)
// ----------------------------------------------------------------------------
// Brief « Mesure des quiz : des chiffres justes », T6. Le quiz Élections
// (/elections-27-quizz-funnel) n'avait pas de nom Leads Live propre et, avant
// le correctif du 07/11 (URL coupée), ses leads tombaient sur la page Élite
// (funnel-quizz-elite__optin-a) ou sur la clé de repli « quiz_elite ».
//
// Action `elections` :
//   1. tunnels/{id}.settings.crmLabel = « Funnel Quiz Élections » (nom affiché
//      dans Leads Live pour ses futurs leads ; api/lead-optin.js le lit) ;
//   2. fiches dont une provenance (landingFirst / landingLast) a été envoyée
//      depuis la page Élections — preuve : son URL d'envoi gardée (pageUrl) —
//      mais rangée sous une autre page (quiz_elite, page Élite) :
//        · cette provenance → page / variante / libellé Élections ;
//        · sourceDetail → « Funnel Quiz Élections » si la DERNIÈRE provenance
//          est Élections et qu'il vaut encore un libellé automatique.
//      Trace d'audit : provenanceCorrections[] (date, action, valeurs d'avant). Rien
//      n'est supprimé.
//
// Deux temps (règle du repo) :
//   Action `repli` : provenances sous une clé invalide (quiz_elite, clé
//   tronquée) rattachées à l'étape que prouve leur URL d'envoi (voir plus bas).
//
//   GET  ?action=elections                    → DRY-RUN : plan + empreinte
//   POST ?action=elections&apply=1&plan=<empreinte du dry-run validé>
//        → applique EXACTEMENT ce plan (refus 409 si les données ont bougé).
// Accès : en-tête x-maint-key = variable Vercel QUIZ_MAINT_KEY (preview de la
// branche seulement) ; absente ou fausse → 404. Aucune donnée personnelle en
// sortie (empreintes de fiches, dates, pages, libellés).
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

const ELECTIONS_TUNNEL = 'vmmF3lSA3NOEj31fkRTg';
const NEW_LABEL = 'Funnel Quiz Élections';
const AUTO_LABELS = { 'Funnel Quizz - Elite': 1, 'Funnel Quiz Élite': 1, 'Quiz Funnel': 1, 'VSL Élite': 1, 'Eléctions 27 Quizz Funnel': 1 };

function keyOk(req) {
  const want = String(process.env.QUIZ_MAINT_KEY || '');
  const got = String((req.headers && req.headers['x-maint-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function ref(id) { return crypto.createHash('sha256').update('qa:' + id).digest('hex').slice(0, 10); }
function ms(v) { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return isNaN(t) ? null : t; }
function day(t) { return t == null ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }

function pathOf(L) { try { return L && L.pageUrl ? new URL(String(L.pageUrl)).pathname : ''; } catch (e) { return ''; } }

async function buildPlan() {
  const tSnap = await db.collection('tunnels').doc(ELECTIONS_TUNNEL).get();
  if (!tSnap.exists) throw new Error('tunnel Élections introuvable');
  const t = tSnap.data() || {};
  const step = (t.steps || []).filter(function (s) { return s && !s.archived; })[0];
  if (!step) throw new Error('étape du tunnel Élections introuvable');
  const page = String(t.slug) + '__' + String(step.slug);
  const ePath = '/' + String(step.slug);
  const liveVars = (step.variants || []).filter(function (v) { return v && v.status === 'live' && !v.archived; }).map(function (v) { return v.id; });
  const defVar = liveVars.length === 1 ? liveVars[0] : null;
  const target = { page: page, tunnelId: ELECTIONS_TUNNEL, stepId: step.id, stepLabel: step.name || step.slug || '', label: NEW_LABEL };

  const plan = { tunnel: { id: ELECTIONS_TUNNEL, crmLabelBefore: (t.settings && t.settings.crmLabel) || null, crmLabelAfter: NEW_LABEL }, page: page, defaultVariant: defVar, leads: [] };
  const writes = [];
  const snap = await db.collection('leads').where('quizSubmittedAt', '>=', admin.firestore.Timestamp.fromMillis(Date.parse('2026-10-01T00:00:00Z'))).get();
  snap.forEach(function (doc) {
    const d = doc.data() || {};
    if (d._merged === true) return;
    const LF = d.landingFirst || null, LL = d.landingLast || null;
    /* Preuve fiche par fiche : l'URL d'envoi gardée sur la provenance
       (pageUrl) est la page du quiz Élections. */
    const firstIsE = pathOf(LF) === ePath, lastIsE = pathOf(LL) === ePath;
    if (!firstIsE && !lastIsE) return;
    const reopted = !!d.lastOptinAt;
    const upd = {};
    const before = { landingFirst: LF, landingLast: LL, sourceDetail: d.sourceDetail || null };
    function fixed(L) {
      const o = Object.assign({}, L || {}, target);
      o.variant = (L && L.page === page && L.variant) || defVar || (L && L.variant) || null;
      o.via = (L && L.via) || 'optin';
      o.correctedAt = new Date().toISOString();
      return o;
    }
    if (lastIsE && (LL.page !== page || LL.label !== NEW_LABEL)) upd.landingLast = fixed(LL);
    if (firstIsE && (LF.page !== page || LF.label !== NEW_LABEL)) upd.landingFirst = fixed(LF);
    if (lastIsE && d.sourceDetail && AUTO_LABELS[d.sourceDetail] && d.sourceDetail !== NEW_LABEL) upd.sourceDetail = NEW_LABEL;
    if (!Object.keys(upd).length) return;
    plan.leads.push({
      ref: ref(doc.id), createdDay: day(ms(d.createdAt)), reopted: reopted,
      landingFirst: LF ? (LF.page + '|' + (LF.variant || '-') + '|' + (LF.label || '-') + (pathOf(LF) ? '|' + pathOf(LF) : '')) : null,
      landingLast: LL ? (LL.page + '|' + (LL.variant || '-') + '|' + (LL.label || '-') + (pathOf(LL) ? '|' + pathOf(LL) : '')) : null,
      sourceDetail: d.sourceDetail || null,
      changes: Object.keys(upd).sort()
    });
    writes.push({ id: doc.id, upd: upd, before: before });
  });
  plan.leads.sort(function (a, b) { return String(a.createdDay).localeCompare(String(b.createdDay)) || a.ref.localeCompare(b.ref); });
  const fp = crypto.createHash('sha256').update(JSON.stringify({ t: plan.tunnel, l: plan.leads.map(function (x) { return x.ref + ':' + x.changes.join(','); }) })).digest('hex').slice(0, 16);
  return { plan: plan, writes: writes, fingerprint: fp };
}

/* ── Action `repli` (10/11/2026, accord Adrien) ─────────────────────────────
   Provenances rangées sous une clé INVALIDE — clé de repli « quiz_elite »
   (lp absent de l'URL coupée avant le 07/11) ou clé tronquée
   (« funnel-quizz-elite__op ») — alors que l'URL d'envoi gardée (pageUrl)
   désigne une étape de tunnel connue. Preuve fiche par fiche : le chemin de
   pageUrl = le chemin public de l'étape (tunnel non archivé, une seule
   correspondance). La variante est lue dans pageUrl (v=) si elle y est,
   sinon « non transmise » (null) — jamais devinée.
   sourceDetail → nom Leads Live du tunnel s'il vaut encore un libellé
   automatique et que la DERNIÈRE provenance est corrigée. */
function variantOfUrl(L) {
  try { const v = new URL(String(L.pageUrl)).searchParams.get('v'); return v ? String(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || null : null; } catch (e) { return null; }
}
async function buildFallbackPlan() {
  const tsnap = await db.collection('tunnels').get();
  const byPath = {}, pages = {};
  tsnap.forEach(function (doc) {
    const t = doc.data() || {};
    if (t.archived === true || !t.slug) return;
    const label = String((t.settings && t.settings.crmLabel) || '').trim() || t.name || t.slug;
    (t.steps || []).forEach(function (st) {
      if (!st || st.archived === true || !st.slug) return;
      const page = String(t.slug) + '__' + String(st.slug);
      const path = t.homeStepId && t.homeStepId === st.id ? '/' : '/' + String(st.slug);
      const target = { page: page, tunnelId: doc.id, stepId: st.id, stepLabel: st.name || st.slug || '', label: label };
      pages[page] = 1;
      if (path === '/') return;   // page d'accueil d'un domaine : chemin ambigu, jamais utilisé comme preuve
      byPath[path] = byPath[path] ? 'ambigu' : target;
    });
  });
  const plan = { leads: [], targets: {} };
  const writes = [];
  const snap = await db.collection('leads').where('quizSubmittedAt', '>=', admin.firestore.Timestamp.fromMillis(Date.parse('2026-09-01T00:00:00Z'))).get();
  snap.forEach(function (doc) {
    const d = doc.data() || {};
    if (d._merged === true) return;
    const LF = d.landingFirst || null, LL = d.landingLast || null;
    function targetOf(L) {
      if (!L || !L.page || pages[L.page]) return null;   // clé valide et connue : rien à faire
      /* Seulement la clé de repli quiz ou une clé de tunnel tronquée — les
         anciennes clés System.io (vsl_elite, elite…) sont de vraies pages. */
      const p0 = String(L.page);
      const fallback = p0 === 'quiz_elite' || p0 === 'quiz_business';
      const truncated = p0.indexOf('__') > 0 && Object.keys(pages).some(function (pg) { return pg.indexOf(p0) === 0; });
      if (!fallback && !truncated) return null;
      /* Après la bascule du domaine sur Vercel (28/09/2026) : avant, le même
         chemin pouvait être une page System.io. */
      const at = Date.parse(String(L.capturedAt || ''));
      if (!(at >= Date.parse('2026-09-28T00:00:00Z'))) return null;
      const tg = byPath[pathOf(L)];
      return tg && tg !== 'ambigu' ? tg : null;
    }
    const tF = targetOf(LF), tL = targetOf(LL);
    if (!tF && !tL) return;
    const upd = {};
    const before = { landingFirst: LF, landingLast: LL, sourceDetail: d.sourceDetail || null };
    function fixed(L, tg) {
      const o = Object.assign({}, L, tg);
      o.variant = variantOfUrl(L) || null;
      o.via = L.via || 'optin';
      o.correctedAt = new Date().toISOString();
      return o;
    }
    if (tF) upd.landingFirst = fixed(LF, tF);
    if (tL) upd.landingLast = fixed(LL, tL);
    if (tL && d.sourceDetail && AUTO_LABELS[d.sourceDetail] && d.sourceDetail !== tL.label) upd.sourceDetail = tL.label;
    [tF, tL].forEach(function (tg) { if (tg) plan.targets[tg.page] = tg.label; });
    plan.leads.push({
      ref: ref(doc.id), createdDay: day(ms(d.createdAt)),
      landingFirst: LF ? (LF.page + '|' + (LF.variant || '-') + '|' + (pathOf(LF) || '-')) + (tF ? ' → ' + tF.page + '|' + (variantOfUrl(LF) || '-') : '') : null,
      landingLast: LL ? (LL.page + '|' + (LL.variant || '-') + '|' + (pathOf(LL) || '-')) + (tL ? ' → ' + tL.page + '|' + (variantOfUrl(LL) || '-') : '') : null,
      sourceDetail: d.sourceDetail || null, sourceDetailAfter: upd.sourceDetail || null,
      changes: Object.keys(upd).sort()
    });
    writes.push({ id: doc.id, upd: upd, before: before });
  });
  plan.leads.sort(function (a, b) { return String(a.createdDay).localeCompare(String(b.createdDay)) || a.ref.localeCompare(b.ref); });
  const fp = crypto.createHash('sha256').update(JSON.stringify(plan.leads.map(function (x) { return x.ref + ':' + x.changes.join(',') + ':' + x.landingFirst + ':' + x.landingLast; }))).digest('hex').slice(0, 16);
  return { plan: plan, writes: writes, fingerprint: fp };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  const q = req.query || {};
  if (q.action !== 'elections' && q.action !== 'repli') { res.status(400).json({ error: 'action' }); return; }
  try {
    const P = q.action === 'repli' ? await buildFallbackPlan() : await buildPlan();
    const apply = req.method === 'POST' && (q.apply === '1' || q.apply === 'true');
    if (!apply) { res.status(200).json({ dryRun: true, fingerprint: P.fingerprint, count: P.plan.leads.length, plan: P.plan }); return; }
    if (String(q.plan || '') !== P.fingerprint) { res.status(409).json({ error: 'plan_changed', expected: P.fingerprint, note: 'Relancer le dry-run et le faire valider.' }); return; }
    const FV = admin.firestore.FieldValue;
    const now = new Date().toISOString();
    if (q.action === 'elections') await db.collection('tunnels').doc(ELECTIONS_TUNNEL).update({ 'settings.crmLabel': NEW_LABEL });
    let done = 0;
    for (let i = 0; i < P.writes.length; i += 400) {
      const batch = db.batch();
      P.writes.slice(i, i + 400).forEach(function (w) {
        const upd = Object.assign({}, w.upd);
        upd.provenanceCorrections = FV.arrayUnion({ at: now, action: q.action === 'repli' ? 'quiz-provenance-repli' : 'quiz-elections-provenance', before: w.before, fields: Object.keys(w.upd).sort() });
        batch.update(db.collection('leads').doc(w.id), upd);
      });
      await batch.commit();
      done += Math.min(400, P.writes.length - i);
    }
    res.status(200).json({ applied: true, action: q.action, fingerprint: P.fingerprint, leadsUpdated: done });
  } catch (e) {
    console.error('[quiz-maintenance]', e && e.message);
    res.status(500).json({ error: 'maintenance', message: String(e && e.message || e).slice(0, 300) });
  }
};
