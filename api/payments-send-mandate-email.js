// ==========================================================================
// api/payments-send-mandate-email.js
// --------------------------------------------------------------------------
// Envoie au client l'email contenant le lien mandat GoCardless (IBAN).
// Utilise le compte Gmail OAuth `strategie@adrienemily.com` (token dans
// email_tokens/strategie) via le helper partagé `_gmailSend`.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { ok: true, messageId, from }
//
// Log latéral : écrit une entrée communications[] + timeline_history[] sur
// leads/{leadId} (même schéma que twilio-sms-send pour que sales-contact.html
// et sales-leads.html rendent l'email sans modification frontend).
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { sendEmailFromAccount } = require('./_gmailSend');
const parseBody = require('./_parseBody');

const ACCOUNT_KEY = 'strategie';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmail({ leadName, description, flowUrl }) {
  const safeName = esc(leadName || 'Bonjour');
  const safeDesc = esc(description || 'votre programme');
  const safeUrl = esc(flowUrl);

  const subject = 'Mise en place de votre prélèvement — ' + (description || 'Ambitio');

  const bodyHtml = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f7;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
          <tr>
            <td style="padding:32px 36px 8px;font-size:16px;line-height:1.55;color:#1a1a1a">
              <p style="margin:0 0 16px">Bonjour ${safeName},</p>

              <p style="margin:0 0 16px">Pour finaliser la mise en place de <strong>${safeDesc}</strong>, il ne vous reste qu'à renseigner vos coordonnées bancaires via le lien sécurisé ci-dessous :</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 36px 24px">
              <a href="${safeUrl}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px">Renseigner mon IBAN</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 24px;font-size:13px;line-height:1.55;color:#555">
              <p style="margin:0 0 12px">Ou copiez ce lien dans votre navigateur :</p>
              <p style="margin:0 0 20px;word-break:break-all;font-family:Menlo,Monaco,monospace;font-size:12px;color:#333">${safeUrl}</p>

              <p style="margin:0 0 12px;font-size:12px;color:#777">Ce lien vous dirige vers notre partenaire de prélèvement <strong>GoCardless</strong>, leader européen du SEPA. Vos informations bancaires sont traitées de manière sécurisée et ne sont jamais stockées sur nos serveurs.</p>

              <p style="margin:16px 0 0;font-size:13px;color:#555">Pour toute question, répondez simplement à cet email.</p>

              <p style="margin:16px 0 0;font-size:13px;color:#1a1a1a">Cordialement,<br/><strong>L'équipe Ambitio</strong></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const bodyText = `Bonjour ${leadName || ''},

Pour finaliser la mise en place de ${description || 'votre programme'}, il ne vous reste qu'à renseigner vos coordonnées bancaires via le lien sécurisé ci-dessous :

${flowUrl}

Ce lien vous dirige vers notre partenaire GoCardless (prélèvement SEPA). Vos informations bancaires sont traitées de manière sécurisée et ne sont jamais stockées sur nos serveurs.

Pour toute question, répondez simplement à cet email.

Cordialement,
L'équipe Ambitio`;

  return { subject, bodyHtml, bodyText };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    // ─── Load payment ───
    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (!pay.leadEmail) {
      res.status(400).json({ error: 'Aucun email sur ce paiement' });
      return;
    }
    if (!pay.gcBillingRequestFlowUrl) {
      res.status(400).json({ error: 'Aucun lien mandat généré — crée-le d\'abord' });
      return;
    }

    // ─── Build email ───
    const { subject, bodyHtml, bodyText } = buildEmail({
      leadName: pay.leadName,
      description: pay.description,
      flowUrl: pay.gcBillingRequestFlowUrl
    });

    // ─── Send via Gmail OAuth (compte strategie) ───
    const result = await sendEmailFromAccount({
      accountKey: ACCOUNT_KEY,
      to: pay.leadEmail,
      subject,
      bodyHtml,
      bodyText
    });

    if (!result.ok) {
      console.error('[payments-send-mandate-email] send failed:', result.error);
      res.status(502).json({ error: result.error || 'Échec envoi Gmail' });
      return;
    }

    // ─── Log dans leads/{leadId}.communications[] + timeline_history[] ───
    if (pay.leadId) {
      try {
        // Résolution ownerName (même pattern que twilio-sms-send)
        let ownerName = null;
        try {
          const metaSnap = await db.collection('_meta').doc('team_members').get();
          if (metaSnap.exists) {
            const members = metaSnap.data().members || [];
            const me = members.find(m => m.firebaseUid === auth.uid);
            if (me) ownerName = me.shortName || me.displayName || null;
          }
        } catch (_) { /* non-bloquant */ }
        ownerName = ownerName || auth.email || 'Équipe';

        const nowIso = new Date().toISOString();
        const commEntry = {
          type: 'email',
          direction: 'outbound',
          content: bodyText,
          subject: subject,
          source: 'gmail-strategie',
          date: nowIso,
          createdAt: nowIso,
          ownerUid: auth.uid,
          ownerName,
          providerMessageId: result.messageId || null,
          fromEmail: result.from || ACCOUNT_KEY + '@adrienemily.com',
          toEmail: pay.leadEmail
        };

        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const timelineEntry = {
          text: '📧 Email mandat envoyé (strategie) — ' + (subject || '').substring(0, 100),
          date: tlDate,
          color: '#a78bfa'
        };

        await db.collection('leads').doc(pay.leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion(commEntry),
          timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
          lastContactType: 'email',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logErr) {
        // Non-bloquant : l'email est parti, on log juste l'échec du tracking
        console.warn('[payments-send-mandate-email] log lead failed (non-bloquant):', logErr.message);
      }
    }

    console.log('[payments-send-mandate-email] ✅ sent', {
      paymentId,
      to: pay.leadEmail,
      from: result.from,
      messageId: result.messageId
    });

    res.json({
      ok: true,
      messageId: result.messageId,
      from: result.from
    });

  } catch (e) {
    console.error('[payments-send-mandate-email]', e.message);
    res.status(500).json({ error: e.message });
  }
};
