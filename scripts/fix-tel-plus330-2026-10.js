// ============================================================================
// scripts/fix-tel-plus330-2026-10.js — rattrapage du 20/10/2026
// ----------------------------------------------------------------------------
// Des fiches portent un téléphone « +330XXXXXXXXX » : le 0 national saisi
// derrière l'indicatif (AlteoForms enregistrait la saisie telle quelle,
// corrigé le même jour). Conséquence : WhatsApp ouvrait une conversation
// fantôme (330768307932 au lieu de 33768307932, fiche Meyer) et les rappels
// automatiques partaient vers ce numéro inexistant.
//
// Ce script remet UNIQUEMENT le champ `telephone` au format canonique E.164
// (+33XXXXXXXXX), plus une ligne de timeline qui explique la correction.
// phoneNormalized (9 derniers chiffres) est déjà juste et n'est pas touché.
// Un numéro qui ne donne pas 9 chiffres après +33 une fois le 0 retiré est
// seulement signalé, jamais modifié : il faut le corriger à la main.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-tel-plus330-2026-10.js            # dry-run
//   ... node scripts/fix-tel-plus330-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const rows = await R.runQuery({
    from: [{ collectionId: 'leads' }],
    where: { compositeFilter: { op: 'AND', filters: [R.ff('telephone', 'GREATER_THAN_OR_EQUAL', '+330'), R.ff('telephone', 'LESS_THAN', '+331')] } },
  });
  console.log(rows.length + ' fiche(s) en « +330… »\n');

  let ok = 0, manuel = 0;
  for (const r of rows) {
    const L = r.data;
    const avant = String(L.telephone || '');
    const reste = avant.slice(4);
    if (!/^\d{9}$/.test(reste)) {
      manuel++;
      console.log('⚠️  leads/' + r.id + ' — ' + (L.nom || '?') + ' : ' + avant + ' → numéro incomplet, à corriger à la main');
      continue;
    }
    const apres = '+33' + reste;
    ok++;
    console.log('✏️  leads/' + r.id + ' — ' + (L.nom || '?') + (L._merged ? ' (fusionnée)' : '') + ' : ' + avant + ' → ' + apres);
    if (!APPLY) continue;

    const timeline = (L.timeline_history || []).slice();
    timeline.push({
      text: '🔧 Téléphone remis au format +33 : ' + avant + ' → ' + apres + ' (0 en trop après l\'indicatif, WhatsApp visait un numéro inexistant)',
      date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
      color: '#94a3b8',
    });
    const fields = { telephone: apres, timeline_history: timeline, updatedAt: new Date() };
    await R.patchDoc('leads/' + r.id, fields, Object.keys(fields));
  }

  console.log('\n' + ok + ' à corriger, ' + manuel + ' à reprendre à la main.');
  if (!APPLY) console.log('(dry-run) Relancer avec --apply pour écrire.');
  else console.log('✅ ' + ok + ' fiche(s) corrigée(s).');
})().catch(function (e) { console.error('❌', e.message); process.exit(1); });
