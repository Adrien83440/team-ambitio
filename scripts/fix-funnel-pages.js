// ============================================================================
// scripts/fix-funnel-pages.js — mise au propre du tunnel « Funnel Quizz - Elite »
// ----------------------------------------------------------------------------
// Constat du 28/09/2026 (relecture des pages publiées) :
//   1. l'étape d'entrée s'appelle /funnel-quizz-elite-funnel alors que
//      l'adresse des pubs est www.adrienemily.com/optin-a → renommage du chemin ;
//   2. variante A (quiz) : le calendrier booking.html est chargé sans
//      `embed=1` → après confirmation, /merci s'affiche DANS l'iframe au lieu
//      de remplacer la page entière ;
//   3. variante B (VSL) : la page a gardé son bloc System.io (beacon
//      /api/page-view sur `vsl_elite` + propagation lp=vsl_elite&v=a vers le
//      formulaire) → double comptage des vues et RDV attribués à la mauvaise
//      page. Le runtime du tunnel fait déjà tout cela, proprement.
//
//   node scripts/fix-funnel-pages.js            # lecture seule : montre les diffs
//   node scripts/fix-funnel-pages.js --apply    # republie les pages + patch Firestore
//
// Écritures (--apply) : Storage (nouvelle version des 2 pages, même chemin),
// Firestore tunnels/<id> (champs steps uniquement, updateMask).
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
const OLD_SLUG = 'funnel-quizz-elite-funnel';
const NEW_SLUG = 'optin-a';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode + ' ' + url))));
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

/* Variante A — quiz : embed=1 sur le calendrier. */
function fixQuiz(html) {
  if (html.indexOf('embed=1') >= 0) return { html: html, changed: false, note: 'déjà en embed=1' };
  const out = once(html, "var BOOKING_URL = 'https://team.alteore.com/booking.html?type=call_strat_phenix_all';",
    "var BOOKING_URL = 'https://team.alteore.com/booking.html?type=call_strat_phenix_all&embed=1';   // embed=1 : après confirmation, la PAGE ENTIÈRE bascule sur /merci (pas seulement le cadre)", 'quiz BOOKING_URL');
  return { html: out, changed: true, note: 'BOOKING_URL + embed=1' };
}

/* Variante B — VSL : retrait du bloc System.io (beacon + propagation lp/v),
   le runtime du tunnel s'en charge. Le bloc va du commentaire « MESURE &
   PROVENANCE » jusqu'à la fin de l'IIFE de propagation. */
function fixVsl(html) {
  const start = html.indexOf('  /* ══ MESURE & PROVENANCE — Alteore (23/09/2026)');
  if (start < 0) return { html: html, changed: false, note: 'bloc System.io absent' };
  const endMarker = "    if(epvForm && !epvForm.getAttribute('src')){ epvForm.setAttribute('data-src', withParams(epvForm.getAttribute('data-src'))); }\n  })();\n";
  const end = html.indexOf(endMarker, start);
  if (end < 0) throw new Error('VSL : fin du bloc introuvable');
  const removed = html.slice(start, end + endMarker.length);
  if (!/EPV_TRACK/.test(removed) || removed.length > 4000) throw new Error('VSL : bloc inattendu (' + removed.length + ' car.)');
  const out = html.slice(0, start)
    + "  /* Mesure et provenance : assurées par le runtime du tunnel Alteore\n     (vues, clics, lp / v / UTM vers le formulaire et le RDV). Rien ici. */\n"
    + html.slice(end + endMarker.length);
  return { html: out, changed: true, note: 'bloc EPV_TRACK retiré (' + removed.length + ' car.)' };
}

(async () => {
  const doc = await R.getDoc('tunnels/' + TUNNEL_ID);
  if (!doc) throw new Error('tunnel introuvable');
  const t = doc.data;
  const steps = t.steps || [];
  const step = steps.filter((s) => s.slug === OLD_SLUG || s.slug === NEW_SLUG)[0];
  if (!step) throw new Error('étape ' + OLD_SLUG + ' introuvable');
  const va = (step.variants || []).filter((v) => v.id === 'a')[0];
  const vb = (step.variants || []).filter((v) => v.id === 'b')[0];
  if (!va || !vb || !va.html || !vb.html) throw new Error('variantes a/b non publiées');

  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──'));
  console.log('1. chemin de l\'étape : /' + step.slug + (step.slug === NEW_SLUG ? '  (déjà /optin-a)' : '  →  /' + NEW_SLUG));

  const htmlA = await fetchText(va.html.url);
  const htmlB = await fetchText(vb.html.url);
  const fa = fixQuiz(htmlA);
  const fb = fixVsl(htmlB);
  console.log('2. variante A (quiz, ' + htmlA.length + ' car.) : ' + fa.note);
  console.log('3. variante B (VSL, ' + htmlB.length + ' car.) : ' + fb.note);
  const nothing = step.slug === NEW_SLUG && !fa.changed && !fb.changed;
  if (nothing) { console.log('\nRien à faire.'); return; }
  if (!APPLY) { console.log('\nRelance avec --apply pour appliquer.'); return; }

  const version = Date.now();
  const nowIso = new Date().toISOString();
  /* Sauvegarde des versions en ligne avant republication (Storage n'a pas
     de versionnage) : ~/Downloads/backup-funnel-<horodatage>/ */
  const bdir = path.join(process.env.HOME || '', 'Downloads', 'backup-funnel-' + nowIso.replace(/[:.]/g, '-'));
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'variante-a-quiz.html'), htmlA);
  fs.writeFileSync(path.join(bdir, 'variante-b-vsl.html'), htmlB);
  console.log('  sauvegarde : ' + bdir);
  if (fa.changed) {
    const url = await uploadHtml(va.html.path, fa.html, version);
    va.html = Object.assign({}, va.html, { url: url, version: version, size: fa.html.length, updatedAt: nowIso });
    console.log('  A republiée');
  }
  if (fb.changed) {
    const url = await uploadHtml(vb.html.path, fb.html, version);
    vb.html = Object.assign({}, vb.html, { url: url, version: version, size: fb.html.length, updatedAt: nowIso });
    console.log('  B republiée');
  }
  step.slug = NEW_SLUG;
  await R.patchDoc('tunnels/' + TUNNEL_ID, { steps: steps, updatedAt: new Date() }, ['steps', 'updatedAt']);
  console.log('\nFait. En ligne sous 20 s : https://go.adrienemily.com/' + NEW_SLUG);
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
