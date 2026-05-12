/**
 * api/admin-delete-factures-rattrapage.js
 *
 * Endpoint POST pour supprimer des factures du module billing, avec
 * traçabilité complète (snapshot dans audit_log avant suppression) et
 * décrément de installmentsGenerated sur la subscription parente.
 *
 * Usage : nettoyer des factures de rattrapage historique générées par
 * erreur (typiquement quand on rattrape des mensualités déjà couvertes
 * par un autre système comptable — ex : EI vs SARL).
 *
 * Pour chaque invoiceId :
 *   1. Lit la facture
 *   2. Crée un doc audit_log avec snapshot complet (sauf chunks PDF →
 *      on garde juste pdfHash + pdfChunkCount pour preuve d'existence)
 *   3. Supprime les chunks PDF de la sous-collection invoices/{id}/pdf
 *   4. Supprime le doc invoice
 *
 * Update sub à la fin : installmentsGenerated -= N.
 *
 * ⚠️ NE TOUCHE PAS à invoice_counters : les numéros restent attribués
 * (on peut pas les réutiliser, c'est illégal). Cela crée des trous dans
 * la séquence. Trace dans audit_log justifie les trous en cas d'audit.
 *
 * ─── Auth ───
 * Bearer admin uniquement.
 *
 * ─── POST body ───
 * {
 *   subscriptionId: string,
 *   invoiceIds: string[],
 *   reason: string,
 *   dryRun?: boolean
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   subscriptionId,
 *   deleted: [{ invoiceId, number, totalTtc, lineDescription, auditLogId }],
 *   previousInstallmentsGenerated,
 *   newInstallmentsGenerated
 * }
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth Bearer admin ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body parsing ── */
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const subscriptionId = body.subscriptionId;
    const invoiceIds = body.invoiceIds;
    const reason = body.reason;
    const dryRun = !!body.dryRun;

    /* ── Validations ── */
    if (!subscriptionId || typeof subscriptionId !== 'string') {
      const e = new Error('subscriptionId requis'); e.status = 400; throw e;
    }
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      const e = new Error('invoiceIds (array non vide) requis'); e.status = 400; throw e;
    }
    if (!reason || typeof reason !== 'string' || reason.length < 10) {
      const e = new Error('reason requis (string, min 10 chars) — pour traçabilité audit_log'); e.status = 400; throw e;
    }
    for (let i = 0; i < invoiceIds.length; i++) {
      if (!invoiceIds[i] || typeof invoiceIds[i] !== 'string') {
        const e = new Error('invoiceIds[' + i + '] doit être une string non vide'); e.status = 400; throw e;
      }
    }

    /* Doublons ? */
    const seen = {};
    for (let i = 0; i < invoiceIds.length; i++) {
      if (seen[invoiceIds[i]]) {
        const e = new Error('Doublon dans invoiceIds : ' + invoiceIds[i]); e.status = 400; throw e;
      }
      seen[invoiceIds[i]] = true;
    }

    /* ── Lecture sub ── */
    const subRef = db.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) {
      const e = new Error('Subscription introuvable : ' + subscriptionId); e.status = 404; throw e;
    }
    const sub = subSnap.data();

    /* ── Pré-check : lire toutes les factures pour valider qu'elles existent
       et qu'elles appartiennent bien à cette subscription ── */
    const invoiceSnaps = [];
    for (let i = 0; i < invoiceIds.length; i++) {
      const id = invoiceIds[i];
      const ref = db.collection('invoices').doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        const e = new Error('Facture introuvable : ' + id); e.status = 404; throw e;
      }
      const inv = snap.data();
      if (inv.linkedSubscriptionId !== subscriptionId) {
        const e = new Error('Facture ' + (inv.number || id) + ' n\'est pas liée à la subscription ' + subscriptionId +
          ' (linkedSubscriptionId=' + inv.linkedSubscriptionId + ')');
        e.status = 400; throw e;
      }
      invoiceSnaps.push({ ref: ref, id: id, data: inv });
    }

    /* ── Dry-run : préparer le résumé sans rien faire ── */
    if (dryRun) {
      const preview = invoiceSnaps.map(function(x) {
        const lineDesc = x.data.lines && x.data.lines[0] ? (x.data.lines[0].description || '') : '';
        return {
          invoiceId: x.id,
          number: x.data.number || null,
          status: x.data.status,
          totalTtc: x.data.totalTtc,
          issueDate: x.data.issueDate && x.data.issueDate.toDate ? x.data.issueDate.toDate().toISOString().substring(0, 10) : null,
          lineDescription: lineDesc,
          isHistoricalCatchUp: !!x.data._isHistoricalCatchUp,
          historicalChargeDate: x.data._historicalChargeDate || null,
          hasPdf: !!x.data.pdfHash,
          pdfChunkCount: x.data.pdfChunkCount || 0,
        };
      });
      res.status(200).json({
        success: true,
        dryRun: true,
        subscriptionId: subscriptionId,
        reason: reason,
        wouldDelete: invoiceIds.length + ' facture(s)',
        currentInstallmentsGenerated: sub.installmentsGenerated || 0,
        wouldUpdateInstallmentsGenerated: Math.max(0, (sub.installmentsGenerated || 0) - invoiceIds.length),
        currentNextScheduledAt: sub.nextScheduledAt && sub.nextScheduledAt.toDate
          ? sub.nextScheduledAt.toDate().toISOString()
          : null,
        nextScheduledAtUnchanged: true,
        invoiceCounterUntouched: true,
        warning: 'Cette opération crée des trous dans la séquence de numérotation. audit_log conserve la trace complète.',
        preview: preview,
      });
      return;
    }

    /* ── Suppression réelle ── */
    const deleted = [];

    for (let i = 0; i < invoiceSnaps.length; i++) {
      const x = invoiceSnaps[i];
      const inv = x.data;
      const lineDesc = inv.lines && inv.lines[0] ? (inv.lines[0].description || '') : '';

      /* 1. Snapshot complet dans audit_log AVANT suppression (sans chunks PDF) */
      const invoiceSnapshot = Object.assign({}, inv);
      /* On ne garde pas le base64 du PDF dans l'audit (trop lourd, déjà sub-collection),
         mais on note pdfHash + pdfChunkCount pour preuve qu'un PDF existait */
      const auditDoc = {
        action: 'invoice_delete',
        invoiceId: x.id,
        invoiceNumber: inv.number || null,
        invoiceStatus: inv.status,
        invoiceTotalTtc: inv.totalTtc || 0,
        invoiceIssueDate: inv.issueDate || null,
        invoiceClientId: inv.clientId || null,
        invoiceClientName: (inv.clientSnapshot && (inv.clientSnapshot.companyName ||
          ((inv.clientSnapshot.contactFirstName || '') + ' ' + (inv.clientSnapshot.contactLastName || '')).trim())) || null,
        invoiceLineDescription: lineDesc,
        invoicePdfHash: inv.pdfHash || null,
        invoicePdfChunkCount: inv.pdfChunkCount || 0,
        invoiceSnapshot: invoiceSnapshot,
        reason: reason,
        context: 'admin-delete-factures-rattrapage',
        subscriptionId: subscriptionId,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        deletedBy: user.uid,
        deletedByEmail: user.email || null,
      };
      const auditRef = await db.collection('audit_log').add(auditDoc);

      /* 2. Supprimer les chunks PDF (sous-collection) */
      const pdfCol = x.ref.collection('pdf');
      const pdfSnap = await pdfCol.get();
      const pdfBatch = db.batch();
      pdfSnap.forEach(function(d) { pdfBatch.delete(d.ref); });
      if (!pdfSnap.empty) {
        await pdfBatch.commit();
      }

      /* 3. Supprimer le doc invoice */
      await x.ref.delete();

      deleted.push({
        invoiceId: x.id,
        number: inv.number || null,
        totalTtc: inv.totalTtc || 0,
        lineDescription: lineDesc,
        auditLogId: auditRef.id,
      });
    }

    /* ── Update subscription : installmentsGenerated -= N ── */
    const previousGenerated = sub.installmentsGenerated || 0;
    const newGenerated = Math.max(0, previousGenerated - deleted.length);

    /* Si elle était completed et qu'on retire des factures, on la repasse en active
       (pour qu'elle puisse continuer à être facturée par la cron normale). */
    let newStatus = sub.status;
    if (sub.status === 'completed' && newGenerated < (sub.totalInstallments || 0)) {
      newStatus = 'active';
    }

    await subRef.update({
      installmentsGenerated: newGenerated,
      status: newStatus,
      _lastDeleteCleanupAt: admin.firestore.FieldValue.serverTimestamp(),
      _lastDeleteCleanupBy: user.uid,
      _lastDeleteCleanupCount: deleted.length,
      _lastDeleteCleanupReason: reason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: user.uid,
    });

    /* ── Réponse ── */
    res.status(200).json({
      success: true,
      subscriptionId: subscriptionId,
      reason: reason,
      deleted: deleted,
      previousInstallmentsGenerated: previousGenerated,
      newInstallmentsGenerated: newGenerated,
      newStatus: newStatus,
      nextScheduledAtUnchanged: true,
    });

  } catch (err) {
    sendError(res, err);
  }
};
