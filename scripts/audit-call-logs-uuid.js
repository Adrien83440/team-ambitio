// ============================================================================
// scripts/audit-call-logs-uuid.js — LECTURE SEULE
// ----------------------------------------------------------------------------
// Depuis le passage de Ringover aux webhooks 2.0 (constaté le 14/09/2026),
// api/ringover-call-status.js écrivait chaque événement dans un doc call_logs
// dont l'id était l'UUID de ressource (data.id) au lieu du call_id numérique.
// Ces docs orphelins n'ont ni userId ni initiatedAt : invisibles dans
// l'historique, mais présents en base.
//
// Ce script COMPTE et LISTE ces orphelins. Il n'écrit RIEN.
// La décision (archivage via un champ _orphan, ou suppression) revient à
// Adrien après lecture du rapport — conformément à la règle « dry-run validé
// avant toute écriture ».
//
// Usage :
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/<service-account>.json \
//     node scripts/audit-call-logs-uuid.js
// ============================================================================

const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'ambitio-team' });
const db = admin.firestore();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  let scanned = 0;
  let orphans = 0;
  const samples = [];
  let last = null;

  // Parcours paginé par id de document (pas de champ requis, pas d'index).
  for (;;) {
    let q = db.collection('call_logs')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    snap.forEach(doc => {
      scanned++;
      if (UUID_RE.test(doc.id)) {
        orphans++;
        if (samples.length < 20) {
          const x = doc.data() || {};
          samples.push({
            id: doc.id,
            status: x.status || null,
            durationSec: x.durationSec != null ? x.durationSec : null,
            updatedAt: x.updatedAt && x.updatedAt.toDate ? x.updatedAt.toDate().toISOString() : null,
            hasUserId: !!x.userId,
            hasInitiatedAt: !!x.initiatedAt,
          });
        }
      }
    });

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  console.log('call_logs scannés   :', scanned);
  console.log('orphelins UUID      :', orphans);
  console.log('échantillon (20 max):');
  samples.forEach(s => console.log(' ', JSON.stringify(s)));
  console.log('\nAucune écriture effectuée (audit lecture seule).');
  process.exit(0);
})().catch(e => { console.error('Erreur:', e.message); process.exit(1); });
