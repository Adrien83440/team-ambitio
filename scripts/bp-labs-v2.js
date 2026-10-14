// ============================================================================
// scripts/bp-labs-v2.js — FICHES BUSINESS PHÉNIX DANS LE CLOSING LAB ET LE COACH LAB
// ----------------------------------------------------------------------------
// Demande d'Adrien (14/10/2026) : des fiches Business aussi explicites que
// celles d'Elite. Dans « Les formations Adrien&Emily » du Closing LAB, le
// sous-module « Business Phénix » reçoit, comme « Elite Phénix » : la méthode
// (détail de l'accompagnement), le parcours du closing à J+180, les tarifs
// avec toutes les mensualités. Le comparatif Business / Elite rejoint les
// avatars et le document d'offre. La leçon « Tarifs et Paiement Elite »
// reçoit un lien vers le même tableau (son image est conservée). Dans le
// Coach LAB, le module Business reçoit le parcours client à côté du guide.
//
// DRY-RUN PAR DÉFAUT : affiche le plan, n'écrit rien. --apply écrit, avec la
// précondition updateTime (refus si la formation a bougé entre-temps).
// Rien n'est supprimé ; une leçon déjà présente (même id) n'est pas recréée.
//
//   node scripts/bp-labs-v2.js            # à blanc
//   node scripts/bp-labs-v2.js --apply    # écrit
// ============================================================================
'use strict';
const path = require('path');
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(process.env.HOME, '.secrets/ambitio-team-sa.json');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const SITE = 'https://team.alteore.com/';

function lecon(id, title, file, htmlTitle, body, duration) {
  return R.enc({
    kind: 'lesson', id: id, title: title, status: 'published',
    video: '', image: '', audio: '', thumbnail: '', duration: duration || '',
    body: body, resources: [{ title: htmlTitle, url: SITE + file }], html: SITE + file, htmlTitle: htmlTitle
  });
}

const L = {
  methode: lecon('bp6-methode', 'La méthode Business Phénix', 'doc-methode-business-phenix.html',
    'La méthode Business Phénix — Guide du closer',
    'Le détail de l\'accompagnement : le problème (le gérant ne se paie pas), pour qui, les 3 moteurs, ce que contient ' +
    'et ne contient pas l\'accompagnement, la séance type, les 10 séances, le cadre, les objections.', '20 min'),
  parcours: lecon('bp6-parcours', 'Parcours du Closing à J+180', 'doc-parcours-business-phenix.html',
    'Parcours Client — Business Phénix',
    'Ce qu\'on fait avec le client, jour par jour : closing, onboarding, RDV audit business, les 10 séances sur les ' +
    '3 moteurs, le bilan et la fin à J+180.', '10 min'),
  tarifs: lecon('bp6-tarifs', 'Tarifs et Paiement Business', 'doc-tarifs-phenix.html',
    'Tarifs et paiements — Business & Elite',
    'Toutes les mensualités prêtes à lire : BP PIF, BP MENS de 2 à 6 fois, en HT et en TTC, et ce qui est encaissé ' +
    'à la signature. Elite sur la même page.', '5 min'),
  comparatif: lecon('bp6-comparatif', 'Business ou Elite : le comparatif', 'doc-comparatif-phenix.html',
    'Business ou Elite : le comparatif',
    'La question qui tranche, les deux offres ligne à ligne, deux histoires de dirigeants, la zone grise et les phrases ' +
    'à ne pas dire.', '10 min'),
  parcoursCoach: lecon('bp6-parcours-coach', 'Parcours client Business — du closing au jour 180', 'doc-parcours-business-phenix.html',
    'Parcours Client — Business Phénix',
    'Le chemin complet du client Business, de la signature à J+180 : qui fait quoi, à quel moment.', '10 min')
};

const str = function (v) { return v && 'stringValue' in v ? v.stringValue : ''; };
const fields = function (v) { return (v && v.mapValue && v.mapValue.fields) || {}; };
const arr = function (v) { return (v && v.arrayValue && v.arrayValue.values) || []; };
const idOf = function (v) { return str(fields(v).id); };
function setArr(f, k, vals) { f[k] = { arrayValue: { values: vals } }; }

/* Insère `item` après l'élément d'id `apres` (sinon à la fin), s'il n'y est pas. */
function inserer(list, item, apres) {
  if (list.some(function (x) { return idOf(x) === idOf(item); })) return false;
  const i = list.findIndex(function (x) { return idOf(x) === apres; });
  if (i >= 0) list.splice(i + 1, 0, item); else list.push(item);
  return true;
}

