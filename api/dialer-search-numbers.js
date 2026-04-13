// ============================================================================
// api/dialer-search-numbers.js
// ----------------------------------------------------------------------------
// Remplace la Cloud Function callable `searchAvailableNumbers`.
//
// URL publique : https://team.alteore.com/api/dialer-search-numbers
// Méthode : POST
// Headers requis : Authorization: Bearer <firebase_id_token>
//                  Content-Type: application/json
// Body (JSON) :
//   {
//     "countryCode": "FR",         // optionnel, défaut "FR"
//     "regionIndicatif": "04",     // optionnel, indicatif régional (sans le 0 ou avec)
//     "numberType": "local",       // "local" | "mobile" | "tollfree" | "national"
//     "limit": 10                  // optionnel, 1-30, défaut 10
//   }
//
// Réponse succès (200) :
//   { numbers: [...], criteria: {...} }
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getTwilioClient } = require('./_twilioClient');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req);
  const criteria = {
    countryCode: body.countryCode || 'FR',
    regionIndicatif: body.regionIndicatif || null,
    numberType: body.numberType || 'national',
    limit: Math.min(Math.max(parseInt(body.limit, 10) || 10, 1), 30),
  };

  try {
    const client = await getTwilioClient();
    const country = client.availablePhoneNumbers(criteria.countryCode);

    let list;
    switch (criteria.numberType) {
      case 'local':
        list = country.local;
        break;
      case 'mobile':
        list = country.mobile;
        break;
      case 'tollfree':
        list = country.tollFree;
        break;
      case 'national':
      default:
        list = country.national;
        break;
    }

    const searchOptions = { limit: criteria.limit };
    if (criteria.regionIndicatif) {
      // areaCode Twilio = indicatif sans le 0 initial
      searchOptions.areaCode = String(criteria.regionIndicatif).replace(/^0/, '');
    }

    const results = await list.list(searchOptions);

    const numbers = results.map(n => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality || null,
      region: n.region || null,
      isoCountry: n.isoCountry || criteria.countryCode,
      capabilities: {
        voice: !!(n.capabilities && n.capabilities.voice),
        sms: !!(n.capabilities && n.capabilities.SMS),
        mms: !!(n.capabilities && n.capabilities.MMS),
      },
    }));

    res.status(200).json({ numbers, criteria });
  } catch (err) {
    console.error('[dialer-search-numbers] Error:', err);
    res.status(500).json({ error: err.message || 'Search failed' });
  }
};
