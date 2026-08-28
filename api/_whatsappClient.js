// ============================================================================
// api/_whatsappClient.js — CLIENT WHATSAPP CLOUD API (Meta en direct)
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// POURQUOI UN CANAL SÉPARÉ DE TWILIO
// ----------------------------------
// Décision du 09/08/2026 : Twilio garde les SMS, la voix et Ringover ;
// WhatsApp prend les rappels, les notifications et le groupe de suivi. Rien
// n'est mutualisé — ni le client, ni les identifiants, ni le webhook — pour
// que la séparation soit réelle et pas seulement de façade. Un incident sur
// un canal ne doit jamais pouvoir emporter l'autre.
//
// Ce qu'on reprend de Twilio, c'est LA MÉTHODE : identifiants en base plutôt
// qu'en variables d'environnement, cache au niveau module (une seule lecture
// Firestore par cold start Vercel), signature vérifiée sur tout ce qui entre.
//
// AUCUNE DÉPENDANCE NPM. Node 20 fournit `fetch` et `crypto` ; le SDK Meta
// n'apporterait rien de plus qu'un POST JSON.
//
// LE JOURNAL N'EST PAS DÉCORATIF
// ------------------------------
// Chaque envoi écrit un document dans `whatsapp_messages`, dont l'identifiant
// EST le `wamid` renvoyé par Meta. Le webhook reçoit ses accusés de réception
// indexés sur ce même `wamid` : il retrouve donc le document sans requête, et
// « le client dit qu'il n'a rien reçu » cesse d'être une question sans réponse.
// C'est précisément l'angle mort qui a masqué la panne SMS pendant des mois.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

/* Cache niveau module — vidé à chaque cold start. */
let _creds = null;

/**
 * Charge les identifiants depuis _config/whatsapp_credentials.
 * Lance si le document ou un champ vital manque : mieux vaut une erreur
 * explicite au premier appel qu'un envoi qui part vers nulle part.
 */
async function getWhatsappCreds() {
  if (_creds) return _creds;

  const snap = await db.collection('_config').doc('whatsapp_credentials').get();
  if (!snap.exists) throw new Error('_config/whatsapp_credentials introuvable');

  const d = snap.data() || {};
  if (!d.token) throw new Error('whatsapp_credentials.token manquant');
  if (!d.phoneNumberId) throw new Error('whatsapp_credentials.phoneNumberId manquant');

  _creds = {
    token: String(d.token),
    phoneNumberId: String(d.phoneNumberId),
    wabaId: d.wabaId ? String(d.wabaId) : null,
    /* verifyToken et appSecret ne servent qu'au webhook : leur absence ne doit
       pas empêcher un envoi. C'est whatsapp-webhook.js qui refuse de tourner
       sans eux, et lui seul. */
    verifyToken: d.verifyToken ? String(d.verifyToken) : null,
    appSecret: d.appSecret ? String(d.appSecret) : null,
    apiVersion: d.apiVersion ? String(d.apiVersion) : 'v25.0',
    /* Interrupteur des rappels automatiques, lu par whatsapp-rappels-rdv.js.
       Absent = éteint : on n'allume jamais un envoi de masse par défaut. */
    rappelsActifs: d.rappelsActifs === true,
  };
  return _creds;
}

/**
 * Numéro au format attendu par Meta : chiffres uniquement, indicatif compris.
 * Mêmes règles que api/signature-send-link.js — un numéro accepté pour un SMS
 * doit l'être pour WhatsApp, sinon on créerait deux vérités sur la même donnée.
 * @returns {string|null} ex. '33612345678', ou null si non exploitable
 */
function normaliserNumero(brut) {
  if (!brut) return null;
  const n = String(brut).replace(/[\s\-().]/g, '');
  let e164 = null;
  if (n.startsWith('+')) e164 = n;
  else if (n.startsWith('00')) e164 = '+' + n.slice(2);
  else if (n.startsWith('0') && n.length === 10) e164 = '+33' + n.slice(1);
  else if (n.startsWith('33') && n.length >= 11) e164 = '+' + n;
  else return null;
  const chiffres = e164.replace(/[^0-9]/g, '');
  return chiffres.length >= 10 ? chiffres : null;
}

