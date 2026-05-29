/**
 * api/_billing-gmail.js
 *
 * Envoi d'emails via l'API Gmail avec OAuth (compte stocké dans
 * email_tokens/{slug}). Refresh automatique du access token si expiré.
 *
 * Utilisé par invoice-send-email.js. Indépendant de tout module existant
 * du repo — refacto possible plus tard si tu veux partager avec d'autres
 * Vercel Functions.
 *
 * Configuration requise pour le refresh OAuth :
 *   - Soit dans _config/google_oauth Firestore avec { clientId, clientSecret }
 *   - Soit env vars GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
 *   - L'un ou l'autre, le module détecte automatiquement
 *
 * Format attendu de email_tokens/{slug} :
 *   {
 *     email: "contact@adrienemily.com",
 *     accessToken: "ya29.xxx",
 *     refreshToken: "1//xxx",
 *     expiresAt: <Timestamp ou ISO string>
 *   }
 */

const { admin, db } = require('./_billing-helpers');

/* ─── OAuth credentials lookup ─── */
async function getOAuthCreds() {
  /* Priority 1 : env vars */
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    };
  }
  /* Priority 2 : Firestore _config — même source que le helper _gmailSend qui
     fonctionne déjà (emails de mandat). On essaie plusieurs docs et on accepte
     aussi bien snake_case (client_id/client_secret) que camelCase
     (clientId/clientSecret). */
  const tries = ['oauth', 'oauth_calendar', 'google_oauth'];
  for (let i = 0; i < tries.length; i++) {
    try {
      const snap = await db.collection('_config').doc(tries[i]).get();
      if (snap.exists) {
        const d = snap.data();
        if (d.client_id && d.client_secret) {
          return { clientId: d.client_id, clientSecret: d.client_secret };
        }
        if (d.clientId && d.clientSecret) {
          return { clientId: d.clientId, clientSecret: d.clientSecret };
        }
      }
    } catch (e) { /* doc suivant */ }
  }

  const e = new Error('Google OAuth credentials introuvables (_config/oauth, _config/oauth_calendar ou _config/google_oauth — besoin client_id + client_secret)');
  e.status = 500;
  throw e;
}

/* ─── Refresh access token Google ─── */
async function refreshAccessToken(refreshToken, creds) {
  const params = new URLSearchParams();
  params.append('client_id', creds.clientId);
  params.append('client_secret', creds.clientSecret);
  params.append('refresh_token', refreshToken);
  params.append('grant_type', 'refresh_token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    const e = new Error('Token refresh failed: ' + errText.substring(0, 300));
    e.status = 502;
    throw e;
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 3600,
  };
}

