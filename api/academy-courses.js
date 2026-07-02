// ============================================================================
// api/academy-courses.js — LISTE DES FORMATIONS AE ACADEMY (V11b)
// ----------------------------------------------------------------------------
// Appelé par l'éditeur de modèles de contrat (sales-signatures.html) pour
// remplir le menu « Formation AE Academy » : id + nom des vraies formations,
// rien d'autre.
//
// URL  : POST https://team.alteore.com/api/academy-courses
// Auth : Bearer ID token Firebase (n'importe quel membre d'équipe connecté).
// Body : {}
//
// Relais serveur → serveur vers le pont (le secret ACADEMY_BRIDGE_KEY ne
// transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/catalog
//
// Réponses 200 (fail-soft — l'éditeur retombe sur le mode Automatique) :
//   { ok:true, courses:[ { id, name }, … ] }
//   { ok:false, error:"bridge_not_configured"|"academy_unreachable" }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) {
    res.status(200).json({ ok: false, error: 'bridge_not_configured' });
    return;
  }

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: '{}',
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) {
      res.status(200).json({ ok: false, error: 'academy_unreachable' });
      return;
    }
    res.status(200).json({ ok: true, courses: Array.isArray(j.courses) ? j.courses : [] });
  } catch (e) {
    console.error('[academy-courses]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
