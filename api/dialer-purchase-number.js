// ============================================================================
// api/dialer-purchase-number.js
// ----------------------------------------------------------------------------
// Remplace la Cloud Function callable `purchasePhoneNumber`.
//
// URL publique : https://team.alteore.com/api/dialer-purchase-number
// Méthode : POST
// Headers requis : Authorization: Bearer <firebase_id_token>
//                  Content-Type: application/json
// Body (JSON) :
//   {
//     "phoneNumber": "+33987654321",     // requis, format E.164
//     "friendlyName": "09 FR - Ambitio", // optionnel
//     "numberType": "national",          // optionnel
//     "regionIndicatif": "09",           // optionnel
//     "countryCode": "FR",               // optionnel
//     "monthlyPrice": 1.0,               // optionnel (EUR)
//     "assignedTo": "user_uid",          // optionnel — UID Firebase d'un user
//     "assignedToRole": "sales",         // optionnel
//     "notes": "..."                     // optionnel
//   }
//
// Réponse succès (200) :
//   { numberId: "...", phoneNumber: "+33987654321", providerSid: "PNxxx" }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getTwilioClient } = require('./_twilioClient');

// Base URL des endpoints Vercel (pour configurer les webhooks voice du numéro)
const WEBHOOK_BASE_URL = 'https://team.alteore.com';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = req.body || {};

  if (!body.phoneNumber) {
    res.status(400).json({ error: 'phoneNumber is required (E.164 format)' });
    return;
  }

  try {
    const client = await getTwilioClient();

    // 1. Achat du numéro chez Twilio + configuration des webhooks
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: body.phoneNumber,
      voiceUrl: `${WEBHOOK_BASE_URL}/api/twilio-inbound`,
      voiceMethod: 'POST',
      statusCallback: `${WEBHOOK_BASE_URL}/api/twilio-call-status`,
      statusCallbackMethod: 'POST',
    });

    // 2. Création du doc Firestore
    const numberDoc = {
      provider: 'twilio',
      providerSid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
      friendlyName:
        body.friendlyName || purchased.friendlyName || purchased.phoneNumber,
      numberType: body.numberType || 'national',
      countryCode: body.countryCode || 'FR',
      regionIndicatif: body.regionIndicatif || null,
      capabilities: {
        voice: !!(purchased.capabilities && purchased.capabilities.voice),
        sms: !!(purchased.capabilities && purchased.capabilities.SMS),
        mms: !!(purchased.capabilities && purchased.capabilities.MMS),
      },
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      purchasedBy: auth.uid,
      monthlyPrice:
        typeof body.monthlyPrice === 'number' ? body.monthlyPrice : 1.0,
      monthlyPriceCurrency: 'EUR',
      assignedTo: body.assignedTo || null,
      assignedToRole: body.assignedToRole || null,
      active: true,
      notes: body.notes || '',
    };

    const docRef = await db.collection('phone_numbers').add(numberDoc);

    res.status(200).json({
      numberId: docRef.id,
      phoneNumber: purchased.phoneNumber,
      providerSid: purchased.sid,
    });
  } catch (err) {
    console.error('[dialer-purchase-number] Error:', err);
    res.status(500).json({ error: err.message || 'Purchase failed' });
  }
};
