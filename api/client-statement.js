/**
 * api/client-statement.js
 *
 * Relevé de compte client (grand livre) — endpoint GET, admin uniquement.
 *
 * Deux modes :
 *   GET ?clientId=xxx&from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv|pdf
 *     → relevé d'un client (JSON pour l'aperçu UI, CSV/PDF en téléchargement)
 *   GET ?all=1&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → grand livre tous clients, CSV uniquement
 *
 * from/to sont optionnels (absents = historique complet).
 * Le PDF est généré à la volée — aucun stockage : contrairement à une facture,
 * un relevé n'a pas de valeur légale à figer.
 */

const { db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const core = require('./_statement-core');
const { generateStatementPdf } = require('./_statement-pdf');
const { loadMontserratFonts } = require('./_billing-fonts');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readDateParam(query, name) {
  const v = (query && query[name]) || '';
  if (!v) return null;
  if (!DATE_RE.test(v)) {
    const e = new Error('Paramètre ' + name + ' invalide (attendu YYYY-MM-DD)'); e.status = 400; throw e;
  }
  return v;
}

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    await requireAuth(req, ['admin']);

    const q = req.query || {};
    const from = readDateParam(q, 'from');
    const to = readDateParam(q, 'to');
    if (from && to && from > to) {
      const e = new Error('Plage invalide : from est après to'); e.status = 400; throw e;
    }

    /* ── Mode grand livre tous clients (CSV) ── */
    if (q.all === '1' || q.all === 'true') {
      const ledger = await core.buildGlobalLedger(from, to);
      const csv = '\uFEFF' + core.globalLedgerCsv(ledger);
      const filename = 'grand-livre-clients_' + core.rangeSuffix(from, to) + '.csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.status(200).send(csv);
      return;
    }

    /* ── Mode relevé d'un client ── */
    const clientId = q.clientId || '';
    if (!clientId) {
      const e = new Error('clientId manquant (ou all=1 pour le grand livre global)'); e.status = 400; throw e;
    }
    const format = q.format || 'json';
    if (['json', 'csv', 'pdf'].indexOf(format) === -1) {
      const e = new Error('format invalide (json | csv | pdf)'); e.status = 400; throw e;
    }

    const statement = await core.buildClientStatement(clientId, from, to);

    if (format === 'json') {
      res.status(200).json({ success: true, statement: statement });
      return;
    }

    const baseName = 'releve_' + core.safeFileName(statement.clientName) + '_' + core.rangeSuffix(from, to);

    if (format === 'csv') {
      const csv = '\uFEFF' + core.clientStatementCsv(statement);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + baseName + '.csv"');
      res.status(200).send(csv);
      return;
    }

    /* format === 'pdf' */
    const billingSnap = await db.collection('_config').doc('billing').get();
    if (!billingSnap.exists) {
      const e = new Error('Configuration de facturation manquante'); e.status = 500; throw e;
    }
    const issuer = billingSnap.data();

    let logoBuf = null;
    if (issuer.logoMode === 'image' && issuer.logoBase64) {
      const m = String(issuer.logoBase64).match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        try { logoBuf = Buffer.from(m[2], 'base64'); }
        catch (e) { console.warn('[client-statement] Logo decode failed:', e.message); }
      }
    }

    let fonts = null;
    try {
      fonts = await loadMontserratFonts();
    } catch (e) {
      console.warn('[client-statement] Montserrat fonts unavailable, using Helvetica fallback:', e.message);
    }

    const pdfBuf = await generateStatementPdf({
      statement: statement,
      periodText: core.periodLabel(statement.period),
      issuer: issuer,
      logoBuf: logoBuf,
      fonts: fonts,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + baseName + '.pdf"');
    res.setHeader('Content-Length', pdfBuf.length);
    res.status(200).send(pdfBuf);
  } catch (err) {
    sendError(res, err);
  }
};
