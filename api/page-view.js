// ============================================================================
// api/page-view.js — v3 (vues + variantes A/B + opt-in + clics CTA des VSL)
// ----------------------------------------------------------------------------
// Beacon des pages marketing system.io pour le Funnel Sales :
//   • VUES par page (taux d'opt-in réel = leads / vues)
//   • VUES et OPT-INS par VARIANTE A/B (bloc 🧪 A/B test du funnel, avec
//     significativité statistique calculée côté Alteore)
//   • depuis le 23/09/2026 — PAGES VSL SANS OPT-IN : le visiteur arrive sur
//     la VSL et prend RDV directement. Le beacon compte les VUES et les CLICS
//     sur un bouton « Réserver » ; les RDV, eux, ne sont pas comptés ici mais
//     lus dans la collection `bookings` (bloc `landing` posé par booking.html),
//     qui reste la seule vérité (replanifications et RDV internes exclus).
//
// URL  : POST https://team.alteore.com/api/page-view
// Auth : AUCUNE — beacon navigateur public (comme un pixel). Les pages
//        dédoublonnent par session : 1 vue max / page / session,
//        1 clic max / session, 1 opt-in max / session.
// CORS : ouvert (*) — les pages system.io ne sont pas sur team.alteore.com.
//
// Body (JSON) :
//   { "page": "elite" }                                  → +1 vue page
//   { "page": "elite", "variant": "b" }                  → +1 vue variante B
//   { "page": "elite", "variant": "b", "event": "optin" }→ +1 opt-in variante B
//   { "page": "vsl_elite", "variant": "a" }              → +1 vue VSL variante A
//   { "page": "vsl_elite", "variant": "a", "event": "cta" } → +1 clic CTA
//
// Écriture : incrément atomique Firestore (Admin SDK)
//   page_views_daily/{YYYY-MM-DD}_{page}                 (page sans variante)
//   page_views_daily/{YYYY-MM-DD}_{page}--{variant}      (variante A/B)
//   → { date, page, variant|null, views: n, optins: n, ctas: n }
//   Jour calculé en Europe/Paris.
//
// ─── IMPORTANT — PAS DE DOUBLE COMPTAGE ──────────────────────────────
// Un hit incrémente UN SEUL document (celui de sa variante, ou celui de
// la page si pas de variante). Le total « Vues » du funnel = somme de tous
// les docs de la page → reste exact avec ou sans test.
//
// ─── ANTI-ABUS (léger, assumé) ────────────────────────────────────────
//   - page forcée dans ALLOWED_PAGES (sinon 'other') → docs bornés.
//   - variant nettoyée [a-z0-9_-], 20 car. max.
//   - payload minuscule, aucune donnée personnelle, compteur indicatif.
//
// Rétrocompatible v1/v2 : les anciens snippets continuent de fonctionner.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

// Pages reconnues. Ajouter ici tout nouveau tunnel.
//   elite / business          → pages d'opt-in historiques
//   vsl_elite / vsl_business  → pages VSL à prise de RDV directe (09/2026)
const ALLOWED_PAGES = ['elite', 'business', 'vsl_elite', 'vsl_business'];
const ALLOWED_EVENTS = { view: 1, optin: 1, cta: 1 };

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
  let variant = null;
  let event = 'view';
  try {
    const body = parseBody(req) || {};
    const rawPage = String(body.page || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (ALLOWED_PAGES.indexOf(rawPage) >= 0) page = rawPage;

    const rawVariant = String(body.variant || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    if (rawVariant) variant = rawVariant;

    const rawEvent = String(body.event || '').toLowerCase().trim();
    if (ALLOWED_EVENTS[rawEvent]) event = rawEvent;
  } catch (e) {
    // body illisible → vue 'other'
  }

  const date = todayIsoParis();
  const docId = date + '_' + page + (variant ? '--' + variant : '');

  const patch = {
    date,
    page,
    variant: variant || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (event === 'optin') patch.optins = admin.firestore.FieldValue.increment(1);
  else if (event === 'cta') patch.ctas = admin.firestore.FieldValue.increment(1);
  else patch.views = admin.firestore.FieldValue.increment(1);

  try {
    await db.collection('page_views_daily').doc(docId).set(patch, { merge: true });
  } catch (e) {
    console.error('[page-view] firestore error:', e.message);
    // Un beacon ne doit jamais faire d'erreur visible côté page marketing.
  }

  res.status(200).json({ ok: true });
};
