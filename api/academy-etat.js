// ============================================================================
// api/academy-etat.js — L'EXÉCUTION DU CLIENT, DANS LA FICHE COACHING
// ----------------------------------------------------------------------------
// POURQUOI. Le coach travaille ici. L'avancement réel de son client — ses
// milestones, ses étapes, ses six outils — vit dans l'Academy. Jusqu'à cette
// route, la fiche ne pouvait afficher qu'un lien « ouvrir l'Academy » : le
// coach changeait d'onglet pour savoir si l'outil 03 était rempli.
//
// URL  : POST https://team.alteore.com/api/academy-etat
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { "email": "client@exemple.com" }
//
// Relais serveur → serveur (le secret ne transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/etat-parcours
//
// LA RÉPONSE EST TRANSMISE TELLE QUELLE. L'Academy filtre déjà à la source ce
// qu'elle refuse de laisser sortir — les notes du coach, la décision d'étape,
// le CONTENU des outils. Remodeler ici n'ajouterait aucune sécurité et
// créerait un deuxième endroit où la forme peut diverger.
//
// ⚠️ Les états d'étape sont BRUTS (« a_completer », « bloquante ») : ils sont
// destinés à l'équipe. Si cette réponse devait un jour alimenter un écran vu
// par un dirigeant, il faudrait les traduire d'abord.
//
// Réponses 200 (fail-soft — la fiche affiche un message doux, rien ne casse) :
//   { ok:true, found:false }                       → aucun compte Academy
//   { ok:true, found:true, … }                     → l'état du parcours
//   { ok:false, error:"bridge_not_configured"|"forbidden"|"academy_unreachable" }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden' });
    return;
  }

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) {
    res.status(200).json({ ok: false, error: 'bridge_not_configured' });
    return;
  }

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { body = {}; }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    res.status(200).json({ ok: false, error: 'email_required' });
    return;
  }

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/etat-parcours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: email }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    res.status(200).json(j);
  } catch (e) {
    console.error('[academy-etat]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
