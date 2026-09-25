// ============================================================================
// api/tunnel-render.js — SERT LES PAGES DES TUNNELS DE VENTE (09/2026)
// ----------------------------------------------------------------------------
// Remplace l'hébergement System.io : les pages HTML écrites par Adrien sont
// déposées depuis admin-tunnels.html dans Storage, et servies ici sur le
// domaine marketing (go.adrienemily.com, puis www.adrienemily.com le jour
// où System.io est arrêté) via les routes par hôte de vercel.json :
//
//   go.adrienemily.com/<chemin>       → /api/tunnel-render?__p=<chemin>
//   team.alteore.com/t/<chemin>       → idem, MODE APERÇU (brouillons
//                                        visibles, aucune mesure, noindex)
//
// Ce que fait la fonction, dans l'ordre :
//   1. résout <chemin> → tunnel + étape (registre en cache 20 s) ;
//   2. choisit la variante A/B : `?v=` forcé, sinon cookie collant 30 j,
//      sinon tirage pondéré par les poids réglés dans l'admin ;
//   3. lit le HTML dans Storage (cache mémoire par version : une page
//      republiée est servie à jour, une page inchangée ne relit rien) ;
//   4. injecte dans le <head> : charset + viewport s'ils manquent, la
//      config `window.ALTEO_TUNNEL` et tunnel-runtime.js EN LIGNE (aucune
//      requête supplémentaire) — beacon, pixel, provenance, opt-in.
//
// Cache CDN : une étape à variante unique est cachée 60 s à l'edge Vercel
// (stale-while-revalidate 10 min) ; avec plusieurs variantes la réponse
// dépend du cookie, donc `private, no-store`. L'aperçu n'est jamais caché.
//
// Aucune donnée personnelle ne transite ici. Fail-safe : toute erreur rend
// une page 404 / 503 sobre, jamais une trace.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { storage } = require('./_firebaseAdmin');
const Reg = require('./_tunnelRegistry');

const PROPAGATE_HOSTS = ['go.adrienemily.com', 'www.adrienemily.com', 'adrienemily.com'];
const COOKIE_DAYS = 30;
const HTML_CACHE_MAX = 40;

let _runtime = null;
function runtimeSource() {
  if (_runtime != null) return _runtime;
  const candidates = [
    path.join(process.cwd(), 'tunnel-runtime.js'),
    path.join(__dirname, '..', 'tunnel-runtime.js')
  ];
  for (const p of candidates) {
    try {
      // Le commentaire d'en-tête (documentation) ne part pas dans les pages.
      _runtime = fs.readFileSync(p, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
      return _runtime;
    } catch (e) { /* suivant */ }
  }
  _runtime = '';
  return _runtime;
}

/* Cache HTML : clé = chemin Storage, valeur = { version, html }. */
const _html = new Map();
async function loadHtml(storagePath, version) {
  const hit = _html.get(storagePath);
  if (hit && hit.version === version) return hit.html;
  const [buf] = await storage.bucket().file(storagePath).download();
  const html = buf.toString('utf8');
  if (_html.size >= HTML_CACHE_MAX) _html.delete(_html.keys().next().value);
  _html.set(storagePath, { version: version, html: html });
  return html;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function pickVariant(variants, forced, cookieVal) {
  const byId = {};
  variants.forEach(function (v) { byId[v.id] = v; });
  if (forced && byId[forced]) return byId[forced];
  if (cookieVal && byId[cookieVal]) return byId[cookieVal];
  const weighted = variants.filter(function (v) { return v.weight > 0; });
  const pool = weighted.length ? weighted : variants;
  const total = pool.reduce(function (s, v) { return s + (v.weight > 0 ? v.weight : 1); }, 0);
  let r = (crypto.randomBytes(4).readUInt32BE(0) / 0xffffffff) * total;
  for (const v of pool) {
    r -= (v.weight > 0 ? v.weight : 1);
    if (r <= 0) return v;
  }
  return pool[pool.length - 1];
}

function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* Injection dans le <head>. Ordre : charset (si absent), viewport (si
   absent), config + runtime. Sans <head> on crée le strict nécessaire. */
function inject(html, config) {
  const runtime = runtimeSource();
  let block = '';
  if (!/<meta[^>]+charset/i.test(html)) block += '<meta charset="utf-8">';
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) block += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  block += '<script>window.ALTEO_TUNNEL=' + jsonForScript(config) + ';</script>';
  block += runtime ? '<script>' + runtime + '</script>' : '<script src="/tunnel-runtime.js"></script>';
  if (config.noindex) block += '<meta name="robots" content="noindex,nofollow">';

  const headOpen = html.match(/<head(\s[^>]*)?>/i);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  const htmlOpen = html.match(/<html(\s[^>]*)?>/i);
  if (htmlOpen) {
    const at2 = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at2) + '<head>' + block + '</head>' + html.slice(at2);
  }
  return '<!DOCTYPE html><html lang="fr"><head>' + block + '</head><body>' + html + '</body></html>';
}

