// ============================================================================
// api/coaching-replays-groupe.js — REPLAYS DES COACHINGS DE GROUPE → ACADEMY
// ----------------------------------------------------------------------------
// Demande d'Adrien (12/11/2026) : chaque semaine, deux coachings de groupe
// (lundi, jeudi) sont enregistrés dans Meet par coaching@adrienemily.com.
// Jusqu'ici, à la main : déplacer la vidéo de « Meet Recordings » vers le
// dossier Drive partagé par lien, puis l'ajouter dans l'Academy, cours Elite,
// module « Replay Coaching GR », à la fin du sous-module du coach.
// Cette route le fait seule, chaque matin.
//
// URL  : GET/POST /api/coaching-replays-groupe
// Auth : • Authorization: Bearer <CRON_SECRET>   (Vercel Cron)
//        • x-api-key: <CRON_SECRET> ou <REPLAYS_GROUPE_KEY>  (appel manuel)
// Cron : tous les jours à 05:15 UTC — voir vercel.json. Ne fait RIEN tant que
//        _config/replays_groupe.enabled n'est pas true.
//
// ─── DÉROULÉ ──────────────────────────────────────────────────────────────
//  1. Drive de coaching@ (email_tokens/drive_coaching, scope Drive complet,
//     connecté depuis admin-email-auth.html) : TOUTES les vidéos dont il est
//     propriétaire, créées dans la fenêtre (?days, défaut 14) et pas encore
//     dans un dossier de coach. (Constaté au diagnostic du 12/11/2026 : depuis
//     août, les enregistrements n'arrivent plus dans « Meet Recordings ».)
//  2. Academy (pont /api/bridge/replay-groupe, action « etat ») : les
//     sous-modules du module replays, un par coach. Le coach se lit dans le
//     NOM DU FICHIER Google (« … Thomas … ») : un seul sous-module doit
//     correspondre, sinon la vidéo n'est PAS rangée (coach_inconnu / ambigu).
//  3. Garde-fou : le nom doit porter la marque d'un coaching de groupe
//     (_config/replays_groupe.marqueur, expression régulière, défaut
//     « groupe | GR | collectif »). Un coaching individuel ne doit jamais
//     partir chez tous les élèves.
//  4. Dossier de destination : celui où sont DÉJÀ rangées les vidéos du
//     sous-module de ce coach (parent Drive de ses dernières leçons), à défaut
//     le dossier le plus utilisé par le module, à défaut
//     _config/replays_groupe.destFolderId. Rien à régler en temps normal.
//  5. Déplacement de la vidéo dans ce dossier (partagé par lien) ; si elle
//     n'est toujours pas lisible par lien, partage « lecteur, toute personne
//     disposant du lien » sur CE FICHIER UNIQUEMENT.
//  6. Ajout de la leçon (titre Google, publiée, à la fin du sous-module) par
//     le pont — qui refuse tout doublon et recopie aussitôt dans Business.
//  7. Trace replays_groupe/{driveFileId} (étape par étape : un déplacement
//     sans ajout est repris au run suivant) + récap par email (boîte
//     coaching) quand quelque chose a été ajouté ou mis de côté.
//
// ─── _config/replays_groupe (tout est optionnel) ─────────────────────────
//   enabled        bool    false → le cron ne fait rien (l'appel manuel ?apply=1, si)
//   tokenKey       string  clé email_tokens (défaut 'drive_coaching')
//   compte         string  compte Google attendu (défaut coaching@adrienemily.com)
//   marqueur       string  regex (insensible à la casse) d'un coaching de groupe
//   destFolderId   string  dossier de secours si aucun ne se déduit
//   notifyTo       string  destinataire du récap (défaut contact@adrienemily.com)
//
// ─── PARAMÈTRES ───────────────────────────────────────────────────────────
//   dry=1     lecture seule : liste ce qui serait fait. Ne déplace rien,
//             n'écrit rien, n'envoie rien.
//   apply=1   exécute même si enabled est faux (premier passage validé).
//   activer=1|0  allume / éteint la tâche du matin (_config/replays_groupe.enabled).
//   days=<n>  fenêtre en jours (défaut 14, max 60).
//   diag=1    lecture seule : contenu de « Meet Recordings », des dossiers des
//             coachs et des vidéos récentes du Drive (aucune écriture).
//
// ─── TEST MANUEL ──────────────────────────────────────────────────────────
//   curl -H "x-api-key: <REPLAYS_GROUPE_KEY>" \
//     "https://team.alteore.com/api/coaching-replays-groupe?dry=1&days=30"
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const CFG_PATH = '_config/replays_groupe';
const TRACE = 'replays_groupe';
const DEFAULT_TOKEN = 'drive_coaching';
const DEFAULT_COMPTE = 'coaching@adrienemily.com';
const DEFAULT_MARQUEUR = '(groupe|\\bgr\\b|collectif)';
const DEFAULT_NOTIFY = 'contact@adrienemily.com';
const SOURCE_NAME = 'Meet Recordings';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MIN_AGE_MS = 30 * 60000;      // une vidéo de moins de 30 min peut être encore en traitement
const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const MAX_PAR_RUN = 10;             // garde-fou : jamais plus de 10 ajouts d'un coup
const MOTS_VIDES = ['coaching', 'coachings', 'gr', 'groupe', 'groupes', 'replay', 'replays',
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'avec', 'the', 'and', 'call', 'session'];

