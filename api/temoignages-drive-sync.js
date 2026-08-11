// ============================================================================
// api/temoignages-drive-sync.js
// ----------------------------------------------------------------------------
// Import AUTOMATIQUE des témoignages clients depuis un dossier Google Drive
// vers la collection Firestore `testimonials` (mur de témoignages).
//
// URL  : GET/POST /api/temoignages-drive-sync
// Auth : • Authorization: Bearer <CRON_SECRET>   (Vercel Cron)
//        • x-api-key: <CRON_SECRET>              (test manuel curl)
//        • Authorization: Bearer <ID token Firebase d'un admin>
//          (bouton « Synchroniser maintenant » de temoignages.html)
// Cron : toutes les heures — voir vercel.json.
//
// ─── PRINCIPE ─────────────────────────────────────────────────────────────
// Adrien dépose un fichier dans le dossier Drive surveillé → au run suivant
// il apparaît sur le mur. Les SOUS-DOSSIERS de premier niveau deviennent des
// catégories (« Interviews », « Vidéos », « Trustpilot », « Messages »).
//
// ─── OÙ ATTERRISSENT LES FICHIERS ─────────────────────────────────────────
//   • Images (≤ IMG_COPY_MAX)   → recopiées dans Firebase Storage.
//   • Vidéos (≤ VID_COPY_MAX)   → recopiées dans Firebase Storage.
//     La vignette Drive est recopiée elle aussi (les thumbnailLink Drive
//     expirent — les stocker est la seule façon d'avoir un mur stable).
//   • Vidéos plus lourdes       → PAS de copie : lecture en iframe depuis
//     Drive (`/preview`). Nécessite que le fichier soit accessible par lien.
//     Si _config/temoignages.autoShare === true, on pose nous-mêmes la
//     permission « anyone / reader » SUR CE FICHIER UNIQUEMENT. Sinon on
//     l'importe quand même et on le signale dans `warnings` : il restera
//     illisible tant qu'Adrien ne l'aura pas partagé à la main.
//   • Autre format              → fiche `kind:'file'` pointant sur Drive.
//
// ─── CONFIGURATION : _config/temoignages ──────────────────────────────────
//   driveFolderId    string  ID du dossier surveillé (obligatoire)
//   tokenKey         string  clé email_tokens/* du compte Google (déf.
//                            'drive_temoignages', connecté via
//                            admin-email-auth.html avec le scope Drive)
//   autoImport       bool    false → le cron ne fait rien (le bouton, si)
//   autoPublish      bool    true  → arrive directement sur le mur public
//   autoShare        bool    true  → partage auto des grosses vidéos
//   defaultCategory  string  catégorie des fichiers à la racine
//
// ─── IDEMPOTENCE ──────────────────────────────────────────────────────────
// Un fichier déjà importé porte son `driveFileId` sur le document Firestore.
// On charge d'abord tous les driveFileId connus, puis on ignore les fichiers
// déjà présents. Un témoignage archivé n'est JAMAIS ré-importé (sinon
// archiver un import Drive serait sans effet).
//
// ─── PARAMÈTRES (query string) ────────────────────────────────────────────
//   dry=1        dry-run : liste ce qui serait importé, n'écrit RIEN
//   max=<n>      nombre max de nouveaux fichiers traités (défaut 20, cap 60)
//
// ─── TEST MANUEL ──────────────────────────────────────────────────────────
//   curl -X POST -H "x-api-key: <CRON_SECRET>" \
//     "https://team.alteore.com/api/temoignages-drive-sync?dry=1"
// ============================================================================

const crypto = require('crypto');
const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');

const CFG_PATH        = '_config/temoignages';
const COL             = 'testimonials';
const DEFAULT_TOKEN   = 'drive_temoignages';
const IMG_COPY_MAX    = 40 * 1024 * 1024;   // 40 Mo — au-delà c'est une image d'archive
const VID_COPY_MAX    = 100 * 1024 * 1024;  // 100 Mo — au-delà on lit depuis Drive
const DEFAULT_MAX     = 20;
const HARD_MAX        = 60;
const FOLDER_MIME     = 'application/vnd.google-apps.folder';

/* ─── Catégories : nom du sous-dossier → clé de catégorie ─────────────── */
function categoryFromFolderName(name) {
  const n = String(name || '').toLowerCase();
  if (/interview|entretien|dirigeant/.test(n))            return 'interview';
  if (/trustpilot|avis|review|google\s*avis/.test(n))     return 'trustpilot';
  if (/message|whatsapp|sms|capture|screen/.test(n))      return 'message';
  if (/vid[ée]o|video|t[ée]moignage/.test(n))             return 'video';
  return null;
}

