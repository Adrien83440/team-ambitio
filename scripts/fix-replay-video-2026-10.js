// ============================================================================
// scripts/fix-replay-video-2026-10.js — vidéos des replays closing
// ----------------------------------------------------------------------------
// Constat du 20/10/2026 (comparaison durée vidéo / fin de transcription) :
//   1. Chanel (20/10) : la synchro est passée avant que Meet publie la vidéo ;
//      le repli Drive a pris le seul fichier du créneau… l'appel d'un AUTRE
//      prospect (351 s). La bonne vidéo existe (1 h 32).
//   2. Charlotte (13/10) : l'enregistrement a été coupé dans Meet au bout de
//      12 min, l'appel a duré ~3 h. Rien à récupérer côté vidéo, mais
//      durationSec valait la durée filmée et a tronqué les chapitres IA.
//
// Pour chaque replay prêt :
//   • vidéo ≠ celle que l'API Meet donne pour la conférence → on rattache la
//     bonne (id, taille, durée), on recale la transcription et les chapitres
//     sur le début du bon enregistrement ;
//   • transcription qui dépasse la vidéo → durationSec = durée de l'appel,
//     videoDurationSec = durée filmée ;
//   • dans les deux cas, chapitres marqués chaptersStale (sauf retouchés à la
//     main) : la prochaine synchro (« Tout synchroniser » ou cron 04:30 UTC)
//     les régénère, les anciens restent dans chaptersPrev.
//
//   node scripts/fix-replay-video-2026-10.js            # lecture seule
//   node scripts/fix-replay-video-2026-10.js --apply    # écrit
//
// Écritures (--apply) : bookings/<id> (champs replay.* listés, updateMask),
// bookings/<id>/replay_transcript/chunk_* (champ entries) si recalage.
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Le jeton Google « Meet Closing » est lu dans Firestore, jamais affiché.
// ============================================================================

const https = require('https');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const MEET = 'https://meet.googleapis.com/v2/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';

function getJson(url, tok) {
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { Authorization: 'Bearer ' + tok } }, function (r) {
      let d = '';
      r.on('data', function (c) { d += c; });
      r.on('end', function () {
        let j = {};
        try { j = JSON.parse(d || '{}'); } catch (_) { /* vide */ }
        if (r.statusCode >= 300) return reject(new Error('HTTP ' + r.statusCode + ' ' + ((j.error && j.error.message) || d.slice(0, 200))));
        resolve(j);
      });
    }).on('error', reject);
  });
}

async function googleToken() {
  const cfg = await R.getDoc('_config/replay_closing');
  const key = (cfg && cfg.data.tokenKey) || 'meet_closing';
  const tok = await R.getDoc('email_tokens/' + key);
  if (!tok || !tok.data.refreshToken) throw new Error('email_tokens/' + key + ' : compte Google non connecté');
  let conf = null;
  for (const id of ['oauth', 'oauth_calendar']) {
    const c = await R.getDoc('_config/' + id);
    if (c && (c.data.client_id || c.data.clientId)) { conf = c.data; break; }
  }
  if (!conf) throw new Error('_config/oauth introuvable');
  const body = new URLSearchParams({
    client_id: conf.client_id || conf.clientId, client_secret: conf.client_secret || conf.clientSecret,
    refresh_token: tok.data.refreshToken, grant_type: 'refresh_token',
  }).toString();
  const r = await R.request('POST', 'https://oauth2.googleapis.com/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return r.access_token;
}

// Même règle que pickRecording() de api/_meetTranscript.js.
function pickRecording(recs) {
  const span = function (r) { return (Date.parse(r.endTime || '') || 0) - (Date.parse(r.startTime || '') || 0); };
  const done = recs.filter(function (r) {
    return r.driveDestination && r.driveDestination.file && (!r.state || r.state === 'FILE_GENERATED');
  });
  done.sort(function (x, y) { return span(y) - span(x); });
  return done[0] || null;
}

function chunkId(i) { return 'chunk_' + ('000' + i).slice(-3); }
function r1(x) { return Math.max(0, Math.round(x * 10) / 10); }
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return Math.floor(sec / 3600) + 'h' + ('0' + Math.floor((sec % 3600) / 60)).slice(-2) + 'm' + ('0' + (sec % 60)).slice(-2) + 's';
}

