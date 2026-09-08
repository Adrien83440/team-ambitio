/**
 * api/client-statement-send.js
 *
 * Envoi par email du relevé de compte d'un client (typiquement au comptable).
 * Calqué sur api/invoice-send-email.js : le sujet et le corps arrivent déjà
 * résolus depuis l'UI ; le serveur régénère le relevé et les pièces jointes
 * lui-même (jamais de contenu comptable fourni par le client HTTP).
 *
 * POST body :
 *   {
 *     clientId: string,
 *     periodFrom?: 'YYYY-MM-DD',    // absent = début de l'historique
 *     periodTo?: 'YYYY-MM-DD',      // absent = aujourd'hui
 *     to: string[],                 // destinataires
 *     cc?: string[],
 *     subject: string,
 *     bodyText: string,
 *     attachPdf?: boolean,          // défaut true
 *     attachCsv?: boolean,          // défaut true
 *     useBcc?: boolean              // override du paramètre par défaut
 *   }
 *
 * Response 200 : { success, messageId, threadId, sentTo }
 * Trace d'audit : statementSentHistory (arrayUnion) sur la fiche invoice_clients.
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const { wrapAsHtml } = require('./_billing-email-templates');
const core = require('./_statement-core');
const { generateStatementPdf } = require('./_statement-pdf');
const { loadMontserratFonts } = require('./_billing-fonts');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body ── */
    const body = req.body || {};
    const clientId = body.clientId;
    if (!clientId || typeof clientId !== 'string') {
      const e = new Error('clientId requis'); e.status = 400; throw e;
    }
    const periodFrom = body.periodFrom || null;
    const periodTo = body.periodTo || null;
    if (periodFrom && !DATE_RE.test(periodFrom)) {
      const e = new Error('periodFrom invalide (attendu YYYY-MM-DD)'); e.status = 400; throw e;
    }
    if (periodTo && !DATE_RE.test(periodTo)) {
      const e = new Error('periodTo invalide (attendu YYYY-MM-DD)'); e.status = 400; throw e;
    }
    if (periodFrom && periodTo && periodFrom > periodTo) {
      const e = new Error('Plage invalide : periodFrom est après periodTo'); e.status = 400; throw e;
    }

    const toRaw = body.to;
    const to = Array.isArray(toRaw) ? toRaw.filter(function(e){ return e && e.trim(); }) : (toRaw ? [toRaw] : []);
    const cc = Array.isArray(body.cc) ? body.cc.filter(function(e){ return e && e.trim(); }) : [];
    if (!to.length) {
      const e = new Error('Au moins un destinataire requis'); e.status = 400; throw e;
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (let i = 0; i < to.length; i++) {
      if (!emailRe.test(to[i])) {
        const e = new Error('Email destinataire invalide : ' + to[i]); e.status = 400; throw e;
      }
    }
    for (let i = 0; i < cc.length; i++) {
      if (!emailRe.test(cc[i])) {
        const e = new Error('Email CC invalide : ' + cc[i]); e.status = 400; throw e;
      }
    }
    const subject = body.subject;
    const bodyText = body.bodyText;
    if (!subject || !subject.trim()) {
      const e = new Error('Sujet requis'); e.status = 400; throw e;
    }
    if (!bodyText || !bodyText.trim()) {
      const e = new Error('Corps requis'); e.status = 400; throw e;
    }
    const attachPdf = body.attachPdf != null ? !!body.attachPdf : true;
    const attachCsv = body.attachCsv != null ? !!body.attachCsv : true;
    if (!attachPdf && !attachCsv) {
      const e = new Error('Au moins une pièce jointe requise (PDF ou CSV)'); e.status = 400; throw e;
    }

    /* ── Relevé (régénéré côté serveur) ── */
    const statement = await core.buildClientStatement(clientId, periodFrom, periodTo);
    const baseName = 'releve_' + core.safeFileName(statement.clientName) + '_' + core.rangeSuffix(periodFrom, periodTo);

    /* ── Config émetteur + email ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    if (!billingSnap.exists) {
      const e = new Error('Configuration de facturation manquante'); e.status = 500; throw e;
    }
    const billing = billingSnap.data();
    const senderAccount = billing.senderAccount || 'contact';
    const enableBcc = billing.enableBcc != null ? billing.enableBcc : true;
    const fromName = billing.companyName || 'Adrien & Emily';

    const tokenSnap = await db.collection('email_tokens').doc(senderAccount).get();
    if (!tokenSnap.exists) {
      const e = new Error('email_tokens/' + senderAccount + ' introuvable. Configurez le compte expéditeur dans les paramètres facturation.'); e.status = 500; throw e;
    }
    const senderEmail = (tokenSnap.data() || {}).email || 'contact@adrienemily.com';
    const shouldBcc = (body.useBcc != null ? body.useBcc : enableBcc);
    const bcc = shouldBcc ? [senderEmail] : [];

    /* ── Pièces jointes ── */
    const attachments = [];
    if (attachPdf) {
      let logoBuf = null;
      if (billing.logoMode === 'image' && billing.logoBase64) {
        const m = String(billing.logoBase64).match(/^data:image\/(\w+);base64,(.+)$/);
        if (m) {
          try { logoBuf = Buffer.from(m[2], 'base64'); }
          catch (e) { console.warn('[client-statement-send] Logo decode failed:', e.message); }
        }
      }
      let fonts = null;
      try {
        fonts = await loadMontserratFonts();
      } catch (e) {
        console.warn('[client-statement-send] Montserrat fonts unavailable:', e.message);
      }
      const pdfBuf = await generateStatementPdf({
        statement: statement,
        periodText: core.periodLabel(statement.period),
        issuer: billing,
        logoBuf: logoBuf,
        fonts: fonts,
      });
      attachments.push({ filename: baseName + '.pdf', contentBytes: pdfBuf, contentType: 'application/pdf' });
    }
    if (attachCsv) {
      const csv = '\uFEFF' + core.clientStatementCsv(statement);
      attachments.push({ filename: baseName + '.csv', contentBytes: Buffer.from(csv, 'utf-8'), contentType: 'text/csv' });
    }

    /* ── Envoi Gmail ── */
    const htmlBody = wrapAsHtml(bodyText, billing);
    let sendResult;
    try {
      sendResult = await sendGmailWithAttachment({
        tokenAccount: senderAccount,
        fromName: fromName,
        to: to,
        cc: cc,
        bcc: bcc,
        subject: subject,
        bodyText: bodyText,
        bodyHtml: htmlBody,
        attachments: attachments,
      });
    } catch (gmailErr) {
      console.error('[client-statement-send] Gmail send failed:', gmailErr);
      const e = new Error('Échec envoi email : ' + (gmailErr.message || gmailErr)); e.status = gmailErr.status || 502; throw e;
    }

    /* ── Trace d'audit sur la fiche client (AVANT la réponse — Vercel coupe
       la fonction dès res.end) ── */
    await db.collection('invoice_clients').doc(clientId).update({
      statementSentHistory: admin.firestore.FieldValue.arrayUnion({
        sentAt: new Date().toISOString(),
        sentBy: user.uid,
        sentByEmail: user.email || null,
        to: to,
        cc: cc,
        period: { from: periodFrom, to: periodTo },
        balance: statement.totals.balance,
        messageId: sendResult.messageId || null,
      }),
      lastStatementSentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      messageId: sendResult.messageId,
      threadId: sendResult.threadId,
      sentTo: to,
      sentCc: cc,
      sentBcc: bcc,
    });
  } catch (err) {
    sendError(res, err);
  }
};
