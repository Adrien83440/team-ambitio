/**
 * api/invoice-validate.js
 *
 * Endpoint POST de validation d'une facture brouillon.
 *
 * Flux :
 *   1. Auth Bearer + role admin
 *   2. Lecture facture brouillon
 *   3. Validations métier (client, lignes, totaux)
 *   4. Lecture snapshots émetteur + CGV active
 *   5. Transaction Firestore atomique :
 *        - lecture compteur année
 *        - calcul numéro F2026-00001
 *        - update facture : status=validated, isLocked=true, number, dates, snapshots
 *        - incrémentation compteur
 *   6. Génération PDF avec pdf-lib (hors transaction)
 *   7. Hash SHA-256 + stockage chunks Firestore
 *
 * Si la génération PDF échoue après la transaction, la facture reste validée
 * (numéro attribué) avec un flag `pdfPending: true` permettant un retry.
 *
 * POST body : { invoiceId: string }
 * Response 200 : { success, invoiceId, number, issueDate, dueDate, pdfHash, pdfSizeBytes }
 */

const { admin, db, requireAuth, requireAuthOrSystemKey, sha256, chunkBufferToBase64, addDays, sendError, setCors } = require('./_billing-helpers');
const { loadMontserratFonts } = require('./_billing-fonts');
const { generateInvoicePdf } = require('./_billing-pdf');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth ── */
    /* Accepte Bearer admin (cas frontend manuel) OU x-system-key invoiceGeneration
       (cas Cloud Function scheduledInvoiceGenerator + endpoint subscription-generate-invoice). */
    const user = await requireAuthOrSystemKey(req, ['admin'], 'invoiceGeneration');

    /* ── Body ── */
    const body = req.body || {};
    const invoiceId = body.invoiceId;
    if (!invoiceId || typeof invoiceId !== 'string') {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }

    /* Date d'émission optionnelle (cas sync GoCardless rétroactive).
       Si fournie, elle remplace la date du jour pour issueDate/dueDate/year.
       Format accepté : 'YYYY-MM-DD' (interprété en heure locale midi pour
       éviter les décalages timezone). Le validatedAt reste serverTimestamp(). */
    let customIssueDate = null;
    if (body.issueDate && typeof body.issueDate === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.issueDate)) {
        const e = new Error('issueDate doit être au format YYYY-MM-DD'); e.status = 400; throw e;
      }
      customIssueDate = new Date(body.issueDate + 'T12:00:00');
      if (isNaN(customIssueDate.getTime())) {
        const e = new Error('issueDate invalide'); e.status = 400; throw e;
      }
    }

    /* ── Lecture facture ── */
    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data();
    if (invoice.status !== 'draft') {
      const e = new Error('Cette facture a déjà été validée (statut : ' + invoice.status + ')'); e.status = 409; throw e;
    }

    /* ── Validations métier ── */
    if (!invoice.clientId || !invoice.clientSnapshot) {
      const e = new Error('Aucun client sélectionné'); e.status = 400; throw e;
    }
    if (!invoice.lines || !invoice.lines.length) {
      const e = new Error('Au moins une ligne est requise'); e.status = 400; throw e;
    }
    for (let i = 0; i < invoice.lines.length; i++) {
      const l = invoice.lines[i];
      const qty = parseFloat(l.qty);
      const pu = parseFloat(l.unitPriceHt);
      if (isNaN(qty) || qty <= 0) {
        const e = new Error('Ligne ' + (i + 1) + ' : quantité invalide'); e.status = 400; throw e;
      }
      if (isNaN(pu) || pu < 0) {
        const e = new Error('Ligne ' + (i + 1) + ' : prix unitaire invalide'); e.status = 400; throw e;
      }
      if (!l.description && !l.productName) {
        const e = new Error('Ligne ' + (i + 1) + ' : description requise'); e.status = 400; throw e;
      }
    }
    if (!invoice.totalTtc || invoice.totalTtc <= 0) {
      const e = new Error('Le montant total TTC doit être strictement positif'); e.status = 400; throw e;
    }

    /* ── Lecture snapshots ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    if (!billingSnap.exists) {
      const e = new Error('Configuration de facturation manquante'); e.status = 500; throw e;
    }
    const issuerData = billingSnap.data();

    /* Champs émetteur obligatoires conformité */
    const requiredIssuer = ['companyName', 'companySiret', 'companyVatNumber', 'companyRcs'];
    for (let i = 0; i < requiredIssuer.length; i++) {
      const k = requiredIssuer[i];
      if (!issuerData[k]) {
        const e = new Error('Configuration émetteur incomplète : ' + k + ' manquant'); e.status = 400; throw e;
      }
    }

    /* CGV active */
    const cgvQuery = await db.collection('_config').doc('billing').collection('cgv').where('isActive', '==', true).limit(1).get();
    let cgv = null;
    cgvQuery.forEach(function(d){ cgv = Object.assign({ id: d.id }, d.data()); });
    if (!cgv) {
      const e = new Error('Aucune version de CGV active'); e.status = 500; throw e;
    }

    /* ── Préparer logoBuf si configuré ── */
    let logoBuf = null;
    if (issuerData.logoMode === 'image' && issuerData.logoBase64) {
      const m = String(issuerData.logoBase64).match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        try { logoBuf = Buffer.from(m[2], 'base64'); }
        catch (e) { console.warn('[invoice-validate] Logo decode failed:', e.message); }
      }
    }

    /* ── Préparer issuerSnapshot (sans logoBase64 pour ne pas alourdir le doc) ── */
    const issuerSnapshot = {};
    Object.keys(issuerData).forEach(function(k) {
      if (k !== 'logoBase64') issuerSnapshot[k] = issuerData[k];
    });
    issuerSnapshot.logoUsed = !!logoBuf;
    issuerSnapshot.snapshotAt = new Date().toISOString();

    /* CGV snapshot (texte intégral capté immutable) */
    const cgvSnapshot = {
      version: cgv.version || '1.0',
      activeFrom: cgv.activeFrom || null,
      text: cgv.text || '',
      snapshotAt: new Date().toISOString(),
    };

    /* ── Charger fonts (peut être null si Google Fonts unreachable) ── */
    let fonts = null;
    try {
      fonts = await loadMontserratFonts();
    } catch (e) {
      console.warn('[invoice-validate] Montserrat fonts unavailable, using Helvetica fallback:', e.message);
    }

    /* ── Transaction atomique : compteur + facture ── */
    const now = new Date();
    /* Si une date d'émission custom est fournie (sync rétroactive),
       on l'utilise pour issueDate, dueDate et le calcul d'année du
       compteur. Sinon, date du jour. */
    const issueDateJs = customIssueDate || now;
    const year = issueDateJs.getFullYear();
    const paymentTermsDays = invoice.paymentTermsDays != null ? invoice.paymentTermsDays : 30;
    const dueDateJs = addDays(issueDateJs, paymentTermsDays);

    const txResult = await db.runTransaction(async function(tx) {
      const counterRef = db.collection('invoice_counters').doc(String(year));
      const counterSnap = await tx.get(counterRef);
      const data = counterSnap.exists ? counterSnap.data() : { year: year, invoiceNextSeq: 1, creditNoteNextSeq: 1 };
      const seq = data.invoiceNextSeq || 1;
      const padded = String(seq).padStart(5, '0');
      const number = 'F' + year + '-' + padded;

      tx.update(invRef, {
        status: 'validated',
        isLocked: true,
        number: number,
        issueDate: admin.firestore.Timestamp.fromDate(issueDateJs),
        dueDate: admin.firestore.Timestamp.fromDate(dueDateJs),
        issuerSnapshot: issuerSnapshot,
        cgvSnapshot: cgvSnapshot,
        validatedAt: admin.firestore.FieldValue.serverTimestamp(),
        validatedBy: user.uid,
        validatedByEmail: user.email || null,
        pdfPending: true, /* sera passé à false après stockage chunks */
      });

      tx.set(counterRef, {
        year: year,
        invoiceNextSeq: seq + 1,
        creditNoteNextSeq: data.creditNoteNextSeq || 1,
        lastInvoiceNumber: number,
        lastInvoiceAt: admin.firestore.FieldValue.serverTimestamp(),
        lastInvoiceBy: user.uid,
      }, { merge: true });

      return { number: number, seq: seq };
    });

    /* ── Lire la facture mise à jour pour le PDF ── */
    const updatedSnap = await invRef.get();
    const updatedInvoice = updatedSnap.data();

    /* ── Génération PDF ── */
    let pdfBuf;
    try {
      pdfBuf = await generateInvoicePdf({
        invoice: updatedInvoice,
        issuer: issuerSnapshot,
        cgv: cgvSnapshot,
        logoBuf: logoBuf,
        fonts: fonts,
      });
    } catch (pdfErr) {
      console.error('[invoice-validate] PDF generation failed AFTER counter increment:', pdfErr);
      /* La facture est validée et numérotée. On flag pour retry mais on
         renvoie une erreur pour que l'UI puisse remonter le souci. */
      await invRef.update({
        pdfPending: true,
        pdfError: String(pdfErr.message || pdfErr).substring(0, 500),
        pdfErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const e = new Error('Facture validée (numéro ' + txResult.number + ') mais génération PDF échouée. Vérifiez la console.'); e.status = 500; throw e;
    }

    const pdfHash = sha256(pdfBuf);
    const chunks = chunkBufferToBase64(pdfBuf);

    /* ── Stockage chunks (delete previous + write new) ── */
    const pdfCol = invRef.collection('pdf');
    const previousChunks = await pdfCol.get();
    const batch = db.batch();
    previousChunks.forEach(function(d){ batch.delete(d.ref); });
    chunks.forEach(function(data, i) {
      const chunkRef = pdfCol.doc('chunk_' + String(i).padStart(4, '0'));
      batch.set(chunkRef, { index: i, total: chunks.length, data: data });
    });
    batch.update(invRef, {
      pdfHash: pdfHash,
      pdfChunkCount: chunks.length,
      pdfSizeBytes: pdfBuf.length,
      pdfGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      pdfPending: false,
      pdfError: null,
      pdfErrorAt: null,
    });
    await batch.commit();

    /* ── Réponse ── */
    res.status(200).json({
      success: true,
      invoiceId: invoiceId,
      number: txResult.number,
      issueDate: issueDateJs.toISOString(),
      dueDate: dueDateJs.toISOString(),
      pdfHash: pdfHash,
      pdfSizeBytes: pdfBuf.length,
      pdfChunkCount: chunks.length,
    });
  } catch (err) {
    sendError(res, err);
  }
};
