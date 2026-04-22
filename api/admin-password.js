// ============================================================================
// api/admin-password.js
// ----------------------------------------------------------------------------
// Gestion admin des mots de passe Firebase Auth.
//
// Actions supportées (POST + Authorization: Bearer <idToken>) :
//
//   { action: 'sendResetLink', uid: string }
//     → Génère un lien de reset Firebase pour l'email du user cible
//     → Envoie un email automatique via Gmail OAuth (strategie@)
//     → Retourne { ok, link, emailSent, emailError?, targetEmail }
//     → Le lien reste exploitable même si l'email échoue (fallback copier)
//
//   { action: 'setPassword', uid: string, password: string }
//     → Définit directement un nouveau mot de passe (Admin SDK updateUser)
//     → Marche aussi si uid === admin.uid (admin change son propre MDP)
//     → Retourne { ok, isSelf }
//
// Auth : requireAdmin — role === 'admin' dans users/{uid}
// Audit : chaque action est tracée dans audit_log (success + failures)
//
// Validation MDP : minimum 8 caractères (strictement supérieur au minimum
// Firebase Auth de 6, pour renforcer la sécurité à la définition admin).
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');

const MIN_PASSWORD_LENGTH = 8;

function validatePassword(pwd) {
  if (typeof pwd !== 'string') return 'Mot de passe manquant';
  if (pwd.length < MIN_PASSWORD_LENGTH) return `Minimum ${MIN_PASSWORD_LENGTH} caractères`;
  if (pwd.length > 4096) return 'Mot de passe trop long';
  return null;
}

async function logAudit({ action, actorUid, actorEmail, targetUid, targetEmail, success, error }) {
  try {
    await db.collection('audit_log').add({
      action,
      actorUid: actorUid || null,
      actorEmail: actorEmail || null,
      targetUid: targetUid || null,
      targetEmail: targetEmail || null,
      success: !!success,
      error: error || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[admin-password] Audit log failed:', e.message);
  }
}

function buildResetEmailHtml({ displayName, resetLink }) {
  const safeName = displayName || '';
  return `
<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f7f7f8;border-radius:12px;color:#1a1a1a">
  <div style="background:linear-gradient(135deg,#b91c1c,#ef4444);width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:700">🔑</div>
  <h2 style="color:#b91c1c;margin:18px 0 12px;font-size:20px">Réinitialisation de mot de passe</h2>
  <p style="margin:0 0 12px">Bonjour ${safeName},</p>
  <p style="margin:0 0 12px">Un administrateur d'Ambitio a demandé une réinitialisation de ton mot de passe.</p>
  <p style="margin:0 0 16px">Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
  <div style="margin:24px 0">
    <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px">Réinitialiser mon mot de passe</a>
  </div>
  <p style="color:#666;font-size:12px;margin:16px 0 8px">Si le bouton ne fonctionne pas, copie-colle ce lien dans ton navigateur :</p>
  <p style="color:#666;font-size:12px;word-break:break-all;background:#fff;padding:10px;border-radius:6px;border:1px solid #e5e5e5;margin:0">${resetLink}</p>
  <p style="color:#999;font-size:11px;margin-top:28px">Ce lien expire après 1h. Si tu n'es pas à l'origine de cette demande, ignore cet email — ton mot de passe actuel reste valide.</p>
  <p style="color:#999;font-size:11px;margin-top:4px">— Équipe Ambitio</p>
</div>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth admin
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req);
  const { action, uid, password } = body;

  if (!action) return res.status(400).json({ error: 'action manquant' });
  if (!uid) return res.status(400).json({ error: 'uid manquant' });

  // Récupère infos user cible
  let targetUser;
  try {
    targetUser = await admin.auth().getUser(uid);
  } catch (e) {
    return res.status(404).json({ error: 'Utilisateur introuvable : ' + (e.message || e.code) });
  }
  const targetEmail = targetUser.email || null;
  const targetName = targetUser.displayName || targetEmail;

  // ─── Action 1 : Envoyer un lien de reset ───
  if (action === 'sendResetLink') {
    if (!targetEmail) {
      return res.status(400).json({ error: 'User sans email : reset impossible' });
    }
    try {
      const resetLink = await admin.auth().generatePasswordResetLink(targetEmail);

      // Envoi email automatique (best effort — on n'échoue pas la requête si ça rate)
      let emailSent = false;
      let emailError = null;
      try {
        const mail = await sendEmailFromAccount({
          accountKey: 'strategie',
          to: targetEmail,
          subject: 'Réinitialisation de votre mot de passe Ambitio',
          bodyHtml: buildResetEmailHtml({ displayName: targetName, resetLink }),
          bodyText:
            `Bonjour ${targetName || ''},\n\n` +
            `Un administrateur d'Ambitio a demandé une réinitialisation de ton mot de passe.\n` +
            `Ouvre ce lien pour choisir un nouveau mot de passe :\n${resetLink}\n\n` +
            `Ce lien expire après 1h.\n\n— Équipe Ambitio`,
        });
        emailSent = !!mail.ok;
        if (!mail.ok) emailError = mail.error || 'Envoi email échoué';
      } catch (mailErr) {
        emailError = mailErr.message || String(mailErr);
        console.warn('[admin-password] Email send failed:', emailError);
      }

      await logAudit({
        action: 'password_reset_link_sent',
        actorUid: auth.uid,
        actorEmail: auth.email,
        targetUid: uid,
        targetEmail,
        success: true,
        error: emailSent ? null : `Email failed: ${emailError}`,
      });

      return res.status(200).json({
        ok: true,
        link: resetLink,
        emailSent,
        emailError,
        targetEmail,
      });
    } catch (e) {
      console.error('[admin-password] generateResetLink error:', e);
      await logAudit({
        action: 'password_reset_link_sent',
        actorUid: auth.uid,
        actorEmail: auth.email,
        targetUid: uid,
        targetEmail,
        success: false,
        error: e.message,
      });
      return res.status(500).json({ error: e.message });
    }
  }

  // ─── Action 2 : Définir un mot de passe ───
  if (action === 'setPassword') {
    const pwdError = validatePassword(password);
    if (pwdError) return res.status(400).json({ error: pwdError });

    try {
      await admin.auth().updateUser(uid, { password });

      const isSelf = uid === auth.uid;
      await logAudit({
        action: isSelf ? 'password_changed_self' : 'password_set_by_admin',
        actorUid: auth.uid,
        actorEmail: auth.email,
        targetUid: uid,
        targetEmail,
        success: true,
      });

      return res.status(200).json({ ok: true, isSelf });
    } catch (e) {
      console.error('[admin-password] setPassword error:', e);
      await logAudit({
        action: uid === auth.uid ? 'password_changed_self' : 'password_set_by_admin',
        actorUid: auth.uid,
        actorEmail: auth.email,
        targetUid: uid,
        targetEmail,
        success: false,
        error: e.message,
      });
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
