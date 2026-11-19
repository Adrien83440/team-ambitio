// ============================================================================
// api/_verifyFirebaseAuth.js
// ----------------------------------------------------------------------------
// Helper partagé pour vérifier l'authentification Firebase sur toutes les
// Vercel Functions qui ont besoin d'un user connecté.
//
// Usage dans une Vercel Function :
//
//   const { requireAuth, requireAdmin } = require('./_verifyFirebaseAuth');
//
//   module.exports = async (req, res) => {
//     const auth = await requireAdmin(req, res);
//     if (!auth) return;  // La fonction helper a déjà répondu 401/403
//
//     // À partir d'ici on a auth.uid, auth.role, auth.email, auth.userData
//     // ... ta logique métier ...
//   };
//
// Protocole côté frontend :
//   1. Récupérer un ID token Firebase : const idToken = await firebase.auth().currentUser.getIdToken();
//   2. Le mettre dans le header : fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');

/**
 * Vérifie le Bearer token Firebase dans le header Authorization.
 * Retourne un objet { uid, email, role, userData } si valide.
 * Lance une erreur avec .statusCode 401 ou 403 sinon.
 */
async function verifyFirebaseAuth(req) {
  // 0. Appel INTERNE (même processus) — api/_internalCall.js. Une tâche
  //    planifiée réutilise une route existante sans jeton navigateur : elle
  //    pose req._internalAuth sur un objet requête qu'elle construit elle-même.
  //    Une requête réseau ne peut pas porter cette propriété JavaScript (seuls
  //    en-têtes, corps et URL viennent de l'extérieur) : pas de contournement
  //    possible depuis Internet. uid null = tâche automatique pour _ai.js.
  if (req && req._internalAuth && typeof req._internalAuth === 'object' && req._internalAuth.internal === true) {
    return req._internalAuth;
  }

  // 1. Extraire le token du header Authorization
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or invalid Authorization header (expected "Bearer <token>")');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    const err = new Error('Empty Bearer token');
    err.statusCode = 401;
    throw err;
  }

  // 2. Vérifier le token auprès de Firebase Auth
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (verifyErr) {
    console.warn('[verifyFirebaseAuth] Token verification failed:', verifyErr.message);
    const err = new Error('Invalid or expired Firebase token');
    err.statusCode = 401;
    throw err;
  }

  const uid = decoded.uid;

  // 3. Charger le doc user Firestore pour récupérer le rôle
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    const err = new Error('User document not found in Firestore');
    err.statusCode = 403;
    throw err;
  }

  const userData = userSnap.data();

  return {
    uid,
    email: decoded.email || userData.email || null,
    role: userData.role || null,
    userData,
  };
}

/**
 * Convenience helper : vérifie l'auth et répond 401/403 automatiquement
 * si ça échoue. Retourne l'objet auth si OK, null sinon.
 *
 * Le caller DOIT faire `if (!auth) return;` juste après pour arrêter
 * l'exécution si auth a échoué (parce que res a déjà été envoyée).
 */
async function requireAuth(req, res) {
  try {
    return await verifyFirebaseAuth(req);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Authentication failed' });
    return null;
  }
}

/**
 * Comme requireAuth, mais vérifie en plus que le user a role === "admin".
 */
async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401

  if (auth.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return null;
  }

  return auth;
}

/**
 * Comme requireAuth, mais pour le DÉCLENCHEMENT des prélèvements GoCardless
 * (endpoints gocardless-payment + gocardless-finalize). Autorise :
 *   - les admins — peuvent déclencher tous les paiements ;
 *   - tout utilisateur avec users/{uid}.paymentsTrigger === true, quel que
 *     soit son rôle (sales, csm…) — peut déclencher tous les paiements ;
 *   - les sales SANS flag — régime historique : uniquement leurs propres
 *     paiements. Le check createdBy reste à la charge de l'endpoint :
 *       if (!auth.canTriggerAll && pay.createdBy !== auth.uid) → 403
 * Pose auth.canTriggerAll = true quand le droit couvre tous les paiements.
 * Miroir du helper Firestore rules canTriggerPayments() et de la case
 * « 🚀 Déclenchement des prélèvements » dans admin-users.html.
 * NE COUVRE PAS : création, génération/envoi du lien mandat, annulation —
 * ces endpoints gardent leur gate d'origine (admin ou sales propriétaire).
 */
async function requirePaymentsTrigger(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401/403

  const canTriggerAll = auth.role === 'admin' || auth.userData.paymentsTrigger === true;
  if (!canTriggerAll && auth.role !== 'sales') {
    res.status(403).json({ error: 'Droit de déclenchement requis (paymentsTrigger)' });
    return null;
  }

  auth.canTriggerAll = canTriggerAll;
  return auth;
}

/**
 * LECTEUR FUNNEL (19/11/2026) — rôle `funnel_viewer` : compte en lecture
 * seule du module Stats funnel (sales-funnel.html), créé pour la média
 * buyeuse. Autorise les admins ET ce rôle, pour les seules routes de LECTURE
 * du module (statut / journal de l'API Conversions, dry-run du cron, coût de
 * setting agrégé). Un compte au statut « disabled » ou dont l'échéance
 * (users/{uid}.expiresAt, liens d'accès api/funnel-acces.js) est passée est
 * refusé.
 * Pose auth.readOnly = true pour le lecteur : l'endpoint refuse alors toute
 * écriture.
 */
const FUNNEL_VIEWER_ROLE = 'funnel_viewer';
async function requireFunnelReader(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null; // requireAuth a déjà répondu 401/403

  if (auth.role === 'admin') { auth.readOnly = false; return auth; }
  /* Lien d'accès (api/funnel-acces.js) : échéance portée par users/{uid}. */
  const exp = auth.userData.expiresAt;
  const expMs = exp && typeof exp.toMillis === 'function' ? exp.toMillis() : (exp ? Date.parse(exp) : null);
  const notExpired = !expMs || expMs > Date.now();
  if (auth.role === FUNNEL_VIEWER_ROLE && auth.userData.status !== 'disabled' && notExpired) {
    auth.readOnly = true;
    return auth;
  }
  res.status(403).json({ error: 'Accès Stats funnel requis' });
  return null;
}

module.exports = {
  verifyFirebaseAuth,
  requireAuth,
  requireAdmin,
  requirePaymentsTrigger,
  requireFunnelReader,
  FUNNEL_VIEWER_ROLE,
};
