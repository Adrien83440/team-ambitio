// ============================================================================
// api/replay-closing.js — module « Replay closing » (admin)
// ----------------------------------------------------------------------------
// Sert la page admin-replay-closing.html : liste des appels de closing avec
// le client rattaché, replay chapitré (vidéo + chapitres + transcription
// cliquable), édition des chapitres, import à la demande. Sert aussi de cron
// d'import nocturne.
//
// URL  : /api/replay-closing
// Auth : • Bearer <ID token Firebase> d'un ADMIN (page)
//        • Bearer <CRON_SECRET> ou x-api-key: <CRON_SECRET> (cron / curl)
//
// ─── ACTIONS (admin) ──────────────────────────────────────────────────────
//   GET  ?action=list&days=60      appels de closing passés de la fenêtre
//   GET  ?action=get&id=<booking>  replay complet (chapitres + transcription
//                                  + URL vidéo signée)
//   POST { action:'import', id }             importe / réimporte un appel
//   POST { action:'chapters', id, chapters } enregistre les chapitres édités
//   POST { action:'regen', id }              régénère les chapitres par l'IA
//
// ─── CRON (CRON_SECRET) ───────────────────────────────────────────────────
//   GET  (sans action, ou action=sync)   importe les appels pas encore traités
//     days=<n>  fenêtre en jours (défaut 7, cap 30 — Google purge à 30 jours)
//     dry=1     liste ce qui serait importé, n'écrit RIEN, n'appelle pas l'IA
//     max=<n>   nombre max d'appels traités par passage (défaut 6)
//   Tous les jours à 04:30 UTC (après meet-recordings-sync) — voir vercel.json.
//
//   curl -H "x-api-key: <CRON_SECRET>" \
//     "https://team.alteore.com/api/replay-closing?action=sync&days=30&dry=1"
//
// La logique d'import vit dans _meetTranscript.js ; la vidéo est servie par
// replay-closing-video.js (URL signée, valable 6 h).
// ============================================================================

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const MT = require('./_meetTranscript');

const QUERY_LIMIT = 1500;
const PAST_MARGIN_MS = 60 * 60000;  // le RDV doit être fini depuis ≥ 1 h
const VIDEO_TTL_MS = 6 * 3600000;
const SYNC_BUDGET_MS = 200000;      // on n'entame pas un import après ça

function parisTodayIso() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoAddDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function videoSig(id, exp) {
  return crypto.createHmac('sha256', String(process.env.CRON_SECRET || ''))
    .update('replay-video|' + id + '|' + exp).digest('hex');
}
function signedVideoUrl(id) {
  if (!process.env.CRON_SECRET) return null;
  const exp = Date.now() + VIDEO_TTL_MS;
  return '/api/replay-closing-video?id=' + encodeURIComponent(id) + '&exp=' + exp + '&sig=' + videoSig(id, exp);
}

function tsMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}

// Résumé d'un RDV pour la liste et l'en-tête du lecteur.
function bookingSummary(id, b) {
  const pr = b.prospect || {};
  const rp = b.replay || {};
  const fileId = rp.videoFileId || MT.driveFileIdFromUrl(b.meetRecordingUrl);
  return {
    id: id,
    date: b.date || null,
    time: b.time || null,
    duration: Number(b.duration) || null,
    clientName: MT.clientName(b),
    clientEmail: pr.email || null,
    leadId: b.leadId || null,
    closer: b.personName || b.expertName || null,
    typeLabel: b.typeLabel || b.type || null,
    outcome: b.outcome || null,
    status: b.status || 'confirmed',
    hasVideo: !!fileId,
    hasMeetLink: !!MT.meetCodeFromLink(b.meetLink),
    replayStatus: rp.status || null,
    replayReason: rp.reason || null,
    durationSec: rp.durationSec || null,
    entriesCount: rp.entriesCount || 0,
    chaptersCount: (rp.chapters || []).length,
    importedAt: tsMs(rp.importedAt),
  };
}

async function closingBookings(days) {
  const todayIso = parisTodayIso();
  const startIso = isoAddDays(todayIso, -days);
  const snap = await db.collection('bookings')
    .where('date', '>=', startIso)
    .where('date', '<=', todayIso)
    .limit(QUERY_LIMIT)
    .get();
  const typeMap = await MT.loadTypeMap();
  const nowMs = Date.now();
  const out = [];
  snap.forEach(function (doc) {
    const b = doc.data() || {};
    if (!MT.isClosingBooking(b, typeMap)) return;
    if (MT.bookingEndMs(b) + PAST_MARGIN_MS > nowMs) return;
    out.push({ id: doc.id, b: b });
  });
  return { list: out, from: startIso, to: todayIso, truncated: snap.size >= QUERY_LIMIT };
}

