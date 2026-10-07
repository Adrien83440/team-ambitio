// ============================================================================
// api/tunnel-preview.js — APERÇU D'UN HTML NON PUBLIÉ (10/2026)
// ----------------------------------------------------------------------------
// L'éditeur de code d'admin-tunnels.html envoie le HTML en cours d'édition ;
// la fonction le renvoie rendu EXACTEMENT comme api/tunnel-render.js le
// servirait en aperçu : charset / viewport, window.ALTEO_TUNNEL (preview:
// true → aucune mesure, aucun pixel), runtime en ligne, SEO et head de
// l'étape. L'admin l'affiche dans un <iframe srcdoc>.
//
//   POST /api/tunnel-preview  { tunnelId, stepId, variantId, html }
//   → 200 text/html : la page injectée (jamais mise en cache, noindex).
//
// Auth : admin uniquement (Bearer Firebase). Aucune écriture : rien n'est
// publié tant que l'admin ne clique pas « Publier » (Storage, côté client).
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const Reg = require('./_tunnelRegistry');
const Render = require('./tunnel-render');
const Legal = require('./_legal');

const MAX_HTML = 4 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req);
  const tunnelId = String(body.tunnelId || '').trim().slice(0, 80);
  const stepId = String(body.stepId || '').trim().slice(0, 80);
  const variantId = Reg.cleanSlug(body.variantId, 20) || 'a';
  const html = typeof body.html === 'string' ? body.html : '';
  if (!tunnelId || !stepId) { res.status(400).json({ error: 'tunnelId et stepId requis' }); return; }
  if (html.length < 40 || html.indexOf('<') < 0) { res.status(400).json({ error: 'Ce contenu ne ressemble pas à une page HTML' }); return; }
  if (html.length > MAX_HTML) { res.status(413).json({ error: 'Page trop lourde (4 Mo max)' }); return; }
  /* Refuser une page déjà injectée (config + runtime), pas une page qui lit window.ALTEO_TUNNEL. */
  if (/window\.ALTEO_TUNNEL\s*=\s*\{|__alteoRuntime|tunnel-runtime\.js/.test(html)) { res.status(400).json({ error: 'La page contient déjà le runtime Alteore' }); return; }

  const doc = await db.collection('tunnels').doc(tunnelId).get();
  if (!doc.exists) { res.status(404).json({ error: 'Tunnel introuvable' }); return; }
  const tunnel = Reg.normalizeTunnel(doc.id, doc.data());
  const step = tunnel.steps.filter(function (s) { return s.id === stepId; })[0];
  if (!step) { res.status(404).json({ error: 'Étape introuvable (ou archivée)' }); return; }
  const variant = step.variants.filter(function (v) { return v.id === variantId; })[0] || { id: variantId };

  const config = Render.buildConfig(tunnel, step, variant, true);
  const extra = Render.buildExtra(tunnel, step, true);
  const out = Render.inject(Legal.apply(html, await Legal.getLegal(), { footer: tunnel.kind !== 'raw' }), config, extra);

  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(out);
};
