// ============================================================================
// api/user-password-reset.js
// ----------------------------------------------------------------------------
// Endpoint PUBLIC (pas d'auth) pour demander un reset de mot de passe depuis
// login.html. Remplace sendPasswordResetEmail() côté client qui échoue
// silencieusement si le user tape un alias différent de l'email officiel
// enregistré dans Firebase Auth.
//
// Flow :
//   1. Cherche le user dans Firestore users où email == X (champ principal)
//   2. Sinon cherche où workEmails array-contains X (alias additionnels)
//   3. Sinon fallback admin.auth().getUserByEmail(X)
//   4. Récupère l'email officiel Firebase Auth → génère le reset sur cet email
//      (le mail arrivera dans la boîte réelle via la redirection Workspace)
//   5. Envoie l'email via Gmail OAuth strategie@
//
// Sécurité :
//   - Renvoie TOUJOURS { ok: true, sent: true } même si rien trouvé
//     → anti-enumeration (comportement Firebase natif)
//   - Rate limit : max 3 tentatives par email par 15 min, stocké dans
//     Firestore password_reset_attempts/{emailKey}
//   - Audit log dans audit_log (succès + échecs + tentatives rate-limit)
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');

// Rate limit config
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 3;                    // 3 tentatives par fenêtre

function normalizeEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

// Clé Firestore-safe pour rate limit (emails contiennent @ et . qui passent en path)
function rateLimitKey(email) {
  return email.replace(/[^a-z0-9@._-]/g, '_').substring(0, 150);
}

