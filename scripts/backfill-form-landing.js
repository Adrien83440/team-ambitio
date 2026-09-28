// ============================================================================
// scripts/backfill-form-landing.js — provenance des leads AlteoForms (VSL A)
// ----------------------------------------------------------------------------
// Contexte (28/09/2026) : jusqu'à ce jour, api/alteoform-submit.js ne posait
// pas la page d'entrée (lp / v de la VSL) sur la fiche. Seule la prise de RDV
// la posait ensuite — un prospect qui remplissait le formulaire sans réserver
// n'était compté nulle part comme « formulaire rempli ». Ce script relit
// l'URL de la page du formulaire mémorisée dans attributionFirst.landingPage
// (…alteoforms-render.html?id=…&lp=vsl_elite&v=a…) et pose ce que
// alteoform-submit aurait écrit : landingFirst { page, variant, via:'optin' }.
//
// Cible : leads `source == 'alteoform'` créés depuis le 23/09/2026 dont
//         landingFirst manque ou n'a pas `via` (posé par la réservation, après
//         le formulaire). Aucun autre champ touché ; landingLast conservé.
// Sans lp dans l'URL (ancienne page d'opt-in) → ignoré, jamais deviné.
//
//   node scripts/backfill-form-landing.js            # LECTURE SEULE
//   node scripts/backfill-form-landing.js --apply    # écrit, après validation
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');
const APPLY = process.argv.indexOf('--apply') >= 0;
const LABELS = { vsl_elite: 'VSL Élite', vsl_business: 'VSL Business', quiz_elite: 'Funnel Quiz Élite', quiz_business: 'Funnel Quiz Business', elite: 'Opt-in Élite', business: 'Opt-in Business' };

function landingFromUrl(url) {
  if (!url) return null;
  let sp;
  try { sp = new URL(String(url)).searchParams; } catch (e) { return null; }
  const page = String(sp.get('lp') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const variant = String(sp.get('v') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!page) return null;
  return { page, variant: variant || null, label: LABELS[page] || page, via: 'optin', pageUrl: String(url).slice(0, 500) };
}

(async function () {
  setTimeout(function () { console.error('TIMEOUT 120 s'); process.exit(2); }, 120000);
  let rows = await R.runQuery({
    from: [{ collectionId: 'leads' }],
    /* Un seul filtre serveur (createdAt) : source + createdAt exigerait un
       index composite. Le tri sur `source` se fait ici. */
    where: R.ff('createdAt', 'GREATER_THAN_OR_EQUAL', new Date('2026-09-23T00:00:00Z')),
    limit: 1000
  });
  rows = rows.filter(function (x) { return x.data.source === 'alteoform'; });
  console.log((APPLY ? '[APPLY] ' : '[DRY-RUN] ') + rows.length + ' lead(s) AlteoForm depuis le 23/09');
  let todo = 0, done = 0;
  for (const x of rows) {
    const l = x.data;
    if (l._merged === true) { console.log('  · ' + x.id + ' — _merged, ignoré'); continue; }
    if (l.landingFirst && l.landingFirst.page && l.landingFirst.via) { console.log('  · ' + x.id + ' — déjà ' + l.landingFirst.page + ' (via ' + l.landingFirst.via + '), ignoré'); continue; }
    const landing = landingFromUrl(l.attributionFirst && l.attributionFirst.landingPage);
    if (!landing) { console.log('  · ' + x.id + ' — pas de lp dans l\'URL du formulaire, ignoré'); continue; }
    landing.capturedAt = l.formSubmittedAt || l.createdAt || new Date().toISOString();
    landing.backfilledAt = new Date().toISOString();
    const fields = { landingFirst: landing }, mask = ['landingFirst'];
    if (!l.landingLast || !l.landingLast.page) { fields.landingLast = landing; mask.push('landingLast'); }
    todo++;
    console.log('  → ' + x.id + ' | ' + (l.email || '?') + ' | formulaire le ' + (l.formSubmittedAt || '?') + ' | landingFirst actuel : ' + (l.landingFirst ? l.landingFirst.page + '/' + (l.landingFirst.variant || '-') + ' sans via' : 'absent')
      + '\n      écrirait : ' + JSON.stringify(fields));
    if (APPLY) { await R.patchDoc(x.path.split('/documents/')[1], fields, mask); done++; console.log('      ✔ écrit'); }
  }
  console.log((APPLY ? 'Écrits : ' + done : 'À écrire : ' + todo) + ' / ' + rows.length);
  process.exit(0);
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
