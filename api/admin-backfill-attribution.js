// ============================================================================
// api/admin-backfill-attribution.js
// ----------------------------------------------------------------------------
// Reconstruit `attributionFirst` sur les leads existants, à partir de tout ce
// que la plateforme a archivé avant le chantier attribution du 17/08/2026.
//
// ─── POURQUOI ─────────────────────────────────────────────────────────
// Le lead ne portait qu'UN champ texte `utm`, écrasé à chaque
// ré-engagement : api/alteoform-submit.js y écrivait « AlteoForm - <titre> »,
// api/lead-optin.js « VSL Business », onBookingCreated « Form <id> ». La
// créative qui avait réellement amené le prospect disparaissait, et sa
// performance (RDV, closes, collecté) remontait sur la ligne du formulaire
// dans le funnel.
//
// Bonne nouvelle : AVANT chaque écrasement, l'ancienne valeur était
// archivée — engagementHistory[].utm et formSubmissionsHistory[].utm. Ce
// script rejoue cet historique dans l'ordre chronologique et repose le
// premier touch. Les leads CRÉÉS directement par un AlteoForm n'ont, eux,
// jamais eu d'UTM d'origine côté serveur : ils restent non attribués, et le
// rapport les compte explicitement plutôt que de leur inventer une source.
//
// ─── CE QUI EST ÉCRIT ─────────────────────────────────────────────────
//   attributionFirst        — reconstruit, marqué reconstructed: true
//   attributionLast         — seulement s'il est vide (les endpoints live
//                             en sont propriétaires, on ne leur passe pas
//                             devant)
//   attributionBackfilledAt — marqueur d'audit
// Le champ `utm` legacy N'EST PAS touché : rien n'est jamais supprimé.
//
// ─── SÉCURITÉ / EXPLOITATION ──────────────────────────────────────────
// - requireAdmin (même garde que api/admin-backfill-utm-decode.js)
// - DRY-RUN PAR DÉFAUT : sans ?apply=1, aucune écriture, seulement le
//   rapport. C'est le mode à faire valider avant d'exécuter.
// - Idempotent : un lead portant déjà un attributionFirst signifiant est
//   ignoré. Rejouable sans risque.
// - Pagination par documentId + curseur, écritures batchées par 450.
// - Trace audit_log avant (intent) et après (result).
//
// ─── UTILISATION ──────────────────────────────────────────────────────
//   // 1. DRY-RUN — à lire et à valider
//   fetch('/api/admin-backfill-attribution', {
//     headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken() }
//   }).then(r => r.json()).then(console.log);
//
//   // 2. EXÉCUTION, après validation
//   //    ...?apply=1        puis ...?apply=1&after=<cursor renvoyé> si hasMore
//
//   Paramètres : apply=1 · verbose=1 (détail complet) · max=<scan cap> ·
//   applyLimit=<mutations par appel> · after=<curseur>
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
// Parsing d'attribution : même implémentation que celle des endpoints
// d'entrée et du funnel. Un backfill qui parserait autrement produirait des
// clés d'axe différentes de celles des nouveaux leads.
const Core = require('../funnel-core.js');

const FieldPath = admin.firestore.FieldPath;

const SELECT_FIELDS = ['utm', 'engagementHistory', 'formSubmissionsHistory',
  'attributionFirst', 'attributionLast', 'nom', 'email', '_merged'];

// ─── Classification des libellés ────────────────────────────────────────────
// La taxonomie vit dans funnel-core (Core.classifyLegacyLabel) : le backfill
// écrit exactement ce que le funnel relit, sans risque de dérive. Elle a été
// établie sur le relevé réel des 8 051 fiches et validée par Adrien le
// 17/08/2026 — voir le commentaire du module pour le détail des volumes.
//
// Rappel du principe : le champ `utm` ne contient presque jamais une
// créative. Ce sont, dans l'ordre de volume, des canaux (VSL, ACFLIX,
// Webinaire Dimanche), des audiences (adv_broad, LaL) et seulement à la
// marge de vraies pubs. Chaque libellé part donc dans SON champ, et le
// défaut est « canal », jamais « créative ».
const KIND_TO_FIELD = {
  ad_id:    'ad_id',
  creative: 'utm_content',
  adset:    'utm_term',
  channel:  'channel',
};