/**
 * Appel brut à la Graph API. Ne lance jamais sur une erreur HTTP : les erreurs
 * Meta arrivent en JSON avec un code exploitable, et les perdre dans une
 * exception reviendrait à journaliser « échec » sans jamais savoir pourquoi.
 */
async function graph(chemin, opts) {
  opts = opts || {};
  const creds = await getWhatsappCreds();
  const url = 'https://graph.facebook.com/' + creds.apiVersion + '/' + chemin;

  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + creds.token },
  };
  if (opts.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let rep;
  try {
    rep = await fetch(url, init);
  } catch (e) {
    return { ok: false, status: 0, data: null, erreur: (e && e.message) || 'reseau' };
  }

  let data = null;
  try { data = await rep.json(); } catch (_) { data = null; }

  if (!rep.ok) {
    const err = (data && data.error) || {};
    return {
      ok: false,
      status: rep.status,
      data: data,
      erreur: err.message || ('HTTP ' + rep.status),
      code: err.code != null ? err.code : null,
      sousCode: err.error_subcode != null ? err.error_subcode : null,
    };
  }
  return { ok: true, status: rep.status, data: data };
}

/* Types de médias acceptés. Volontairement court : une image, un document.
   La vidéo est exclue — elle dépasse presque toujours la limite de corps
   d'une fonction Vercel, et un envoi qui échoue à 4 Mo près serait pire que
   pas d'envoi du tout. */
const MEDIAS = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'application/pdf': 'document',
};

/**
 * Téléverse un fichier chez Meta et renvoie son identifiant.
 * L'identifiant est valable 30 jours et ne sert qu'une fois côté message.
 * @returns {Promise<{ok:boolean, id:string|null, erreur:string|null}>}
 */
async function televerserMedia(buffer, mime, nom) {
  const creds = await getWhatsappCreds();
  if (!MEDIAS[mime]) return { ok: false, id: null, erreur: 'type_non_supporte' };

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), nom || 'fichier');

  let rep;
  try {
    rep = await fetch('https://graph.facebook.com/' + creds.apiVersion + '/'
      + creds.phoneNumberId + '/media', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + creds.token },
      body: form,
    });
  } catch (e) {
    return { ok: false, id: null, erreur: (e && e.message) || 'reseau' };
  }

  let data = null;
  try { data = await rep.json(); } catch (_) { data = null; }
  if (!rep.ok || !data || !data.id) {
    const err = (data && data.error) || {};
    return { ok: false, id: null, erreur: err.message || ('HTTP ' + rep.status) };
  }
  return { ok: true, id: data.id, erreur: null };
}

/**
 * Envoie un média déjà téléversé. Même contrainte que le texte libre : la
 * fenêtre de 24 h doit être ouverte, et c'est à l'appelant de l'avoir vérifié.
 *
 * `opts.mediaUrl` — copie archivée du fichier dans Firebase Storage, produite
 * par l'appelant AVANT l'envoi. Sans elle, la bulle sortante n'afficherait que
 * « 📷 nom-du-fichier » : on saurait qu'une pièce jointe est partie, jamais
 * laquelle. Meta ne permet pas de relire un média sortant — son identifiant
 * n'est valable qu'une fois, à l'envoi — donc si on ne garde pas la copie
 * nous-mêmes, personne ne pourra plus jamais vérifier ce qui a été envoyé.
 */
