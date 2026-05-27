/**
 * api/admin-backfill-invoice-clients.js
 *
 * Rétroactif : pour chaque persons.isClient === true qui n'a pas d'invoice_clients
 * rattaché (persons.invoiceClientId === null), crée le doc invoice_clients manquant
 * avec les champs identité copiés depuis persons.
 *
 * Pourquoi :
 *   Avant le patch _sync.js Step 5 du 2026-05-27, la transition lead.isClient
 *   false→true créait uniquement le persons, pas l'invoice_clients. Résultat :
 *   les clients récemment convertis n'apparaissent pas dans admin-facturation.html
 *   (qui liste depuis invoice_clients, pas persons).
 *
 *   Cet endpoint scanne persons.isClient === true && invoiceClientId === null,
 *   et crée le invoice_clients manquant (réutilise un orphelin si trouvé par email
 *   ou gcCustomerId, sinon en crée un nouveau).
 *
 * ─── Auth ───
 * Bearer admin uniquement (action de masse, journalisée).
 *
 * ─── POST body ───
 * {
 *   dryRun?: boolean,    // défaut true. Si true, retourne juste la liste des
 *                        //   persons concernées sans rien créer.
 *   limit?: number       // défaut 100. Cap de sécurité.
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   dryRun: bool,
 *   scanned: number,
 *   alreadyLinked: number,
 *   reusedOrphans: number,
 *   created: number,
 *   skippedNoEmail: number,
 *   items: [
 *     {
 *       personId, nom, email, action:'create'|'reuse'|'skip'|'alreadyLinked',
 *       invoiceClientId?: string, reason?: string
 *     }
 *   ]
 * }
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

/* On n'importe PAS depuis Functions/_sync.js (out of scope Vercel).
   On re-implémente localement les mêmes helpers avec la même logique. */

function lower(s) { return (s || '').toString().trim().toLowerCase(); }

function parseContactName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function findExistingInvoiceClient(email, gcCustomerId) {
  if (email) {
    const snap = await db.collection('invoice_clients').where('email', '==', email).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  if (gcCustomerId) {
    const snap1 = await db.collection('invoice_clients').where('gcCustomerId', '==', gcCustomerId).limit(1).get();
    if (!snap1.empty) return snap1.docs[0].id;
    const snap2 = await db.collection('invoice_clients').where('gocardlessCustomerId', '==', gcCustomerId).limit(1).get();
    if (!snap2.empty) return snap2.docs[0].id;
  }
  return null;
}

function buildInvoiceClientDoc(personId, personData, source) {
  const email = lower(personData.email);
  const phone = personData.telephone || '';
  const { firstName, lastName } = parseContactName(personData.nom);
  return {
    personId: personId,
    clientType: personData.clientType || 'individual',
    companyName: personData.companyName || '',
    companyLegalForm: personData.companyLegalForm || '',
    companyRcs: personData.companyRcs || '',
    contactFirstName: firstName,
    contactLastName: lastName,
    email: email,
    telephone: phone,
    phone: phone,
    siret: personData.siret || '',
    vatNumber: personData.vatNumber || '',
    vatExempt: !!personData.vatExempt,
    address: personData.address || {
      line1: '',
      line2: '',
      postalCode: '',
      city: '',
      country: 'France',
    },
    gcCustomerId: personData.gcCustomerId || null,
    gocardlessCustomerId: personData.gcCustomerId || null,
    salesOwner: personData.closeurSlug || null,
    archived: false,
    _needsAddressCompletion: !(personData.address && personData.address.line1),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    _createdBy: source || 'vercel:admin-backfill-invoice-clients',
  };
}

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth Bearer admin ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body ── */
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const dryRun = body.dryRun !== false;  /* défaut TRUE — par sécurité */
    const limit = Math.min(parseInt(body.limit, 10) || 100, 500);

    /* ── Scan persons.isClient === true ── */
    const personsSnap = await db.collection('persons').where('isClient', '==', true).get();

    const result = {
      success: true,
      dryRun: dryRun,
      scanned: personsSnap.size,
      alreadyLinked: 0,
      reusedOrphans: 0,
      created: 0,
      skippedNoEmail: 0,
      items: [],
    };

    let processed = 0;
    for (const docSnap of personsSnap.docs) {
      if (processed >= limit) break;

      const personData = docSnap.data();
      const personId = docSnap.id;

      /* Skip les persons "merged" (jamais affichées, cf. admin-persons.html) */
      if (personData._merged === true) continue;

      /* Skip si déjà rattaché à un invoice_clients */
      if (personData.invoiceClientId) {
        result.alreadyLinked++;
        continue;
      }

      const email = lower(personData.email);
      const gcId = personData.gcCustomerId || null;

      /* Skip si pas d'email ET pas de gcCustomerId : on ne peut pas matcher
         de manière fiable, et créer un invoice_clients sans email est inutile
         (la facturation par email échouera). */
      if (!email && !gcId) {
        result.skippedNoEmail++;
        result.items.push({
          personId: personId,
          nom: personData.nom || '',
          email: email,
          action: 'skip',
          reason: 'no_email_no_gc',
        });
        continue;
      }

      /* Cherche un invoice_clients orphelin (pas encore lié à un persons) */
      const existingIcId = await findExistingInvoiceClient(email, gcId);

      processed++;

      if (existingIcId) {
        /* Réutiliser l'orphelin */
        if (!dryRun) {
          await db.collection('invoice_clients').doc(existingIcId).update({
            personId: personId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            _backfilledBy: user.uid,
            _backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          await db.collection('persons').doc(personId).update({
            invoiceClientId: existingIcId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        result.reusedOrphans++;
        result.items.push({
          personId: personId,
          nom: personData.nom || '',
          email: email,
          action: 'reuse',
          invoiceClientId: existingIcId,
        });
      } else {
        /* Créer */
        let newIcId = null;
        if (!dryRun) {
          const newDoc = buildInvoiceClientDoc(personId, personData, 'vercel:admin-backfill-invoice-clients');
          newDoc._backfilledBy = user.uid;
          const ref = await db.collection('invoice_clients').add(newDoc);
          newIcId = ref.id;
          await db.collection('persons').doc(personId).update({
            invoiceClientId: newIcId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        result.created++;
        result.items.push({
          personId: personId,
          nom: personData.nom || '',
          email: email,
          action: 'create',
          invoiceClientId: newIcId || '(dry-run)',
        });
      }
    }

    /* ── Audit log ── */
    if (!dryRun && (result.created > 0 || result.reusedOrphans > 0)) {
      try {
        await db.collection('audit_log').add({
          type: 'backfill_invoice_clients',
          actor: user.uid,
          actorEmail: user.email,
          created: result.created,
          reusedOrphans: result.reusedOrphans,
          scanned: result.scanned,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn('[admin-backfill-invoice-clients] audit_log write failed:', e.message);
      }
    }

    console.log('[admin-backfill-invoice-clients] ' + (dryRun ? 'DRY-RUN ' : 'EXECUTE ') +
      JSON.stringify({ created: result.created, reused: result.reusedOrphans, alreadyLinked: result.alreadyLinked, skipped: result.skippedNoEmail }));

    res.status(200).json(result);

  } catch (err) {
    sendError(res, err);
  }
};
