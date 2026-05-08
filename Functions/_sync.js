/**
 * Functions/_sync.js
 *
 * Sync inter-modules — Cloud Functions (Step 3+4+5).
 *
 * Architecture :
 *   - Hub : collection persons (master de l'identité humaine)
 *   - Spokes : leads, clients (coaching), invoice_clients, payments, subscriptions
 *
 *   Step 3 : onPersonsUpdate         hub → spokes (fan-out)
 *   Step 4 : on{Lead,Client,...}Update spokes → hub (remontée)
 *   Step 5 : intégré dans onLeadUpdate — création persons à isClient false→true
 *
 * Anti-loop : diff-check à chaque écriture. Si valeur cible déjà identique → skip.
 *             Convergence en 1 hop par champ.
 *
 * Garantie "jamais supprimer" : tous les anciens champs sont archivés dans
 *   _previous<Champ>[] via arrayUnion avant remplacement (sur les "identité dur" :
 *   nom, email, telephone, address, companyName, siret, vatNumber, gcCustomerId).
 *
 * Loi anti-fraude 2018 : invoices avec status === 'validated' jamais touchées.
 *   Seuls les drafts (status === 'draft') voient leur clientSnapshot resynchronisé.
 *
 * Le préfixe underscore exclut ce fichier du routing Vercel — il n'est importable
 * que par index.js via Object.assign(exports, require('./_sync')).
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const db = admin.firestore();

/* ═══════════════════════════════════════════════════════════════════════
   CONSTANTS — Mappings & helpers
   ═══════════════════════════════════════════════════════════════════════ */

/* Champs avec archivage _previousX[] sur écrasement (identité dur) */
const ARCHIVE_FIELDS = new Set([
  'nom', 'email', 'telephone', 'address',
  'companyName', 'siret', 'vatNumber', 'gcCustomerId'
]);

/* Mapping persons → spokes
   Clé = champ canonique sur persons. Valeur = liste de targets.
   target = { collection, field, archived?, alsoWriteAs? (rétrocompat) } */
const FROM_PERSONS_MAPPING = {
  nom: [
    { collection: 'leads',           field: 'nom',          archived: true  },
    { collection: 'clients',         field: 'nom',          archived: true  },
    { collection: 'payments',        field: 'leadName',     archived: false },
    { collection: 'subscriptions',   field: 'leadName',     archived: false },
  ],
  email: [
    { collection: 'leads',           field: 'email',        archived: true,  transform: 'lower' },
    { collection: 'clients',         field: 'email',        archived: true  },
    { collection: 'invoice_clients', field: 'email',        archived: true  },
    { collection: 'payments',        field: 'leadEmail',    archived: false, transform: 'lower' },
  ],
  telephone: [
    { collection: 'leads',           field: 'telephone',    archived: true,  alsoWriteAs: 'phoneNormalized', transformAlso: 'phone9' },
    { collection: 'clients',         field: 'telephone',    archived: true,  alsoWriteAs: 'tel' },
    { collection: 'invoice_clients', field: 'telephone',    archived: true,  alsoWriteAs: 'phone' },
    { collection: 'payments',        field: 'leadPhone',    archived: false },
  ],
  gcCustomerId: [
    { collection: 'leads',           field: 'gcCustomerId',          archived: true  },
    { collection: 'invoice_clients', field: 'gcCustomerId',          archived: true,  alsoWriteAs: 'gocardlessCustomerId' },
    { collection: 'payments',        field: 'gcCustomerId',          archived: false },
    { collection: 'subscriptions',   field: 'gcCustomerId',          archived: false },
  ],
  closeurSlug: [
    { collection: 'leads',           field: 'closeurSlug',  archived: false },
    { collection: 'invoice_clients', field: 'salesOwner',   archived: false },
  ],
  closeurName: [
    { collection: 'leads',           field: 'closeurName',  archived: false },
  ],
  coachAssigned: [
    { collection: 'leads',           field: 'coachAssigned', archived: false },
    { collection: 'clients',         field: 'coachAssigned', archived: false },
  ],
  crmStatus: [
    { collection: 'leads',           field: 'clientStatus', archived: false },
  ],
  coachingStatus: [
    { collection: 'clients',         field: 'statut',       archived: false },
  ],
  /* Champs identité société : exclusivement vers invoice_clients */
  companyName:      [{ collection: 'invoice_clients', field: 'companyName',      archived: true  }],
  companyLegalForm: [{ collection: 'invoice_clients', field: 'companyLegalForm', archived: false }],
  companyRcs:       [{ collection: 'invoice_clients', field: 'companyRcs',       archived: false }],
  siret:            [{ collection: 'invoice_clients', field: 'siret',            archived: true  }],
  vatNumber:        [{ collection: 'invoice_clients', field: 'vatNumber',        archived: true  }],
  vatExempt:        [{ collection: 'invoice_clients', field: 'vatExempt',        archived: false }],
  address:          [{ collection: 'invoice_clients', field: 'address',          archived: true  }],
  clientType:       [{ collection: 'invoice_clients', field: 'clientType',       archived: false }],
};

