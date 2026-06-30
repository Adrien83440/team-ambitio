// ============================================================================
// api/admin-backfill-utm-decode.js
// ----------------------------------------------------------------------------
// Décode définitivement, EN BASE, les UTM percent-encodés de la collection
// leads (ex: "3%29NEW-%C3%A9t%C3%A9-Vousavezr%C3%A9ussi" -> "3)NEW-été-Vous...").
//
// ─── POURQUOI ────────────────────────────────────────────────────────────────
// Certaines landing pages transmettent l'utm_campaign brut (non décodé) au
// webhook /api/lead-optin, qui le stockait tel quel. L'affichage Lead Live /
// Pipeline CRM décode désormais à la volée (decodeUtm), donc l'UI est déjà
// propre — MAIS la valeur reste encodée en base, ce qui pollue les exports,
// les scénarios Make et tout consommateur direct du champ `utm`.
// Ce backfill nettoie la donnée au repos. Il est OPTIONNEL : ne rien lancer ne
// casse rien (l'UI reste correcte). La capture est par ailleurs corrigée à la
// source (lead-optin.js décode désormais avant écriture).
//
// ─── CE QUE FAIT L'ENDPOINT ──────────────────────────────────────────────────
// Via Admin SDK (bypass des rules, lit tout), scanne la collection leads et,
// pour chaque fiche :
//   A) si `utm` est percent-encodé (decodeUtm(utm) !== utm) -> réécrit `utm`.
//   B) si includeHistory=1 (défaut) et qu'au moins une entrée de
//      engagementHistory[] a un `.utm` encodé -> réécrit le tableau entier
//      avec les .utm décodés (les autres champs des entrées sont préservés).
// Pose un marqueur utmDecodeBackfilledAt pour l'audit. Idempotent : une valeur
// déjà décodée (ou contenant un `%` littéral comme "Promo 50%") n'est jamais
// re-flaggée car decodeUtm la laisse inchangée.
//
// ─── SÉCURITÉ / WORKFLOW ──────────────────────────────────────────────────────
//   - Auth : Bearer admin uniquement (requireAdmin).
//   - DRY-RUN PAR DÉFAUT. Pour exécuter réellement : ?apply=1
//   - Writes batchés par 450. Cap de mutations par run (?applyLimit, défaut 2000)
//     + curseur (?after=<docId>) pour reprendre sans timeout serverless.
//   - Journalisation dans audit_log (intent + résultat) en mode apply.
//
// ─── PARAMÈTRES (query string) ────────────────────────────────────────────────
//   apply=1          exécute les writes (sinon dry-run = scan seul)
//   after=<docId>    reprend le scan après ce doc (pagination de reprise)
//   max=<n>          cap de fiches scannées dans ce run (défaut 50000)
//   applyLimit=<n>   cap de fiches MUTÉES dans ce run (défaut 2000)
//   includeHistory=0 désactive le nettoyage de engagementHistory[].utm (défaut 1)
//   verbose=1        retourne TOUS les items (sinon échantillon de 300)
//
// ─── DÉCLENCHEMENT (console navigateur sur team.alteore.com) ──────────────────
//   // 1) Dry-run (aperçu, ne touche rien) :
//   fetch('/api/admin-backfill-utm-decode', {
//     headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken() }
//   }).then(r => r.json()).then(console.log);
//
//   // 2) Exécution réelle :
//   fetch('/api/admin-backfill-utm-decode?apply=1', {
//     headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken() }
//   }).then(r => r.json()).then(console.log);
//
//   // 3) Si hasMore=true, relancer avec le curseur :
//   //    ...?apply=1&after=<cursor renvoyé>
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');

const FieldPath = admin.firestore.FieldPath;

// Champs strictement nécessaires (limite le payload des reads).
const SELECT_FIELDS = ['utm', 'engagementHistory', 'nom', 'email', '_merged'];

