// ============================================================================
// api/instagram-webhook.js — WEBHOOK INSTAGRAM (Meta)
// ----------------------------------------------------------------------------
// GET  /api/instagram-webhook   → poignée de main de vérification Meta
// POST /api/instagram-webhook   → messages privés + commentaires en temps réel
//
// POURQUOI IL EXISTE
// ------------------
// Les messages privés Instagram n'ont AUCUNE API de statistiques et AUCUNE API
// de rattrapage : Meta ne dira jamais « tu as envoyé 340 DM le mois dernier,
// 96 ont répondu ». La seule façon de connaître un taux de réponse est de
// journaliser les messages au fil de l'eau, à partir du jour du branchement.
// Tout ce qui précède la mise en service est définitivement hors d'atteinte —
// ce n'est pas un défaut de ce fichier, c'est la nature de la plateforme.
//
// LES DM ENVOYÉS À LA MAIN DEPUIS L'APPLICATION COMPTENT AUSSI
// ------------------------------------------------------------
// Élodie et l'équipe répondent depuis l'app Instagram, pas depuis un outil.
// Meta renvoie ces messages sortants sous forme d'ÉCHOS (`message.is_echo`),
// à condition que l'application soit abonnée au champ `messages` et que
// l'accès aux outils connectés soit actif sur le compte. C'est ce mécanisme,
// et lui seul, qui rend le taux de réponse mesurable sans changer les
// habitudes de personne.
//
// ⚠️ Si les échos n'arrivent pas (abonnement partiel, réglage de la boîte),
// on verra des messages entrants sans sortants : le taux de réponse serait
// alors faux par construction. D'où le compteur `outboundCount` global exposé
// dans l'onglet Instagram — s'il reste à zéro alors que l'équipe envoie des
// DM, c'est le réglage Meta qu'il faut corriger, pas la statistique.
//
// DEUX SECRETS, DEUX RÔLES DIFFÉRENTS — même discipline que whatsapp-webhook :
//   · `verifyToken` — chaîne QUE NOUS CHOISISSONS, rejouée par Meta lors de
//     la poignée de main. Elle prouve que l'URL nous appartient.
//   · `appSecret`   — clé secrète de l'application Meta, qui signe chaque
//     POST. Elle prouve que le contenu vient bien de Meta.
//
// AUCUN CONTOURNEMENT SILENCIEUX : sans `appSecret` en base, on répond 503.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const IG = require('./_instagramClient');

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

/* ══════════════════════════════════════════════════════════════════════
   PROFIL D'UN INTERLOCUTEUR — résolu une seule fois par conversation
   ══════════════════════════════════════════════════════════════════════ */
