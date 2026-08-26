// ============================================================================
// scripts/whatsapp-export-templates.js — SAUVEGARDE DU COMPTE WHATSAPP ACTUEL
// ----------------------------------------------------------------------------
// LECTURE SEULE. N'écrit rien en base, n'appelle aucune API en écriture.
//
// POURQUOI CE SCRIPT EXISTE
// -------------------------
// Les définitions des modèles approuvés ne vivent QUE chez Meta. Le repo n'en
// garde aucune copie : `api/whatsapp-rappels-rdv.js` connaît le NOM d'un
// modèle et l'ORDRE de ses variables, jamais le texte que le client lit.
// Supprimer le compte WhatsApp Business sans exporter d'abord, c'est perdre
// les textes exacts qui ont passé l'examen Meta — et devoir les réinventer,
// donc repasser un examen sur un contenu différent.
//
// Une capture d'écran ne suffit pas : elle ne donne ni les identifiants des
// numéros (nécessaires pour les détacher), ni les sauts de ligne exacts, ni
// la configuration des boutons.
//
// À LANCER AVANT TOUTE SUPPRESSION CÔTÉ META.
//
// DEUX FAÇONS DE FOURNIR LES IDENTIFIANTS
// ---------------------------------------
//   A. Par l'environnement — aucune credential Google requise. C'est la voie
//      la plus courte : les deux valeurs se lisent dans la console Firebase,
//      document _config/whatsapp_credentials.
//
//        export WHATSAPP_TOKEN='EAA...'
//        export WHATSAPP_WABA_ID='123456789'
//        node scripts/whatsapp-export-templates.js
//
//   B. Depuis Firestore — pratique si la clé de service account est déjà en
//      place, et évite de manipuler le token à la main.
//
//        export GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
//        node scripts/whatsapp-export-templates.js
//
//   Option commune :  --out /chemin/dossier
//
// AUCUN SECRET DANS LA SORTIE : ni le token, ni l'appSecret, ni le
// verifyToken ne sont écrits dans le fichier ni affichés à l'écran.
// ============================================================================

const fs = require('fs');
const path = require('path');

function argValue(name, defaut) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
}

const OUT_DIR = argValue('--out', path.join(process.cwd(), 'whatsapp-backup'));

const ENV_TOKEN = (process.env.WHATSAPP_TOKEN || '').trim();
const ENV_WABA = (process.env.WHATSAPP_WABA_ID || '').trim();
const ENV_PHONE = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const ENV_VERSION = (process.env.WHATSAPP_API_VERSION || '').trim();

/* Appel Graph minimal, identique en esprit à api/_whatsappClient.js : on ne
   lance pas sur une erreur HTTP, on renvoie l'erreur Meta lisible. */
async function graph(creds, chemin) {
  const url = chemin.indexOf('https://') === 0
    ? chemin
    : 'https://graph.facebook.com/' + creds.apiVersion + '/' + chemin;
  let rep;
  try {
    rep = await fetch(url, { headers: { Authorization: 'Bearer ' + creds.token } });
  } catch (e) {
    return { ok: false, erreur: (e && e.message) || 'reseau' };
  }
  let data = null;
  try { data = await rep.json(); } catch (_) { data = null; }
  if (!rep.ok) {
    const err = (data && data.error) || {};
    return { ok: false, erreur: err.message || ('HTTP ' + rep.status), code: err.code || null };
  }
  return { ok: true, data: data };
}

/* Meta pagine à 100 modèles. On suit `paging.next` jusqu'au bout : un export
   tronqué serait pire qu'aucun export, parce qu'il aurait l'air complet. */
async function tousLesModeles(creds) {
  const champs = 'name,status,category,language,components,quality_score,'
               + 'rejected_reason,previous_category,id';
  let chemin = creds.wabaId + '/message_templates?limit=100&fields=' + champs;
  const tout = [];
  for (let garde = 0; garde < 20; garde++) {
    const rep = await graph(creds, chemin);
    if (!rep.ok) return { ok: false, erreur: rep.erreur, modeles: tout };
    const lot = (rep.data && rep.data.data) || [];
    for (let i = 0; i < lot.length; i++) tout.push(lot[i]);
    const suivant = rep.data && rep.data.paging && rep.data.paging.next;
    if (!suivant) return { ok: true, modeles: tout };
    chemin = suivant;
  }
  return { ok: true, modeles: tout, tronque: true };
}

/**
 * Les identifiants, par l'environnement si possible, sinon depuis Firestore.
 * `firebase-admin` n'est chargé que dans le second cas : le script doit
 * pouvoir tourner sur une machine sans clé de service account.
 */
