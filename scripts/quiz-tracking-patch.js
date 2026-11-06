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
//   · epqTrackA(s) en tête de recordQuestion(s) → ALTEO.quiz('a')
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
const MARK = 'epqTrackQ';

/* ── Textes de l'écran prix (affichés en dry-run pour validation) ────── */
const TXT = {
  kicker: 'Avant d\'aller plus loin',
  title: 'Une précision importante sur l\'investissement',
  body: 'Nos accompagnements s\'adressent à des dirigeants prêts à investir dans leur entreprise : '
    + 'l\'investissement dépasse ' + MONTANT + '. On préfère te le dire dès maintenant, '
    + 'pour que ton rendez-vous soit utile.',
  go: 'C\'est clair, je continue',
  back: 'Modifier ma réponse',
  stop: 'Ce n\'est pas le bon moment pour moi',
  byeTitle: 'Merci pour ta franchise',
  byeBody: 'Quand le moment sera venu, ton diagnostic t\'attendra ici.'
};

function jsStr(s) { return JSON.stringify(String(s)); }

/* ── Code injecté (ES5, même portée que STEPS / A / stage / go) ────────── */
function helpers(withGate) {
  return [
    '  /* ═════════════ MESURE DU QUIZ (scripts/quiz-tracking-patch.js, 11/2026) ═════════════',
    '     Abandon question par question + réponses (compteurs anonymes) via',
    '     window.ALTEO.quiz — onglet « Qualité leads » du Funnel Sales.',
    '     Écran prix : CA mensuel sous ' + SEUIL + ' € → avertissement avant de continuer. */',
    '  var EPQ_QTYPES = { pain: 1, multi: 1, single: 1, rating: 1, yesno: 1 };',
    '  function epqSend(kind, data) { try { if (window.ALTEO && typeof window.ALTEO.quiz === \'function\') window.ALTEO.quiz(kind, data); } catch (e) {} }',
    '  function epqQuestions() { var out = []; for (var k = 0; k < STEPS.length; k++) { if (STEPS[k] && EPQ_QTYPES[STEPS[k].type]) out.push(k); } return out; }',
    '  function epqLabel(s) { var t = s && (s.q || s.question || s.title || s.label || s.t); if (typeof t === \'function\') { try { t = t(); } catch (e) { t = \'\'; } } t = String(t || (s && s.id) || \'\').replace(/<[^>]*>/g, \'\').replace(/\\s+/g, \' \').trim(); return t.slice(0, 200); }',
    '  function epqQ(idx) { var qs = epqQuestions(), pos = qs.indexOf(idx), s = STEPS[idx]; return { id: (s && s.id) || (\'q\' + idx), i: pos, n: qs.length, label: epqLabel(s) }; }',
    '  function ' + MARK + '(i) {',
    '    var qs = epqQuestions(); if (!qs.length) return;',
    '    if (STEPS[i] && EPQ_QTYPES[STEPS[i].type]) { if (qs.indexOf(i) === 0) epqSend(\'start\'); epqSend(\'q\', { q: epqQ(i) }); return; }',
    '    if (i > qs[qs.length - 1]) epqSend(\'done\');',
    '  }',
    '  function epqTrackA(s) {',
    '    try {',
    '      if (!s || !EPQ_QTYPES[s.type]) return;',
    '      var v = s.type === \'pain\' ? A.pain : A[s.id];',
    '      if (s.type === \'yesno\') v = v ? \'Oui\' : \'Non\';',
    '      else if (s.type === \'rating\') v = (v == null ? \'\' : String(v)) + \' / 5\';',
    '      if (v == null || v === \'\') return;',
    '      epqSend(\'a\', { q: epqQ(STEPS.indexOf(s)), a: v });',
    '    } catch (e) {}',
    '  }',
    withGate ? gateCode() : '  function epqGate() { return false; }',
    ''
  ].join('\n');
}

