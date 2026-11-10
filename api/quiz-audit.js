// ============================================================================
// api/quiz-audit.js — AUDIT DE LA MESURE DES QUIZ, LECTURE SEULE (10/11/2026)
// ----------------------------------------------------------------------------
// Brief « Mesure des quiz : des chiffres justes » (T0) : extraire, jour par
// jour et page × variante, tous les compteurs qui racontent le parcours d'un
// visiteur de quiz, pour les rapprocher entre eux et des sources externes
// (Meta, pixel, Make). Sert aussi à relire le HTML publié d'une page quiz
// (page marketing publique) pour tester la mesure injectée hors production.
//
// N'ÉCRIT RIEN. Aucune donnée personnelle en sortie : les leads et les RDV
// sont réduits à des dates, des pages, des statuts et une empreinte courte
// de l'identifiant (jamais nom, e-mail, téléphone, réponses libres).
//
// Accès : en-tête `x-audit-key` égal à la variable Vercel QUIZ_AUDIT_KEY.
// Variable absente ou clé fausse → 404 (l'endpoint « n'existe pas »). La clé
// est posée dans Vercel, jamais dans le dépôt ; la retirer coupe l'accès.
//
//   GET /api/quiz-audit?from=2026-11-03&to=2026-11-10            → compteurs
//   GET /api/quiz-audit?part=page&tunnel=<id>&step=<id>&v=<variante>
//                                                                → HTML publié
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin, storage } = require('./_firebaseAdmin');