async function traiter(fid, edit) {
  const t = await R.token();
  const doc = await R.request('GET', BASE + '/formations/' + fid, { Authorization: 'Bearer ' + t });
  const mods = arr(doc.fields.modules);
  const log = [];
  edit(mods, log);
  console.log('\n## ' + fid + ' — ' + (log.length ? log.length + ' changement(s)' : 'rien à faire'));
  log.forEach(function (l) { console.log('   ' + l); });
  if (!log.length || !APPLY) return;
  await R.request('PATCH', BASE + '/formations/' + fid + '?updateMask.fieldPaths=modules&currentDocument.updateTime=' + encodeURIComponent(doc.updateTime),
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { fields: { modules: { arrayValue: { values: mods } } } });
  console.log('   ✓ écrit');
}

(async function () {
  console.log(APPLY ? '=== ÉCRITURE (--apply) ===' : '=== À BLANC (lecture seule) ===');

  await traiter('closing-lab', function (mods, log) {
    const m = mods.find(function (x) { return idOf(x) === 'n217'; });
    if (!m) { log.push('✗ module « Les formations Adrien&Emily » (n217) introuvable — rien fait'); return; }
    const kids = arr(fields(m).children).slice();
    if (inserer(kids, L.comparatif, 'bp6-doc-offre')) log.push('+ « Business ou Elite : le comparatif » (après le document d\'offre)');
    const sub = kids.find(function (x) { return idOf(x) === 'n222'; });
    if (sub) {
      const ls = arr(fields(sub).lessons).slice();
      if (inserer(ls, L.methode, 'bp6-onboarding')) log.push('+ Business Phénix › « La méthode Business Phénix »');
      if (inserer(ls, L.parcours, 'bp6-methode')) log.push('+ Business Phénix › « Parcours du Closing à J+180 »');
      if (inserer(ls, L.tarifs, 'bp6-parcours')) log.push('+ Business Phénix › « Tarifs et Paiement Business »');
      /* Même ordre que le sous-module Elite : onboarding, méthode, parcours, tarifs, puis le reste. */
      const ordre = ['bp6-onboarding', 'bp6-methode', 'bp6-parcours', 'bp6-tarifs'];
      const avant = ls.map(idOf).join(',');
      ls.sort(function (a, b) {
        const ia = ordre.indexOf(idOf(a)), ib = ordre.indexOf(idOf(b));
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      if (ls.map(idOf).join(',') !== avant) log.push('↕ Business Phénix : ordre aligné sur Elite (' + ls.map(function (x) { return str(fields(x).title); }).join(' · ') + ')');
      setArr(fields(sub), 'lessons', ls);
    } else log.push('✗ sous-module « Business Phénix » (n222) introuvable');
    const elite = kids.find(function (x) { return idOf(x) === 'n227'; });
    const tarifsElite = elite && arr(fields(elite).lessons).find(function (x) { return idOf(x) === 'n226'; });
    if (tarifsElite) {
      const f = fields(tarifsElite), res = arr(f.resources).slice();
      if (!res.some(function (r) { return /doc-tarifs-phenix/.test(str(fields(r).url)); })) {
        res.push(R.enc({ title: 'Tableau des tarifs — toutes les mensualités', url: SITE + 'doc-tarifs-phenix.html#elite' }));
        setArr(f, 'resources', res);
        log.push('+ Elite › « Tarifs et Paiement Elite » : lien vers le tableau des tarifs (image conservée)');
      }
    }
    setArr(fields(m), 'children', kids);
  });

  await traiter('coach-lab', function (mods, log) {
    const m = mods.find(function (x) { return idOf(x) === 'bp6-ressources-coachs'; });
    if (!m) { log.push('✗ module Business du Coach LAB introuvable'); return; }
    const kids = arr(fields(m).children).slice();
    if (inserer(kids, L.parcoursCoach, 'bp6-guide-coach')) log.push('+ « Parcours client Business — du closing au jour 180 » (après le guide)');
    setArr(fields(m), 'children', kids);
  });

  console.log(APPLY ? '\n✓ Terminé.' : '\nÀ blanc terminé — relancer avec --apply pour écrire.');
})().catch(function (e) { console.error('✗ ERREUR :', e && e.message); process.exit(1); });
