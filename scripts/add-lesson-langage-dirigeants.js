// ============================================================================
// scripts/add-lesson-langage-dirigeants.js — 07/10/2026
// ----------------------------------------------------------------------------
// Ajoute la leçon « Parler le langage des dirigeants » (page HTML autonome
// doc-langage-dirigeants/index.html, audio + quiz) dans deux formations :
//   - setting-lab : module « Espace Formation », après « Module 1 : Les bases »
//   - closing-lab : module « Formation Closing », en première position
//
// Lecture seule par défaut (affiche le plan avant / après). --execute écrit.
//
// Sûreté :
//   - on manipule les valeurs Firestore BRUTES (pas de décodage / ré-encodage
//     des autres leçons : aucun double, timestamp ou null n'est altéré) ;
//   - écriture limitée au champ `modules` (+ updatedAt) via updateMask ;
//   - précondition currentDocument.updateTime : si quelqu'un a modifié la
//     formation dans le builder entre la lecture et l'écriture, Firestore
//     refuse et rien n'est écrit ;
//   - idempotent : id de leçon fixe, déjà présent → formation ignorée.
//
// Usage :
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/add-lesson-langage-dirigeants.js            # dry-run
//   ... node scripts/add-lesson-langage-dirigeants.js --execute
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const EXECUTE = process.argv.indexOf('--execute') >= 0;
const LESSON_ID = 'langage-dirigeants';
const URL = 'https://team.alteore.com/doc-langage-dirigeants/index.html';

const LESSON = {
  kind: 'lesson',
  id: LESSON_ID,
  title: 'Parler le langage des dirigeants',
  status: 'published',
  video: '', image: '', audio: '', thumbnail: '',
  duration: '15 min',
  body: 'Chiffre d\'affaires, charges, marge, trésorerie, masse salariale, temps du dirigeant : ' +
    'en un quart d\'heure, tu comprends ce qu\'un chef d\'entreprise te dit vraiment.\n\n' +
    'Lance la leçon avec le son (bouton lecture), fais les exercices de chaque chapitre, ' +
    'puis le quiz final : la leçon se coche toute seule quand tu l\'as terminé. ' +
    'Le lexique reste accessible en haut à droite.',
  resources: [],
  html: URL,
  htmlTitle: 'Le langage des dirigeants'
};

// fid → où insérer : module (par titre), puis après la leçon `after`
// (titre) ou en tête si `after` est null.
const TARGETS = [
  { fid: 'setting-lab', module: 'Espace Formation', after: 'Module 1 : Les bases' },
  { fid: 'closing-lab', module: 'Formation Closing', after: null }
];

function str(v) { return v && 'stringValue' in v ? v.stringValue : ''; }
function fields(v) { return (v && v.mapValue && v.mapValue.fields) || {}; }
function arr(v) { return (v && v.arrayValue && v.arrayValue.values) || []; }
function norm(s) { return String(s || '').trim().toLowerCase(); }

function planOf(mods) {
  return mods.map(function (m) {
    const mf = fields(m);
    const kids = arr(mf.children).map(function (c) {
      const cf = fields(c);
      return '     - ' + str(cf.kind) + ' ' + str(cf.title) + (str(cf.id) === LESSON_ID ? '   ← NOUVELLE' : '');
    });
    return ['   ' + str(mf.title)].concat(kids).join('\n');
  }).join('\n');
}

async function hasLesson(mods) {
  return mods.some(function (m) {
    return arr(fields(m).children).some(function (c) {
      const cf = fields(c);
      if (str(cf.id) === LESSON_ID) return true;
      return arr(cf.lessons).some(function (l) { return str(fields(l).id) === LESSON_ID; });
    });
  });
}

async function run() {
  console.log(EXECUTE ? '=== EXÉCUTION ===' : '=== DRY-RUN (lecture seule) — ajouter --execute pour écrire ===');
  const t = await R.token();
  for (const tg of TARGETS) {
    const doc = await R.request('GET', BASE + '/formations/' + tg.fid, { Authorization: 'Bearer ' + t });
    const mods = arr(doc.fields.modules);
    console.log('\n## ' + tg.fid + ' (' + str(doc.fields.name) + ') — updateTime ' + doc.updateTime);
    if (await hasLesson(mods)) { console.log('   Leçon déjà présente : rien à faire.'); continue; }

    const mi = mods.findIndex(function (m) { return norm(str(fields(m).title)) === norm(tg.module); });
    if (mi < 0) throw new Error(tg.fid + ' : module « ' + tg.module + ' » introuvable');
    const kids = arr(fields(mods[mi]).children);
    let pos = 0;
    if (tg.after) {
      const ai = kids.findIndex(function (c) { return norm(str(fields(c).title)) === norm(tg.after); });
      if (ai < 0) throw new Error(tg.fid + ' : leçon « ' + tg.after + ' » introuvable');
      pos = ai + 1;
    }

    // Copie profonde des valeurs brutes, insertion de la leçon encodée.
    const next = JSON.parse(JSON.stringify(mods));
    const mf = next[mi].mapValue.fields;
    if (!mf.children || !mf.children.arrayValue) mf.children = { arrayValue: { values: [] } };
    if (!mf.children.arrayValue.values) mf.children.arrayValue.values = [];
    mf.children.arrayValue.values.splice(pos, 0, R.enc(LESSON));

    console.log('   Module « ' + tg.module + ' », position ' + (pos + 1) + '. Plan après ajout :');
    console.log(planOf(next));

    if (!EXECUTE) continue;
    const url = BASE + '/formations/' + tg.fid +
      '?updateMask.fieldPaths=modules&updateMask.fieldPaths=updatedAt' +
      '&currentDocument.updateTime=' + encodeURIComponent(doc.updateTime);
    await R.request('PATCH', url, { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      { fields: { modules: { arrayValue: { values: next } }, updatedAt: { timestampValue: new Date().toISOString() } } });
    console.log('   ✓ écrit');
  }
}

run().catch(function (e) { console.error('ERREUR :', e.message || e); process.exit(1); });