/* ─── Récupérer un access token valide ─── */
async function getValidAccessToken(tokenSlug) {
  const ref = db.collection('email_tokens').doc(tokenSlug);
  const snap = await ref.get();
  if (!snap.exists) {
    const e = new Error('email_tokens/' + tokenSlug + ' introuvable');
    e.status = 500;
    throw e;
  }
  const data = snap.data();
  if (!data.refreshToken) {
    const e = new Error('refreshToken manquant pour ' + tokenSlug);
    e.status = 500;
    throw e;
  }

  /* Vérifier expiration */
  let expiresAtMs = 0;
  if (data.expiresAt) {
    if (data.expiresAt.toMillis) expiresAtMs = data.expiresAt.toMillis();
    else if (typeof data.expiresAt === 'string') expiresAtMs = new Date(data.expiresAt).getTime();
    else if (typeof data.expiresAt === 'number') expiresAtMs = data.expiresAt;
  }

  /* On refresh si expiré ou dans les 60 prochaines secondes */
  const now = Date.now();
  if (data.accessToken && expiresAtMs && expiresAtMs > now + 60000) {
    return { accessToken: data.accessToken, email: data.email };
  }

  /* Refresh */
  const creds = await getOAuthCreds();
  const refreshed = await refreshAccessToken(data.refreshToken, creds);
  const newExpiresAt = new Date(now + (refreshed.expiresIn * 1000));

  await ref.update({
    accessToken: refreshed.accessToken,
    expiresAt: admin.firestore.Timestamp.fromDate(newExpiresAt),
    lastRefreshedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { accessToken: refreshed.accessToken, email: data.email };
}

/* ─── MIME builder ─── */

/**
 * Encode une chaîne en base64url (Gmail API attend ce format).
 */
function base64UrlEncode(buffer) {
  const b64 = (typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encode "RFC 2047" pour les headers (sujet, nom expéditeur) avec accents.
 */
function encodeRfc2047(str) {
  if (!str) return '';
  /* Si pure ASCII, pas besoin d'encoder */
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

/**
 * Convertit du texte simple en HTML basique (saut de ligne préservés).
 */
function plainToHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\r?\n/)
    .map(function(line){ return '<p style="margin:0 0 12px 0;">' + (line.trim() ? line : '&nbsp;') + '</p>'; })
    .join('\n');
}

/**
 * Construit le message MIME multipart avec pièce jointe.
 *
 * @param {object} args
 *   from        : "Adrien & Emily <contact@adrienemily.com>"
 *   to          : ["client@example.com", ...]
 *   cc          : array
 *   bcc         : array
 *   subject     : string
 *   bodyText    : plain text
 *   bodyHtml    : HTML (optionnel, dérivé de bodyText si absent)
 *   attachments : [{ filename, contentBytes (Buffer), contentType }]
 */
function buildMime(args) {
  const boundaryMixed = 'mixed_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  const boundaryAlt = 'alt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);

  const headers = [];
  headers.push('From: ' + args.from);
  headers.push('To: ' + (args.to || []).join(', '));
  if (args.cc && args.cc.length) headers.push('Cc: ' + args.cc.join(', '));
  if (args.bcc && args.bcc.length) headers.push('Bcc: ' + args.bcc.join(', '));
  headers.push('Subject: ' + encodeRfc2047(args.subject || ''));
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: multipart/mixed; boundary="' + boundaryMixed + '"');

  let body = headers.join('\r\n') + '\r\n\r\n';

  /* Multipart alternative (text + html) */
  body += '--' + boundaryMixed + '\r\n';
  body += 'Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"\r\n\r\n';

  /* Plain text */
  body += '--' + boundaryAlt + '\r\n';
  body += 'Content-Type: text/plain; charset="UTF-8"\r\n';
  body += 'Content-Transfer-Encoding: base64\r\n\r\n';
  body += Buffer.from(args.bodyText || '', 'utf8').toString('base64') + '\r\n';

  /* HTML */
  body += '--' + boundaryAlt + '\r\n';
  body += 'Content-Type: text/html; charset="UTF-8"\r\n';
  body += 'Content-Transfer-Encoding: base64\r\n\r\n';
  const htmlContent = args.bodyHtml || plainToHtml(args.bodyText || '');
  body += Buffer.from(htmlContent, 'utf8').toString('base64') + '\r\n';

  body += '--' + boundaryAlt + '--\r\n';

  /* Pièces jointes */
  if (args.attachments && args.attachments.length) {
    for (let i = 0; i < args.attachments.length; i++) {
      const att = args.attachments[i];
      body += '--' + boundaryMixed + '\r\n';
      body += 'Content-Type: ' + (att.contentType || 'application/octet-stream') + '; name="' + att.filename + '"\r\n';
      body += 'Content-Disposition: attachment; filename="' + att.filename + '"\r\n';
      body += 'Content-Transfer-Encoding: base64\r\n\r\n';
      /* Découpe en lignes de 76 chars (RFC 2045) */
      const b64 = att.contentBytes.toString('base64');
      const lines = [];
      for (let j = 0; j < b64.length; j += 76) lines.push(b64.substring(j, j + 76));
      body += lines.join('\r\n') + '\r\n';
    }
  }

  body += '--' + boundaryMixed + '--\r\n';

  return body;
}

/* ─── Envoi Gmail API ─── */

/**
 * Envoie un email via l'API Gmail.
 *
 * @param {object} args
 *   tokenAccount : slug du email_tokens (ex: 'contact')
 *   fromName     : nom expéditeur (ex: 'Adrien & Emily')
 *   to           : array d'emails
 *   cc           : array (optionnel)
 *   bcc          : array (optionnel)
 *   subject      : string
 *   bodyText     : string
 *   bodyHtml     : string (optionnel)
 *   attachments  : [{ filename, contentBytes (Buffer), contentType }]
 *
 * @returns {Promise<{ messageId, threadId }>}
 */
async function sendGmailWithAttachment(args) {
  const tokenInfo = await getValidAccessToken(args.tokenAccount || 'contact');
  const fromAddr = tokenInfo.email || 'contact@adrienemily.com';
  const fromHeader = (args.fromName ? encodeRfc2047(args.fromName) + ' <' + fromAddr + '>' : fromAddr);

  const mime = buildMime({
    from: fromHeader,
    to: args.to || [],
    cc: args.cc || [],
    bcc: args.bcc || [],
    subject: args.subject || '',
    bodyText: args.bodyText || '',
    bodyHtml: args.bodyHtml || '',
    attachments: args.attachments || [],
  });

  const raw = base64UrlEncode(Buffer.from(mime, 'utf8'));

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + tokenInfo.accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: raw }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const e = new Error('Gmail send failed (' + response.status + '): ' + errText.substring(0, 500));
    e.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw e;
  }

  const data = await response.json();
  return { messageId: data.id || null, threadId: data.threadId || null };
}

module.exports = {
  sendGmailWithAttachment: sendGmailWithAttachment,
  getValidAccessToken: getValidAccessToken,
  encodeRfc2047: encodeRfc2047,
  plainToHtml: plainToHtml,
};
