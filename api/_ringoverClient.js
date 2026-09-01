// api/_ringoverClient.js
const { db } = require('./_firebaseAdmin');

const RINGOVER_API_BASE = 'https://public-api.ringover.com/v2';
let _cachedCreds = null;

async function getRingoverCreds() {
  if (_cachedCreds) return _cachedCreds;
  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) throw new Error('_config/telco_credentials introuvable');
  const creds = (snap.data().ringover) || {};
  if (!creds.apiKey) throw new Error('telco_credentials missing ringover.apiKey');
  _cachedCreds = creds;
  return creds;
}

/* Poste Ringover d'un utilisateur donné.
   Un seul compte Ringover ne peut pas servir plusieurs commerciaux : la clé
   API identifie l'utilisateur dont le téléphone sonne. Tant qu'il n'y avait
   qu'une utilisatrice, la clé partagée suffisait ; à plusieurs, chaque poste
   doit avoir sa propre clé, déclarée dans
     _config/telco_credentials.ringover.users.{firebaseUid}
       = { apiKey?, userId?, fromNumber?, device? }
   (aucun secret dans le repo — les identifiants restent en base, comme le
   reste de _config/*). Les champs absents retombent sur la config partagée.
   Renvoie toujours un objet exploitable : { apiKey, userId, fromNumber,
   device, dedicated } — `dedicated` dit si l'appelant a SA propre clé. */
async function getRingoverCredsForUser(uid) {
  const creds = await getRingoverCreds();
  const perUser = (uid && creds.users && creds.users[uid]) || null;
  return {
    apiKey:     (perUser && perUser.apiKey)     || creds.apiKey,
    userId:     (perUser && perUser.userId)     || creds.userId || null,
    fromNumber: (perUser && perUser.fromNumber) || creds.fromNumber || null,
    device:     (perUser && perUser.device)     || creds.device || 'APP',
    dedicated:  !!(perUser && perUser.apiKey),
    shared:     creds,
  };
}

async function ringoverFetch(path, { method = 'GET', body = null, apiKey = null } = {}) {
  const creds = apiKey ? { apiKey } : await getRingoverCreds();

  const doFetch = async (authValue) => {
    const opts = {
      method,
      headers: { 'Authorization': authValue, 'Content-Type': 'application/json' },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    const res  = await fetch(`${RINGOVER_API_BASE}${path}`, opts);
    const text = await res.text();
    // Convertir les gros entiers (uint64) en strings AVANT JSON.parse
    // pour éviter la perte de précision JS sur call_id, message_id, etc.
    const safeText = text.replace(
      /"(call_id|id|channel_id|conversation_id|message_id|cdr_id|user_id|team_id)"\s*:\s*(\d{15,})/g,
      '"$1":"$2"'
    );
    let data = null;
    try { data = JSON.parse(safeText); } catch (_) {
      try { data = JSON.parse(text); } catch (_) {}
    }
    return { res, text, data };
  };

  // Essai 1 : sans Bearer (format documenté Ringover v2)
  let { res, text, data } = await doFetch(creds.apiKey);

  // Essai 2 : avec Bearer si 401
  if (res.status === 401) {
    console.warn(`[ringoverClient] 401 sans Bearer, retry avec Bearer. Body: ${text}`);
    ({ res, text, data } = await doFetch(`Bearer ${creds.apiKey}`));
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.detail)) || text || `Ringover API error ${res.status}`;
    console.error(`[ringoverClient] ${method} ${path} → ${res.status}: ${text}`);
    const err = new Error(msg);
    err.status = res.status;
    err.rawResponse = text;
    throw err;
  }
  return data;
}

module.exports = { getRingoverCreds, getRingoverCredsForUser, ringoverFetch };
