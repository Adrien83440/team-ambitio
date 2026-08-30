// ============================================================================
// api/whatsapp-webhook.js — WEBHOOK WHATSAPP (Meta Cloud API)
// ----------------------------------------------------------------------------
// GET  /api/whatsapp-webhook   → poignée de main de vérification Meta
// POST /api/whatsapp-webhook   → accusés de réception + messages entrants
//
// POURQUOI IL EXISTE
// ------------------
// Meta exige une URL de rappel joignable pour valider le numéro. Mais surtout,
// c'est LE SEUL endroit qui dit si un message est réellement arrivé. Un POST
// /messages qui répond 200 signifie « Meta a accepté », rien de plus — c'est
// exactement la confusion qui a masqué la panne SMS pendant des mois, où
// l'interface affichait « ✅ envoyé » alors que rien ne partait.
//
// DEUX SECRETS, DEUX RÔLES DIFFÉRENTS
//   · `verifyToken` — une chaîne QUE NOUS CHOISISSONS, rejouée à l'identique
//     par Meta lors de la poignée de main. Elle prouve que l'URL nous
//     appartient.
//   · `appSecret`   — la clé secrète de l'application Meta, qui signe chaque
//     POST. Elle prouve que le contenu vient bien de Meta.
// Les confondre, c'est n'en vérifier aucun.
//
// AUCUN CONTOURNEMENT SILENCIEUX : sans `appSecret` en base, on répond 503.
// Un webhook qui accepte tout parce qu'un secret manque est pire qu'un webhook
// absent — même discipline que api/gocardless-webhook.js.
//
// ⚠️ TANT QUE L'APPLICATION META N'EST PAS PUBLIÉE, seuls les webhooks de test
// envoyés depuis le tableau de bord arrivent ici. Aucune donnée de production
// n'est diffusée. Les accusés de réception resteront donc muets jusqu'à la
// publication de l'app — ce n'est pas une panne de ce fichier.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const { getWhatsappCreds, majConversation, rattacherLead,
        importerMediaEntrant, FENETRE_MS } = require('./_whatsappClient');

/* Lecture du corps brut. La signature porte sur les octets exacts envoyés par
   Meta : re-sérialiser un objet déjà parsé donnerait un JSON différent (ordre
   des clés, espaces) et ferait échouer toute vérification. Même helper que
   api/gocardless-webhook.js, éprouvé en production. */
