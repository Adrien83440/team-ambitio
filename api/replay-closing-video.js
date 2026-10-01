// ============================================================================
// api/replay-closing-video.js — flux vidéo d'un replay closing
// ----------------------------------------------------------------------------
// Relit l'enregistrement Meet dans le Drive du compte hôte et le sert par
// tranches (HTTP Range) à la balise <video> de admin-replay-closing.html.
// C'est ce qui permet le saut instantané au clic sur un chapitre : le lecteur
// Drive intégré n'expose aucune commande de lecture.
//
// La vidéo n'est JAMAIS copiée : chaque tranche est lue dans Drive à la
// demande, avec le compte « Meet Closing » (email_tokens/meet_closing).
//
// URL  : GET /api/replay-closing-video?id=<booking>&exp=<ms>&sig=<hmac>
// Auth : URL signée (HMAC-SHA256, clé CRON_SECRET) émise par
//        api/replay-closing.js?action=get pour un admin — une balise <video>
//        ne peut pas envoyer d'en-tête Authorization. Valable 6 h.
//
// Tranches de 4 Mo : sous la limite de taille de réponse Vercel, et chaque
// invocation reste courte. Le navigateur enchaîne les requêtes tout seul.
// ============================================================================

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const { getGoogle } = require('./_meetTranscript');
const { videoSig } = require('./replay-closing');

const CHUNK = 4 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const q = req.query || {};
  const id = String(q.id || '').trim();
  const exp = parseInt(q.exp, 10) || 0;
  if (!process.env.CRON_SECRET || !id || !exp || exp < Date.now() || !safeEqual(q.sig, videoSig(id, exp))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  try {
    const snap = await db.collection('bookings').doc(id).get();
    const rp = snap.exists ? ((snap.data() || {}).replay || {}) : {};
    const fileId = rp.videoFileId;
    const size = Number(rp.videoSize) || 0;
    if (!fileId || !size) { res.status(404).json({ error: 'video_not_found' }); return; }

    let start = 0, end = size - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - parseInt(m[2], 10));   // « les N derniers octets »
      } else {
        start = parseInt(m[1], 10) || 0;
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
      }
    }
    if (start >= size || start > end) {
      res.setHeader('Content-Range', 'bytes */' + size);
      res.status(416).end();
      return;
    }
    end = Math.min(end, start + CHUNK - 1);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', rp.videoMime || 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { res.status(206).end(); return; }

    const g = await getGoogle();
    const r = await g.drive.files.get(
      { fileId: fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer', headers: { Range: 'bytes=' + start + '-' + end } }
    );
    res.status(206).end(Buffer.from(r.data));
  } catch (e) {
    console.error('[replay-video]', id, e.message);
    if (!res.headersSent) res.removeHeader('Content-Length');
    res.status(e.statusCode || 502).json({ error: e.message || 'drive_error' });
  }
};
