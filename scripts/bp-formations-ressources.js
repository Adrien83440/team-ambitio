// ============================================================================
// scripts/bp-formations-ressources.js — 14/10/2026
// ----------------------------------------------------------------------------
// Refonte Business Phénix (cahier des charges §11.1 e) : ressources du module
// Formations internes (collection `formations/{id}`, voir formations-core.js).
//
//   1. Closing LAB (closing-lab) : module « Business Phénix — nouveau format
//      (6 mois) » avec 4 leçons « ressource » (page HTML du repo affichée dans
//      la leçon + lien en ressource) :
//        - document d'offre unique   doc-offre-phenix.html
//        - Avatars Business / Elite  doc-avatars-phenix.html
//        - brief closers             doc-briefs-business-phenix.html#brief-closers
//        - process d'onboarding      process-onboarding-business-closer.html
//   2. Coach LAB (coach-lab) : même module, 1 leçon vers
//      doc-guide-coach-business-phenix.html.
//   3. Repère, dans les trois LABs, les leçons / classeurs qui parlent de
//      Business 12 mois (BP12, « Business … 12 mois », 9 piliers, ancienne
//      page onboarding5k) et propose de les DÉPLACER dans un module
//      « Archives — ancienne formule Business 12 mois » de la même formation.
//      Jamais de suppression : un déplacement garde la leçon intacte (valeur
//      Firestore brute, id conservé → la progression des membres suit).
//      Les modules / sous-modules vidés restent en place.
//
// DRY-RUN PAR DÉFAUT : affiche le plan, n'écrit rien. --apply écrit.
//
// Options :
//   --apply                 écrit (après validation du dry-run par Adrien)
//   --sans-deplacement      n'archive rien, ajoute seulement les ressources
//   --deplacer=id1,id2      n'archive que ces ids (parmi les candidats affichés)
//   --brouillon             crée le module de ressources en brouillon
//
// Sûreté (même mécanique que add-lesson-langage-dirigeants.js) :
//   - valeurs Firestore BRUTES : les autres leçons ne sont ni décodées ni
//     ré-encodées (aucun double, timestamp ou null altéré) ;
//   - écriture limitée à `modules` + `updatedAt` (updateMask) ;
//   - précondition currentDocument.updateTime : si la formation a été
//     modifiée dans le builder entre la lecture et l'écriture, rien n'est écrit ;
//   - idempotent : ids fixes (préfixe bp6-), déjà présents → ignorés ;
//     une leçon déjà dans le module d'archives n'est plus candidate.
//
// Usage :
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/bp-formations-ressources.js            # dry-run
//   ... node scripts/bp-formations-ressources.js --apply
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const SITE = 'https://team.alteore.com/';

const APPLY = process.argv.indexOf('--apply') >= 0;
const SANS_DEPLACEMENT = process.argv.indexOf('--sans-deplacement') >= 0;
const BROUILLON = process.argv.indexOf('--brouillon') >= 0;
const DEPLACER_ARG = (process.argv.find(function (a) { return a.indexOf('--deplacer=') === 0; }) || '').slice(11);
const DEPLACER = DEPLACER_ARG ? DEPLACER_ARG.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : null;

const MODULE_TITRE = 'Business Phénix — nouveau format (6 mois)';
const ARCHIVE_ID = 'archives-bp12';
const ARCHIVE_TITRE = 'Archives — ancienne formule Business 12 mois';

function lecon(id, title, file, htmlTitle, body, duration) {
  return {
    kind: 'lesson', id: id, title: title, status: 'published',
    video: '', image: '', audio: '', thumbnail: '',
    duration: duration || '',
    body: body,
    resources: [{ title: htmlTitle, url: SITE + file }],
    html: SITE + file,
    htmlTitle: htmlTitle
  };
}

