// ============================================================================
// api/formations-drive.js — Google Drive pour les Formations internes
// ----------------------------------------------------------------------------
// Parcours d'un Drive côté SERVEUR (aucun OAuth dans le navigateur) pour le
// builder formations-admin.html : lister un dossier, scanner un arbre,
// partager en lecture les fichiers importés.
//
// URL  : POST /api/formations-drive
// Auth : Authorization: Bearer <ID token Firebase> d'un admin, ou d'un
//        utilisateur portant users/{uid}.formationsEditor === true.
//
// Compte Google utilisé : email_tokens/{tokenKey}, connecté une fois depuis
// admin-email-auth.html (« Drive Formations »). tokenKey vient de
// _config/formations.tokenKey (défaut 'drive_formations') ; à défaut on se
// rabat sur le compte 'drive_temoignages' déjà connecté pour le mur.
//
// ─── ACTIONS (body JSON) ──────────────────────────────────────────────────
//   { action:'status' }
//     → { ok, connected, tokenKey, email }
//   { action:'list', folderId }        folderId = 'root' | 'shared' | <id>
//     → { ok, folders:[{id,name}], files:[{id,name,mimeType,size,kind,thumbnailLink}] }
//   { action:'tree', folderId, name }
//     → { ok, node:{ id, name, folders:[node], videos:[{id,name}], docs:[{id,name}] },
//          truncated:bool }
//   { action:'share', fileIds:[…] }
//     → { ok, shared:[…], failed:[{id,error}] }
//        Pose « Tous ceux qui ont le lien : lecteur » sur CHAQUE fichier,
//        jamais sur un dossier. Sans ce partage, l'iframe /preview d'une
//        vidéo Drive reste noire pour un membre qui n'a pas accès au fichier.
//
// Rien n'est écrit en Firestore ici : l'import lui-même (création des
// modules / leçons en brouillon) se fait dans la page, avec les rules.
// ============================================================================

const { google } = require('googleapis');
const { db } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const CFG_PATH      = '_config/formations';
const DEFAULT_TOKEN = 'drive_formations';
const FALLBACK_TOKEN = 'drive_temoignages';
const FOLDER_MIME   = 'application/vnd.google-apps.folder';
const PAGE_SIZE     = 200;
const TREE_MAX_FILES = 600;   // au-delà on coupe : un import se fait dossier par dossier
const TREE_MAX_DEPTH = 5;
const SHARE_MAX     = 150;

/* ─── Classification des fichiers ─────────────────────────────────────── */
// Drive range parfois un upload en application/octet-stream : on regarde
// aussi l'extension, comme le faisait AE Academy.
function kindOf(file) {
  const m = String(file.mimeType || '').toLowerCase();
  const n = String(file.name || '').toLowerCase();
  if (m === FOLDER_MIME) return 'folder';
  if (m.indexOf('audio/') === 0 || /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac)$/.test(n)) return 'audio';
  if (m.indexOf('video/') === 0 || /\.(mp4|mov|m4v|webm|avi|mkv|mpg|mpeg)$/.test(n)) return 'video';
  if (m.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|avif|heic)$/.test(n)) return 'image';
  if (m === 'application/pdf' || m.indexOf('application/vnd.google-apps.') === 0 ||
      /officedocument|msword|ms-excel|ms-powerpoint|opendocument/.test(m) ||
      /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/.test(n)) return 'doc';
  return 'other';
}

/* ─── OAuth Google (même mécanique que temoignages-drive-sync) ────────── */
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

async function resolveTokenKey() {
  let key = DEFAULT_TOKEN;
  try {
    const cfg = await db.doc(CFG_PATH).get();
    if (cfg.exists && cfg.data().tokenKey) key = String(cfg.data().tokenKey);
  } catch (_) { /* config absente : défaut */ }
  const primary = await db.collection('email_tokens').doc(key).get();
  if (primary.exists && (primary.data() || {}).refreshToken) return { key, tok: primary.data() };
  if (key !== FALLBACK_TOKEN) {
    const fb = await db.collection('email_tokens').doc(FALLBACK_TOKEN).get();
    if (fb.exists && (fb.data() || {}).refreshToken) return { key: FALLBACK_TOKEN, tok: fb.data() };
  }
  return { key, tok: null };
}

async function getDriveClient() {
  const { key, tok } = await resolveTokenKey();
  if (!tok) {
    const err = new Error('Compte Google Drive non connecté (email_tokens/' + key +
      '). Connecte « Drive Formations » depuis admin-email-auth.html.');
    err.statusCode = 503;
    throw err;
  }
  const conf   = await getOAuthConfig();
  const client = new google.auth.OAuth2(conf.clientId, conf.clientSecret);
  client.setCredentials({ refresh_token: tok.refreshToken, access_token: tok.accessToken || undefined });
  return { drive: google.drive({ version: 'v3', auth: client }), tokenKey: key, email: tok.email || '' };
}

