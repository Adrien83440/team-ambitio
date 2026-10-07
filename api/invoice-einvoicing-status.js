// ============================================================================
// api/invoice-einvoicing-status.js — OÙ EN EST LA FACTURE SUR LE RÉSEAU ?
// ----------------------------------------------------------------------------
// POST /api/invoice-einvoicing-status   { invoiceId }
//   Auth : Bearer admin
//   → 200 { success, status, label, lastEvent, events, checkedAt }
//
// Relit l'état réel de la facture chez Qonto. Nécessaire parce que le statut
// capté à la création vaut toujours « pending » : le cheminement sur le réseau
// se joue APRÈS notre appel. Sans relecture, on affiche indéfiniment une
// valeur périmée à la seconde où elle a été écrite.
//
// Six états possibles, du dépôt à l'acceptation :
//   pending           pas encore soumise
//   submitted         déposée sur le réseau
//   approved          acceptée par la plateforme du destinataire
//   declined          refusée
//   not_delivered     n'a pas atteint le destinataire
//   submission_failed échec au dépôt
//
// Lecture seule côté Qonto ; on ne fait qu'écrire le résultat sur la facture.
// ============================================================================

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const qonto = require('./_qonto-client');

/* Libellés FR. Un état inconnu est affiché tel quel plutôt que masqué : si
   Qonto en ajoute un, mieux vaut le voir brut que le voir disparaître. */
const STATUS_LABELS = {
  pending: 'En attente de dépôt',
  submitted: 'Déposée sur le réseau',
  approved: 'Acceptée par le destinataire',
  declined: 'Refusée',
  not_delivered: 'Non délivrée',
  submission_failed: 'Échec du dépôt',
};

/* Codes du cycle de vie de la réforme (norme XP Z12-012). Qonto les renvoie
   bruts dans einvoicing_lifecycle_events. Attention : 211/212 sont des
   statuts que NOUS émettons (paiement transmis, encaissée) — ils ne disent
   rien de l'acheminement vers le destinataire. */
const CDV_LABELS = {
  200: 'Déposée',
  201: 'Émise par la plateforme',
  202: 'Reçue par la plateforme',
  203: 'Mise à disposition',
  204: 'Prise en charge',
  205: 'Approuvée',
  206: 'Approuvée partiellement',
  207: 'En litige',
  208: 'Suspendue',
  209: 'Complétée',
  210: 'Refusée',
  211: 'Paiement transmis',
  212: 'Encaissée',
  213: 'Rejetée',
  214: 'Visée',
};

function cdvLabelOf(code) {
  return CDV_LABELS[code] || ('code ' + code);
}

/* Jusqu'au 07/10/2026, un statut vide affichait « inconnu » : c'est pourtant
   une information — Qonto ne connaît aucun dépôt réseau pour cette facture. */
function labelOf(status) {
  if (!status) return 'Aucun statut réseau chez Qonto';
  return STATUS_LABELS[status] || String(status);
}

function mapEvent(e) {
  e = e || {};
  const code = e.status_code != null ? e.status_code : null;
  return {
    statusCode: code,
    label: code != null ? cdvLabelOf(code) : null,
    reason: e.reason || null,
    reasonMessage: e.reason_message || null,
    timestamp: e.timestamp || null,
  };
}

/* Journal complet, chronologique. Plafonné : une facture n'en accumule que
   quelques-uns, mais un document Firestore ne doit pas grossir sans borne. */
function eventsOf(invoice) {
  const events = invoice && Array.isArray(invoice.einvoicing_lifecycle_events)
    ? invoice.einvoicing_lifecycle_events
    : [];
  return events.slice(-30).map(mapEvent);
}

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    await requireAuth(req, ['admin']);

    const body = req.body || {};
    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId.trim() : '';
    if (!invoiceId) {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }

    if (!qonto.isConfigured()) {
      const e = new Error('Connexion Qonto non configurée : ' + qonto.missingConfig().join(', '));
      e.status = 409; throw e;
    }

    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data() || {};
    const qontoInvoiceId = (invoice.qonto && invoice.qonto.invoiceId) || null;
    if (!qontoInvoiceId) {
      const e = new Error(
        'Cette facture n\'existe pas chez Qonto — il n\'y a pas de statut réseau '
        + 'à consulter. Utilise « Resynchroniser » pour l\'y créer.'
      );
      e.status = 409; throw e;
    }

    const resp = await qonto.qontoFetch('GET', '/v2/client_invoices/' + encodeURIComponent(qontoInvoiceId));
    const qInv = (resp && resp.client_invoice) ? resp.client_invoice : resp;

    const status = (qInv && qInv.einvoicing_status) || null;
    const events = eventsOf(qInv);
    const lastEvent = events.length ? events[events.length - 1] : null;

    /* Écrit AVANT la réponse : Vercel coupe la fonction dès res.end(). */
    await invRef.update({
      'qonto.einvoicingStatus': status,
      'qonto.einvoicingLastEvent': lastEvent,
      'qonto.einvoicingEvents': events,
      'qonto.einvoicingCheckedAt': admin.firestore.FieldValue.serverTimestamp(),
      'qonto.status': (qInv && qInv.status) || null,
    });

    res.status(200).json({
      success: true,
      status: status,
      label: labelOf(status),
      lastEvent: lastEvent,
      events: events,
      qontoStatus: (qInv && qInv.status) || null,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
};