const RESSOURCES = {
  'closing-lab': {
    moduleId: 'bp6-ressources-closers',
    lessons: [
      lecon('bp6-doc-offre', 'Document d\'offre — Business Phénix & Elite Phénix', 'doc-offre-phenix.html',
        'Document d\'offre unique',
        'Le support à garder ouvert pendant le rendez-vous de closing : la question qui tranche, ' +
        'Business Phénix (3 moteurs, 10 séances, cadre, prix BP PIF / BP MENS), Elite Phénix ' +
        '(prix EP PIF / EP MENS), le comparatif et le parcours client.', '15 min'),
      lecon('bp6-avatars', 'Avatars Business / Elite — qui va où', 'doc-avatars-phenix.html',
        'Avatars Business Phénix · Elite Phénix',
        'Règle de bascule (le dirigeant se paie-t-il correctement ?), critères, zone grise, ' +
        'plancher Business, profils types et hors cible. L\'argent n\'est pas un motif de disqualification.', '10 min'),
      lecon('bp6-brief-closers', 'Brief closers — nouveau format Business Phénix', 'doc-briefs-business-phenix.html#brief-closers',
        'Brief closers',
        'Les règles de closing du nouveau format : une seule offre, jamais les deux ; nomenclature ' +
        'BP PIF / BP MENS / EP PIF / EP MENS ; 6 mensualités maximum sur Business.', '10 min'),
      lecon('bp6-onboarding', 'Process d\'onboarding Business Phénix', 'process-onboarding-business-closer.html',
        'Process onboarding Business Phénix',
        'Après la signature : RDV audit business sous 72 h, WhatsApp des liens, groupe de bienvenue, ' +
        'puis Marine prend le relais. Messages prêts à copier.', '5 min')
    ]
  },
  'coach-lab': {
    moduleId: 'bp6-ressources-coachs',
    lessons: [
      lecon('bp6-guide-coach', 'Guide du coach — Business Phénix', 'doc-guide-coach-business-phenix.html',
        'Guide du coach Business Phénix',
        'Le nouveau format Business : l\'offre face à Elite, le cadre, les règles de comportement, ' +
        'le RDV audit business, la séance type, les 10 séances, les jalons et la trame de compte rendu.', '25 min')
    ]
  },
  'setting-lab': null // scanné pour les archives uniquement
};

// Repérage de l'ancienne formule.
const MOTIFS = [
  { rx: /\bBP\s?-?12\b/i, lib: 'BP12' },
  { rx: /business[^.\n]{0,60}\b(12|douze)\s*mois/i, lib: 'Business … 12 mois' },
  { rx: /\b(12|douze)\s*mois\b[^.\n]{0,60}business/i, lib: '12 mois … Business' },
  { rx: /\b(9|neuf)\s*piliers\b/i, lib: '9 piliers' },
  { rx: /onboarding5k/i, lib: 'onboarding5k' }
];

/* ─── Accès aux valeurs Firestore brutes ─────────────────────────────── */
function str(v) { return v && 'stringValue' in v ? v.stringValue : ''; }
function fields(v) { return (v && v.mapValue && v.mapValue.fields) || {}; }
function arr(v) { return (v && v.arrayValue && v.arrayValue.values) || []; }
function setArr(mapFields, key, values) { mapFields[key] = { arrayValue: { values: values } }; }
function norm(s) { return String(s || '').trim().toLowerCase(); }

/* Tout le texte « lisible » d'une leçon ou d'un classeur. */
function texteDe(v) {
  const f = fields(v);
  const parts = [str(f.title), str(f.body), str(f.htmlTitle), str(f.html), str(f.intro), str(f.video)];
  arr(f.resources).forEach(function (r) { parts.push(str(fields(r).title), str(fields(r).url)); });
  arr(f.sections).forEach(function (s) {
    parts.push(str(fields(s).title));
    arr(fields(s).files).forEach(function (x) { parts.push(str(fields(x).title), str(fields(x).note), str(fields(x).url)); });
  });
  return parts.join('\n');
}
function motifs(texte) {
  return MOTIFS.filter(function (m) { return m.rx.test(texte); }).map(function (m) { return m.lib; });
}

function contientId(mods, id) {
  return mods.some(function (m) {
    if (str(fields(m).id) === id) return true;
    return arr(fields(m).children).some(function (c) {
      if (str(fields(c).id) === id) return true;
      return arr(fields(c).lessons).some(function (l) { return str(fields(l).id) === id; });
    });
  });
}

