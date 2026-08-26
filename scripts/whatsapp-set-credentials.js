// ============================================================================
// scripts/whatsapp-set-credentials.js — BASCULE DE _config/whatsapp_credentials
// ----------------------------------------------------------------------------
// Vérifie les identifiants du NOUVEAU compte WhatsApp Business auprès de Meta,
// puis — si une clé de service account est disponible — les écrit en base.
// Dry-run par défaut, comme tout script d'écriture de ce repo.
//
// CE QU'IL VÉRIFIE AVANT D'ÉCRIRE — et pourquoi
// ---------------------------------------------
//   · le token est-il VALIDE, et PERMANENT (expires_at = 0) ?
//     Un temporaire de 24 h et un permanent commencent tous deux par `EAA` et
//     sont indiscernables à l'œil. Écrire un temporaire, c'est une panne
//     totale du canal le lendemain, sans rien avoir changé entre-temps.
//   · le `phoneNumberId` appartient-il bien au `wabaId` fourni ?
//     Un modèle n'est utilisable que par les numéros de SON compte. Deux
//     identifiants qui ne désignent pas le même compte se lisent séparément
//     sans erreur, et chaque envoi échoue ensuite sur un « template not
//     found » que personne ne rattache à sa cause.
//   · le numéro est-il ENREGISTRÉ sur l'API Cloud ?
//     Sinon `platform_type` vaut NOT_APPLICABLE : c'est normal juste après la
//     création, et c'est api/whatsapp-register-number.js qui le corrige. On
//     le signale sans bloquer.
//
// Une vérification qui échoue interrompt tout. C'est le but : mieux vaut un
// script qui refuse qu'un canal muet qu'on débogue trois jours.
//
// DEUX MODES
// ----------
//   A. VÉRIFICATION SEULE — aucune credential Google requise.
//      Les vérifications tournent, puis le script affiche exactement les
//      champs à saisir à la main dans la console Firebase. C'est le mode
//      retenu automatiquement quand aucune clé de service account n'est
//      disponible, et il se force avec --verifier.
//
//        export WHATSAPP_TOKEN='EAA...'
//        node scripts/whatsapp-set-credentials.js \
//          --waba-id 123456789 --phone-number-id 987654321
//
//   B. ÉCRITURE EN BASE — avec la clé de service account.
//
//        export GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
//        export WHATSAPP_TOKEN='EAA...'
//        node scripts/whatsapp-set-credentials.js \
//          --waba-id 123456789 --phone-number-id 987654321            # dry-run
//        node scripts/whatsapp-set-credentials.js \
//          --waba-id 123456789 --phone-number-id 987654321 --execute
//
//      L'interrupteur des rappels se bascule seul, sans toucher au reste :
//        node scripts/whatsapp-set-credentials.js --rappels off --execute
//        node scripts/whatsapp-set-credentials.js --rappels on  --execute
//
// LE TOKEN NE S'ÉCRIT JAMAIS DANS LES TRACES
// ------------------------------------------
// Ni à l'écran, ni tronqué, ni « juste le préfixe ». Il ne passe pas non plus
// en argument de ligne de commande — l'historique du shell le garderait en
// clair. Il se transmet par variable d'environnement.
//
// L'ANCIENNE CONFIGURATION EST ARCHIVÉE, JAMAIS ÉCRASÉE
// ----------------------------------------------------
// Copie intégrale dans _config/whatsapp_credentials/historique/{date} avant
// toute écriture. Cette sous-collection n'est couverte par AUCUN bloc de
// firestore.rules — les règles ne cascadent jamais — elle est donc fermée à
// tout accès client, ce qui est exactement ce qu'on veut pour des secrets.
//
// ⚠️ APRÈS L'ÉCRITURE : api/_whatsappClient.js met les identifiants en cache
// au niveau module, vidé au seul cold start. Une instance Vercel déjà chaude
// continue d'utiliser l'ANCIEN token. Il faut donc redéployer (un push suffit)
// pour que la bascule soit effective partout tout de suite.
// ============================================================================

const EXECUTE = process.argv.indexOf('--execute') >= 0;
const FORCE_VERIF = process.argv.indexOf('--verifier') >= 0;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]).trim() : null;
}

