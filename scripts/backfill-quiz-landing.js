// ============================================================================
// scripts/backfill-quiz-landing.js — provenance des leads du funnel quiz
// ----------------------------------------------------------------------------
// Contexte (28/09/2026) : les premiers leads du funnel quiz system.io sont
// arrivés AVANT que api/lead-optin.js ne pose la page d'entrée sur la fiche
// (landingFirst / landingLast, via 'optin'). Sans elle, le funnel ne peut
// rattacher au quiz ni ces leads, ni un RDV qu'ils prendraient sans le
// paramètre `lp` (e-mail, setter). Ce script pose ce que lead-optin aurait
// écrit, et rien d'autre.
//
// Cible : leads portant `quizSubmittedAt` et SANS landingFirst.page.
// Écrit  : landingFirst (si absent), landingLast, et sourceDetail lorsqu'il
//          vaut encore « VSL Élite » / « VSL Business » (libellé posé par
//          erreur avant le correctif). Aucun autre champ n'est touché.
//
// Deux temps (règle du repo) :
//   node scripts/backfill-quiz-landing.js            # LECTURE SEULE : liste
//   node scripts/backfill-quiz-landing.js --apply    # écrit, après validation
//
// Clé : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Accès REST natif (scripts/_firestore-rest.js) : firebase-admin bloque
// sous Node 26 depuis Claude Code.
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;

function landingFor(lead) {
  const biz = String(lead.type || '').indexOf('business') >= 0;
  const page = biz ? 'quiz_business' : 'quiz_elite';
  const out = {
    page: page,
    variant: null,
    label: biz ? 'Funnel Quiz Business' : 'Funnel Quiz Élite',
    via: 'optin',
    capturedAt: lead.quizSubmittedAt || new Date().toISOString(),
    backfilledAt: new Date().toISOString()
  };
  const url = lead.attributionFirst && lead.attributionFirst.landingPage;
  if (url) out.pageUrl = String(url).slice(0, 500);
  return out;
}

(async function () {
  setTimeout(function () { console.error('TIMEOUT 120 s'); process.exit(2); }, 120000);
  const leads = await R.runQuery({
    from: [{ collectionId: 'leads' }],
    where: R.ff('quizSubmittedAt', 'GREATER_THAN_OR_EQUAL', new Date('2026-01-01T00:00:00Z')),
    limit: 1000
  });
  console.log((APPLY ? '[APPLY] ' : '[DRY-RUN] ') + leads.length + ' lead(s) avec quizSubmittedAt');
  let todo = 0, done = 0;
  for (const x of leads) {
    const l = x.data;
    if (l._merged === true) { console.log('  · ' + x.id + ' — _merged, ignoré'); continue; }
    if (l.landingFirst && l.landingFirst.page) { console.log('  · ' + x.id + ' — déjà ' + l.landingFirst.page + ', ignoré'); continue; }
    const landing = landingFor(l);
    const fields = { landingFirst: landing, landingLast: landing };
    const mask = ['landingFirst', 'landingLast'];
    const sd = String(l.sourceDetail || '');
    if (sd === 'VSL Élite' || sd === 'VSL Business') { fields.sourceDetail = landing.label; mask.push('sourceDetail'); }
    todo++;
    console.log('  → ' + x.id + ' | ' + (l.email || l.telephone || '?') + ' | type=' + l.type + ' | sourceDetail=' + sd
      + ' | quiz le ' + (l.quizSubmittedAt || '?') + '\n      écrirait : ' + JSON.stringify(fields));
    if (APPLY) {
      await R.patchDoc(x.path.split('/documents/')[1], fields, mask);
      done++;
      console.log('      ✔ écrit');
    }
  }
  console.log((APPLY ? 'Écrits : ' + done : 'À écrire : ' + todo) + ' / ' + leads.length);
  process.exit(0);
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
