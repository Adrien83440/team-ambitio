// ============================================================================
// api/academy-jalon.js — LE COACH CONSTATE UN JALON DEPUIS LA FICHE CLIENT
// ----------------------------------------------------------------------------
// POURQUOI. Le coach tient sa séance ici, dans la fiche coaching. Le jalon
// de son client — « M2 atteint », « M3 manqué, parce que… » — se constatait
// uniquement dans l'Academy : un autre onglet, un autre écran, et l'acte
// finissait par ne pas être posé. Cette route le pose depuis la fiche.
//
// URL  : POST https://team.alteore.com/api/academy-jalon
// Auth : Bearer ID token Firebase — rôles admin / coach UNIQUEMENT.
//        La CSM relance et alerte, elle ne juge pas l'atteinte d'un jalon :
//        même matrice de droits que dans l'Academy.
// Body : { "email": "client@exemple.com", "code": "M2",
//          "statut": "atteint" | "partiel" | "manque", "cause": "…" }
//
// Relais serveur → serveur (le secret ne transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/constat-jalon
//
// QUI CONSTATE. L'e-mail du compte Firebase Auth de la personne connectée
// part dans « par » : c'est lui que le journal de l'Academy retient. Une
// personne, jamais un service.
//
// LES RÈGLES SONT CELLES DE L'ACADEMY, appliquées là-bas : un jalon manqué
// sans cause est refusé, « à venir » n'est pas un constat, un code étranger
// à la trame du dossier est refusé. La réponse de l'Academy est TRANSMISE
// TELLE QUELLE, refus compris : le coach doit lire pourquoi, pas se heurter
// à un bouton muet.
//
// Réponses 200 (fail-soft, la fiche affiche le message) :
//   { ok:true, found:false }                       → aucun compte Academy
//   { ok:true, found:true, code, constat }
//   { ok:false, error:"forbidden"|"bridge_not_configured"|"donnees_invalides"
//              |"academy_unreachable"|<erreur Academy>, message? }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach'];
const STATUTS = ['atteint', 'partiel', 'manque'];

function txt(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden', message: 'Réservé aux coachs et administrateurs.' });
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
  const email = txt(body.email, 200).toLowerCase();
  const code = txt(body.code, 8);
  const statut = txt(body.statut, 20);
  const cause = txt(body.cause, 1000);
  const par = txt(auth.email, 200).toLowerCase();

  if (!email || !code || STATUTS.indexOf(statut) < 0) {
    res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Données invalides.' });
    return;
  }
  if (!par) {
    res.status(200).json({ ok: false, error: 'auteur_inconnu', message: 'Compte sans adresse e-mail : le constat ne peut pas être signé.' });
    return;
  }

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/constat-jalon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: email, code: code, statut: statut, cause: cause, par: par }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    // Transmis tel quel, refus compris — le message vient de l'Academy.
    res.status(200).json(j);
  } catch (e) {
    console.error('[academy-jalon]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
