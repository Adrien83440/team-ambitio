// ============================================================================
// api/_instagramClient.js — CLIENT INSTAGRAM GRAPH API (Meta en direct)
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// POURQUOI UNE APPLICATION META SÉPARÉE DE WHATSAPP
// -------------------------------------------------
// Décision du 01/09/2026 : Instagram a sa propre application Meta, ses propres
// identifiants, son propre webhook. Rien n'est mutualisé avec WhatsApp — même
// doctrine que la séparation Twilio / WhatsApp Cloud API. Une revue Meta qui
// traîne sur les permissions Instagram, un token révoqué, un webhook mal
// abonné : aucun de ces incidents ne doit pouvoir emporter les rappels de RDV.
//
// CE QUE CE CLIENT SAIT FAIRE
//   · lire les insights du compte (jour par jour)
//   · lister les publications et leurs métriques
//   · paginer les commentaires d'une publication
//   · résoudre un IGSID de conversation en @username
//   · rafraîchir le jeton longue durée avant expiration
//
// LE JETON EXPIRE À 60 JOURS — ET C'EST LE PIÈGE
// ----------------------------------------------
// Un jeton Instagram longue durée vit 60 jours. Sans rafraîchissement, l'onglet
// Instagram du Funnel meurt SILENCIEUSEMENT deux mois après la mise en service :
// le cron continue de tourner, Meta répond 190, personne ne regarde les logs.
// D'où `rafraichirTokenSiBesoin()`, appelé à chaque exécution du cron, et le
// champ `tokenExpiresAt` en base que la page affiche en clair.
//
// AUCUNE DÉPENDANCE NPM : Node 20 fournit `fetch` et `crypto`.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

/* Cache niveau module — vidé à chaque cold start Vercel, exactement comme
   _whatsappClient.js : une seule lecture Firestore par instance. */
let _creds = null;

const API_VERSION_DEFAUT = 'v23.0';

/* DEUX PORTES D'ENTRÉE, SELON LA FAÇON DONT L'APPLICATION A ÉTÉ CONFIGURÉE
   ────────────────────────────────────────────────────────────────────────
   · authMode 'instagram' (recommandé, et le plus simple à mettre en place) —
     « API setup with Instagram business login » dans le tableau de bord Meta.
     Le jeton se génère en un bouton, aucune Page Facebook n'est nécessaire,
     et il se rafraîchit sans App Secret. Les appels partent sur
     graph.instagram.com et l'identifiant du compte peut rester `me`.
   · authMode 'facebook' — l'ancienne voie, via une Page Facebook et le
     Business Manager. Utile si le compte est déjà administré comme ça.
     Les appels partent sur graph.facebook.com, le rafraîchissement exige
     appId + appSecret.
   Tout le reste du client est identique : mêmes endpoints, mêmes champs. */
const HOST_INSTAGRAM = 'https://graph.instagram.com';
const HOST_FACEBOOK  = 'https://graph.facebook.com';

/* Mot-clé par défaut si `_config/instagram_credentials.keywords` est absent.
   Le compte publie des appels à commenter « GO » — c'est LE signal d'intérêt
   qu'on cherche à compter. */
const KEYWORDS_DEFAUT = ['go'];

/**
 * Charge les identifiants depuis _config/instagram_credentials.
 * Lance si le document ou un champ vital manque : mieux vaut une erreur
 * explicite au premier appel qu'une synchro qui écrit du vide.
 */
async function getInstagramCreds(forceReload) {
  if (_creds && !forceReload) return _creds;

  const snap = await db.collection('_config').doc('instagram_credentials').get();
  if (!snap.exists) throw new Error('_config/instagram_credentials introuvable');

  const d = snap.data() || {};
  if (!d.token) throw new Error('instagram_credentials.token manquant');

  const authMode = String(d.authMode || 'instagram').toLowerCase() === 'facebook'
    ? 'facebook' : 'instagram';
  /* En mode Instagram Login, `me` désigne le compte propriétaire du jeton :
     l'identifiant numérique devient facultatif. En mode Facebook, il faut
     l'identifiant du compte Instagram rattaché à la Page. */
  if (!d.igUserId && authMode === 'facebook') {
    throw new Error('instagram_credentials.igUserId manquant (obligatoire en authMode "facebook")');
  }

  _creds = {
    authMode: authMode,
    host: authMode === 'facebook' ? HOST_FACEBOOK : HOST_INSTAGRAM,
    igUserId: d.igUserId ? String(d.igUserId) : 'me',
    token: String(d.token),
    tokenExpiresAt: d.tokenExpiresAt ? String(d.tokenExpiresAt) : null,
    appId: d.appId ? String(d.appId) : null,
    /* appSecret et verifyToken ne servent qu'au webhook : leur absence ne doit
       pas empêcher une synchro de lecture. C'est instagram-webhook.js qui
       refuse de tourner sans eux, et lui seul. */
    appSecret: d.appSecret ? String(d.appSecret) : null,
    verifyToken: d.verifyToken ? String(d.verifyToken) : null,
    apiVersion: d.apiVersion ? String(d.apiVersion) : API_VERSION_DEFAUT,
    keywords: Array.isArray(d.keywords) && d.keywords.length
      ? d.keywords.map((k) => normaliserTexte(k)).filter(Boolean)
      : KEYWORDS_DEFAUT,
    /* Interrupteur de la synchro. Absent = allumé : contrairement à un envoi
       de masse, une lecture ne fait de mal à personne. */
    syncActif: d.syncActif !== false,
    compteNom: d.compteNom ? String(d.compteNom) : null,
  };
  return _creds;
}

