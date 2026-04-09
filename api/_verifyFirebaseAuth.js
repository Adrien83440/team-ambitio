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

module.exports = {
  verifyFirebaseAuth,
  requireAuth,
  requireAdmin,
};
