// ============================================================================
// api/persons-merge.js
// ----------------------------------------------------------------------------
// Endpoint admin pour fusionner 2 docs persons en un seul (Step 6.5).
//
// URL  : POST https://team.alteore.com/api/persons-merge
// Auth : Bearer Firebase ID token (admin requis)
// Body : { survivorId: string, mergedId: string }
//
// Comportement (transaction atomique côté Firestore) :
//
//   1. Charge les 2 persons (survivor + merged)
//   2. Réassigne personId sur tous les docs liés du merged → survivor :
//        leads, clients (coaching), invoice_clients, payments, subscriptions
//   3. Sur le survivor :
//      - leadIds, paymentIds, subscriptionIds = union des 2 listes
//      - knownEmails / knownPhones = enrichis avec ceux du merged
//      - _previousEmails / _previousTelephone / _previousNom = archivage
//        des anciennes valeurs du merged
//      - coachingId / invoiceClientId : si survivor n'en a pas et merged en
//        a un, on le récupère sur le survivor
//   4. Sur le merged :
//      - _merged: true, _mergedInto: survivorId
//      - _mergedAt: serverTimestamp, _mergedBy: admin uid
//      - PAS DE SUPPRESSION (règle "jamais supprimer" du projet)
//
// Atomicité : on utilise un batch Firestore (limite 500 ops). Pour les
// volumes attendus (1 humain = au max ~10 docs liés), aucun risque.
//
// Idempotence : si on rappelle l'endpoint avec la même paire, on détecte
// que merged.\_merged === true et on retourne 409 (déjà fusionné).
//
// Loi anti-fraude 2018 : aucune touche aux invoices (validated). Les
// payments et invoice_clients sont juste réassignés via personId, sans
// modification de leur contenu métier.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const { parseBody } = require('./_parseBody');