async function envoyerMedia(opts) {
  opts = opts || {};
  const to = normaliserNumero(opts.to);
  const mime = String(opts.mime || '');
  const genre = MEDIAS[mime];
  const contexte = opts.contexte || {};
  const legende = String(opts.legende || '').trim();
  const nom = String(opts.nom || 'fichier');

  const mediaUrl = opts.mediaUrl ? String(opts.mediaUrl) : null;
  const base = { media: true, mime: mime, nomFichier: nom, contexte: contexte,
                 mediaUrl: mediaUrl };
  if (!to) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'numero_invalide' }));
    return { ok: false, wamid: null, erreur: 'numero_invalide' };
  }
  if (!genre) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'type_non_supporte' }));
    return { ok: false, wamid: null, erreur: 'type_non_supporte' };
  }

  const creds = await getWhatsappCreds();
  const contenu = { id: opts.mediaId };
  /* Une légende n'est acceptée que sur l'image ; sur un document, WhatsApp
     affiche le nom du fichier. */
  if (genre === 'image' && legende) contenu.caption = legende;
  if (genre === 'document') contenu.filename = nom;

  const corps = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: genre };
  corps[genre] = contenu;

  const rep = await graph(creds.phoneNumberId + '/messages', { method: 'POST', body: corps });
  if (!rep.ok) {
    console.error('[whatsapp] media →', to, ':', rep.erreur);
    await journaliser(null, Object.assign({}, base, {
      statut: 'echec', to: to, erreur: rep.erreur || 'echec',
      codeMeta: rep.code != null ? rep.code : null,
    }));
    return { ok: false, wamid: null, erreur: rep.erreur || 'echec' };
  }

  const msgs = (rep.data && rep.data.messages) || [];
  const wamid = (msgs[0] && msgs[0].id) || null;
  await journaliser(wamid, Object.assign({}, base, { statut: 'accepte', to: to, wamid: wamid }));
  if (wamid) {
    await majConversation(to, {
      sens: 'out', wamid: wamid,
      texte: (genre === 'image' ? '📷 ' : '📎 ') + (legende || nom),
      /* `legende` à part du `texte` : l'écran affiche le média PUIS la légende,
         et réutiliser `texte` — qui porte déjà « 📷 nom » — ferait doublon
         sous l'image. */
      extra: { media: genre, mime: mime, nomFichier: nom, legende: legende || null,
               mediaUrl: mediaUrl, contexte: contexte },
    });
  }
  console.log('[whatsapp] media', genre, '→', to, 'wamid=' + wamid);
  return { ok: true, wamid: wamid, erreur: null };
}

/* ── MÉDIAS ENTRANTS ──────────────────────────────────────────────────────
   Meta ne pousse JAMAIS le fichier dans le webhook : la charge utile ne
   contient qu'un `id`. Il faut deux appels de plus — un pour obtenir une URL
   signée, un pour la télécharger — et cette URL expire en 5 minutes ET refuse
   toute requête sans l'en-tête Bearer. Un `<img src>` pointé dessus depuis le
   navigateur ne montrerait donc jamais rien.

   D'où l'archivage immédiat dans Firebase Storage : le fichier survit aux
   30 jours de rétention Meta, et l'URL produite reste lisible pour toujours.
   ------------------------------------------------------------------------ */

/* Au-delà de ce poids, on garde le message sans le fichier. Le webhook doit
   répondre 200 rapidement : Meta rejoue en boucle tout appel qui traîne, et un
   rejeu ne se passerait pas mieux. 8 Mo couvre toutes les photos de téléphone
   et tous les vocaux ; seule une vidéo longue dépasse. */
const MEDIA_MAX_OCTETS = 8 * 1024 * 1024;

/* Extension déduite du type déclaré par Meta : sans elle, le fichier stocké
   s'ouvre en « inconnu » et aucun navigateur ne l'affiche en ligne. */
const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionDe(mime) {
  const propre = String(mime || '').split(';')[0].trim().toLowerCase();
  return EXTENSIONS[propre] || 'bin';
}

/**
 * Copie un binaire dans Firebase Storage et renvoie une URL lisible.
 *
 * On pose nous-mêmes un `firebaseStorageDownloadTokens` : l'URL produite est
 * exactement de la forme qu'aurait produite un téléversement navigateur, elle
 * ne dépend ni des ACL du bucket ni des règles Storage, et n'expire pas.
 * Même méthode qu'api/temoignages-drive-sync.js, éprouvée en production.
 */