async function chargerCreds() {
  if (ENV_TOKEN && ENV_WABA) {
    console.log('Identifiants : variables d\'environnement');
    return {
      token: ENV_TOKEN,
      wabaId: ENV_WABA,
      phoneNumberId: ENV_PHONE || '',
      apiVersion: ENV_VERSION || 'v25.0',
    };
  }
  if (ENV_TOKEN && !ENV_WABA) {
    throw new Error('WHATSAPP_TOKEN fourni sans WHATSAPP_WABA_ID — sans le compte, aucun modèle lisible.');
  }

  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    throw new Error('firebase-admin absent (npm install) et WHATSAPP_TOKEN non fourni.');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
    throw new Error(
      'Aucune credential Google, et WHATSAPP_TOKEN / WHATSAPP_WABA_ID non fournis.\n'
      + '  → le plus court : lire _config/whatsapp_credentials dans la console Firebase, puis\n'
      + '      export WHATSAPP_TOKEN=\'EAA...\'\n'
      + '      export WHATSAPP_WABA_ID=\'...\''
    );
  }

  console.log('Identifiants : Firestore (_config/whatsapp_credentials)');
  admin.initializeApp({ projectId: 'ambitio-team' });
  const snap = await admin.firestore().collection('_config').doc('whatsapp_credentials').get();
  if (!snap.exists) throw new Error('_config/whatsapp_credentials introuvable');
  const d = snap.data() || {};
  if (!d.token) throw new Error('whatsapp_credentials.token manquant');
  if (!d.wabaId) throw new Error('whatsapp_credentials.wabaId manquant — sans lui, aucun modèle lisible');
  return {
    token: String(d.token),
    wabaId: String(d.wabaId),
    phoneNumberId: String(d.phoneNumberId || ''),
    apiVersion: d.apiVersion ? String(d.apiVersion) : 'v25.0',
  };
}

async function main() {
  const creds = await chargerCreds();

  console.log('Compte WhatsApp Business : ' + creds.wabaId);
  console.log('Numéro configuré         : ' + (creds.phoneNumberId || '(non fourni)'));
  console.log('');

  /* Le compte lui-même : nom, devise, état d'examen. Utile pour recréer à
     l'identique, et pour vérifier qu'on exporte bien le bon compte. */
  const compte = await graph(creds, creds.wabaId
    + '?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status');
  if (compte.ok) {
    const c = compte.data || {};
    console.log('Nom du compte : ' + (c.name || '?'));
    console.log('Examen        : ' + (c.account_review_status || '?'));
  } else {
    console.log('⚠️  Compte illisible : ' + compte.erreur);
  }

  /* Les numéros rattachés : c'est ce qu'il faudra détacher avant de pouvoir
     reprendre le même numéro sur un autre compte. */
  const numeros = await graph(creds, creds.wabaId
    + '/phone_numbers?limit=50&fields=id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status');
  const listeNumeros = numeros.ok ? ((numeros.data && numeros.data.data) || []) : [];
  if (numeros.ok) {
    console.log('');
    console.log('Numéros rattachés (' + listeNumeros.length + ') :');
    for (let i = 0; i < listeNumeros.length; i++) {
      const n = listeNumeros[i];
      console.log('  · ' + (n.display_phone_number || '?')
        + '  id=' + n.id
        + '  nom=' + (n.verified_name || '?')
        + '  qualité=' + (n.quality_rating || '?')
        + '  plateforme=' + (n.platform_type || '?'));
    }
  } else {
    console.log('⚠️  Numéros illisibles : ' + numeros.erreur);
  }

  const res = await tousLesModeles(creds);
  const modeles = res.modeles || [];
  console.log('');
  console.log('Modèles exportés : ' + modeles.length + (res.ok ? '' : ' (INCOMPLET : ' + res.erreur + ')'));
  if (res.tronque) console.log('⚠️  Pagination interrompue au bout de 20 pages.');

  for (let i = 0; i < modeles.length; i++) {
    const m = modeles[i];
    const comps = m.components || [];
    const corps = comps.filter(function (c) { return String(c.type).toUpperCase() === 'BODY'; })[0];
    const entete = comps.filter(function (c) { return String(c.type).toUpperCase() === 'HEADER'; })[0];
    const pied = comps.filter(function (c) { return String(c.type).toUpperCase() === 'FOOTER'; })[0];
    const boutons = comps.filter(function (c) { return String(c.type).toUpperCase() === 'BUTTONS'; })[0];

    console.log('');
    console.log('  ── ' + m.name + '  [' + m.language + '] ' + m.status + ' · ' + m.category);
    if (entete && entete.text) console.log('     EN-TÊTE : ' + entete.text);
    console.log('     ' + String((corps && corps.text) || '').replace(/\n/g, '\n     '));
    if (pied && pied.text) console.log('     PIED : ' + pied.text);
    if (boutons && Array.isArray(boutons.buttons)) {
      for (let b = 0; b < boutons.buttons.length; b++) {
        const bt = boutons.buttons[b];
        console.log('     BOUTON : ' + (bt.type || '?') + ' « ' + (bt.text || '?') + ' »'
          + (bt.url ? ' → ' + bt.url : ''));
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const horodatage = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fichier = path.join(OUT_DIR, 'whatsapp-export-' + horodatage + '.json');
  fs.writeFileSync(fichier, JSON.stringify({
    exporteLe: new Date().toISOString(),
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId || null,
    apiVersion: creds.apiVersion,
    compte: compte.ok ? compte.data : { erreur: compte.erreur },
    numeros: numeros.ok ? listeNumeros : { erreur: numeros.erreur },
    modelesComplets: res.ok,
    modeles: modeles,
  }, null, 2), 'utf8');

  console.log('');
  console.log('→ ' + fichier);
  console.log('  (à conserver hors du repo une fois la bascule terminée)');
}

main().then(function () { process.exit(0); })
      .catch(function (e) { console.error('ÉCHEC : ' + ((e && e.message) || e)); process.exit(1); });