// ─── Décodage UTM défensif (identique front decodeUtm / lead-optin.js) ───────
// Valeur déjà propre -> inchangée. Séquence % invalide -> conservée, sans planter.
function decodeUtm(v) {
  if (v == null) return v;
  const s = String(v);
  if (s.indexOf('%') === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      try { return decodeURIComponent(m); } catch (_) { return m; }
    });
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireAdmin(req, res);
  if (!auth) return; // requireAdmin a déjà répondu 401/403

  try {
    const q = req.query || {};
    const apply = String(q.apply || '') === '1';
    const verbose = String(q.verbose || '') === '1';
    const includeHistory = String(q.includeHistory || '1') !== '0';
    const scanCap = Math.max(1, parseInt(q.max, 10) || 50000);
    const applyLimit = Math.max(1, parseInt(q.applyLimit, 10) || 2000);
    const afterId = (q.after && String(q.after)) || null;
    const pageSize = 300;
    const ITEM_CAP = verbose ? Infinity : 300;

    // ─── Stats ───
    let scanned = 0;
    let skippedMerged = 0;
    let utmFieldFixes = 0;
    let historyFixes = 0;       // nb de fiches dont l'historique a été nettoyé
    let historyEntryFixes = 0;  // nb total d'entrées d'historique décodées

    const mutations = []; // { id, ref, update, item }
    const items = [];

    let lastDocId = afterId;
    let hasMore = false;
    let stopForApplyCap = false;

    // ─── Boucle de pagination par documentId ───
    while (scanned < scanCap) {
      let query = db.collection('leads')
        .select(...SELECT_FIELDS)
        .orderBy(FieldPath.documentId())
        .limit(pageSize);
      if (lastDocId) query = query.startAfter(lastDocId);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        lastDocId = doc.id;
        scanned++;
        const d = doc.data() || {};

        // Doublons soft-merged : jamais affichés, jamais consommés -> on laisse.
        if (d._merged === true) { skippedMerged++; continue; }

        const update = {};
        const reasons = [];

        // A) Champ utm de tête.
        let newUtm = null;
        if (typeof d.utm === 'string' && d.utm.indexOf('%') !== -1) {
          const dec = decodeUtm(d.utm);
          if (dec !== d.utm) {
            update.utm = dec;
            newUtm = dec;
            utmFieldFixes++;
            reasons.push('utm');
          }
        }

        // B) engagementHistory[].utm (réécriture du tableau si ≥1 changement).
        let historyEntriesFixedHere = 0;
        if (includeHistory && Array.isArray(d.engagementHistory) && d.engagementHistory.length > 0) {
          let changed = false;
          const newHist = d.engagementHistory.map((e) => {
            if (e && typeof e.utm === 'string' && e.utm.indexOf('%') !== -1) {
              const dec = decodeUtm(e.utm);
              if (dec !== e.utm) {
                changed = true;
                historyEntriesFixedHere++;
                return Object.assign({}, e, { utm: dec });
              }
            }
            return e;
          });
          if (changed) {
            update.engagementHistory = newHist;
            historyFixes++;
            historyEntryFixes += historyEntriesFixedHere;
            reasons.push('engagementHistory(' + historyEntriesFixedHere + ')');
          }
        }

        if (reasons.length === 0) continue; // rien d'encodé sur cette fiche

        update.utmDecodeBackfilledAt = admin.firestore.FieldValue.serverTimestamp();

        const item = {
          id: doc.id,
          nom: d.nom || null,
          email: d.email || null,
          fields: reasons.join(' + '),
          utmBefore: typeof d.utm === 'string' ? d.utm : null,
          utmAfter: newUtm,
          historyEntriesFixed: historyEntriesFixedHere,
        };
        if (items.length < ITEM_CAP) items.push(item);

        mutations.push({ id: doc.id, ref: doc.ref, update, item });

        if (mutations.length >= applyLimit) { stopForApplyCap = true; break; }
      }

      if (stopForApplyCap) { hasMore = true; break; }
      if (snap.size < pageSize) { hasMore = false; break; }
      if (scanned >= scanCap) { hasMore = true; break; }
    }

    const summary = {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      includeHistory,
      scanned,
      skippedMerged,
      candidates: mutations.length,
      utmFieldFixes,
      historyFixes,
      historyEntryFixes,
      cursor: lastDocId,
      hasMore,
      itemsTruncated: !verbose && items.length >= ITEM_CAP,
      items,
    };

    if (!apply) {
      // DRY-RUN : aucune écriture.
      return res.status(200).json(summary);
    }

    if (mutations.length === 0) {
      summary.applied = { writes: 0 };
      return res.status(200).json(summary);
    }

    // ─── AUDIT : intent avant écriture ───
    const auditRef = db.collection('audit_log').doc();
    await auditRef.set({
      type: 'utm_decode_backfill',
      phase: 'intent',
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      includeHistory,
      scanned,
      candidates: mutations.length,
      utmFieldFixes,
      historyFixes,
      cursorStart: afterId || null,
      cursorEnd: lastDocId || null,
      hasMore,
      // Détail capé pour rester sous la limite 1 Mo / doc Firestore.
      affected: mutations.slice(0, 2000).map((m) => ({ id: m.id, fields: m.item.fields })),
      affectedTruncated: mutations.length > 2000,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ─── Écritures batchées par 450 ───
    let writes = 0;
    for (let i = 0; i < mutations.length; i += 450) {
      const chunk = mutations.slice(i, i + 450);
      const batch = db.batch();
      chunk.forEach((m) => batch.update(m.ref, m.update));
      await batch.commit();
      writes += chunk.length;
    }

    // ─── AUDIT : résultat ───
    await db.collection('audit_log').doc().set({
      type: 'utm_decode_backfill',
      phase: 'result',
      intentAuditId: auditRef.id,
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      utmFieldFixes,
      historyFixes,
      historyEntryFixes,
      writes,
      cursorEnd: lastDocId || null,
      hasMore,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    summary.applied = { writes };
    summary.auditId = auditRef.id;
    console.log('[admin-backfill-utm-decode] EXECUTE — writes=' + writes +
      ' utmFieldFixes=' + utmFieldFixes + ' historyFixes=' + historyFixes +
      ' hasMore=' + hasMore);
    return res.status(200).json(summary);

  } catch (e) {
    console.error('[admin-backfill-utm-decode] error:', e && e.message, e && e.stack);
    return res.status(500).json({ ok: false, error: (e && e.message) || 'internal_error' });
  }
};
