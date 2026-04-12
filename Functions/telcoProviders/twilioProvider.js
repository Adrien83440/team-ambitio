// ============================================================================
// Functions/telcoProviders/twilioProvider.js
// ----------------------------------------------------------------------------
// Wrapper Twilio pour toutes les opérations télécom du module dialer.
// Une seule implémentation pour l'instant (Twilio), mais l'interface est
// pensée pour pouvoir ajouter OvhSipProvider en Vague 2/3 sans rien casser.
//
// Les credentials sont lus une seule fois depuis _config/telco_credentials
// au premier appel et cachés en mémoire (par cold start).
// ============================================================================

const twilio = require('twilio');

// Caches au niveau du module — vidés à chaque cold start
let _client = null;
let _cachedCreds = null;

/**
 * Charge les credentials Twilio depuis Firestore (avec cache).
 */
async function loadCreds(db) {
  if (_cachedCreds) return _cachedCreds;

  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) {
    throw new Error('_config/telco_credentials document not found');
  }

  const data = snap.data();
  // Défense contre la casse : on accepte "twilio" ou "Twilio"
  const twilioCreds = data.twilio || data.Twilio;
  if (!twilioCreds || !twilioCreds.accountSid) {
    throw new Error('telco_credentials missing twilio block (accountSid required)');
  }

  _cachedCreds = twilioCreds;
  return twilioCreds;
}

/**
 * Retourne un client Twilio initialisé (avec cache).
 */
async function getClient(db) {
  if (_client) return _client;
  const creds = await loadCreds(db);
  _client = twilio(creds.accountSid, creds.authToken);
  return _client;
}

// ============================================================================
// SEARCH — Recherche des numéros disponibles à l'achat
// ============================================================================

/**
 * Recherche des numéros disponibles à l'achat.
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} criteria
 * @param {string} [criteria.countryCode='FR']
 * @param {string|null} [criteria.regionIndicatif=null] - "04", "09", etc.
 * @param {"local"|"mobile"|"tollfree"|"national"} [criteria.numberType='national']
 * @param {number} [criteria.limit=10]
 */
async function searchAvailableNumbers(db, criteria) {
  const client = await getClient(db);
  const {
    countryCode = 'FR',
    regionIndicatif = null,
    numberType = 'national',
    limit = 10,
  } = criteria;

  const country = client.availablePhoneNumbers(countryCode);

  let list;
  switch (numberType) {
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

  const searchOptions = { limit };
  if (regionIndicatif) {
    // Pour les numéros FR, areaCode = indicatif sans le 0 initial
    searchOptions.areaCode = regionIndicatif.replace(/^0/, '');
  }

  const results = await list.list(searchOptions);

  return results.map(n => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality || null,
    region: n.region || null,
    isoCountry: n.isoCountry || countryCode,
    capabilities: {
      voice: !!(n.capabilities && n.capabilities.voice),
      sms: !!(n.capabilities && n.capabilities.SMS),
      mms: !!(n.capabilities && n.capabilities.MMS),
    },
  }));
}

// ============================================================================
// PURCHASE — Achat d'un numéro
// ============================================================================

/**
 * Achète un numéro chez Twilio et configure ses webhooks voice.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} phoneNumber - Format E.164 (ex: "+33987654321")
 * @param {string} webhookBaseUrl - Base URL pour les endpoints Vercel (ex: "https://team.alteore.com")
 */
async function purchaseNumber(db, phoneNumber, webhookBaseUrl) {
  const client = await getClient(db);

  const result = await client.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl: `${webhookBaseUrl}/api/twilio-inbound`,
    voiceMethod: 'POST',
    statusCallback: `${webhookBaseUrl}/api/twilio-call-status`,
    statusCallbackMethod: 'POST',
  });

  return {
    sid: result.sid,
    phoneNumber: result.phoneNumber,
    friendlyName: result.friendlyName,
    capabilities: result.capabilities || {},
  };
}

// ============================================================================
// RELEASE — Libération d'un numéro
// ============================================================================

async function releaseNumber(db, providerSid) {
  const client = await getClient(db);
  await client.incomingPhoneNumbers(providerSid).remove();
  return true;
}

// ============================================================================
// VOICE TOKEN — Génération du JWT pour le softphone WebRTC
// ============================================================================

/**
 * Génère un JWT Access Token Twilio Voice pour un utilisateur donné.
 * Le softphone frontend utilise ce token pour s'authentifier auprès de Twilio
 * et devenir un endpoint WebRTC adressable.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} userId - UID Firebase de l'utilisateur
 * @param {number} [ttlSeconds=3600] - Durée de vie du token (1h par défaut)
 */
async function generateVoiceAccessToken(db, userId, ttlSeconds = 3600) {
  const creds = await loadCreds(db);

  if (!creds.apiKeySid || !creds.apiKeySecret || !creds.voiceAppSid) {
    throw new Error(
      'telco_credentials incomplete: apiKeySid, apiKeySecret and voiceAppSid are required'
    );
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const identity = `user_${userId}`;

  const token = new AccessToken(
    creds.accountSid,
    creds.apiKeySid,
    creds.apiKeySecret,
    { identity, ttl: ttlSeconds }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: creds.voiceAppSid,
    incomingAllow: true,
  });
  token.addGrant(voiceGrant);

  return {
    token: token.toJwt(),
    identity,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

// ============================================================================
// DOWNLOAD RECORDING — Récupère un enregistrement depuis Twilio
// ============================================================================

/**
 * Télécharge un enregistrement audio depuis Twilio.
 * Retourne un Buffer contenant le MP3.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} recordingSid - SID de l'enregistrement Twilio (REXXXX...)
 * @returns {Promise<Buffer>}
 */
async function downloadRecording(db, recordingSid) {
  const creds = await loadCreds(db);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Recordings/${recordingSid}.mp3`;
  const authHeader =
    'Basic ' +
    Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

  // Node 20 runtime has native fetch
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    throw new Error(
      `Twilio recording download failed: ${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Credential access (exposed for debugging / other modules)
  loadCreds,

  // Operations
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  generateVoiceAccessToken,
  downloadRecording,
};