/* Mapping spoke → persons (lecture inverse).
   Clé = collection source. Valeur = { fieldSrc: fieldHub, ... } */
const TO_HUB_MAPPING = {
  leads: {
    nom:           'nom',
    email:         'email',
    telephone:     'telephone',
    gcCustomerId:  'gcCustomerId',
    closeurSlug:   'closeurSlug',
    closeurName:   'closeurName',
    coachAssigned: 'coachAssigned',
    clientStatus:  'crmStatus',
  },
  clients: {
    nom:           'nom',
    email:         'email',
    telephone:     'telephone',
    statut:        'coachingStatus',
    coachAssigned: 'coachAssigned',
  },
  invoice_clients: {
    email:                'email',
    telephone:            'telephone',
    phone:                'telephone',         /* rétrocompat — phone alimente telephone */
    companyName:          'companyName',
    companyLegalForm:     'companyLegalForm',
    companyRcs:           'companyRcs',
    siret:                'siret',
    vatNumber:            'vatNumber',
    vatExempt:            'vatExempt',
    address:              'address',
    clientType:           'clientType',
    salesOwner:           'closeurSlug',
    gcCustomerId:         'gcCustomerId',
    gocardlessCustomerId: 'gcCustomerId',      /* rétrocompat */
  },
  payments: {
    gcCustomerId:  'gcCustomerId',
  },
  subscriptions: {
    gcCustomerId:  'gcCustomerId',
  },
};

/* Champs invoice_clients qui se reflètent dans le clientSnapshot des invoices drafts.
   Quand l'IC change, on met à jour les drafts pour cohérence (jamais les validées). */
const IC_TO_INVOICE_DRAFTS_FIELDS = [
  'companyName', 'companyLegalForm', 'companyRcs',
  'contactFirstName', 'contactLastName',
  'email', 'telephone', 'phone',
  'siret', 'vatNumber', 'vatExempt',
  'address',
  'clientType',
];

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

function lower(s) { return (s || '').toString().trim().toLowerCase(); }
function digits(s) { return (s || '').toString().replace(/\D+/g, ''); }
function phone9(s) { const d = digits(s); return d.length >= 9 ? d.slice(-9) : ''; }

function applyTransform(value, transformName) {
  if (transformName === 'lower') return lower(value);
  if (transformName === 'phone9') return phone9(value);
  return value;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function archiveFieldName(field) { return '_previous' + capitalize(field); }

/* Égalité tolérante : null/undefined/'' équivalent ; objets compared par JSON.stringify */
function valuesEqual(a, b) {
  const aE = (a === null || a === undefined || a === '');
  const bE = (b === null || b === undefined || b === '');
  if (aE && bE) return true;
  if (aE !== bE) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }
  return a === b;
}

/* ═══════════════════════════════════════════════════════════════════════
   STEP 3 — propagateFromPersons (hub → spokes)
   ═══════════════════════════════════════════════════════════════════════ */
async function propagateFromPersons(personId, before, after) {
  /* Identifier les champs canoniques modifiés */
  const changedFields = [];
  Object.keys(FROM_PERSONS_MAPPING).forEach(field => {
    if (!valuesEqual(before[field], after[field])) changedFields.push(field);
  });
  if (changedFields.length === 0) return;

  console.log('[sync.fromPersons] persons/' + personId + ' changed: ' + changedFields.join(', '));

  /* Pour chaque champ modifié, propager vers chaque target */
  for (const field of changedFields) {
    const targets = FROM_PERSONS_MAPPING[field];
    for (const target of targets) {
      try {
        await propagateOneFieldToCollection(personId, after[field], field, target);
      } catch (e) {
        console.error('[sync.fromPersons] propagation error on ' + field + ' → ' + target.collection + '.' + target.field + ':', e.message);
      }
    }
  }
}

