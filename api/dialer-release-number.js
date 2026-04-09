// ============================================================================
// api/dialer-release-number.js
// ----------------------------------------------------------------------------
// Remplace la Cloud Function callable `releasePhoneNumber`.
//
// URL publique : https://team.alteore.com/api/dialer-release-number
// Méthode : POST
// Headers requis : Authorization: Bearer <firebase_id_token>
//                  Content-Type: application/json
// Body (JSON) :
//   { "numberId": "<doc id in phone_numbers>" }
//
// Réponse succès (200) :
//   { released: true, numberId: "..." }
//
// Le numéro est marqué `active: false` dans Firestore (pas supprimé) pour
// préserver l'historique des call_logs qui y font référence.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getTwilioClient } = require('./_twilioClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = req.body || {};

  if (!body.numberId) {
    res.status(400).json({ error: 'numberId is required' });
    return;
  }

  try {
    const snap = await db.collection('phone_numbers').doc(body.numberId).get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Number not found' });
      return;
    }

    const numberData = snap.data();

    // Libération chez Twilio (non-blocking si ça échoue — le numéro peut déjà
    // avoir été libéré manuellement côté Twilio Console)
    if (numberData.providerSid) {
      try {
        const client = await getTwilioClient();
        await client.incomingPhoneNumbers(numberData.providerSid).remove();
      } catch (twilioErr) {
        console.warn(
          '[dialer-release-number] Twilio release warning (continuing):',
          twilioErr.message
        );
      }
    }

    // Marquage inactive dans Firestore (pas de delete)
    await snap.ref.update({
      active: false,
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      releasedBy: auth.uid,
    });

    res.status(200).json({ released: true, numberId: body.numberId });
  } catch (err) {
    console.error('[dialer-release-number] Error:', err);
    res.status(500).json({ error: err.message || 'Release failed' });
  }
};
