// ==========================================================================
// api/_firebaseAdmin.js
// --------------------------------------------------------------------------
// Initialise le Firebase Admin SDK UNE SEULE FOIS par cold start (pattern
// singleton Node). Toutes les Vercel Functions importent { db, admin, storage }
// depuis ici au lieu de ré-initialiser à chaque requête.
//
// Les credentials viennent des variables d'environnement Vercel :
//   - FIREBASE_ADMIN_PROJECT_ID
//   - FIREBASE_ADMIN_CLIENT_EMAIL
//   - FIREBASE_ADMIN_PRIVATE_KEY
//
// NOTE : Vercel stocke la private_key avec des \n littéraux (deux caractères
// backslash + n) dans la variable d'env. Il faut les reconvertir en vrais
// retours à la ligne avant de passer à admin.credential.cert().
//
// IMPORTANT — Storage bucket :
// Le projet ambitio-team utilise le nouveau format Firebase Storage
// (.firebasestorage.app) et PAS l'ancien format GCS legacy (.appspot.com).
// Les nouveaux projets Firebase créés depuis mi-2024 sont sur ce nouveau
// backend. Si on laisse le défaut Admin SDK (.appspot.com), l'upload de
// fichiers échoue avec "The specified bucket does not exist."
// Le nom exact est dans la console frontend firebase.initializeApp().
// ==========================================================================

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
    // Bucket Firebase Storage — nouveau format .firebasestorage.app.
    // Override possible via FIREBASE_STORAGE_BUCKET env var si besoin.
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      `${process.env.FIREBASE_ADMIN_PROJECT_ID}.firebasestorage.app`,
  });
}

const db = admin.firestore();
const storage = admin.storage();

module.exports = { admin, db, storage };
