/**
 * api/_billing-helpers.js
 *
 * Module utilitaire partagé par les Vercel Functions de facturation :
 *   - auth Bearer (Firebase ID token + role check)
 *   - SHA-256 (preuve d'intégrité du PDF)
 *   - chunking base64 (stockage Firestore < 1 MB par doc)
 *
 * Le préfixe underscore exclut ce fichier du routing Vercel — il n'est
 * importable que par d'autres fichiers du dossier api/.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

/* ─── Firebase Admin init (idempotent) ─── */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const auth = admin.auth();

/**
 * Vérifie le Bearer token de la requête et retourne le user Firebase
 * + son rôle depuis la collection `users`.
 *
 * Lance une erreur structurée { status, message } à intercepter par
 * l'appelant pour répondre proprement.
 */
async function requireAuth(req, allowedRoles) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    const e = new Error('Missing Bearer token'); e.status = 401; throw e;
  }
  const idToken = header.substring(7);
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch (err) {
    const e = new Error('Invalid token'); e.status = 401; throw e;
  }
  const userSnap = await db.collection('users').doc(decoded.uid).get();
  if (!userSnap.exists) {
    const e = new Error('User not found'); e.status = 403; throw e;
  }
  const userData = userSnap.data();
  const role = userData.role;
  if (allowedRoles && allowedRoles.indexOf(role) === -1) {
    const e = new Error('Insufficient role: ' + role); e.status = 403; throw e;
  }
  return { uid: decoded.uid, email: decoded.email || userData.email, role: role, userData: userData };
}

/**
 * Variante de requireAuth qui accepte AUSSI un header x-system-key.
 * 
 * Si la requête présente un header `x-system-key` valide pour la purpose
 * demandée (vérifié contre _config/system_keys.{purpose}), bypass le Bearer
 * token et retourne un user système avec role='admin' et isSystem=true.
 * 
 * Sinon, fallback sur requireAuth classique.
 * 
 * Utilisé par les endpoints appelables à la fois depuis le frontend (Bearer
 * admin) et depuis les Cloud Functions / scripts (x-system-key) — typiquement
 * la génération automatique de factures depuis subscriptions (Step 4B).
 */
async function requireAuthOrSystemKey(req, allowedRoles, systemKeyPurpose) {
  const headerKey = req.headers['x-system-key'];
  if (headerKey && systemKeyPurpose) {
    const keysSnap = await db.collection('_config').doc('system_keys').get();
    const keys = keysSnap.exists ? keysSnap.data() : {};
    const expected = keys[systemKeyPurpose];
    if (expected && headerKey === expected) {
      return {
        uid: 'system_' + systemKeyPurpose,
        email: 'system+' + systemKeyPurpose + '@alteore.local',
        role: 'admin',
        isSystem: true,
        systemPurpose: systemKeyPurpose,
        userData: {},
      };
    }
    /* x-system-key fourni mais invalide → reject explicitement (ne pas fallback Bearer) */
    const e = new Error('Invalid system key for purpose: ' + systemKeyPurpose); e.status = 401; throw e;
  }
  /* Pas de x-system-key → auth classique */
  return await requireAuth(req, allowedRoles);
}

/* ─── SHA-256 ─── */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/* ─── Chunking base64 pour stockage Firestore ─── */
/**
 * Découpe un buffer en chunks base64 stockables dans Firestore.
 * Limite Firestore : 1 MB par document. On utilise 700 KB de string base64
 * par chunk (~525 KB de bytes) pour rester très conservatif.
 */
function chunkBufferToBase64(buffer, maxCharsPerChunk) {
  maxCharsPerChunk = maxCharsPerChunk || 700000;
  const fullBase64 = buffer.toString('base64');
  const chunks = [];
  for (let i = 0; i < fullBase64.length; i += maxCharsPerChunk) {
    chunks.push(fullBase64.substring(i, i + maxCharsPerChunk));
  }
  return chunks;
}

/**
 * Reconstitue un buffer à partir des chunks (ordre garanti par index).
 */
function reassembleBase64Chunks(chunkDocs) {
  const sorted = chunkDocs.slice().sort(function(a, b){ return (a.index || 0) - (b.index || 0); });
  const fullBase64 = sorted.map(function(c){ return c.data || ''; }).join('');
  return Buffer.from(fullBase64, 'base64');
}

/* ─── Date helpers ─── */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateFr(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* ─── Réponse helpers ─── */
function sendError(res, err) {
  console.error('[billing] error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal error', code: err.code || null });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-system-key');
}

module.exports = {
  admin: admin,
  db: db,
  auth: auth,
  requireAuth: requireAuth,
  requireAuthOrSystemKey: requireAuthOrSystemKey,
  sha256: sha256,
  chunkBufferToBase64: chunkBufferToBase64,
  reassembleBase64Chunks: reassembleBase64Chunks,
  addDays: addDays,
  formatDateFr: formatDateFr,
  sendError: sendError,
  setCors: setCors,
};
