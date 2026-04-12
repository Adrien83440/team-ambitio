// ============================================================================
// api/dialer-sync-numbers.js
// ----------------------------------------------------------------------------
// Synchronise les numéros Twilio existants vers Firestore phone_numbers,
// et reconfigure SYSTÉMATIQUEMENT leurs webhooks voice vers nos endpoints
// Vercel (twilio-inbound, twilio-call-status).
//
// Pourquoi cet endpoint existe :
//   - Permet d'importer des numéros achetés en direct dans Twilio Console
//     (cas d'Adrien qui a acheté 2 numéros 04 11 avant qu'admin-numbers.html
//     existe)
//   - Permet de "réparer" automatiquement des numéros dont les webhooks
//     pointent vers la démo Twilio par défaut
//   - Sera réutilisé par admin-numbers.html via un bouton "Synchroniser"
//
// URL publique : https://team.alteore.com/api/dialer-sync-numbers
// Méthode : POST
// Headers requis : Authorization: Bearer <firebase_id_token>  (admin only)
// Body : (vide ou {})
//
// Filtrage : SEULS les numéros FR (+33) sont importés. Les numéros US et
// autres pays sont ignorés (cas d'Adrien qui a un numéro US de test).
//
// Réponse succès (200) :
//   {
//     report: {
//       totalInTwilio: 3,
//       processed: 2,           // FR uniquement
//       imported: 2,            // créés dans Firestore
//       updated: 0,             // déjà présents, webhooks mis à jour
//       webhooksReconfigured: 2,
//       skipped: 1,             // non-FR ignorés
//       errors: []
//     },
//     numbers: [...]  // liste des numéros traités avec leur statut
//   }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getTwilioClient } = require('./_twilioClient');

const WEBHOOK_BASE_URL = 'https://team.alteore.com';
const VOICE_URL = `${WEBHOOK_BASE_URL}/api/twilio-inbound`;
const STATUS_CALLBACK_URL = `${WEBHOOK_BASE_URL}/api/twilio-call-status`;

/**
 * Détermine le type de numéro à partir de ses caractéristiques Twilio.
 * On regarde l'indicatif FR pour distinguer local / national / mobile.
 */
function inferNumberType(phoneNumber) {
  if (!phoneNumber || !phoneNumber.startsWith('+33')) return 'national';
  // +33 1/2/3/4/5 = local géographique
  // +33 6/7 = mobile (ne devrait pas arriver chez nous mais on gère)
  // +33 8 = special / non-géographique
  // +33 9 = national VoIP
  const after33 = phoneNumber.substring(3, 4);
  if (['1', '2', '3', '4', '5'].includes(after33)) return 'local';
  if (['6', '7'].includes(after33)) return 'mobile';
  if (after33 === '9') return 'national';
  return 'national';
}

/**
 * Extrait l'indicatif régional FR (2 chiffres) depuis un E.164 +33XXXXXXXXX.
 * Pour +33411789602 → "04"
 */