(async function main() {
  console.log(APPLY ? '=== APPLICATION ===' : '=== LECTURE SEULE (ajouter --apply pour écrire) ===');
  const at = await googleToken();
  const rows = await R.runQuery({ from: [{ collectionId: 'bookings' }], where: R.ff('replay.status', 'EQUAL', 'ready') });
  console.log(rows.length + ' replays prêts\n');
  let nFix = 0;

  for (const row of rows) {
    const b = row.data, rp = b.replay || {};
    const name = ((b.prospect || {}).prenom || '') + ' ' + ((b.prospect || {}).nom || '');
    const chunks = [];
    for (let i = 0; i < (Number(rp.chunks) || 0); i++) {
      const c = await R.getDoc('bookings/' + row.id + '/replay_transcript/' + chunkId(i));
      chunks.push(c ? (c.data.entries || []) : []);
    }
    const all = [].concat.apply([], chunks);
    if (!all.length) continue;

    // 1. Bon enregistrement d'après l'API Meet (conférences < 30 jours)
    let rec = null;
    if (rp.conferenceRecord) {
      try {
        const j = await getJson(MEET + rp.conferenceRecord + '/recordings?pageSize=100', at);
        rec = pickRecording(j.recordings || []);
      } catch (e) { console.log('  ' + row.id + ' : Meet indisponible (' + e.message + ')'); }
    }

    const fields = {}, mask = [];
    const set = function (k, v) { fields[k] = v; mask.push('replay.' + k); };
    let shift = 0, why = '';
    let videoDur = Number(rp.videoDurationSec) || (rp.videoSize ? Number(rp.durationSec) || 0 : 0);

    if (rec && rec.driveDestination.file !== rp.videoFileId) {
      const meta = await getJson(DRIVE + rec.driveDestination.file + '?supportsAllDrives=true&fields=' +
        encodeURIComponent('id,name,size,mimeType,videoMediaMetadata(durationMillis)'), at);
      const ms = meta.videoMediaMetadata && Number(meta.videoMediaMetadata.durationMillis);
      videoDur = ms ? Math.round(ms / 1000) : 0;
      const newBase = Date.parse(rec.startTime);
      shift = Number(rp.recordingStartMs) ? (Number(rp.recordingStartMs) - newBase) / 1000 : 0;
      set('videoFileId', meta.id);
      set('videoSize', Number(meta.size) || null);
      set('videoMime', meta.mimeType || 'video/mp4');
      set('recordingStartMs', newBase);
      set('videoPending', false);
      why = 'MAUVAISE VIDÉO ' + rp.videoFileId + ' → ' + meta.id + ' « ' + meta.name + ' » (' + clock(videoDur) + '), recalage ' + shift.toFixed(1) + ' s';
    }

    const lastEnd = Math.ceil(all[all.length - 1].e + shift);
    const truncated = videoDur && lastEnd > videoDur + 20;
    // Chapitres générés quand durationSec valait la durée d'une vidéo trop
    // courte : ils s'arrêtent bien avant la fin de l'appel (cas de Chanel,
    // réimporté à la main avec la bonne vidéo mais resté à 1 chapitre).
    const chs = rp.chapters || [];
    const chaptersCut = !rp.chaptersEditedAt && lastEnd > 900 &&
      (Number(rp.durationSec) < lastEnd - 20 || !chs.length || chs[chs.length - 1].t < lastEnd * 0.5);
    if (!why && !truncated && !chaptersCut) continue;
    if (!why) why = truncated ? 'VIDÉO COUPÉE à ' + clock(videoDur) + ', appel jusqu\'à ' + clock(lastEnd)
      : 'CHAPITRES TRONQUÉS : ' + chs.length + ' chapitre(s), le dernier à ' + clock(chs.length ? chs[chs.length - 1].t : 0) + ' pour un appel de ' + clock(lastEnd);

    set('videoDurationSec', videoDur || null);
    set('durationSec', Math.max(videoDur, lastEnd));
    if (shift && rp.chapters) {
      const mv = function (l) { return l.map(function (c) { return Object.assign({}, c, { t: Math.max(0, Math.round(c.t + shift)) }); }); };
      set('chapters', mv(rp.chapters));
      if (rp.chaptersAi) set('chaptersAi', mv(rp.chaptersAi));
    }
    if (chaptersCut) set('chaptersStale', true);

    nFix++;
    console.log('• ' + row.id + ' | ' + name.trim());
    console.log('    ' + why);
    console.log('    durationSec ' + rp.durationSec + ' → ' + fields.durationSec + ' · videoDurationSec → ' + fields.videoDurationSec +
      (fields.chaptersStale ? ' · chapitres (' + (rp.chapters || []).length + ', tronqués) à régénérer' : '') +
      (rp.chaptersEditedAt ? ' · chapitres retouchés à la main : conservés' : ''));
    if (shift) console.log('    transcription : ' + all.length + ' segments décalés de ' + (-shift).toFixed(1) + ' s');

    if (!APPLY) continue;
    if (shift) {
      for (let i = 0; i < chunks.length; i++) {
        const moved = chunks[i].map(function (e) { return Object.assign({}, e, { s: r1(e.s + shift), e: r1(e.e + shift) }); });
        await R.patchDoc('bookings/' + row.id + '/replay_transcript/' + chunkId(i), { entries: moved }, ['entries']);
      }
    }
    await R.patchDoc('bookings/' + row.id, { replay: fields }, mask);
    console.log('    ✓ écrit');
  }
  console.log('\n' + nFix + ' replay(s) à corriger' + (APPLY ? ' — corrigés.' : '.'));
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
