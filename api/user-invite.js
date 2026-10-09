// ============================================================================
// api/user-invite.js — invitations des comptes équipe (09/10/2026)
// ----------------------------------------------------------------------------
// POST { action, ... }
//
// Actions ADMIN (Authorization: Bearer <idToken>, role admin) :
//   create   { email, displayName, role, modules }
//            → compte Auth créé DÉSACTIVÉ (sans mot de passe), users/{uid}
//              status 'invited', email d'invitation depuis strategie@.
//            → { ok, uid, link, expiresAt, emailSent, emailError }
//   resend   { uid }   → nouveau lien (l'ancien est révoqué), même retour
//   activate { uid }   → compte Auth réactivé, status 'active', email
//                        « accès ouvert » si un mot de passe a été choisi
//
// Actions PUBLIQUES (jeton d'invitation) :
//   check       { token }            → { ok, state, displayName, email }
//   setPassword { token, password }  → mot de passe posé, status
//              'pending_activation', admins prévenus (email + pop-up)
//
// Détails du parcours et du stockage des jetons : api/_userInvite.js.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const inv = require('./_userInvite');

const ROLES = ['coach', 'sales', 'csm', 'admin'];
const MIN_PASSWORD_LENGTH = 8;

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function cleanModules(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  Object.keys(m).forEach(function (k) {
    if (/^[a-z_]{1,40}$/.test(k) && ['none', 'read', 'edit'].indexOf(m[k]) >= 0) out[k] = m[k];
  });
  return out;
}

async function handleCreate(req, res, auth, body) {
  const email = normalizeEmail(body.email);
  const displayName = String(body.displayName || '').trim().slice(0, 120) || email.split('@')[0];
  const role = ROLES.indexOf(body.role) >= 0 ? body.role : 'coach';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 250) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email: email, displayName: displayName, disabled: true });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    if (e.code === 'auth/invalid-email') return res.status(400).json({ error: 'Email invalide' });
    console.error('[user-invite] createUser failed:', e);
    return res.status(500).json({ error: 'Création du compte impossible : ' + e.message });
  }
  const uid = userRecord.uid;

  const nowIso = new Date().toISOString();
  await db.collection('users').doc(uid).set({
    email: email,
    displayName: displayName,
    role: role,
    status: 'invited',
    modules: cleanModules(body.modules),
    createdAt: nowIso,
    createdBy: auth.uid,
    invitedAt: nowIso,
    invitedBy: auth.uid,
  });

  const invite = await inv.createInvite({ uid: uid, email: email, displayName: displayName, createdBy: auth.uid });
  const mail = await inv.sendInviteEmail({ email: email, displayName: displayName, link: invite.link });

  await inv.logAudit({
    action: 'user_invited',
    actorUid: auth.uid,
    actorEmail: auth.email || null,
    targetUid: uid,
    targetEmail: email,
    success: true,
    error: mail.emailSent ? null : 'Email failed: ' + mail.emailError,
  });

  return res.status(200).json({
    ok: true,
    uid: uid,
    link: invite.link,
    expiresAt: invite.expiresAt.toISOString(),
    emailSent: mail.emailSent,
    emailError: mail.emailError,
  });
}

async function handleResend(req, res, auth, body) {
  const uid = String(body.uid || '');
  if (!uid) return res.status(400).json({ error: 'uid manquant' });
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const u = snap.data() || {};
  if (u.status !== 'invited') {
    return res.status(409).json({ error: 'Ce compte n\'est plus en attente d\'invitation (statut : ' + (u.status || 'actif') + ')' });
  }
  let authUser;
  try { authUser = await admin.auth().getUser(uid); } catch (e) {
    return res.status(404).json({ error: 'Compte Auth introuvable' });
  }
  const email = authUser.email || u.email;
  const displayName = u.displayName || authUser.displayName || '';

  const invite = await inv.createInvite({ uid: uid, email: email, displayName: displayName, createdBy: auth.uid });
  const mail = await inv.sendInviteEmail({ email: email, displayName: displayName, link: invite.link });
  await db.collection('users').doc(uid).update({ invitedAt: new Date().toISOString(), invitedBy: auth.uid });

  await inv.logAudit({
    action: 'user_invite_resent',
    actorUid: auth.uid,
    actorEmail: auth.email || null,
    targetUid: uid,
    targetEmail: email,
    success: true,
    error: mail.emailSent ? null : 'Email failed: ' + mail.emailError,
  });

  return res.status(200).json({
    ok: true,
    uid: uid,
    link: invite.link,
    expiresAt: invite.expiresAt.toISOString(),
    emailSent: mail.emailSent,
    emailError: mail.emailError,
  });
}