function lireCorpsBrut(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    req.on('data', (c) => morceaux.push(c));
    req.on('end', () => {
      try { resolve(Buffer.concat(morceaux).toString('utf8')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* Comparaison à temps constant, sans planter sur des longueurs différentes. */
function egalTempsConstant(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (_) {
    return false;
  }
}

/* Les accusés n'arrivent pas dans l'ordre : un `sent` peut suivre un
   `delivered`. Sans rang, un retard réseau ferait régresser le statut affiché
   et on croirait un message perdu alors qu'il est lu. */
const RANG = { accepte: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

function rangDe(s) {
  return Object.prototype.hasOwnProperty.call(RANG, s) ? RANG[s] : 0;
}

/**
 * Applique un accusé de réception sur la ligne de journal correspondante.
 * La transaction n'est pas du zèle : deux accusés du même message peuvent
 * arriver en parallèle sur deux instances Vercel différentes.
 */
async function appliquerStatut(st) {
  const wamid = st && st.id;
  if (!wamid) return;

  const statut = String(st.status || '').trim() || 'inconnu';
  const ref = db.collection('whatsapp_messages').doc(String(wamid));
  const erreurs = Array.isArray(st.errors) ? st.errors : [];

  const maj = {
    dernierStatutAt: Date.now(),
    destinataireId: st.recipient_id || null,
  };
  if (erreurs.length) {
    const e = erreurs[0] || {};
    maj.erreurMeta = {
      code: e.code != null ? e.code : null,
      titre: e.title || null,
      detail: e.error_data && e.error_data.details ? e.error_data.details : (e.message || null),
    };
  }

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const actuel = snap.exists ? (snap.data() || {}) : {};
      const rangActuel = rangDe(actuel.statut);
      const rangNouveau = rangDe(statut);

      /* Le document peut ne pas exister : accusé arrivé avant l'écriture du
         journal, ou message envoyé hors de ce code. On le crée quand même —
         perdre un accusé de réception est pire que garder une ligne orpheline. */
      const patch = Object.assign({}, maj, {
        historiqueStatuts: (actuel.historiqueStatuts || []).concat([{
          statut: statut,
          at: Date.now(),
        }]).slice(-12),
      });
      if (!snap.exists) {
        patch.wamid = String(wamid);
        patch.orpheline = true;
        patch.date = new Date().toISOString();
      }
      if (rangNouveau >= rangActuel) patch.statut = statut;

      tx.set(ref, patch, { merge: true });
    });
  } catch (e) {
    console.error('[whatsapp-webhook] statut', wamid, e && e.message);
  }

  /* Le même statut se répercute sur le message du fil, sinon la boîte
     partagée afficherait éternellement « envoyé » sur un message échoué.
     `recipient_id` donne la conversation sans requête.

     ET LE MOTIF AVEC LUI. Pendant des semaines, `erreurMeta` n'était écrit que
     sur la ligne technique de `whatsapp_messages` : l'interface ne pouvait
     afficher qu'un ⚠ muet, et comprendre un échec demandait d'ouvrir la
     console Firestore. Un code d'erreur qui n'atteint pas l'écran ne sert à
     personne — c'est ce qui a coûté une heure sur le blocage 131042. */
  if (st.recipient_id) {
    try {
      const patchFil = { statut: statut, statutA: Date.now() };
      if (maj.erreurMeta) patchFil.erreurMeta = maj.erreurMeta;
      await db.collection('whatsapp_conversations').doc(String(st.recipient_id))
        .collection('messages').doc(String(wamid))
        .set(patchFil, { merge: true });
    } catch (e) {
      console.warn('[whatsapp-webhook] statut fil', wamid, e && e.message);
    }
  }
}

/* Les types de message qui portent un fichier, et l'étiquette lisible qui les
   représente dans la liste des conversations. Sans elle, une photo produisait
   une bulle VIDE avec juste l'heure : le message était bien enregistré, mais
   `texte` restait null parce que seuls text/button/interactive étaient lus. */
const GENRES_MEDIA = {
  image:    { libelle: '📷 Photo' },
  video:    { libelle: '🎬 Vidéo' },
  audio:    { libelle: '🎵 Audio' },
  document: { libelle: '📎 Document' },
  sticker:  { libelle: '😀 Sticker' },
};

/* Slug d'équipe → uid Firebase. `leads.assignedTo` porte un slug (`elodie`),
   alors que `inbox_notifications.ownerUid` est interrogé par uid : sans cette
   conversion, la notification n'atteindrait jamais la personne assignée.
   Cache au niveau module — une lecture par cold start, comme les identifiants. */
let _membres = null;

async function uidDuSlug(slug) {
  if (!slug) return null;
  if (!_membres) {
    /* Le cache ne retient QUE les succès : mémoriser une lecture ratée
       priverait d'attribution tous les messages reçus jusqu'au prochain cold
       start, sans rien dans les journaux pour l'expliquer. */
    const table = {};
    try {
      const snap = await db.collection('_meta').doc('team_members').get();
      const brut = (snap.exists ? (snap.data() || {}) : {}).members;
      /* `members` est tantôt une map, tantôt un tableau — Firestore convertit
         selon la façon dont le document a été écrit. Même tolérance que
         nav.js, et toujours le `slug` interne comme clé de vérité. */
      const entrees = Array.isArray(brut) ? brut
        : (brut && typeof brut === 'object' ? Object.keys(brut).map((k) => (
            Object.assign({ slug: k }, brut[k])
          )) : []);
      entrees.forEach((m) => {
        if (m && m.slug && m.firebaseUid) table[String(m.slug)] = String(m.firebaseUid);
      });
      _membres = table;
    } catch (e) {
      console.warn('[whatsapp-webhook] team_members illisible :', e && e.message);
      return null;
    }
  }
  return _membres[String(slug)] || null;
}

/**
 * Crée la notification de la cloche pour un WhatsApp entrant.
 *
 * Même collection et même schéma que les SMS (api/twilio-sms-inbound.js) : le
 * widget sait déjà jouer le son, empiler le toast et compter les non-lus, il
 * ne lui manquait qu'une source. `ownerUid: null` signifie « visible des
 * admins seulement » — exactement la règle déjà appliquée à un SMS dont le
 * numéro n'est rattaché à aucune fiche.
 *
 * Ne lance jamais : une notification manquée ne doit pas empêcher le message
 * d'être enregistré.
 */
async function notifierInbox(o) {
  try {
    /* Identifiant dérivé du wamid plutôt qu'auto-généré : Meta rejoue un
       webhook dès qu'une réponse tarde, et un `add()` empilerait alors une
       seconde cloche pour le même message. Le `/` est neutralisé — un wamid
       est du base64, et une barre oblique y couperait le chemin du document. */
    const cle = 'wa_' + String(o.wamid || '').replace(/\//g, '_');
    await db.collection('inbox_notifications').doc(cle).set({
      type: 'whatsapp',
      direction: 'inbound',
      leadId: o.leadId || null,
      leadName: o.leadName || null,
      fromNumber: o.fromNumber ? '+' + String(o.fromNumber) : null,
      toNumber: null,
      preview: o.preview ? String(o.preview).substring(0, 200) : null,
      ownerUid: o.ownerUid || null,
      ownerSlug: o.ownerSlug || null,
      /* Le clic mène à la boîte partagée, jamais au composeur SMS : répondre à
         un WhatsApp par un SMS Twilio partirait du mauvais numéro, sans que
         personne le remarque. */
      deepLinkUrl: 'whatsapp.html?n=' + encodeURIComponent(String(o.fromNumber || '')),
      source: 'whatsapp',
      providerMessageSid: o.wamid || null,
      readBy: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      /* `merge` préserve les `readBy` déjà posés : un rejeu ne doit pas faire
         repasser en non lu un message que quelqu'un a déjà traité. */
    }, { merge: true });
  } catch (e) {
    console.error('[whatsapp-webhook] notifierInbox', e && e.message);
  }
}

/**
 * Enregistre un message entrant. On ne répond à rien ici : la vague 1 se
 * contente d'écouter. Répondre automatiquement à un client demanderait des
 * règles métier qui n'ont pas été arbitrées.
 */
async function enregistrerEntrant(msg, contacts) {
  const wamid = msg && msg.id;
  if (!wamid) return;

  const de = msg.from || null;
  let nom = null;
  if (Array.isArray(contacts)) {
    const c = contacts.find((x) => x && x.wa_id === de);
    if (c && c.profile) nom = c.profile.name || null;
  }

  const type = msg.type || null;
  let texte = null;
  if (type === 'text' && msg.text) texte = msg.text.body || null;
  else if (type === 'button' && msg.button) texte = msg.button.text || null;
  else if (type === 'interactive' && msg.interactive) {
    const it = msg.interactive;
    texte = (it.button_reply && it.button_reply.title)
      || (it.list_reply && it.list_reply.title)
      || null;
  }

  /* ── Pièce jointe ────────────────────────────────────────────────────
     Le webhook ne reçoit qu'un identifiant : on rapatrie le fichier tout de
     suite. C'est un aller-retour réseau de plus AVANT la réponse 200, mais
     Vercel tue la fonction dès `res.end()` — un téléchargement lancé sans être
     attendu ne finirait jamais. Une photo de téléphone pèse quelques centaines
     de kilo-octets : le coût est sans commune mesure avec une bulle vide. */
  const extra = { type: type };
  const genre = GENRES_MEDIA[type];
  if (genre) {
    const charge = msg[type] || {};
    const nomFichier = charge.filename || null;
    /* Un vocal et un fichier audio joint sont deux gestes différents, et
       l'équipe ne les traite pas pareil. */
    const libelle = (type === 'audio' && charge.voice === true)
      ? '🎤 Message vocal'
      : (type === 'document' && nomFichier ? '📎 ' + nomFichier : genre.libelle);
    const legende = charge.caption || null;

    extra.media = type;
    extra.mime = charge.mime_type || null;
    extra.nomFichier = nomFichier;
    extra.legende = legende;
    extra.libelleMedia = libelle;

    const imp = await importerMediaEntrant({ mediaId: charge.id, numero: de, wamid: wamid });
    if (imp.ok) {
      extra.mediaUrl = imp.mediaUrl;
      extra.mime = imp.mime || extra.mime;
      extra.taille = imp.taille || null;
    } else {
      /* Le message reste, la pièce jointe manque : on écrit pourquoi plutôt
         que de laisser une bulle muette de plus. */
      extra.mediaErreur = imp.erreur || 'media_indisponible';
      console.warn('[whatsapp-webhook] média', type, wamid, ':', extra.mediaErreur);
    }

    /* La liste des conversations et la notification ont besoin d'un texte :
       la légende quand il y en a une, l'étiquette du média sinon. */
    texte = legende || libelle;
  }

  try {
    await db.collection('whatsapp_inbound').doc(String(wamid)).set({
      wamid: String(wamid),
      de: de,
      nom: nom,
      type: type,
      texte: texte,
      media: extra.media || null,
      mediaUrl: extra.mediaUrl || null,
      mime: extra.mime || null,
      /* Horodatage Meta en secondes — on garde les deux pour pouvoir trier
         même si l'un des deux manque. */
      tsMeta: msg.timestamp ? Number(msg.timestamp) * 1000 : null,
      at: Date.now(),
      date: new Date().toISOString(),
      traite: false,
    }, { merge: true });
  } catch (e) {
    console.error('[whatsapp-webhook] entrant', wamid, e && e.message);
  }

  /* Et il rejoint la boîte partagée, en rouvrant la fenêtre de 24 h. C'est le
     seul évènement qui autorise à nouveau un message libre vers ce contact. */
  if (de) {
    await majConversation(de, {
      sens: 'in',
      wamid: wamid,
      texte: texte,
      nom: nom,
      statut: 'recu',
      extra: extra,
    });

    /* La cloche. Le rattachement est refait ici plutôt que lu sur la
       conversation : `majConversation` ne le tente qu'à la CRÉATION du
       document, donc une conversation ancienne dont le lead a été créé depuis
       n'aurait jamais de propriétaire. */
    const lead = await rattacherLead(de);
    const ownerSlug = (lead && lead.assignedTo) || null;
    await notifierInbox({
      leadId: lead ? lead.leadId : null,
      leadName: (lead && lead.nom) || nom || null,
      fromNumber: de,
      preview: texte,
      ownerUid: await uidDuSlug(ownerSlug),
      ownerSlug: ownerSlug,
      wamid: wamid,
    });

    /* La fenêtre de 24 h recopiée SUR LE LEAD. Le feed de Leads Live ne lit
       que `leads` : sans ce champ, savoir qu'il reste deux heures pour
       répondre imposerait d'ouvrir la conversation — c'est-à-dire de le
       découvrir trop tard, ce que le compte à rebours doit justement éviter.

       La donnée fait double emploi avec `whatsapp_conversations`, et c'est
       assumé : la conversation reste la vérité, le lead n'en porte qu'un
       reflet daté, rafraîchi à chaque message entrant. */
    if (lead && lead.leadId) {
      await db.collection('leads').doc(String(lead.leadId)).set({
        whatsappFenetre: Date.now() + FENETRE_MS,
      }, { merge: true }).catch((e) => console.warn('[whatsapp-webhook] fenêtre lead:', e && e.message));
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // ── Poignée de main de vérification ────────────────────────────────────
  if (req.method === 'GET') {
    const q = req.query || {};
    const mode = q['hub.mode'];
    const jeton = q['hub.verify_token'];
    const defi = q['hub.challenge'];

    let creds;
    try {
      creds = await getWhatsappCreds();
    } catch (e) {
      console.error('[whatsapp-webhook] creds:', e && e.message);
      res.status(503).end();
      return;
    }
    if (!creds.verifyToken) {
      console.error('[whatsapp-webhook] verifyToken absent de _config/whatsapp_credentials');
      res.status(503).end();
      return;
    }

    if (mode === 'subscribe' && egalTempsConstant(String(jeton || ''), creds.verifyToken)) {
      /* Meta attend le défi en TEXTE BRUT. Un JSON ferait échouer la
         validation de l'URL sans message d'erreur exploitable. */
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(String(defi || ''));
      return;
    }
    console.warn('[whatsapp-webhook] vérification refusée');
    res.status(403).end();
    return;
  }

  if (req.method !== 'POST') { res.status(405).end(); return; }

  // ── 1. Corps brut ──────────────────────────────────────────────────────
  let brut;
  try {
    brut = await lireCorpsBrut(req);
  } catch (e) {
    console.error('[whatsapp-webhook] lecture corps:', e && e.message);
    res.status(400).json({ error: 'body_unreadable' });
    return;
  }
  if (!brut) { res.status(400).json({ error: 'empty_body' }); return; }

  // ── 2. Signature — obligatoire, aucun contournement ────────────────────
  let creds;
  try {
    creds = await getWhatsappCreds();
  } catch (e) {
    console.error('[whatsapp-webhook] creds:', e && e.message);
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  if (!creds.appSecret) {
    console.error('[whatsapp-webhook] appSecret absent de _config/whatsapp_credentials');
    res.status(503).json({ error: 'app_secret_missing' });
    return;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') {
    console.warn('[whatsapp-webhook] signature absente');
    res.status(401).json({ error: 'missing_signature' });
    return;
  }
  const attendue = 'sha256=' + crypto
    .createHmac('sha256', creds.appSecret)
    .update(brut, 'utf8')
    .digest('hex');

  if (!egalTempsConstant(signature, attendue)) {
    console.warn('[whatsapp-webhook] signature invalide');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  // ── 3. Traitement ──────────────────────────────────────────────────────
  let charge;
  try {
    charge = JSON.parse(brut);
  } catch (e) {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  let nbStatuts = 0;
  let nbEntrants = 0;
  try {
    const entrees = Array.isArray(charge.entry) ? charge.entry : [];
    for (let i = 0; i < entrees.length; i++) {
      const changements = Array.isArray(entrees[i].changes) ? entrees[i].changes : [];
      for (let j = 0; j < changements.length; j++) {
        const v = changements[j].value || {};
        const statuts = Array.isArray(v.statuses) ? v.statuses : [];
        for (let k = 0; k < statuts.length; k++) {
          await appliquerStatut(statuts[k]);
          nbStatuts++;
        }
        const messages = Array.isArray(v.messages) ? v.messages : [];
        for (let m = 0; m < messages.length; m++) {
          await enregistrerEntrant(messages[m], v.contacts);
          nbEntrants++;
        }
      }
    }
  } catch (e) {
    console.error('[whatsapp-webhook] traitement:', e && e.stack ? e.stack : e);
  }

  if (nbStatuts || nbEntrants) {
    console.log('[whatsapp-webhook]', nbStatuts + ' statut(s), ' + nbEntrants + ' entrant(s)');
  }

  /* 200 systématique une fois la signature validée et les écritures tentées.
     Un autre code ferait rejouer l'événement par Meta en boucle, sans que le
     rejeu ait la moindre chance de mieux se passer. Toutes les écritures sont
     déjà terminées ici — Vercel tue la fonction dès la réponse envoyée. */
  res.status(200).json({ ok: true });
};