async function archiverMedia(buffer, chemin, mime) {
  const bucket = admin.storage().bucket();
  const token = crypto.randomUUID();
  await bucket.file(chemin).save(buffer, {
    resumable: false,
    contentType: mime || 'application/octet-stream',
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name
       + '/o/' + encodeURIComponent(chemin) + '?alt=media&token=' + token;
}

/**
 * Récupère un média entrant chez Meta et l'archive.
 *
 * Ne lance jamais : une photo qu'on n'a pas pu rapatrier ne doit pas faire
 * perdre le message qui la portait. En cas d'échec, le webhook écrit quand
 * même la bulle, avec la raison.
 *
 * @param {Object} o
 * @param {string} o.mediaId  identifiant renvoyé par Meta dans le webhook
 * @param {string} o.numero   émetteur, chiffres nus — sert de dossier
 * @param {string} o.wamid    identifiant du message — sert de nom de fichier
 * @returns {Promise<{ok:boolean, mediaUrl:string|null, mime:string|null,
 *                    taille:number|null, erreur:string|null}>}
 */
async function importerMediaEntrant(o) {
  o = o || {};
  const mediaId = String(o.mediaId || '').trim();
  const vide = { ok: false, mediaUrl: null, mime: null, taille: null };
  if (!mediaId) return Object.assign({}, vide, { erreur: 'media_id_absent' });

  /* 1. L'URL signée, valable 5 minutes. */
  const meta = await graph(encodeURIComponent(mediaId));
  if (!meta.ok) {
    console.warn('[whatsapp] média', mediaId, 'introuvable :', meta.erreur);
    return Object.assign({}, vide, { erreur: meta.erreur || 'media_introuvable' });
  }
  const d = meta.data || {};
  const url = d.url;
  const mime = d.mime_type || null;
  const taille = Number(d.file_size || 0) || null;
  if (!url) return Object.assign({}, vide, { mime: mime, erreur: 'url_absente' });

  /* Le poids est connu AVANT le téléchargement : autant refuser tout de suite
     plutôt que de tirer 40 Mo pour les jeter ensuite. */
  if (taille && taille > MEDIA_MAX_OCTETS) {
    return Object.assign({}, vide, { mime: mime, taille: taille, erreur: 'media_trop_lourd' });
  }

  /* 2. Le téléchargement — l'en-tête Bearer est obligatoire, lookaside.fbsbx
        répond 401 sans lui. */
  const creds = await getWhatsappCreds();
  let rep;
  try {
    rep = await fetch(url, { headers: { Authorization: 'Bearer ' + creds.token } });
  } catch (e) {
    return Object.assign({}, vide, { mime: mime, erreur: (e && e.message) || 'reseau' });
  }
  if (!rep.ok) {
    return Object.assign({}, vide, { mime: mime, erreur: 'HTTP ' + rep.status });
  }

  let buf;
  try {
    buf = Buffer.from(await rep.arrayBuffer());
  } catch (e) {
    return Object.assign({}, vide, { mime: mime, erreur: 'lecture_impossible' });
  }
  /* Meta annonce parfois un `file_size` optimiste : on revérifie sur le réel. */
  if (buf.length > MEDIA_MAX_OCTETS) {
    return Object.assign({}, vide, { mime: mime, taille: buf.length, erreur: 'media_trop_lourd' });
  }

  /* 3. L'archivage. Le wamid comme nom de fichier rend l'opération idempotente :
        un webhook rejoué par Meta réécrit le même objet au lieu d'en empiler
        une copie. */
  const chemin = 'whatsapp_media/' + String(o.numero || 'inconnu') + '/'
               + String(o.wamid || mediaId) + '.' + extensionDe(mime);
  try {
    const mediaUrl = await archiverMedia(buf, chemin, mime);
    return { ok: true, mediaUrl: mediaUrl, mime: mime, taille: buf.length, erreur: null };
  } catch (e) {
    console.error('[whatsapp] archivage média', chemin, e && e.message);
    return Object.assign({}, vide, { mime: mime, taille: buf.length, erreur: 'archivage_impossible' });
  }
}

/* ── GROUPES ───────────────────────────────────────────────────────────────
   Ouvert depuis 2026 sur l'API Cloud, et réservé aux comptes portant le badge
   vérifié (Official Business Account). Sans OBA, la création est refusée par
   Meta — `whatsapp-diagnostic` expose `numero.compteOfficiel` pour le savoir
   avant d'essayer.

   TROIS LIMITES QUI COMMANDENT LA CONCEPTION
   ------------------------------------------
   · 8 participants maximum. Client + closer + Adrien + Emily + Marine + coach
     = 6 : ça tient, mais il n'y a pas la place pour une septième habitude.
   · AUCUN endpoint pour ajouter quelqu'un d'office. On crée le groupe, on
     obtient un lien, et chacun le rejoint en cliquant. C'est pour ça que le
     modèle `invitation_groupe` existe : il EST le véhicule du lien.
   · Les statistiques de modèle ne remontent pas pour les envois en groupe, et
     chaque invitation est facturée comme un message.
   ------------------------------------------------------------------------ */

/**
 * Crée un groupe et renvoie son identifiant.
 *
 * ⚠️ Le nom du champ portant le sujet n'est pas documenté publiquement de
 * façon fiable : on envoie `subject`, qui est la convention WhatsApp, et on
 * renvoie la réponse brute de Meta en cas d'échec pour pouvoir trancher au
 * premier appel réel plutôt que de deviner ici.
 *
 * @returns {Promise<{ok:boolean, groupId:string|null, lien:string|null,
 *                    erreur:string|null, brut:Object|null}>}
 */
async function creerGroupe(opts) {
  opts = opts || {};
  const sujet = String(opts.sujet || '').trim();
  if (!sujet) return { ok: false, groupId: null, lien: null, erreur: 'sujet_requis', brut: null };

  const creds = await getWhatsappCreds();
  const rep = await graph(creds.phoneNumberId + '/groups', {
    method: 'POST',
    body: { messaging_product: 'whatsapp', subject: sujet },
  });

  if (!rep.ok) {
    console.error('[whatsapp] création groupe «' + sujet + '» :', rep.erreur, 'code=' + rep.code);
    return {
      ok: false, groupId: null, lien: null,
      erreur: rep.erreur || 'echec', brut: rep.data || null,
    };
  }

  const d = rep.data || {};
  /* Meta renvoie l'identifiant et, selon les versions, le lien d'invitation
     dans la foulée. On accepte les deux formes plutôt que d'imposer la
     nôtre — et l'appelant redemandera le lien s'il manque. */
  const groupId = d.id || d.group_id || (Array.isArray(d.groups) && d.groups[0] && d.groups[0].id) || null;
  const lien = d.invite_link || (Array.isArray(d.groups) && d.groups[0] && d.groups[0].invite_link) || null;

  if (!groupId) {
    return { ok: false, groupId: null, lien: null, erreur: 'identifiant_absent', brut: d };
  }
  console.log('[whatsapp] groupe créé', groupId, '«' + sujet + '»');
  return { ok: true, groupId: String(groupId), lien: lien || null, erreur: null, brut: d };
}

/**
 * Le lien d'invitation d'un groupe.
 * GET le lit ; POST en génère un nouveau ET INVALIDE LE PRÉCÉDENT — d'où le
 * GET par défaut : régénérer par erreur laisserait sur le carreau tous ceux
 * qui n'ont pas encore cliqué.
 */
async function lienInvitationGroupe(groupId, regenerer) {
  const id = String(groupId || '').trim();
  if (!id) return { ok: false, lien: null, erreur: 'group_id_requis' };

  const rep = regenerer
    ? await graph(encodeURIComponent(id) + '/invite_link', {
        method: 'POST', body: { messaging_product: 'whatsapp' },
      })
    : await graph(encodeURIComponent(id) + '/invite_link');

  if (!rep.ok) return { ok: false, lien: null, erreur: rep.erreur || 'echec' };
  const lien = (rep.data && rep.data.invite_link) || null;
  if (!lien) return { ok: false, lien: null, erreur: 'lien_absent' };
  return { ok: true, lien: lien, erreur: null };
}

/**
 * Écrit une ligne de journal. Ne lance jamais : un envoi réussi ne doit pas
 * être signalé en échec parce que sa trace n'a pas pu s'écrire.
 * L'identifiant du document est le wamid quand on l'a — c'est ce qui permet
 * au webhook de retrouver la ligne sans requête.
 */
async function journaliser(wamid, infos) {
  const doc = Object.assign({}, infos, {
    at: Date.now(),
    date: new Date().toISOString(),
  });
  try {
    if (wamid) await db.collection('whatsapp_messages').doc(wamid).set(doc, { merge: true });
    else await db.collection('whatsapp_messages').add(doc);
  } catch (e) {
    console.warn('[whatsapp] journal:', e && e.message);
  }
}

/* La fenêtre de service WhatsApp : 24 h après le DERNIER message entrant du
   contact. Au-delà, seul un modèle approuvé peut partir. C'est la contrainte
   qui commande toute l'interface de la boîte partagée — un champ de saisie
   libre hors fenêtre produirait des messages qui échouent sans que personne
   comprenne pourquoi. */
const FENETRE_MS = 24 * 60 * 60 * 1000;

/**
 * Retrouve le lead derrière un numéro. Le téléphone canonique est `telephone`,
 * en E.164 strict avec le `+` ; nos numéros WhatsApp sont en chiffres nus.
 * Les documents fusionnés (`_merged: true`) sont ignorés — motif pickAlive().
 *
 * `assignedTo` est un SLUG d'équipe (`elodie`), pas un uid Firebase : c'est au
 * webhook de le convertir avant d'en faire un `ownerUid` de notification.
 * @returns {{leadId:string, nom:string, assignedTo:string|null}|null}
 */
function premierVivant(snap) {
  let trouve = null;
  snap.forEach((d) => {
    if (trouve) return;
    const v = d.data() || {};
    /* Motif pickAlive : un document fusionné n'est plus la fiche de
       référence, et y écrire reviendrait à écrire dans le vide. */
    if (v._merged === true) return;
    trouve = {
      leadId: d.id,
      nom: v.nom || v.prenom || null,
      assignedTo: v.assignedTo || null,
    };
  });
  return trouve;
}

async function rattacherLead(numero) {
  if (!numero) return null;
  try {
    /* 1. Le téléphone canonique, en E.164 strict. */
    const parTel = await db.collection('leads')
      .where('telephone', '==', '+' + numero).limit(5).get();
    const direct = premierVivant(parTel);
    if (direct) return direct;

    /* 2. Repli sur les NEUF DERNIERS CHIFFRES. Le champ `telephone` n'est pas
       toujours en E.164 — des fiches anciennes ou importées portent encore
       « 06 68 … » ou un numéro sans « + » — et une comparaison stricte les
       manque toutes. `phoneNormalized` est justement le champ que
       api/lead-optin.js utilise pour dédoublonner à l'entrée : c'est le seul
       rapprochement qui ne dépende d'aucun formatage.

       Sans ce repli, la conversation n'était rattachée à aucun lead : la boîte
       partagée affichait un numéro nu au lieu d'un nom, et aucune trace ne
       pouvait être posée sur la fiche. */
    const court = String(numero).replace(/[^0-9]/g, '').slice(-9);
    if (court.length < 9) return null;
    const parCourt = await db.collection('leads')
      .where('phoneNormalized', '==', court).limit(5).get();
    return premierVivant(parCourt);
  } catch (e) {
    console.warn('[whatsapp] rattachement lead', numero, e && e.message);
    return null;
  }
}

/**
 * Tient à jour l'index de conversation ET le fil, pour la boîte partagée.
 *
 * Appelée par l'envoi ET par le webhook : c'est LE point d'écriture unique,
 * pour que l'index, le fil et le journal technique ne puissent pas diverger.
 *
 * @param {string} numero  destinataire ou émetteur, chiffres nus
 * @param {Object} m
 * @param {'in'|'out'} m.sens
 * @param {string} m.wamid
 * @param {string} [m.texte]     corps lisible — pour un modèle, son nom suffit
 * @param {string} [m.nom]       nom du profil WhatsApp, sur un entrant
 * @param {string} [m.statut]
 * @param {Object} [m.extra]     champs libres écrits sur le message du fil
 */
async function majConversation(numero, m) {
  if (!numero || !m || !m.wamid) return;
  const maintenant = Date.now();
  const entrant = m.sens === 'in';
  const ref = db.collection('whatsapp_conversations').doc(String(numero));

  try {
    /* Le fil d'abord : même si l'index échoue, le message n'est pas perdu. */
    await ref.collection('messages').doc(String(m.wamid)).set(Object.assign({
      wamid: String(m.wamid),
      sens: m.sens === 'in' ? 'in' : 'out',
      texte: m.texte || null,
      statut: m.statut || (entrant ? 'recu' : 'accepte'),
      at: maintenant,
      date: new Date().toISOString(),
    }, m.extra || {}), { merge: true });

    const snap = await ref.get();
    const actuel = snap.exists ? (snap.data() || {}) : {};

    const patch = {
      numero: String(numero),
      dernierMessage: { texte: m.texte || null, sens: entrant ? 'in' : 'out', at: maintenant },
      majA: maintenant,
    };
    if (!snap.exists) {
      patch.statut = 'ouverte';
      patch.creeA = maintenant;
      patch.nonLus = 0;
      /* Rattachement tenté une seule fois, à la création : une requête par
         message entrant serait du gaspillage sur une conversation active. */
      const lead = await rattacherLead(numero);
      if (lead) { patch.leadId = lead.leadId; patch.nomLead = lead.nom; }
    }
    if (entrant) {
      /* Chaque entrant rouvre la fenêtre pour 24 h. */
      patch.fenetreExpireA = maintenant + FENETRE_MS;
      patch.nonLus = (Number(actuel.nonLus) || 0) + 1;
      if (m.nom && m.nom !== actuel.nom) patch.nom = m.nom;
    }
    await ref.set(patch, { merge: true });
  } catch (e) {
    console.error('[whatsapp] conversation', numero, e && e.message);
  }
}

/**
 * Envoie un message texte LIBRE.
 *
 * N'est autorisé que dans la fenêtre de 24 h suivant le dernier message du
 * contact — c'est l'appelant qui doit l'avoir vérifié. Hors fenêtre, Meta
 * refuse avec l'erreur 131047, tracée telle quelle dans le journal.
 *
 * @returns {Promise<{ok:boolean, wamid:string|null, erreur:string|null}>}
 */
async function envoyerTexte(opts) {
  opts = opts || {};
  const texte = String(opts.texte == null ? '' : opts.texte).trim();
  const contexte = opts.contexte || {};
  /* `groupId` prend le pas sur `to` : un groupe n'a pas de numéro, et le faire
     passer par normaliserNumero le réduirait à null. La fenêtre de 24 h ne
     s'applique pas à un groupe dont on est membre. */
  const groupId = opts.groupId ? String(opts.groupId).trim() : null;
  const to = groupId || normaliserNumero(opts.to);

  const base = { texteLibre: true, contexte: contexte, groupId: groupId,
                 destinataireBrut: opts.to != null ? String(opts.to) : null };

  if (!texte) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'texte_vide' }));
    return { ok: false, wamid: null, erreur: 'texte_vide' };
  }
  if (!to) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'numero_invalide' }));
    return { ok: false, wamid: null, erreur: 'numero_invalide' };
  }

  const creds = await getWhatsappCreds();
  const rep = await graph(creds.phoneNumberId + '/messages', {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: groupId ? 'group' : 'individual',
      to: to,
      type: 'text',
      text: { preview_url: false, body: texte },
    },
  });

  if (!rep.ok) {
    console.error('[whatsapp] texte →', to, ':', rep.erreur, 'code=' + rep.code);
    await journaliser(null, Object.assign({}, base, {
      statut: 'echec', to: to, erreur: rep.erreur || 'echec',
      codeMeta: rep.code != null ? rep.code : null,
    }));
    return { ok: false, wamid: null, erreur: rep.erreur || 'echec' };
  }

  const msgs = (rep.data && rep.data.messages) || [];
  const wamid = (msgs[0] && msgs[0].id) || null;

  await journaliser(wamid, Object.assign({}, base, { statut: 'accepte', to: to, wamid: wamid }));
  /* Un groupe n'entre PAS dans la boîte partagée : `whatsapp_conversations` est
     indexée par le numéro d'un contact, et y ranger un identifiant de groupe
     créerait un fil fantôme auquel personne ne pourrait répondre — l'API
     n'accepte pas de réponse libre entrante côté groupe. Le journal technique
     garde la trace, lui. */
  if (wamid && !groupId) {
    await majConversation(to, {
      sens: 'out', wamid: wamid, texte: texte,
      extra: { contexte: contexte, par: contexte.par || null },
    });
  }

  console.log('[whatsapp] texte →', to, 'wamid=' + wamid);
  return { ok: true, wamid: wamid, erreur: null };
}