function page(res, status, title, text, extraHeaders) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  Object.keys(extraHeaders || {}).forEach(function (k) { res.setHeader(k, extraHeaders[k]); });
  res.end('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(title) + '</title>'
    + '<style>html,body{margin:0;min-height:100%;background:#0a0a14;color:#f0f0f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
    + '.w{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 20px;text-align:center}'
    + 'h1{font-size:26px;margin:0 0 10px}p{margin:0;color:rgba(240,240,245,.6);font-size:15px;line-height:1.5}</style></head>'
    + '<body><div class="w"><div><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(text) + '</p></div></div></body></html>');
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).end();
    return;
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { page(res, 400, 'Requête invalide', ''); return; }

  const rawPath = url.searchParams.get('__p') || '';
  const previewRoute = url.searchParams.get('__t') === '1';          // /t/… sur team.alteore.com
  const preview = previewRoute || url.searchParams.get('preview') === '1';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const p = Reg.cleanPath(rawPath);

  if (p === 'favicon.ico') { res.status(204).end(); return; }
  if (p === 'robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(previewRoute ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n');
    return;
  }
  if (p.indexOf('/') >= 0) {
    // Les chemins de tunnel n'ont qu'un segment ; tout le reste est inconnu.
    page(res, 404, 'Page introuvable', 'Cette adresse ne correspond à aucune page.');
    return;
  }

  let hit;
  try {
    hit = await Reg.findByPath(p, { allowDraft: preview });
  } catch (e) {
    console.error('[tunnel-render] registre indisponible :', e && e.message);
    page(res, 503, 'Un instant…', 'La page arrive. Rechargez dans quelques secondes.', { 'Retry-After': '5' });
    return;
  }
  if (!hit) {
    page(res, 404, 'Page introuvable', 'Cette adresse ne correspond à aucune page.');
    return;
  }
  const tunnel = hit.tunnel, step = hit.step;
  const variants = step.variants.filter(function (v) {
    return v.html && v.html.path && (preview || v.status === 'live');
  });
  if (!variants.length) {
    page(res, 404, 'Page en préparation', 'Cette page n’a pas encore de contenu publié.');
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieName = 'alt_ab_' + step.id;
  const forced = Reg.cleanSlug(url.searchParams.get('v'), 20);
  const variant = pickVariant(variants, forced, cookies[cookieName]);
  const multi = variants.length > 1;
  if (multi && !previewRoute && cookies[cookieName] !== variant.id) {
    res.setHeader('Set-Cookie', cookieName + '=' + variant.id + '; Max-Age=' + (COOKIE_DAYS * 86400) + '; Path=/; SameSite=Lax; Secure');
  }

  let html;
  try {
    html = await loadHtml(variant.html.path, variant.html.version || 0);
  } catch (e) {
    console.error('[tunnel-render] lecture Storage :', variant.html.path, e && e.message);
    page(res, 503, 'Un instant…', 'La page arrive. Rechargez dans quelques secondes.', { 'Retry-After': '5' });
    return;
  }

  const settings = tunnel.settings || {};
  const config = {
    tunnelId: tunnel.id, tunnelSlug: tunnel.slug, tunnelName: tunnel.name,
    stepId: step.id, stepSlug: step.slug, stepName: step.name || step.slug, stepType: step.type || 'page',
    variant: variant.id,
    page: Reg.pageKey(tunnel, step),
    pixelId: settings.pixelId ? String(settings.pixelId).replace(/[^\d]/g, '') : '',
    nextUrl: Reg.nextUrlOf(tunnel, step),
    bookingUrl: settings.bookingType ? 'https://team.alteore.com/booking.html?type=' + encodeURIComponent(String(settings.bookingType)) : '',
    hosts: PROPAGATE_HOSTS,
    preview: preview,
    noindex: preview || settings.noindex === true,
    eventEndpoint: '/api/tunnel-event',
    optinEndpoint: '/api/tunnel-optin'
  };

  const out = inject(html, config);
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Alteo-Tunnel', tunnel.slug + '/' + step.slug + '/' + variant.id);
  if (preview || multi) res.setHeader('Cache-Control', 'private, no-store');
  else res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
  if (config.noindex) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (host && host !== 'team.alteore.com') res.setHeader('Vary', 'Cookie');
  res.end(req.method === 'HEAD' ? '' : out);
};