async function propagateOneFieldToCollection(personId, personsValue, personsField, target) {
  /* Lookup tous les docs de la collection cible avec ce personId */
  const snap = await db.collection(target.collection).where('personId', '==', personId).get();
  if (snap.empty) return;

  const newValue = target.transform ? applyTransform(personsValue, target.transform) : personsValue;

  let writes = 0;
  /* Batch — chunk par 400 (limite Firestore = 500) */
  let batch = db.batch();
  let batchSize = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const oldValue = data[target.field];

    /* Diff-check : skip si déjà identique (évite les loops) */
    if (valuesEqual(oldValue, newValue)) continue;

    /* Règle "jamais d'écrasement par vide" : skip si new falsy ET old non-falsy */
    const newIsEmpty = (newValue === null || newValue === undefined || newValue === '');
    const oldIsEmpty = (oldValue === null || oldValue === undefined || oldValue === '');
    if (newIsEmpty && !oldIsEmpty) continue;

    const updates = {
      [target.field]: newValue === undefined ? null : newValue,
      _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    /* Champ rétrocompat (ex: tel pour clients, phone pour invoice_clients) */
    if (target.alsoWriteAs) {
      const alsoValue = target.transformAlso ? applyTransform(personsValue, target.transformAlso) : newValue;
      updates[target.alsoWriteAs] = alsoValue === undefined ? null : alsoValue;
    }

    /* Archive l'ancien si applicable + non-vide */
    if (target.archived && !oldIsEmpty) {
      updates[archiveFieldName(target.field)] = admin.firestore.FieldValue.arrayUnion(oldValue);
    }

    batch.update(d.ref, updates);
    batchSize++;
    writes++;

    if (batchSize >= 400) {
      await batch.commit();
      batch = db.batch();
      batchSize = 0;
    }
  }
  if (batchSize > 0) await batch.commit();

  if (writes > 0) {
    console.log('[sync.fromPersons]   → ' + target.collection + '.' + target.field + ' : ' + writes + ' doc(s)');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   STEP 4 — propagateToHub (spoke → hub)
   ═══════════════════════════════════════════════════════════════════════ */
async function propagateToHub(sourceCol, docId, before, after) {
  const personId = after.personId;
  if (!personId) return;
  const mapping = TO_HUB_MAPPING[sourceCol];
  if (!mapping) return;

  /* Identifier les champs sources modifiés qui sont mappés */
  const changedHubFields = {};   /* hubField → newValue */
  const archivedHubFields = {};  /* hubField → oldValue (à archiver si applicable) */

  Object.keys(mapping).forEach(srcField => {
    const hubField = mapping[srcField];
    const oldVal = before[srcField];
    const newVal = after[srcField];
    if (valuesEqual(oldVal, newVal)) return;

    /* Pas d'écrasement par vide */
    const newIsEmpty = (newVal === null || newVal === undefined || newVal === '');
    const oldIsEmpty = (oldVal === null || oldVal === undefined || oldVal === '');
    if (newIsEmpty && !oldIsEmpty) return;

    /* Transform email → lowercase */
    let finalValue = newVal;
    if (hubField === 'email' && typeof finalValue === 'string') finalValue = finalValue.toLowerCase().trim();

    /* Si plusieurs srcField mappent vers le même hubField (ex: phone+telephone → telephone),
       on prend la dernière valeur non-vide. La logique ci-dessous écrase, ce qui est OK. */
    changedHubFields[hubField] = finalValue;
    if (!oldIsEmpty) archivedHubFields[hubField] = oldVal;
  });

  if (Object.keys(changedHubFields).length === 0) return;

  console.log('[sync.toHub] ' + sourceCol + '/' + docId + ' → persons/' + personId + ' : ' + Object.keys(changedHubFields).join(', '));

  /* Lecture du persons + diff-check final (anti-loop : si déjà identique, skip) */
  const personRef = db.collection('persons').doc(personId);
  const personSnap = await personRef.get();
  if (!personSnap.exists) {
    console.warn('[sync.toHub] persons/' + personId + ' inexistant — skip');
    return;
  }
  const personsData = personSnap.data();

  const updates = {};
  let hasRealChange = false;
  Object.keys(changedHubFields).forEach(hubField => {
    if (valuesEqual(personsData[hubField], changedHubFields[hubField])) return;  /* déjà sync — anti-loop */
    updates[hubField] = changedHubFields[hubField];
    hasRealChange = true;

    /* Archive si applicable */
    if (ARCHIVE_FIELDS.has(hubField) && archivedHubFields[hubField] !== undefined) {
      updates[archiveFieldName(hubField)] = admin.firestore.FieldValue.arrayUnion(archivedHubFields[hubField]);
    }
  });

  if (!hasRealChange) {
    console.log('[sync.toHub]   → no real change after diff-check (anti-loop)');
    return;
  }

  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  updates._lastSyncedAt = admin.firestore.FieldValue.serverTimestamp();

  /* Aussi maintenir knownEmails / knownPhones */
  if (updates.email) {
    updates.knownEmails = admin.firestore.FieldValue.arrayUnion(updates.email);
  }
  if (updates.telephone) {
    updates.knownPhones = admin.firestore.FieldValue.arrayUnion(updates.telephone);
  }

  await personRef.update(updates);
  console.log('[sync.toHub]   → persons/' + personId + ' updated');
}

/* ═══════════════════════════════════════════════════════════════════════
   IC → drafts d'invoices (cohérence du clientSnapshot)
   ═══════════════════════════════════════════════════════════════════════ */
async function syncInvoiceClientToDraftInvoices(icId, before, after) {
  const changed = IC_TO_INVOICE_DRAFTS_FIELDS.some(f => !valuesEqual(before[f], after[f]));
  if (!changed) return;

  /* Lookup les drafts liés à cet IC */
  const snap = await db.collection('invoices')
    .where('clientId', '==', icId)
    .where('status', '==', 'draft')   /* CRITIQUE : jamais les validated */
    .get();
  if (snap.empty) return;

  /* Construire un nouveau clientSnapshot à partir de l'IC après changement */
  const newSnapshot = {};
  IC_TO_INVOICE_DRAFTS_FIELDS.forEach(f => { newSnapshot[f] = after[f] !== undefined ? after[f] : null; });
  /* Conserver les autres champs custom du snapshot existant */

  let updates = 0;
  for (const d of snap.docs) {
    const inv = d.data();
    if (inv.status !== 'draft') continue;  /* double safety */
    if (inv.isLocked === true) continue;   /* triple safety */

    /* Merge : on garde le snapshot existant et on overwrite uniquement les champs concernés */
    const mergedSnapshot = Object.assign({}, inv.clientSnapshot || {}, newSnapshot);

    await d.ref.update({
      clientSnapshot: mergedSnapshot,
      _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    updates++;
  }
  if (updates > 0) console.log('[sync.icToDrafts] invoice_clients/' + icId + ' → ' + updates + ' draft invoice(s) clientSnapshot updated');
}

/* ═══════════════════════════════════════════════════════════════════════
   STEP 5 — Création persons à la transition isClient: false → true
   ═══════════════════════════════════════════════════════════════════════ */
async function createPersonOnIsClientTransition(leadId, leadData) {
  if (leadData.personId) return;  /* déjà rattaché */

  const email = lower(leadData.email);
  const phoneE164 = leadData.telephone || '';
  const phoneN = leadData.phoneNormalized || phone9(leadData.telephone);

  /* 1. Cherche un persons existant avec le même email */
  let existingPersonId = null;
  if (email) {
    const snap = await db.collection('persons').where('email', '==', email).limit(1).get();
    if (!snap.empty) existingPersonId = snap.docs[0].id;
  }
  /* 2. Sinon par phoneNormalized */
  if (!existingPersonId && phoneN) {
    const snap = await db.collection('persons').where('phoneNormalized', '==', phoneN).limit(1).get();
    if (!snap.empty) existingPersonId = snap.docs[0].id;
  }

  if (existingPersonId) {
    /* Réutiliser */
    await db.collection('leads').doc(leadId).update({
      personId: existingPersonId,
      _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('persons').doc(existingPersonId).update({
      leadIds: admin.firestore.FieldValue.arrayUnion(leadId),
      isClient: true,    /* on s'assure que le persons est marqué client */
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[sync.transitionIsClient] lead ' + leadId + ' attaché à persons existant ' + existingPersonId);
    return;
  }

  /* 3. Créer un nouveau persons */
  const newPerson = {
    nom:             leadData.nom || '',
    email:           email,
    telephone:       phoneE164,
    phoneNormalized: phoneN,
    clientType:      'individual',
    companyName:     null,
    companyLegalForm:null,
    companyRcs:      null,
    siret:           null,
    vatNumber:       null,
    vatExempt:       false,
    address:         null,
    crmStatus:       leadData.clientStatus || 'active',
    coachingStatus:  null,
    isClient:        true,
    closeurSlug:     leadData.closeurSlug || null,
    closeurName:     leadData.closeurName || null,
    coachAssigned:   leadData.coachAssigned || null,
    salesOwner:      leadData.closeurSlug || null,
    gcCustomerId:    leadData.gcCustomerId || null,
    leadIds:         [leadId],
    primaryLeadId:   leadId,
    coachingId:      null,
    invoiceClientId: null,
    paymentIds:      [],
    subscriptionIds: [],
    knownEmails:     email ? [email] : [],
    knownPhones:     phoneE164 ? [phoneE164] : [],
    createdAt:       admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    _lastSyncedAt:   admin.firestore.FieldValue.serverTimestamp(),
    _createdBy:      'cf:onLeadUpdate:transitionIsClient',
  };

  const ref = await db.collection('persons').add(newPerson);
  await db.collection('leads').doc(leadId).update({
    personId: ref.id,
    _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('[sync.transitionIsClient] nouveau persons ' + ref.id + ' créé pour lead ' + leadId);
}

/* ═══════════════════════════════════════════════════════════════════════
   CLOUD FUNCTIONS — exports
   ═══════════════════════════════════════════════════════════════════════ */

exports.onPersonsUpdate = functions.firestore
  .document('persons/{personId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      await propagateFromPersons(context.params.personId, before, after);
    } catch (e) {
      console.error('[sync] onPersonsUpdate error:', e.message, e.stack);
    }
    return null;
  });

exports.onLeadUpdate = functions.firestore
  .document('leads/{leadId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      /* Step 5 : transition isClient false → true → création persons */
      if (before.isClient !== true && after.isClient === true && !after.personId) {
        await createPersonOnIsClientTransition(context.params.leadId, after);
        /* Pas de propagateToHub immédiat — on vient de tout setup */
        return null;
      }
      /* Step 4 : remontée vers hub */
      if (after.personId) {
        await propagateToHub('leads', context.params.leadId, before, after);
      }
    } catch (e) {
      console.error('[sync] onLeadUpdate error:', e.message, e.stack);
    }
    return null;
  });

exports.onClientUpdate = functions.firestore
  .document('clients/{clientId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      if (after.personId) {
        await propagateToHub('clients', context.params.clientId, before, after);
      }
    } catch (e) {
      console.error('[sync] onClientUpdate error:', e.message, e.stack);
    }
    return null;
  });

exports.onInvoiceClientUpdate = functions.firestore
  .document('invoice_clients/{icId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      if (after.personId) {
        await propagateToHub('invoice_clients', context.params.icId, before, after);
      }
      /* Cohérence drafts d'invoices : si l'IC change, on resync les snapshots des drafts */
      await syncInvoiceClientToDraftInvoices(context.params.icId, before, after);
    } catch (e) {
      console.error('[sync] onInvoiceClientUpdate error:', e.message, e.stack);
    }
    return null;
  });

exports.onPaymentUpdate = functions.firestore
  .document('payments/{paymentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      if (after.personId) {
        await propagateToHub('payments', context.params.paymentId, before, after);
      }
    } catch (e) {
      console.error('[sync] onPaymentUpdate error:', e.message, e.stack);
    }
    return null;
  });

exports.onSubscriptionUpdate = functions.firestore
  .document('subscriptions/{subId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    try {
      if (after.personId) {
        await propagateToHub('subscriptions', context.params.subId, before, after);
      }
    } catch (e) {
      console.error('[sync] onSubscriptionUpdate error:', e.message, e.stack);
    }
    return null;
  });