async function handleActivate(req, res, auth, body) {
  const uid = String(body.uid || '');
  if (!uid) return res.status(400).json({ error: 'uid manquant' });
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const u = snap.data() || {};
  const prevStatus = u.status || 'active';

  let authUser;
  try {
    authUser = await admin.auth().updateUser(uid, { disabled: false });
  } catch (e) {
    console.error('[user-invite] activate failed:', e);
    return res.status(500).json({ error: 'Activation impossible : ' + e.message });
  }

  await db.collection('users').doc(uid).update({
    status: 'active',
    activatedAt: new Date().toISOString(),
    activatedBy: auth.uid,
  });

  // Email « accès ouvert » seulement si la personne a déjà choisi son mot de
  // passe. Si elle ne l'a pas encore fait (status 'invited'), son lien
  // d'invitation reste valable et suffit.
  let mail = { emailSent: false, emailError: null };
  if (prevStatus === 'pending_activation' || (prevStatus === 'invited' && u.passwordSetAt)) {
    mail = await inv.sendActivatedEmail({ email: authUser.email || u.email, displayName: u.displayName || authUser.displayName });
  }

  await inv.logAudit({
    action: 'user_activated',
    actorUid: auth.uid,
    actorEmail: auth.email || null,
    targetUid: uid,
    targetEmail: authUser.email || u.email || null,
    previousStatus: prevStatus,
    success: true,
    error: mail.emailError ? 'Email failed: ' + mail.emailError : null,
  });

  return res.status(200).json({
    ok: true,
    previousStatus: prevStatus,
    passwordPending: prevStatus === 'invited' && !u.passwordSetAt,
    emailSent: mail.emailSent,
    emailError: mail.emailError,
  });
}

async function handleCheck(req, res, body) {
  const r = await inv.readInvite(body.token);
  if (r.state !== 'ok') return res.status(200).json({ ok: false, state: r.state });
  return res.status(200).json({
    ok: true,
    state: 'ok',
    displayName: r.data.displayName || '',
    email: r.data.email || '',
  });
}

async function handleSetPassword(req, res, body) {
  const pwd = body.password;
  if (typeof pwd !== 'string' || pwd.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins ' + MIN_PASSWORD_LENGTH + ' caractères' });
  }
  if (pwd.length > 4096) return res.status(400).json({ error: 'Mot de passe trop long' });

  const r = await inv.readInvite(body.token);
  if (r.state !== 'ok') return res.status(410).json({ ok: false, state: r.state });
  const uid = r.data.uid;

  try {
    await admin.auth().updateUser(uid, { password: pwd, emailVerified: true });
  } catch (e) {
    console.error('[user-invite] setPassword failed:', e);
    if (e.code === 'auth/invalid-password') return res.status(400).json({ error: 'Mot de passe refusé (trop faible)' });
    if (e.code === 'auth/user-not-found') return res.status(410).json({ ok: false, state: 'unknown' });
    return res.status(500).json({ error: 'Enregistrement impossible, réessayez dans un instant' });
  }

  await r.ref.update({ usedAt: admin.firestore.FieldValue.serverTimestamp() });

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const u = snap.exists ? (snap.data() || {}) : {};
  const nowIso = new Date().toISOString();
  // Un admin a pu activer le compte avant que la personne choisisse son mot
  // de passe : dans ce cas elle peut se connecter tout de suite.
  const alreadyActive = u.status === 'active';
  const patch = { passwordSetAt: nowIso };
  if (!alreadyActive) {
    patch.status = 'pending_activation';
    patch.activationRequestedAt = nowIso;
  }
  await userRef.set(patch, { merge: true });

  let mail = { emailSent: false, emailError: null };
  if (!alreadyActive) {
    mail = await inv.sendAdminPendingEmail({
      uid: uid,
      email: r.data.email || u.email,
      displayName: u.displayName || r.data.displayName,
      role: u.role,
    });
  }

  await inv.logAudit({
    action: 'user_invite_password_set',
    targetUid: uid,
    targetEmail: r.data.email || u.email || null,
    success: true,
    error: mail.emailError ? 'Admin email failed: ' + mail.emailError : null,
  });

  return res.status(200).json({
    ok: true,
    active: alreadyActive,
    displayName: u.displayName || r.data.displayName || '',
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = parseBody(req);
  const action = body.action;

  try {
    if (action === 'check') return await handleCheck(req, res, body);
    if (action === 'setPassword') return await handleSetPassword(req, res, body);

    if (action === 'create' || action === 'resend' || action === 'activate') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      if (action === 'create') return await handleCreate(req, res, auth, body);
      if (action === 'resend') return await handleResend(req, res, auth, body);
      return await handleActivate(req, res, auth, body);
    }
    return res.status(400).json({ error: 'Action inconnue : ' + action });
  } catch (e) {
    console.error('[user-invite] ' + action + ' error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
