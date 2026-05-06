/**
 * api/invoice-send-email.js
 *
 * Endpoint POST d'envoi d'une facture par email.
 *
 * Flux :
 *   1. Auth Bearer + role admin
 *   2. Lecture facture (doit être validée minimum + pdfHash présent)
 *   3. Reconstitution du PDF depuis les chunks Firestore
 *   4. Lecture compte expéditeur + paramètres email (BCC, etc.)
 *   5. Envoi via Gmail API avec PDF en pièce jointe
 *   6. Update facture :
 *        - status: 'sent' (sauf si déjà 'paid', on conserve)
 *        - sentAt, sentBy, sentTo, lastSentAt
 *        - sentHistory[] arrayUnion (date, to, cc, bcc, subject, messageId)
 *        - timeline[] arrayUnion
 *
 * POST body :
 *   {
 *     invoiceId: string,
 *     to: string[],           // destinataires
 *     cc?: string[],          // CC optionnel
 *     subject: string,        // sujet final (template déjà résolu côté UI)
 *     bodyText: string,       // corps texte final (template déjà résolu côté UI)
 *     useBcc?: boolean        // override paramètre par défaut
 *   }
 *
 * Response 200 : { success, messageId, threadId, sentTo }
 */

const { admin, db, requireAuth, reassembleBase64Chunks, sendError, setCors } = require('./_billing-helpers');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const { wrapAsHtml } = require('./_billing-email-templates');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body ── */
    const body = req.body || {};
    const invoiceId = body.invoiceId;
    const toRaw = body.to;
    const cc = Array.isArray(body.cc) ? body.cc.filter(function(e){ return e && e.trim(); }) : [];
    const subject = body.subject;
    const bodyText = body.bodyText;
    const useBcc = body.useBcc;

    if (!invoiceId || typeof invoiceId !== 'string') {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }
    const to = Array.isArray(toRaw) ? toRaw.filter(function(e){ return e && e.trim(); }) : (toRaw ? [toRaw] : []);
    if (!to.length) {
      const e = new Error('Au moins un destinataire requis'); e.status = 400; throw e;
    }
    /* Validation basique des emails */
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
    if (!subject || !subject.trim()) {
      const e = new Error('Sujet requis'); e.status = 400; throw e;
    }
    if (!bodyText || !bodyText.trim()) {
      const e = new Error('Corps requis'); e.status = 400; throw e;
    }

    /* ── Lecture facture ── */
    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data();
    if (invoice.status === 'draft') {
      const e = new Error('Validez la facture avant de l\'envoyer'); e.status = 400; throw e;
    }
    if (!invoice.pdfHash) {
      const e = new Error('PDF non disponible (génération échouée ou en attente)'); e.status = 400; throw e;
    }

    /* ── Reconstitution PDF ── */
    const chunksSnap = await invRef.collection('pdf').orderBy('index').get();
    if (chunksSnap.empty) {
      const e = new Error('PDF chunks introuvables — régénération nécessaire'); e.status = 500; throw e;
    }
    const chunks = [];
    chunksSnap.forEach(function(d){ chunks.push(d.data()); });
    const pdfBuf = reassembleBase64Chunks(chunks);

    /* ── Config émetteur + email ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    if (!billingSnap.exists) {
      const e = new Error('Configuration de facturation manquante'); e.status = 500; throw e;
    }
    const billing = billingSnap.data();
    const senderAccount = billing.senderAccount || 'contact';
    const enableBcc = billing.enableBcc != null ? billing.enableBcc : true;
    const fromName = billing.companyName || 'Adrien & Emily';

    /* BCC : utilise le compte expéditeur lui-même par défaut */
    const tokenSnap = await db.collection('email_tokens').doc(senderAccount).get();
    if (!tokenSnap.exists) {
      const e = new Error('email_tokens/' + senderAccount + ' introuvable. Configurez le compte expéditeur dans les paramètres facturation.'); e.status = 500; throw e;
    }
    const senderEmail = (tokenSnap.data() || {}).email || 'contact@adrienemily.com';
    const shouldBcc = (useBcc != null ? useBcc : enableBcc);
    const bcc = shouldBcc ? [senderEmail] : [];

    /* ── HTML wrap pour l'email ── */
    const htmlBody = wrapAsHtml(bodyText, billing);

    /* ── Envoi Gmail ── */
    const filename = (invoice.number || invoiceId) + '.pdf';
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
        attachments: [{
          filename: filename,
          contentBytes: pdfBuf,
          contentType: 'application/pdf',
        }],
      });
    } catch (gmailErr) {
      console.error('[invoice-send-email] Gmail send failed:', gmailErr);
      /* Trace l'erreur sur la facture sans bloquer le statut */
      await invRef.update({
        lastSendError: String(gmailErr.message || gmailErr).substring(0, 500),
        lastSendErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const e = new Error('Échec envoi email : ' + (gmailErr.message || gmailErr)); e.status = gmailErr.status || 502; throw e;
    }

    /* ── Update facture ── */
    const sendEntry = {
      sentAt: new Date().toISOString(),
      sentBy: user.uid,
      sentByEmail: user.email || null,
      to: to,
      cc: cc,
      bcc: bcc,
      subject: subject,
      messageId: sendResult.messageId || null,
      threadId: sendResult.threadId || null,
    };

    /* On ne dégrade pas le statut si déjà paid (renvoi possible après paiement) */
    const newStatus = (invoice.status === 'paid') ? 'paid' : 'sent';

    const updates = {
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSentTo: to,
      lastSendError: null,
      lastSendErrorAt: null,
      sentHistory: admin.firestore.FieldValue.arrayUnion(sendEntry),
      timeline: admin.firestore.FieldValue.arrayUnion({
        type: 'invoice_sent',
        at: new Date().toISOString(),
        by: user.uid,
        byEmail: user.email || null,
        to: to.join(', '),
      }),
    };

    /* Premier envoi : on bascule en 'sent' et on enregistre les premières dates */
    if (!invoice.sentAt && invoice.status !== 'paid') {
      updates.status = 'sent';
      updates.sentAt = admin.firestore.FieldValue.serverTimestamp();
      updates.sentBy = user.uid;
      updates.sentByEmail = user.email || null;
      updates.sentTo = to;
    } else if (invoice.status !== 'paid' && invoice.status !== 'sent') {
      updates.status = newStatus;
    }

    await invRef.update(updates);

    /* ── Réponse ── */
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
