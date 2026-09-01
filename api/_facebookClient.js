// ============================================================================
// api/_facebookClient.js — CLIENT FACEBOOK PAGES API (Meta en direct)
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// MÊME APPLICATION META QUE INSTAGRAM — et c'est un choix, pas une facilité
// ---------------------------------------------------------------------------
// La doctrine du repo isole les canaux (Twilio / WhatsApp, Instagram /
// WhatsApp). Ici on s'en écarte volontairement : le coût d'entrée d'une
// application Meta n'est pas sa création, c'est son passage en mode Live —
// obtenu le 01/09/2026 après plusieurs heures, et sans lequel l'API rend des
// données VIDES SANS ERREUR. Une seconde application repartirait de zéro.
// Facebook et Instagram, ici, sont le même compte, la même Page, la même
// équipe : les séparer protégerait de rien et coûterait cher.
//
// LE JETON DE PAGE N'EXPIRE PAS
// -----------------------------
// Dérivé d'un jeton utilisateur longue durée, un Page Access Token est
// permanent. Pas de rafraîchissement à 60 jours comme sur Instagram, donc
// pas de panne annoncée à deux mois. Il reste révocable — d'où la
// vérification d'échéance conservée dans le diagnostic.
//
// LES HELPERS DE TEXTE VIENNENT D'INSTAGRAM, EXPRÈS
// -------------------------------------------------
// `contientMotCle`, la normalisation, les dates et la signature webhook sont
// importés de _instagramClient.js plutôt que recopiés. Un « GO » doit avoir
// EXACTEMENT la même définition sur les deux réseaux : deux implémentations
// dériveraient, et deux compteurs qu'on additionne sans le savoir ne veulent
// plus rien dire. Ces fonctions ont demandé plusieurs corrections (graphies
// étirées, exclusion de la voix du compte) — les dupliquer, c'était
// promettre de refaire les mêmes erreurs d'un seul côté.
//
// AUCUNE DÉPENDANCE NPM : Node 20 fournit `fetch` et `crypto`.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const IG = require('./_instagramClient');

const GRAPH = 'https://graph.facebook.com';
const API_VERSION_DEFAUT = 'v23.0';

let _creds = null;

/**
 * Charge les identifiants depuis _config/facebook_credentials.
 * Lance si le document ou un champ vital manque : mieux vaut une erreur
 * explicite au premier appel qu'une synchro qui écrit du vide.
 */
async function getFacebookCreds(forceReload) {
  if (_creds && !forceReload) return _creds;

  const snap = await db.collection('_config').doc('facebook_credentials').get();
  if (!snap.exists) throw new Error('_config/facebook_credentials introuvable');

  const d = snap.data() || {};
  if (!d.token) throw new Error('facebook_credentials.token manquant');
  if (!d.pageId) throw new Error('facebook_credentials.pageId manquant');

  _creds = {
    pageId: String(d.pageId),
    token: String(d.token),
    appId: d.appId ? String(d.appId) : null,
    /* appSecret et verifyToken ne servent qu'au webhook : leur absence ne
       doit pas empêcher une lecture. C'est facebook-webhook.js qui refuse de
       tourner sans eux, et lui seul. */
    appSecret: d.appSecret ? String(d.appSecret) : null,
    verifyToken: d.verifyToken ? String(d.verifyToken) : null,
    apiVersion: d.apiVersion ? String(d.apiVersion) : API_VERSION_DEFAUT,
    /* Mots-clés partagés avec Instagram par défaut : la consigne « écris GO »
       est la même sous une publication, quel que soit le réseau. */
    keywords: Array.isArray(d.keywords) && d.keywords.length
      ? d.keywords.map((k) => IG.normaliserTexte(k)).filter(Boolean)
      : IG.KEYWORDS_DEFAUT,
    syncActif: d.syncActif !== false,
    pageNom: d.pageNom ? String(d.pageNom) : null,
  };
  return _creds;
}

function viderCacheCreds() { _creds = null; }

/* ══════════════════════════════════════════════════════════════════════
   APPEL GRAPH — un seul point de sortie réseau
   ══════════════════════════════════════════════════════════════════════ */

