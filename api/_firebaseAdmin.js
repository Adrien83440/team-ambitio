// api/_firebaseAdmin.js — même code + preferRest:true (fix DEADLINE_EXCEEDED Vercel)
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey,
    }),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      `${process.env.FIREBASE_ADMIN_PROJECT_ID}.firebasestorage.app`,
  });

  // Fix DEADLINE_EXCEEDED en Vercel serverless :
  // Le SDK Admin utilise gRPC par défaut → timeout >60s au cold start.
  // preferRest:true bascule sur HTTP/REST, beaucoup plus fiable en serverless.
  admin.firestore().settings({ preferRest: true });
}

const db      = admin.firestore();
const storage = admin.storage();

module.exports = { admin, db, storage };
