// ============================================================================
// scripts/fix-quiz-attribution.js — le quiz hébergé porte la clé du tunnel
// ----------------------------------------------------------------------------
// Constat du 28/09/2026 : la page quiz (variante A de /optin-a) gardait sa
// clé System.io `quiz_elite` : envoyée à Make (→ lead-optin) et posée sur le
// calendrier. Ses leads et ses RDV tombaient donc sur une autre ligne que ses
// vues dans le Funnel Sales. Correctif dans la page :
//   · LP_TAG = clé de page du tunnel (window.ALTEO_TUNNEL.page), variante
//     LP_VAR = ALTEO_TUNNEL.variant ; repli quiz_elite hors tunnel ;
//   · page_url envoyée à Make porte lp / v → lead-optin les relit (landing) ;
//   · calendrier : lp + v ;
//   · après l'envoi : ALTEO.track('optin') → compteur opt-ins de l'étape.
// Aucun changement dans Make.
//
//   node scripts/fix-quiz-attribution.js            # lecture seule
//   node scripts/fix-quiz-attribution.js --apply    # sauvegarde + republication
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BUCKET = 'ambitio-team.firebasestorage.app';
const TUNNEL_ID = '5ccT9HbJtp3hBpCLiSm5';
const STEP_SLUG = 'optin-a';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode))));
    }).on('error', reject);
  });
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
function once(s, old, neu, label) {
  const c = s.split(old).length - 1;
  if (c !== 1) throw new Error(label + ' : ancre trouvée ' + c + ' fois : ' + old.slice(0, 70));
  return s.split(old).join(neu);
}

function fixQuiz(html) {
  if (html.indexOf('LP_VAR') >= 0) return { html: html, changed: false, note: 'déjà corrigé' };
  let out = html;
  out = once(out, "  var LP_TAG = 'quiz_elite';",
    "  /* Clé de page du tunnel hébergé (Alteore) : c'est elle qui relie vues,\n     formulaires et RDV dans le Funnel Sales. Repli System.io hors tunnel. */\n  var LP_TAG = (window.ALTEO_TUNNEL && window.ALTEO_TUNNEL.page) || 'quiz_elite';\n  var LP_VAR = (window.ALTEO_TUNNEL && window.ALTEO_TUNNEL.variant) || '';", 'LP_TAG');
  out = once(out, "      lp:LP_TAG, page_url:location.href.split('#')[0], date:new Date().toISOString(),",
    "      lp:LP_TAG, v:LP_VAR, page_url:withParams(location.href.split('#')[0], {lp:LP_TAG, v:LP_VAR}), date:new Date().toISOString(),", 'page_url');
  out = once(out, "    if(cal){ cal.src = withParams(cal.getAttribute('data-src'), {lp:LP_TAG}); }",
    "    if(cal){ cal.src = withParams(cal.getAttribute('data-src'), {lp:LP_TAG, v:LP_VAR}); }", 'calendrier');
  out = once(out, "    try{ if(window.dataLayer) window.dataLayer.push({event:'quiz_lead', lp:LP_TAG, score:SC.global}); }catch(e){}",
    "    try{ if(window.dataLayer) window.dataLayer.push({event:'quiz_lead', lp:LP_TAG, score:SC.global}); }catch(e){}\n    try{ if(window.ALTEO && window.ALTEO.track) window.ALTEO.track('optin'); }catch(e){}   // compteur opt-ins de l'étape (tunnel Alteore)", 'track optin');
  return { html: out, changed: true, note: 'LP_TAG / LP_VAR depuis le tunnel, page_url et calendrier avec lp + v, ALTEO.track(optin)' };
}

(async () => {
  const doc = await R.getDoc('tunnels/' + TUNNEL_ID);
  if (!doc) throw new Error('tunnel introuvable');
  const steps = doc.data.steps || [];
  const step = steps.filter((s) => s.slug === STEP_SLUG && s.archived !== true)[0];
  if (!step) throw new Error('étape /' + STEP_SLUG + ' introuvable');
  const va = (step.variants || []).filter((v) => v.id === 'a' && v.html && v.html.url)[0];
  if (!va) throw new Error('variante A non publiée');
  const html = await fetchText(va.html.url);
  const fx = fixQuiz(html);
  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──') + '\nvariante A (quiz, ' + html.length + ' car.) : ' + fx.note);
  if (!fx.changed) return;
  if (!APPLY) { console.log('\nRelance avec --apply pour appliquer.'); return; }
  const nowIso = new Date().toISOString();
  const bdir = path.join(process.env.HOME || '', 'Downloads', 'backup-funnel-' + nowIso.replace(/[:.]/g, '-'));
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'variante-a-quiz.html'), html);
  console.log('  sauvegarde : ' + bdir);
  const version = Date.now();
  const url = await uploadHtml(va.html.path, fx.html, version);
  va.html = Object.assign({}, va.html, { url: url, version: version, size: fx.html.length, updatedAt: nowIso });
  await R.patchDoc('tunnels/' + TUNNEL_ID, { steps: steps, updatedAt: new Date() }, ['steps', 'updatedAt']);
  console.log('  A republiée\n\nFait. En ligne sous 20 s.');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
