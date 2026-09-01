// ============================================================================
// api/facebook-webhook.js — WEBHOOK PAGE FACEBOOK (Meta)
// ----------------------------------------------------------------------------
// GET  /api/facebook-webhook   → poignée de main de vérification Meta
// POST /api/facebook-webhook   → commentaires et Messenger en temps réel
//
// CE QU'IL APPORTE — ET CE QU'IL N'APPORTE PAS
// --------------------------------------------
// Contrairement à Instagram, Facebook n'a pas BESOIN de ce webhook pour que
// les chiffres existent : `/{page-id}/conversations` et `/{post-id}/comments`
// rendent l'historique, et le cron de nuit suffit à tout reconstruire. Le
// webhook ne sert donc qu'à une chose : ne pas attendre demain matin pour
// voir un GO ou un message arriver.
//
// Conséquence directe sur la conception : EN CAS DE DOUTE, C'EST LE CRON QUI
// A RAISON. Le webhook incrémente des compteurs entre deux passages ; la
// synchronisation de nuit les recalcule depuis la source et corrige l'écart.
// Un webhook manqué n'est jamais une donnée perdue — c'est un affichage en
// retard de quelques heures.
//
// DEUX SECRETS, DEUX RÔLES — même discipline que les autres webhooks du repo :
//   · `verifyToken` — chaîne QUE NOUS CHOISISSONS, rejouée par Meta lors de
//     la poignée de main : elle prouve que l'URL nous appartient.
//   · `appSecret`   — clé de l'application, qui signe chaque POST : elle
//     prouve que le contenu vient bien de Meta.
// AUCUN CONTOURNEMENT SILENCIEUX : sans `appSecret` en base, on répond 503.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const FB = require('./_facebookClient');

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
   COMMENTAIRE EN TEMPS RÉEL (champ `feed`)
   ══════════════════════════════════════════════════════════════════════ */
