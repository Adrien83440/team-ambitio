// ============================================================================
// api/_meetTranscript.js — helper partagé du module « Replay closing »
// ----------------------------------------------------------------------------
// Importe, pour un RDV closing (bookings/{id}), la transcription HORODATÉE de
// Google Meet (API Meet v2 : texte + locuteur + début/fin de chaque segment),
// la recale sur le début de l'enregistrement vidéo, la stocke dans Firestore
// et fait découper l'appel en chapitres par l'IA.
//
// ─── POURQUOI COPIER DANS FIRESTORE ───────────────────────────────────────
// Google ne garde les segments que 30 JOURS après la réunion. Une fois copiés
// ici, le replay chapitré reste consultable sans limite. La VIDÉO, elle, n'est
// jamais copiée : elle reste dans le Drive du compte hôte et est relue à la
// demande par api/replay-closing-video.js.
//
// ─── COMPTE GOOGLE ────────────────────────────────────────────────────────
// email_tokens/{tokenKey}, connecté une fois depuis admin-email-auth.html
// (« Meet Closing »), avec le compte qui HÉBERGE les Meet de closing
// (strategie@adrienemily.com). tokenKey vient de _config/replay_closing.tokenKey
// (défaut 'meet_closing'). Scopes : meetings.space.readonly + drive.readonly.
// Compte séparé de email_tokens/strategie (Gmail) : on ne touche pas au token
// qui envoie les mails.
//
// ─── MODÈLE DE DONNÉES ────────────────────────────────────────────────────
// bookings/{id}.replay = {
//   status        'ready' | 'video_only' | 'pending' | 'none'
//   reason        motif court quand status !== 'ready'
//   checks        nombre de tentatives d'import
//   meetCode, conferenceRecord
//   videoFileId, videoSize, videoMime, durationSec
//   recordingStartMs   origine des temps (ms epoch)
//   entriesCount, chunks, speakers[]
//   summary, chapters[{ t, title, summary }]   (t en secondes)
//   chaptersAi[]       dernière proposition de l'IA (jamais éditée à la main)
//   chaptersModel, chaptersGeneratedAt, chaptersEditedAt, chaptersEditedBy
//   importedAt, checkedAt
// }
// bookings/{id}/replay_transcript/chunk_000… = { index, entries[{ s, e, p, t }] }
//   s/e = début/fin en secondes depuis recordingStartMs, p = index dans
//   speakers[], t = texte. Découpé pour rester sous la limite d'1 Mo par doc.
//   Sous-collection lue UNIQUEMENT via l'Admin SDK (api/replay-closing.js) :
//   aucune règle Firestore à ajouter.
//
// Variables Vercel : ANTHROPIC_API_KEY (déjà en place).
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');

const CFG_PATH = '_config/replay_closing';
const DEFAULT_TOKEN = 'meet_closing';
const MEET_API = 'https://meet.googleapis.com/v2/';
const CHUNK_CHARS = 500000;       // taille max d'un chunk de transcription
const MATCH_WINDOW_MS = 12 * 3600000; // écart max RDV ↔ conférence Meet
const GRACE_DAYS = 5;             // au-delà : on arrête de chercher
const MAX_CHECKS = 8;
const AI_MODEL = 'claude-opus-5';
const MIN_ENTRIES_FOR_AI = 12;

// ─── OAuth Google (même mécanique que formations-drive) ──────────────────
async function getOAuthConfig() {
  for (const id of ['oauth', 'oauth_calendar']) {
    try {
      const snap = await db.collection('_config').doc(id).get();
      if (snap.exists) {
        const d = snap.data() || {};
        const clientId = d.client_id || d.clientId;
        const clientSecret = d.client_secret || d.clientSecret;
        if (clientId && clientSecret) return { clientId, clientSecret };
      }
    } catch (_) { /* on essaie le suivant */ }
  }
  throw new Error('_config/oauth introuvable (besoin client_id + client_secret)');
}