/**
 * Envoie un modèle approuvé.
 *
 * @param {Object} opts
 * @param {string} opts.to        destinataire (format libre, normalisé ici)
 * @param {string} opts.template  nom exact du modèle approuvé chez Meta
 * @param {string} [opts.langue]  code langue du modèle — 'fr' par défaut
 * @param {Array}  [opts.params]  valeurs de {{1}}, {{2}}… dans l'ordre
 * @param {Object} [opts.contexte] métadonnées libres pour le journal
 *                                 (clientId, coachSlug, bookingId…)
 * @returns {Promise<{ok:boolean, wamid:string|null, erreur:string|null}>}
 *
 * Ne lance pas : l'appelant décide quoi faire d'un échec, et le journal garde
 * la trace dans tous les cas.
 */
async function envoyerModele(opts) {
  opts = opts || {};
  const modele = String(opts.template || '').trim();
  const langue = String(opts.langue || 'fr').trim();
  const params = Array.isArray(opts.params) ? opts.params : [];
  const contexte = opts.contexte || {};
  /* Même règle que pour le texte : un groupe se désigne par son identifiant. */
  const groupId = opts.groupId ? String(opts.groupId).trim() : null;
  const to = groupId || normaliserNumero(opts.to);

  const base = {
    modele: modele,
    langue: langue,
    params: params.map((v) => (v == null ? '' : String(v))),
    contexte: contexte,
    groupId: groupId,
    destinataireBrut: opts.to != null ? String(opts.to) : null,
  };

  if (!modele) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'template_requis' }));
    return { ok: false, wamid: null, erreur: 'template_requis' };
  }
  if (!to) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'numero_invalide' }));
    return { ok: false, wamid: null, erreur: 'numero_invalide' };
  }

  /* UN PARAMÈTRE VIDE FAIT ÉCHOUER L'ENVOI ENTIER côté Meta, et l'erreur
     renvoyée ne dit pas lequel. On tranche ici, avec le numéro du paramètre
     fautif : c'est le mode de panne le plus probable de tout ce module (un
     coach non attribué, une date de RDV absente), autant qu'il soit lisible
     du premier coup d'œil dans le journal. */
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v == null || String(v).trim() === '') {
      const erreur = 'parametre_vide_{{' + (i + 1) + '}}';
      await journaliser(null, Object.assign({}, base, { statut: 'refuse', to: to, erreur: erreur }));
      return { ok: false, wamid: null, erreur: erreur };
    }
  }

  const creds = await getWhatsappCreds();
  const composants = params.length
    ? [{
        type: 'body',
        parameters: params.map((v) => ({ type: 'text', text: String(v) })),
      }]
    : [];

  const rep = await graph(creds.phoneNumberId + '/messages', {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: groupId ? 'group' : 'individual',
      to: to,
      type: 'template',
      template: {
        name: modele,
        language: { code: langue },
        components: composants,
      },
    },
  });

  if (!rep.ok) {
    console.error('[whatsapp] envoi', modele, '→', to, ':', rep.erreur, 'code=' + rep.code);
    await journaliser(null, Object.assign({}, base, {
      statut: 'echec',
      to: to,
      erreur: rep.erreur || 'echec',
      codeMeta: rep.code != null ? rep.code : null,
      sousCodeMeta: rep.sousCode != null ? rep.sousCode : null,
    }));
    return { ok: false, wamid: null, erreur: rep.erreur || 'echec' };
  }

  const msgs = (rep.data && rep.data.messages) || [];
  const wamid = (msgs[0] && msgs[0].id) || null;

  /* `accepte` et non `envoye` : à ce stade Meta a seulement pris le message
     en charge. C'est le webhook qui dira `sent`, `delivered`, `read` ou
     `failed`. Confondre les deux, c'est refaire l'erreur du module SMS. */
  await journaliser(wamid, Object.assign({}, base, {
    statut: 'accepte',
    to: to,
    wamid: wamid,
  }));

  /* Le message rejoint la boîte partagée — sauf s'il est parti dans un groupe,
     qui n'a pas sa place dans une messagerie de contacts. Un modèle n'a pas de
     corps lisible côté API : on affiche son nom, l'interface saura l'habiller. */
  if (wamid && !groupId) {
    await majConversation(to, {
      sens: 'out',
      wamid: wamid,
      texte: '[' + modele + ']',
      extra: { modele: modele, params: base.params, contexte: contexte },
    });
  }

  console.log('[whatsapp]', modele, '→', to, 'wamid=' + wamid);
  return { ok: true, wamid: wamid, erreur: null };
}

module.exports = {
  creerGroupe,
  lienInvitationGroupe,
  FENETRE_MS,
  MEDIA_MAX_OCTETS,
  extensionDe,
  archiverMedia,
  importerMediaEntrant,
  rattacherLead,
  majConversation,
  getWhatsappCreds,
  normaliserNumero,
  graph,
  journaliser,
  envoyerModele,
  envoyerTexte,
  televerserMedia,
  envoyerMedia,
  MEDIAS,
};