// ─── Petits outils ─────────────────────────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function motsDuCoach(titreSousModule) {
  return norm(titreSousModule).split(' ').filter(function (w) {
    return w.length >= 3 && MOTS_VIDES.indexOf(w) < 0 && !/^\d+$/.test(w);
  });
}
function contientMot(texteNorm, mot) {
  return (' ' + texteNorm + ' ').indexOf(' ' + mot + ' ') >= 0;
}
function titreDeLecon(nom) {
  return String(nom || '').replace(/\.(mp4|mov|webm|m4v)$/i, '').trim();
}
function jourParis(iso) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  } catch (e) { return String(iso || ''); }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Le sous-module du coach dont le nom apparaît dans le nom du fichier.
// { sub } si un seul correspond, { raison:'coach_inconnu'|'ambigu', candidats }
function coachDuFichier(nomFichier, sousModules) {
  const t = norm(nomFichier);
  const trouves = sousModules.filter(function (s) {
    const mots = motsDuCoach(s.titre);
    return mots.length > 0 && mots.some(function (m) { return contientMot(t, m); });
  });
  if (trouves.length === 1) return { sub: trouves[0] };
  return { raison: trouves.length ? 'ambigu' : 'coach_inconnu', candidats: trouves.map(function (s) { return s.titre; }) };
}

// ─── Authentification ─────────────────────────────────────────────────
function authorize(req) {
  const cron = process.env.CRON_SECRET || '';
  const cle = process.env.REPLAYS_GROUPE_KEY || '';
  const header = req.headers['authorization'] || '';
  const bearer = header.indexOf('Bearer ') === 0 ? header.substring(7).trim() : '';
  const apiKey = req.headers['x-api-key'] || '';
  if (cron && (bearer === cron || apiKey === cron)) return true;
  if (cle && apiKey === cle) return true;
  return false;
}

// ─── Google Drive (compte coaching@) ──────────────────────────────────
async function getOAuthConfig() {
  const ids = ['oauth', 'oauth_calendar'];
  for (let i = 0; i < ids.length; i++) {
    const snap = await db.collection('_config').doc(ids[i]).get();
    if (snap.exists) {
      const d = snap.data() || {};
      const clientId = d.client_id || d.clientId;
      const clientSecret = d.client_secret || d.clientSecret;
      if (clientId && clientSecret) return { clientId: clientId, clientSecret: clientSecret };
    }
  }
  throw new Error('_config/oauth introuvable (client_id + client_secret)');
}

