// ============================================================================
// api/_aiMail.js — envoi des emails du programme IA aux admins
// ----------------------------------------------------------------------------
// Destinataires : users où role === 'admin' (email du compte Firebase Auth),
// complétés par _config/ai.extraEmails[] si renseigné. Compte d'envoi Gmail :
// _config/ai.emailAccount ('contact' par défaut — cf. api/_gmailSend.js).
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');

async function adminEmails() {
  const out = {};
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    snap.forEach(function (d) {
      const u = d.data() || {};
      if (u.disabled === true || u.active === false) return;
      const e = String(u.email || '').trim().toLowerCase();
      if (e && e.indexOf('@') > 0) out[e] = 1;
    });
  } catch (e) { console.warn('[_aiMail] lecture admins impossible', e.message); }
  try {
    const c = await db.collection('_config').doc('ai').get();
    const extra = (c.exists && Array.isArray((c.data() || {}).extraEmails)) ? c.data().extraEmails : [];
    extra.forEach(function (e) { e = String(e || '').trim().toLowerCase(); if (e.indexOf('@') > 0) out[e] = 1; });
  } catch (e) { /* facultatif */ }
  return Object.keys(out);
}

async function emailAccount() {
  try {
    const c = await db.collection('_config').doc('ai').get();
    if (c.exists && c.data().emailAccount) return String(c.data().emailAccount);
  } catch (e) { /* défaut */ }
  return 'contact';
}

function wrapHtml(title, inner) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1f2330">' +
    '<div style="padding:18px 22px;border-radius:14px 14px 0 0;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff">' +
    '<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Alteore · IA</div>' +
    '<div style="font-size:19px;font-weight:700;margin-top:4px">' + title + '</div></div>' +
    '<div style="padding:20px 22px;border:1px solid #e6e7ee;border-top:none;border-radius:0 0 14px 14px;line-height:1.55;font-size:14px">' +
    inner + '</div></div>';
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function sendToAdmins(subject, innerHtml) {
  const to = await adminEmails();
  if (!to.length) return { ok: false, error: 'no_admin_email' };
  const accountKey = await emailAccount();
  const html = wrapHtml(subject, innerHtml);
  try {
    return await sendEmailFromAccount({
      accountKey: accountKey,
      to: to.join(', '),
      subject: subject,
      bodyHtml: html,
      bodyText: htmlToText(html),
    });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { sendToAdmins: sendToAdmins, adminEmails: adminEmails, wrapHtml: wrapHtml, htmlToText: htmlToText };
