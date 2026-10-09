// ============================================================================
// api/_userInvite.js — helpers partagés des invitations de comptes équipe
// ----------------------------------------------------------------------------
// Remplace l'ancien sendPasswordResetEmail() client (09/10/2026) : email
// Firebase par défaut en anglais, expéditeur noreply@…firebaseapp.com (spam),
// lien valable 1 h, aucune étape d'activation par un admin.
//
// Parcours :
//   1. Admin crée l'utilisateur (méthode Invitation) → compte Auth DÉSACTIVÉ,
//      users/{uid}.status = 'invited', jeton envoyé depuis strategie@.
//   2. La personne ouvre set-password.html?t=… et choisit son mot de passe →
//      status = 'pending_activation', notification aux admins (email + pop-up
//      alteore-pending-users.js).
//   3. Un admin vérifie les droits et active → compte Auth réactivé,
//      status = 'active', email « ton accès est ouvert ».
//
// Jetons : user_invites/{sha256(jeton)} — le jeton en clair n'est jamais
// stocké. Collection sans règle Firestore = inaccessible côté client, lue et
// écrite uniquement ici (Admin SDK). Rien n'est supprimé : un jeton remplacé
// reçoit revokedAt, un jeton utilisé reçoit usedAt.
// ============================================================================

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const BASE_URL = 'https://team.alteore.com';
const MAIL_ACCOUNT = 'strategie';
const ADMIN_NOTIFY_EMAIL = 'contact@adrienemily.com';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function firstName(displayName) {
  return String(displayName || '').trim().split(/\s+/)[0] || '';
}

// Révoque les jetons encore valides de cet utilisateur (un renvoi annule
// le lien précédent).
async function revokeOpenInvites(uid) {
  const snap = await db.collection('user_invites').where('uid', '==', uid).get();
  const batch = db.batch();
  let n = 0;
  snap.forEach(function (d) {
    const x = d.data() || {};
    if (!x.usedAt && !x.revokedAt) {
      batch.update(d.ref, { revokedAt: admin.firestore.FieldValue.serverTimestamp() });
      n++;
    }
  });
  if (n) await batch.commit();
  return n;
}

// Crée un nouveau jeton (et révoque les anciens). Retourne { token, link, expiresAt }.
async function createInvite({ uid, email, displayName, createdBy }) {
  await revokeOpenInvites(uid);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.collection('user_invites').doc(hashToken(token)).set({
    uid: uid,
    email: email,
    displayName: displayName || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: createdBy || null,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    usedAt: null,
    revokedAt: null,
  });
  return { token: token, link: BASE_URL + '/set-password.html?t=' + token, expiresAt: expiresAt };
}

// Lit un jeton. Retourne { ref, data, state } — state : 'ok' | 'unknown' |
// 'used' | 'revoked' | 'expired'.
async function readInvite(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return { state: 'unknown' };
  const ref = db.collection('user_invites').doc(hashToken(token));
  const snap = await ref.get();
  if (!snap.exists) return { state: 'unknown' };
  const data = snap.data() || {};
  if (data.usedAt) return { ref: ref, data: data, state: 'used' };
  if (data.revokedAt) return { ref: ref, data: data, state: 'revoked' };
  const exp = data.expiresAt && data.expiresAt.toMillis ? data.expiresAt.toMillis() : 0;
  if (exp < Date.now()) return { ref: ref, data: data, state: 'expired' };
  return { ref: ref, data: data, state: 'ok' };
}

function mailShell(innerHtml) {
  return '<div style="font-family:-apple-system,\'Segoe UI\',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;background:#f7f7f8;border-radius:12px;color:#1a1a1a">' +
    innerHtml +
    '<p style="color:#999;font-size:11px;margin-top:28px">— L\'équipe Adrien&amp;Emily · Alteore</p>' +
    '</div>';
}

function button(href, label) {
  return '<div style="margin:24px 0"><a href="' + escHtml(href) + '" style="display:inline-block;padding:14px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">' + escHtml(label) + '</a></div>' +
    '<p style="color:#666;font-size:12px;margin:16px 0 8px">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>' +
    '<p style="color:#666;font-size:12px;word-break:break-all;background:#fff;padding:10px;border-radius:6px;border:1px solid #e5e5e5;margin:0">' + escHtml(href) + '</p>';
}