function keyOk(req) {
  const want = String(process.env.QUIZ_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function isoOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ref(id) { return id ? crypto.createHash('sha256').update('qa:' + id).digest('hex').slice(0, 10) : null; }
function ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function parisDay(t) { return t == null ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }
function phone9(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
function landingOf(L) {
  if (!L || typeof L !== 'object') return null;
  let path = null;
  try { if (L.pageUrl) path = new URL(String(L.pageUrl)).pathname.slice(0, 80); } catch (e) { path = null; }
  return { page: L.page || null, variant: L.variant || null, via: L.via || null, label: L.label || null, path: path, tunnelId: L.tunnelId || null, capturedAt: L.capturedAt || null };
}
/* Début / fin d'un jour de Paris en UTC (marge d'un jour de chaque côté,
   le filtrage fin se fait sur parisDay). */
function bounds(from, to) {
  return { start: new Date(from + 'T00:00:00Z').getTime() - 86400000, end: new Date(to + 'T23:59:59Z').getTime() + 86400000 };
}

async function byDate(col, from, to) {
  const snap = await db.collection(col).where('date', '>=', from).where('date', '<=', to).get();
  const out = [];
  snap.forEach(function (d) { const x = d.data() || {}; delete x.updatedAt; x._id = d.id; out.push(x); });
  return out;
}

async function tunnelsList() {
  const snap = await db.collection('tunnels').get();
  const out = [];
  snap.forEach(function (doc) {
    const t = doc.data() || {};
    out.push({
      id: doc.id, name: t.name || null, slug: t.slug || null, kind: t.kind || null, status: t.status || null,
      archived: t.archived === true, crmLabel: (t.settings && t.settings.crmLabel) || null,
      leadType: (t.settings && t.settings.leadType) || null,
      steps: (Array.isArray(t.steps) ? t.steps : []).map(function (s) {
        return {
          id: s.id, slug: s.slug || null, name: s.name || null, status: s.status || null, archived: s.archived === true,
          variants: (Array.isArray(s.variants) ? s.variants : []).map(function (v) {
            return {
              id: v.id, label: v.label || null, status: v.status || null, weight: v.weight == null ? null : v.weight,
              archived: v.archived === true, version: v.html && v.html.version ? v.html.version : null,
              versionAt: v.html && v.html.version ? new Date(Number(v.html.version)).toISOString() : null,
              history: Array.isArray(v.history) ? v.history.map(function (h) { return h && (h.version || h.at || null); }).slice(-20) : null
            };
          })
        };
      })
    });
  });
  return out;
}

/* Leads entrés (createdAt) ou ré-inscrits (lastOptinAt) sur la période. */
async function leadsOf(from, to) {
  const B = bounds(from, to);
  const tsS = admin.firestore.Timestamp.fromMillis(B.start), tsE = admin.firestore.Timestamp.fromMillis(B.end);
  const seen = {};
  const out = [];
  const keys = { p9: {}, em: {} };
  function add(doc) {
    if (seen[doc.id]) return;
    seen[doc.id] = 1;
    const d = doc.data() || {};
    const p9 = phone9(d.telephone || d.phone);
    const em = String(d.email || '').toLowerCase().trim();
    const r = ref(doc.id);
    if (p9) keys.p9[p9] = r;
    if (em) keys.em[em] = r;
    keys[doc.id] = r;
    out.push({
      ref: r, merged: d._merged === true,
      createdDay: parisDay(ms(d.createdAt)), createdAt: ms(d.createdAt),
      importedCreatedAt: ms(d.importedCreatedAt), dateWebinaire: ms(d.dateWebinaire),
      lastOptinDay: parisDay(ms(d.lastOptinAt)), lastOptinAt: ms(d.lastOptinAt),
      quizSubmittedDay: parisDay(ms(d.quizSubmittedAt)), hasQuiz: !!d.quiz,
      quizKeys: d.quiz && typeof d.quiz === 'object' ? Object.keys(d.quiz).slice(0, 60) : null,
      quizMarks: d.quiz && typeof d.quiz === 'object' ? { version: d.quiz.quiz_version || null, firstQ: Array.isArray(d.quiz.reponses) && d.quiz.reponses[0] ? String(d.quiz.reponses[0].question || '').slice(0, 90) : null, nRep: Array.isArray(d.quiz.reponses) ? d.quiz.reponses.length : 0 } : null,
      type: d.type || null, sourceDetail: d.sourceDetail || null, source: d.source || null,
      stage: d.stage || null, status: d.status || null,
      landingFirst: landingOf(d.landingFirst), landingLast: landingOf(d.landingLast),
      utm_campaign: (d.attributionFirst && d.attributionFirst.utm_campaign) || null,
      utm_content: (d.attributionFirst && d.attributionFirst.utm_content) || null,
      utm_campaign_last: (d.attributionLast && d.attributionLast.utm_campaign) || null
    });
  }
  const a = await db.collection('leads').where('createdAt', '>=', tsS).where('createdAt', '<=', tsE).get();
  a.forEach(add);
  try {
    const b = await db.collection('leads').where('lastOptinAt', '>=', tsS).where('lastOptinAt', '<=', tsE).get();
    b.forEach(add);
  } catch (e) { out.push({ error: 'lastOptinAt: ' + (e && e.message) }); }
  return { list: out, keys: keys };
}

async function bookingsOf(from, to, keys) {
  const B = bounds(from, to);
  const snap = await db.collection('bookings').where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(B.start)).get();
  const out = [];
  snap.forEach(function (doc) {
    const b = doc.data() || {};
    const p = b.prospect || {};
    const lr = (b.leadId && keys[b.leadId]) || keys.p9[phone9(p.telephone || p.phone)] || keys.em[String(p.email || '').toLowerCase().trim()] || null;
    out.push({
      ref: ref(doc.id), leadRef: lr, hasLeadId: !!b.leadId,
      createdDay: parisDay(ms(b.createdAt)), date: b.date || null,
      type: b.type || null, source: b.source || null, status: b.status || null, outcome: b.outcome || null,
      isCoaching: b.isCoaching === true, excluded: b.skipLeadCreation === true || !!b.clientId,
      rescheduledFrom: ref(b.rescheduledFromId), rescheduledTo: ref(b.rescheduledToId), rescheduled: b.rescheduled === true,
      cancellationKind: (b.cancellation && b.cancellation.kind) || null,
      landing: landingOf(b.landing)
    });
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  const q = req.query || {};
  try {
    if (q.part === 'page') {
      const snap = await db.collection('tunnels').doc(String(q.tunnel || '')).get();
      if (!snap.exists) { res.status(404).json({ error: 'tunnel' }); return; }
      const t = snap.data() || {};
      const st = (t.steps || []).filter(function (s) { return s && s.id === q.step; })[0];
      const v = st && (st.variants || []).filter(function (x) { return x && x.id === (q.v || 'a'); })[0];
      if (!v || !v.html || !v.html.path) { res.status(404).json({ error: 'variant' }); return; }
      const [buf] = await storage.bucket().file(v.html.path).download();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Page-Version', String(v.html.version || ''));
      res.status(200).send(buf.toString('utf8'));
      return;
    }
    const from = isoOk(q.from) ? q.from : '2026-11-03';
    const to = isoOk(q.to) ? q.to : new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const parts = String(q.only || 'tunnels,views,stats,quiz,leads,bookings,ads,adsad').split(',');
    const out = { from: from, to: to, generatedAt: new Date().toISOString() };
    const L = parts.indexOf('leads') >= 0 || parts.indexOf('bookings') >= 0 ? await leadsOf(from, to) : null;
    const jobs = [];
    if (parts.indexOf('tunnels') >= 0) jobs.push(tunnelsList().then(function (x) { out.tunnels = x; }));
    if (parts.indexOf('views') >= 0) jobs.push(byDate('page_views_daily', from, to).then(function (x) { out.page_views_daily = x; }));
    if (parts.indexOf('stats') >= 0) jobs.push(byDate('tunnel_stats_daily', from, to).then(function (x) { out.tunnel_stats_daily = x; }));
    if (parts.indexOf('quiz') >= 0) jobs.push(byDate('quiz_funnel_daily', from, to).then(function (x) { out.quiz_funnel_daily = x; }));
    if (parts.indexOf('ads') >= 0) jobs.push(byDate('ads_insights', from, to).then(function (x) { out.ads_insights = x; }));
    if (parts.indexOf('visits') >= 0) jobs.push(byDate('tunnel_visits', from, to).then(function (x) {
      /* Journal par visite (T3) : agrégats seulement, jamais les visites une à une. */
      const agg = {};
      x.forEach(function (v) {
        Object.keys(v.p || {}).forEach(function (pk) {
          const e = v.p[pk] || {}, k = v.date + '|' + pk;
          const a = agg[k] || (agg[k] = { visits: 0, view: 0, cta: 0, start: 0, done: 0, optin: 0, answeredQ: 0 });
          a.visits++; ['view', 'cta', 'start', 'done', 'optin'].forEach(function (f) { if (e[f]) a[f]++; });
          a.answeredQ += Object.keys(e.a || {}).length;
        });
      });
      out.tunnel_visits = agg;
    }));
    if (parts.indexOf('adsad') >= 0) {
      jobs.push(byDate('ads_insights_ad', from, to).then(function (x) { out.ads_insights_ad = x; }));
      jobs.push(db.collection('ads_creatives').get().then(function (snap) {
        out.ads_creatives = [];
        snap.forEach(function (d) { const c = d.data() || {}; out.ads_creatives.push({ ad_id: d.id, ad_name: c.ad_name || null, adset_name: c.adset_name || null, campaign_id: c.campaign_id || null, campaign_name: c.campaign_name || null }); });
      }));
    }
    if (L && parts.indexOf('leads') >= 0) out.leads = L.list;
    if (L && parts.indexOf('bookings') >= 0) jobs.push(bookingsOf(from, to, L.keys).then(function (x) { out.bookings = x; }));
    await Promise.all(jobs);
    res.status(200).json(out);
  } catch (e) {
    console.error('[quiz-audit]', e && e.message);
    res.status(500).json({ error: 'audit', message: String(e && e.message || e).slice(0, 300) });
  }
};
