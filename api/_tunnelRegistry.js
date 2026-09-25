// ============================================================================
// api/_tunnelRegistry.js — registre des tunnels de vente hébergés (09/2026)
// ----------------------------------------------------------------------------
// Source : collection Firestore `tunnels/{tunnelId}` (éditée par
// admin-tunnels.html). Un tunnel = un groupe ORDONNÉ d'étapes ; une étape =
// une page publique, avec une ou plusieurs variantes A/B dont le HTML vit
// dans Storage (`tunnels/{tunnelId}/{stepId}/{variantId}/index.html`).
//
// Ce module est partagé par :
//   · api/tunnel-render.js      — sert la page (résolution chemin → étape)
//   · api/tunnel-event.js       — beacon vues / visites / clics CTA
//   · api/tunnel-optin.js       — formulaire d'opt-in → fiche Leads Live
//   · api/page-view.js          — accepte les pages de tunnel comme `lp`
//   · api/booking-attribution.js — libellé + type de lead d'un RDV VSL
//
// CLÉ DE PAGE (`lp` / page_views_daily.page / bookings.landing.page /
// leads.landingFirst.page) : `<slugTunnel>__<slugEtape>`. Le double
// underscore est sans ambiguïté : les slugs n'admettent que [a-z0-9-].
// funnel-core.js reconnaît ce motif (isVslPage) et range la page dans
// l'étape « VSL — prise de RDV directe » du Funnel Sales.
//
// Cache mémoire 20 s par instance : une page marketing sous pub Meta peut
// prendre des centaines de hits par minute, on ne relit pas Firestore à
// chaque fois. Une publication depuis l'admin est visible sous 20 s.
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const CACHE_MS = 20 * 1000;
let _cache = { at: 0, list: null, promise: null };

function cleanSlug(v, max) {
  return String(v == null ? '' : v).toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, max || 40);
}

function cleanPath(v) {
  // Chemin d'URL → slug d'étape : minuscules, sans slashs de bord ni
  // extension .html, un seul segment.
  let p = String(v == null ? '' : v).trim();
  try { p = decodeURIComponent(p); } catch (e) { /* laissé tel quel */ }
  p = p.toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\.html?$/, '');
  if (p === 'index') p = '';
  return p.replace(/[^a-z0-9-\/]/g, '').slice(0, 80);
}

function pageKey(tunnel, step) {
  return cleanSlug(tunnel && tunnel.slug, 40) + '__' + cleanSlug(step && step.slug, 40);
}

function isTunnelPageKey(page) {
  return /^[a-z0-9-]{1,40}__[a-z0-9-]{1,40}$/.test(String(page || ''));
}

function pageLabel(tunnel, step) {
  const t = (tunnel && tunnel.name) || (tunnel && tunnel.slug) || 'Tunnel';
  const s = (step && step.name) || (step && step.slug) || '';
  return s ? t + ' · ' + s : t;
}

/* Chemin public d'une étape : '/' pour la page d'accueil du domaine,
   sinon '/<slug>'. */
function stepPath(tunnel, step) {
  if (!tunnel || !step) return '/';
  if (tunnel.homeStepId && tunnel.homeStepId === step.id) return '/';
  return '/' + cleanSlug(step.slug, 40);
}

function normalizeTunnel(id, d) {
  const t = Object.assign({}, d || {});
  t.id = id;
  t.slug = cleanSlug(t.slug, 40);
  t.name = String(t.name || t.slug || 'Tunnel').slice(0, 120);
  t.status = t.status === 'live' ? 'live' : 'draft';
  t.archived = t.archived === true;
  t.settings = (t.settings && typeof t.settings === 'object') ? t.settings : {};
  t.steps = Array.isArray(t.steps) ? t.steps.filter(function (s) { return s && s.id && s.archived !== true; }) : [];
  t.steps.forEach(function (s) {
    s.slug = cleanSlug(s.slug, 40);
    s.status = s.status === 'live' ? 'live' : 'draft';
    s.variants = Array.isArray(s.variants) ? s.variants.filter(function (v) { return v && v.id; }) : [];
    s.variants.forEach(function (v) {
      v.id = cleanSlug(v.id, 20) || 'a';
      v.status = v.status === 'live' ? 'live' : 'draft';
      v.weight = Math.max(0, Number(v.weight) || 0);
    });
  });
  return t;
}

