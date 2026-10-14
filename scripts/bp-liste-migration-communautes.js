// ============================================================================
// scripts/bp-liste-migration-communautes.js — 14/10/2026
// ----------------------------------------------------------------------------
// Liste de migration des communautés WhatsApp (refonte Business Phénix,
// cahier des charges §10 et §11.10) : qui va dans la communauté Elite
// (Le Cercle), qui va dans la communauté Business.
//
// LECTURE SEULE : le script lit la collection `clients` (projection limitée
// aux champs utiles) et n'écrit RIEN dans Firestore. Sa seule sortie est un
// fichier CSV local ; il refuse d'écraser un fichier existant.
//
// Colonnes : nom, email, téléphone, programme, statut, coach, communauté cible
//   communauté cible = « Elite » si le programme contient « elite »
//                      (insensible à la casse), sinon « Business »
//                      (nouveau format comme ancienne formule).
// Par défaut, les fiches inactives (statut 'inactif' ou actif === false),
// les anciens clients (ancienClient === true) et les fiches fusionnées
// (_merged === true) sont ignorées. --tous inclut inactifs et anciens
// clients (les fiches fusionnées restent toujours ignorées).
//
// Format : séparateur « ; » et BOM UTF-8, pour une ouverture directe dans
// Excel / Numbers en français.
//
// ⚠️ Le CSV contient des données personnelles : le garder HORS du repo
//    (ou ne pas le committer) et le supprimer une fois la migration faite.
//
// Usage :
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/bp-liste-migration-communautes.js                 # ./migration-communautes-AAAA-MM-JJ.csv
//   ... node scripts/bp-liste-migration-communautes.js ~/Desktop/liste.csv
//   ... node scripts/bp-liste-migration-communautes.js --tous
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./_firestore-rest.js');

const ARGS = process.argv.slice(2);
const TOUS = ARGS.indexOf('--tous') >= 0;
const SORTIE_ARG = ARGS.filter(function (a) { return a.indexOf('--') !== 0; })[0] || '';

const CHAMPS = ['nom', 'email', 'telephone', 'tel', 'programme', 'statut', 'actif',
  'ancienClient', 'coach', 'coachNom', 'coachName', '_merged'];

function aujourdhui() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function cheminSortie() {
  if (!SORTIE_ARG) return path.join(process.cwd(), 'migration-communautes-' + aujourdhui() + '.csv');
  const p = SORTIE_ARG.replace(/^~(?=$|\/)/, process.env.HOME || '');
  return path.resolve(process.cwd(), p);
}

function txt(v) { return v == null ? '' : String(v).trim(); }

function celluleCsv(v) {
  const s = txt(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function communauteCible(programme) {
  return /elite/i.test(txt(programme)) ? 'Elite' : 'Business';
}

function statutLisible(c) {
  const parts = [];
  if (txt(c.statut)) parts.push(txt(c.statut));
  else if (c.actif === false) parts.push('inactif');
  if (c.ancienClient === true) parts.push('ancien client');
  return parts.join(' · ') || 'actif';
}

function estInactif(c) {
  return txt(c.statut).toLowerCase() === 'inactif' || c.actif === false || c.ancienClient === true;
}

async function run() {
  const sortie = cheminSortie();
  if (fs.existsSync(sortie)) {
    throw new Error('le fichier existe déjà, rien n\'est écrasé : ' + sortie);
  }

  console.log('=== LECTURE SEULE — aucune écriture Firestore ===');
  console.log('Lecture de la collection clients…');
  const docs = await R.runQuery({
    select: { fields: CHAMPS.map(function (f) { return { fieldPath: f }; }) },
    from: [{ collectionId: 'clients' }]
  });

  let fusionnes = 0, ignores = 0;
  const lignes = [];
  docs.forEach(function (d) {
    const c = d.data || {};
    if (c._merged === true) { fusionnes++; return; }
    if (!TOUS && estInactif(c)) { ignores++; return; }
    lignes.push({
      nom: txt(c.nom),
      email: txt(c.email),
      telephone: txt(c.telephone || c.tel),
      programme: txt(c.programme),
      statut: statutLisible(c),
      coach: txt(c.coach || c.coachNom || c.coachName),
      communaute: communauteCible(c.programme)
    });
  });

  lignes.sort(function (a, b) {
    if (a.communaute !== b.communaute) return a.communaute < b.communaute ? -1 : 1;
    return a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' });
  });

  const entete = ['nom', 'email', 'téléphone', 'programme', 'statut', 'coach', 'communauté cible'];
  const csv = '﻿' + [entete.join(';')].concat(lignes.map(function (l) {
    return [l.nom, l.email, l.telephone, l.programme, l.statut, l.coach, l.communaute].map(celluleCsv).join(';');
  })).join('\r\n') + '\r\n';

  // flag 'wx' : échoue si le fichier est apparu entre-temps (jamais d'écrasement).
  fs.writeFileSync(sortie, csv, { encoding: 'utf8', flag: 'wx' });

  const nbElite = lignes.filter(function (l) { return l.communaute === 'Elite'; }).length;
  const sansProgramme = lignes.filter(function (l) { return !l.programme; }).length;
  console.log('\nFiches lues        : ' + docs.length);
  console.log('Fusionnées ignorées: ' + fusionnes);
  console.log('Inactives / anciens: ' + (TOUS ? 'incluses (--tous)' : ignores + ' ignorées (ajouter --tous pour les inclure)'));
  console.log('Communauté Elite   : ' + nbElite);
  console.log('Communauté Business: ' + (lignes.length - nbElite));
  if (sansProgramme) console.log('⚠️  ' + sansProgramme + ' fiche(s) sans programme, classée(s) Business : à vérifier à la main.');
  console.log('\nCSV écrit : ' + sortie);
  console.log('⚠️  Données personnelles : ne pas committer ce fichier, le supprimer après la migration.');
}

run().catch(function (e) { console.error('ERREUR :', e.message || e); process.exit(1); });
