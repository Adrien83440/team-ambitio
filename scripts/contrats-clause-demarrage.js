#!/usr/bin/env node
// ============================================================================
// scripts/contrats-clause-demarrage.js — CLAUSE « DÉMARRAGE CONVENU » (30/10/2026)
// ----------------------------------------------------------------------------
// Ajoute aux contrats clients une clause qui n'apparaît QUE si le closer a
// fixé une date de démarrage différé (pilote de closing → variable
// date_demarrage, pré-remplie dans la fenêtre d'envoi). Sans date, le contrat
// reste strictement identique.
//
// ⚖️ À FAIRE RELIRE PAR L'AVOCAT AVANT --apply : les contrats disent aujourd'hui
// que le démarrage a lieu à la signature (case de renonciation) ou à la fin du
// délai de 14 jours. La case parle d'« ouverture immédiate » : sa rédaction
// devra peut-être s'adapter quand une date est fixée.
//
// Sans option : À BLANC, rien n'est écrit (règle CLAUDE.md n°3).
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/contrats-clause-demarrage.js
//   … --apply   → écrit, après validation d'Adrien. Rejouable : un modèle qui
//                 porte déjà la clause est ignoré.
// ============================================================================
'use strict';
const { runQuery, patchDoc, createDoc } = require('./_firestore-rest.js');

const APPLY = process.argv.includes('--apply');
const CIBLES = /^(EP6|BP12|Business Phénix 6 mois)/;
const VARIABLE = { key: 'date_demarrage', label: 'Date de démarrage différé', type: 'date', filledBy: 'equipe', required: false, requiredIf: '', help: 'Uniquement si le client démarre plus tard. Pré-rempli par le pilote de closing.' };
const CLAUSE = 'if:date_demarrage:p:**Démarrage convenu.** Par accord des parties et à la demande du CLIENT, l’ouverture de ses accès et le démarrage de l’accompagnement sont fixés au {{var:date_demarrage}}. La durée prévue au présent article court à compter de cette date. Ce report est sans effet sur le prix, les échéances et les modalités de paiement, qui s’appliquent dès la signature. Le démarrage peut être avancé d’un commun accord.';

(async function () {
  const rows = await runQuery({ from: [{ collectionId: 'signature_templates' }] });
  let n = 0;
  for (const r of rows) {
    const d = r.data || {}, nom = d.name || d.title || r.id, web = d.web;
    if (!CIBLES.test(nom) || !web || !Array.isArray(web.sections)) continue;
    if (JSON.stringify(web).indexOf('date_demarrage') >= 0) { console.log('déjà en place :', nom); continue; }
    const sec = web.sections.find(function (s) { return /DUR[ÉE]E/i.test(s.title || ''); });
    if (!sec) { console.log('⚠️  pas d\'article Durée, ignoré :', nom); continue; }
    const apres = sec.blocks.findIndex(function (b) { return /à compter/i.test(b); });
    const pos = apres >= 0 ? apres + 1 : sec.blocks.length;
    console.log('\n' + (APPLY ? 'ÉCRIT' : 'À BLANC') + ' — ' + nom + ' (' + r.id + ')');
    console.log('  variable : ' + VARIABLE.key + ' · ' + sec.title + ', après le bloc ' + (pos - 1));
    console.log('  après    : ' + String(sec.blocks[pos - 1] || '').slice(0, 110) + '…');
    n++;
    if (!APPLY) continue;
    /* Comme l'Atelier (api/contract-studio.js) : nouvelle version + copie dans
       versions/, pour pouvoir revenir en arrière. Écriture ciblée : le reste du
       modèle n'est pas réencodé. Un contrat déjà envoyé garde sa copie figée
       (webSnapshot), il n'est pas concerné. */
    web.variables = (web.variables || []).concat([VARIABLE]);
    sec.blocks.splice(pos, 0, CLAUSE);
    web.version = (web.version || 1) + 1;
    web.savedAt = new Date().toISOString();
    web.savedBy = 'scripts/contrats-clause-demarrage.js';
    await patchDoc('signature_templates/' + r.id, {
      web: { variables: web.variables, sections: web.sections, version: web.version, savedAt: web.savedAt, savedBy: web.savedBy },
      updatedAt: new Date(),
    }, ['web.variables', 'web.sections', 'web.version', 'web.savedAt', 'web.savedBy', 'updatedAt']);
    await createDoc('signature_templates/' + r.id + '/versions/' + String(web.version).padStart(4, '0'), {
      version: web.version, name: nom, web: web, note: 'Clause optionnelle « Démarrage convenu » (démarrage différé)',
      by: web.savedBy, at: new Date(), atIso: web.savedAt,
    });
  }
  console.log('\nClause : ' + CLAUSE.replace(/^if:date_demarrage:p:/, ''));
  console.log('\n' + n + ' modèle(s) ' + (APPLY ? 'mis à jour.' : 'concerné(s). Rien n\'a été écrit — relancer avec --apply après validation.'));
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