/* ─── Listage ─────────────────────────────────────────────────────────── */
function safeId(id) {
  const s = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{5,}$/.test(s)) throw Object.assign(new Error('folderId invalide'), { statusCode: 400 });
  return s;
}

function queryFor(folderId) {
  if (folderId === 'root')   return "'root' in parents and trashed = false";
  if (folderId === 'shared') return 'sharedWithMe = true and trashed = false';
  return "'" + safeId(folderId) + "' in parents and trashed = false";
}

async function listFolder(drive, folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: queryFor(folderId),
      pageSize: PAGE_SIZE,
      pageToken,
      fields: 'nextPageToken, files(id,name,mimeType,size,thumbnailLink)',
      orderBy: 'folder,name_natural',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: folderId === 'shared' ? 'user' : undefined,
    });
    (res.data.files || []).forEach((f) => out.push(f));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function scanTree(drive, folderId, name, budget, depth) {
  const node = { id: folderId, name: name || '', folders: [], videos: [], docs: [] };
  if (depth > TREE_MAX_DEPTH || budget.count >= TREE_MAX_FILES) { budget.truncated = true; return node; }
  const files = await listFolder(drive, folderId);
  for (const f of files) {
    const k = kindOf(f);
    if (k === 'folder') {
      node.folders.push(await scanTree(drive, f.id, f.name, budget, depth + 1));
      continue;
    }
    if (budget.count >= TREE_MAX_FILES) { budget.truncated = true; break; }
    // vidéos ET audios deviennent des leçons (l'audio se joue en <audio> si
    // c'est une URL directe ; depuis Drive il s'ouvrira en /preview)
    if (k === 'video' || k === 'audio') { node.videos.push({ id: f.id, name: f.name, kind: k }); budget.count += 1; }
    else if (k === 'doc' || k === 'image') { node.docs.push({ id: f.id, name: f.name, kind: k }); budget.count += 1; }
  }
  return node;
}

/* ─── Handler ─────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let auth;
  try { auth = await verifyFirebaseAuth(req); }
  catch (e) { res.status(e.statusCode || 401).json({ ok: false, error: e.message || 'unauthorized' }); return; }
  const editor = auth.role === 'admin' || (auth.userData && auth.userData.formationsEditor === true);
  if (!editor) { res.status(403).json({ ok: false, error: 'Accès réservé aux éditeurs de formations' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '').trim();

  try {
    if (action === 'status') {
      const { key, tok } = await resolveTokenKey();
      res.status(200).json({ ok: true, connected: !!tok, tokenKey: key, email: tok ? (tok.email || '') : '' });
      return;
    }

    const { drive } = await getDriveClient();

    if (action === 'list') {
      const folderId = String(body.folderId || 'root');
      const files = await listFolder(drive, folderId);
      const folders = [], others = [];
      files.forEach((f) => {
        const k = kindOf(f);
        if (k === 'folder') folders.push({ id: f.id, name: f.name });
        else others.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size || 0), kind: k, thumbnailLink: f.thumbnailLink || '' });
      });
      res.status(200).json({ ok: true, folders, files: others });
      return;
    }

    if (action === 'tree') {
      const folderId = safeId(body.folderId);
      const budget = { count: 0, truncated: false };
      const node = await scanTree(drive, folderId, String(body.name || ''), budget, 0);
      res.status(200).json({ ok: true, node, truncated: budget.truncated, files: budget.count });
      return;
    }

    if (action === 'share') {
      const ids = Array.isArray(body.fileIds) ? body.fileIds.map(String) : [];
      if (!ids.length) { res.status(400).json({ ok: false, error: 'fileIds requis' }); return; }
      if (ids.length > SHARE_MAX) { res.status(400).json({ ok: false, error: 'Trop de fichiers en une fois (max ' + SHARE_MAX + ')' }); return; }
      const shared = [], failed = [];
      for (const id of ids) {
        try {
          safeId(id);
          await drive.permissions.create({
            fileId: id,
            supportsAllDrives: true,
            requestBody: { role: 'reader', type: 'anyone' },
          });
          shared.push(id);
        } catch (e) {
          failed.push({ id, error: (e && e.message) || String(e) });
        }
      }
      res.status(200).json({ ok: true, shared, failed });
      return;
    }

    res.status(400).json({ ok: false, error: 'action inconnue' });
  } catch (e) {
    const code = e.statusCode || 500;
    console.error('[formations-drive]', action, e && e.message);
    res.status(code).json({ ok: false, error: (e && e.message) || 'Erreur serveur' });
  }
};
