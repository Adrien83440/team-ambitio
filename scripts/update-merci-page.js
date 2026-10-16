// ============================================================================
// scripts/update-merci-page.js — page /merci (tunnel « Pages communes »)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 16/10/2026 : retirer la « pré-confirmation WhatsApp »
// (bouton wa.me « Envoyer OK ») de la page de remerciement après RDV. La
// confirmation de présence est désormais faite par le setter, avec preuve
// (appel / SMS / WhatsApp du prospect), depuis Leads Live — voir
// api/rdv-presence.js.
//
// Retire, chacun présent une seule fois (sinon arrêt) :
//   1. la section HTML « PRÉ-CONFIRMATION WHATSAPP » et le séparateur qui la
//      précède ;
//   2. son bloc CSS (.wa-block, .btn-wa…) et la règle mobile .btn-wa ;
//   3. la ligne « Bouton WhatsApp de pré-confirmation » de l'en-tête.
//
//   node scripts/update-merci-page.js                    # lecture seule : constat
//   node scripts/update-merci-page.js --out fichier.html # idem + page patchée en local (test)
//   node scripts/update-merci-page.js --apply            # sauvegarde + republication + patch Firestore
//
// Écritures (--apply) : Storage (nouvelle version de la page A, même chemin),
// Firestore tunnels/<id> (champ steps uniquement, updateMask).
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const OUT_IDX = process.argv.indexOf('--out');
const OUT = OUT_IDX >= 0 ? process.argv[OUT_IDX + 1] : '';
const BUCKET = 'ambitio-team.firebasestorage.app';
const TUNNEL_ID = 'JPtKC95d4QhdCW8jLBev';   // « Pages communes » (kind: pages)
const STEP_SLUG = 'merci';

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
/* Retire l'unique occurrence de `re` ; zéro ou plusieurs → arrêt. */
function removeOnce(s, re, label) {
  const all = s.match(new RegExp(re.source, 'g' + re.flags.replace('g', '')));
  const c = all ? all.length : 0;
  if (c !== 1) throw new Error(label + ' : motif trouvé ' + c + ' fois');
  return s.replace(re, '');
}

function stripWhatsapp(html) {
  if (html.indexOf('wa.me/') < 0 && html.indexOf('PRÉ-CONFIRMATION WHATSAPP') < 0) {
    return { html: html, changed: false, note: 'déjà retiré' };
  }
  let out = html;
  // 1. Séparateur + section (le séparateur juste avant n'aurait plus rien à séparer).
  out = removeOnce(out, /[ \t]*<div class="divider"><\/div>\s*<!-- PRÉ-CONFIRMATION WHATSAPP -->[\s\S]*?<\/section>[ \t]*\r?\n/, 'section WhatsApp');
  // 2. CSS de la section, puis la règle mobile du bouton.
  out = removeOnce(out, /\/\* PRÉ-CONFIRMATION WHATSAPP \*\/[\s\S]*?(?=\/\* FOOTER \*\/)/, 'CSS WhatsApp');
  out = removeOnce(out, /[ \t]*#me-root \.btn-wa\{[^}]*\}[ \t]*\r?\n/, 'règle mobile .btn-wa');
  // 3. Ligne d'en-tête.
  out = removeOnce(out, /<!-- - Bouton WhatsApp de pré-confirmation\s*-->\r?\n/, 'en-tête');
  if (/wa\.me\/|btn-wa|wa-block/.test(out)) throw new Error('il reste une trace du bloc WhatsApp : vérifier la page à la main');
  return { html: out, changed: true, note: (html.length - out.length) + ' car. retirés' };
}

/* Validation locale : chaque <script> inline de la page doit se parser. */
function checkScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (/type="application\/(ld\+)?json"/i.test(m[0])) continue;
    n++;
    new Function(m[1]);   // lève une SyntaxError si le bloc est cassé
  }
  return n;
}

(async () => {
  const doc = await R.getDoc('tunnels/' + TUNNEL_ID);
  if (!doc) throw new Error('tunnel « Pages communes » introuvable');
  const steps = doc.data.steps || [];
  const step = steps.filter((s) => s.slug === STEP_SLUG && s.archived !== true)[0];
  if (!step) throw new Error('étape /' + STEP_SLUG + ' introuvable');
  const va = (step.variants || []).filter((v) => v.id === 'a' && v.html && v.html.url)[0];
  if (!va) throw new Error('variante A non publiée');
  const html = await fetchText(va.html.url);
  if (html.length !== va.html.size) console.log('  (taille en ligne ' + html.length + ' ≠ size Firestore ' + va.html.size + ')');

  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──') + '  /merci : ' + html.length + ' car., version ' + va.html.version);
  const f = stripWhatsapp(html);
  console.log('1. pré-confirmation WhatsApp : ' + f.note);
  const nb = checkScripts(f.html);
  console.log('   ' + nb + ' bloc(s) <script> inline valides, page patchée : ' + f.html.length + ' car.');
  if (OUT) { fs.writeFileSync(OUT, f.html); console.log('   page patchée écrite : ' + OUT); }

  if (!f.changed) { console.log('\nRien à faire.'); return; }
  if (!APPLY) { console.log('\nRelance avec --apply pour appliquer.'); return; }

  const version = Date.now();
  const nowIso = new Date().toISOString();
  const bdir = path.join(process.env.HOME || '', 'Downloads', 'backup-merci-' + nowIso.replace(/[:.]/g, '-'));
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'merci-variante-a.html'), html);
  console.log('  sauvegarde : ' + bdir);
  const url = await uploadHtml(va.html.path, f.html, version);
  va.html = Object.assign({}, va.html, { url: url, version: version, size: f.html.length, updatedAt: nowIso });
  await R.patchDoc('tunnels/' + TUNNEL_ID, { steps: steps, updatedAt: new Date() }, ['steps', 'updatedAt']);
  console.log('\nFait. En ligne sous 20 s : https://www.adrienemily.com/' + STEP_SLUG);
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
