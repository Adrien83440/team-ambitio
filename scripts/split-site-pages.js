// ============================================================================
// scripts/split-site-pages.js — nature des documents « tunnels » (28/09/2026)
// ----------------------------------------------------------------------------
// Décision Adrien : le site vitrine n'est pas un tunnel de vente, et la page
// « merci » (après RDV) n'appartient à aucun tunnel. Même moteur d'hébergement,
// mais trois natures (`kind`) :
//   funnel → tunnel de vente (listé et mesuré dans Funnel)
//   site   → site vitrine (géré depuis Site & pages)
//   pages  → pages communes hors tunnel
//
// Ce script :
//   1. pose kind='site' sur le tunnel Site, kind='funnel' sur le funnel ;
//   2. crée le document « Pages communes » (slug `pages`, en ligne) avec la
//      page /merci copiée depuis le funnel (HTML rechargé, redéposé) ;
//   3. archive l'étape /merci du funnel (jamais supprimée).
//
//   node scripts/split-site-pages.js            # lecture seule
//   node scripts/split-site-pages.js --apply
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// ============================================================================

const crypto = require('crypto');
const https = require('https');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BUCKET = 'ambitio-team.firebasestorage.app';
const SITE_ID = '2eESotyqrGhi76AN0Vve';
const FUNNEL_ID = '5ccT9HbJtp3hBpCLiSm5';
const PIXEL_ID = '1341581597802071';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode))));
    }).on('error', reject);
  });
}
function autoId(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
}
async function uploadHtml(storagePath, html, version) {
  const token = await R.tokenFor('https://www.googleapis.com/auth/devstorage.read_write');
  const dlToken = crypto.randomUUID();
  const meta = { name: storagePath, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', metadata: { version: String(version), firebaseStorageDownloadTokens: dlToken } };
  const boundary = 'alteo' + crypto.randomBytes(8).toString('hex');
  const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta)
    + '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
  await R.request('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=multipart',
    { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body);
  return 'https://firebasestorage.googleapis.com/v0/b/' + BUCKET + '/o/' + encodeURIComponent(storagePath) + '?alt=media&token=' + dlToken;
}

(async () => {
  const all = await R.runQuery({ from: [{ collectionId: 'tunnels' }] });
  const live = all.filter((d) => d.data.archived !== true);
  const site = live.filter((d) => d.id === SITE_ID)[0];
  const funnel = live.filter((d) => d.id === FUNNEL_ID)[0];
  if (!site || !funnel) throw new Error('site ou funnel introuvable');
  if (live.some((d) => d.data.kind === 'pages')) throw new Error('un document « pages » existe déjà');
  const merci = (funnel.data.steps || []).filter((s) => s.slug === 'merci' && s.archived !== true)[0];
  if (!merci) throw new Error('étape /merci introuvable dans le funnel');
  const va = (merci.variants || []).filter((v) => v.id === 'a' && v.html && v.html.url)[0];
  if (!va) throw new Error('/merci sans variante publiée');

  let slug = 'pages', n = 2;
  while (live.some((d) => d.data.slug === slug)) slug = 'pages-' + (n++);
  const pagesId = autoId(20);
  const now = new Date();
  const stepId = 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newStep = {
    id: stepId, name: merci.name || 'Merci', slug: 'merci', type: 'merci', status: merci.status === 'live' ? 'live' : 'draft', next: { mode: 'none' },
    seo: merci.seo || { title: '', description: '', ogImage: '' }, pixelEvent: merci.pixelEvent || '', noindex: merci.noindex === true, headHtml: merci.headHtml || '',
    variants: [{ id: 'a', label: va.label || 'Variante A', weight: 100, status: 'live', html: null }]
  };
  const pagesDoc = {
    name: 'Pages communes', slug: slug, kind: 'pages', status: 'live', archived: false, homeStepId: '',
    settings: {
      host: 'www.adrienemily.com', pixelId: PIXEL_ID, leadType: 'vsl_elite', defaultChannel: '', bookingType: '', noindex: false,
      faviconUrl: String((funnel.data.settings || {}).faviconUrl || ''), ogImage: '', headHtml: '',
      notes: 'Pages hors tunnel : merci après RDV (cible des types « Audit Stratégique »), pages utilitaires. Créé par scripts/split-site-pages.js.'
    },
    steps: [newStep], assets: [], createdAt: now, updatedAt: now, createdBy: 'script:split-site-pages'
  };

  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──'));
  console.log('1. tunnels/' + SITE_ID + ' (' + site.data.name + ') : kind=' + (site.data.kind || '∅') + ' → site');
  console.log('   tunnels/' + FUNNEL_ID + ' (' + funnel.data.name + ') : kind=' + (funnel.data.kind || '∅') + ' → funnel ; étape /merci (' + merci.id + ') → archivée');
  console.log('2. tunnels/' + pagesId + ' « Pages communes » slug=' + slug + ' live, pixel ' + PIXEL_ID + ', page /merci copiée (' + va.html.size + ' o) → step ' + stepId);
  if (!APPLY) { console.log('\nRelance avec --apply pour appliquer.'); return; }

  const html = await fetchText(va.html.url);
  const version = Date.now();
  const sp = 'tunnels/' + pagesId + '/' + stepId + '/a/index.html';
  const url = await uploadHtml(sp, html, version);
  newStep.variants[0].html = { path: sp, url: url, version: version, size: html.length, updatedAt: now.toISOString(), fileName: va.html.fileName || '' };
  await R.createDoc('tunnels/' + pagesId, pagesDoc);
  console.log('  Pages communes créées');
  await R.patchDoc('tunnels/' + SITE_ID, { kind: 'site', updatedAt: now }, ['kind', 'updatedAt']);
  const steps = (funnel.data.steps || []).map((s) => (s.id === merci.id ? Object.assign({}, s, { archived: true, archivedAt: now.toISOString(), archivedReason: 'déplacée dans Pages communes' }) : s));
  await R.patchDoc('tunnels/' + FUNNEL_ID, { kind: 'funnel', steps: steps, updatedAt: now }, ['kind', 'steps', 'updatedAt']);
  console.log('  site marqué, funnel marqué, /merci archivée dans le funnel\n\nFait. /merci répond depuis « Pages communes » sous 20 s.');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