// Candidats d'attribution, du PLUS ANCIEN au plus récent. Les dates archivées
// sont des ISO strings : l'ordre lexicographique EST l'ordre chronologique.
function candidatesOf(d) {
  const out = [];
  (Array.isArray(d.engagementHistory) ? d.engagementHistory : []).forEach((e) => {
    if (!e) return;
    const at = String(e.archivedAt || '');
    if (e.attribution && Core.attrHasSignal(e.attribution)) out.push({ at, attr: e.attribution });
    if (e.utm) out.push({ at, raw: e.utm });
  });
  (Array.isArray(d.formSubmissionsHistory) ? d.formSubmissionsHistory : []).forEach((e) => {
    if (e && e.utm) out.push({ at: String(e.submittedAt || ''), raw: e.utm });
  });
  // Valeur courante en dernier : c'est par construction la plus récente,
  // donc le pire candidat pour un PREMIER touch — mais mieux que rien.
  if (d.utm) out.push({ at: '~current', raw: d.utm });
  out.sort((a, b) => (a.at < b.at ? -1 : (a.at > b.at ? 1 : 0)));
  return out;
}

// Reconstruction. Les passes sont ordonnées de la mesure vers la déduction,
// et NON par ancienneté seule — c'est le correctif du dry-run du 17/08 :
// une fiche portant l'identifiant Meta 120246654691110308 se voyait attribuer
// un « VSL » plus ancien trouvé dans son historique. Un identifiant de pub
// perdu au profit d'un nom de page : l'inverse de ce qu'on cherche.
//
//   1. attribution déjà structurée dans l'historique  → mesure
//   2. querystring archivée (utm_source, ad_id…)      → mesure
//   3. identifiant Meta, le plus ancien               → signal publicitaire sûr
//   4. créative nommée, la plus ancienne              → signal publicitaire
//   5. adset nommé, le plus ancien                    → signal publicitaire
//   6. canal, le plus ancien                          → PAS de la publicité
//
// À l'intérieur d'une passe, le plus ancien gagne : c'est bien un premier
// touch. Entre deux passes, la qualité du signal prime sur l'ancienneté.
// La source retenue est remontée dans le rapport — « legacy-* » est une
// déduction, pas une mesure.
const KIND_PASSES = [
  { kind: 'ad_id',    from: 'legacy-adid' },
  { kind: 'creative', from: 'legacy-creative' },
  { kind: 'adset',    from: 'legacy-adset' },
  { kind: 'channel',  from: 'legacy-channel' },
];

