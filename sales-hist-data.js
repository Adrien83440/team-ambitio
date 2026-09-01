// ============================================================================
// sales-hist-data.js
// ----------------------------------------------------------------------------
// Données historiques de performance commerciale, antérieures à la bascule
// sur Firestore. Chargé par sales-dashboard.html ET sales-projections.html.
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// Ces données étaient recopiées dans les deux pages, la seconde portant le
// commentaire « miroir du dashboard ». Les deux copies avaient divergé :
// 22 valeurs sur 275. Les montants concordaient, mais `leads` et
// `tempsAppel` manquaient côté projections — et sales-projections.html lit
// `d.leads || 0`, donc tous les mois historiques y comptaient zéro lead
// pendant que le dashboard affichait 133, 191, 178.
//
// Une seule copie, un seul endroit à corriger. Ne pas réintroduire de
// définition locale de HIST_DATA dans une page : c'est exactement ce qui a
// produit la divergence.
//
// `var` et non `const` : le fichier est chargé en script classique avant
// les blocs inline des deux pages, qui référencent HIST_DATA par son nom.
// ============================================================================

var HIST_DATA = {
  guillaume: {
    closing: {
      'Juillet 2025':   { calls:23,lives:20,offres:14,closes:6,hardClose:6,followUp:0,contracte:33020.4,collecte:3342.4 },
      'Août 2025':      { calls:39,lives:25,offres:20,closes:4,hardClose:4,followUp:0,contracte:30282.0,collecte:1998.75 },
      'Septembre 2025': { calls:18,lives:11,offres:8,closes:2,hardClose:2,followUp:0,contracte:11512.8,collecte:959.4 },
      'Octobre 2025':   { calls:9,lives:9,offres:8,closes:1,hardClose:1,followUp:0,contracte:5756.4,collecte:479.7 },
      'Novembre 2025':  { calls:5,lives:2,offres:1,closes:1,hardClose:1,followUp:0,contracte:2300.0,collecte:1149.0 },
      'Décembre 2025':  { calls:0,lives:0,offres:0,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0 },
      'Janvier 2026':   { calls:10,lives:5,offres:4,closes:2,hardClose:2,followUp:0,contracte:14400,collecte:720 },
    },
    closing_weekly: {
      'Février 2026': {
        s1:{calls:8,lives:2,offres:1,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0},
        s2:{calls:8,lives:4,offres:2,closes:2,hardClose:2,followUp:0,contracte:12000,collecte:1000},
        s3:{calls:8,lives:6,offres:2,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0},
        s4:{calls:10,lives:7,offres:3,closes:1,hardClose:1,followUp:0,contracte:7200,collecte:600},
      },
    },
    setting: {
      'Janvier 2026': { tempsAppel:0,leads:0,calls:225,decroches:51,propRdv:8,sets:8,presents:6,closes:2,collecte:0 },
    },
    setting_weekly: {
      'Février 2026': {
        s1:{tempsAppel:5,leads:133,calls:231,decroches:56,propRdv:13,sets:9,presents:2,closes:0,collecte:0},
        s2:{tempsAppel:7,leads:191,calls:324,decroches:54,propRdv:17,sets:11,presents:4,closes:2,collecte:1000},
        s3:{tempsAppel:3,leads:178,calls:312,decroches:43,propRdv:24,sets:17,presents:7,closes:0,collecte:0},
        s4:{tempsAppel:3,leads:49,calls:16,decroches:23,propRdv:7,sets:4,presents:7,closes:1,collecte:600},
      },
    },
  },
  elodie: {
    closing: {
      'Juillet 2025':   { calls:29,lives:24,offres:19,closes:7,hardClose:7,followUp:0,contracte:22748.6,collecte:13629.0 },
      'Août 2025':      { calls:28,lives:19,offres:14,closes:5,hardClose:5,followUp:0,contracte:28782.0,collecte:799.5 },
      'Septembre 2025': { calls:24,lives:17,offres:10,closes:2,hardClose:2,followUp:0,contracte:11512.8,collecte:959.4 },
      'Octobre 2025':   { calls:8,lives:2,offres:2,closes:1,hardClose:1,followUp:0,contracte:5756.4,collecte:239.85 },
      'Novembre 2025':  { calls:13,lives:7,offres:3,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0 },
      'Décembre 2025':  { calls:16,lives:10,offres:8,closes:1,hardClose:1,followUp:0,contracte:5756.4,collecte:399.75 },
      'Janvier 2026':   { calls:46,lives:28,offres:13,closes:7,hardClose:7,followUp:0,contracte:34069.2,collecte:3966.12 },
    },
    closing_weekly: {
      'Février 2026': {
        s1:{calls:11,lives:2,offres:1,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0},
        s2:{calls:14,lives:7,offres:2,closes:0,hardClose:0,followUp:0,contracte:0,collecte:0},
        s3:{calls:15,lives:2,offres:2,closes:1,hardClose:0,followUp:0,contracte:6000,collecte:6000},
        s4:{calls:9,lives:5,offres:0,closes:2,hardClose:0,followUp:0,contracte:9600,collecte:1400},
      },
    },
    setting: {
      'Décembre 2025': { tempsAppel:0,leads:0,calls:81,decroches:27,propRdv:15,sets:15,presents:4,closes:0,collecte:0 },
      'Janvier 2026':  { tempsAppel:0,leads:0,calls:470,decroches:112,propRdv:64,sets:39,presents:17,closes:6,collecte:0 },
    },
    setting_weekly: {
      'Février 2026': {
        s1:{tempsAppel:9,leads:33,calls:165,decroches:30,propRdv:10,sets:7,presents:0,closes:0,collecte:0},
        s2:{tempsAppel:8,leads:50,calls:162,decroches:20,propRdv:10,sets:8,presents:2,closes:0,collecte:0},
        s3:{tempsAppel:0,leads:56,calls:122,decroches:15,propRdv:13,sets:11,presents:5,closes:0,collecte:0},
        s4:{tempsAppel:0,leads:22,calls:65,decroches:7,propRdv:3,sets:2,presents:2,closes:1,collecte:0},
      },
    },
  },
};
