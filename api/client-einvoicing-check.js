// ============================================================================
// api/client-einvoicing-check.js — LE CLIENT PEUT-IL RECEVOIR UNE E-FACTURE ?
// ----------------------------------------------------------------------------
// POST /api/client-einvoicing-check   { clientId }
//   Auth : Bearer admin
//   → 200 { success, reachable, address, clientName, checkedAt }
//
// Répond à la question qu'on se pose AVANT d'émettre : ce client est-il
// atteignable sur le réseau de facturation électronique ?
//
// Qonto expose la réponse sous forme d'un booléen `e_invoicing_reachable`,
// vrai seulement si l'adresse de routage est active à la fois dans l'Annuaire
// français et sur Peppol. Il n'existe pas d'endpoint de consultation sèche :
// la valeur n'est renvoyée qu'en créant ou en mettant à jour le client. On
// passe donc par upsertClient, qui est idempotent — un client déjà connu est
// simplement mis à jour, et son identifiant Qonto réutilisé.
//
// Effet de bord assumé : le client est créé chez Qonto s'il n'y existe pas
// encore. C'est sans conséquence — il le serait de toute façon à la première
// facture — et c'est le prix de la réponse.
// ============================================================================

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const qontoFlow = require('./_qonto-invoice-flow');
const qonto = require('./_qonto-client');

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    await requireAuth(req, ['admin']);

    const body = req.body || {};
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!clientId) {
      const e = new Error('clientId requis'); e.status = 400; throw e;
    }

    if (!qonto.isConfigured()) {
      const e = new Error(
        'Connexion Qonto non configurée : ' + qonto.missingConfig().join(', ')
      );
      e.status = 409; throw e;
    }

    const ref = db.collection('invoice_clients').doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) {
      const e = new Error('Client introuvable'); e.status = 404; throw e;
    }
    const client = snap.data() || {};

    /* Même garde-fou que partout ailleurs : un client de l'entreprise
       individuelle n'a rien à faire chez Qonto, même en lecture. */
    if (client.billingScope === 'ei') {
      const e = new Error(
        'Ce client est rattaché à l\'entreprise individuelle : ses factures ne '
        + 'passent pas par Qonto, la question de sa joignabilité ne se pose pas ici.'
      );
      e.status = 409; throw e;
    }

    const siret = String(client.siret || '').replace(/\D/g, '');
    if (!siret) {
      const e = new Error(
        'SIRET manquant sur cette fiche : sans lui, aucune adresse de routage '
        + 'ne peut être construite. Complète la fiche, puis relance la vérification.'
      );
      e.status = 400; throw e;
    }

    /* upsertClient écrit lui-même einvoicingReachable sur la fiche. */
    await qontoFlow.upsertClient({ db: db, admin: admin, clientId: clientId });

    const after = await ref.get();
    const data = after.data() || {};

    res.status(200).json({
      success: true,
      reachable: typeof data.einvoicingReachable === 'boolean' ? data.einvoicingReachable : null,
      address: data.einvoicingAddress || qonto.einvoicingAddressFrom(client) || null,
      clientName: client.companyName
        || ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')).trim()
        || null,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
};