const WABA_ID = argValue('--waba-id');
const PHONE_NUMBER_ID = argValue('--phone-number-id');
const API_VERSION = argValue('--api-version');
const RAPPELS = argValue('--rappels');            /* 'on' | 'off' | null */
const TOKEN = (process.env.WHATSAPP_TOKEN || '').trim() || null;

if (process.argv.indexOf('--token') >= 0) {
  console.error('Le token ne se passe pas en argument : l\'historique du shell le garderait.');
  console.error('Utiliser :  export WHATSAPP_TOKEN=\'EAA...\'');
  process.exit(1);
}
if (RAPPELS && RAPPELS !== 'on' && RAPPELS !== 'off') {
  console.error('--rappels attend « on » ou « off ».');
  process.exit(1);
}
if (!TOKEN && !WABA_ID && !PHONE_NUMBER_ID && !API_VERSION && !RAPPELS) {
  console.error('Rien à faire. Voir l\'en-tête du fichier pour l\'usage.');
  process.exit(1);
}

/* Firestore n'est joignable que si une credential existe. Sans elle on ne
   renonce pas : on vérifie quand même, et on dicte quoi saisir à la main. */
const CREDS_GOOGLE = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_CONFIG);
const MODE_VERIF = FORCE_VERIF || !CREDS_GOOGLE;

