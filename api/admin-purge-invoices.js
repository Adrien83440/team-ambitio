/**
 * api/admin-purge-invoices.js
 *
 * Purge totale des factures actuelles : archive toutes les invoices
 * existantes (flag _archived=true) et reset le compteur F2026 à 1.
 *
 * Les factures NE SONT PAS supprimées physiquement → conformité CGI
 * (conservation 10 ans). Elles deviennent juste invisibles dans l'UI
 * (filtre _archived !== true côté frontend).
 *
 * ATTENTION : opération destructive UI-side. Double confirmation
 * obligatoire (confirm: 'YES_PURGE_AND_RESET').
 *
 * ─── Auth ───
 * Bearer admin uniquement.
 *
 * ─── POST body ───
 * {
 *   confirm: 'YES_PURGE_AND_RESET',  // requis sinon erreur 400
 *   resetCounter: boolean,            // défaut true
 *   year: number,                     // défaut année courante
 *   dryRun?: boolean                  // défaut true
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   dryRun: bool,
 *   archived: number,           // nombre de factures archivées
 *   counterReset: { year, previousNextSeq, newNextSeq }
 * }
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const user = await requireAuth(req, ['admin']);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const dryRun = body.dryRun !== false;
    const resetCounter = body.resetCounter !== false;
    const year = parseInt(body.year, 10) || new Date().getFullYear();

    if (!dryRun && body.confirm !== 'YES_PURGE_AND_RESET') {
      const e = new Error('Confirmation requise : body.confirm = "YES_PURGE_AND_RESET"');
      e.status = 400; throw e;
    }

    /* ── 1. Scan invoices non-archivées ── */
    const snap = await db.collection('invoices').get();
    const toArchive = [];
    snap.forEach(function(d) {
      const data = d.data();
      if (data._archived !== true) {
        toArchive.push({ id: d.id, number: data.number || null, status: data.status });
      }
    });

    const result = {
      success: true,
      dryRun: dryRun,
      year: year,
      toArchive: toArchive.length,
      archived: 0,
      counterReset: null,
    };

    if (dryRun) {
      /* Preview du compteur actuel */
      const counterSnap = await db.collection('invoice_counters').doc(String(year)).get();
      const cur = counterSnap.exists ? counterSnap.data() : { invoiceNextSeq: 1 };
      result.counterReset = {
        year: year,
        previousNextSeq: cur.invoiceNextSeq || 1,
        newNextSeq: resetCounter ? 1 : (cur.invoiceNextSeq || 1),
        willReset: !!resetCounter,
      };
      result.archivePreview = toArchive.slice(0, 20).map(function(it) {
        return { id: it.id, number: it.number, status: it.status };
      });
      return res.status(200).json(result);
    }

    /* ── 2. Archivage par batches de 450 (limite Firestore writeBatch = 500) ── */
    const archiveTs = admin.firestore.FieldValue.serverTimestamp();
    const archiveReason = 'purge-refonte-' + new Date().toISOString().substring(0, 10);
    const CHUNK = 450;
    for (let i = 0; i < toArchive.length; i += CHUNK) {
      const chunk = toArchive.slice(i, i + CHUNK);
      const batch = db.batch();
      chunk.forEach(function(it) {
        const ref = db.collection('invoices').doc(it.id);
        batch.update(ref, {
          _archived: true,
          _archivedAt: archiveTs,
          _archivedBy: user.uid,
          _archivedReason: archiveReason,
        });
      });
      await batch.commit();
      result.archived += chunk.length;
    }

    /* ── 3. Reset compteur ── */
    if (resetCounter) {
      const counterRef = db.collection('invoice_counters').doc(String(year));
      const counterSnap = await counterRef.get();
      const previousSeq = counterSnap.exists ? (counterSnap.data().invoiceNextSeq || 1) : 1;
      await counterRef.set({
        year: year,
        invoiceNextSeq: 1,
        creditNoteNextSeq: counterSnap.exists ? (counterSnap.data().creditNoteNextSeq || 1) : 1,
        _resetAt: archiveTs,
        _resetBy: user.uid,
        _resetFromSeq: previousSeq,
        _resetReason: archiveReason,
      }, { merge: true });
      result.counterReset = {
        year: year,
        previousNextSeq: previousSeq,
        newNextSeq: 1,
      };
    }

    /* ── 4. Audit log ── */
    try {
      await db.collection('audit_log').add({
        type: 'invoices_purge_archive',
        actor: user.uid,
        actorEmail: user.email,
        archived: result.archived,
        counterReset: result.counterReset,
        reason: archiveReason,
        createdAt: archiveTs,
      });
    } catch (_) {}

    console.log('[admin-purge-invoices] EXECUTE — archived ' + result.archived +
      ' invoices, counter reset to 1 (year ' + year + ')');

    res.status(200).json(result);

  } catch (err) {
    console.error('[admin-purge-invoices] fatal: ' + err.message);
    sendError(res, err);
  }
};
