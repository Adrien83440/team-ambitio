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
//
// Anti-abus : tunnel et étape doivent exister dans le registre (cache
// 20 s), événement dans une liste fermée, chaînes bornées. Compteur
// indicatif, jamais une donnée personnelle.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const Reg = require('./_tunnelRegistry');

const EVENTS = { visit: 1, view: 1, cta: 1 };

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
  const tunnel = hit.tunnel, step = hit.step;

  const FV = admin.firestore.FieldValue;
  const inc = FV.increment(1);
  const date = todayIsoParis();
  const pageK = Reg.pageKey(tunnel, step);
  const writes = [];

  if (event === 'view' || event === 'cta') {
    const docId = date + '_' + pageK + (variant ? '--' + variant : '');
    const patch = {
      date: date, page: pageK, variant: variant, tunnelId: tunnel.id, stepId: step.id,
      pageLabel: Reg.pageLabel(tunnel, step),
      updatedAt: FV.serverTimestamp()
    };
    patch[event === 'view' ? 'views' : 'ctas'] = inc;
    writes.push(db.collection('page_views_daily').doc(docId).set(patch, { merge: true }));
  }

  const field = event === 'visit' ? 'visits' : (event === 'view' ? 'views' : 'ctas');
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
  if (event === 'visit' || event === 'cta') {
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