async function traiterFeed(value, creds, rapport) {
  /* Le champ `feed` porte TOUT ce qui bouge sur la Page — publications,
     réactions, partages. Seuls les commentaires ajoutés nous intéressent :
     le reste est recalculé par le cron, et un « like » traité ici ne ferait
     qu'ajouter du bruit et des écritures. */
  if (!value || value.item !== 'comment' || value.verb !== 'add') return;
  const id = value.comment_id ? String(value.comment_id) : null;
  if (!id) return;

  const ref = db.collection('fb_comments').doc(id);
  const dejaVu = await ref.get();
  if (dejaVu.exists) { rapport.doublons++; return; }

  const from = value.from || {};
  const authorId = from.id ? String(from.id) : null;
  const authorName = from.name ? String(from.name) : null;
  const estPage = authorId === creds.pageId;
  const isGo = !estPage && FB.contientMotCle(value.message, creds.keywords);

  let leadId = null;
  if (authorName) {
    const lead = await FB.trouverLeadParNomFb(authorName);
    if (lead) leadId = lead.id;
  }

  const ms = value.created_time ? Number(value.created_time) * 1000 : Date.now();

  await ref.set({
    commentId: id,
    postId: value.post_id ? String(value.post_id) : null,
    pageId: creds.pageId,
    authorId: authorId,
    authorName: authorName,
    isPage: estPage,
    isReply: !!(value.parent_id && value.parent_id !== value.post_id),
    parentId: value.parent_id ? String(value.parent_id) : null,
    text: value.message != null ? String(value.message).slice(0, 2000) : '',
    isGo: isGo,
    timestamp: new Date(ms).toISOString(),
    date: FB.jourParis(ms),
    leadId: leadId,
    viaWebhook: true,
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  rapport.commentaires++;

  /* Compteur de la publication mis à jour en direct. Le cron de nuit
     recalcule depuis la source et corrige l'écart : le webhook donne
     l'instantané, le cron donne la vérité. */
  if (value.post_id) {
    const patch = {
      postId: String(value.post_id),
      commentsWebhookAt: admin.firestore.FieldValue.serverTimestamp(),
      comments: admin.firestore.FieldValue.increment(1),
    };
    if (isGo) { patch.goCount = admin.firestore.FieldValue.increment(1); rapport.go++; }
    await db.collection('fb_posts').doc(String(value.post_id)).set(patch, { merge: true });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   MESSENGER EN TEMPS RÉEL
   ══════════════════════════════════════════════════════════════════════ */
async function traiterMessage(ev, creds, rapport) {
  const msg = ev.message || {};
  const mid = msg.mid ? String(msg.mid) : null;
  if (!mid) return;

  const estEcho = msg.is_echo === true;
  const psid = String(estEcho ? (ev.recipient && ev.recipient.id) : (ev.sender && ev.sender.id) || '');
  if (!psid || psid === 'undefined') return;

  const ts = Number(ev.timestamp) || Date.now();
  const direction = estEcho ? 'out' : 'in';

  /* L'identifiant EST le `mid` Meta : un webhook rejoué (Meta réessaie
     jusqu'à trois fois) ne compte pas deux fois le même message. */
  const refEvent = db.collection('fb_dm_events').doc(mid);
  const dejaVu = await refEvent.get();
  if (dejaVu.exists) { rapport.doublons++; return; }

  await refEvent.set({
    messageId: mid,
    psid: psid,
    direction: direction,
    text: msg.text != null ? String(msg.text).slice(0, 2000) : '',
    timestampMs: ts,
    date: FB.jourParis(ts),
    viaWebhook: true,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  rapport.messages++;

  /* Le fil est indexé par PSID tant que le cron n'a pas rapproché la
     conversation : lui seul connaît l'identifiant de conversation Meta et
     recalculera l'agrégat complet. Ici on ne fait que tenir l'écran à jour. */
  const refThread = db.collection('fb_dm_threads').doc('psid_' + psid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(refThread);
    const d = snap.exists ? (snap.data() || {}) : {};
    const patch = { psid: psid, pageId: creds.pageId, viaWebhook: true,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (!snap.exists) {
      patch.firstEventMs = ts;
      patch.firstEventDate = FB.jourParis(ts);
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
      if (!d.firstOutboundMs) patch.firstOutboundMs = ts;
      if (d.lastInboundMs && !d.ourReplyDelayMs && (d.initiatedBy === 'them' || !d.firstOutboundMs)) {
        patch.ourReplyDelayMs = ts - d.lastInboundMs;
      }
    } else {
      patch.inboundCount = (d.inboundCount || 0) + 1;
      patch.lastInboundMs = ts;
      if (!d.firstInboundMs) patch.firstInboundMs = ts;
      const premierOut = d.firstOutboundMs || null;
      if (premierOut && !d.replied && ts >= premierOut) {
        patch.replied = true;
        patch.responseDelayMs = ts - premierOut;
      }
    }
    tx.set(refThread, patch, { merge: true });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════ */
const handler = async (req, res) => {
  let creds;
  try {
    creds = await FB.getFacebookCreds();
  } catch (e) {
    console.error('[facebook-webhook] identifiants indisponibles:', e.message);
    res.status(503).json({ error: 'facebook_not_configured' });
    return;
  }

  if (req.method === 'GET') {
    if (!creds.verifyToken) {
      console.error('[facebook-webhook] verifyToken absent de _config/facebook_credentials');
      res.status(503).send('not_configured');
      return;
    }
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe'
        && FB.egalTempsConstant(String(q['hub.verify_token'] || ''), creds.verifyToken)) {
      res.status(200).send(String(q['hub.challenge'] || ''));
      return;
    }
    console.warn('[facebook-webhook] handshake refusé');
    res.status(403).send('forbidden');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!creds.appSecret) {
    console.error('[facebook-webhook] appSecret absent — refus de traiter');
    res.status(503).json({ error: 'app_secret_missing' });
    return;
  }

  let brut = '';
  try { brut = await lireCorpsBrut(req); }
  catch (e) { res.status(400).json({ error: 'body_unreadable' }); return; }

  const signature = req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'];
  if (!FB.verifierSignature(brut, signature, creds.appSecret)) {
    console.warn('[facebook-webhook] signature invalide');
    res.status(401).json({ error: 'bad_signature' });
    return;
  }

  let payload = {};
  try { payload = brut ? JSON.parse(brut) : {}; } catch (_) { payload = {}; }

  const rapport = { commentaires: 0, messages: 0, go: 0, doublons: 0, erreurs: 0 };
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  /* Traitement AVANT la réponse : Vercel tue la fonction dès res.end(), une
     écriture Firestore encore en vol serait perdue. */
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (let k = 0; k < changes.length; k++) {
      const ch = changes[k] || {};
      if (ch.field !== 'feed') continue;
      try { await traiterFeed(ch.value || {}, creds, rapport); }
      catch (e) { rapport.erreurs++; console.error('[facebook-webhook] feed', e.message); }
    }

    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (let j = 0; j < messaging.length; j++) {
      const ev = messaging[j] || {};
      if (!ev.message) continue;              // lectures, réactions : ignorés
      try { await traiterMessage(ev, creds, rapport); }
      catch (e) { rapport.erreurs++; console.error('[facebook-webhook] message', e.message); }
    }
  }

  /* 200 systématique dès lors que la signature est bonne : un 500 ferait
     rejouer Meta en boucle sur un événement qu'on ne saura pas mieux traiter
     au deuxième passage. Et ici, contrairement à Instagram, rien n'est
     définitivement perdu — le cron rattrape. */
  res.status(200).json({ ok: true, ...rapport });
};

module.exports = handler;

// ─── Config Vercel : bodyParser DÉSACTIVÉ ───────────────────────────────
// La signature Meta porte sur les OCTETS BRUTS. Si Vercel parse le corps en
// amont, le flux est déjà consommé quand on le relit : le corps arrive vide,
// la signature ne correspond jamais et tout est rejeté en 401.
module.exports.config = { api: { bodyParser: false } };
