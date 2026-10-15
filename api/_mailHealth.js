// ============================================================================
// api/_mailHealth.js — SANTÉ DES COMPTES GOOGLE CONNECTÉS (15/10/2026)
// ----------------------------------------------------------------------------
// Incident du 10/10/2026 : le refresh token de email_tokens/strategie a été
// révoqué côté Google (invalid_grant). Rien ne l'a signalé : pendant 5 jours,
// confirmations de RDV, mandats et invitations sont partis dans le vide, et
// on ne l'a vu qu'en créant un compte (erreur dans la pop-up).
//
// Ce helper tient un registre unique : _config/mail_health
//   { accounts: { <accountKey>: {
//       status: 'revoked',
//       email, error, source,            // dernier échec constaté
//       firstFailedAt, lastFailedAt,     // début de l'incident / dernier échec
//       alertSentAt, alertFrom,          // email d'alerte (une fois par incident)
//       alertAttemptAt                   // dernière tentative d'alerte
//   } } }
// Lecture admin seulement (règle _config/{docId}) ; écrit ici (Admin SDK).
//
//   markRevoked(key, detail) — à appeler sur un échec de refresh invalid_grant.
//       Pose l'entrée puis envoie UNE alerte à l'admin depuis une autre boîte
//       encore valide (coaching → contact → strategie).
//   markHealthy(key)         — à appeler sur un refresh réussi : efface
//       l'entrée si elle existe (lecture seule sinon, aucune écriture).
//   isRevokedResponse(x)     — vrai si la réponse Google est un invalid_grant.
//
// Seul invalid_grant est traité comme une révocation : une panne réseau ou
// un 5xx Google ne déclenche rien (pas de fausse alerte).
// Affichage : alteore-mail-health.js (bandeau admin) et admin-email-auth.html.
// Contrôle horaire de tous les comptes : api/mail-health-cron.js.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');

const HEALTH_REF = db.collection('_config').doc('mail_health');
const ADMIN_NOTIFY_EMAIL = 'contact@adrienemily.com';
const ALERT_FROM_ORDER = ['coaching', 'contact', 'strategie'];
const ALERT_RETRY_MS = 60 * 60 * 1000;
const BASE_URL = 'https://team.alteore.com';

// Ce qui s'arrête quand le compte est coupé — repris dans l'email d'alerte.
const IMPACTS = {
  strategie: 'confirmations et rappels de RDV Booking, emails de mandat GoCardless, emails aux leads, invitations et mots de passe de l\'équipe',
  coaching: 'emails aux clients coaching (replays, comptes rendus, séries de séances)',
  contact: 'envoi des factures et relevés, brouillons AlteoForms, notifications admin',
  meet_closing: 'transcriptions et enregistrements du Replay closing',
  drive_temoignages: 'import du mur de témoignages depuis Drive',
  drive_formations: 'import et partage des vidéos des formations internes',
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

// Accepte l'objet JSON de Google, le texte brut de la réponse ou un message
// d'erreur qui le contient.
function isRevokedResponse(x) {
  if (!x) return false;
  if (typeof x === 'object' && x.error === 'invalid_grant') return true;
  return /invalid_grant/.test(typeof x === 'string' ? x : JSON.stringify(x));
}

function parisLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' }) +
    ' à ' + d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
}