/* Candidats à l'archivage : [{ id, titre, kind, mi, si|null, li, motifs, origine }] */
function candidats(mods) {
  const out = [];
  mods.forEach(function (m, mi) {
    const mf = fields(m);
    if (str(mf.id) === ARCHIVE_ID || norm(str(mf.title)) === norm(ARCHIVE_TITRE)) return;
    const mMotifs = motifs(str(mf.title));
    arr(mf.children).forEach(function (c, ci) {
      const cf = fields(c);
      if (str(cf.id).indexOf('bp6-') === 0) return;
      if (str(cf.kind) === 'sub') {
        const sMotifs = motifs(str(cf.title));
        arr(cf.lessons).forEach(function (l, li) {
          const lf = fields(l);
          if (str(lf.id).indexOf('bp6-') === 0) return;
          const tous = mMotifs.concat(sMotifs, motifs(texteDe(l)));
          if (!tous.length) return;
          out.push({ id: str(lf.id), titre: str(lf.title), kind: str(lf.kind) || 'lesson', mi: mi, si: ci, li: li,
            motifs: tous.filter(function (x, i) { return tous.indexOf(x) === i; }),
            origine: str(mf.title) + ' / ' + str(cf.title), origineId: str(mf.id) + '-' + str(cf.id) });
        });
      } else {
        const tous = mMotifs.concat(motifs(texteDe(c)));
        if (!tous.length) return;
        out.push({ id: str(cf.id), titre: str(cf.title), kind: str(cf.kind) || 'lesson', mi: mi, si: null, li: ci,
          motifs: tous.filter(function (x, i) { return tous.indexOf(x) === i; }),
          origine: str(mf.title), origineId: str(mf.id) + '-racine' });
      }
    });
  });
  return out;
}

function planOf(mods) {
  return mods.map(function (m) {
    const mf = fields(m);
    const kids = arr(mf.children).map(function (c) {
      const cf = fields(c);
      if (str(cf.kind) === 'sub') {
        return ['     ▸ ' + str(cf.title)].concat(arr(cf.lessons).map(function (l) {
          return '         - ' + (str(fields(l).kind) || 'lesson') + ' ' + str(fields(l).title) + '  [' + str(fields(l).id) + ']';
        })).join('\n');
      }
      return '     - ' + (str(cf.kind) || 'lesson') + ' ' + str(cf.title) + '  [' + str(cf.id) + ']';
    });
    return ['   ■ ' + str(mf.title) + ' (' + (str(mf.status) || 'draft') + ')'].concat(kids).join('\n');
  }).join('\n');
}

