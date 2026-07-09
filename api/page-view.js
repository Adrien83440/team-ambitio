// ============================================================================
// api/page-view.js
// ----------------------------------------------------------------------------
// Beacon de comptage des VUES des pages d'opt-in (system.io) pour le taux
// d'opt-in réel du Funnel Sales : taux = leads / vues.
//
// URL  : POST https://team.alteore.com/api/page-view
// Auth : AUCUNE — beacon navigateur public (comme un pixel). Le snippet
//        côté page (voir SNIPPET-PAGEVIEW-SYSTEMIO.html) dédoublonne par
//        session via sessionStorage : 1 vue max / page / session.
// CORS : ouvert (*) — la page system.io n'est pas sur team.alteore.com.
//
// Body (JSON) : { "page": "elite" }        // "elite" | "business"
//
// Écriture : incrément atomique Firestore (Admin SDK)
//   page_views_daily/{YYYY-MM-DD}_{page}  →  { date, page, views: +1 }
//   Jour calculé en Europe/Paris (cohérent avec le reste du système).
//
// ─── ANTI-ABUS (léger, assumé) ────────────────────────────────────────
//   - slug forcé dans la whitelist ALLOWED_PAGES (tout le reste → 'other')
//     → nombre de documents borné, pas de pollution de collection.
//   - payload minuscule, aucune donnée personnelle, aucun retour de data.
//   - c'est un compteur indicatif de tunnel : la précision "analytics"
//     n'est pas l'objectif (les bots éventuels gonflent marginalement).
//
// ─── LECTURE ──────────────────────────────────────────────────────────
// sales-funnel.html (admin only) lit page_views_daily sur la période.
// Rule Firestore : read isAdmin(), write false (Admin SDK uniquement).
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

// Pages d'opt-in reconnues. Ajouter ici tout nouveau tunnel.
const ALLOWED_PAGES = ['elite', 'business'];

function todayIsoParis() {
  // 'en-CA' → format YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let page = 'other';
  try {
    const body = parseBody(req) || {};
    const raw = String(body.page || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (ALLOWED_PAGES.indexOf(raw) >= 0) page = raw;
  } catch (e) {
    // body illisible → compté en 'other'
  }

  const date = todayIsoParis();
  const docId = date + '_' + page;

  try {
    await db.collection('page_views_daily').doc(docId).set({
      date,
      page,
      views: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.error('[page-view] firestore error:', e.message);
    // On répond 200 quand même : un beacon ne doit jamais faire d'erreur
    // visible côté page marketing.
  }

  res.status(200).json({ ok: true });
};
