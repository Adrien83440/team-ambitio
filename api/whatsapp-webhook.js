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
const { db } = require('./_firebaseAdmin');
const { getWhatsappCreds } = require('./_whatsappClient');

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

  let texte = null;
  if (msg.type === 'text' && msg.text) texte = msg.text.body || null;
  else if (msg.type === 'button' && msg.button) texte = msg.button.text || null;
  else if (msg.type === 'interactive' && msg.interactive) {
    const it = msg.interactive;
    texte = (it.button_reply && it.button_reply.title)
      || (it.list_reply && it.list_reply.title)
      || null;
  }

  try {
    await db.collection('whatsapp_inbound').doc(String(wamid)).set({
      wamid: String(wamid),
      de: de,
      nom: nom,
      type: msg.type || null,
      texte: texte,
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
