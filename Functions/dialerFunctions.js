// ============================================================================
// Functions/dialerFunctions.js
// ----------------------------------------------------------------------------
// Firebase Cloud Functions pour le module Dialer de Team Ambitio.
// Ajouté en Step 5 de la Vague 1.
//
// Exports :
//   - getTwilioVoiceToken      (callable) — JWT pour le softphone
//   - searchAvailableNumbers   (callable admin) — recherche numéros Twilio
//   - purchasePhoneNumber      (callable admin) — achat numéro
//   - releasePhoneNumber       (callable admin) — libération numéro
//   - onTwilioWebhookInbox     (trigger Firestore) — handlers webhook Twilio
//   - dialerSessionCleanup     (scheduled) — nettoyage sessions zombies
//
// USAGE DANS index.js :
//   Ajouter UNE SEULE ligne à la fin du fichier :
//     Object.assign(exports, require('./dialerFunctions'));
//
//   (Ou si tu préfères des imports nommés, tu peux aussi faire :
//     const dialer = require('./dialerFunctions');
//     Object.assign(exports, dialer);
//   Les deux marchent.)
// ============================================================================

const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Init défensive (normalement déjà fait dans index.js)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const storage = admin.storage();

const twilioProvider = require('./telcoProviders/twilioProvider');
const twilioHandlers = require('./handlers/twilioHandlers');

// Région des Functions — aligne avec celle de tes Functions existantes
// (europe-west1 = Belgique, proche des données Firestore eur3)
const REGION = 'europe-west1';

// Base URL des endpoints Vercel
const WEBHOOK_BASE_URL = 'https://team.alteore.com';

// ============================================================================
// Helpers d'authentification
// ============================================================================

async function requireAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required'
    );
  }
  return context.auth;
}

async function requireAdmin(context) {
  await requireAuth(context);
  const userSnap = await db.collection('users').doc(context.auth.uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('permission-denied', 'User not found');
  }
  const userData = userSnap.data();
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Admin role required'
    );
  }
  return userData;
}

// ============================================================================
// CALLABLE: getTwilioVoiceToken
// ----------------------------------------------------------------------------
// Appelé par le softphone frontend au démarrage d'une session.
// Retourne un JWT Twilio Voice que le Twilio.Device utilise pour
// s'authentifier et devenir un endpoint WebRTC adressable.
// ============================================================================

exports.getTwilioVoiceToken = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const auth = await requireAuth(context);

    try {
      const result = await twilioProvider.generateVoiceAccessToken(
        db,
        auth.uid,
        3600 // 1h TTL
      );
      return result;
    } catch (err) {
      console.error('[getTwilioVoiceToken] Error:', err);
      throw new functions.https.HttpsError(
        'internal',
        err.message || 'Token generation failed'
      );
    }
  });

// ============================================================================
// CALLABLE: searchAvailableNumbers (admin)
// ----------------------------------------------------------------------------
// Interface admin-numbers.html : rechercher des numéros à acheter chez Twilio
// selon indicatif régional et type (local/national/mobile).
// ============================================================================

exports.searchAvailableNumbers = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    await requireAdmin(context);

    const criteria = {
      countryCode: data.countryCode || 'FR',
      regionIndicatif: data.regionIndicatif || null,
      numberType: data.numberType || 'national',
      limit: Math.min(Math.max(parseInt(data.limit, 10) || 10, 1), 30),
    };

    try {
      const numbers = await twilioProvider.searchAvailableNumbers(db, criteria);
      return { numbers, criteria };
    } catch (err) {
      console.error('[searchAvailableNumbers] Error:', err);
      throw new functions.https.HttpsError(
        'internal',
        err.message || 'Search failed'
      );
    }
  });

// ============================================================================
// CALLABLE: purchasePhoneNumber (admin)
// ----------------------------------------------------------------------------
// Achète un numéro, configure ses webhooks vers les Vercel Functions, et
// crée le doc dans phone_numbers avec assignation éventuelle à un user.
// ============================================================================

exports.purchasePhoneNumber = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    await requireAdmin(context);

    if (!data.phoneNumber) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'phoneNumber is required (E.164 format)'
      );
    }

    try {
      // 1. Achat chez Twilio
      const purchased = await twilioProvider.purchaseNumber(
        db,
        data.phoneNumber,
        WEBHOOK_BASE_URL
      );

      // 2. Création du doc Firestore avec sanitization défensive
      const numberDoc = {
        provider: 'twilio',
        providerSid: purchased.sid,
        phoneNumber: purchased.phoneNumber,
        friendlyName:
          data.friendlyName || purchased.friendlyName || purchased.phoneNumber,
        numberType: data.numberType || 'national',
        countryCode: data.countryCode || 'FR',
        regionIndicatif: data.regionIndicatif || null,
        capabilities: {
          voice: !!(purchased.capabilities && purchased.capabilities.voice),
          sms: !!(purchased.capabilities && purchased.capabilities.SMS),
          mms: !!(purchased.capabilities && purchased.capabilities.MMS),
        },
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        purchasedBy: context.auth.uid,
        monthlyPrice:
          typeof data.monthlyPrice === 'number' ? data.monthlyPrice : 1.0,
        monthlyPriceCurrency: 'EUR',
        assignedTo: data.assignedTo || null,
        assignedToRole: data.assignedToRole || null,
        active: true,
        notes: data.notes || '',
      };

      const docRef = await db.collection('phone_numbers').add(numberDoc);

      return {
        numberId: docRef.id,
        phoneNumber: purchased.phoneNumber,
        providerSid: purchased.sid,
      };
    } catch (err) {
      console.error('[purchasePhoneNumber] Error:', err);
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError(
        'internal',
        err.message || 'Purchase failed'
      );
    }
  });