async function logAudit(data) {
  try {
    await db.collection('audit_log').add({
      ...data,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[user-password-reset] Audit log failed:', e.message);
  }
}

// Vérifie + incrémente le rate limit. Retourne { allowed, count }
async function checkRateLimit(email) {
  const key = rateLimitKey(email);
  const ref = db.collection('password_reset_attempts').doc(key);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;

    // Reset si fenêtre expirée
    if (!data || (now - (data.firstAt?.toMillis?.() || 0)) > RATE_LIMIT_WINDOW_MS) {
      tx.set(ref, {
        count: 1,
        firstAt: admin.firestore.FieldValue.serverTimestamp(),
        lastAt: admin.firestore.FieldValue.serverTimestamp(),
        email,
      });
      return { allowed: true, count: 1 };
    }

    const newCount = (data.count || 0) + 1;
    tx.update(ref, {
      count: newCount,
      lastAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { allowed: newCount <= RATE_LIMIT_MAX, count: newCount };
  });
}

// Trouve le user Firebase Auth à partir d'un email tapé (possiblement un alias)
// Retourne { uid, officialEmail, displayName } ou null si rien trouvé
async function resolveUserFromEmail(typedEmail) {
  // 1. Cherche dans Firestore users où email == typedEmail
  try {
    const q1 = await db.collection('users').where('email', '==', typedEmail).limit(1).get();
    if (!q1.empty) {
      const userDoc = q1.docs[0];
      const authUser = await admin.auth().getUser(userDoc.id);
      return {
        uid: userDoc.id,
        officialEmail: authUser.email,
        displayName: authUser.displayName || userDoc.data().displayName || null,
        matchedVia: 'firestore_email',
      };
    }
  } catch (e) { console.warn('[resolveUser] Firestore email query failed:', e.message); }

  // 2. Cherche dans Firestore users où workEmails array-contains typedEmail
  try {
    const q2 = await db.collection('users').where('workEmails', 'array-contains', typedEmail).limit(1).get();
    if (!q2.empty) {
      const userDoc = q2.docs[0];
      const authUser = await admin.auth().getUser(userDoc.id);
      return {
        uid: userDoc.id,
        officialEmail: authUser.email,
        displayName: authUser.displayName || userDoc.data().displayName || null,
        matchedVia: 'workEmails_alias',
      };
    }
  } catch (e) { console.warn('[resolveUser] workEmails query failed:', e.message); }

  // 3. Fallback : essaie Firebase Auth direct (cas d'un user sans doc Firestore)
  try {
    const authUser = await admin.auth().getUserByEmail(typedEmail);
    return {
      uid: authUser.uid,
      officialEmail: authUser.email,
      displayName: authUser.displayName || null,
      matchedVia: 'firebase_auth_direct',
    };
  } catch (e) {
    // user-not-found = c'est normal, on ne log pas
    if (e.code !== 'auth/user-not-found') {
      console.warn('[resolveUser] Firebase Auth lookup failed:', e.message);
    }
  }

  return null;
}

function buildResetEmailHtml({ displayName, resetLink, typedEmail, officialEmail }) {
  const safeName = displayName || '';
  const aliasNote = (typedEmail.toLowerCase() !== officialEmail.toLowerCase())
    ? `<p style="color:#666;font-size:12px;margin:12px 0 0;padding:10px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px">ℹ️ Tu as demandé le reset avec <b>${typedEmail}</b>, qui est un alias. Pour te connecter, utilise ton email principal : <b>${officialEmail}</b></p>`
    : '';
  return `
<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f7f7f8;border-radius:12px;color:#1a1a1a">
  <div style="background:linear-gradient(135deg,#b91c1c,#ef4444);width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:700">🔑</div>
  <h2 style="color:#b91c1c;margin:18px 0 12px;font-size:20px">Réinitialisation de mot de passe</h2>
  <p style="margin:0 0 12px">Bonjour ${safeName},</p>
  <p style="margin:0 0 12px">Tu as demandé une réinitialisation de ton mot de passe Ambitio.</p>
  <p style="margin:0 0 16px">Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
  <div style="margin:24px 0">
    <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px">Réinitialiser mon mot de passe</a>
  </div>
  <p style="color:#666;font-size:12px;margin:16px 0 8px">Si le bouton ne fonctionne pas, copie-colle ce lien dans ton navigateur :</p>
  <p style="color:#666;font-size:12px;word-break:break-all;background:#fff;padding:10px;border-radius:6px;border:1px solid #e5e5e5;margin:0">${resetLink}</p>
  ${aliasNote}
  <p style="color:#999;font-size:11px;margin-top:28px">Ce lien expire après 1h. Si tu n'es pas à l'origine de cette demande, ignore cet email — ton mot de passe actuel reste valide.</p>
  <p style="color:#999;font-size:11px;margin-top:4px">— Équipe Ambitio</p>
</div>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req);
  const typedEmail = normalizeEmail(body.email);

  // Validation format basique
  if (!typedEmail || !typedEmail.includes('@') || typedEmail.length > 250) {
    // On ne révèle pas non plus la raison — même UX qu'un succès silencieux
    return res.status(200).json({ ok: true, sent: true });
  }

  // Rate limit (toujours renvoie succès silencieux même si bloqué)
  let rateLimit;
  try {
    rateLimit = await checkRateLimit(typedEmail);
  } catch (e) {
    console.error('[user-password-reset] Rate limit check failed:', e);
    rateLimit = { allowed: true, count: 1 }; // fail open pour ne pas bloquer de vrais users
  }

  if (!rateLimit.allowed) {
    await logAudit({
      action: 'password_reset_self_rate_limited',
      targetEmail: typedEmail,
      success: false,
      error: `Rate limit exceeded (${rateLimit.count} attempts)`,
    });
    return res.status(200).json({ ok: true, sent: true });
  }

  // Résolution user (tolère les alias)
  const user = await resolveUserFromEmail(typedEmail);

  if (!user) {
    // Aucun user trouvé — on log mais on renvoie succès silencieux
    await logAudit({
      action: 'password_reset_self_unknown_email',
      targetEmail: typedEmail,
      success: false,
      error: 'No user found for this email or alias',
    });
    return res.status(200).json({ ok: true, sent: true });
  }

  // Génère le lien de reset sur l'email officiel Firebase
  let resetLink;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(user.officialEmail);
  } catch (e) {
    console.error('[user-password-reset] generateResetLink failed:', e);
    await logAudit({
      action: 'password_reset_self',
      targetUid: user.uid,
      targetEmail: user.officialEmail,
      typedEmail,
      success: false,
      error: 'generateResetLink failed: ' + e.message,
    });
    return res.status(200).json({ ok: true, sent: true });
  }

  // Envoi du mail via Gmail OAuth strategie@ (vers l'email officiel)
  let emailSent = false;
  let emailError = null;
  try {
    const mail = await sendEmailFromAccount({
      accountKey: 'strategie',
      to: user.officialEmail,
      subject: 'Réinitialisation de votre mot de passe Ambitio',
      bodyHtml: buildResetEmailHtml({
        displayName: user.displayName,
        resetLink,
        typedEmail,
        officialEmail: user.officialEmail,
      }),
      bodyText:
        `Bonjour ${user.displayName || ''},\n\n` +
        `Tu as demandé une réinitialisation de ton mot de passe Ambitio.\n` +
        `Ouvre ce lien pour choisir un nouveau mot de passe :\n${resetLink}\n\n` +
        (typedEmail.toLowerCase() !== user.officialEmail.toLowerCase()
          ? `Note : tu as utilisé l'alias ${typedEmail}. Ton email principal pour te connecter est ${user.officialEmail}.\n\n`
          : '') +
        `Ce lien expire après 1h.\n\n— Équipe Ambitio`,
    });
    emailSent = !!mail.ok;
    if (!mail.ok) emailError = mail.error || 'Envoi email échoué';
  } catch (mailErr) {
    emailError = mailErr.message || String(mailErr);
    console.error('[user-password-reset] Email send failed:', emailError);
  }

  await logAudit({
    action: 'password_reset_self',
    targetUid: user.uid,
    targetEmail: user.officialEmail,
    typedEmail,
    matchedVia: user.matchedVia,
    success: emailSent,
    error: emailSent ? null : emailError,
  });

  // Succès silencieux côté client (même si email failed — évite enumeration)
  return res.status(200).json({ ok: true, sent: true });
};