async function resolveTokenKey() {
  let key = DEFAULT_TOKEN;
  try {
    const cfg = await db.doc(CFG_PATH).get();
    if (cfg.exists && cfg.data().tokenKey) key = String(cfg.data().tokenKey);
  } catch (_) { /* config absente : défaut */ }
  return key;
}

// Retourne { auth, drive, tokenKey, email } ou lève une erreur 503 lisible.
async function getGoogle() {
  const key = await resolveTokenKey();
  const snap = await db.collection('email_tokens').doc(key).get();
  const tok = snap.exists ? (snap.data() || {}) : null;
  if (!tok || !tok.refreshToken) {
    const err = new Error('Compte Google non connecté (email_tokens/' + key +
      '). Connecte « Meet Closing » depuis admin-email-auth.html.');
    err.statusCode = 503;
    err.code = 'google_not_connected';
    throw err;
  }
  const conf = await getOAuthConfig();
  const auth = new google.auth.OAuth2(conf.clientId, conf.clientSecret);
  auth.setCredentials({ refresh_token: tok.refreshToken, access_token: tok.accessToken || undefined });
  return { auth, drive: google.drive({ version: 'v3', auth }), tokenKey: key, email: tok.email || '' };
}

async function connectionStatus() {
  const key = await resolveTokenKey();
  try {
    const snap = await db.collection('email_tokens').doc(key).get();
    const tok = snap.exists ? (snap.data() || {}) : null;
    return { connected: !!(tok && tok.refreshToken), tokenKey: key, email: tok ? (tok.email || '') : '' };
  } catch (_) {
    return { connected: false, tokenKey: key, email: '' };
  }
}

// ─── Dates ───────────────────────────────────────────────────────────────
// date 'YYYY-MM-DD' + time 'HH:MM' exprimés en heure de Paris → ms epoch.
function parisToUtcMs(dateIso, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || ''));
  if (!m) return 0;
  const t = /^(\d{1,2}):(\d{2})/.exec(String(time || '')) || [null, '12', '00'];
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], 0);
  // Décalage de Paris à cet instant : on formate `guess` en heure de Paris
  // et on mesure l'écart avec l'heure UTC.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess));
  const p = {};
  parts.forEach(function (x) { p[x.type] = x.value; });
  const asParis = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return guess - (asParis - guess);
}

function bookingStartMs(b) { return parisToUtcMs(b.date, b.time || '12:00'); }
function bookingEndMs(b) {
  const s = bookingStartMs(b);
  return s ? s + (Number(b.duration) || 30) * 60000 : 0;
}

// ─── Périmètre : RDV de CLOSING uniquement ───────────────────────────────
// Miroir de bkScope() + bkScopeBadge() de booking-admin.html : hors coaching /
// clients, et « SB » (pas un RDV de setting).
function isClosingBooking(b, typeMap) {
  const t = (b.type && typeMap && typeMap[b.type]) || null;
  if (b.isCoaching === true) return false;
  if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return false;
  if (t && t.isCoaching === true) return false;
  if (b.source === 'setter_booking') return false;
  if (!b.source && t && t.isSetterOnly === true) return false;
  return true;
}

async function loadTypeMap() {
  const map = {};
  try {
    const snap = await db.collection('booking_config').doc('_types').get();
    if (snap.exists) {
      ((snap.data() || {}).list || []).forEach(function (t) { if (t && t.id) map[t.id] = t; });
    }
  } catch (e) { console.warn('[replay] typeMap', e.message); }
  return map;
}

// ─── Identifiants Meet / Drive ───────────────────────────────────────────
function meetCodeFromLink(link) {
  const m = /meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i.exec(String(link || ''));
  return m ? m[1].toLowerCase() : null;
}
function driveFileIdFromUrl(url) {
  const s = String(url || '');
  let m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  m = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : null;
}