async function graph(token, version, chemin) {
  const url = 'https://graph.facebook.com/' + version + '/' + chemin;
  let rep;
  try {
    rep = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
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

/* Ce qu'on peut dire d'un secret sans le divulguer : sa présence et sa
   longueur. Rien de plus. */
function empreinte(valeur) {
  if (!valeur) return 'absent';
  return 'présent (' + String(valeur).length + ' caractères)';
}

/**
 * Les trois vérifications auprès de Meta.
 * @returns {Promise<string|null>} le motif de blocage, ou null si tout va bien
 */
async function verifier(token, version, wabaId, phoneNumberId) {
  let bloquant = null;
  console.log('=== VÉRIFICATIONS AUPRÈS DE META ===');

  const dbg = await graph(token, version, 'debug_token?input_token=' + encodeURIComponent(token));
  if (!dbg.ok) {
    console.log('  ✗ token       : introspection impossible — ' + dbg.erreur);
    bloquant = 'token_illisible';
  } else {
    const d = (dbg.data && dbg.data.data) || {};
    const exp = Number(d.expires_at || 0);
    const comptes = (Array.isArray(d.granular_scopes) ? d.granular_scopes : [])
      .filter(function (g) { return g && String(g.scope || '').indexOf('whatsapp_business') === 0; })
      .reduce(function (acc, g) { return acc.concat(Array.isArray(g.target_ids) ? g.target_ids : []); }, []);

    if (d.is_valid !== true) {
      console.log('  ✗ token       : invalide');
      bloquant = 'token_invalide';
    } else if (exp !== 0) {
      console.log('  ✗ token       : TEMPORAIRE, expire le ' + new Date(exp * 1000).toISOString());
      console.log('                  → générer un token d\'utilisateur système, sans expiration');
      bloquant = 'token_temporaire';
    } else {
      console.log('  ✓ token       : valide et permanent (app ' + (d.app_id || '?') + ')');
    }

    if (comptes.length && comptes.indexOf(wabaId) < 0) {
      console.log('  ✗ portée      : ce token ne pilote pas ' + wabaId);
      console.log('                  comptes accessibles : ' + comptes.join(', '));
      bloquant = bloquant || 'waba_hors_portee';
    } else if (comptes.length) {
      console.log('  ✓ portée      : le token pilote bien ' + wabaId);
    }
  }

  const nums = await graph(token, version, wabaId
    + '/phone_numbers?limit=50&fields=id,display_phone_number,verified_name,platform_type,quality_rating');
  if (!nums.ok) {
    console.log('  ✗ compte      : numéros illisibles — ' + nums.erreur);
    bloquant = bloquant || 'waba_illisible';
  } else {
    const liste = (nums.data && nums.data.data) || [];
    const trouve = liste.filter(function (n) { return String(n.id) === phoneNumberId; })[0];
    if (!trouve) {
      console.log('  ✗ numéro      : ' + phoneNumberId + ' n\'appartient PAS au compte ' + wabaId);
      console.log('                  numéros du compte : ' + (liste.map(function (n) {
        return (n.display_phone_number || '?') + ' (' + n.id + ')';
      }).join(', ') || 'aucun'));
      bloquant = bloquant || 'numero_hors_compte';
    } else {
      console.log('  ✓ numéro      : ' + (trouve.display_phone_number || '?')
        + ' — « ' + (trouve.verified_name || '?') + ' »');
      /* Non bloquant : juste après la création, l'enregistrement sur l'API
         Cloud n'a pas encore eu lieu. C'est l'étape suivante, pas une erreur. */
      if (String(trouve.platform_type || '').toUpperCase() !== 'CLOUD_API') {
        console.log('  ⚠ plateforme  : ' + (trouve.platform_type || 'NOT_APPLICABLE')
          + ' — numéro pas encore enregistré sur l\'API Cloud');
        console.log('                  → POST /api/whatsapp-register-number après cette bascule');
      } else {
        console.log('  ✓ plateforme  : CLOUD_API');
      }
    }
  }
  console.log('');
  return bloquant;
}

function suite() {
  console.log('');
  console.log('SUITE :');
  console.log('  1. redéployer (un push suffit) — les instances Vercel chaudes');
  console.log('     gardent l\'ancien token en cache module');
  console.log('  2. POST /api/whatsapp-subscribe        (abonner l\'app au nouveau compte)');
  console.log('  3. POST /api/whatsapp-register-number  { pin }');
  console.log('  4. GET  /api/whatsapp-diagnostic       (tout doit être vert)');
  console.log('  5. GET  /api/whatsapp-rappels-rdv?dryRun=1');
  console.log('  6. rallumer rappelsActifs');
}

/* ── MODE A : vérification seule, sans Firestore ────────────────────────── */
async function modeVerification() {
  if (RAPPELS) {
    console.error('--rappels écrit en base : il exige la clé de service account.');
    console.error('Sans elle, basculer rappelsActifs à la main dans la console Firebase');
    console.error('(_config/whatsapp_credentials).');
    process.exit(1);
  }
  if (!TOKEN || !WABA_ID || !PHONE_NUMBER_ID) {
    console.error('Mode vérification : WHATSAPP_TOKEN, --waba-id et --phone-number-id');
    console.error('sont tous les trois requis.');
    process.exit(1);
  }

  const version = API_VERSION || 'v25.0';
  console.log('Mode VÉRIFICATION SEULE — aucune credential Google, rien ne sera écrit.');
  console.log('');
  const bloquant = await verifier(TOKEN, version, WABA_ID, PHONE_NUMBER_ID);
  if (bloquant) {
    console.error('INTERROMPU : ' + bloquant + '. Ne rien saisir en base tant que ce point n\'est pas réglé.');
    process.exit(1);
  }

  console.log('=== À SAISIR DANS LA CONSOLE FIREBASE ===');
  console.log('  Document : _config/whatsapp_credentials');
  console.log('');
  console.log('  token         : (le contenu de WHATSAPP_TOKEN, ' + String(TOKEN).length + ' caractères)');
  console.log('  wabaId        : ' + WABA_ID);
  console.log('  phoneNumberId : ' + PHONE_NUMBER_ID);
  console.log('  apiVersion    : ' + version);
  console.log('  rappelsActifs : false   ← à repasser à true seulement après le diagnostic');
  console.log('');
  console.log('  appSecret et verifyToken : NE PAS Y TOUCHER.');
  console.log('  Le premier appartient à l\'app Meta, que tu gardes ; le second est');
  console.log('  choisi par nous et rejoué tel quel par Meta. Les changer casserait');
  console.log('  le webhook sans rien apporter.');
  suite();
}

/* ── MODE B : écriture en base ──────────────────────────────────────────── */
async function modeEcriture() {
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: 'ambitio-team' });
  const REF = admin.firestore().collection('_config').doc('whatsapp_credentials');

  const snap = await REF.get();
  const actuel = snap.exists ? (snap.data() || {}) : {};

  const version = API_VERSION || (actuel.apiVersion ? String(actuel.apiVersion) : 'v25.0');
  const tokenEffectif = TOKEN || (actuel.token ? String(actuel.token) : null);
  const wabaEffectif = WABA_ID || (actuel.wabaId ? String(actuel.wabaId) : null);
  const phoneEffectif = PHONE_NUMBER_ID || (actuel.phoneNumberId ? String(actuel.phoneNumberId) : null);

  console.log('=== CONFIGURATION ACTUELLE ===');
  console.log('  wabaId        : ' + (actuel.wabaId || '(absent)'));
  console.log('  phoneNumberId : ' + (actuel.phoneNumberId || '(absent)'));
  console.log('  apiVersion    : ' + (actuel.apiVersion || 'v25.0 (défaut)'));
  console.log('  token         : ' + empreinte(actuel.token));
  console.log('  appSecret     : ' + empreinte(actuel.appSecret) + '  ← inchangé, propriété de l\'app Meta');
  console.log('  verifyToken   : ' + empreinte(actuel.verifyToken) + '  ← inchangé, choisi par nous');
  console.log('  rappelsActifs : ' + (actuel.rappelsActifs === true));
  console.log('');

  const patch = {};
  if (TOKEN) patch.token = TOKEN;
  if (WABA_ID) patch.wabaId = WABA_ID;
  if (PHONE_NUMBER_ID) patch.phoneNumberId = PHONE_NUMBER_ID;
  if (API_VERSION) patch.apiVersion = API_VERSION;
  if (RAPPELS) patch.rappelsActifs = RAPPELS === 'on';

  console.log('=== CE QUI SERAIT ÉCRIT ===');
  const cles = Object.keys(patch);
  for (let i = 0; i < cles.length; i++) {
    const k = cles[i];
    if (k === 'token') {
      const identique = actuel.token && String(actuel.token) === TOKEN;
      console.log('  token         : ' + empreinte(TOKEN) + (identique ? '  (identique à l\'actuel)' : '  (nouveau)'));
    } else {
      console.log('  ' + k + new Array(Math.max(1, 14 - k.length)).join(' ') + ': ' + patch[k]);
    }
  }
  if (!cles.length) console.log('  (aucun champ)');
  console.log('');

  /* Vérifications sautées si on ne fait que basculer l'interrupteur des
     rappels : aucun identifiant ne change, il n'y a rien à revalider. */
  const identifiantsTouches = !!(TOKEN || WABA_ID || PHONE_NUMBER_ID || API_VERSION);
  if (identifiantsTouches) {
    if (!tokenEffectif) { console.error('Aucun token, ni fourni ni en base.'); process.exit(1); }
    if (!wabaEffectif) { console.error('Aucun wabaId, ni fourni ni en base.'); process.exit(1); }
    if (!phoneEffectif) { console.error('Aucun phoneNumberId, ni fourni ni en base.'); process.exit(1); }

    const bloquant = await verifier(tokenEffectif, version, wabaEffectif, phoneEffectif);
    if (bloquant) {
      console.error('INTERROMPU : ' + bloquant + '. Rien n\'a été écrit.');
      process.exit(1);
    }
  }

  if (!EXECUTE) {
    console.log('DRY-RUN — rien n\'a été écrit. Relancer avec --execute pour appliquer.');
    return;
  }

  /* Archive AVANT écriture. Sans elle, un token perdu chez Meta et écrasé ici
     serait irrécupérable des deux côtés. */
  if (snap.exists) {
    const cle = new Date().toISOString().replace(/[:.]/g, '-');
    await REF.collection('historique').doc(cle).set(Object.assign({}, actuel, {
      archiveLe: new Date().toISOString(),
      archivePar: 'scripts/whatsapp-set-credentials.js',
    }));
    console.log('Ancienne configuration archivée : _config/whatsapp_credentials/historique/' + cle);
  }

  await REF.set(patch, { merge: true });
  console.log('Écrit : ' + cles.join(', '));
  if (identifiantsTouches) suite();
}

(MODE_VERIF ? modeVerification() : modeEcriture())
  .then(function () { process.exit(0); })
  .catch(function (e) { console.error('ÉCHEC : ' + ((e && e.message) || e)); process.exit(1); });
