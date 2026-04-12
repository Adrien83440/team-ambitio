/**
 * sales-dialer-api.js
 * Helper frontend partagé pour appeler les Vercel Functions du module Dialer.
 * Gère l'authentification Firebase (idToken) et les erreurs en français.
 *
 * Usage :
 *   const token = await SalesDialerAPI.voiceToken();
 *   const results = await SalesDialerAPI.searchNumbers({ areaCode: '04', country: 'FR' });
 *   await SalesDialerAPI.purchaseNumber({ phoneNumber: '+33411...', assignedTo: 'elodie' });
 *
 * Toutes les méthodes retournent une Promise. En cas d'erreur, throw une Error
 * avec un message FR lisible (à afficher direct dans une notification toast).
 */

(function () {
  'use strict';

  // ─── Configuration ─────────────────────────────────────────────────────────
  const API_BASE = '/api'; // Vercel Functions servies sous /api/*
  const ENDPOINTS = {
    voiceToken:     `${API_BASE}/dialer-voice-token`,
    searchNumbers:  `${API_BASE}/dialer-search-numbers`,
    purchaseNumber: `${API_BASE}/dialer-purchase-number`,
    releaseNumber:  `${API_BASE}/dialer-release-number`,
    syncNumbers:    `${API_BASE}/dialer-sync-numbers`,
  };

  // ─── Auth helper ───────────────────────────────────────────────────────────
  async function getIdToken() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error("Firebase n'est pas initialisé sur cette page.");
    }
    const user = firebase.auth().currentUser;
    if (!user) {
      throw new Error("Vous devez être connecté pour effectuer cette action.");
    }
    try {
      return await user.getIdToken(/* forceRefresh */ false);
    } catch (e) {
      console.error('[SalesDialerAPI] getIdToken failed:', e);
      throw new Error("Impossible de vérifier votre session. Veuillez vous reconnecter.");
    }
  }

  // ─── Mapping des erreurs HTTP → messages FR ────────────────────────────────
  function frenchErrorMessage(status, payload) {
    const serverMsg = (payload && (payload.error || payload.message)) || '';

    // Messages spécifiques renvoyés par nos Vercel Functions
    const map = {
      'TWILIO_INSUFFICIENT_FUNDS': "Solde Twilio insuffisant pour acheter ce numéro.",
      'TWILIO_NUMBER_UNAVAILABLE': "Ce numéro n'est plus disponible chez Twilio.",
      'TWILIO_INVALID_NUMBER':     "Le numéro fourni est invalide.",
      'NUMBER_NOT_FOUND':          "Numéro introuvable dans la base.",
      'NUMBER_IN_USE':             "Ce numéro est actuellement utilisé sur un appel actif.",
      'PERMISSION_DENIED':         "Vous n'avez pas les droits pour effectuer cette action.",
      'BUNDLE_REQUIRED':           "Un Bundle réglementaire FR est requis pour ce type de numéro.",
    };
    if (map[serverMsg]) return map[serverMsg];

    switch (status) {
      case 400: return serverMsg || "Requête invalide.";
      case 401: return "Session expirée. Veuillez vous reconnecter.";
      case 403: return "Accès refusé. Action réservée aux administrateurs.";
      case 404: return "Ressource introuvable.";
      case 409: return serverMsg || "Conflit : cette action n'est pas possible actuellement.";
      case 429: return "Trop de requêtes. Patientez quelques secondes.";
      case 500: return "Erreur serveur. Réessayez dans un instant.";
      case 502:
      case 503:
      case 504: return "Service temporairement indisponible (Twilio ou Vercel).";
      default:  return serverMsg || `Erreur inattendue (${status}).`;
    }
  }

  // ─── Wrapper fetch authentifié ─────────────────────────────────────────────
  async function authedFetch(url, { method = 'GET', body = null, query = null } = {}) {
    const token = await getIdToken();

    let finalUrl = url;
    if (query && typeof query === 'object') {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') params.append(k, v);
      });
      const qs = params.toString();
      if (qs) finalUrl += `?${qs}`;
    }

    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(finalUrl, opts);
    } catch (networkErr) {
      console.error('[SalesDialerAPI] Network error:', networkErr);
      throw new Error("Connexion réseau impossible. Vérifiez votre connexion internet.");
    }

    let payload = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try { payload = await response.json(); } catch (_) { payload = null; }
    }

    if (!response.ok) {
      const msg = frenchErrorMessage(response.status, payload);
      const err = new Error(msg);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  // ─── API publique ──────────────────────────────────────────────────────────
  const SalesDialerAPI = {

    /**
     * Génère un Twilio Voice Access Token (JWT) pour le SDK Voice côté browser.
     * @returns {Promise<{token: string, identity: string, ttl: number}>}
     */
    async voiceToken() {
      return authedFetch(ENDPOINTS.voiceToken, { method: 'POST' });
    },

    /**
     * Recherche des numéros disponibles à l'achat sur Twilio.
     * @param {Object} params
     * @param {string} params.country     - Code pays ISO (ex: 'FR')
     * @param {string} [params.areaCode]  - Indicatif local (ex: '04', '01')
     * @param {string} [params.type]      - 'local' | 'mobile' | 'tollFree' | 'national'
     * @param {string} [params.contains]  - Pattern (ex: '*411*')
     * @param {number} [params.limit=20]  - Max 30
     * @returns {Promise<{available: Array<{phoneNumber, friendlyName, locality, region, capabilities, monthlyPrice}>}>}
     */
    async searchNumbers({ country = 'FR', areaCode, type, contains, limit = 20 } = {}) {
      return authedFetch(ENDPOINTS.searchNumbers, {
        method: 'GET',
        query: { country, areaCode, type, contains, limit },
      });
    },

    /**
     * Achète un numéro chez Twilio et l'enregistre dans Firestore phone_numbers.
     * @param {Object} params
     * @param {string} params.phoneNumber  - E.164 (ex: '+33411223344')
     * @param {string} params.assignedTo   - ID team member (ex: 'elodie')
     * @param {string} [params.friendlyName]
     * @param {string} [params.bundleSid]  - SID du Bundle FR si requis
     * @returns {Promise<{success: true, sid: string, phoneNumber: string, firestoreId: string}>}
     */
    async purchaseNumber({ phoneNumber, assignedTo, friendlyName, bundleSid } = {}) {
      if (!phoneNumber) throw new Error("Numéro de téléphone manquant.");
      if (!assignedTo)  throw new Error("Vous devez assigner le numéro à un membre.");
      return authedFetch(ENDPOINTS.purchaseNumber, {
        method: 'POST',
        body: { phoneNumber, assignedTo, friendlyName, bundleSid },
      });
    },

    /**
     * Libère un numéro chez Twilio et le supprime de Firestore phone_numbers.
     * @param {Object} params
     * @param {string} params.sid  - Twilio IncomingPhoneNumber SID
     * @returns {Promise<{success: true, released: string}>}
     */
    async releaseNumber({ sid } = {}) {
      if (!sid) throw new Error("SID Twilio manquant.");
      return authedFetch(ENDPOINTS.releaseNumber, {
        method: 'POST',
        body: { sid },
      });
    },

    /**
     * Re-synchronise tous les numéros depuis Twilio vers Firestore phone_numbers.
     * Met à jour les webhooks et corrige les divergences.
     * @returns {Promise<{success: true, synced: number, added: number, updated: number, removed: number}>}
     */
    async syncNumbers() {
      return authedFetch(ENDPOINTS.syncNumbers, { method: 'POST' });
    },
  };

  // ─── Export global ─────────────────────────────────────────────────────────
  window.SalesDialerAPI = SalesDialerAPI;
})();
