// ============================================================================
// scripts/sign-audience-migrate.js — ESPACE ADMIN DES SIGNATURES (09/10/2026)
// ----------------------------------------------------------------------------
// Pose le champ `audience` sur chaque modèle et chaque demande de signature :
//   · 'admin'  — contrats internes (setters, closers, coachs, attestations) :
//                lisibles par les seuls admins (règles Firestore) ;
//   · 'equipe' — contrats clients : lisibles par l'équipe, comme avant.
//
// Règle de classement : un modèle « Envoi rapide » (isAdhoc) est un document
// interne → admin ; un modèle permanent (BP12, EP…) est un contrat client →
// equipe. Une demande hérite de l'audience de son modèle. Une valeur déjà
// posée n'est jamais modifiée.
//
// Le champ doit exister sur TOUS les documents avant le déploiement des
// règles : les requêtes de l'équipe filtrent sur audience == 'equipe', et un
// document sans le champ disparaîtrait de leur vue.
//
// Règle n°3 : À BLANC PAR DÉFAUT. --apply pour écrire (updateMask : seul
// `audience` est touché).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/sign-audience-migrate.js [--apply]
// ============================================================================
'use strict';
const R = require('./_firestore-rest');
const APPLY = process.argv.indexOf('--apply') >= 0;

(async function () {
  console.log(APPLY ? '=== MODE ÉCRITURE ===' : '=== MODE À BLANC (aucune écriture) ===');
  const tpls = await R.runQuery({ from: [{ collectionId: 'signature_templates' }], select: { fields: [{ fieldPath: 'name' }, { fieldPath: 'isAdhoc' }, { fieldPath: 'audience' }] } });
  const reqs = await R.runQuery({ from: [{ collectionId: 'signature_requests' }], select: { fields: [{ fieldPath: 'templateId' }, { fieldPath: 'templateName' }, { fieldPath: 'clientName' }, { fieldPath: 'status' }, { fieldPath: 'audience' }, { fieldPath: 'isAdhoc' }] } });
  const aud = {};
  const writes = [];
  console.log('\n— MODÈLES —');
  tpls.forEach(function (d) {
    const T = d.data;
    const a = T.audience || (T.isAdhoc ? 'admin' : 'equipe');
    aud[d.id] = a;
    const tag = T.audience ? '(déjà posé)' : '→ ' + a;
    console.log((a === 'admin' ? '🔒' : '  ') + ' ' + (T.name || d.id).padEnd(45) + ' ' + tag);
    if (!T.audience) writes.push({ path: 'signature_templates/' + d.id, a: a });
  });
  console.log('\n— DEMANDES —');
  reqs.forEach(function (d) {
    const X = d.data;
    const a = X.audience || aud[X.templateId] || (X.isAdhoc ? 'admin' : 'equipe');
    const tag = X.audience ? '(déjà posé)' : '→ ' + a;
    if (a === 'admin' || !X.audience) console.log((a === 'admin' ? '🔒' : '  ') + ' ' + String(X.clientName || '').padEnd(28) + String(X.templateName || '').padEnd(45) + (X.status || '') + ' ' + tag);
    if (!X.audience) writes.push({ path: 'signature_requests/' + d.id, a: a });
  });
  const nAdmin = writes.filter(function (w) { return w.a === 'admin'; }).length;
  console.log('\n' + writes.length + ' document(s) à étiqueter, dont ' + nAdmin + ' en espace admin.');
  if (!APPLY) { console.log('Relancer avec --apply pour écrire.'); return; }
  for (const w of writes) await R.patchDoc(w.path, { audience: w.a }, ['audience']);
  console.log('→ écrit.');
})().catch(function (e) { console.error(e); process.exit(1); });
