// ============================================================================
// scripts/create-site-tunnel.js — crée le tunnel « Site adrienemily.com »
// ----------------------------------------------------------------------------
// Reproduit ce que ferait admin-tunnels.html à la main (README de
// site-adrienemily/) : un tunnel `site` avec 4 étapes — accueil (page
// d'accueil du domaine, répond sur /), about, product, contacts-page — et,
// pour chacune, la variante A publiée depuis le fichier HTML du repo.
//
//   node scripts/create-site-tunnel.js            # lecture seule : montre le plan
//   node scripts/create-site-tunnel.js --apply    # dépose les pages + crée le doc
//
// Écritures (--apply seulement) :
//   Storage  tunnels/<id>/<stepId>/a/index.html   (4 fichiers, jeton de téléchargement)
//   Firestore tunnels/<id>                         (création, échoue s'il existe)
// Aucun document existant n'est modifié. Refuse de tourner si un tunnel au
// slug `site` existe déjà ou si un chemin est déjà servi par un tunnel en ligne.
//
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BUCKET = 'ambitio-team.firebasestorage.app';
const ROOT = path.join(__dirname, '..', 'site-adrienemily');
const PIXEL_ID = '1341581597802071';

const PAGES = [
  { file: 'index.html',         slug: 'accueil',       name: 'Accueil',    home: true },
  { file: 'about.html',         slug: 'about',         name: 'À propos' },
  { file: 'product.html',       slug: 'product',       name: 'Programmes' },
  { file: 'contacts-page.html', slug: 'contacts-page', name: 'Contact' }
];

function autoId(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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

(async () => {
  // ── Garde-fous ────────────────────────────────────────────────────────────
  const tunnels = await R.runQuery({ from: [{ collectionId: 'tunnels' }] });
  const live = tunnels.filter((d) => d.data.archived !== true);
  if (live.some((d) => d.data.slug === 'site')) throw new Error('Un tunnel au slug « site » existe déjà : rien à faire.');
  const servedPaths = {};
  live.forEach((d) => (d.data.steps || []).forEach((s) => { if (d.data.status === 'live' && s.status === 'live') servedPaths[s.slug] = d.data.name; }));
  PAGES.forEach((p) => { if (servedPaths[p.slug]) throw new Error('Le chemin /' + p.slug + ' est déjà servi par « ' + servedPaths[p.slug] + ' ».'); });
  const funnel = live.filter((d) => d.data.settings && d.data.settings.faviconUrl)[0];
  const faviconUrl = funnel ? String(funnel.data.settings.faviconUrl) : '';

  // ── Pages ────────────────────────────────────────────────────────────────
  const files = PAGES.map((p) => {
    const html = fs.readFileSync(path.join(ROOT, p.file), 'utf8');
    if (/window\.ALTEO_TUNNEL|tunnel-runtime\.js/.test(html)) throw new Error(p.file + ' contient déjà le runtime Alteore');
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim();
    return Object.assign({ html: html, title: title, size: Buffer.byteLength(html, 'utf8') }, p);
  });

  const id = autoId(20);
  const now = new Date();
  const version = Date.now();
  const steps = files.map((p) => ({
    id: uid('st_'), name: p.name, slug: p.slug, type: 'page', status: 'live', next: { mode: 'none' },
    seo: { title: '', description: '', ogImage: '' }, pixelEvent: '', noindex: false, headHtml: '',
    variants: [{ id: 'a', label: 'Variante A', weight: 100, status: 'live', html: null }]
  }));
  const home = steps[PAGES.findIndex((p) => p.home)];

  const doc = {
    name: 'Site adrienemily.com', slug: 'site', status: 'live', archived: false, homeStepId: home.id,
    settings: {
      host: 'www.adrienemily.com', pixelId: PIXEL_ID, leadType: 'self_booking', defaultChannel: 'Site adrienemily.com',
      bookingType: 'call_strat_phenix_all', noindex: false, faviconUrl: faviconUrl, ogImage: '', headHtml: '',
      notes: 'Site vitrine — pages du dossier site-adrienemily/ du repo (voir son README). Créé par scripts/create-site-tunnel.js le ' + now.toISOString().slice(0, 10) + '.'
    },
    steps: steps, assets: [], createdAt: now, updatedAt: now, createdBy: 'script:create-site-tunnel'
  };

  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──') + '\ntunnels/' + id + '  slug=site  status=live  home=' + home.id + '  favicon=' + (faviconUrl ? 'repris du funnel' : 'aucun'));
  files.forEach((p, i) => console.log('  /' + (p.home ? '' : p.slug) + '  ←  ' + p.file + '  (' + Math.round(p.size / 1024) + ' Ko, <title> ' + JSON.stringify(p.title.slice(0, 60)) + ')  step ' + steps[i].id));
  if (!APPLY) { console.log('\nRelance avec --apply pour créer.'); return; }

  for (let i = 0; i < files.length; i++) {
    const sp = 'tunnels/' + id + '/' + steps[i].id + '/a/index.html';
    const url = await uploadHtml(sp, files[i].html, version);
    steps[i].variants[0].html = { path: sp, url: url, version: version, size: files[i].size, updatedAt: now.toISOString(), fileName: files[i].file };
    console.log('  déposé ' + sp);
  }
  await R.createDoc('tunnels/' + id, doc);
  console.log('\nTunnel créé : tunnels/' + id + '\nAperçus : https://team.alteore.com/t/?v=a  /t/about  /t/product  /t/contacts-page\nEn ligne : https://go.adrienemily.com/');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
