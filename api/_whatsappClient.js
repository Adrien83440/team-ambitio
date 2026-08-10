// ============================================================================
// api/_whatsappClient.js — CLIENT WHATSAPP CLOUD API (Meta en direct)
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// POURQUOI UN CANAL SÉPARÉ DE TWILIO
// ----------------------------------
// Décision du 09/08/2026 : Twilio garde les SMS, la voix et Ringover ;
// WhatsApp prend les rappels, les notifications et le groupe de suivi. Rien
// n'est mutualisé — ni le client, ni les identifiants, ni le webhook — pour
// que la séparation soit réelle et pas seulement de façade. Un incident sur
// un canal ne doit jamais pouvoir emporter l'autre.
//
// Ce qu'on reprend de Twilio, c'est LA MÉTHODE : identifiants en base plutôt
// qu'en variables d'environnement, cache au niveau module (une seule lecture
// Firestore par cold start Vercel), signature vérifiée sur tout ce qui entre.
//
// AUCUNE DÉPENDANCE NPM. Node 20 fournit `fetch` et `crypto` ; le SDK Meta
// n'apporterait rien de plus qu'un POST JSON.
//
// LE JOURNAL N'EST PAS DÉCORATIF
// ------------------------------
// Chaque envoi écrit un document dans `whatsapp_messages`, dont l'identifiant
// EST le `wamid` renvoyé par Meta. Le webhook reçoit ses accusés de réception
// indexés sur ce même `wamid` : il retrouve donc le document sans requête, et
// « le client dit qu'il n'a rien reçu » cesse d'être une question sans réponse.
// C'est précisément l'angle mort qui a masqué la panne SMS pendant des mois.
// ============================================================================

const { db } = require('./_firebaseAdmin');

/* Cache niveau module — vidé à chaque cold start. */
let _creds = null;

/**
 * Charge les identifiants depuis _config/whatsapp_credentials.
 * Lance si le document ou un champ vital manque : mieux vaut une erreur
 * explicite au premier appel qu'un envoi qui part vers nulle part.
 */
async function getWhatsappCreds() {
  if (_creds) return _creds;

  const snap = await db.collection('_config').doc('whatsapp_credentials').get();
  if (!snap.exists) throw new Error('_config/whatsapp_credentials introuvable');

  const d = snap.data() || {};
  if (!d.token) throw new Error('whatsapp_credentials.token manquant');
  if (!d.phoneNumberId) throw new Error('whatsapp_credentials.phoneNumberId manquant');

  _creds = {
    token: String(d.token),
    phoneNumberId: String(d.phoneNumberId),
    wabaId: d.wabaId ? String(d.wabaId) : null,
    /* verifyToken et appSecret ne servent qu'au webhook : leur absence ne doit
       pas empêcher un envoi. C'est whatsapp-webhook.js qui refuse de tourner
       sans eux, et lui seul. */
    verifyToken: d.verifyToken ? String(d.verifyToken) : null,
    appSecret: d.appSecret ? String(d.appSecret) : null,
    apiVersion: d.apiVersion ? String(d.apiVersion) : 'v25.0',
    /* Interrupteur des rappels automatiques, lu par whatsapp-rappels-rdv.js.
       Absent = éteint : on n'allume jamais un envoi de masse par défaut. */
    rappelsActifs: d.rappelsActifs === true,
  };
  return _creds;
}

/**
 * Numéro au format attendu par Meta : chiffres uniquement, indicatif compris.
 * Mêmes règles que api/signature-send-link.js — un numéro accepté pour un SMS
 * doit l'être pour WhatsApp, sinon on créerait deux vérités sur la même donnée.
 * @returns {string|null} ex. '33612345678', ou null si non exploitable
 */
function normaliserNumero(brut) {
  if (!brut) return null;
  const n = String(brut).replace(/[\s\-().]/g, '');
  let e164 = null;
  if (n.startsWith('+')) e164 = n;
  else if (n.startsWith('00')) e164 = '+' + n.slice(2);
  else if (n.startsWith('0') && n.length === 10) e164 = '+33' + n.slice(1);
  else if (n.startsWith('33') && n.length >= 11) e164 = '+' + n;
  else return null;
  const chiffres = e164.replace(/[^0-9]/g, '');
  return chiffres.length >= 10 ? chiffres : null;
}

/**
 * Appel brut à la Graph API. Ne lance jamais sur une erreur HTTP : les erreurs
 * Meta arrivent en JSON avec un code exploitable, et les perdre dans une
 * exception reviendrait à journaliser « échec » sans jamais savoir pourquoi.
 */
async function graph(chemin, opts) {
  opts = opts || {};
  const creds = await getWhatsappCreds();
  const url = 'https://graph.facebook.com/' + creds.apiVersion + '/' + chemin;

  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + creds.token },
  };
  if (opts.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let rep;
  try {
    rep = await fetch(url, init);
  } catch (e) {
    return { ok: false, status: 0, data: null, erreur: (e && e.message) || 'reseau' };
  }

  let data = null;
  try { data = await rep.json(); } catch (_) { data = null; }

  if (!rep.ok) {
    const err = (data && data.error) || {};
    return {
      ok: false,
      status: rep.status,
      data: data,
      erreur: err.message || ('HTTP ' + rep.status),
      code: err.code != null ? err.code : null,
      sousCode: err.error_subcode != null ? err.error_subcode : null,
    };
  }
  return { ok: true, status: rep.status, data: data };
}