/* ─── Nom affiché déduit du nom de fichier ────────────────────────────── */
// « Anne-Lise M.mp4 » → « Anne-Lise M ». Mais « IMG_4821.HEIC » ou
// « Screenshot 2026-08-11 at 14.22.png » ne donnent rien d'utile : on
// préfère un champ vide qu'un nom de fichier d'appareil photo sur le mur.
function clientNameFromFile(fileName) {
  const base = String(fileName || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  if (!base) return '';
  if (/^(img|dsc|pxl|vid|mov|photo|image|video|screenshot|capture|whatsapp|signal|screen[\s_-]?shot)[\s_-]?\d*/i.test(base)) return '';
  if (/^\d[\d\s._-]*$/.test(base)) return '';
  if (base.length > 48) return '';
  return base.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/* ─── Type de témoignage à partir du MIME Drive ───────────────────────── */
function kindFor(mimeType, sizeBytes) {
  const m = String(mimeType || '').toLowerCase();
  // HEIC/HEIF : illisibles par les navigateurs → fiche fichier
  if (m.indexOf('heic') >= 0 || m.indexOf('heif') >= 0) return 'file';
  if (m.indexOf('image/') === 0) return sizeBytes <= IMG_COPY_MAX ? 'image' : 'file';
  if (m.indexOf('video/') === 0) return 'video';
  return 'file';
}

/* ─── OAuth Google ────────────────────────────────────────────────────── */
async function getOAuthConfig() {
  for (const id of ['oauth', 'oauth_calendar']) {
    try {
      const snap = await db.collection('_config').doc(id).get();
      if (snap.exists) {
        const d = snap.data() || {};
        const clientId     = d.client_id || d.clientId;
        const clientSecret = d.client_secret || d.clientSecret;
        if (clientId && clientSecret) return { clientId, clientSecret };
      }
    } catch (_) { /* on essaie le suivant */ }
  }
  throw new Error('_config/oauth introuvable (besoin client_id + client_secret)');
}

async function getDriveClient(tokenKey) {
  const snap = await db.collection('email_tokens').doc(tokenKey).get();
  if (!snap.exists) {
    throw new Error('Compte Google non connecté (email_tokens/' + tokenKey +
                    '). Connecte « Drive Témoignages » depuis admin-email-auth.html.');
  }
  const tok = snap.data() || {};
  if (!tok.refreshToken) {
    throw new Error('refreshToken absent pour ' + tokenKey + ' — reconnecte le compte.');
  }
  const conf   = await getOAuthConfig();
  const client = new google.auth.OAuth2(conf.clientId, conf.clientSecret);
  client.setCredentials({
    refresh_token: tok.refreshToken,
    access_token:  tok.accessToken || undefined,
  });
  return { drive: google.drive({ version: 'v3', auth: client }), auth: client };
}

/* ─── Listage du dossier + de ses sous-dossiers de 1er niveau ─────────── */
const FILE_FIELDS = 'nextPageToken, files(id, name, mimeType, size, createdTime, ' +
                    'modifiedTime, thumbnailLink, webViewLink, imageMediaMetadata(width,height), ' +
                    'videoMediaMetadata(width,height,durationMillis))';

async function listChildren(drive, folderId) {
  const out = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: "'" + folderId + "' in parents and trashed = false",
      fields: FILE_FIELDS,
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'createdTime',
    });
    const files = (res.data && res.data.files) || [];
    for (const f of files) out.push(f);
    pageToken = (res.data && res.data.nextPageToken) || null;
  } while (pageToken && out.length < 1000);
  return out;
}

async function collectFiles(drive, rootFolderId, defaultCategory) {
  const rootEntries = await listChildren(drive, rootFolderId);
  const collected = [];

  for (const e of rootEntries) {
    if (e.mimeType === FOLDER_MIME) continue;
    if (String(e.mimeType || '').indexOf('application/vnd.google-apps.') === 0) continue; // Docs natifs
    collected.push({ file: e, category: defaultCategory, folderName: '' });
  }

  const subfolders = rootEntries.filter(function (e) { return e.mimeType === FOLDER_MIME; });
  for (const sf of subfolders) {
    const cat = categoryFromFolderName(sf.name) || defaultCategory;
    const kids = await listChildren(drive, sf.id);
    for (const k of kids) {
      if (k.mimeType === FOLDER_MIME) continue; // un seul niveau de profondeur
      if (String(k.mimeType || '').indexOf('application/vnd.google-apps.') === 0) continue;
      collected.push({ file: k, category: cat, folderName: sf.name });
    }
  }
  return collected;
}

