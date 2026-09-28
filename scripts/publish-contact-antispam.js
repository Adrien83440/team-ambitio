// ============================================================================
// scripts/publish-contact-antispam.js — publie le correctif anti-spam du
// formulaire de contact (28/09/2026)
// ----------------------------------------------------------------------------
// Fait ce qu'Adrien ferait dans admin-tunnels.html, sur le tunnel « site » :
//   1. Réglages → Champs obligatoires à l'opt-in :
//        prenom, nom, email, telephone, message
//      (settings.requiredFields — lu par api/tunnel-optin.js) ;
//   2. Republie l'étape « contacts-page » (variante A) avec le HTML du repo
//      site-adrienemily/contacts-page.html (téléphone required, message
//      d'erreur data-alteo-invalid).
//
//   node scripts/publish-contact-antispam.js            # lecture seule : montre le plan
//   node scripts/publish-contact-antispam.js --apply    # écrit Storage + Firestore
//
// Garde-fous : tunnel slug `site` unique et trouvé, étape `contacts-page`
// avec variante `a` publiée, HTML du repo différent de celui en ligne, aucun
// timestampValue dans le tableau `steps` brut (sinon la réécriture du tableau
// altérerait les types — on s'arrête et on le signale).
//
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BUCKET = 'ambitio-team.firebasestorage.app';
const FILE = path.join(__dirname, '..', 'site-adrienemily', 'contacts-page.html');
const REQUIRED = 'prenom, nom, email, telephone, message';

async function uploadHtml(storagePath, html, version) {
  const token = await R.tokenFor('https://www.googleapis.com/auth/devstorage.read_write');
  const dlToken = crypto.randomUUID();
  const meta = {
    name: storagePath,
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-cache',
    metadata: { version: String(version), firebaseStorageDownloadTokens: dlToken }
  };
  const boundary = 'alteo' + crypto.randomBytes(8).toString('hex');
  const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta)
    + '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
  await R.request('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=multipart',
    { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body);
  return 'https://firebasestorage.googleapis.com/v0/b/' + BUCKET + '/o/' + encodeURIComponent(storagePath) + '?alt=media&token=' + dlToken;
}

async function downloadHtml(storagePath) {
  const token = await R.tokenFor('https://www.googleapis.com/auth/devstorage.read_write');
  const r = await fetch('https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + encodeURIComponent(storagePath) + '?alt=media',
    { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('téléchargement Storage : HTTP ' + r.status);
  return r.text();
}

(async () => {
  const html = fs.readFileSync(FILE, 'utf8');
  if (html.indexOf('data-alteo-invalid') < 0 || !/name="telephone"[^>]*required/.test(html)) {
    throw new Error('contacts-page.html du repo ne contient pas le correctif attendu (required téléphone + data-alteo-invalid).');
  }

  // ── Tunnel « site » ───────────────────────────────────────────────────────
  const tunnels = await R.runQuery({ from: [{ collectionId: 'tunnels' }], where: R.ff('slug', 'EQUAL', 'site') });
  const live = tunnels.filter((d) => d.data.archived !== true);
  if (live.length !== 1) throw new Error('tunnel slug « site » : ' + live.length + ' document(s) trouvé(s), 1 attendu.');
  const doc = live[0];
  const steps = Array.isArray(doc.data.steps) ? doc.data.steps : [];
  const step = steps.filter((s) => s && s.slug === 'contacts-page')[0];
  if (!step) throw new Error('étape « contacts-page » introuvable dans tunnels/' + doc.id);
  const variant = (step.variants || []).filter((v) => v && v.id === 'a')[0];
  if (!variant || !variant.html || !variant.html.path) throw new Error('variante « a » sans html.path sur l\'étape contact.');

  // Le tableau `steps` va être réécrit intégralement : refuser si sa version
  // brute contient un timestampValue (le décodage REST le transformerait en
  // chaîne et l'écriture altérerait le type).
  const raw = await R.request('GET',
    'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents/tunnels/' + doc.id,
    { Authorization: 'Bearer ' + (await R.token()) });
  const rawSteps = raw && raw.fields && raw.fields.steps;
  if (rawSteps && JSON.stringify(rawSteps).indexOf('"timestampValue"') >= 0) {
    throw new Error('steps contient un timestampValue : réécriture refusée, passer par admin-tunnels.html.');
  }

  // ── État actuel vs plan ──────────────────────────────────────────────────
  const current = await downloadHtml(variant.html.path);
  const same = current === html;
  const version = Date.now();
  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──'));
  console.log('tunnels/' + doc.id + '  « ' + doc.data.name + ' »  status=' + doc.data.status);
  console.log('  requiredFields : ' + JSON.stringify((doc.data.settings || {}).requiredFields || '') + '  →  ' + JSON.stringify(REQUIRED));
  console.log('  page contact   : ' + variant.html.path + '  (en ligne ' + current.length + ' car., version ' + (variant.html.version || '?') + ')');
  console.log('                   repo ' + html.length + ' car.' + (same ? '  — IDENTIQUE, upload inutile' : '  →  version ' + version));
  if (!same && current.indexOf('data-alteo-invalid') >= 0) {
    console.log('  ⚠ le HTML en ligne contient déjà data-alteo-invalid : il a peut-être été modifié depuis admin-tunnels, vérifier avant --apply.');
  }
  if (!APPLY) { console.log('\nRelance avec --apply pour écrire.'); return; }

  // ── Écritures ────────────────────────────────────────────────────────────
  if (!same) {
    const url = await uploadHtml(variant.html.path, html, version);
    variant.html = {
      path: variant.html.path, url: url, version: version,
      size: Buffer.byteLength(html, 'utf8'), updatedAt: new Date().toISOString(),
      fileName: variant.html.fileName || 'contacts-page.html'
    };
    console.log('  déposé ' + variant.html.path);
  }
  await R.patchDoc('tunnels/' + doc.id,
    { settings: { requiredFields: REQUIRED }, steps: steps, updatedAt: new Date() },
    ['settings.requiredFields', 'steps', 'updatedAt']);
  console.log('  Firestore patché (settings.requiredFields' + (same ? '' : ' + steps') + ').');
  console.log('\nEn ligne sous ~20 s (cache registre) : https://www.adrienemily.com/contacts-page');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