// ─── Actions admin ───────────────────────────────────────────────────────
async function actionList(req, res) {
  const days = Math.min(Math.max(parseInt((req.query || {}).days, 10) || 60, 1), 365);
  const r = await closingBookings(days);
  const items = [];
  r.list.forEach(function (x) {
    const s = bookingSummary(x.id, x.b);
    // Un RDV annulé / no-show sans aucune trace d'enregistrement n'a rien à
    // montrer : on l'écarte pour ne garder que les appels réellement tenus.
    const st = x.b.status || 'confirmed';
    const held = st === 'confirmed' || st === 'completed';
    if (!held && !s.hasVideo && s.replayStatus !== 'ready') return;
    items.push(s);
  });
  items.sort(function (a, b) {
    const ka = (a.date || '') + ' ' + (a.time || ''), kb = (b.date || '') + ' ' + (b.time || '');
    return ka < kb ? 1 : (ka > kb ? -1 : 0);
  });
  const conn = await MT.connectionStatus();
  res.status(200).json({
    ok: true, items: items, window: { from: r.from, to: r.to }, truncated: r.truncated,
    google: conn, aiReady: !!process.env.ANTHROPIC_API_KEY,
  });
}

async function loadBooking(id) {
  const snap = await db.collection('bookings').doc(id).get();
  return snap.exists ? (snap.data() || {}) : null;
}

async function actionGet(req, res) {
  const id = String((req.query || {}).id || '').trim();
  if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
  const b = await loadBooking(id);
  if (!b) { res.status(404).json({ ok: false, error: 'booking_not_found' }); return; }
  const rp = b.replay || {};
  const fileId = rp.videoFileId || MT.driveFileIdFromUrl(b.meetRecordingUrl);
  const entries = rp.status === 'ready' ? await MT.readEntries(id, rp.chunks) : [];
  res.status(200).json({
    ok: true,
    booking: bookingSummary(id, b),
    replay: {
      status: rp.status || null,
      reason: rp.reason || null,
      summary: rp.summary || '',
      chapters: rp.chapters || [],
      chaptersEdited: !!rp.chaptersEditedAt,
      chaptersError: rp.chaptersError || null,
      speakers: rp.speakers || [],
      durationSec: rp.durationSec || null,
      videoError: rp.videoError || null,
    },
    entries: entries,
    video: {
      fileId: fileId || null,
      // Flux natif (saut instantané) : seulement si le compte Google connecté
      // a pu lire le fichier à l'import.
      streamUrl: fileId && rp.videoSize ? signedVideoUrl(id) : null,
      driveUrl: fileId ? 'https://drive.google.com/file/d/' + fileId + '/view' : (b.meetRecordingUrl || null),
    },
  });
}

async function actionImport(req, res, body) {
  const id = String(body.id || '').trim();
  if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
  const b = await loadBooking(id);
  if (!b) { res.status(404).json({ ok: false, error: 'booking_not_found' }); return; }
  const r = await MT.importBooking(id, b, {});
  res.status(200).json({ ok: true, result: r });
}

async function actionChapters(req, res, body, auth) {
  const id = String(body.id || '').trim();
  if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
  const b = await loadBooking(id);
  if (!b) { res.status(404).json({ ok: false, error: 'booking_not_found' }); return; }
  const rp = b.replay || {};
  const chapters = MT.cleanChapters(body.chapters, rp.durationSec);
  await db.collection('bookings').doc(id).set({ replay: {
    chapters: chapters,
    chaptersEditedAt: admin.firestore.FieldValue.serverTimestamp(),
    chaptersEditedBy: auth.uid,
  } }, { merge: true });
  res.status(200).json({ ok: true, chapters: chapters });
}

