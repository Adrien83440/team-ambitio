/**
 * api/invoice-pdf.js
 *
 * Endpoint GET de téléchargement du PDF d'une facture validée.
 *
 * Auth : Bearer ID token (admin uniquement en Step 2B-1 ;
 *        sales/csm seront ajoutés en Step 3 quand le lien lead sera actif).
 *
 * Flux :
 *   1. Auth Bearer + role admin
 *   2. Lecture facture
 *   3. Vérification : non-draft + pdfHash présent
 *   4. Lecture des chunks PDF triés par index
 *   5. Reconstitution buffer
 *   6. Stream avec Content-Disposition attachment
 *
 * GET ?id=invoiceId
 */

const { db, requireAuth, reassembleBase64Chunks, sendError, setCors } = require('./_billing-helpers');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const user = await requireAuth(req, ['admin']);
    const invoiceId = (req.query && req.query.id) || '';
    if (!invoiceId) {
      const e = new Error('id manquant'); e.status = 400; throw e;
    }

    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data();

    if (invoice.status === 'draft') {
      const e = new Error('Pas de PDF pour un brouillon — validez la facture d\'abord'); e.status = 400; throw e;
    }
    if (!invoice.pdfHash) {
      const e = new Error('PDF non disponible (génération échouée ou en attente)'); e.status = 404; throw e;
    }

    /* Lecture chunks ordonnés */
    const chunksSnap = await invRef.collection('pdf').orderBy('index').get();
    if (chunksSnap.empty) {
      const e = new Error('PDF chunks introuvables — régénération nécessaire'); e.status = 404; throw e;
    }
    const chunks = [];
    chunksSnap.forEach(function(d){ chunks.push(d.data()); });

    const pdfBuf = reassembleBase64Chunks(chunks);

    const filename = (invoice.number || invoiceId) + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-Length', pdfBuf.length);
    res.setHeader('X-Invoice-Number', invoice.number || '');
    res.setHeader('X-Pdf-Hash', invoice.pdfHash);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(pdfBuf);
  } catch (err) {
    sendError(res, err);
  }
};