async function getDrive(tokenKey, compteAttendu) {
  const snap = await db.collection('email_tokens').doc(tokenKey).get();
  if (!snap.exists) {
    const e = new Error('Drive de ' + compteAttendu + ' non connecté : Admin → Connexions email → « Drive Coaching ».');
    e.code = 'drive_non_connecte';
    throw e;
  }
  const tok = snap.data() || {};
  if (!tok.refreshToken) {
    const e2 = new Error('Jeton Drive incomplet : reconnecter « Drive Coaching ».');
    e2.code = 'drive_non_connecte';
    throw e2;
  }
  if (tok.email && String(tok.email).toLowerCase() !== compteAttendu) {
    const e3 = new Error('« Drive Coaching » est connecté avec ' + tok.email + ' au lieu de ' + compteAttendu + '.');
    e3.code = 'mauvais_compte';
    throw e3;
  }
  const conf = await getOAuthConfig();
  const client = new google.auth.OAuth2(conf.clientId, conf.clientSecret);
  client.setCredentials({ refresh_token: tok.refreshToken, access_token: tok.accessToken || undefined });
  return google.drive({ version: 'v3', auth: client });
}

async function listerTout(drive, q, fields) {
  const out = [];
  let pageToken = null;
  do {
    const r = await drive.files.list({
      q: q, fields: 'nextPageToken, files(' + fields + ')', pageSize: 200,
      pageToken: pageToken || undefined, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    (r.data.files || []).forEach(function (f) { out.push(f); });
    pageToken = r.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function parentsDe(drive, fileId) {
  try {
    const r = await drive.files.get({ fileId: fileId, fields: 'id, parents, trashed', supportsAllDrives: true });
    if (r.data.trashed) return [];
    return r.data.parents || [];
  } catch (e) { return []; }
}

// Lisible par toute personne disposant du lien ? (permissions héritées comprises)
async function estPublic(drive, fileId) {
  try {
    const r = await drive.permissions.list({ fileId: fileId, fields: 'permissions(type, role)', supportsAllDrives: true });
    return (r.data.permissions || []).some(function (p) { return p.type === 'anyone'; });
  } catch (e) { return null; } // inconnu
}

async function infoDossier(drive, folderId) {
  try {
    const r = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType, trashed', supportsAllDrives: true });
    if (r.data.mimeType !== FOLDER_MIME || r.data.trashed) return null;
    return { id: r.data.id, nom: r.data.name || '', public: await estPublic(drive, folderId) };
  } catch (e) { return null; }
}

const NOMS_DOSSIERS = {};
async function nomDossier(drive, id) {
  if (!id) return '';
  if (NOMS_DOSSIERS[id] !== undefined) return NOMS_DOSSIERS[id];
  try {
    const r = await drive.files.get({ fileId: id, fields: 'name', supportsAllDrives: true });
    NOMS_DOSSIERS[id] = r.data.name || '';
  } catch (e) { NOMS_DOSSIERS[id] = ''; }
  return NOMS_DOSSIERS[id];
}

// ─── Pont Academy ─────────────────────────────────────────────────────
async function pont(body) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) throw new Error('ACADEMY_BRIDGE_KEY absente');
  const r = await fetch(ACADEMY_URL + '/api/bridge/replay-groupe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!j) throw new Error('Academy injoignable (HTTP ' + r.status + ')');
  return j;
}

// ─── Dossiers de destination, déduits de ce qui est déjà rangé ─────────
async function deduireDestinations(drive, sousModules, cfg) {
  const parSub = {};
  const compte = {};
  for (let i = 0; i < sousModules.length; i++) {
    const s = sousModules[i];
    const fichiers = s.lecons.map(function (l) { return l.fileId; }).filter(Boolean).slice(-3).reverse();
    for (let k = 0; k < fichiers.length; k++) {
      const ps = await parentsDe(drive, fichiers[k]);
      if (ps.length) {
        if (!parSub[s.id]) parSub[s.id] = ps[0];
        compte[ps[0]] = (compte[ps[0]] || 0) + 1;
      }
    }
  }
  let global = '';
  Object.keys(compte).forEach(function (id) { if (!global || compte[id] > compte[global]) global = id; });
  if (!global && cfg.destFolderId) global = cfg.destFolderId;
  const ids = {};
  Object.keys(parSub).forEach(function (k) { ids[parSub[k]] = true; });
  if (global) ids[global] = true;
  const infos = {};
  const liste = Object.keys(ids);
  for (let j = 0; j < liste.length; j++) infos[liste[j]] = await infoDossier(drive, liste[j]);
  return { parSub: parSub, global: global, infos: infos };
}

// ─── Récap ────────────────────────────────────────────────────────────
function recapHtml(rapport) {
  let h = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">';
  h += '<p><b>Replays des coachings de groupe — passage du ' + esc(jourParis(new Date().toISOString())) + '</b></p>';
  if (rapport.ajoutes.length) {
    h += '<p>✅ Ajoutés dans l\'Academy (Elite, et Business recopié) :</p><ul>';
    rapport.ajoutes.forEach(function (a) {
      h += '<li><b>' + esc(a.coach) + '</b> — ' + esc(a.titre) + (a.business && a.business.change ? '' : ' <i>(Business : déjà à jour)</i>') + '</li>';
    });
    h += '</ul>';
  }
  if (rapport.aClasser.length) {
    h += '<p>⚠️ Non rangés — à regarder :</p><ul>';
    rapport.aClasser.forEach(function (a) {
      h += '<li>' + esc(a.nom) + ' — ' + esc(a.raison) + (a.detail ? ' (' + esc(a.detail) + ')' : '') + '</li>';
    });
    h += '</ul>';
  }
  if (rapport.erreurs.length) {
    h += '<p>❌ Erreurs (nouvel essai au prochain passage) :</p><ul>';
    rapport.erreurs.forEach(function (a) { h += '<li>' + esc(a.nom) + ' — ' + esc(a.erreur) + '</li>'; });
    h += '</ul>';
  }
  h += '<p style="color:#666;font-size:12px">Envoyé automatiquement par Team (api/coaching-replays-groupe).</p></div>';
  return h;
}

// ─── Traitement d'une vidéo ───────────────────────────────────────────
async function traiter(drive, f, sub, dest, dry) {
  const ref = db.collection(TRACE).doc(f.id);
  const titre = titreDeLecon(f.name);
  const base = {
    driveFileId: f.id, nom: f.name || '', titre: titre, coachSubId: sub.id, coach: sub.titre,
    destFolderId: dest, createdTime: f.createdTime || '',
  };
  if (dry) {
    const essai = await pont({ action: 'ajouter', subId: sub.id, fileId: f.id, titre: titre, dry: true });
    return { dry: true, essai: essai };
  }

  const snap = await ref.get();
  const avant = snap.exists ? (snap.data() || {}) : {};
  if (avant.etat === 'ajoute') return { deja: true };
  // Trace AVANT toute action : un passage interrompu est repris au suivant.
  await ref.set(Object.assign({}, base, {
    etat: avant.etat === 'deplace' ? 'deplace' : 'en_cours',
    majLe: admin.firestore.FieldValue.serverTimestamp(),
    creeLe: avant.creeLe || admin.firestore.FieldValue.serverTimestamp(),
  }), { merge: true });

  // Déplacement dans le dossier partagé.
  const parents = f.parents || (await parentsDe(drive, f.id));
  if (parents.indexOf(dest) < 0) {
    await drive.files.update({
      fileId: f.id, addParents: dest, removeParents: parents.join(','),
      fields: 'id, parents', supportsAllDrives: true,
    });
  }
  let partage = 'dossier';
  const pub = await estPublic(drive, f.id);
  if (pub !== true) {
    await drive.permissions.create({
      fileId: f.id, requestBody: { type: 'anyone', role: 'reader' }, supportsAllDrives: true,
    });
    partage = 'fichier';
  }
  await ref.set({ etat: 'deplace', partage: partage, deplaceLe: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  const r = await pont({ action: 'ajouter', subId: sub.id, fileId: f.id, titre: titre, dry: false });
  if (!r.ok) throw new Error('Academy : ' + (r.error || 'refus'));
  await ref.set({
    etat: 'ajoute', lessonId: r.lessonId || '', dejaPresent: r.raison === 'deja_present',
    business: r.business || null, ajouteLe: admin.firestore.FieldValue.serverTimestamp(), erreur: '',
  }, { merge: true });
  return { ok: true, resultat: r, partage: partage };
}

// ═══ HANDLER ═════════════════════════════════════════════════════════
module.exports = async function (req, res) {
  if (!authorize(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const q = req.query || {};
  const dry = String(q.dry || '') === '1';
  const apply = String(q.apply || '') === '1';
  let days = parseInt(q.days, 10);
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
  if (days > MAX_DAYS) days = MAX_DAYS;

  // Bascule de la tâche du matin : ?activer=1 / ?activer=0 (appel manuel à clé).
  if (q.activer === '1' || q.activer === '0') {
    const on = q.activer === '1';
    await db.doc(CFG_PATH).set({ enabled: on, enabledMaj: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.status(200).json({ ok: true, enabled: on });
    return;
  }

  const cfgSnap = await db.doc(CFG_PATH).get();
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  if (!dry && !apply && cfg.enabled !== true) {
    res.status(200).json({ ok: true, skipped: 'desactive', info: 'Mettre _config/replays_groupe.enabled à true, ou appeler avec ?dry=1 / ?apply=1.' });
    return;
  }

  const compte = String(cfg.compte || DEFAULT_COMPTE).toLowerCase();
  let marqueur;
  try { marqueur = new RegExp(cfg.marqueur || DEFAULT_MARQUEUR, 'i'); }
  catch (e) { marqueur = new RegExp(DEFAULT_MARQUEUR, 'i'); }

  const rapport = { ok: true, mode: dry ? 'dry' : 'apply', days: days, compte: compte, marqueur: String(marqueur),
    source: null, destinations: null, ajoutes: [], dejaFaits: [], aClasser: [], erreurs: [], enAttente: [], aFaire: [], ignoresHorsGroupe: 0 };

  let drive;
  let etat;
  try {
    drive = await getDrive(cfg.tokenKey || DEFAULT_TOKEN, compte);
    etat = await pont({ action: 'etat' });
    if (!etat.ok || !etat.trouve) throw new Error('Module « Replay Coaching GR » introuvable dans le cours Elite');
  } catch (e) {
    res.status(200).json({ ok: false, error: e.code || 'prealable', message: String(e.message || e) });
    return;
  }
  const sousModules = etat.sousModules || [];
  rapport.sousModules = sousModules.map(function (s) { return { id: s.id, titre: s.titre, mots: motsDuCoach(s.titre), lecons: s.lecons.length }; });

  // Dossiers de destination.
  const dests = await deduireDestinations(drive, sousModules, cfg);
  rapport.destinations = { global: dests.global, parSousModule: dests.parSub, dossiers: dests.infos };

  // Dossier(s) source « Meet Recordings » de coaching@.
  const sources = await listerTout(drive,
    "(name = '" + SOURCE_NAME + "' or name = 'Enregistrements Meet') and mimeType = '" + FOLDER_MIME + "' and 'me' in owners and trashed = false",
    'id, name');
  rapport.source = sources.map(function (s) { return s.id; });

  // Diagnostic (lecture seule) : ce que contient vraiment le Drive de coaching@.
  if (String(q.diag || '') === '1') {
    const vue = function (f) { return { nom: f.name, cree: f.createdTime, mime: f.mimeType, parents: f.parents || [] }; };
    const diag = { source: [], dossiers: {}, recents: [] };
    for (let a = 0; a < sources.length; a++) {
      const r1 = await drive.files.list({ q: "'" + sources[a].id + "' in parents and trashed = false", orderBy: 'createdTime desc',
        pageSize: 15, fields: 'files(id, name, mimeType, createdTime, parents)', supportsAllDrives: true, includeItemsFromAllDrives: true });
      diag.source = diag.source.concat((r1.data.files || []).map(vue));
    }
    const ds = Object.keys(dests.infos);
    for (let b = 0; b < ds.length; b++) {
      const r2 = await drive.files.list({ q: "'" + ds[b] + "' in parents and trashed = false", orderBy: 'createdTime desc',
        pageSize: 3, fields: 'files(id, name, mimeType, createdTime)', supportsAllDrives: true, includeItemsFromAllDrives: true });
      diag.dossiers[(dests.infos[ds[b]] && dests.infos[ds[b]].nom) || ds[b]] = (r2.data.files || []).map(vue);
    }
    const r3 = await drive.files.list({ q: "mimeType contains 'video/' and trashed = false and createdTime > '" + new Date(Date.now() - 45 * 86400000).toISOString() + "'",
      orderBy: 'createdTime desc', pageSize: 25, fields: 'files(id, name, mimeType, createdTime, parents, owners(emailAddress))',
      supportsAllDrives: true, includeItemsFromAllDrives: true });
    diag.recents = (r3.data.files || []).map(function (f) {
      const v = vue(f); v.proprio = ((f.owners || [])[0] || {}).emailAddress || ''; return v;
    });
    rapport.diag = diag;
    res.status(200).json(rapport);
    return;
  }

  const depuis = new Date(Date.now() - days * 86400000).toISOString();
  // Depuis l'été 2026, Google ne range plus forcément les enregistrements dans
  // « Meet Recordings » : on cherche dans TOUT le Drive de coaching@ les vidéos
  // dont il est propriétaire, créées dans la fenêtre. Celles déjà dans un
  // dossier de coach sont considérées comme rangées (à la main ou par nous).
  const dossiersCoachs = {};
  Object.keys(dests.infos).forEach(function (id) { dossiersCoachs[id] = true; });
  const toutes = await listerTout(drive,
    "mimeType contains 'video/' and 'me' in owners and trashed = false and createdTime > '" + depuis + "'",
    'id, name, mimeType, createdTime, parents, size');
  let dejaRanges = 0;
  let videos = toutes.filter(function (f) {
    const dedans = (f.parents || []).some(function (p) { return dossiersCoachs[p]; });
    if (dedans) dejaRanges += 1;
    return !dedans;
  });
  rapport.videosVues = toutes.length;
  rapport.dejaDansUnDossierDeCoach = dejaRanges;
  // Reprise : vidéos déjà déplacées mais pas encore ajoutées (passage interrompu).
  if (!dry) {
    const enSuspens = await db.collection(TRACE).where('etat', 'in', ['en_cours', 'deplace', 'erreur']).limit(30).get();
    for (let j = 0; j < enSuspens.docs.length; j++) {
      const id = enSuspens.docs[j].id;
      if (videos.some(function (v) { return v.id === id; })) continue;
      try {
        const g = await drive.files.get({ fileId: id, fields: 'id, name, mimeType, createdTime, parents, trashed', supportsAllDrives: true });
        if (!g.data.trashed) videos.push(g.data);
      } catch (e) { /* fichier disparu : la trace reste en l'état */ }
    }
  }
  videos.sort(function (a, b) { return String(a.createdTime).localeCompare(String(b.createdTime)); });

  let faits = 0;
  for (let n = 0; n < videos.length; n++) {
    const f = videos[n];
    const ligne = { nom: f.name || '', fileId: f.id, cree: jourParis(f.createdTime) };
    // Pas un coaching de groupe (coaching individuel, autre vidéo) : ignoré en
    // silence — ni liste, ni trace, ni email (les noms de clients n'en sortent pas).
    if (!marqueur.test(f.name || '')) { rapport.ignoresHorsGroupe += 1; continue; }
    if (Date.now() - new Date(f.createdTime).getTime() < MIN_AGE_MS) { rapport.enAttente.push(ligne); continue; }
    ligne.depuis = await nomDossier(drive, (f.parents || [])[0]);
    const c = coachDuFichier(f.name, sousModules);
    if (!c.sub) { rapport.aClasser.push(Object.assign(ligne, { raison: c.raison, detail: c.candidats.join(' / ') })); continue; }
    const dest = dests.parSub[c.sub.id] || dests.global;
    if (!dest) { rapport.aClasser.push(Object.assign(ligne, { raison: 'dossier_inconnu', detail: 'aucun dossier de destination déduit' })); continue; }
    if (faits >= MAX_PAR_RUN) { rapport.enAttente.push(Object.assign(ligne, { raison: 'limite_du_passage' })); continue; }

    ligne.coach = c.sub.titre;
    ligne.titre = titreDeLecon(f.name);
    ligne.dossier = (dests.infos[dest] && dests.infos[dest].nom) || dest;
    try {
      const r = await traiter(drive, f, c.sub, dest, dry);
      if (r.dry) {
        const deja = r.essai && r.essai.raison === 'deja_present';
        if (deja) rapport.dejaFaits.push(ligne);
        else if (r.essai && r.essai.ok) rapport.aFaire.push(Object.assign(ligne, { businessSuivra: r.essai.business && r.essai.business.courseId }));
        else rapport.aClasser.push(Object.assign(ligne, { raison: (r.essai && r.essai.error) || 'refus_academy' }));
      } else if (r.deja) {
        rapport.dejaFaits.push(ligne);
      } else {
        faits += 1;
        if (r.resultat.raison === 'deja_present') rapport.dejaFaits.push(ligne);
        else rapport.ajoutes.push(Object.assign(ligne, { business: r.resultat.business, partage: r.partage }));
      }
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      rapport.erreurs.push(Object.assign(ligne, { erreur: msg }));
      if (!dry) {
        try { await db.collection(TRACE).doc(f.id).set({ etat: 'erreur', erreur: msg, majLe: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
        catch (e2) { /* rien */ }
      }
    }
  }

  // Une vidéo mise de côté n'est signalée par email qu'UNE fois (trace « ecarte »).
  let nouveauxAClasser = [];
  if (!dry) {
    for (let a = 0; a < rapport.aClasser.length; a++) {
      const x = rapport.aClasser[a];
      try {
        const ref = db.collection(TRACE).doc(x.fileId);
        const sn = await ref.get();
        if (!sn.exists) {
          await ref.set({ driveFileId: x.fileId, nom: x.nom, etat: 'ecarte', raison: x.raison, detail: x.detail || '',
            creeLe: admin.firestore.FieldValue.serverTimestamp() });
          nouveauxAClasser.push(x);
        }
      } catch (e) { /* rien : sera re-signalé au prochain passage */ }
    }
  }

  // Récap : uniquement si quelque chose de NOUVEAU s'est passé (jamais en dry-run).
  if (!dry && (rapport.ajoutes.length || rapport.erreurs.length || nouveauxAClasser.length)) {
    try {
      await sendEmailFromAccount({
        accountKey: 'coaching',
        to: cfg.notifyTo || DEFAULT_NOTIFY,
        subject: 'Replays de groupe : ' + rapport.ajoutes.length + ' ajouté(s)' +
          (nouveauxAClasser.length + rapport.erreurs.length ? ', ' + (nouveauxAClasser.length + rapport.erreurs.length) + ' à regarder' : ''),
        bodyHtml: recapHtml(Object.assign({}, rapport, { aClasser: nouveauxAClasser })),
      });
      rapport.recap = 'envoye';
    } catch (e) {
      rapport.recap = 'echec : ' + String((e && e.message) || e).slice(0, 200);
    }
  }

  res.status(200).json(rapport);
};