async function actionRegen(req, res, body) {
  const id = String(body.id || '').trim();
  if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
  const b = await loadBooking(id);
  if (!b) { res.status(404).json({ ok: false, error: 'booking_not_found' }); return; }
  const rp = b.replay || {};
  if (rp.status !== 'ready') { res.status(409).json({ ok: false, error: 'no_transcript' }); return; }
  const entries = await MT.readEntries(id, rp.chunks);
  if (!entries.length) { res.status(409).json({ ok: false, error: 'no_transcript' }); return; }
  const ai = await MT.generateChapters(entries, rp.speakers || [], {
    closer: b.personName || b.expertName || '', client: MT.clientName(b), durationSec: rp.durationSec,
  });
  // Les chapitres remplacés restent en base (chaptersPrev) : une régénération
  // ne fait jamais perdre un découpage retouché à la main.
  await db.collection('bookings').doc(id).set({ replay: {
    summary: ai.summary, chapters: ai.chapters, chaptersAi: ai.chapters,
    chaptersPrev: rp.chapters || [],
    chaptersModel: ai.model,
    chaptersGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    chaptersEditedAt: null, chaptersEditedBy: null, chaptersError: null,
  } }, { merge: true });
  res.status(200).json({ ok: true, summary: ai.summary, chapters: ai.chapters });
}

// ─── Cron : import des appels pas encore traités ─────────────────────────
async function actionSync(req, res) {
  const q = req.query || {};
  const days = Math.min(Math.max(parseInt(q.days, 10) || 7, 1), 30);
  const dry = q.dry === '1' || q.dry === 'true';
  const max = Math.min(Math.max(parseInt(q.max, 10) || 6, 1), 25);
  const started = Date.now();

  const r = await closingBookings(days);
  const out = {
    ok: true, dry: dry, window: { from: r.from, to: r.to },
    closings: r.list.length, eligible: 0, processed: 0,
    ready: 0, videoOnly: 0, pending: 0, none: 0, remaining: 0, errors: [], items: [],
  };

  const todo = r.list.filter(function (x) {
    const b = x.b;
    const st = b.status || 'confirmed';
    if (st !== 'confirmed' && st !== 'completed') return false;
    const rp = b.replay || {};
    if (rp.status === 'ready' || rp.status === 'video_only' || rp.status === 'none') return false;
    if ((Number(rp.checks) || 0) >= MT.MAX_CHECKS) return false;
    return !!(MT.meetCodeFromLink(b.meetLink) || b.meetRecordingUrl);
  });
  out.eligible = todo.length;
  if (!todo.length) { res.status(200).json(out); return; }

  let g;
  try { g = await MT.getGoogle(); }
  catch (e) {
    out.ok = false;
    out.error = e.message;
    res.status(200).json(out);
    return;
  }

  for (const item of todo) {
    if (out.processed >= max || Date.now() - started > SYNC_BUDGET_MS) break;
    out.processed++;
    try {
      const x = await MT.importBooking(item.id, item.b, { dry: dry, google: g });
      out.items.push({
        id: item.id, date: item.b.date, client: MT.clientName(item.b),
        status: x.status, reason: x.reason || null, entries: x.entries || 0, chapters: x.chapters || 0,
      });
      if (x.status === 'ready') out.ready++;
      else if (x.status === 'video_only') out.videoOnly++;
      else if (x.status === 'pending') out.pending++;
      else out.none++;
      if (x.chaptersError) out.errors.push({ id: item.id, error: 'chapitres: ' + x.chaptersError });
    } catch (e) {
      console.error('[replay-sync]', item.id, e.message);
      out.errors.push({ id: item.id, error: e.message });
    }
  }
  out.remaining = todo.length - out.processed;
  res.status(200).json(out);
}

// ─── Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  const isCron = !!secret && (authHeader === 'Bearer ' + secret || req.headers['x-api-key'] === secret);

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
    catch (_) { body = {}; }
  }
  const action = String((req.query || {}).action || body.action || '').trim();

  try {
    if (isCron) {
      if (action && action !== 'sync') { res.status(400).json({ ok: false, error: 'cron_sync_only' }); return; }
      await actionSync(req, res);
      return;
    }

    const auth = await requireAdmin(req, res);
    if (!auth) return;

    if (req.method === 'GET' && action === 'list') { await actionList(req, res); return; }
    if (req.method === 'GET' && action === 'get') { await actionGet(req, res); return; }
    if (req.method === 'POST' && action === 'import') { await actionImport(req, res, body); return; }
    if (req.method === 'POST' && action === 'chapters') { await actionChapters(req, res, body, auth); return; }
    if (req.method === 'POST' && action === 'regen') { await actionRegen(req, res, body); return; }
    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[replay-closing]', action, e);
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e), code: e.code || null });
  }
};

module.exports.videoSig = videoSig;