// ─── API Meet v2 (REST direct : absente du paquet googleapis installé) ───
async function meetGet(auth, path, params) {
  const r = await auth.request({ url: MEET_API + path, params: params || {} });
  return r.data || {};
}
async function meetListAll(auth, path, field, params) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 60; i++) {
    const p = Object.assign({ pageSize: 100 }, params || {});
    if (pageToken) p.pageToken = pageToken;
    const data = await meetGet(auth, path, p);
    (data[field] || []).forEach(function (x) { out.push(x); });
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// La conférence de CE rendez-vous : même code Meet, démarrage le plus proche
// de l'heure du RDV (un même lien peut resservir pour un RDV replanifié).
async function findConferenceRecord(auth, code, startMs) {
  const records = await meetListAll(auth, 'conferenceRecords', 'conferenceRecords', {
    filter: 'space.meeting_code = "' + code + '"',
  });
  let best = null, bestGap = Infinity;
  records.forEach(function (r) {
    const t = Date.parse(r.startTime || '');
    if (isNaN(t)) return;
    const gap = Math.abs(t - startMs);
    if (gap < bestGap) { best = r; bestGap = gap; }
  });
  if (!best || bestGap > MATCH_WINDOW_MS) return null;
  return best;
}

function participantLabel(p) {
  const u = p.signedinUser || p.anonymousUser || p.phoneUser || {};
  return String(u.displayName || '').trim() || 'Participant';
}

// ─── Découpage de la transcription pour Firestore ────────────────────────
function chunkEntries(entries) {
  const chunks = [];
  let cur = [], size = 0;
  entries.forEach(function (e) {
    const len = (e.t || '').length + 40;
    if (cur.length && size + len > CHUNK_CHARS) { chunks.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += len;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}
function chunkId(i) { return 'chunk_' + ('000' + i).slice(-3); }

async function readEntries(bookingId, chunks) {
  const n = Number(chunks) || 0;
  if (!n) return [];
  const col = db.collection('bookings').doc(bookingId).collection('replay_transcript');
  const refs = [];
  for (let i = 0; i < n; i++) refs.push(col.doc(chunkId(i)));
  const snaps = await db.getAll.apply(db, refs);
  const out = [];
  snaps.forEach(function (s) {
    if (s.exists) ((s.data() || {}).entries || []).forEach(function (e) { out.push(e); });
  });
  return out;
}

// ─── Chapitres IA ────────────────────────────────────────────────────────
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
function parseClock(v) {
  if (typeof v === 'number') return v;
  const parts = String(v || '').trim().split(':').map(function (x) { return parseInt(x, 10); });
  if (!parts.length || parts.some(function (x) { return isNaN(x); })) return NaN;
  let sec = 0;
  parts.forEach(function (x) { sec = sec * 60 + x; });
  return sec;
}

// Transcription lisible par l'IA : une ligne par prise de parole, les segments
// consécutifs d'un même locuteur sont fusionnés.
function transcriptForAi(entries, speakers) {
  const lines = [];
  let cur = null;
  entries.forEach(function (e) {
    if (cur && cur.p === e.p && e.s - cur.end < 20) {
      cur.text += ' ' + e.t;
      cur.end = e.e;
    } else {
      if (cur) lines.push('[' + fmtClock(cur.s) + '] ' + (speakers[cur.p] || 'Participant') + ' : ' + cur.text);
      cur = { p: e.p, s: e.s, end: e.e, text: e.t };
    }
  });
  if (cur) lines.push('[' + fmtClock(cur.s) + '] ' + (speakers[cur.p] || 'Participant') + ' : ' + cur.text);
  return lines.join('\n');
}

const CHAPTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'chapters'],
  properties: {
    summary: { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'title', 'summary'],
        properties: {
          start: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
};

function buildChapterPrompt(ctx, transcript) {
  const L = [];
  L.push('Voici la transcription horodatée d\'un appel de closing (vente d\'un accompagnement business à un dirigeant, en visio).');
  L.push('Elle sert à un responsable commercial qui veut revoir l\'appel sans le regarder en entier : il clique sur un chapitre et la vidéo saute à ce passage.');
  L.push('');
  L.push('Contexte :');
  L.push('- Closer : ' + (ctx.closer || '(inconnu)'));
  L.push('- Prospect : ' + (ctx.client || '(inconnu)'));
  L.push('- Durée : ' + fmtClock(ctx.durationSec));
  L.push('');
  L.push('Découpe l\'appel en 5 à 15 chapitres qui suivent le déroulé réel (par exemple : prise de contact, situation actuelle, objectifs, blocages, présentation de l\'offre, prix, objections, décision, prochaines étapes). N\'invente aucun chapitre : si une étape n\'a pas eu lieu, elle n\'apparaît pas.');
  L.push('');
  L.push('Pour chaque chapitre :');
  L.push('- "start" : l\'horodatage HH:MM:SS de la ligne où le sujet commence, repris tel quel de la transcription. Le premier chapitre commence à 00:00:00.');
  L.push('- "title" : 3 à 7 mots, concrets et propres à CET appel (« Objection : budget trop serré » plutôt que « Objections »).');
  L.push('- "summary" : une phrase sur ce qui se dit dans ce passage.');
  L.push('');
  L.push('"summary" (racine) : 3 à 5 phrases sur l\'appel dans son ensemble — situation du prospect, ce qui a été proposé, les objections, l\'issue. Factuel, sans jugement sur le closer.');
  L.push('');
  L.push('Tout en français. Réponds uniquement avec l\'objet JSON.');
  L.push('');
  L.push('<transcription>');
  L.push(transcript);
  L.push('</transcription>');
  return L.join('\n');
}

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (_) { /* on tente d'isoler l'objet */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /* rien */ }
  }
  return null;
}

async function callClaude(prompt, structured) {
  const body = {
    model: AI_MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'medium' },
  };
  if (structured) body.output_config.format = { type: 'json_schema', schema: CHAPTER_SCHEMA };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(function () { return null; });
  if (!r.ok || !j) {
    const msg = j && j.error && j.error.message ? j.error.message : ('HTTP ' + r.status);
    const err = new Error('IA : ' + msg);
    err.status = r.status;
    throw err;
  }
  if (j.stop_reason === 'refusal') throw new Error('IA : demande refusée par le modèle');
  if (j.stop_reason === 'max_tokens') throw new Error('IA : réponse tronquée');
  const text = (j.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('\n');
  return parseJsonLoose(text);
}

// Normalise des chapitres (venus de l'IA ou de l'éditeur) : temps bornés,
// triés, dédoublonnés, textes plafonnés.
function cleanChapters(list, durationSec) {
  const max = Number(durationSec) > 0 ? Number(durationSec) : Infinity;
  const seen = {};
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (c) {
    if (!c) return;
    let t = parseClock(c.t != null ? c.t : c.start);
    if (isNaN(t)) return;
    t = Math.max(0, Math.floor(t));
    if (t > max) return; // au-delà de la fin de la vidéo : horodatage inventé
    const title = String(c.title || '').trim().slice(0, 140);
    if (!title || seen[t]) return;
    seen[t] = true;
    out.push({ t: t, title: title, summary: String(c.summary || '').trim().slice(0, 600) });
  });
  out.sort(function (a, b) { return a.t - b.t; });
  return out.slice(0, 40);
}

async function generateChapters(entries, speakers, ctx) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY absente');
  const prompt = buildChapterPrompt(ctx, transcriptForAi(entries, speakers));
  let parsed = null;
  try {
    parsed = await callClaude(prompt, true);
  } catch (e) {
    // Sortie structurée refusée par l'API (400) : on retente en JSON libre.
    if (e.status !== 400) throw e;
    parsed = await callClaude(prompt, false);
  }
  if (!parsed) throw new Error('IA : réponse illisible');
  const chapters = cleanChapters(parsed.chapters, ctx.durationSec);
  if (!chapters.length) throw new Error('IA : aucun chapitre exploitable');
  return { summary: String(parsed.summary || '').trim().slice(0, 2500), chapters: chapters, model: AI_MODEL };
}