async function sendAlert(accountKey, entry, skip) {
  // Chargé ici et pas en tête : _gmailSend requiert déjà ce fichier.
  const { sendEmailFromAccount } = require('./_gmailSend');
  const who = entry.email || (accountKey + '@adrienemily.com');
  const since = parisLabel(toMs(entry.lastSuccessAt) || toMs(entry.firstFailedAt));
  const link = BASE_URL + '/admin-email-auth.html';
  const impact = IMPACTS[accountKey] || 'tout ce qui utilise ce compte Google';
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.55">' +
    '<h2 style="color:#b91c1c;margin:0 0 14px;font-size:20px">📭 ' + escHtml(who) + ' est déconnecté de Google</h2>' +
    '<p style="margin:0 0 12px">Google refuse désormais l\'accès de la plateforme au compte <b>' + escHtml(accountKey) + '</b> ' +
    '(accès révoqué ou expiré' + (since ? ', dernier fonctionnement connu le ' + escHtml(since) : '') + ').</p>' +
    '<p style="margin:0 0 12px"><b>Ce qui ne fonctionne plus :</b> ' + escHtml(impact) + '.</p>' +
    '<p style="margin:0 0 18px">Reconnectez le compte en vous identifiant avec <b>' + escHtml(who) + '</b> ' +
    'et en acceptant tous les accès demandés. Pensez ensuite à renvoyer ce qui n\'est pas parti.</p>' +
    '<a href="' + link + '" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#7c3aed;color:#fff;font-weight:700;text-decoration:none">Reconnecter le compte</a>' +
    '<p style="margin:18px 0 0;font-size:12px;color:#64748b">Détail technique : ' + escHtml(String(entry.error || '').slice(0, 300)) + '</p>' +
    '</div>';
  const text =
    who + ' est déconnecté de Google (accès révoqué ou expiré' + (since ? ', dernier fonctionnement connu le ' + since : '') + ').\n' +
    'Ce qui ne fonctionne plus : ' + impact + '.\n' +
    'Reconnectez le compte : ' + link;
  const order = ALERT_FROM_ORDER.filter(function (k) { return k !== accountKey && skip.indexOf(k) < 0; });
  for (let i = 0; i < order.length; i++) {
    try {
      const r = await sendEmailFromAccount({
        accountKey: order[i],
        to: ADMIN_NOTIFY_EMAIL,
        subject: '📭 ' + who + ' ne peut plus envoyer — à reconnecter',
        bodyHtml: html,
        bodyText: text,
        _healthAlert: true,
      });
      if (r && r.ok) return order[i];
    } catch (e) {
      console.warn('[mailHealth] alerte via ' + order[i] + ' impossible :', e.message);
    }
  }
  return null;
}

// detail : { error, email, source, lastSuccessAt, noAlert }
async function markRevoked(accountKey, detail) {
  if (!accountKey) return;
  const d = detail || {};
  let entry = null;
  let mustAlert = false;
  let flagged = [];
  try {
    await db.runTransaction(async function (tx) {
      const snap = await tx.get(HEALTH_REF);
      const accounts = (snap.exists && (snap.data() || {}).accounts) || {};
      const prev = accounts[accountKey] || null;
      const now = admin.firestore.Timestamp.now();
      flagged = Object.keys(accounts);
      entry = {
        status: 'revoked',
        email: d.email || (prev && prev.email) || '',
        error: String(d.error || '').slice(0, 500),
        source: d.source || '',
        firstFailedAt: (prev && prev.firstFailedAt) || now,
        lastFailedAt: now,
      };
      if (prev && prev.lastSuccessAt) entry.lastSuccessAt = prev.lastSuccessAt;
      else if (d.lastSuccessAt) entry.lastSuccessAt = d.lastSuccessAt;
      if (prev && prev.alertSentAt) {
        entry.alertSentAt = prev.alertSentAt;
        if (prev.alertFrom) entry.alertFrom = prev.alertFrom;
      } else if (!d.noAlert && (!prev || !prev.alertAttemptAt || now.toMillis() - toMs(prev.alertAttemptAt) > ALERT_RETRY_MS)) {
        entry.alertAttemptAt = now;
        mustAlert = true;
      } else if (prev && prev.alertAttemptAt) {
        entry.alertAttemptAt = prev.alertAttemptAt;
      }
      const upd = {};
      upd[accountKey] = entry;
      tx.set(HEALTH_REF, { accounts: upd, updatedAt: now }, { merge: true });
    });
  } catch (e) {
    console.warn('[mailHealth] markRevoked ' + accountKey + ' :', e.message);
    return;
  }
  if (!mustAlert) return;
  const from = await sendAlert(accountKey, entry, flagged);
  if (!from) return;
  try {
    const upd = {};
    upd[accountKey] = { alertSentAt: admin.firestore.FieldValue.serverTimestamp(), alertFrom: from };
    await HEALTH_REF.set({ accounts: upd }, { merge: true });
  } catch (e) {
    console.warn('[mailHealth] alertSentAt ' + accountKey + ' :', e.message);
  }
}

async function markHealthy(accountKey) {
  if (!accountKey) return false;
  try {
    const snap = await HEALTH_REF.get();
    const accounts = (snap.exists && (snap.data() || {}).accounts) || {};
    if (!accounts[accountKey]) return false;
    const incidentStartedAt = accounts[accountKey].firstFailedAt || null;
    const upd = {};
    upd[accountKey] = admin.firestore.FieldValue.delete();
    await HEALTH_REF.set({ accounts: upd, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await db.collection('audit_log').add({
      action: 'mail_health_restored',
      accountKey: accountKey,
      incidentStartedAt: incidentStartedAt,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn('[mailHealth] markHealthy ' + accountKey + ' :', e.message);
    return false;
  }
}

module.exports = { markRevoked, markHealthy, isRevokedResponse, IMPACTS };