async function traiter(t, fid) {
  const doc = await R.request('GET', BASE + '/formations/' + fid, { Authorization: 'Bearer ' + t })
    .catch(function (e) { if (/HTTP 404/.test(String(e.message))) return null; throw e; });
  console.log('\n══════════════════════════════════════════════════════════════');
  if (!doc) { console.log('## ' + fid + ' : formation introuvable — ignorée.'); return; }
  const mods = arr(doc.fields && doc.fields.modules);
  console.log('## ' + fid + ' (' + str(doc.fields.name) + ') — updateTime ' + doc.updateTime);

  const next = JSON.parse(JSON.stringify(mods));
  let change = false;

  /* 1. Ressources du nouveau format */
  const res = RESSOURCES[fid];
  if (res) {
    const manquantes = res.lessons.filter(function (l) { return !contientId(next, l.id); });
    if (!manquantes.length) {
      console.log('\n   Ressources : déjà présentes, rien à ajouter.');
    } else {
      let mi = next.findIndex(function (m) {
        return str(fields(m).id) === res.moduleId || norm(str(fields(m).title)) === norm(MODULE_TITRE);
      });
      if (mi < 0) {
        next.unshift(R.enc({ id: res.moduleId, title: MODULE_TITRE, status: BROUILLON ? 'draft' : 'published', children: [] }));
        mi = 0;
        console.log('\n   Ressources : création du module « ' + MODULE_TITRE + ' » en tête (' + (BROUILLON ? 'brouillon' : 'publié') + ').');
      } else {
        console.log('\n   Ressources : module « ' + str(fields(next[mi]).title) + ' » existant, complété.');
      }
      const mf = next[mi].mapValue.fields;
      const kids = arr(mf.children).slice();
      manquantes.forEach(function (l) {
        kids.push(R.enc(l));
        console.log('     + ' + l.title + '  →  ' + l.html);
      });
      setArr(mf, 'children', kids);
      change = true;
    }
  }

  /* 2. Leçons de l'ancienne formule → module d'archives */
  const cands = candidats(next);
  if (!cands.length) {
    console.log('\n   Ancienne formule : aucune leçon repérée.');
  } else {
    console.log('\n   Ancienne formule : ' + cands.length + ' élément(s) repéré(s) :');
    cands.forEach(function (c) {
      const retenu = !SANS_DEPLACEMENT && (!DEPLACER || DEPLACER.indexOf(c.id) >= 0);
      console.log('     ' + (retenu ? '→ archiver ' : '· garder   ') + c.kind + ' « ' + c.titre + ' »  [' + c.id + ']');
      console.log('         depuis : ' + c.origine + '   motifs : ' + c.motifs.join(', '));
    });
    const retenus = cands.filter(function (c) { return !SANS_DEPLACEMENT && (!DEPLACER || DEPLACER.indexOf(c.id) >= 0); });
    if (retenus.length) {
      // Extraction de la fin vers le début : les index restent valides.
      const extraits = retenus.slice().sort(function (a, b) {
        if (a.mi !== b.mi) return b.mi - a.mi;
        if ((a.si == null ? -1 : a.si) !== (b.si == null ? -1 : b.si)) return (b.si == null ? -1 : b.si) - (a.si == null ? -1 : a.si);
        return b.li - a.li;
      }).map(function (c) {
        const mf = next[c.mi].mapValue.fields;
        let val;
        if (c.si == null) {
          const list = arr(mf.children).slice();
          val = list.splice(c.li, 1)[0];
          setArr(mf, 'children', list);
        } else {
          const kids = arr(mf.children);
          const sf = kids[c.si].mapValue.fields;
          const list = arr(sf.lessons).slice();
          val = list.splice(c.li, 1)[0];
          setArr(sf, 'lessons', list);
        }
        return { c: c, val: val };
      }).reverse();

      let ai = next.findIndex(function (m) {
        return str(fields(m).id) === ARCHIVE_ID || norm(str(fields(m).title)) === norm(ARCHIVE_TITRE);
      });
      if (ai < 0) {
        next.push(R.enc({ id: ARCHIVE_ID, title: ARCHIVE_TITRE, status: 'published', children: [] }));
        ai = next.length - 1;
        console.log('\n     Création du module « ' + ARCHIVE_TITRE + ' » en fin de formation (publié : référence des clients existants).');
      }
      const af = next[ai].mapValue.fields;
      const achildren = arr(af.children).slice();
      extraits.forEach(function (x) {
        // Un sous-module d'archives par origine, pour retrouver d'où vient la leçon.
        const subId = 'arch-' + x.c.origineId;
        let si = achildren.findIndex(function (c) { return str(fields(c).id) === subId; });
        if (si < 0) {
          achildren.push(R.enc({ kind: 'sub', id: subId, title: x.c.origine, lessons: [] }));
          si = achildren.length - 1;
        }
        const sf = achildren[si].mapValue.fields;
        const ls = arr(sf.lessons).slice();
        ls.push(x.val);
        setArr(sf, 'lessons', ls);
      });
      setArr(af, 'children', achildren);
      change = true;
    }
  }

  if (!change) { console.log('\n   Rien à écrire.'); return; }
  console.log('\n   Plan après modification :');
  console.log(planOf(next));

  if (!APPLY) { console.log('\n   (dry-run : rien n\'est écrit)'); return; }
  const url = BASE + '/formations/' + fid +
    '?updateMask.fieldPaths=modules&updateMask.fieldPaths=updatedAt' +
    '&currentDocument.updateTime=' + encodeURIComponent(doc.updateTime);
  await R.request('PATCH', url, { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    { fields: { modules: { arrayValue: { values: next } }, updatedAt: { timestampValue: new Date().toISOString() } } });
  console.log('\n   ✓ écrit');
}

async function run() {
  console.log(APPLY ? '=== EXÉCUTION (--apply) ===' : '=== DRY-RUN (lecture seule) — ajouter --apply pour écrire ===');
  if (SANS_DEPLACEMENT) console.log('Option --sans-deplacement : aucune leçon ne sera archivée.');
  if (DEPLACER) console.log('Option --deplacer : seuls ' + DEPLACER.join(', ') + ' seront archivés.');
  const t = await R.token();
  for (const fid of Object.keys(RESSOURCES)) await traiter(t, fid);
}

run().catch(function (e) { console.error('ERREUR :', e.message || e); process.exit(1); });
