// ============================================================================
// scripts/update-quiz-page.js — quiz Élite Phénix (variante A de /optin-a)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 28/09/2026 :
//   1. témoignage de Margaux : nouvelle vidéo Wistia `ezcmd8effo` (portrait,
//      9:16), à la place de `x800p34pj8` ;
//   2. écran de résultats : un CTA « Prendre mon RDV avec un expert » juste
//      après les stats (score global + 4 piliers), qui descend au calendrier
//      intégré (#epq-bookblock) — même mécanique que le CTA du bas (data-tobook) ;
//   3. mode aperçu : `?apercu=resultats` affiche directement l'écran de
//      résultats avec des réponses d'exemple, sans formulaire ni envoi à Make,
//      uniquement en aperçu du tunnel (/t/…) ou hors tunnel (fichier local).
//      La variante reçoit `previews[]` pour qu'admin-tunnels affiche le lien
//      « 👁 Résultats du diagnostic ».
//
//   node scripts/update-quiz-page.js                   # lecture seule : constat
//   node scripts/update-quiz-page.js --out fichier.html # idem + écrit la page patchée en local (test)
//   node scripts/update-quiz-page.js --apply            # sauvegarde + republication + patch Firestore
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
const TUNNEL_ID = '5ccT9HbJtp3hBpCLiSm5';
const STEP_SLUG = 'optin-a';

const OLD_WISTIA = 'x800p34pj8';
const NEW_WISTIA = 'ezcmd8effo';
const PREVIEWS = [{ label: 'Résultats du diagnostic', query: 'apercu=resultats' }];

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

/* ── 1. Témoignage de Margaux ─────────────────────────────────────────── */
function fixMargaux(html) {
  if (html.indexOf("id:'" + NEW_WISTIA + "'") >= 0) return { html: html, changed: false, note: 'déjà ' + NEW_WISTIA };
  const out = once(html,
    "    {id:'" + OLD_WISTIA + "', asp:'0.5625', who:'Margaux', what:'Épicerie / Restaurant', res:'+20 % de CA/mois', portrait:true},",
    "    {id:'" + NEW_WISTIA + "', asp:'0.5625', who:'Margaux', what:'Épicerie / Restaurant', res:'+20 % de CA/mois', portrait:true},   // vidéo du 28/09/2026 (ex-" + OLD_WISTIA + ")",
    'VIDEOS Margaux');
  return { html: out, changed: true, note: OLD_WISTIA + ' → ' + NEW_WISTIA };
}

/* ── 2. CTA après les stats ───────────────────────────────────────────── */
function fixCta(html) {
  if (html.indexOf('r-cta-mid') >= 0) return { html: html, changed: false, note: 'déjà présent' };
  let out = once(html,
    "    h += costBlock();",
    "    /* CTA court juste après les stats : descend au calendrier intégré (data-tobook), sans faire défiler toute la page */\n"
    + "    h += '<div class=\"r-center r-cta-mid\"><a class=\"q-cta\" href=\"#epq-bookblock\" data-tobook>Prendre mon RDV avec un expert</a><small class=\"r-small\">Gratuit · 30 min · sans engagement</small></div>';\n"
    + "    h += costBlock();",
    'CTA après stats');
  out = once(out,
    "#epq .r-lock{filter:blur(7px);pointer-events:none;user-select:none}",
    "#epq .r-lock{filter:blur(7px);pointer-events:none;user-select:none}\n"
    + "#epq .r-cta-mid{margin-top:22px}\n"
    + "#epq .r-cta-mid .q-cta{margin-top:0;font-size:15.5px;padding:14px 32px}",
    'CSS CTA');
  return { html: out, changed: true, note: 'bouton « Prendre mon RDV avec un expert » après les 4 piliers' };
}

