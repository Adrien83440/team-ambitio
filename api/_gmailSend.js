// ==========================================================================
// api/_gmailSend.js
// --------------------------------------------------------------------------
// Helper interne (NON exposé comme endpoint) pour envoyer un email via
// l'API Gmail en utilisant un compte OAuth déjà connecté côté Ambitio.
//
// Comptes disponibles : 'strategie', 'coaching', 'contact'
// (correspond aux clés dans Firestore : email_tokens/{accountKey})
//
// Le helper gère :
//   - Lecture des tokens (access + refresh) depuis Firestore
//   - Refresh automatique de l'access_token si expiré (401)
//   - Encodage du message au format MIME base64url attendu par Gmail
//   - Update du token rafraîchi dans Firestore (pour les prochains appels)
//
// Pré-requis :
//   - Doc _config/oauth (ou _config/oauth_calendar) contenant client_id +
//     client_secret Google Cloud Console (OAuth 2.0)
//   - Doc email_tokens/{accountKey} avec accessToken + refreshToken + email
//   - Scope OAuth "https://www.googleapis.com/auth/gmail.send" accordé
//
// Usage :
//   const { sendEmailFromAccount } = require('./_gmailSend');
//   await sendEmailFromAccount({
//     accountKey: 'strategie',
//     to: 'prospect@example.com',
//     subject: 'Confirmation de votre RDV',
//     bodyHtml: '<p>Bonjour…</p>',
//     bodyText: 'Bonjour…' // fallback texte (optionnel)
//   });
// ==========================================================================

const { db } = require('./_firebaseAdmin');

// Récupère client_id + client_secret depuis _config (essaie oauth puis oauth_calendar)
async function loadOauthConfig() {
  const tries = ['oauth', 'oauth_calendar'];
  for (const docId of tries) {
    const snap = await db.collection('_config').doc(docId).get();
    if (snap.exists) {
      const d = snap.data();
      if (d.client_id && d.client_secret) {
        return { clientId: d.client_id, clientSecret: d.client_secret };
      }
      if (d.clientId && d.clientSecret) {
        return { clientId: d.clientId, clientSecret: d.clientSecret };
      }
    }
  }
  throw new Error('OAuth config introuvable dans _config/oauth ou _config/oauth_calendar (besoin client_id + client_secret)');
}

// Récupère les tokens Gmail pour un compte
async function loadAccountTokens(accountKey) {
  const snap = await db.collection('email_tokens').doc(accountKey).get();
  if (!snap.exists) {
    throw new Error('Compte email non connecté : ' + accountKey + ' (connecte via admin-email-auth.html)');
  }
  const d = snap.data();
  if (!d.refreshToken) {
    throw new Error('refreshToken manquant pour le compte ' + accountKey + ' (reconnecte via admin-email-auth.html)');
  }
  return {
    accessToken: d.accessToken || null,
    refreshToken: d.refreshToken,
    email: d.email || null,
  };
}

// Refresh access_token via Google OAuth
async function refreshAccessToken(accountKey, refreshToken, oauth) {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Refresh token Gmail failed pour ' + accountKey + ' : ' + JSON.stringify(data));
  }
  // Sauvegarde le nouveau access_token
  await db.collection('email_tokens').doc(accountKey).set({
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
    accessTokenRefreshedAt: new Date(),
  }, { merge: true });
  return data.access_token;
}

// Encode une chaîne en base64url (Gmail API)
function base64url(str) {
  return Buffer.from(str, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Construit le message MIME (RFC 822)
function buildMime({ from, to, subject, bodyHtml, bodyText, replyTo }) {
  const boundary = '----=_Boundary_' + Math.random().toString(36).substring(2);
  // Subject doit être encodé si contient non-ASCII
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';

  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodedSubject,
    'MIME-Version: 1.0',
  ];
  if (replyTo) headers.push('Reply-To: ' + replyTo);

  if (bodyHtml && bodyText) {
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    const body =
      '\r\n--' + boundary + '\r\n' +
      'Content-Type: text/plain; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: 7bit\r\n\r\n' +
      bodyText + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: 7bit\r\n\r\n' +
      bodyHtml + '\r\n' +
      '--' + boundary + '--';
    return headers.join('\r\n') + '\r\n' + body;
  } else if (bodyHtml) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 7bit');
    return headers.join('\r\n') + '\r\n\r\n' + bodyHtml;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 7bit');
    return headers.join('\r\n') + '\r\n\r\n' + (bodyText || '');
  }
}

// Envoie un email via Gmail API
async function gmailApiSend(accessToken, mimeMessage) {
  const raw = base64url(mimeMessage);
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: raw }),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data: data };
}

/**
 * sendEmailFromAccount — envoie un email depuis un compte Gmail OAuth.
 *
 * @param {Object} params
 * @param {string} params.accountKey — 'strategie' | 'coaching' | 'contact'
 * @param {string} params.to — adresse destinataire
 * @param {string} params.subject — sujet
 * @param {string} [params.bodyHtml] — HTML body (recommandé)
 * @param {string} [params.bodyText] — texte brut (fallback / multipart)
 * @param {string} [params.replyTo] — adresse de réponse (optionnel)
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendEmailFromAccount({ accountKey, to, subject, bodyHtml, bodyText, replyTo }) {
  if (!accountKey || !to || !subject) {
    throw new Error('sendEmailFromAccount : accountKey, to et subject sont requis');
  }
  if (!bodyHtml && !bodyText) {
    throw new Error('sendEmailFromAccount : bodyHtml ou bodyText requis');
  }

  const oauth = await loadOauthConfig();
  const tokens = await loadAccountTokens(accountKey);
  const fromAddr = tokens.email || (accountKey + '@adrienemily.com');

  // Tente envoi avec l'access_token courant
  let accessToken = tokens.accessToken;
  let needsRefresh = !accessToken;

  if (!needsRefresh) {
    const mime = buildMime({ from: fromAddr, to, subject, bodyHtml, bodyText, replyTo });
    const result = await gmailApiSend(accessToken, mime);
    if (result.ok) {
      return { ok: true, messageId: result.data.id, from: fromAddr };
    }
    if (result.status === 401) {
      needsRefresh = true;
    } else {
      return { ok: false, error: 'Gmail API ' + result.status + ' : ' + JSON.stringify(result.data) };
    }
  }

  // Refresh + retry
  if (needsRefresh) {
    accessToken = await refreshAccessToken(accountKey, tokens.refreshToken, oauth);
    const mime = buildMime({ from: fromAddr, to, subject, bodyHtml, bodyText, replyTo });
    const result = await gmailApiSend(accessToken, mime);
    if (result.ok) {
      return { ok: true, messageId: result.data.id, from: fromAddr };
    }
    return { ok: false, error: 'Gmail API ' + result.status + ' (after refresh) : ' + JSON.stringify(result.data) };
  }

  return { ok: false, error: 'Unknown send failure' };
}

module.exports = { sendEmailFromAccount };
