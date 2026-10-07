// ============================================================================
// api/_legal.js — LIENS LÉGAUX UNIQUES (CGV, mentions, confidentialité) — 10/2026
// ----------------------------------------------------------------------------
// Les trois liens se saisissent UNE fois (Site & pages → Contenu → « Liens
// légaux », enregistrés dans site_config/public.config.legal via
// api/site-config.js) et s'appliquent à toutes les pages servies par
// api/tunnel-render.js, sans redéposer aucun HTML :
//
//   · RÉÉCRITURE — tout <a> reconnu comme lien légal reçoit l'URL configurée.
//     Reconnu = (1) attribut data-legal="cgv|mentions|confidentialite", ou
//     (2) href vers les anciennes pages ambitiocorp.com (Systeme.io), ou
//     (3) texte du lien : « CGV », « Conditions générales de vente »,
//     « Mentions légales », « Politique de confidentialité ».
//     Les blocs <script> et <style> ne sont jamais touchés.
//   · PIED DE PAGE — une page publique (tunnel, site, pages communes) qui ne
//     contient AUCUN lien légal reçoit une ligne discrète avant </body>.
//     Jamais sur les Pages simples (pages clients) : décidé par l'appelant.
//
// booking.html et alteoforms-render.html (team.alteore.com) lisent la même
// config via GET /api/site-config (legal-footer.js).
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const KEYS = ['mentions', 'cgv', 'confidentialite'];
const LABELS = { mentions: 'Mentions légales', cgv: 'CGV', confidentialite: 'Politique de confidentialité' };

/* Valeurs actuelles des pages (codées en dur) : tant que rien n'est
   enregistré, la réécriture ne change rien. */
const DEFAULTS = {
  mentions: 'https://www.ambitiocorp.com/mentionslegales',
  cgv: 'https://www.ambitiocorp.com/cgv',
  confidentialite: 'https://www.ambitiocorp.com/politiquedeconfidentialite',
  footer: true
};

/* Anciennes adresses reconnues quel que soit le texte du lien. */
const LEGACY_HREF = {
  mentions: /ambitiocorp\.com\/mentions-?legales/i,
  cgv: /ambitiocorp\.com\/cgv(?![a-z0-9-])/i,
  confidentialite: /ambitiocorp\.com\/politique-?de-?confidentialite/i
};

const TEXT = {
  mentions: /^mentions l[eé]gales$/,
  cgv: /^(cgv|conditions g[eé]n[eé]rales de vente)$/,
  confidentialite: /^politique de confidentialit[eé]$/
};

function url(v) {
  const u = String(v == null ? '' : v).trim().slice(0, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}

function sanitize(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  KEYS.forEach(function (k) { out[k] = url(c[k]) || DEFAULTS[k]; });
  out.footer = c.footer !== false;
  return out;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Texte visible d'un lien, normalisé : sans balises, entités courantes
   décodées, espaces écrasés, minuscules, ponctuation de fin retirée. */
function linkText(inner) {
  return String(inner || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&eacute;/gi, 'é').replace(/&#0*233;/g, 'é').replace(/&#x0*e9;/gi, 'é')
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[\s  ]+/g, ' ')
    .trim().toLowerCase()
    .replace(/[\s.:;,!»«]+$/, '');
}

function keyOf(attrs, inner) {
  const m = /\bdata-legal\s*=\s*["']?([a-z]+)/i.exec(attrs);
  if (m && LABELS[m[1].toLowerCase()]) return m[1].toLowerCase();
  const h = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs);
  const href = h ? h[1].replace(/^["']|["']$/g, '') : '';
  for (const k of KEYS) if (href && LEGACY_HREF[k].test(href)) return k;
  const t = linkText(inner);
  for (const k of KEYS) if (TEXT[k].test(t)) return k;
  return null;
}

function rewriteSegment(html, legal, state) {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, function (all, attrs, inner) {
    const k = keyOf(attrs, inner);
    if (!k) return all;
    state.found = true;
    const target = legal[k];
    if (!target) return all;
    const val = 'href="' + escAttr(target) + '"';
    const next = /\bhref\s*=/i.test(attrs)
      ? attrs.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, val)
      : attrs + ' ' + val;
    return '<a' + next + '>' + inner + '</a>';
  });
}

/* HTML → { html, found } ; found = au moins un lien légal reconnu. */
function rewrite(html, legal) {
  const state = { found: false };
  const parts = String(html).split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i);
  for (let i = 0; i < parts.length; i += 2) parts[i] = rewriteSegment(parts[i], legal, state);
  return { html: parts.join(''), found: state.found };
}

function footerHtml(legal) {
  const links = KEYS.filter(function (k) { return legal[k]; }).map(function (k) {
    return '<a data-legal="' + k + '" href="' + escAttr(legal[k]) + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;margin:0 8px;white-space:nowrap">' + LABELS[k] + '</a>';
  });
  if (!links.length) return '';
  return '<div data-alteo-legal style="display:block;box-sizing:border-box;width:100%;clear:both;margin:0;padding:18px 16px 22px;text-align:center;'
    + 'font:12px/1.8 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#8a8f9c;background:transparent">'
    + links.join('') + '</div>';
}

/* Réécriture + pied de page si la page n'a aucun lien légal (opts.footer). */
function apply(html, legal, opts) {
  const r = rewrite(html, legal);
  if (r.found || !(opts && opts.footer) || legal.footer === false) return r.html;
  const foot = footerHtml(legal);
  if (!foot) return r.html;
  const at = r.html.search(/<\/body>(?![\s\S]*<\/body>)/i);
  return at >= 0 ? r.html.slice(0, at) + foot + r.html.slice(at) : r.html + foot;
}

/* Config en cache 20 s par instance (même rythme que le registre des tunnels). */
const CACHE_MS = 20 * 1000;
let _cache = { at: 0, data: null, promise: null };
function getLegal() {
  const now = Date.now();
  if (_cache.data && now - _cache.at < CACHE_MS) return Promise.resolve(_cache.data);
  if (_cache.promise) return _cache.promise;
  _cache.promise = db.collection('site_config').doc('public').get().then(function (snap) {
    const d = snap.exists ? (snap.data() || {}) : {};
    const data = sanitize(d.config && d.config.legal);
    _cache = { at: Date.now(), data: data, promise: null };
    return data;
  }, function (e) {
    _cache.promise = null;
    if (_cache.data) return _cache.data;
    console.error('[legal] lecture site_config :', e && e.message);
    return sanitize({});   // fail-safe : défauts, la page est servie quand même
  });
  return _cache.promise;
}

module.exports = { KEYS, LABELS, DEFAULTS, sanitize, rewrite, footerHtml, apply, getLegal };
