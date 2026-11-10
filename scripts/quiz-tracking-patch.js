// ============================================================================
// scripts/quiz-tracking-patch.js — mesure du quiz + écran « prix » (06/11/2026)
// ----------------------------------------------------------------------------
// Demande Adrien × Vincent (point stratégie du 06/11/2026) :
//   1. savoir à quelle question les visiteurs abandonnent le quiz, et ce
//      qu'ils ont répondu (compteurs anonymes) → onglet « ⭐ Qualité leads »
//      du Funnel Sales ;
//   2. écran intermédiaire pour les CA mensuels sous le seuil (20 000 € par
//      défaut) : « l'investissement dépasse 6 000 € », puis le choix de
//      continuer (le tunnel continue, le prospect vient en connaissance de
//      cause) ou de s'arrêter là (disqualification interne : il ne prend
//      pas un créneau, et l'algorithme Meta n'apprend pas sur lui).
//
// Ce que le script ajoute dans le <script> du quiz (pages HTML écrites à la
// main, stockées dans Storage, servies par api/tunnel-render.js) :
//   · epqTrackQ(i) en tête de go(i)            → ALTEO.quiz('start'|'q'|'done')
//   · epqShown(s) en tête de recordQuestion(s)  → écran affiché sans go() (écran 1)
//     (la réponse 'a' part quand on quitte la question, voir api/_quizTracking.js)
//   · epqGate(i, reprise) en tête de go(i)     → écran prix (si activé)
// Tout passe par window.ALTEO.quiz (tunnel-runtime.js) : rien n'est envoyé
// en aperçu (/t/…) ni en fichier local. DÉPLOYER le frontend (Vercel) AVANT
// de lancer --apply : sans le nouveau runtime, les appels sont ignorés sans
// erreur (garde `ALTEO.quiz` absent), mais rien n'est mesuré.
//
// Usage (lecture seule par défaut — règle « dry-run validé par Adrien ») :
//   node scripts/quiz-tracking-patch.js                    # constat, aucune écriture
//   node scripts/quiz-tracking-patch.js --out dossier/     # + pages patchées en local (à ouvrir
//                                                          #   dans le navigateur pour tester)
//   node scripts/quiz-tracking-patch.js --apply            # sauvegarde + republication + Firestore
// Options :
//   --tunnel <id>      tunnel visé (défaut : quiz Élite Phénix)
//   --seuil 20000      CA mensuel en dessous duquel l'écran prix s'affiche
//   --montant "6 000 €" montant annoncé sur l'écran prix
//   --sans-prix        n'ajoute QUE la mesure, pas l'écran prix
//
// Écritures (--apply) : Storage (nouvelle version de chaque page patchée,
// même chemin), Firestore tunnels/<id> (champ steps uniquement, updateMask).
// Sauvegarde des pages d'origine dans ~/Downloads/backup-quiz-<date>/.
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Idempotent : une page qui contient déjà « epqTrackQ » est ignorée.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const R = require('./_firestore-rest.js');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const APPLY = process.argv.indexOf('--apply') >= 0;
const NO_GATE = process.argv.indexOf('--sans-prix') >= 0;
const OUT = arg('--out', '');
const TUNNEL_ID = arg('--tunnel', '5ccT9HbJtp3hBpCLiSm5');
const SEUIL = parseInt(arg('--seuil', '20000'), 10) || 20000;
const MONTANT = arg('--montant', '6 000 €');
const BUCKET = 'ambitio-team.firebasestorage.app';

const QT = require('../api/_quizTracking.js')({ seuil: SEUIL, montant: MONTANT });
const TXT = QT.TXT;
const patchPage = QT.patchPage;
const checkScripts = QT.checkScripts;

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
  const tok = await R.tokenFor('https://www.googleapis.com/auth/devstorage.read_write');
  const dlToken = crypto.randomUUID();
  const meta = { name: storagePath, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', metadata: { version: String(version), firebaseStorageDownloadTokens: dlToken } };
  const boundary = 'alteo' + crypto.randomBytes(8).toString('hex');
  const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta)
    + '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
  await R.request('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=multipart',
    { Authorization: 'Bearer ' + tok, 'Content-Type': 'multipart/related; boundary=' + boundary }, body);
  return 'https://firebasestorage.googleapis.com/v0/b/' + BUCKET + '/o/' + encodeURIComponent(storagePath) + '?alt=media&token=' + dlToken;
}

async function main() {
  const doc = await R.getDoc('tunnels/' + TUNNEL_ID);
  if (!doc) throw new Error('tunnel ' + TUNNEL_ID + ' introuvable');
  const steps = doc.data.steps || [];
  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──') + '  tunnel « ' + (doc.data.name || TUNNEL_ID) + ' »');
  console.log('   écran prix : ' + (NO_GATE ? 'désactivé (--sans-prix)' : 'CA mensuel ≤ ' + SEUIL + ' € → « ' + TXT.body + ' »'));

  const jobs = [];
  for (const st of steps) {
    if (!st || st.archived === true) continue;
    for (const va of (st.variants || [])) {
      if (!va || !va.html || !va.html.url) continue;
      const html = await fetchText(va.html.url);
      const r = patchPage(html, !NO_GATE);
      const tag = '/' + st.slug + ' · variante ' + va.id + (va.label ? ' (' + va.label + ')' : '');
      if (r.skip) { console.log('   – ' + tag + ' : ' + r.note); continue; }
      console.log('   ' + (r.changed ? '✎' : '✓') + ' ' + tag + ' : ' + r.note);
      if (!r.changed) continue;
      const nb = checkScripts(r.html);
      console.log('       ' + nb + ' bloc(s) <script> valides · ' + html.length + ' → ' + r.html.length + ' car.');
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        const f = path.join(OUT, st.slug + '-' + va.id + '.html');
        fs.writeFileSync(f, r.html);
        console.log('       page patchée : ' + f);
      }
      jobs.push({ st: st, va: va, before: html, after: r.html, tag: tag });
    }
  }
  if (!jobs.length) { console.log('\nRien à faire.'); return; }
  if (!APPLY) { console.log('\n' + jobs.length + ' page(s) à patcher. Relance avec --apply pour appliquer (après déploiement Vercel du runtime).'); return; }

  const version = Date.now();
  const nowIso = new Date().toISOString();
  const bdir = path.join(process.env.HOME || '', 'Downloads', 'backup-quiz-' + nowIso.replace(/[:.]/g, '-'));
  fs.mkdirSync(bdir, { recursive: true });
  for (const j of jobs) {
    fs.writeFileSync(path.join(bdir, j.st.slug + '-' + j.va.id + '.html'), j.before);
    const url = await uploadHtml(j.va.html.path, j.after, version);
    j.va.html = Object.assign({}, j.va.html, { url: url, version: version, size: j.after.length, updatedAt: nowIso });
    console.log('   ' + j.tag + ' republiée (version ' + version + ')');
  }
  console.log('   sauvegarde des originaux : ' + bdir);
  await R.patchDoc('tunnels/' + TUNNEL_ID, { steps: steps, updatedAt: new Date() }, ['steps', 'updatedAt']);
  console.log('\nFait. En ligne sous 20 s.');
}

module.exports = { patchPage: patchPage, checkScripts: checkScripts };
if (require.main === module) main().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