function gateCode() {
  return [
    '  var EPQ_SEUIL = ' + SEUIL + ', epqGateOk = false;',
    '  /* CA mensuel « bas » : plus grand montant de la réponse ≤ seuil, ou « moins de… »,',
    '     ou pas encore de CA. « Plus de… » n\'est jamais bas. */',
    '  function epqLowCa(label) {',
    '    var s = String(label || \'\').toLowerCase();',
    '    if (/pas encore|aucun|^\\s*0\\s*€/.test(s)) return true;',
    '    if (/plus de|au-dessus|sup[ée]rieur|>/.test(s)) return false;',
    '    var t = s.replace(/[\\s\\u00a0\\u202f.]/g, \'\'), re = /(\\d+(?:,\\d+)?)(k|m)?/g, m, max = -1;',
    '    while ((m = re.exec(t))) { var n = parseFloat(m[1].replace(\',\', \'.\')); if (m[2] === \'k\') n *= 1000; if (m[2] === \'m\') n *= 1000000; if (n > max) max = n; }',
    '    return max >= 0 && max <= EPQ_SEUIL;',
    '  }',
    '  function epqCaIdx() { for (var k = 0; k < STEPS.length; k++) { if (STEPS[k] && STEPS[k].id === \'ca_mensuel\') return k; } return -1; }',
    '  function epqGate(i, resume) {',
    '    var ci = epqCaIdx();',
    '    if (epqGateOk || ci < 0 || i <= ci || typeof stage === \'undefined\' || !stage) return false;',
    '    if (!epqLowCa(A.ca_mensuel)) return false;',
    '    epqSend(\'gate\', { g: \'shown\' });',
    '    stage.innerHTML = \'<div class="r-wrap epq-gate"><div class="epq-gate-k">\' + ' + jsStr(TXT.kicker) + ' + \'</div>\'',
    '      + \'<h2 class="epq-gate-t">\' + ' + jsStr(TXT.title) + ' + \'</h2>\'',
    '      + \'<p class="epq-gate-p">\' + ' + jsStr(TXT.body) + ' + \'</p>\'',
    '      + \'<div class="r-center"><a href="#" class="q-cta" data-epq-gate="go">\' + ' + jsStr(TXT.go) + ' + \' →</a></div>\'',
    '      + \'<div class="epq-gate-links"><a href="#" data-epq-gate="back">\' + ' + jsStr(TXT.back) + ' + \'</a> · <a href="#" data-epq-gate="stop">\' + ' + jsStr(TXT.stop) + ' + \'</a></div></div>\';',
    '    stage.onclick = function (ev) {',
    '      var el = ev.target && ev.target.closest ? ev.target.closest(\'[data-epq-gate]\') : null;',
    '      if (!el) return;',
    '      ev.preventDefault(); stage.onclick = null;',
    '      var act = el.getAttribute(\'data-epq-gate\');',
    '      if (act === \'go\') { epqGateOk = true; epqSend(\'gate\', { g: \'continue\' }); resume(); }',
    '      else if (act === \'back\') { go(ci, true); }',
    '      else { epqSend(\'gate\', { g: \'exit\' }); stage.innerHTML = \'<div class="r-wrap epq-gate"><h2 class="epq-gate-t">\' + ' + jsStr(TXT.byeTitle) + ' + \' 🙏</h2><p class="epq-gate-p">\' + ' + jsStr(TXT.byeBody) + ' + \'</p></div>\'; }',
    '    };',
    '    return true;',
    '  }'
  ].join('\n');
}

const GATE_CSS = [
  '#epq .epq-gate{max-width:560px;margin:0 auto;text-align:center}',
  '#epq .epq-gate-k{font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.7;margin-bottom:10px}',
  '#epq .epq-gate-t{font-size:24px;line-height:1.25;margin:0 0 14px}',
  '#epq .epq-gate-p{font-size:16px;line-height:1.6;opacity:.9;margin:0 0 6px}',
  '#epq .epq-gate-links{margin-top:16px;font-size:13.5px;opacity:.75}',
  '#epq .epq-gate-links a{color:inherit;text-decoration:underline}'
].join('\n');

/* ── Patch d'une page ──────────────────────────────────────────────────── */
function patchPage(html, withGate) {
  if (html.indexOf(MARK) >= 0) return { html: html, changed: false, note: 'déjà instrumentée' };
  const notes = [];
  if (!/\bSTEPS\b/.test(html) || html.indexOf('recordQuestion(') < 0) {
    return { html: html, changed: false, skip: true, note: 'pas un quiz (STEPS / recordQuestion absents)' };
  }
  const reGo = /function go\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*\{/g;
  const goHits = html.match(reGo) || [];
  if (goHits.length !== 1) throw new Error('function go( trouvée ' + goHits.length + ' fois');
  const reRq = /function recordQuestion\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
  const rqHits = html.match(reRq) || [];
  if (rqHits.length !== 1) throw new Error('function recordQuestion( trouvée ' + rqHits.length + ' fois');

  let gate = withGate;
  if (gate && !/(?:var|let|const)\s+stage\b/.test(html)) { gate = false; notes.push('⚠ variable stage introuvable : écran prix NON ajouté'); }
  if (gate && html.indexOf('ca_mensuel') < 0) { gate = false; notes.push('⚠ question ca_mensuel absente : écran prix NON ajouté'); }
  if (!/(?:var|let|const)\s+A\s*=/.test(html)) notes.push('⚠ objet A introuvable : les réponses ne seront pas comptées (abandon oui)');

  const mGo = /function go\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*\{/.exec(html);
  const iVar = mGo[1], second = mGo[2];
  const resumeCall = 'go(' + iVar + (second ? ', ' + second : '') + ')';
  const injectGo = mGo[0] + '\n    if (epqGate(' + iVar + ', function () { ' + resumeCall + '; })) return;\n    ' + MARK + '(' + iVar + ');';
  let out = html.slice(0, mGo.index) + helpers(gate) + '\n  ' + injectGo + html.slice(mGo.index + mGo[0].length);

  const mRq = /function recordQuestion\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(out);
  out = out.slice(0, mRq.index) + mRq[0] + '\n    epqTrackA(' + mRq[1] + ');' + out.slice(mRq.index + mRq[0].length);

  if (gate) {
    const cssAnchor = '</style>';
    const c = out.split(cssAnchor).length - 1;
    if (c < 1) throw new Error('aucune balise </style> pour le CSS de l\'écran prix');
    const at = out.indexOf(cssAnchor);
    out = out.slice(0, at) + GATE_CSS + '\n' + out.slice(at);
  }
  notes.unshift('go(' + iVar + (second ? ', ' + second : '') + ') + recordQuestion(' + mRq[1] + ') instrumentés' + (gate ? ' · écran prix sous ' + SEUIL + ' €' : ' · sans écran prix'));
  return { html: out, changed: true, note: notes.join(' · '), gate: gate };
}

/* Chaque <script> inline de la page doit se parser. */
function checkScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (/type="application\/(ld\+)?json"/i.test(m[0])) continue;
    n++;
    new Function(m[1]);
  }
  return n;
}

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
