// ============================================================================
// api/tunnel-event.js — BEACON DES PAGES DE TUNNEL (09/2026)
// ----------------------------------------------------------------------------
// Appelé par tunnel-runtime.js (injecté par api/tunnel-render.js) :
//   { t: tunnelId, s: stepId, v: variante, e: 'visit'|'view'|'cta',
//     src: { utm_source, utm_campaign, utm_content } }
//
// Auth : AUCUNE — beacon navigateur public (comme api/page-view.js).
// Body : text/plain JSON (sendBeacon sans pré-vol CORS). Dédoublonné côté
// page : 1 visite / tunnel / session, 1 vue / étape / session, 1 clic CTA /
// étape / session. Les opt-ins ne passent pas ici : ils sont comptés par
// api/tunnel-optin.js, qui est la seule vérité de l'inscription.
//
// Écritures (incréments atomiques, Admin SDK) :
//   page_views_daily/{date}_{page}--{variant}
//       { date, page: '<tunnel>__<etape>', variant, tunnelId, stepId,
//         pageLabel, views, ctas }
//       → même collection que les VSL system.io : le Funnel Sales lit la
//         page comme une VSL (étape « prise de RDV directe », A/B test).
//   tunnel_stats_daily/{date}_{tunnelId}
//       { date, tunnelId, tunnelName, visits, views, ctas,
//         steps: { stepId: { name, views, ctas } },
//         sources: { clé: { utm_source, utm_campaign, utm_content,
//                           visits, ctas } } }
//       → onglet Stats de admin-tunnels.html (entonnoir + acquisition).
//   quiz_funnel_daily/{date}_{page}--{variant}   (événement 'quiz', 11/2026)
//       { starts, completes, nQuestions,
//         questions: { qid: { i, label, reached, answered,
//                             answers: { clé: { label, n } } } },
//         gate: { shown, continue, exit } }
//       → onglet « Qualité leads » du Funnel Sales (abandon par question).
//
// Anti-abus : tunnel et étape doivent exister dans le registre (cache
// 20 s), événement dans une liste fermée, chaînes bornées. Compteur
// indicatif, jamais une donnée personnelle.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const Reg = require('./_tunnelRegistry');

/* optin (28/09/2026) : pages dont le formulaire ne passe pas par le runtime
   (quiz → Make → lead-optin) — la page appelle ALTEO.track('optin') après
   l'envoi. La fiche lead, elle, reste créée par lead-optin. */
const EVENTS = { visit: 1, view: 1, cta: 1, optin: 1, quiz: 1 };

/* ── QUIZ — abandon question par question (06/11/2026, demande Vincent) ──
   La page quiz appelle window.ALTEO.quiz(…) (tunnel-runtime.js), qui poste
   e: 'quiz' avec un sous-type k :
     start → 1re question affichée (une fois par session)
     q     → question affichée   { q: { id, i, n, label } }
     a     → question répondue   { q: {…}, a: 'réponse' | ['réponse', …] }
     gate  → écran « prix » (CA sous le seuil) { g: 'shown'|'continue'|'exit' }
     done  → écran de résultats atteint (quiz terminé, avant le formulaire)
   Dédoublonné côté page (une fois par session et par question). Compteurs
   ANONYMES, aucune donnée personnelle : la réponse est une option du quiz,
   jamais un champ libre (bornée à 120 caractères).
   Écrit dans quiz_funnel_daily/{date}_{page}--{variante}, lu par l'onglet
   « Qualité leads » du Funnel Sales (lqs-tab.js). */
const QUIZ_KINDS = { start: 1, q: 1, a: 1, gate: 1, done: 1 };
const GATE_KINDS = { shown: 1, 'continue': 1, exit: 1 };
function quizKey(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}
function quizPatch(body, base, FV) {
  const k = QUIZ_KINDS[str(body.k, 10)] ? str(body.k, 10) : null;
  if (!k) return null;
  const inc = FV.increment(1);
  const patch = Object.assign({}, base);
  if (k === 'start') { patch.starts = inc; return patch; }
  if (k === 'done') { patch.completes = inc; return patch; }
  if (k === 'gate') {
    const g = str(body.g, 12);
    if (!GATE_KINDS[g]) return null;
    patch.gate = {}; patch.gate[g] = inc;
    return patch;
  }
  const qIn = (body.q && typeof body.q === 'object') ? body.q : {};
  const qid = quizKey(qIn.id);
  if (!qid) return null;
  const i = Math.max(0, Math.min(99, parseInt(qIn.i, 10) || 0));
  const q = { i: i, label: str(qIn.label, 200) || qid };
  const n = parseInt(qIn.n, 10);
  if (n > 0 && n < 100) patch.nQuestions = n;
  if (k === 'q') q.reached = inc;
  else {
    q.answered = inc;
    const list = (Array.isArray(body.a) ? body.a : [body.a]).slice(0, 10);
    const answers = {};
    list.forEach(function (a) {
      const lbl = str(a, 120);
      const ak = quizKey(lbl);
      if (!ak) return;
      answers[ak] = { label: lbl, n: inc };
    });
    if (Object.keys(answers).length) q.answers = answers;
  }
  patch.questions = {}; patch.questions[qid] = q;
  return patch;
}

function todayIsoParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 120); }
function keyPart(v) { return str(v, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }

/* Clé d'acquisition : source ~ campagne ~ contenu (ou 'direct'). */
function sourceKey(src) {
  const s = keyPart(src.utm_source), c = keyPart(src.utm_campaign), n = keyPart(src.utm_content);
  if (!s && !c && !n) return 'direct';
  return (s || '-') + '~' + (c || '-') + '~' + (n || '-');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const body = parseBody(req) || {};
  const tunnelId = str(body.t, 80).replace(/[^A-Za-z0-9_-]/g, '');
  const stepId = str(body.s, 80).replace(/[^A-Za-z0-9_-]/g, '');
  const variant = Reg.cleanSlug(body.v, 20) || null;
  const event = EVENTS[str(body.e, 10).toLowerCase()] ? str(body.e, 10).toLowerCase() : null;
  const srcIn = (body.src && typeof body.src === 'object') ? body.src : {};
  const src = {
    utm_source: str(srcIn.utm_source, 120),
    utm_campaign: str(srcIn.utm_campaign, 200),
    utm_content: str(srcIn.utm_content, 200)
  };

  if (!tunnelId || !stepId || !event) { res.status(200).json({ ok: true, ignored: 'payload' }); return; }

  let hit = null;
  try { hit = await Reg.findByIds(tunnelId, stepId); } catch (e) { console.error('[tunnel-event] registre :', e && e.message); }
  if (!hit) { res.status(200).json({ ok: true, ignored: 'unknown' }); return; }
  if (Reg.isTestTunnel(hit.tunnel)) { res.status(200).json({ ok: true, ignored: 'test' }); return; }   // page de test : jamais mesurée
  const tunnel = hit.tunnel, step = hit.step;

  const FV = admin.firestore.FieldValue;
  const inc = FV.increment(1);
  const date = todayIsoParis();
  const pageK = Reg.pageKey(tunnel, step);
  const writes = [];

  /* Quiz : un seul document, rien dans page_views_daily ni tunnel_stats_daily
     (les vues et opt-ins de la page restent comptés par les événements
     habituels). Écrit AVANT la réponse (Vercel coupe après res.end). */
  if (event === 'quiz') {
    const vQ = variant ? (step.variants || []).filter(function (v) { return v && String(v.id) === variant; })[0] : null;
    const base = {
      date: date, page: pageK, variant: variant, tunnelId: tunnel.id, stepId: step.id,
      pageLabel: Reg.pageLabel(tunnel, step), updatedAt: FV.serverTimestamp()
    };
    if (vQ && vQ.label) base.variantLabel = String(vQ.label).slice(0, 80);
    const qp = quizPatch(body, base, FV);
    if (!qp) { res.status(200).json({ ok: true, ignored: 'quiz' }); return; }
    try {
      await db.collection('quiz_funnel_daily').doc(date + '_' + pageK + (variant ? '--' + variant : '')).set(qp, { merge: true });
    } catch (e) {
      console.error('[tunnel-event] quiz :', e && e.message);
    }
    res.status(200).json({ ok: true });
    return;
  }

  const FIELD = { visit: 'visits', view: 'views', cta: 'ctas', optin: 'optins' };
  if (event === 'view' || event === 'cta' || event === 'optin') {
    const docId = date + '_' + pageK + (variant ? '--' + variant : '');
    const patch = {
      date: date, page: pageK, variant: variant, tunnelId: tunnel.id, stepId: step.id,
      pageLabel: Reg.pageLabel(tunnel, step),
      updatedAt: FV.serverTimestamp()
    };
    /* Libellé de la variante (ex. « Quiz », « VSL ») : lisible par le Funnel
       Sales même pour un utilisateur qui n'a pas accès aux documents tunnels. */
    const vObj = variant ? (step.variants || []).filter(function (v) { return v && String(v.id) === variant; })[0] : null;
    if (vObj && vObj.label) patch.variantLabel = String(vObj.label).slice(0, 80);
    patch[FIELD[event]] = inc;
    writes.push(db.collection('page_views_daily').doc(docId).set(patch, { merge: true }));
  }

  const field = FIELD[event];
  const stats = {
    date: date, tunnelId: tunnel.id, tunnelName: tunnel.name, tunnelSlug: tunnel.slug,
    updatedAt: FV.serverTimestamp(),
    steps: {}
  };
  stats[field] = inc;
  if (event !== 'visit') {
    stats.steps[step.id] = { name: step.name || step.slug, slug: step.slug };
    stats.steps[step.id][field] = inc;
  }
  if (event === 'visit' || event === 'cta' || event === 'optin') {
    const sk = sourceKey(src);
    stats.sources = {};
    stats.sources[sk] = { utm_source: src.utm_source, utm_campaign: src.utm_campaign, utm_content: src.utm_content };
    stats.sources[sk][field] = inc;
  }
  writes.push(db.collection('tunnel_stats_daily').doc(date + '_' + tunnel.id).set(stats, { merge: true }));

  try {
    await Promise.all(writes);
  } catch (e) {
    console.error('[tunnel-event] firestore :', e && e.message);
    // Un beacon ne doit jamais faire d'erreur visible côté page marketing.
  }
  res.status(200).json({ ok: true });
};