function reconstruct(d) {
  const cands = candidatesOf(d);
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].attr) return { attr: cands[i].attr, from: 'history-attribution', at: cands[i].at };
  }
  for (let i = 0; i < cands.length; i++) {
    if (!cands[i].raw) continue;
    const parsed = Core.parseAttribution(cands[i].raw);
    if (parsed) return { attr: parsed, from: 'querystring', at: cands[i].at };
  }
  for (let p = 0; p < KIND_PASSES.length; p++) {
    const pass = KIND_PASSES[p];
    for (let i = 0; i < cands.length; i++) {
      if (!cands[i].raw) continue;
      const cl = Core.classifyLegacyLabel(cands[i].raw);
      if (cl.kind !== pass.kind) continue;
      const attr = {};
      attr[KIND_TO_FIELD[cl.kind]] = String(cl.value).slice(0, 300);
      return { attr, from: pass.from, at: cands[i].at };
    }
  }
  return null;
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
    const scanCap = Math.max(1, parseInt(q.max, 10) || 50000);
    const applyLimit = Math.max(1, parseInt(q.applyLimit, 10) || 2000);
    const afterId = (q.after && String(q.after)) || null;
    const pageSize = 300;
    const ITEM_CAP = verbose ? Infinity : 300;

    // ─── Stats ───
    let scanned = 0;
    let skippedMerged = 0;
    let skippedAlreadyDone = 0;
    let unresolved = 0;                       // aucune trace exploitable
    const bySource = { 'history-attribution': 0, querystring: 0, 'legacy-adid': 0,
      'legacy-creative': 0, 'legacy-adset': 0, 'legacy-channel': 0 };

    const mutations = [];
    const items = [];
    const unresolvedSample = [];

    let lastDocId = afterId;
    let hasMore = false;
    let stopForApplyCap = false;

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

        // Doublons soft-merged : jamais affichés, jamais consommés.
        if (d._merged === true) { skippedMerged++; continue; }

        // Idempotence : un premier touch existe déjà → on ne repasse JAMAIS
        // dessus, c'est tout l'intérêt du champ.
        //
        // ⚠ attrHasSignal seul ne suffit PAS : il ne regarde que les champs
        // publicitaires, et ignore volontairement `channel` (un canal n'est
        // pas de la pub). Une fiche backfillée en canal repassait donc à
        // chaque exécution — 2 700 réécritures pour rien au second passage
        // du 17/08, à valeurs identiques. On teste la présence du bloc, pas
        // la nature de son contenu.
        const af = d.attributionFirst;
        if (af && typeof af === 'object' && (Core.attrHasSignal(af) || af.channel)) {
          skippedAlreadyDone++; continue;
        }

        const rec = reconstruct(d);
        if (!rec) {
          unresolved++;
          if (unresolvedSample.length < 50) {
            unresolvedSample.push({ id: doc.id, utm: d.utm || null });
          }
          continue;
        }

        const attr = Object.assign({}, rec.attr, {
          via: 'backfill',
          reconstructed: true,
          reconstructedFrom: rec.from,
          capturedAt: (rec.at && rec.at !== '~current') ? rec.at : null,
        });

        const update = { attributionFirst: attr };
        if (!Core.attrHasSignal(d.attributionLast)) update.attributionLast = attr;
        update.attributionBackfilledAt = admin.firestore.FieldValue.serverTimestamp();

        bySource[rec.from] = (bySource[rec.from] || 0) + 1;

        if (items.length < ITEM_CAP) {
          items.push({
            id: doc.id,
            nom: d.nom || null,
            utmBefore: d.utm || null,
            from: rec.from,
            attribution: rec.attr,
          });
        }

        mutations.push({ id: doc.id, ref: doc.ref, update, from: rec.from });
        if (mutations.length >= applyLimit) { stopForApplyCap = true; break; }
      }

      if (stopForApplyCap) { hasMore = true; break; }
      if (snap.size < pageSize) { hasMore = false; break; }
      if (scanned >= scanCap) { hasMore = true; break; }
    }

    const summary = {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      scanned,
      skippedMerged,
      skippedAlreadyDone,
      candidates: mutations.length,
      unresolved,
      bySource,
      // Lecture du rapport :
      //   history-attribution / querystring → captures réelles
      //   legacy-adid                       → identifiant Meta, lisible une
      //                                       fois ads_creatives alimentée
      //   legacy-creative / legacy-adset    → déduction publicitaire
      //   legacy-channel                    → canal d'acquisition, PAS de la
      //                                       pub : n'entre pas dans le taux
      //                                       d'attribution publicitaire
      unresolvedSample,
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
      type: 'attribution_backfill',
      phase: 'intent',
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      scanned,
      candidates: mutations.length,
      bySource,
      unresolved,
      cursorStart: afterId || null,
      cursorEnd: lastDocId || null,
      hasMore,
      // Détail capé pour rester sous la limite 1 Mo / doc Firestore.
      affected: mutations.slice(0, 2000).map((m) => ({ id: m.id, from: m.from })),
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
      type: 'attribution_backfill',
      phase: 'result',
      intentAuditId: auditRef.id,
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      bySource,
      writes,
      cursorEnd: lastDocId || null,
      hasMore,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    summary.applied = { writes };
    summary.auditId = auditRef.id;
    console.log('[admin-backfill-attribution] EXECUTE — writes=' + writes +
      ' unresolved=' + unresolved + ' hasMore=' + hasMore);
    return res.status(200).json(summary);

  } catch (e) {
    console.error('[admin-backfill-attribution] error:', e && e.message, e && e.stack);
    return res.status(500).json({ ok: false, error: (e && e.message) || 'internal_error' });
  }
};