/**
 * Écrit une ligne de journal. Ne lance jamais : un envoi réussi ne doit pas
 * être signalé en échec parce que sa trace n'a pas pu s'écrire.
 * L'identifiant du document est le wamid quand on l'a — c'est ce qui permet
 * au webhook de retrouver la ligne sans requête.
 */
async function journaliser(wamid, infos) {
  const doc = Object.assign({}, infos, {
    at: Date.now(),
    date: new Date().toISOString(),
  });
  try {
    if (wamid) await db.collection('whatsapp_messages').doc(wamid).set(doc, { merge: true });
    else await db.collection('whatsapp_messages').add(doc);
  } catch (e) {
    console.warn('[whatsapp] journal:', e && e.message);
  }
}

/**
 * Envoie un modèle approuvé.
 *
 * @param {Object} opts
 * @param {string} opts.to        destinataire (format libre, normalisé ici)
 * @param {string} opts.template  nom exact du modèle approuvé chez Meta
 * @param {string} [opts.langue]  code langue du modèle — 'fr' par défaut
 * @param {Array}  [opts.params]  valeurs de {{1}}, {{2}}… dans l'ordre
 * @param {Object} [opts.contexte] métadonnées libres pour le journal
 *                                 (clientId, coachSlug, bookingId…)
 * @returns {Promise<{ok:boolean, wamid:string|null, erreur:string|null}>}
 *
 * Ne lance pas : l'appelant décide quoi faire d'un échec, et le journal garde
 * la trace dans tous les cas.
 */
async function envoyerModele(opts) {
  opts = opts || {};
  const modele = String(opts.template || '').trim();
  const langue = String(opts.langue || 'fr').trim();
  const params = Array.isArray(opts.params) ? opts.params : [];
  const contexte = opts.contexte || {};
  const to = normaliserNumero(opts.to);

  const base = {
    modele: modele,
    langue: langue,
    params: params.map((v) => (v == null ? '' : String(v))),
    contexte: contexte,
    destinataireBrut: opts.to != null ? String(opts.to) : null,
  };

  if (!modele) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'template_requis' }));
    return { ok: false, wamid: null, erreur: 'template_requis' };
  }
  if (!to) {
    await journaliser(null, Object.assign({}, base, { statut: 'refuse', erreur: 'numero_invalide' }));
    return { ok: false, wamid: null, erreur: 'numero_invalide' };
  }

  /* UN PARAMÈTRE VIDE FAIT ÉCHOUER L'ENVOI ENTIER côté Meta, et l'erreur
     renvoyée ne dit pas lequel. On tranche ici, avec le numéro du paramètre
     fautif : c'est le mode de panne le plus probable de tout ce module (un
     coach non attribué, une date de RDV absente), autant qu'il soit lisible
     du premier coup d'œil dans le journal. */
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v == null || String(v).trim() === '') {
      const erreur = 'parametre_vide_{{' + (i + 1) + '}}';
      await journaliser(null, Object.assign({}, base, { statut: 'refuse', to: to, erreur: erreur }));
      return { ok: false, wamid: null, erreur: erreur };
    }
  }

  const creds = await getWhatsappCreds();
  const composants = params.length
    ? [{
        type: 'body',
        parameters: params.map((v) => ({ type: 'text', text: String(v) })),
      }]
    : [];

  const rep = await graph(creds.phoneNumberId + '/messages', {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'template',
      template: {
        name: modele,
        language: { code: langue },
        components: composants,
      },
    },
  });

  if (!rep.ok) {
    console.error('[whatsapp] envoi', modele, '→', to, ':', rep.erreur, 'code=' + rep.code);
    await journaliser(null, Object.assign({}, base, {
      statut: 'echec',
      to: to,
      erreur: rep.erreur || 'echec',
      codeMeta: rep.code != null ? rep.code : null,
      sousCodeMeta: rep.sousCode != null ? rep.sousCode : null,
    }));
    return { ok: false, wamid: null, erreur: rep.erreur || 'echec' };
  }

  const msgs = (rep.data && rep.data.messages) || [];
  const wamid = (msgs[0] && msgs[0].id) || null;

  /* `accepte` et non `envoye` : à ce stade Meta a seulement pris le message
     en charge. C'est le webhook qui dira `sent`, `delivered`, `read` ou
     `failed`. Confondre les deux, c'est refaire l'erreur du module SMS. */
  await journaliser(wamid, Object.assign({}, base, {
    statut: 'accepte',
    to: to,
    wamid: wamid,
  }));

  console.log('[whatsapp]', modele, '→', to, 'wamid=' + wamid);
  return { ok: true, wamid: wamid, erreur: null };
}

module.exports = {
  getWhatsappCreds,
  normaliserNumero,
  graph,
  journaliser,
  envoyerModele,
};
