// ============================================================================
// scripts/fix-landing-tronquee-2026-11.js — provenance des leads du quiz Élite
// coupée par la limite de 500 caractères (constat du 07/11/2026)
// ----------------------------------------------------------------------------
// Cause : le quiz ajoute lp=funnel-quizz-elite__optin-a&v=… à la FIN de
// page_url. Avec un fbclid et des utm longs, l'URL dépassait 500 caractères ;
// api/lead-optin.js coupait AVANT de lire lp → page « funnel-quizz-elite__o »,
// « __opti »… et variante perdue (corrigé dans lead-optin le 07/11/2026).
// Si la coupe tombait avant « lp= », la page était déduite « quiz_elite ».
//
// Ce script répare landingFirst / landingLast des leads concernés :
//   page      → funnel-quizz-elite__optin-a
//   label, tunnelId, stepId, stepLabel → ceux du tunnel (comme un lead sain)
//   variant   → laissé tel quel (null) : il est perdu, on ne l'invente pas
//   repairNote → trace d'audit
// Cas « quiz_elite » : seulement si pageUrl fait EXACTEMENT 500 caractères,
// pointe vers adrienemily.com/optin-a et ne contient pas « lp= » (coupure
// certaine). Les vrais anciens leads « quiz_elite » ne sont pas touchés.
//
//   node scripts/fix-landing-tronquee-2026-11.js            # DRY-RUN : liste, aucune écriture
//   node scripts/fix-landing-tronquee-2026-11.js --apply    # écrit (après validation d'Adrien)
//
// Écritures (--apply) : leads/{id}, champs landingFirst.* / landingLast.*
// listés uniquement (updateMask), jamais le reste du document.
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Idempotent : un landing déjà réparé (page complète) n'est plus listé.
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const PAGE = 'funnel-quizz-elite__optin-a';
const FIX = {
  page: PAGE,
  label: 'Funnel Quizz - Elite',
  tunnelId: '5ccT9HbJtp3hBpCLiSm5',
  stepId: 'st_muglgenjxgcy8',
  stepLabel: 'Funnel quizz + VSL'
};
const SINCE = new Date('2026-09-25T00:00:00Z');   // création du tunnel

/* Préfixe strict de la vraie clé (« funnel-quizz-elite__o » … « __optin- »). */
function isTruncatedKey(p) {
  p = String(p || '');
  return p.length > 'funnel-quizz-elite__'.length && p.length < PAGE.length && PAGE.indexOf(p) === 0;
}
function isCutQuizElite(L) {
  if (!L || L.page !== 'quiz_elite') return false;
  const u = String(L.pageUrl || '');
  return u.length === 500 && /adrienemily\.com\/optin-a/i.test(u) && u.indexOf('lp=') < 0;
}
function needsFix(L) { return !!L && (isTruncatedKey(L.page) || isCutQuizElite(L)); }

async function main() {
  console.log(APPLY ? '── APPLY ──' : '── DRY-RUN (aucune écriture) ──');
  const rows = await R.runQuery({ from: [{ collectionId: 'leads' }], where: R.ff('createdAt', 'GREATER_THAN_OR_EQUAL', SINCE) });
  const jobs = [];
  rows.forEach(function (r) {
    const d = r.data;
    if (d._merged) return;
    const parts = ['landingFirst', 'landingLast'].filter(function (k) { return needsFix(d[k]); });
    if (parts.length) jobs.push({ id: r.id, d: d, parts: parts });
  });
  console.log(rows.length + ' leads lus depuis le ' + SINCE.toISOString().slice(0, 10) + ' · ' + jobs.length + ' à réparer\n');
  jobs.forEach(function (j) {
    console.log('  ' + j.id + '  créé ' + String(j.d.createdAt).slice(0, 10) + '  '
      + j.parts.map(function (k) { return k + ' « ' + j.d[k].page + ' »'; }).join(', ') + '  → « ' + PAGE + ' » (variante inconnue)');
  });
  if (!jobs.length) { console.log('Rien à faire.'); return; }
  if (!APPLY) { console.log('\nRelance avec --apply pour écrire (champs landing uniquement).'); return; }

  const at = new Date().toISOString();
  let n = 0;
  for (const j of jobs) {
    const fields = {}, paths = [];
    j.parts.forEach(function (k) {
      const before = j.d[k].page;
      fields[k] = Object.assign({}, FIX, { repairNote: 'lp tronqué (« ' + before + ' ») réparé le ' + at.slice(0, 10) + ', variante perdue', repairedAt: at });
      Object.keys(fields[k]).forEach(function (f) { paths.push(k + '.' + f); });
    });
    await R.patchDoc('leads/' + j.id, fields, paths);
    n++;
  }
  console.log('\n' + n + ' lead(s) réparé(s).');
}

main().catch(function (e) { console.error(e && e.message ? e.message : e); process.exit(1); });