async function resoudreProfil(igsid, creds) {
  try {
    const p = await IG.graphGet(String(igsid), { fields: 'username,name' }, creds);
    return { username: IG.normaliserUsername(p.username), name: p.name || null };
  } catch (e) {
    /* Un profil non résolu n'est pas un incident : la conversation existe,
       elle sera simplement anonyme dans le tableau. */
    console.warn('[instagram-webhook] profil', igsid, e.message);
    return { username: null, name: null };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   MESSAGE PRIVÉ — journal + agrégat de conversation
   ══════════════════════════════════════════════════════════════════════ */
async function traiterMessage(ev, creds, rapport) {
  const msg = ev.message || {};
  const mid = msg.mid ? String(msg.mid) : null;
  if (!mid) return;

  const estEcho = msg.is_echo === true;
  const igsid = String(estEcho ? (ev.recipient && ev.recipient.id) : (ev.sender && ev.sender.id) || '');
  if (!igsid || igsid === 'undefined') return;

  const ts = Number(ev.timestamp) || Date.now();
  const direction = estEcho ? 'out' : 'in';
  const jour = IG.jourParis(ts);

  /* 1. Journal brut — l'identifiant EST le `mid` Meta : un webhook rejoué
     (Meta réessaie jusqu'à 3 fois en cas de lenteur) ne compte pas deux
     fois le même message. C'est la seule protection qui tienne. */
  const refEvent = db.collection('ig_dm_events').doc(mid);
  const dejaVu = await refEvent.get();
  if (dejaVu.exists) { rapport.doublons++; return; }

  await refEvent.set({
    mid: mid,
    igsid: igsid,
    direction: direction,
    text: msg.text != null ? String(msg.text).slice(0, 2000) : '',
    hasAttachment: Array.isArray(msg.attachments) && msg.attachments.length > 0,
    isDeleted: msg.is_deleted === true,
    timestampMs: ts,
    date: jour,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  rapport.messages++;

  /* 2. Agrégat de conversation — en transaction : Meta livre les événements
     en parallèle, deux messages simultanés se marcheraient dessus avec un
     simple update. */
  const refThread = db.collection('ig_dm_threads').doc(igsid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(refThread);
    const d = snap.exists ? (snap.data() || {}) : {};
    const patch = {
      igsid: igsid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      patch.firstEventMs = ts;
      patch.firstEventDate = jour;
      /* Qui a ouvert la conversation ? C'est ce qui distingue « nous avons
         démarché, ont-ils répondu ? » de « ils nous ont écrit, avons-nous
         répondu ? ». Mélanger les deux rendrait le taux ininterprétable. */
      patch.initiatedBy = direction === 'out' ? 'us' : 'them';
      patch.outboundCount = 0;
      patch.inboundCount = 0;
    }

    if (direction === 'out') {
      patch.outboundCount = (d.outboundCount || 0) + 1;
      patch.lastOutboundMs = ts;
      if (!d.firstOutboundMs) {
        patch.firstOutboundMs = ts;
        patch.firstOutboundDate = jour;
      }
      /* Notre délai de réponse à un message entrant resté sans réponse. */
      if (d.lastInboundMs && !d.ourReplyDelayMs && (d.initiatedBy === 'them' || !d.firstOutboundMs)) {
        patch.ourReplyDelayMs = ts - d.lastInboundMs;
      }
    } else {
      patch.inboundCount = (d.inboundCount || 0) + 1;
      patch.lastInboundMs = ts;
      if (!d.firstInboundMs) {
        patch.firstInboundMs = ts;
        patch.firstInboundDate = jour;
      }
      /* LE chiffre : une réponse APRÈS notre premier message sortant. */
      const premierOut = d.firstOutboundMs || (direction === 'out' ? ts : null);
      if (premierOut && !d.replied && ts >= premierOut) {
        patch.replied = true;
        patch.repliedAtMs = ts;
        patch.responseDelayMs = ts - premierOut;
      }
    }

    /* Profil et rattachement : une seule fois par conversation. Résoudre le
       pseudo à chaque message multiplierait les appels Graph par le volume
       de DM, pour une information qui ne change jamais. */
    if (!d.profilResolu) {
      patch.profilResolu = true;
      const prof = await resoudreProfil(igsid, creds);
      patch.username = prof.username;
      patch.name = prof.name;
      if (prof.username) {
        const lead = await IG.trouverLeadParUsername(prof.username);
        if (lead) { patch.leadId = lead.id; patch.leadNom = lead.nom || null; }
      }
    }

    tx.set(refThread, patch, { merge: true });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   COMMENTAIRE EN TEMPS RÉEL
   ══════════════════════════════════════════════════════════════════════ */
async function traiterCommentaire(value, creds, rapport) {
  const id = value && value.id ? String(value.id) : null;
  if (!id) return;

  const mediaId = value.media && value.media.id ? String(value.media.id) : null;
  const from = value.from || {};
  const username = IG.normaliserUsername(from.username);
  const texte = value.text != null ? String(value.text) : '';
  /* Même règle que le cron : un commentaire du compte lui-même n'est jamais
     un GO. C'est lui qui porte la consigne « écris GO ». */
  const estAuteur = !!(creds.compteNom && username === IG.normaliserUsername(creds.compteNom));
  const isGo = !estAuteur && IG.contientMotCle(texte, creds.keywords);

  const ref = db.collection('ig_comments').doc(id);
  const dejaVu = await ref.get();
  if (dejaVu.exists) { rapport.doublons++; return; }

  let leadId = null;
  if (username) {
    const lead = await IG.trouverLeadParUsername(username);
    if (lead) leadId = lead.id;
  }

  const maintenant = Date.now();
  await ref.set({
    commentId: id,
    mediaId: mediaId,
    username: username,
    isAuthor: estAuteur,
    igsid: from.id ? String(from.id) : null,
    text: texte.slice(0, 2000),
    isGo: isGo,
    timestamp: new Date(maintenant).toISOString(),
    date: IG.jourParis(maintenant),
    leadId: leadId,
    viaWebhook: true,
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  rapport.commentaires++;

  /* Compteur de la publication mis à jour en direct. Le cron de nuit
     recalcule le total depuis la source et corrige l'éventuel écart — le
     webhook donne l'instantané, le cron donne la vérité. */
  if (mediaId) {
    const patch = {
      mediaId: mediaId,
      commentsWebhookAt: admin.firestore.FieldValue.serverTimestamp(),
      comments: admin.firestore.FieldValue.increment(1),
    };
    if (isGo) {
      patch.goCount = admin.firestore.FieldValue.increment(1);
      rapport.go++;
    }
    await db.collection('ig_media').doc(mediaId).set(patch, { merge: true });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  let creds;
  try {
    creds = await IG.getInstagramCreds();
  } catch (e) {
    console.error('[instagram-webhook] identifiants indisponibles:', e.message);
    res.status(503).json({ error: 'instagram_not_configured' });
    return;
  }

  // ─── GET : poignée de main Meta ────────────────────────────────────
  if (req.method === 'GET') {
    if (!creds.verifyToken) {
      console.error('[instagram-webhook] verifyToken absent de _config/instagram_credentials');
      res.status(503).send('not_configured');
      return;
    }
    const q = req.query || {};
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];
    if (mode === 'subscribe' && IG.egalTempsConstant(String(token || ''), creds.verifyToken)) {
      res.status(200).send(String(challenge || ''));
      return;
    }
    console.warn('[instagram-webhook] handshake refusé');
    res.status(403).send('forbidden');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ─── POST : signature obligatoire ──────────────────────────────────
  if (!creds.appSecret) {
    console.error('[instagram-webhook] appSecret absent — refus de traiter');
    res.status(503).json({ error: 'app_secret_missing' });
    return;
  }

  let brut = '';
  try { brut = await lireCorpsBrut(req); }
  catch (e) { res.status(400).json({ error: 'body_unreadable' }); return; }

  const signature = req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'];
  if (!IG.verifierSignature(brut, signature, creds.appSecret)) {
    console.warn('[instagram-webhook] signature invalide');
    res.status(401).json({ error: 'bad_signature' });
    return;
  }

  let payload = {};
  try { payload = brut ? JSON.parse(brut) : {}; } catch (_) { payload = {}; }

  const rapport = { messages: 0, commentaires: 0, go: 0, doublons: 0, erreurs: 0 };
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  /* Traitement AVANT la réponse : Vercel tue la fonction dès res.end(), une
     écriture Firestore encore en vol serait perdue. Règle éprouvée sur les
     webhooks GoCardless et WhatsApp. */
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};

    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (let j = 0; j < messaging.length; j++) {
      const ev = messaging[j] || {};
      if (!ev.message) continue;               // lectures, réactions : ignorés
      try { await traiterMessage(ev, creds, rapport); }
      catch (e) { rapport.erreurs++; console.error('[instagram-webhook] message', e.message); }
    }

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (let k = 0; k < changes.length; k++) {
      const ch = changes[k] || {};
      if (ch.field !== 'comments') continue;
      try { await traiterCommentaire(ch.value || {}, creds, rapport); }
      catch (e) { rapport.erreurs++; console.error('[instagram-webhook] commentaire', e.message); }
    }
  }

  /* 200 systématique dès lors que la signature est bonne : un 500 ferait
     rejouer Meta en boucle sur un événement qu'on ne saura pas mieux traiter
     au deuxième passage. Les échecs unitaires sont comptés et journalisés. */
  res.status(200).json({ ok: true, ...rapport });
};

// ─── Config Vercel : bodyParser DÉSACTIVÉ ───────────────────────────────
// La signature Meta porte sur les OCTETS BRUTS. Si Vercel parse le corps en
// amont, le flux est déjà consommé quand on le relit : le corps arrive vide,
// la signature ne correspond jamais et tout est rejeté en 401. Même réglage
// que api/gocardless-webhook.js, éprouvé en production.
module.exports.config = { api: { bodyParser: false } };
