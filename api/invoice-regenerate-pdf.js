/**
 * api/invoice-regenerate-pdf.js
 *
 * Régénère le PDF d'une (ou plusieurs) facture(s) DÉJÀ validée(s) dont la
 * génération PDF avait échoué (pdfPending: true), typiquement à cause d'un
 * timeout réseau des fonts au moment de la validation.
 *
 * NON DESTRUCTIF : ne touche ni au numéro, ni au compteur, ni à issueDate,
 * ni aux montants, ni au statut. Régénère uniquement le binaire PDF à partir
 * des snapshots déjà figés dans la facture (issuerSnapshot, cgvSnapshot, lines)
 * puis stocke les chunks et passe pdfPending → false.
 *
 * Idempotent : on peut le relancer autant de fois que voulu.
 *
 * ─── Auth ───
 * Bearer admin uniquement.
 *
 * ─── POST body ───
 * {
 *   invoiceId?: string,   // régénère une facture précise
 *   all?: boolean,        // si true, régénère TOUTES les factures pdfPending=true (non archivées)
 *   max?: number          // cap en mode all (défaut 50)
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   processed: number,
 *   regenerated: [ { invoiceId, number, pdfSizeBytes } ],
 *   errors: [ { invoiceId, number, error } ]
 * }
 */

const {
  admin, db, requireAuth, sha256, chunkBufferToBase64, sendError, setCors,
} = require('./_billing-helpers');
const { loadMontserratFonts } = require('./_billing-fonts');
const { generateInvoicePdf } = require('./_billing-pdf');

/**
 * Régénère + stocke le PDF d'une facture validée.
 * @returns {Promise<{invoiceId, number, pdfSizeBytes}>}
 * @throws si la facture est introuvable / draft / sans numéro, ou si le PDF échoue
 */
async function regenerateOne(invoiceId, fonts, sharedConfig) {
  const invRef = db.collection('invoices').doc(invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) {
    const e = new Error('Facture introuvable'); e.status = 404; throw e;
  }
  const invoice = invSnap.data();

  if (invoice.status === 'draft') {
    const e = new Error('Facture en brouillon — à valider, pas à régénérer'); e.status = 400; throw e;
  }
  if (!invoice.number) {
    const e = new Error('Facture sans numéro — incohérent'); e.status = 400; throw e;
  }

  /* Snapshots : priorité à ceux figés dans la facture (immutables, conformité).
     Fallback sur la config courante si absents (cas très anciens). */
  let issuerSnapshot = invoice.issuerSnapshot;
  let cgvSnapshot = invoice.cgvSnapshot;

  if (!issuerSnapshot || !cgvSnapshot) {
    /* Reconstruire depuis la config courante (rare) */
    if (!sharedConfig.issuerData) {
      const billingSnap = await db.collection('_config').doc('billing').get();
      sharedConfig.issuerData = billingSnap.exists ? billingSnap.data() : {};
      const cgvQuery = await db.collection('_config').doc('billing').collection('cgv')
        .where('isActive', '==', true).limit(1).get();
      let cgv = null;
      cgvQuery.forEach(function(d) { cgv = Object.assign({ id: d.id }, d.data()); });
      sharedConfig.cgv = cgv;
    }
    if (!issuerSnapshot) {
      issuerSnapshot = {};
      Object.keys(sharedConfig.issuerData).forEach(function(k) {
        if (k !== 'logoBase64') issuerSnapshot[k] = sharedConfig.issuerData[k];
      });
    }
    if (!cgvSnapshot && sharedConfig.cgv) {
      cgvSnapshot = {
        version: sharedConfig.cgv.version || '1.0',
        activeFrom: sharedConfig.cgv.activeFrom || null,
        text: sharedConfig.cgv.text || '',
      };
    }
  }

  /* Logo : toujours relu depuis la config courante (non stocké dans le snapshot) */
  if (sharedConfig.logoBuf === undefined) {
    if (!sharedConfig.issuerData) {
      const billingSnap = await db.collection('_config').doc('billing').get();
      sharedConfig.issuerData = billingSnap.exists ? billingSnap.data() : {};
    }
    let logoBuf = null;
    const id = sharedConfig.issuerData;
    if (id.logoMode === 'image' && id.logoBase64) {
      const m = String(id.logoBase64).match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        try { logoBuf = Buffer.from(m[2], 'base64'); } catch (_) {}
      }
    }
    sharedConfig.logoBuf = logoBuf;
  }

  /* Génération PDF */
  const pdfBuf = await generateInvoicePdf({
    invoice: invoice,
    issuer: issuerSnapshot,
    cgv: cgvSnapshot,
    logoBuf: sharedConfig.logoBuf,
    fonts: fonts,
  });

  const pdfHash = sha256(pdfBuf);
  const chunks = chunkBufferToBase64(pdfBuf);

  /* Stockage chunks : delete previous + write new (même logique qu'invoice-validate) */
  const pdfCol = invRef.collection('pdf');
  const previousChunks = await pdfCol.get();
  const batch = db.batch();
  previousChunks.forEach(function(d) { batch.delete(d.ref); });
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
    pdfRegeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return { invoiceId: invoiceId, number: invoice.number, pdfSizeBytes: pdfBuf.length };
}

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const user = await requireAuth(req, ['admin']);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const invoiceId = body.invoiceId || null;
    const all = body.all === true;
    /* mode: 'pending' (défaut) = seulement les PDF échoués/en attente
             'all'              = TOUTES les factures validées/payées (régénération
                                  complète après changement de template/présentation) */
    const mode = body.mode === 'all' ? 'all' : 'pending';
    const max = Math.min(parseInt(body.max, 10) || 50, 200);

    if (!invoiceId && !all) {
      const e = new Error('Fournir invoiceId ou all:true'); e.status = 400; throw e;
    }

    /* Charger les fonts une seule fois pour tout le batch */
    let fonts = null;
    try {
      fonts = await loadMontserratFonts();
    } catch (e) {
      console.warn('[invoice-regenerate-pdf] fonts unavailable, Helvetica fallback:', e.message);
    }

    /* Config partagée (logo, issuer, cgv) chargée à la demande, réutilisée pour tout le batch */
    const sharedConfig = {};

    const result = { success: true, mode: invoiceId ? 'single' : mode, processed: 0, regenerated: [], errors: [] };

    let targets = [];
    if (invoiceId) {
      targets = [invoiceId];
    } else if (mode === 'all') {
      /* Toutes les factures non-draft, non archivées (régénération complète) */
      const snap = await db.collection('invoices').orderBy('number').limit(max).get();
      snap.forEach(function(d) {
        const data = d.data();
        if (data._archived !== true && data.status !== 'draft' && data.number) {
          targets.push(d.id);
        }
      });
    } else {
      /* Toutes les factures pdfPending=true, non archivées */
      const snap = await db.collection('invoices').where('pdfPending', '==', true).limit(max).get();
      snap.forEach(function(d) {
        if (d.data()._archived !== true) targets.push(d.id);
      });
    }

    for (const id of targets) {
      result.processed++;
      try {
        const r = await regenerateOne(id, fonts, sharedConfig);
        result.regenerated.push(r);
        console.log('[invoice-regenerate-pdf] OK ' + r.number + ' (' + r.pdfSizeBytes + ' bytes)');
      } catch (e) {
        result.errors.push({ invoiceId: id, error: String(e.message || e) });
        console.error('[invoice-regenerate-pdf] FAIL ' + id + ': ' + e.message);
      }
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('[invoice-regenerate-pdf] fatal: ' + err.message);
    sendError(res, err);
  }
};