const COLLECTIONS_WITH_PERSONID = [
  'leads',
  'clients',
  'invoice_clients',
  'payments',
  'subscriptions',
];

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  // Parse body
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body: ' + e.message });
  }

  const { survivorId, mergedId } = body || {};
  if (!survivorId || !mergedId) {
    return res.status(400).json({ error: 'survivorId and mergedId are both required' });
  }
  if (survivorId === mergedId) {
    return res.status(400).json({ error: 'survivorId and mergedId must be different' });
  }

  try {
    // 1. Charger les 2 persons
    const [survivorSnap, mergedSnap] = await Promise.all([
      db.collection('persons').doc(survivorId).get(),
      db.collection('persons').doc(mergedId).get(),
    ]);
    if (!survivorSnap.exists) return res.status(404).json({ error: `Survivor persons/${survivorId} not found` });
    if (!mergedSnap.exists)   return res.status(404).json({ error: `Merged persons/${mergedId} not found` });

    const survivor = survivorSnap.data();
    const merged   = mergedSnap.data();

    // Idempotence : déjà fusionné
    if (merged._merged === true) {
      return res.status(409).json({
        error: `persons/${mergedId} is already merged into persons/${merged._mergedInto || '?'}`,
        alreadyMerged: true,
      });
    }
    if (survivor._merged === true) {
      return res.status(409).json({
        error: `Cannot merge into persons/${survivorId} : it is itself already merged into ${survivor._mergedInto || '?'}`,
      });
    }

    // 2. Lister tous les docs à réassigner — pour chaque collection
    const reassignments = {};  // collection → [docId, docId, ...]
    let totalReassigned = 0;

    for (const coll of COLLECTIONS_WITH_PERSONID) {
      const snap = await db.collection(coll).where('personId', '==', mergedId).get();
      const ids = snap.docs.map(d => d.id);
      if (ids.length > 0) {
        reassignments[coll] = ids;
        totalReassigned += ids.length;
      }
    }

    // 3. Construire le patch survivor (union des arrays + archivage)
    const survivorUpdates = {
      _lastSyncedAt:   admin.firestore.FieldValue.serverTimestamp(),
      _lastMergedAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    };

    // Union des leadIds / paymentIds / subscriptionIds
    const survivorLeads = Array.isArray(survivor.leadIds) ? survivor.leadIds : [];
    const mergedLeads   = Array.isArray(merged.leadIds)   ? merged.leadIds   : [];
    const unionLeads    = Array.from(new Set([...survivorLeads, ...mergedLeads, ...(reassignments.leads || [])]));
    if (unionLeads.length !== survivorLeads.length) survivorUpdates.leadIds = unionLeads;

    const survivorPayments = Array.isArray(survivor.paymentIds) ? survivor.paymentIds : [];
    const mergedPayments   = Array.isArray(merged.paymentIds)   ? merged.paymentIds   : [];
    const unionPayments    = Array.from(new Set([...survivorPayments, ...mergedPayments, ...(reassignments.payments || [])]));
    if (unionPayments.length !== survivorPayments.length) survivorUpdates.paymentIds = unionPayments;

    const survivorSubs = Array.isArray(survivor.subscriptionIds) ? survivor.subscriptionIds : [];
    const mergedSubs   = Array.isArray(merged.subscriptionIds)   ? merged.subscriptionIds   : [];
    const unionSubs    = Array.from(new Set([...survivorSubs, ...mergedSubs, ...(reassignments.subscriptions || [])]));
    if (unionSubs.length !== survivorSubs.length) survivorUpdates.subscriptionIds = unionSubs;

    // Si survivor n'a pas de coachingId et merged en a un → récupérer
    if (!survivor.coachingId && merged.coachingId) {
      survivorUpdates.coachingId = merged.coachingId;
    }
    // Idem invoiceClientId
    if (!survivor.invoiceClientId && merged.invoiceClientId) {
      survivorUpdates.invoiceClientId = merged.invoiceClientId;
    }

    // Enrichissement knownEmails / knownPhones
    const knownEmailsToAdd = [];
    if (merged.email && merged.email !== survivor.email) knownEmailsToAdd.push(merged.email);
    if (Array.isArray(merged.knownEmails)) {
      merged.knownEmails.forEach(e => {
        if (e && e !== survivor.email && !knownEmailsToAdd.includes(e)) knownEmailsToAdd.push(e);
      });
    }
    if (Array.isArray(merged._previousEmails)) {
      merged._previousEmails.forEach(e => {
        if (e && !knownEmailsToAdd.includes(e)) knownEmailsToAdd.push(e);
      });
    }
    if (knownEmailsToAdd.length > 0) {
      survivorUpdates.knownEmails  = admin.firestore.FieldValue.arrayUnion(...knownEmailsToAdd);
      survivorUpdates._previousEmails = admin.firestore.FieldValue.arrayUnion(...knownEmailsToAdd);
    }

    const knownPhonesToAdd = [];
    if (merged.telephone && merged.telephone !== survivor.telephone) knownPhonesToAdd.push(merged.telephone);
    if (Array.isArray(merged.knownPhones)) {
      merged.knownPhones.forEach(p => {
        if (p && p !== survivor.telephone && !knownPhonesToAdd.includes(p)) knownPhonesToAdd.push(p);
      });
    }
    if (Array.isArray(merged._previousTelephone)) {
      merged._previousTelephone.forEach(p => {
        if (p && !knownPhonesToAdd.includes(p)) knownPhonesToAdd.push(p);
      });
    }
    if (knownPhonesToAdd.length > 0) {
      survivorUpdates.knownPhones        = admin.firestore.FieldValue.arrayUnion(...knownPhonesToAdd);
      survivorUpdates._previousTelephone = admin.firestore.FieldValue.arrayUnion(...knownPhonesToAdd);
    }

    // Archivage du nom du merged dans _previousNom du survivor (si différent)
    if (merged.nom && merged.nom !== survivor.nom) {
      survivorUpdates._previousNom = admin.firestore.FieldValue.arrayUnion(merged.nom);
    }

    // Si survivor n'a pas certains champs et que merged les a → on récupère
    // (sauf identité dur déjà gérée par knownEmails/Phones/PrevNom)
    const FILL_IF_EMPTY = [
      'companyName', 'companyLegalForm', 'companyRcs',
      'siret', 'vatNumber', 'vatExempt', 'address',
      'gcCustomerId', 'closeurSlug', 'closeurName', 'coachAssigned',
    ];
    FILL_IF_EMPTY.forEach(field => {
      const sv = survivor[field];
      const mv = merged[field];
      const svEmpty = (sv === null || sv === undefined || sv === '');
      const mvNotEmpty = !(mv === null || mv === undefined || mv === '');
      if (svEmpty && mvNotEmpty) survivorUpdates[field] = mv;
    });

    // 4. Construire le patch merged (marquer comme fusionné)
    const mergedUpdates = {
      _merged:       true,
      _mergedInto:   survivorId,
      _mergedAt:     admin.firestore.FieldValue.serverTimestamp(),
      _mergedBy:     auth.uid,
      _mergedByEmail: auth.email || null,
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    };

    // 5. Exécuter la transaction (batch atomique)
    const batch = db.batch();

    // Réassigner personId sur tous les docs des 5 collections
    Object.keys(reassignments).forEach(coll => {
      reassignments[coll].forEach(docId => {
        batch.update(db.collection(coll).doc(docId), {
          personId: survivorId,
          _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          _personIdReassignedFrom: mergedId,
          _personIdReassignedAt:   admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    });

    // Update survivor + merged
    batch.update(db.collection('persons').doc(survivorId), survivorUpdates);
    batch.update(db.collection('persons').doc(mergedId),   mergedUpdates);

    // Audit log (entrée dédiée pour traçabilité)
    const auditRef = db.collection('audit_log').doc();
    batch.set(auditRef, {
      action:       'persons_merge',
      survivorId:   survivorId,
      mergedId:     mergedId,
      survivorNom:  survivor.nom || null,
      mergedNom:    merged.nom   || null,
      reassignedDocsCount: totalReassigned,
      reassignments: reassignments,
      performedBy:  auth.uid,
      performedByEmail: auth.email || null,
      at:           admin.firestore.FieldValue.serverTimestamp(),
    });

    // Commit
    await batch.commit();

    console.log(`[persons-merge] ${mergedId} → ${survivorId} | ${totalReassigned} docs reassigned | by ${auth.uid}`);

    return res.status(200).json({
      ok: true,
      survivorId,
      mergedId,
      reassignedDocsCount: totalReassigned,
      reassignments,
    });

  } catch (e) {
    console.error('[persons-merge] error:', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
};
