// ============================================================================
// api/twilio-sms-status.js — CE QUE DEVIENT UN SMS APRÈS L'ENVOI
// ----------------------------------------------------------------------------
// Rappel de statut Twilio (statusCallback). Twilio appelle cette URL à chaque
// changement d'état d'un message : queued → sent → delivered, ou → undelivered
// / failed avec un code d'erreur opérateur.
//
// POURQUOI CET ENDPOINT EXISTE
// ----------------------------
// `messages.create()` qui rend la main sans erreur signifie UNIQUEMENT que
// Twilio a ACCEPTÉ le message. Il ne dit rien de la livraison. Un commentaire
// de api/twilio-sms-send.js affirmait le contraire (« Twilio garantit que si
// messages.create() renvoie sans erreur, le SMS est bien envoyé ») : c'est
// faux, et c'est précisément ce qui a rendu invisible le problème des codes
// de signature qui n'arrivent pas. L'API répondait 200, la page affichait
// « ✅ Code envoyé », et le signataire attendait un SMS que l'opérateur avait
// filtré — sans que personne ne puisse le savoir.
//
// En France, un message parti d'un numéro non déclaré est régulièrement
// bloqué par l'opérateur : Twilio renvoie alors 30007 (filtré), 30006
// (numéro non joignable) ou 21612 (route indisponible), et TOUJOURS de façon
// asynchrone. Sans ce rappel, ces codes n'existent nulle part chez nous.
//
// URL   : POST /api/twilio-sms-status   (à déclarer comme statusCallback)
// Auth  : signature X-Twilio-Signature vérifiée — endpoint public sinon.
// Corps : form-urlencoded Twilio (MessageSid, MessageStatus, ErrorCode…)
//
// OÙ VA L'INFORMATION
//   sms_delivery/{MessageSid}   — statut, code d'erreur, horodatage
//   signature_otp/{reqId}       — miroir du dernier statut, pour que la page
//                                 de signature puisse le lire et cesser de
//                                 faire patienter le signataire pour rien.
//
// COUCHE ADDITIVE : aucun parcours existant n'est modifié. Si ce rappel tombe
// en panne, l'envoi de SMS continue exactement comme avant.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { verifyTwilioSignature } = require('./_twilioSignature');
const { getTwilioCreds } = require('./_twilioClient');

/* Ce que chaque statut veut dire pour nous. Twilio en ajoute régulièrement :
   tout état inconnu est traité comme « en cours », jamais comme un échec. */
const ECHECS = { undelivered: 1, failed: 1 };
const SUCCES = { delivered: 1 };

/* Les codes qu'on rencontre réellement sur la France, traduits pour un humain
   qui n'ira pas chercher dans la documentation Twilio. */
const EXPLICATIONS = {
  30003: "Téléphone éteint, hors réseau ou injoignable.",
  30004: "Le numéro a bloqué les messages.",
  30005: "Numéro inconnu ou plus attribué.",
  30006: "Ligne fixe, ou numéro incapable de recevoir des SMS.",
  30007: "Message filtré par l'opérateur — c'est le cas le plus fréquent en France quand le numéro d'envoi n'est pas déclaré auprès des opérateurs.",
  30008: "Échec inconnu côté opérateur.",
  21211: "Numéro de destination invalide.",
  21408: "Le compte Twilio n'est pas autorisé à envoyer vers ce pays (permissions géographiques).",
  21610: "Ce numéro s'est désabonné (STOP).",
  21612: "Aucune route disponible entre le numéro d'envoi et ce destinataire.",
  21614: "Le numéro de destination ne peut pas recevoir de SMS.",
};

function expliquer(code) {
  if (!code) return '';
  return EXPLICATIONS[String(code)] || EXPLICATIONS[Number(code)] || 'Échec signalé par l\'opérateur (code ' + code + ').';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  /* Twilio signe ses rappels avec l'Auth Token du compte émetteur. On le lit
     LÀ OÙ IL VIT DÉJÀ — _config/telco_credentials, la même source que l'envoi —
     plutôt que de dépendre d'une variable d'environnement dont rien ne garantit
     la présence : un jeton absent ferait rejeter tous les rappels en 403, et on
     n'apprendrait jamais pourquoi les SMS n'arrivent pas. La variable reste
     acceptée en second recours. */
  let authToken = null;
  try {
    const creds = await getTwilioCreds();
    authToken = (creds && creds.authToken) || null;
  } catch (e) {
    console.error('[twilio-sms-status] identifiants Twilio illisibles :', e && e.message);
  }
  if (!authToken) authToken = process.env.TWILIO_AUTH_TOKEN || null;

  if (!verifyTwilioSignature(req, authToken)) {
    res.status(403).json({ error: 'Invalid or missing Twilio signature' });
    return;
  }

  /* Twilio envoie du form-urlencoded, que Vercel parse déjà en objet. */
  const b = req.body || {};
  const sid = String(b.MessageSid || b.SmsSid || '').trim();
  const statut = String(b.MessageStatus || b.SmsStatus || '').trim().toLowerCase();
  if (!sid || !statut) { res.status(200).end(); return; }

  const code = b.ErrorCode ? String(b.ErrorCode) : null;
  const echec = !!ECHECS[statut];

  const trace = {
    sid,
    statut,
    livre: !!SUCCES[statut],
    echec,
    errorCode: code,
    explication: echec ? expliquer(code) : '',
    to: b.To || null,
    from: b.From || null,
    majAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection('sms_delivery').doc(sid).set(trace, { merge: true });

    /* Miroir sur la demande de signature concernée, quand on la connaît :
       c'est ce que lit la page de signature pour arrêter de faire attendre
       quelqu'un dont le SMS ne viendra jamais.

       ⚠ reqId voyage dans la QUERY de l'URL de rappel, pas dans le corps :
       Twilio ne recopie pas les paramètres d'URL dans les champs POST. Le lire
       dans le body aurait toujours donné vide, et le miroir n'aurait jamais
       été écrit — l'échec serait resté invisible côté page de signature. */
    const reqId = String((req.query && req.query.reqId) || b.reqId || '').trim();
    if (reqId) {
      await db.collection('signature_otp').doc(reqId).set({
        livraison: { sid, statut, echec, errorCode: code, explication: trace.explication, at: Date.now() },
      }, { merge: true });
    }

    if (echec) {
      console.error('[twilio-sms-status] NON DÉLIVRÉ', sid, statut, code, trace.explication, 'to=' + (b.To || '?'));
    }
  } catch (e) {
    /* On ne renvoie jamais d'erreur à Twilio : il réessaierait en boucle.
       La trace console suffit à ne pas perdre l'information. */
    console.error('[twilio-sms-status] écriture', e && e.message);
  }

  res.status(200).end();
};
