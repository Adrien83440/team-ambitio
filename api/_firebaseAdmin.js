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
    // Si tu as un bucket custom, précise-le ici. Sinon Firebase Admin utilise
    // le bucket par défaut du projet (ambitio-team.appspot.com).
    storageBucket: `${process.env.FIREBASE_ADMIN_PROJECT_ID}.appspot.com`,
  });
}

const db = admin.firestore();
const storage = admin.storage();

module.exports = { admin, db, storage };