async function loadAll() {
  const snap = await db.collection('tunnels').get();
  const list = [];
  snap.forEach(function (doc) {
    const t = normalizeTunnel(doc.id, doc.data());
    if (!t.archived && t.slug) list.push(t);
  });
  return list;
}

/* Liste des tunnels non archivés (cache 20 s, dédoublonnage des lectures
   concurrentes au démarrage à froid). */
function getTunnels() {
  const now = Date.now();
  if (_cache.list && now - _cache.at < CACHE_MS) return Promise.resolve(_cache.list);
  if (_cache.promise) return _cache.promise;
  _cache.promise = loadAll().then(function (list) {
    _cache = { at: Date.now(), list: list, promise: null };
    return list;
  }, function (e) {
    _cache.promise = null;
    if (_cache.list) return _cache.list;   // panne passagère : on sert l'ancien registre
    throw e;
  });
  return _cache.promise;
}

function invalidate() { _cache = { at: 0, list: null, promise: null }; }

function isServable(tunnel, step, allowDraft) {
  if (!tunnel || !step) return false;
  if (allowDraft) return true;
  return tunnel.status === 'live' && step.status === 'live';
}

/* Chemin d'URL → { tunnel, step } ou null. '' = page d'accueil. */
async function findByPath(path, opts) {
  const allowDraft = !!(opts && opts.allowDraft);
  const p = cleanPath(path);
  const list = await getTunnels();
  let fallback = null;
  for (const t of list) {
    for (const s of t.steps) {
      const isHome = t.homeStepId && t.homeStepId === s.id;
      const match = p === '' ? isHome : (s.slug === p);
      if (!match) continue;
      if (isServable(t, s, false)) return { tunnel: t, step: s };
      if (allowDraft && !fallback) fallback = { tunnel: t, step: s };
    }
  }
  return fallback;
}

/* Clé de page (`lp`) → { tunnel, step } ou null. */
async function findByPage(page) {
  const key = String(page || '').toLowerCase();
  if (!isTunnelPageKey(key)) return null;
  const list = await getTunnels();
  for (const t of list) {
    for (const s of t.steps) {
      if (pageKey(t, s) === key) return { tunnel: t, step: s };
    }
  }
  return null;
}

async function findByIds(tunnelId, stepId) {
  const list = await getTunnels();
  for (const t of list) {
    if (t.id !== tunnelId) continue;
    for (const s of t.steps) if (s.id === stepId) return { tunnel: t, step: s };
  }
  return null;
}

async function isKnownPage(page) {
  return !!(await findByPage(page));
}

/* Étape suivante d'une étape (réglage `next` de l'étape, sinon l'étape
   qui suit dans l'ordre). Retourne une URL relative ('/merci'), absolue
   (réglage « URL ») ou null. */
function nextUrlOf(tunnel, step) {
  const nx = (step && step.next && typeof step.next === 'object') ? step.next : { mode: 'auto' };
  const mode = nx.mode || 'auto';
  if (mode === 'none') return null;
  if (mode === 'url') return String(nx.url || '').slice(0, 500) || null;
  if (mode === 'step') {
    const target = tunnel.steps.filter(function (s) { return s.id === nx.stepId; })[0];
    return target ? stepPath(tunnel, target) : null;
  }
  const idx = tunnel.steps.indexOf(step);
  const following = idx >= 0 ? tunnel.steps[idx + 1] : null;
  return following ? stepPath(tunnel, following) : null;
}

module.exports = {
  cleanSlug, cleanPath, pageKey, isTunnelPageKey, pageLabel, stepPath,
  getTunnels, invalidate, findByPath, findByPage, findByIds, isKnownPage, nextUrlOf
};