function inferRegionIndicatif(phoneNumber) {
  if (!phoneNumber || !phoneNumber.startsWith('+33')) return null;
  const firstDigit = phoneNumber.substring(3, 4);
  return `0${firstDigit}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const report = {
    totalInTwilio: 0,
    processed: 0,
    imported: 0,
    updated: 0,
    webhooksReconfigured: 0,
    skipped: 0,
    errors: [],
  };
  const numbers = [];

  try {
    const client = await getTwilioClient();

    // ------------------------------------------------------------------
    // 1. Lister TOUS les numéros du compte Twilio
    // ------------------------------------------------------------------
    const twilioNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });
    report.totalInTwilio = twilioNumbers.length;

    // ------------------------------------------------------------------
    // 2. Charger tous les phone_numbers existants dans Firestore (par SID)
    // ------------------------------------------------------------------
    const firestoreSnap = await db.collection('phone_numbers').get();
    const existingBySid = new Map();
    firestoreSnap.forEach(doc => {
      const data = doc.data();
      if (data.providerSid) {
        existingBySid.set(data.providerSid, { id: doc.id, data });
      }
    });

    // ------------------------------------------------------------------
    // 3. Pour chaque numéro Twilio, traiter selon son statut
    // ------------------------------------------------------------------
    for (const tn of twilioNumbers) {
      const e164 = tn.phoneNumber;
      const sid = tn.sid;

      // Filtrer : seuls les numéros FR sont importés
      if (!e164 || !e164.startsWith('+33')) {
        report.skipped++;
        numbers.push({
          sid,
          phoneNumber: e164,
          status: 'skipped',
          reason: 'non-FR number',
        });
        continue;
      }

      report.processed++;

      const numberType = inferNumberType(e164);
      const regionIndicatif = inferRegionIndicatif(e164);
      const capabilities = {
        voice: !!(tn.capabilities && tn.capabilities.voice),
        sms: !!(tn.capabilities && tn.capabilities.SMS),
        mms: !!(tn.capabilities && tn.capabilities.MMS),
      };

      // -------- 3a. Reconfigurer les webhooks voice (TOUJOURS) --------
      let webhooksReconfigured = false;
      const needsWebhookUpdate =
        tn.voiceUrl !== VOICE_URL ||
        tn.statusCallback !== STATUS_CALLBACK_URL ||
        tn.voiceMethod !== 'POST' ||
        tn.statusCallbackMethod !== 'POST';

      if (needsWebhookUpdate) {
        try {
          await client.incomingPhoneNumbers(sid).update({
            voiceUrl: VOICE_URL,
            voiceMethod: 'POST',
            statusCallback: STATUS_CALLBACK_URL,
            statusCallbackMethod: 'POST',
          });
          webhooksReconfigured = true;
          report.webhooksReconfigured++;
        } catch (whErr) {
          console.error(
            `[dialer-sync-numbers] Webhook update failed for ${sid}:`,
            whErr.message
          );
          report.errors.push({
            sid,
            phoneNumber: e164,
            step: 'webhook-update',
            error: whErr.message,
          });
        }
      }

      // -------- 3b. Importer ou mettre à jour dans Firestore --------
      const existing = existingBySid.get(sid);

      if (!existing) {
        // Création d'un nouveau doc
        const newDoc = {
          provider: 'twilio',
          providerSid: sid,
          phoneNumber: e164,
          friendlyName: tn.friendlyName || e164,
          numberType,
          countryCode: 'FR',
          regionIndicatif,
          capabilities,
          purchasedAt: tn.dateCreated
            ? admin.firestore.Timestamp.fromDate(new Date(tn.dateCreated))
            : admin.firestore.FieldValue.serverTimestamp(),
          purchasedBy: auth.uid,
          monthlyPrice: 1.0,
          monthlyPriceCurrency: 'EUR',
          assignedTo: null, // L'admin assignera depuis l'UI
          assignedToRole: null,
          active: true,
          notes: 'Imported via sync from Twilio Console',
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        try {
          const docRef = await db.collection('phone_numbers').add(newDoc);
          report.imported++;
          numbers.push({
            sid,
            phoneNumber: e164,
            friendlyName: tn.friendlyName,
            status: 'imported',
            firestoreId: docRef.id,
            webhooksReconfigured,
          });
        } catch (fsErr) {
          console.error(
            `[dialer-sync-numbers] Firestore create failed for ${sid}:`,
            fsErr.message
          );
          report.errors.push({
            sid,
            phoneNumber: e164,
            step: 'firestore-create',
            error: fsErr.message,
          });
        }
      } else {
        // Doc déjà présent : on met juste à jour les capabilities et le syncedAt
        try {
          await db.collection('phone_numbers').doc(existing.id).update({
            capabilities,
            friendlyName: tn.friendlyName || existing.data.friendlyName || e164,
            syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          report.updated++;
          numbers.push({
            sid,
            phoneNumber: e164,
            friendlyName: tn.friendlyName,
            status: 'already_present',
            firestoreId: existing.id,
            webhooksReconfigured,
          });
        } catch (fsErr) {
          console.error(
            `[dialer-sync-numbers] Firestore update failed for ${sid}:`,
            fsErr.message
          );
          report.errors.push({
            sid,
            phoneNumber: e164,
            step: 'firestore-update',
            error: fsErr.message,
          });
        }
      }
    }

    res.status(200).json({ report, numbers });
  } catch (err) {
    console.error('[dialer-sync-numbers] Fatal error:', err);
    res.status(500).json({
      error: err.message || 'Sync failed',
      report,
      numbers,
    });
  }
};