async function graphGet(chemin, params, creds) {
  const c = creds || (await getFacebookCreds());
  const url = new URL(GRAPH + '/' + c.apiVersion + '/' + String(chemin).replace(/^\//, ''));
  Object.keys(params || {}).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      url.searchParams.set(k, String(params[k]));
    }
  });
  url.searchParams.set('access_token', c.token);

  const rep = await fetch(url.toString());
  const txt = await rep.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch (_) { json = {}; }

  if (!rep.ok || json.error) {
    const e = json.error || {};
    const err = new Error('[graph ' + chemin + '] ' + (e.message || rep.status + ' ' + txt.slice(0, 200)));
    err.httpStatus = rep.status;
    err.metaCode = e.code != null ? e.code : null;
    err.metaSubcode = e.error_subcode != null ? e.error_subcode : null;
    err.metaType = e.type || null;
    throw err;
  }
  return json;
}

/**
 * Suit la pagination `paging.next` jusqu'à épuisement ou plafond.
 * Le plafond n'est pas décoratif : un post viral porte des milliers de
 * commentaires, et une serverless a 300 s pour vivre.
 */
async function graphGetPagine(chemin, params, creds, maxPages) {
  const c = creds || (await getFacebookCreds());
  const plafond = maxPages || 20;
  let page = await graphGet(chemin, params, c);
  let items = Array.isArray(page.data) ? page.data.slice() : [];
  let n = 1;
  while (page.paging && page.paging.next && n < plafond) {
    const rep = await fetch(page.paging.next);
    const txt = await rep.text();
    try { page = txt ? JSON.parse(txt) : {}; } catch (_) { page = {}; }
    if (page.error || !Array.isArray(page.data)) break;
    items = items.concat(page.data);
    n++;
  }
  return { items, tronque: !!(page.paging && page.paging.next && n >= plafond) };
}

/* ══════════════════════════════════════════════════════════════════════
   IDENTITÉ D'UN COMMENTATEUR
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Nom lisible d'un auteur Facebook.
 * Depuis 2018, Meta ne divulgue l'identité d'un commentateur que s'il utilise
 * l'application : `from` est souvent absent. Un commentaire anonyme reste un
 * signal parfaitement comptable — il ne peut simplement pas être rattaché à
 * une fiche. On ne fabrique jamais de nom pour combler le trou.
 */
function auteurDe(obj) {
  const f = obj && obj.from ? obj.from : null;
  if (!f) return { id: null, nom: null };
  return {
    id: f.id ? String(f.id) : null,
    nom: f.name ? String(f.name) : null,
  };
}

/**
 * Cherche une fiche lead par nom Facebook.
 * Ignore les documents `_merged: true` — motif pickAlive().
 * Ne lance jamais : un rattachement raté vaut mieux qu'une synchro morte.
 */
async function trouverLeadParNomFb(nom) {
  const n = (nom || '').trim();
  if (!n || n.length < 4) return null;   // un prénom seul créerait des faux positifs
  try {
    const snap = await db.collection('leads').where('nom', '==', n).limit(5).get();
    if (snap.empty) return null;
    let vivant = null;
    snap.forEach((doc) => {
      if (vivant) return;
      const d = doc.data() || {};
      if (d._merged === true) return;
      vivant = { id: doc.id, nom: d.nom || null };
    });
    return vivant;
  } catch (e) {
    console.warn('[facebook] trouverLeadParNomFb', e.message);
    return null;
  }
}

module.exports = {
  getFacebookCreds,
  viderCacheCreds,
  graphGet,
  graphGetPagine,
  auteurDe,
  trouverLeadParNomFb,
  /* Réexportés depuis Instagram — une seule définition, deux réseaux. */
  normaliserTexte: IG.normaliserTexte,
  contientMotCle: IG.contientMotCle,
  verifierSignature: IG.verifierSignature,
  egalTempsConstant: IG.egalTempsConstant,
  jourParis: IG.jourParis,
  decalerJour: IG.decalerJour,
  bornesJour: IG.bornesJour,
};