function viderCacheCreds() { _creds = null; }

/* ══════════════════════════════════════════════════════════════════════
   APPEL GRAPH — un seul point de sortie réseau
   ══════════════════════════════════════════════════════════════════════ */

/**
 * GET sur la Graph API. Retourne le JSON parsé.
 * Lance une Error enrichie (code, subcode, type Meta) : un 190 « token
 * expiré » et un 100 « métrique inconnue » n'appellent pas la même réaction,
 * et l'appelant doit pouvoir les distinguer sans parser un message.
 */
async function graphGet(chemin, params, creds) {
  const c = creds || (await getInstagramCreds());
  const url = new URL(c.host + '/' + c.apiVersion + '/' + chemin.replace(/^\//, ''));
  Object.keys(params || {}).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      url.searchParams.set(k, String(params[k]));
    }
  });
  url.searchParams.set('access_token', c.token);

  const rep = await fetch(url.toString(), { method: 'GET' });
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
 * Le plafond n'est pas décoratif : une publication virale peut porter des
 * milliers de commentaires, et une serverless a 300 s pour vivre.
 */
async function graphGetPagine(chemin, params, creds, maxPages) {
  const c = creds || (await getInstagramCreds());
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
   JETON — rafraîchissement automatique
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Échange le jeton courant contre un nouveau jeton longue durée s'il expire
 * dans moins de `seuilJours` (défaut 10). Écrit le nouveau jeton et sa date
 * d'expiration dans _config/instagram_credentials.
 *
 * Ne lance jamais : un échec de rafraîchissement ne doit pas faire tomber la
 * synchro du jour — le jeton actuel est encore valide, par définition du
 * seuil. Retourne un compte rendu que le cron range dans son rapport.
 */
async function rafraichirTokenSiBesoin(seuilJours) {
  const seuil = seuilJours == null ? 10 : seuilJours;
  let c;
  try { c = await getInstagramCreds(); } catch (e) { return { fait: false, erreur: e.message }; }

  if (c.authMode === 'facebook' && (!c.appId || !c.appSecret)) {
    return { fait: false, raison: 'appId/appSecret absents — rafraîchissement impossible en authMode "facebook"' };
  }
  if (c.tokenExpiresAt) {
    const restant = new Date(c.tokenExpiresAt).getTime() - Date.now();
    if (isFinite(restant) && restant > seuil * 86400000) {
      return { fait: false, raison: 'jeton valide encore ' + Math.round(restant / 86400000) + ' j' };
    }
  }

  try {
    let json;
    if (c.authMode === 'facebook') {
      json = await graphGet('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: c.appId,
        client_secret: c.appSecret,
        fb_exchange_token: c.token,
      }, c);
    } else {
      /* Instagram Login : le jeton se prolonge tout seul, sans secret. Meta
         refuse de rafraîchir un jeton de moins de 24 h — d'où l'appel piloté
         par la date d'expiration et non à chaque exécution. */
      const url = new URL(c.host + '/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', c.token);
      const rep = await fetch(url.toString());
      const txt = await rep.text();
      try { json = txt ? JSON.parse(txt) : {}; } catch (_) { json = {}; }
      if (json.error) return { fait: false, erreur: json.error.message || 'refresh refusé' };
    }
    if (!json.access_token) return { fait: false, erreur: 'réponse sans access_token' };

    const vieSec = Number(json.expires_in) || 60 * 86400;
    const expire = new Date(Date.now() + vieSec * 1000).toISOString();
    await db.collection('_config').doc('instagram_credentials').set({
      token: json.access_token,
      tokenExpiresAt: expire,
      tokenRefreshedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    viderCacheCreds();
    return { fait: true, expireLe: expire };
  } catch (e) {
    return { fait: false, erreur: e.message, metaCode: e.metaCode || null };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   TEXTE — normalisation et détection du mot-clé
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Minuscules, accents retirés, emojis et ponctuation réduits à des espaces.
 * « GO !!! », « Go 🔥 », « gO. », « góo » ne doivent pas produire trois
 * comptages différents — c'est le même geste de la même personne.
 */
function normaliserTexte(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  /* Tout ce qui n'est ni lettre ASCII ni chiffre devient un espace : les
     emojis, la ponctuation et les espaces insécables partent d'un coup. */
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  return t;
}

/* Cache des regex de mots-clés — construites une fois, pas à chaque
   commentaire d'un rattrapage de 60 jours. */
const _reMotCle = {};

/**
 * Regex d'un mot-clé mono-mot, tolérante aux lettres étirées :
 * « go » accepte go, goo, gooooo, ggo — l'enthousiasme s'écrit en allongeant
 * les voyelles, et « GOOO » est un GO. Elle reste ancrée sur le mot entier,
 * donc « golf », « gopro » et « bogoss » restent dehors.
 */
function regexMotCle(k) {
  if (_reMotCle[k]) return _reMotCle[k];
  const motif = '^' + k.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '+').join('') + '$';
  const re = new RegExp(motif);
  _reMotCle[k] = re;
  return re;
}

/**
 * Vrai si le texte contient l'un des mots-clés en MOT ENTIER.
 * Le mot entier est essentiel : sans lui « gopro », « golf » ou « bogoss »
 * gonfleraient le compteur GO et rendraient la statistique mensongère.
 */
function contientMotCle(texte, keywords) {
  const t = normaliserTexte(texte);
  if (!t) return false;
  const mots = t.split(' ');
  const liste = (keywords && keywords.length ? keywords : KEYWORDS_DEFAUT);
  for (let i = 0; i < liste.length; i++) {
    const k = normaliserTexte(liste[i]);
    if (!k) continue;
    /* Mot-clé en plusieurs mots (« je veux ») : recherche de sous-chaîne. */
    if (k.indexOf(' ') >= 0) { if (t.indexOf(k) >= 0) return true; continue; }
    const re = regexMotCle(k);
    for (let j = 0; j < mots.length; j++) if (re.test(mots[j])) return true;
  }
  return false;
}

/** @username → username (sans arobase, minuscules, sans espaces). */
function normaliserUsername(u) {
  if (!u) return null;
  const s = String(u).trim().replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
  return s || null;
}

/* ══════════════════════════════════════════════════════════════════════
   RATTACHEMENT À UNE FICHE LEAD
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Cherche la fiche lead portant ce @username Instagram.
 * Ignore les documents `_merged: true` — motif pickAlive() : un doublon
 * fusionné n'est plus la fiche vivante, le rattacher enverrait les stats
 * sur une coquille.
 * Ne lance jamais : un rattachement raté vaut mieux qu'une synchro morte.
 */
async function trouverLeadParUsername(username) {
  const u = normaliserUsername(username);
  if (!u) return null;
  try {
    const snap = await db.collection('leads')
      .where('instagramUsername', '==', u)
      .limit(5).get();
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
    console.warn('[instagram] trouverLeadParUsername', u, e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SIGNATURE WEBHOOK — X-Hub-Signature-256
   ══════════════════════════════════════════════════════════════════════ */

/** Comparaison à temps constant, sans planter sur des longueurs différentes. */
function egalTempsConstant(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (_) {
    return false;
  }
}

/**
 * Vérifie la signature Meta sur les OCTETS BRUTS du corps.
 * Re-sérialiser un objet déjà parsé donnerait un JSON différent (ordre des
 * clés, espaces) et ferait échouer la vérification — même discipline que
 * api/whatsapp-webhook.js.
 */
function verifierSignature(corpsBrut, entete, appSecret) {
  if (!entete || !appSecret) return false;
  const attendu = 'sha256=' + crypto.createHmac('sha256', appSecret)
    .update(corpsBrut, 'utf8').digest('hex');
  return egalTempsConstant(String(entete), attendu);
}

/* ══════════════════════════════════════════════════════════════════════
   DATES
   ══════════════════════════════════════════════════════════════════════ */

/** Date « YYYY-MM-DD » dans le fuseau de Paris — celui des publications. */
function jourParis(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  try {
    const p = new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    return p; /* fr-CA rend déjà YYYY-MM-DD */
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

/** Décale un « YYYY-MM-DD » de n jours (n négatif = passé). */
function decalerJour(iso, n) {
  const p = String(iso).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bornes UNIX (secondes) d'un jour Paris, pour since/until Graph. */
function bornesJour(iso) {
  const p = String(iso).split('-');
  /* Paris = UTC+1 ou +2. On prend une fenêtre large côté UTC et on laisse
     Meta caler sur le fuseau du compte : les insights « day » sont rendus
     dans le fuseau du compte publicitaire, pas dans le nôtre. */
  const debut = Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2], 0, 0, 0) / 1000);
  return { since: debut, until: debut + 86400 };
}

module.exports = {
  getInstagramCreds,
  viderCacheCreds,
  graphGet,
  graphGetPagine,
  rafraichirTokenSiBesoin,
  normaliserTexte,
  contientMotCle,
  normaliserUsername,
  trouverLeadParUsername,
  verifierSignature,
  egalTempsConstant,
  jourParis,
  decalerJour,
  bornesJour,
  KEYWORDS_DEFAUT,
};