function clientName(b) {
  const pr = b.prospect || {};
  return ((pr.prenom || '') + ' ' + (pr.nom || '')).trim() || 'Inconnu';
}

// ─── Import d'un RDV ─────────────────────────────────────────────────────
// opts : { dry, google } — `google` = résultat de getGoogle() (réutilisé par
// le cron). Retourne { status, reason?, entries?, chapters?, error? }.
// N'écrit rien si opts.dry.
async function importBooking(bookingId, b, opts) {
  opts = opts || {};
  const ref = db.collection('bookings').doc(bookingId);
  const prev = b.replay || {};
  const checks = (Number(prev.checks) || 0) + 1;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const startMs = bookingStartMs(b);
  const ageDays = (Date.now() - bookingEndMs(b)) / 86400000;
  const tooOld = ageDays > GRACE_DAYS || checks >= MAX_CHECKS;

  async function finish(status, reason, extra) {
    const patch = Object.assign({ status: status, reason: reason || null, checks: checks, checkedAt: now }, extra || {});
    if (!opts.dry) await ref.set({ replay: patch }, { merge: true });
    return Object.assign({ status: status, reason: reason || null }, extra || {});
  }

  const g = opts.google || await getGoogle();
  const code = meetCodeFromLink(b.meetLink);
  let fileId = prev.videoFileId || driveFileIdFromUrl(b.meetRecordingUrl);

  // 1. Conférence Meet + enregistrement + segments de transcription
  let record = null, recordingStart = null, rawEntries = [], participants = [];
  if (code) {
    record = await findConferenceRecord(g.auth, code, startMs);
    if (record) {
      const recs = await meetListAll(g.auth, record.name + '/recordings', 'recordings');
      const rec = recs.filter(function (r) { return r.driveDestination && r.driveDestination.file; })[0] || null;
      if (rec) {
        fileId = rec.driveDestination.file;
        recordingStart = Date.parse(rec.startTime || '') || null;
      }
      const trs = await meetListAll(g.auth, record.name + '/transcripts', 'transcripts');
      for (const tr of trs) {
        const list = await meetListAll(g.auth, tr.name + '/entries', 'transcriptEntries');
        list.forEach(function (e) { rawEntries.push(e); });
      }
      if (rawEntries.length) {
        participants = await meetListAll(g.auth, record.name + '/participants', 'participants');
      }
    }
  }

  // 2. Métadonnées vidéo (taille / type pour le flux, durée pour les bornes)
  const video = {};
  if (fileId) {
    try {
      const meta = await g.drive.files.get({
        fileId: fileId, supportsAllDrives: true,
        fields: 'id,size,mimeType,videoMediaMetadata(durationMillis)',
      });
      const d = meta.data || {};
      video.videoFileId = fileId;
      video.videoSize = Number(d.size) || null;
      video.videoMime = d.mimeType || 'video/mp4';
      const ms = d.videoMediaMetadata && Number(d.videoMediaMetadata.durationMillis);
      if (ms) video.durationSec = Math.round(ms / 1000);
    } catch (e) {
      // Fichier illisible par ce compte (autre propriétaire, non partagé…) :
      // on garde l'identifiant pour le lecteur Drive intégré.
      video.videoFileId = fileId;
      video.videoError = String(e.message || e).slice(0, 200);
    }
  }

  // 3. Pas de transcription exploitable
  if (!rawEntries.length) {
    // Réimport tardif : Google a purgé les segments (30 jours) mais on les a
    // déjà en base — on ne dégrade surtout pas un replay prêt.
    if (prev.status === 'ready' && prev.chunks) {
      if (!opts.dry && video.videoFileId) await ref.set({ replay: Object.assign({ checkedAt: now }, video) }, { merge: true });
      return { status: 'ready', kept: true, entries: prev.entriesCount || 0, chapters: (prev.chapters || []).length };
    }
    if (fileId) {
      const why = !code ? 'no_meet_link' : (!record ? 'conference_not_found' : 'no_transcript');
      // Tant que le délai de grâce court, la transcription peut encore arriver.
      return finish(tooOld || !code ? 'video_only' : 'pending', why, video);
    }
    if (!code) return finish('none', 'no_meet_link');
    return finish(tooOld ? 'none' : 'pending', record ? 'no_recording' : 'conference_not_found');
  }

  // 4. Segments → secondes depuis le début de la vidéo
  const base = recordingStart || Date.parse(record.startTime || '') || startMs;
  const nameOf = {};
  participants.forEach(function (p) { nameOf[p.name] = participantLabel(p); });
  const speakers = [];
  const speakerIdx = {};
  const entries = [];
  rawEntries.forEach(function (e) {
    const text = String(e.text || '').trim();
    const s = Date.parse(e.startTime || '');
    if (!text || isNaN(s)) return;
    const end = Date.parse(e.endTime || '');
    const label = nameOf[e.participant] || 'Participant';
    if (!(label in speakerIdx)) { speakerIdx[label] = speakers.length; speakers.push(label); }
    entries.push({
      s: Math.max(0, Math.round((s - base) / 100) / 10),
      e: Math.max(0, Math.round(((isNaN(end) ? s : end) - base) / 100) / 10),
      p: speakerIdx[label],
      t: text,
    });
  });
  entries.sort(function (a, b2) { return a.s - b2.s; });
  if (!entries.length) return finish(fileId ? 'video_only' : 'none', 'no_transcript', video);

  const durationSec = video.durationSec || Math.ceil(entries[entries.length - 1].e);
  const chunks = chunkEntries(entries);

  if (opts.dry) {
    return { status: 'ready', dry: true, entries: entries.length, speakers: speakers, hasVideo: !!fileId };
  }

  // 5. Écriture : transcription d'abord, puis le doc du RDV
  const col = ref.collection('replay_transcript');
  for (let i = 0; i < chunks.length; i++) {
    await col.doc(chunkId(i)).set({ index: i, entries: chunks[i], updatedAt: now });
  }
  const patch = Object.assign({
    status: 'ready', reason: null, checks: checks, checkedAt: now, importedAt: now,
    meetCode: code, conferenceRecord: record.name,
    recordingStartMs: base, durationSec: durationSec,
    entriesCount: entries.length, chunks: chunks.length, speakers: speakers,
  }, video);
  await ref.set({ replay: patch }, { merge: true });

  // 6. Chapitres IA — on ne régénère pas ce qui existe déjà (un réimport ne
  // doit pas écraser des chapitres retouchés à la main).
  const out = { status: 'ready', entries: entries.length, hasVideo: !!fileId, chapters: (prev.chapters || []).length };
  if (!(prev.chapters && prev.chapters.length) && entries.length >= MIN_ENTRIES_FOR_AI) {
    try {
      const ai = await generateChapters(entries, speakers, {
        closer: b.personName || b.expertName || '', client: clientName(b), durationSec: durationSec,
      });
      await ref.set({ replay: {
        summary: ai.summary, chapters: ai.chapters, chaptersAi: ai.chapters,
        chaptersModel: ai.model, chaptersGeneratedAt: now, chaptersError: null,
      } }, { merge: true });
      out.chapters = ai.chapters.length;
    } catch (e) {
      console.error('[replay] chapitres', bookingId, e.message);
      await ref.set({ replay: { chaptersError: String(e.message || e).slice(0, 300) } }, { merge: true });
      out.chaptersError = e.message;
    }
  }
  return out;
}

module.exports = {
  GRACE_DAYS, MAX_CHECKS,
  getGoogle, connectionStatus,
  parisToUtcMs, bookingStartMs, bookingEndMs,
  loadTypeMap, isClosingBooking, clientName,
  meetCodeFromLink, driveFileIdFromUrl,
  readEntries, cleanChapters, generateChapters, parseClock, fmtClock,
  importBooking,
};