/* ─── Copie d'un binaire vers Firebase Storage ────────────────────────── */
// On pose nous-mêmes un firebaseStorageDownloadTokens : l'URL produite est
// EXACTEMENT de la même forme que celle d'un upload navigateur, elle ne
// dépend ni des ACL du bucket ni d'une signature à durée de vie limitée.
async function saveToStorage(buffer, path, contentType) {
  const bucket = admin.storage().bucket();
  const token  = crypto.randomUUID();
  await bucket.file(path).save(buffer, {
    resumable: false,
    contentType: contentType || 'application/octet-stream',
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name +
         '/o/' + encodeURIComponent(path) + '?alt=media&token=' + token;
}

async function downloadDriveFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// La vignette Drive est une URL temporaire : on la rapatrie tout de suite.
async function copyDriveThumbnail(authClient, thumbnailLink, path) {
  if (!thumbnailLink) return '';
  try {
    // sz=w1200 : Drive sert une vignette 220 px par défaut, trop floue.
    const url = thumbnailLink.replace(/=s\d+$/, '=s1200').replace(/=w\d+-h\d+/, '=w1200');
    const headers = {};
    try {
      const t = await authClient.getAccessToken();
      const value = typeof t === 'string' ? t : (t && t.token);
      if (value) headers.Authorization = 'Bearer ' + value;
    } catch (_) { /* vignette publique : on tente sans en-tête */ }
    const resp = await fetch(url, { headers });
    if (!resp.ok) return '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return '';
    return await saveToStorage(buf, path, 'image/jpeg');
  } catch (e) {
    console.warn('[temo-drive] vignette non récupérée:', e.message);
    return '';
  }
}

/* ─── Authentification de l'appel ─────────────────────────────────────── */
async function authorize(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'] || '';
  const bearer = header.startsWith('Bearer ') ? header.substring(7).trim() : '';

  if (secret && (apiKey === secret || bearer === secret)) return { via: 'cron' };

  // Sinon : ID token Firebase d'un admin (bouton de la page)
  if (bearer) {
    try {
      const decoded = await admin.auth().verifyIdToken(bearer);
      const userSnap = await db.collection('users').doc(decoded.uid).get();
      const role = userSnap.exists ? (userSnap.data() || {}).role : null;
      if (role === 'admin') return { via: 'admin', uid: decoded.uid };
      res.status(403).json({ error: 'Admin role required' });
      return null;
    } catch (e) {
      res.status(401).json({ error: 'Token invalide ou expiré' });
      return null;
    }
  }

  res.status(401).json({ error: 'Authentification requise' });
  return null;
}

/* ═══ HANDLER ═════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  const caller = await authorize(req, res);
  if (!caller) return;

  const dry = String(req.query.dry || '') === '1';
  let max = parseInt(req.query.max, 10);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  if (max > HARD_MAX) max = HARD_MAX;

  const warnings = [];
  const details  = [];
  let imported = 0, skipped = 0, failed = 0, remaining = 0;

  try {
    // 1. Configuration
    const cfgSnap = await db.doc(CFG_PATH).get();
    const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
    const folderId = String(cfg.driveFolderId || '').trim();

    if (!folderId) {
      res.status(400).json({ error: 'Aucun dossier Drive configuré. Renseigne-le depuis la page Témoignages.' });
      return;
    }
    // Le cron respecte l'interrupteur ; le bouton de la page passe outre.
    if (caller.via === 'cron' && cfg.autoImport === false) {
      res.status(200).json({ ok: true, skippedRun: true, summary: 'Import automatique désactivé.' });
      return;
    }

    const tokenKey        = cfg.tokenKey || DEFAULT_TOKEN;
    const defaultCategory = cfg.defaultCategory || 'autre';
    const autoPublish     = cfg.autoPublish === true;
    const autoShare       = cfg.autoShare === true;

    // 2. Drive
    const { drive, auth } = await getDriveClient(tokenKey);
    const candidates = await collectFiles(drive, folderId, defaultCategory);

    // 3. Ce qui est déjà importé (une seule requête, pas une par fichier)
    const knownSnap = await db.collection(COL).where('source', '==', 'drive').select('driveFileId').get();
    const known = new Set();
    knownSnap.forEach(function (d) {
      const v = (d.data() || {}).driveFileId;
      if (v) known.add(v);
    });

    const fresh = candidates.filter(function (c) { return !known.has(c.file.id); });
    skipped = candidates.length - fresh.length;
    if (fresh.length > max) {
      remaining = fresh.length - max;
      warnings.push(remaining + ' fichier(s) au-delà de la limite de ' + max +
                    ' pour ce passage — ils seront repris au run suivant.');
    }
    const batch = fresh.slice(0, max);

    // 4. Import fichier par fichier
    for (const entry of batch) {
      const f = entry.file;
      const size = parseInt(f.size, 10) || 0;
      const kind = kindFor(f.mimeType, size);
      const label = f.name + (entry.folderName ? ' (' + entry.folderName + ')' : '');

      if (dry) {
        let plan;
        if (kind === 'image') plan = 'copie vers Storage';
        else if (kind === 'video') plan = size <= VID_COPY_MAX ? 'copie vers Storage' : 'lecture depuis Drive' + (autoShare ? ' + partage auto' : ' — PARTAGE MANUEL REQUIS');
        else plan = 'fiche fichier (lien Drive)';
        details.push({ name: label, kind, bytes: size, category: entry.category, plan });
        imported++;
        continue;
      }

      try {
        const ref  = db.collection(COL).doc();
        const base = 'testimonials/' + ref.id + '/';
        const safe = String(f.name || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90);

        const doc = {
          kind,
          source:      'drive',
          category:    entry.category,
          driveFileId: f.id,
          driveFolder: entry.folderName || '',
          fileName:    f.name || '',
          mime:        f.mimeType || '',
          bytes:       size,
          mediaUrl:    '',
          storagePath: '',
          embedUrl:    '',
          posterUrl:   '',
          sourceUrl:   f.webViewLink || '',
          width:  0, height: 0, duration: 0,
          clientName: clientNameFromFile(f.name),
          caption:    '',
          text:       '',
          isPublic:   autoPublish,
          featured:   false,
          archived:   false,
          order:      new Date(f.createdTime || Date.now()).getTime() || Date.now(),
          createdAt:  admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
        };

        if (f.imageMediaMetadata) {
          doc.width  = f.imageMediaMetadata.width  || 0;
          doc.height = f.imageMediaMetadata.height || 0;
        }
        if (f.videoMediaMetadata) {
          doc.width    = f.videoMediaMetadata.width  || 0;
          doc.height   = f.videoMediaMetadata.height || 0;
          doc.duration = Math.round((parseInt(f.videoMediaMetadata.durationMillis, 10) || 0) / 1000);
        }

        if (kind === 'image') {
          const buf = await downloadDriveFile(drive, f.id);
          doc.storagePath = base + safe;
          doc.mediaUrl    = await saveToStorage(buf, doc.storagePath, f.mimeType);

        } else if (kind === 'video' && size <= VID_COPY_MAX) {
          const buf = await downloadDriveFile(drive, f.id);
          doc.storagePath = base + safe;
          doc.mediaUrl    = await saveToStorage(buf, doc.storagePath, f.mimeType);
          doc.posterUrl   = await copyDriveThumbnail(auth, f.thumbnailLink, base + 'poster.jpg');

        } else if (kind === 'video') {
          // Trop lourde pour être recopiée : lecture en iframe depuis Drive.
          doc.kind      = 'embed';
          doc.embedUrl  = 'https://drive.google.com/file/d/' + f.id + '/preview';
          doc.posterUrl = await copyDriveThumbnail(auth, f.thumbnailLink, base + 'poster.jpg');
          if (autoShare) {
            try {
              await drive.permissions.create({
                fileId: f.id,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true,
              });
            } catch (e) {
              warnings.push('Partage automatique impossible pour « ' + f.name + ' » : ' + e.message);
            }
          } else {
            warnings.push('« ' + f.name + ' » (' + Math.round(size / 1048576) +
                          ' Mo) est lue depuis Drive : partage-la « Tous ceux qui ont le lien » ' +
                          'ou active le partage automatique, sinon elle restera illisible.');
          }

        } else {
          // Format non affichable : on garde le lien Drive.
          doc.mediaUrl = f.webViewLink || '';
          if (!doc.mediaUrl) {
            warnings.push('« ' + f.name + ' » importé sans lien exploitable.');
          }
        }

        // ⚠ Vercel coupe la fonction dès res.end() : on écrit AVANT de répondre.
        await ref.set(doc);
        imported++;
        details.push({ name: label, kind: doc.kind, bytes: size, category: entry.category, id: ref.id });

      } catch (e) {
        failed++;
        console.error('[temo-drive] échec sur ' + f.name + ' :', e.message);
        warnings.push('Échec sur « ' + f.name + ' » : ' + e.message);
      }
    }

    const summary = dry
      ? imported + ' fichier(s) seraient importés, ' + skipped + ' déjà présent(s).'
      : imported + ' importé(s), ' + skipped + ' déjà présent(s)' +
        (failed ? ', ' + failed + ' en échec' : '') +
        (remaining ? ', ' + remaining + ' en attente du prochain passage' : '') + '.';

    if (!dry) {
      await db.doc(CFG_PATH).set({
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncSummary: summary,
        lastSyncBy: caller.via,
      }, { merge: true });
    }

    res.status(200).json({
      ok: true, dry, imported, skipped, failed, remaining,
      scanned: candidates.length, summary, warnings, details,
    });

  } catch (e) {
    console.error('[temo-drive] erreur:', e);
    res.status(500).json({ error: e.message || 'Erreur de synchronisation', warnings });
  }
};