/* ── 3. Mode aperçu ───────────────────────────────────────────────────── */
function fixPreview(html) {
  if (html.indexOf('function previewResults()') >= 0) return { html: html, changed: false, note: 'déjà présent' };
  let out = once(html,
    "  go(0, true);\n})();",
    "  /* ═════════════ MODE APERÇU (admin) ═════════════\n"
    + "     ?apercu=resultats → écran de résultats rempli avec des réponses d'exemple,\n"
    + "     sans formulaire ni envoi à Make. Accepté seulement en aperçu du tunnel\n"
    + "     (/t/…, ALTEO_TUNNEL.preview) ou hors tunnel (fichier local) : jamais sur\n"
    + "     la page publique. Lien « Résultats du diagnostic » dans admin-tunnels. */\n"
    + "  function previewResults(){\n"
    + "    var PICK_SINGLE = {depuis:2, ca_mensuel:1, objectif:0, equipe:2, heures:2, ressenti:1, temps_libre:0};\n"
    + "    var PICK_RATING = {r_salaries:4, r_tresorerie:3, r_consignes:5, r_charge:4};\n"
    + "    var PICK_YESNO = {yn_levier:1};\n"
    + "    STEPS.forEach(function(s){\n"
    + "      if(s.type==='pain'){ A.pain_k = PAINS[0].k; A.pain = PAINS[0].label; }\n"
    + "      else if(s.type==='multi'){ A[s.id] = (val(s.optsFn, s.options) || []).slice(0, 2); }\n"
    + "      else if(s.type==='single'){ var o = val(s.optsFn, s.options) || []; var i = PICK_SINGLE[s.id]; A[s.id] = o[i==null ? 1 : i] || o[0]; }\n"
    + "      else if(s.type==='rating'){ A[s.id] = PICK_RATING[s.id] || 3; }\n"
    + "      else if(s.type==='yesno'){ A[s.id] = PICK_YESNO[s.id] ? 1 : 0; }\n"
    + "      else return;\n"
    + "      recordQuestion(s);\n"
    + "    });\n"
    + "    SC = scores();\n"
    + "    setProgress(STEPS.length);\n"
    + "    document.getElementById('epq-prog').style.display = 'none';\n"
    + "    document.getElementById('epq-main').style.alignItems = 'flex-start';\n"
    + "    stage.innerHTML = '<div class=\"epq-apercu\">Aperçu · réponses d\\'exemple · aucun lead envoyé</div><div class=\"r-wrap\" id=\"epq-res\"></div>';\n"
    + "    unlock('Prénom');\n"
    + "  }\n"
    + "  var apercu = (function(){ try{ return new URLSearchParams(location.search).get('apercu'); }catch(e){ return null; } })();\n"
    + "  if(apercu === 'resultats' && (!window.ALTEO_TUNNEL || window.ALTEO_TUNNEL.preview)){\n"
    + "    previewResults();\n"
    + "  } else {\n"
    + "    go(0, true);\n"
    + "  }\n"
    + "})();",
    'mode aperçu');
  out = once(out,
    "#epq .r-cta-mid{margin-top:22px}",
    "#epq .epq-apercu{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:60;background:#F59E0B;color:#0B1220;font-size:12.5px;font-weight:700;letter-spacing:.3px;padding:7px 14px;border-radius:30px;box-shadow:0 6px 18px rgba(0,0,0,.35);white-space:nowrap}\n"
    + "#epq .r-cta-mid{margin-top:22px}",
    'CSS aperçu');
  return { html: out, changed: true, note: '?apercu=resultats (aperçu du tunnel ou fichier local uniquement)' };
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
  if (!doc) throw new Error('tunnel introuvable');
  const steps = doc.data.steps || [];
  const step = steps.filter((s) => s.slug === STEP_SLUG && s.archived !== true)[0];
  if (!step) throw new Error('étape /' + STEP_SLUG + ' introuvable');
  const va = (step.variants || []).filter((v) => v.id === 'a' && v.html && v.html.url)[0];
  if (!va) throw new Error('variante A non publiée');
  const html = await fetchText(va.html.url);
  if (html.length !== va.html.size) console.log('  (taille en ligne ' + html.length + ' ≠ size Firestore ' + va.html.size + ')');

  console.log((APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──') + '  page A : ' + html.length + ' car., version ' + va.html.version);
  const f1 = fixMargaux(html);
  const f2 = fixCta(f1.html);
  const f3 = fixPreview(f2.html);
  const samePreviews = JSON.stringify(va.previews || []) === JSON.stringify(PREVIEWS);
  console.log('1. témoignage Margaux : ' + f1.note);
  console.log('2. CTA après les stats : ' + f2.note);
  console.log('3. mode aperçu : ' + f3.note);
  console.log('4. lien d\'aperçu sur la variante (Firestore) : ' + (samePreviews ? 'déjà en place' : 'à poser'));
  const nb = checkScripts(f3.html);
  console.log('   ' + nb + ' bloc(s) <script> inline valides, page patchée : ' + f3.html.length + ' car.');
  if (OUT) { fs.writeFileSync(OUT, f3.html); console.log('   page patchée écrite : ' + OUT); }

  const changed = f1.changed || f2.changed || f3.changed || !samePreviews;
  if (!changed) { console.log('\nRien à faire.'); return; }
  if (!APPLY) { console.log('\nRelance avec --apply pour appliquer.'); return; }

  const version = Date.now();
  const nowIso = new Date().toISOString();
  const bdir = path.join(process.env.HOME || '', 'Downloads', 'backup-funnel-' + nowIso.replace(/[:.]/g, '-'));
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'variante-a-quiz.html'), html);
  console.log('  sauvegarde : ' + bdir);
  if (f3.html !== html) {
    const url = await uploadHtml(va.html.path, f3.html, version);
    va.html = Object.assign({}, va.html, { url: url, version: version, size: f3.html.length, updatedAt: nowIso });
    console.log('  A republiée (version ' + version + ')');
  }
  va.previews = PREVIEWS;
  await R.patchDoc('tunnels/' + TUNNEL_ID, { steps: steps, updatedAt: new Date() }, ['steps', 'updatedAt']);
  console.log('\nFait. En ligne sous 20 s : https://www.adrienemily.com/' + STEP_SLUG + '  ·  aperçu : https://team.alteore.com/t/' + STEP_SLUG + '?v=a&' + PREVIEWS[0].query);
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