// Envoie l'email d'invitation. Retourne { emailSent, emailError }.
async function sendInviteEmail({ email, displayName, link }) {
  const fn = firstName(displayName);
  const html = mailShell(
    '<h2 style="color:#5b21b6;margin:0 0 14px;font-size:20px">Bienvenue dans l\'équipe' + (fn ? ', ' + escHtml(fn) : '') + ' 👋</h2>' +
    '<p style="margin:0 0 12px">Un compte a été créé pour vous sur l\'espace équipe Alteore (team.alteore.com).</p>' +
    '<p style="margin:0 0 12px">Pour l\'activer, choisissez votre mot de passe en cliquant sur le bouton ci-dessous :</p>' +
    button(link, 'Choisir mon mot de passe') +
    '<p style="color:#444;font-size:13px;margin:18px 0 0">Votre identifiant de connexion sera : <b>' + escHtml(email) + '</b></p>' +
    '<p style="color:#444;font-size:13px;margin:8px 0 0">Une fois votre mot de passe enregistré, un administrateur ouvrira votre accès. Vous recevrez un email de confirmation à ce moment-là.</p>' +
    '<p style="color:#999;font-size:11px;margin-top:20px">Ce lien est valable 7 jours.</p>'
  );
  const text =
    'Bonjour ' + fn + ',\n\n' +
    'Un compte a été créé pour vous sur l\'espace équipe Alteore (team.alteore.com).\n' +
    'Choisissez votre mot de passe ici :\n' + link + '\n\n' +
    'Identifiant de connexion : ' + email + '\n' +
    'Une fois votre mot de passe enregistré, un administrateur ouvrira votre accès.\n\n' +
    'Ce lien est valable 7 jours.\n\n— L\'équipe Adrien&Emily · Alteore';
  try {
    const r = await sendEmailFromAccount({
      accountKey: MAIL_ACCOUNT,
      to: email,
      subject: 'Votre accès à l\'espace équipe Alteore',
      bodyHtml: html,
      bodyText: text,
    });
    return { emailSent: !!(r && r.ok), emailError: r && r.ok ? null : ((r && r.error) || 'Envoi email échoué') };
  } catch (e) {
    return { emailSent: false, emailError: e.message || String(e) };
  }
}

// Email « accès ouvert » envoyé à l'activation.
async function sendActivatedEmail({ email, displayName }) {
  const fn = firstName(displayName);
  const link = BASE_URL + '/login.html';
  const html = mailShell(
    '<h2 style="color:#047857;margin:0 0 14px;font-size:20px">Votre accès est ouvert ✅</h2>' +
    '<p style="margin:0 0 12px">Bonjour' + (fn ? ' ' + escHtml(fn) : '') + ',</p>' +
    '<p style="margin:0 0 12px">Un administrateur vient d\'activer votre compte sur l\'espace équipe Alteore. Vous pouvez vous connecter dès maintenant avec <b>' + escHtml(email) + '</b> et le mot de passe que vous avez choisi.</p>' +
    button(link, 'Me connecter')
  );
  const text =
    'Bonjour ' + fn + ',\n\n' +
    'Votre compte sur l\'espace équipe Alteore est activé.\n' +
    'Connectez-vous avec ' + email + ' et le mot de passe que vous avez choisi :\n' + link +
    '\n\n— L\'équipe Adrien&Emily · Alteore';
  try {
    const r = await sendEmailFromAccount({
      accountKey: MAIL_ACCOUNT,
      to: email,
      subject: 'Votre accès à l\'espace équipe Alteore est ouvert',
      bodyHtml: html,
      bodyText: text,
    });
    return { emailSent: !!(r && r.ok), emailError: r && r.ok ? null : ((r && r.error) || 'Envoi email échoué') };
  } catch (e) {
    return { emailSent: false, emailError: e.message || String(e) };
  }
}

// Prévient l'admin qu'un compte attend son activation.
async function sendAdminPendingEmail({ uid, email, displayName, role }) {
  const link = BASE_URL + '/admin-users.html?activate=' + encodeURIComponent(uid);
  const name = displayName || email;
  const html = mailShell(
    '<h2 style="color:#b45309;margin:0 0 14px;font-size:20px">🔓 ' + escHtml(name) + ' attend son activation</h2>' +
    '<p style="margin:0 0 12px"><b>' + escHtml(name) + '</b> (' + escHtml(email) + (role ? ' · ' + escHtml(role) : '') + ') vient de choisir son mot de passe.</p>' +
    '<p style="margin:0 0 12px">Son compte reste verrouillé tant que vous ne l\'avez pas activé. Vérifiez ses droits dans sa fiche puis cliquez sur « Activer l\'accès ».</p>' +
    button(link, 'Ouvrir sa fiche')
  );
  const text =
    name + ' (' + email + ') vient de choisir son mot de passe et attend son activation.\n' +
    'Vérifiez ses droits puis activez son accès :\n' + link;
  try {
    const r = await sendEmailFromAccount({
      accountKey: MAIL_ACCOUNT,
      to: ADMIN_NOTIFY_EMAIL,
      subject: '🔓 ' + name + ' attend l\'activation de son accès',
      bodyHtml: html,
      bodyText: text,
    });
    return { emailSent: !!(r && r.ok), emailError: r && r.ok ? null : ((r && r.error) || 'Envoi email échoué') };
  } catch (e) {
    return { emailSent: false, emailError: e.message || String(e) };
  }
}

async function logAudit(data) {
  try {
    await db.collection('audit_log').add(Object.assign({}, data, {
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    }));
  } catch (e) {
    console.warn('[userInvite] audit log failed:', e.message);
  }
}

module.exports = {
  INVITE_TTL_MS,
  BASE_URL,
  hashToken,
  createInvite,
  readInvite,
  revokeOpenInvites,
  sendInviteEmail,
  sendActivatedEmail,
  sendAdminPendingEmail,
  logAudit,
};
