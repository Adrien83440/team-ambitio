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
//   2. fiches dont le quiz est celui des Élections (version « presidentielle »
//      ou questions sur l'élection) mais rangées sous une autre page :
//        · landingLast → page / variante / libellé Élections (le quiz porté par
//          la fiche est toujours le dernier envoyé) ;
//        · landingFirst → idem, seulement si la fiche n'a jamais été
//          ré-inscrite (sinon la 1re page reste celle d'origine) ;
//        · sourceDetail → « Funnel Quiz Élections » s'il vaut encore un libellé
//          automatique de quiz.
//      Trace d'audit : provenanceCorrections[] (date, action, valeurs d'avant). Rien
//      n'est supprimé.
//
// Deux temps (règle du repo) :
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

/* Le quiz porté par la fiche est-il celui des Élections ? */
function isElectionsQuiz(q) {
  if (!q || typeof q !== 'object') return false;
  if (/presidentiel/i.test(String(q.quiz_version || ''))) return true;
  const rep = Array.isArray(q.reponses) ? q.reponses : [];
  return rep.some(function (r) { return r && /[ée]lection|pr[ée]sidentiel/i.test(String(r.question || '')); });
}
function pathOf(L) { try { return L && L.pageUrl ? new URL(String(L.pageUrl)).pathname : ''; } catch (e) { return ''; } }

async function buildPlan() {
  const tSnap = await db.collection('tunnels').doc(ELECTIONS_TUNNEL).get();
  if (!tSnap.exists) throw new Error('tunnel Élections introuvable');
  const t = tSnap.data() || {};
  const step = (t.steps || []).filter(function (s) { return s && !s.archived; })[0];
  if (!step) throw new Error('étape du tunnel Élections introuvable');
  const page = String(t.slug) + '__' + String(step.slug);
  const liveVars = (step.variants || []).filter(function (v) { return v && v.status === 'live' && !v.archived; }).map(function (v) { return v.id; });
  const defVar = liveVars.length === 1 ? liveVars[0] : null;
  const target = { page: page, tunnelId: ELECTIONS_TUNNEL, stepId: step.id, stepLabel: step.name || step.slug || '', label: NEW_LABEL };

  const plan = { tunnel: { id: ELECTIONS_TUNNEL, crmLabelBefore: (t.settings && t.settings.crmLabel) || null, crmLabelAfter: NEW_LABEL }, page: page, defaultVariant: defVar, leads: [] };
  const writes = [];
  const snap = await db.collection('leads').where('quizSubmittedAt', '>=', admin.firestore.Timestamp.fromMillis(Date.parse('2026-10-01T00:00:00Z'))).get();
  snap.forEach(function (doc) {
    const d = doc.data() || {};
    if (d._merged === true) return;
    if (!isElectionsQuiz(d.quiz)) return;
    const LF = d.landingFirst || null, LL = d.landingLast || null;
    const reopted = !!d.lastOptinAt && Array.isArray(d.engagementHistory) && d.engagementHistory.length > 0;
    const upd = {};
    const before = { landingFirst: LF, landingLast: LL, sourceDetail: d.sourceDetail || null };
    function fixed(L) {
      const o = Object.assign({}, L || {}, target);
      o.variant = (L && L.page === page && L.variant) || defVar || (L && L.variant) || null;
      o.via = (L && L.via) || 'optin';
      o.correctedAt = new Date().toISOString();
      return o;
    }
    if (!LL || LL.page !== page || LL.label !== NEW_LABEL) upd.landingLast = fixed(LL);
    if (!reopted && (!LF || LF.page !== page || LF.label !== NEW_LABEL)) upd.landingFirst = fixed(LF);
    if (d.sourceDetail && AUTO_LABELS[d.sourceDetail] && d.sourceDetail !== NEW_LABEL) upd.sourceDetail = NEW_LABEL;
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  const q = req.query || {};
  if (q.action !== 'elections') { res.status(400).json({ error: 'action' }); return; }
  try {
    const P = await buildPlan();
    const apply = req.method === 'POST' && (q.apply === '1' || q.apply === 'true');
    if (!apply) { res.status(200).json({ dryRun: true, fingerprint: P.fingerprint, count: P.plan.leads.length, plan: P.plan }); return; }
    if (String(q.plan || '') !== P.fingerprint) { res.status(409).json({ error: 'plan_changed', expected: P.fingerprint, note: 'Relancer le dry-run et le faire valider.' }); return; }
    const FV = admin.firestore.FieldValue;
    const now = new Date().toISOString();
    await db.collection('tunnels').doc(ELECTIONS_TUNNEL).update({ 'settings.crmLabel': NEW_LABEL });
    let done = 0;
    for (let i = 0; i < P.writes.length; i += 400) {
      const batch = db.batch();
      P.writes.slice(i, i + 400).forEach(function (w) {
        const upd = Object.assign({}, w.upd);
        upd.provenanceCorrections = FV.arrayUnion({ at: now, action: 'quiz-elections-provenance', before: w.before, fields: Object.keys(w.upd).sort() });
        batch.update(db.collection('leads').doc(w.id), upd);
      });
      await batch.commit();
      done += Math.min(400, P.writes.length - i);
    }
    res.status(200).json({ applied: true, fingerprint: P.fingerprint, tunnelLabel: NEW_LABEL, leadsUpdated: done });
  } catch (e) {
    console.error('[quiz-maintenance]', e && e.message);
    res.status(500).json({ error: 'maintenance', message: String(e && e.message || e).slice(0, 300) });
  }
};