// ============================================================================
// CALLABLE: releasePhoneNumber (admin)
// ----------------------------------------------------------------------------
// Libère un numéro chez Twilio et le marque inactive dans Firestore
// (on ne supprime pas le doc pour préserver l'historique des call_logs liés).
// ============================================================================

exports.releasePhoneNumber = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    await requireAdmin(context);

    if (!data.numberId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'numberId is required'
      );
    }

    try {
      const snap = await db.collection('phone_numbers').doc(data.numberId).get();
      if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Number not found');
      }

      const numberData = snap.data();

      // Release chez Twilio (non-blocking si ça échoue, le numéro peut déjà
      // avoir été libéré côté Twilio manuellement)
      if (numberData.providerSid) {
        try {
          await twilioProvider.releaseNumber(db, numberData.providerSid);
        } catch (twilioErr) {
          console.warn(
            '[releasePhoneNumber] Twilio release warning (continuing):',
            twilioErr.message
          );
        }
      }

      // Marquage inactive (pas de delete)
      await snap.ref.update({
        active: false,
        releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { released: true, numberId: data.numberId };
    } catch (err) {
      console.error('[releasePhoneNumber] Error:', err);
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError(
        'internal',
        err.message || 'Release failed'
      );
    }
  });

// ============================================================================
// TRIGGER: onTwilioWebhookInbox
// ----------------------------------------------------------------------------
// Nouveau trigger qui écoute webhook_inbox et ne traite QUE les docs dont
// source commence par "twilio_". Ne touche PAS aux autres sources pour ne
// pas interférer avec le onWebhookInbox existant.
//
// Sources traitées :
//   - twilio_voice_status   → update call_logs + session stats
//   - twilio_recording_ready → déclenche le pipeline IA complet
// ============================================================================

exports.onTwilioWebhookInbox = functions
  .region(REGION)
  .runWith({
    memory: '512MB',
    timeoutSeconds: 540, // 9 min — suffisant pour le pipeline IA complet
  })
  .firestore.document('webhook_inbox/{docId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();

    // Filtre : ne traiter que les sources twilio_*
    if (!data || !data.source || !String(data.source).startsWith('twilio_')) {
      return null;
    }

    const source = data.source;
    const payload = data.payload || {};

    console.log(`[onTwilioWebhookInbox] Processing ${source}`);

    try {
      switch (source) {
        case 'twilio_voice_status':
          await twilioHandlers.handleVoiceStatus(db, payload);
          break;

        case 'twilio_recording_ready':
          await twilioHandlers.handleRecordingReady(db, storage, payload);
          break;

        default:
          console.warn(`[onTwilioWebhookInbox] Unknown twilio source: ${source}`);
          return null;
      }

      // Succès : on supprime le doc (idempotent via try/catch au cas où un
      // autre handler l'aurait déjà supprimé)
      try {
        await snap.ref.delete();
      } catch (delErr) {
        // Bénin — le doc a peut-être été supprimé par un autre processus
      }

      return null;
    } catch (err) {
      console.error(`[onTwilioWebhookInbox] Error processing ${source}:`, err);

      // En cas d'erreur : ne pas supprimer le doc, le marquer pour inspection
      try {
        await snap.ref.update({
          processed: false,
          error: err.message || String(err),
          erroredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (updateErr) {
        // ignore
      }
      return null;
    }
  });

// ============================================================================
// SCHEDULED: dialerSessionCleanup
// ----------------------------------------------------------------------------
// Toutes les 5 minutes, ferme les sessions encore marquées "active" mais
// dont le heartbeat est > 10min (closer qui a fermé son onglet brutalement).
//
// Requiert un index composite Firestore sur (status ASC, lastHeartbeat ASC).
// Firebase créera l'index à la première requête et affichera un lien dans
// les logs Cloud Functions. Clique le lien pour créer l'index en 30s.
// ============================================================================

exports.dialerSessionCleanup = functions
  .region(REGION)
  .pubsub.schedule('every 5 minutes')
  .onRun(async (context) => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    try {
      const query = await db
        .collection('dialer_sessions')
        .where('status', '==', 'active')
        .where('lastHeartbeat', '<', tenMinutesAgo)
        .get();

      if (query.empty) {
        return null;
      }

      const batch = db.batch();
      query.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'ended',
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedReason: 'heartbeat_timeout',
        });
      });
      await batch.commit();

      console.log(
        `[dialerSessionCleanup] Closed ${query.size} zombie session(s)`
      );
      return null;
    } catch (err) {
      console.error('[dialerSessionCleanup] Error:', err);
      return null;
    }
  });
