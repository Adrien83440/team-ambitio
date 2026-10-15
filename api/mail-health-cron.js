// ============================================================================
// api/mail-health-cron.js — CONTRÔLE HORAIRE DES COMPTES GOOGLE (15/10/2026)
// ----------------------------------------------------------------------------
// Toutes les heures, pour chaque document email_tokens/* (boîtes Gmail,
// accès Drive, Meet Closing), demande un access token à Google avec le
// refresh token stocké :
//   • invalid_grant → _mailHealth.markRevoked (registre _config/mail_health,
//     bandeau admin, email d'alerte une fois par incident) ;
//   • succès        → _mailHealth.markHealthy (efface l'incident s'il y en a).
// Le nouvel access token n'est PAS enregistré : chaque module garde sa propre
// gestion d'expiration (accessTokenExpiresAt, expiresAt…), on n'y touche pas.
// Les erreurs réseau / 5xx ne déclenchent rien (pas de fausse alerte).
//
// Indispensable parce que certains envois ne passent pas par api/ : les
// confirmations Booking partent des Cloud Functions (_abSendEmail), qui ne
// connaissent pas le registre. Le contrôle les couvre à l'heure près.
//
// GET  Bearer <CRON_SECRET>                → contrôle complet
// POST Bearer <ID token admin> { action:'run' } → idem, à la demande
//      (appelé par admin-email-auth.html juste après une reconnexion)
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { loadOauthConfig } = require('./_gmailSend');
const mailHealth = require('./_mailHealth');

async function checkOne(id, tok, oauth) {
  if (!tok.refreshToken) {
    await mailHealth.markRevoked(id, { error: 'refreshToken absent du document email_tokens/' + id, email: tok.email || '', source: 'cron' });
    return { key: id, status: 'revoked', error: 'no_refresh_token' };
  }
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: tok.refreshToken,
    grant_type: 'refresh_token',
  });
  let resp, data;
  try {
    resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    try { data = await resp.json(); } catch (e) { data = {}; }
  } catch (e) {
    return { key: id, status: 'unknown', error: e.message };
  }
  if (resp.ok && data.access_token) {
    const restored = await mailHealth.markHealthy(id);
    return { key: id, status: 'ok', restored: restored };
  }
  if (mailHealth.isRevokedResponse(data)) {
    await mailHealth.markRevoked(id, {
      error: JSON.stringify(data),
      email: tok.email || '',
      source: 'cron',
      lastSuccessAt: tok.accessTokenRefreshedAt || tok.lastRefreshedAt || tok.connectedAt || null,
    });
    return { key: id, status: 'revoked', error: data.error_description || data.error };
  }
  return { key: id, status: 'unknown', error: 'HTTP ' + resp.status + ' ' + JSON.stringify(data).slice(0, 200) };
}

async function run() {
  const oauth = await loadOauthConfig();
  const snap = await db.collection('email_tokens').get();
  const results = [];
  for (let i = 0; i < snap.docs.length; i++) {
    const d = snap.docs[i];
    try {
      results.push(await checkOne(d.id, d.data() || {}, oauth));
    } catch (e) {
      results.push({ key: d.id, status: 'unknown', error: e.message });
    }
  }
  return { checked: results.length, results: results };
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.status(200).json(Object.assign({ ok: true }, await run())); } catch (e) { console.error('[mail-health-cron]', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  if (body.action !== 'run') { res.status(400).json({ ok: false, error: 'unknown_action' }); return; }
  try { res.status(200).json(Object.assign({ ok: true }, await run())); } catch (e) { console.error('[mail-health-cron]', e); res.status(500).json({ ok: false, error: e.message }); }
};
