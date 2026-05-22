/**
 * sales-dialer-api.js  (v2 — Ringover)
 * Helper frontend pour appeler les Vercel Functions du module Dialer.
 * Gère l'authentification Firebase (idToken) et les erreurs en français.
 */

(function () {
  'use strict';

  const API_BASE = '/api';
  const ENDPOINTS = {
    ringoverCall:   `${API_BASE}/ringover-call-initiate`,
    ringoverHangup: `${API_BASE}/ringover-call-hangup`,
    cancelCampaign: `${API_BASE}/dialer-cancel-campaign`,
    callDetail:     `${API_BASE}/call-detail`,
    smsSend:        `${API_BASE}/ringover-sms-send`,
    // Admin (gestion des numéros — conservés pour l'UI admin-numbers.html)
    searchNumbers:  `${API_BASE}/dialer-search-numbers`,
    purchaseNumber: `${API_BASE}/dialer-purchase-number`,
    releaseNumber:  `${API_BASE}/dialer-release-number`,
    syncNumbers:    `${API_BASE}/dialer-sync-numbers`,
  };

  async function getIdToken() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error("Firebase n'est pas initialisé sur cette page.");
    }
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Vous devez être connecté pour effectuer cette action.");
    try {
      return await user.getIdToken(false);
    } catch (e) {
      throw new Error("Impossible de vérifier votre session. Veuillez vous reconnecter.");
    }
  }

  function frenchErrorMessage(status, payload) {
    const serverMsg = (payload && (payload.error || payload.message)) || '';
    switch (status) {
      case 400: return serverMsg || "Requête invalide.";
      case 401: return "Session expirée. Veuillez vous reconnecter.";
      case 403: return "Accès refusé.";
      case 404: return "Ressource introuvable.";
      case 409: return serverMsg || "Conflit : cette action n'est pas possible actuellement.";
      case 429: return "Trop de requêtes. Patientez quelques secondes.";
      case 500: return "Erreur serveur. Réessayez dans un instant.";
      case 502:
      case 503:
      case 504: return "Service temporairement indisponible (Ringover ou Vercel).";
      default:  return serverMsg || `Erreur inattendue (${status}).`;
    }
  }

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
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(finalUrl, opts);
    } catch (networkErr) {
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

  const SalesDialerAPI = {

    /**
     * Initie un appel via Ringover (API-initiated click-to-call).
     * Ringover sonne l'app de l'agent → elle décroche → Ringover compose le lead.
     *
     * @param {{ leadId?: string, phone?: string, leadName?: string }} lead
     * @param {Object} [options]
     * @param {string} [options.autoCampaignId]
     * @param {number} [options.waveIndex]
     * @param {number} [options.queueSize]
     * @returns {Promise<{ campaignId: string, callId: string, status: string }>}
     */
    async ringoverCall(lead, options = {}) {
      const body = {
        leadId: lead.leadId || lead.id || null,
        phone: lead.phone || null,
        leadName: lead.leadName || lead.name || null,
      };
      if (options.autoCampaignId) body.autoCampaignId = options.autoCampaignId;
      if (Number.isInteger(options.waveIndex)) body.waveIndex = options.waveIndex;
      if (Number.isInteger(options.queueSize)) body.queueSize = options.queueSize;
      return authedFetch(ENDPOINTS.ringoverCall, { method: 'POST', body });
    },

    /**
     * Compat alias legacy — identique à ringoverCall mais accepte un tableau de leads.
     * Ringover ne faisant qu'un appel à la fois, seul le 1er lead du tableau est utilisé.
     */
    async multiCall(leads, _fromNumberId = null, options = {}) {
      const lead = Array.isArray(leads) ? leads[0] : leads;
      if (!lead) throw new Error('Aucun lead fourni');
      return this.ringoverCall(lead, options);
    },

    /**
     * Raccroche un appel Ringover actif.
     * @param {{ campaignId?: string, callId?: string }} params
     */
    async hangupCall({ campaignId, callId } = {}) {
      return authedFetch(ENDPOINTS.ringoverHangup, {
        method: 'POST',
        body: { campaignId, callId },
      });
    },

    /**
     * Annule une campagne en cours (raccroche les legs Ringover actifs).
     * @param {string} campaignId
     */
    async cancelCampaign(campaignId) {
      return authedFetch(ENDPOINTS.cancelCampaign, {
        method: 'POST',
        body: JSON.stringify({ campaignId }),
      });
    },

    /**
     * Détail d'un appel (enregistrement, transcription, analyse IA).
     * @param {string} callLogId - ID du doc call_logs (= callId Ringover)
     */
    async callDetail(callLogId) {
      if (!callLogId) throw new Error('callLogId manquant.');
      return authedFetch(ENDPOINTS.callDetail, {
        method: 'POST',
        body: JSON.stringify({ callLogId }),
      });
    },

    /**
     * Envoie un SMS à un lead via Ringover.
     * @param {{ leadId: string, message: string }} params
     */
    async sendSms({ leadId, message } = {}) {
      if (!leadId)  throw new Error('leadId manquant.');
      if (!message) throw new Error('Message vide.');
      return authedFetch(ENDPOINTS.smsSend, {
        method: 'POST',
        body: JSON.stringify({ leadId, message }),
      });
    },

    // ── Admin : gestion numéros (conservé pour admin-numbers.html) ──────────

    async searchNumbers({ country = 'FR', areaCode, type, contains, limit = 20 } = {}) {
      return authedFetch(ENDPOINTS.searchNumbers, {
        method: 'GET',
        query: { country, areaCode, type, contains, limit },
      });
    },

    async purchaseNumber({ phoneNumber, assignedTo, friendlyName, bundleSid } = {}) {
      if (!phoneNumber) throw new Error('Numéro de téléphone manquant.');
      if (!assignedTo)  throw new Error('Vous devez assigner le numéro à un membre.');
      return authedFetch(ENDPOINTS.purchaseNumber, {
        method: 'POST',
        body: { phoneNumber, assignedTo, friendlyName, bundleSid },
      });
    },

    async releaseNumber({ sid } = {}) {
      if (!sid) throw new Error('SID manquant.');
      return authedFetch(ENDPOINTS.releaseNumber, { method: 'POST', body: { sid } });
    },

    async syncNumbers() {
      return authedFetch(ENDPOINTS.syncNumbers, { method: 'POST' });
    },
  };

  window.SalesDialerAPI = SalesDialerAPI;
})();
