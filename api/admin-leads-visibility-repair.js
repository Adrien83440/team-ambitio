// ============================================================================
// api/admin-leads-visibility-repair.js
// ----------------------------------------------------------------------------
// Scanne TOUTE la collection leads et identifie les fiches qui « ne remontent
// pas » dans Leads Live (sales-leads.html), puis les répare.
//
// ─── POURQUOI ────────────────────────────────────────────────────────────────
// Leads Live charge ses fiches via 3 listeners onSnapshot en parallèle :
//   1) where('createdAt',   '>=', il y a 30j).orderBy('createdAt','desc')
//   2) where('lastBookingAt','>=', il y a 30j).orderBy('lastBookingAt','desc')
//   3) where('lastOptinAt',  '>=', il y a 30j).orderBy('lastOptinAt','desc')
//
// Piège Firestore : un where('createdAt','>=', Timestamp) combiné à un
// orderBy('createdAt') EXCLUT SILENCIEUSEMENT tout document dont createdAt
// n'est pas un vrai Timestamp :
//   - createdAt manquant  → écarté par le orderBy
//   - createdAt nombre    → number < timestamp dans l'ordre Firestore → échoue le >=
//   - createdAt null      → écarté
// Si en plus la fiche n'a pas de lastOptinAt / lastBookingAt Timestamp récent,
// elle n'est captée par AUCUN listener → invisible dans Leads Live, sans erreur.
//
// Vecteurs connus de createdAt pourri :
//   - le pont self-booking (be.createdAt venant de Make)
//   - une écriture Make directe dans /leads/ (les rules l'autorisent)
//
// ─── CE QUE FAIT L'ENDPOINT ──────────────────────────────────────────────────
// Via Admin SDK (donc il VOIT même les fiches malformées que le client ne charge
// pas), il rejoue exactement la logique de visibilité de Leads Live et, pour
// chaque fiche cachée à tort :
//   A) NORMALISE createdAt en vrai Timestamp à partir de la meilleure preuve
//      dispo (valeur exploitable de createdAt > importedCreatedAt > 1ère date
//      de communications > 1ère date de timeline_history > updatedAt > now).
//      → répare la donnée définitivement ; les fiches dont la vraie date est
//        < 30j réapparaissent à leur place, celles > 30j restent hors fenêtre.
//   B) RÉSURRECTION CIBLÉE : pour les fiches avec engagement RÉEL récent (<30j :
//      opt-in / booking / communication) mais dont la vraie date de création
//      reste > 30j, pose lastOptinAt = now pour les faire remonter en tête de
//      Leads Live comme leads à rappeler. Les clients (isClient / closed_won_*)
//      ne sont JAMAIS résurrectés (pas de pollution du feed sales).
//
// JAMAIS de write sur une fiche qui a déjà un createdAt Timestamp valide
// (sauf résurrection, qui n'ajoute que lastOptinAt).
//
// ─── SÉCURITÉ / WORKFLOW ──────────────────────────────────────────────────────
//   - Auth : Bearer admin uniquement.
//   - DRY-RUN PAR DÉFAUT. Pour exécuter réellement : ?apply=1
//   - Journalisation dans audit_log avant/après chaque run (intent + résultat).
//   - Writes batchés par 450. Cap de mutations par run (?applyLimit, défaut 1500)
//     + curseur (?after=) pour reprendre sans risque de timeout serverless.
//   - Idempotent : une fois createdAt en Timestamp, il n'est plus normalisé ;
//     la résurrection ne revise que les fiches encore cachées.
//
// ─── PARAMÈTRES (query string) ────────────────────────────────────────────────
//   apply=1          exécute les writes (sinon dry-run = scan seul)
//   after=<docId>    reprend le scan après ce doc (pagination de reprise)
//   max=<n>          cap de fiches scannées dans ce run (défaut 50000)
//   applyLimit=<n>   cap de fiches MUTÉES dans ce run (défaut 1500)
//   windowDays=<n>   fenêtre de visibilité Lead Live (défaut 30)
//   verbose=1        retourne TOUS les items (sinon échantillon de 300)
//
// ─── DÉCLENCHEMENT (console navigateur sur team.alteore.com) ──────────────────
//   // 1) Dry-run (aperçu, ne touche rien) :
//   fetch('/api/admin-leads-visibility-repair', {
//     headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken() }
//   }).then(r => r.json()).then(console.log);
//
//   // 2) Exécution réelle :
//   fetch('/api/admin-leads-visibility-repair?apply=1', {
//     headers: { Authorization: 'Bearer ' + await firebase.auth().currentUser.getIdToken() }
//   }).then(r => r.json()).then(console.log);
//
//   // 3) Si hasMore=true (gros volume / timeout), relancer avec le curseur :
//   //    ...?apply=1&after=<cursor renvoyé>
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');

const FieldPath = admin.firestore.FieldPath;
const Timestamp = admin.firestore.Timestamp;

// Champs strictement nécessaires au diagnostic (limite le payload des reads).
const SELECT_FIELDS = [
  'createdAt', 'updatedAt', 'lastOptinAt', 'lastBookingAt',
  'importedCreatedAt', 'communications', 'timeline_history',
  '_merged', '_mergedInto', 'source', 'stage', 'isClient', 'nom', 'email', 'telephone',
];

const CLIENT_STAGES = ['closed_won_setting', 'closed_won_self'];
const EXCLUDED_SOURCES = ['migration_suivi_client']; // jamais affiché dans Lead Live

// ─── Helpers de typage / parsing de dates ───────────────────────────────────

function fieldType(v) {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (v && typeof v.toMillis === 'function') return 'timestamp';
  // map {seconds,...} stocké comme objet (PAS un vrai Timestamp → exclu du query)
  if (v && (typeof v.seconds === 'number' || typeof v._seconds === 'number')) return 'timestamp_map';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  return 'other';
}

// Parse une date FR "jj/mm/aaaa hh:mm:ss" (toLocaleString('fr-FR')) ou ISO.
function parseFrDate(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,àaT]+(\d{1,2})[:hH](\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const day = +m[1], mon = +m[2] - 1, yr = +m[3];
    const hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
    const dt = new Date(yr, mon, day, hh, mi, ss);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  const p = Date.parse(s);
  return isNaN(p) ? null : p;
}

// Convertit n'importe quelle valeur de date en millis (lenient).
function toMillisLenient(v) {
  if (v == null) return null;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds ? Math.floor(v.nanoseconds / 1e6) : 0);
  if (typeof v._seconds === 'number') return v._seconds * 1000 + (v._nanoseconds ? Math.floor(v._nanoseconds / 1e6) : 0);
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v; // secondes vs millis
  if (typeof v === 'string') return parseFrDate(v);
  return null;
}

function maxDef(/* ...vals */) {
  let best = null;
  for (let i = 0; i < arguments.length; i++) {
    const m = arguments[i];
    if (m != null && (best == null || m > best)) best = m;
  }
  return best;
}

function extremeArrayMs(arr, pick /* 'min' | 'max' */) {
  if (!Array.isArray(arr)) return null;
  let best = null;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i] || {};
    let m = toMillisLenient(e.createdAt);
    if (m == null) m = toMillisLenient(e.date);
    if (m == null) continue;
    if (best == null) best = m;
    else if (pick === 'min') best = Math.min(best, m);
    else best = Math.max(best, m);
  }
  return best;
}

function timelineExtremeMs(arr, pick) {
  if (!Array.isArray(arr)) return null;
  let best = null;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i] || {};
    const m = parseFrDate(e.date);
    if (m == null) continue;
    if (best == null) best = m;
    else if (pick === 'min') best = Math.min(best, m);
    else best = Math.max(best, m);
  }
  return best;
}

// Meilleure date de création « vraie » pour la normalisation.
function deriveCreatedMs(d) {
  const fromField = toMillisLenient(d.createdAt);
  if (fromField != null) return { ms: fromField, src: 'createdAt_value' };
  if (typeof d.importedCreatedAt === 'string') {
    const im = parseFrDate(d.importedCreatedAt);
    if (im != null) return { ms: im, src: 'importedCreatedAt' };
  }
  const cm = extremeArrayMs(d.communications, 'min');
  if (cm != null) return { ms: cm, src: 'communications' };
  const tm = timelineExtremeMs(d.timeline_history, 'min');
  if (tm != null) return { ms: tm, src: 'timeline_history' };
  const um = toMillisLenient(d.updatedAt);
  if (um != null) return { ms: um, src: 'updatedAt' };
  return { ms: Date.now(), src: 'now' };
}

function isClientLead(d) {
  return d.isClient === true || CLIENT_STAGES.indexOf(d.stage || '') >= 0;
}

// ─── Cœur : classe une fiche et décide de l'action ──────────────────────────

// visCutoff = fenêtre de VISIBILITÉ réelle de Leads Live (par défaut 30j, celle
//   des listeners onSnapshot) → sert à décider si une fiche est « affichée ».
// resCutoff = fenêtre d'ÉLIGIBILITÉ à la résurrection (paramétrable, ex 7j) →
//   sert à décider si on rattrape la fiche. Les deux sont distinctes exprès.
function classify(d, visCutoff, resCutoff) {
  const caType = fieldType(d.createdAt);
  const caGood = caType === 'timestamp';
  const caMs = toMillisLenient(d.createdAt);

  const loGood = fieldType(d.lastOptinAt) === 'timestamp';
  const loMs = toMillisLenient(d.lastOptinAt);
  const lbGood = fieldType(d.lastBookingAt) === 'timestamp';
  const lbMs = toMillisLenient(d.lastBookingAt);

  const updMs = toMillisLenient(d.updatedAt);
  const commMs = extremeArrayMs(d.communications, 'max');
  const tlMs = timelineExtremeMs(d.timeline_history, 'max');

  // Reproduit la visibilité ACTUELLE dans Leads Live (TOUJOURS sur visCutoff) :
  //   - un listener doit charger la fiche
  //   - puis le filtre client (effectiveDate = max(createdAt,lastOptin,lastBooking)
  //     parsé lenient) doit la garder dans la fenêtre.
  // NB : une string createdAt passe le where serveur (string > timestamp) donc
  // la fiche EST chargée, puis le filtre client tranche sur la vraie date.
  const loadedMain = (caGood && caMs != null && caMs >= visCutoff) || caType === 'string';
  const loadedOptin = loGood && loMs != null && loMs >= visCutoff;
  const loadedBooking = lbGood && lbMs != null && lbMs >= visCutoff;
  const loaded = loadedMain || loadedOptin || loadedBooking;

  const clientEffMs = maxDef(caMs, loMs, lbMs);
  const clientKeeps = clientEffMs != null && clientEffMs >= visCutoff;
  const visibleNow = loaded && clientKeeps;

  // Engagement réel (opt-in / booking / communication / création datée, lenient).
  const engagementMs = maxDef(loMs, lbMs, commMs, caMs);
  // Déclencheur de résurrection : engagement dans la fenêtre resCutoff (ex 7j).
  const hasRecentEngagement = engagementMs != null && engagementMs >= resCutoff;
  // Engagement présent dans la fenêtre de visibilité (ex 30j) mais hors fenêtre de
  // résurrection → fiche qu'on choisit délibérément de NE PAS rattraper (reporting).
  const engagementWithinVis = engagementMs != null && engagementMs >= visCutoff;

  // Activité récente au sens large (reporting) : + timeline + updatedAt.
  const anyRecentMs = maxDef(engagementMs, tlMs, updMs);
  const hasRecentActivity = anyRecentMs != null && anyRecentMs >= visCutoff;

  return {
    caType, caGood, caMs,
    loMs, lbMs, updMs, commMs, tlMs,
    visibleNow, clientKeeps, loaded,
    hasRecentEngagement, engagementWithinVis, hasRecentActivity,
    engagementMs, anyRecentMs,
  };
}

function isoOrNull(ms) {
  if (ms == null) return null;
  try { return new Date(ms).toISOString(); } catch (e) { return null; }
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
    const windowDays = Math.max(1, parseInt(q.windowDays, 10) || 30);
    // Fenêtre de résurrection (rattrapage). Par défaut = windowDays (rétrocompat).
    // Ex : windowDays=30 (visibilité Leads Live) + resurrectDays=7 (on ne rattrape
    // que les fiches non affichées dont l'activité date de < 7 jours).
    const resurrectDays = Math.max(1, parseInt(q.resurrectDays, 10) || windowDays);
    const scanCap = Math.max(1, parseInt(q.max, 10) || 50000);
    const applyLimit = Math.max(1, parseInt(q.applyLimit, 10) || 1500);
    const afterId = (q.after && String(q.after)) || null;
    const pageSize = 300;

    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;       // visibilité
    const resCutoff = Date.now() - resurrectDays * 24 * 60 * 60 * 1000; // résurrection

    // ─── Stats ───
    let scanned = 0;
    let skippedMerged = 0;
    let skippedExcludedSource = 0;
    let visibleAlready = 0;
    let hiddenNoAction = 0;
    const byReason = {};
    const bump = (k) => { byReason[k] = (byReason[k] || 0) + 1; };

    // Mutations à appliquer : { id, ref, update, kind, item }
    const mutations = [];
    const items = []; // pour le rapport (échantillon ou complet)
    const ITEM_CAP = verbose ? Infinity : 300;

    // Originaux à résurrecter parce qu'un doublon _merged a reçu un re-opt-in
    // récent (lastOptinAt/booking/comm) que Leads Live masque (doc _merged).
    // Clé = id de l'originale (_mergedInto). Valeur = id du doublon source.
    const mergeResurrectTargets = new Map();
    let skippedMergedStale = 0; // doublons _merged sans re-engagement récent

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

        // Doublons _merged : jamais affichés tels quels. MAIS si un doublon a
        // reçu un re-engagement récent (le dédup d'opt-in a posé lastOptinAt sur
        // le doublon par erreur), on doit propager la résurrection à l'ORIGINALE.
        if (d._merged === true) {
          skippedMerged++;
          const mergedEngagementMs = maxDef(
            (fieldType(d.lastOptinAt) === 'timestamp' || d.lastOptinAt) ? toMillisLenient(d.lastOptinAt) : null,
            (fieldType(d.lastBookingAt) === 'timestamp' || d.lastBookingAt) ? toMillisLenient(d.lastBookingAt) : null,
            extremeArrayMs(d.communications, 'max')
          );
          const orig = d._mergedInto;
          if (orig && mergedEngagementMs != null && mergedEngagementMs >= resCutoff) {
            // On garde la trace de l'engagement le plus récent par originale.
            const prev = mergeResurrectTargets.get(orig);
            if (!prev || mergedEngagementMs > prev.engagementMs) {
              mergeResurrectTargets.set(orig, { fromMergedId: doc.id, engagementMs: mergedEngagementMs });
            }
          } else {
            skippedMergedStale++;
          }
          continue;
        }
        if (EXCLUDED_SOURCES.indexOf(d.source) >= 0) { skippedExcludedSource++; continue; }

        const c = classify(d, cutoff, resCutoff);

        if (c.visibleNow && c.caGood) {
          // Déjà visible ET createdAt sain → rien à faire.
          visibleAlready++;
          continue;
        }

        // Décision NORMALISATION : createdAt n'est pas un Timestamp valide.
        const needNormalize = !c.caGood;

        // Calcule la date de création dérivée (si on normalise).
        const derived = needNormalize ? deriveCreatedMs(d) : { ms: c.caMs, src: 'createdAt_value' };
        const effAfterCreatedMs = needNormalize ? derived.ms : c.caMs;

        // Après normalisation, la fiche serait-elle visible ?
        const loadedAfter = (effAfterCreatedMs != null && effAfterCreatedMs >= cutoff)
          || (c.loMs != null && fieldType(d.lastOptinAt) === 'timestamp' && c.loMs >= cutoff)
          || (c.lbMs != null && fieldType(d.lastBookingAt) === 'timestamp' && c.lbMs >= cutoff);
        const clientEffAfter = maxDef(effAfterCreatedMs, c.loMs, c.lbMs);
        const visibleAfterNormalize = loadedAfter && clientEffAfter != null && clientEffAfter >= cutoff;

        // Décision RÉSURRECTION : encore caché après normalisation, engagement
        // réel récent, et pas un client.
        const client = isClientLead(d);
        const needResurrect = !visibleAfterNormalize && c.hasRecentEngagement && !client;

        if (!needNormalize && !needResurrect) {
          // Caché mais aucune action. Trois cas distincts pour la transparence :
          //  - client → on ne touche pas (feed sales)
          //  - engagement présent mais HORS fenêtre de résurrection (ex : activité
          //    entre 7 et 30j alors que resurrectDays=7) → délibérément non rattrapé
          //  - aucun engagement récent → vieux lead, correctement hors fenêtre
          if (!c.visibleNow) {
            hiddenNoAction++;
            let reasonKey;
            if (client) reasonKey = 'client_no_action';
            else if (c.engagementWithinVis && !c.hasRecentEngagement) reasonKey = 'engagement_beyond_resurrect_window';
            else reasonKey = 'no_recent_engagement';
            bump('hidden_' + reasonKey);
            if (items.length < ITEM_CAP) {
              items.push({
                id: doc.id, nom: d.nom || null, email: d.email || null, telephone: d.telephone || null,
                stage: d.stage || null, createdAtType: c.caType,
                action: 'none', reason: reasonKey,
                updatedAt: isoOrNull(c.updMs), lastActivity: isoOrNull(c.anyRecentMs),
              });
            }
          } else {
            // visibleNow true mais caGood false géré ailleurs ; ne devrait pas
            // tomber ici. Sécurité : on compte comme déjà visible.
            visibleAlready++;
          }
          continue;
        }

        // Construit l'update.
        const update = {};
        let kind = '';
        const reasonParts = [];

        if (needNormalize) {
          update.createdAt = Timestamp.fromMillis(derived.ms);
          update.createdAtRepaired = true;
          update.createdAtRepairedAt = admin.firestore.FieldValue.serverTimestamp();
          update.createdAtRepairSource = derived.src;
          kind = 'normalize';
          reasonParts.push('createdAt_' + c.caType + '→ts(' + derived.src + ')');
          bump('normalize_createdAt_' + c.caType);
        }

        if (needResurrect) {
          update.lastOptinAt = admin.firestore.FieldValue.serverTimestamp();
          update.visibilityResurrectedAt = admin.firestore.FieldValue.serverTimestamp();
          kind = kind ? 'normalize+resurrect' : 'resurrect';
          reasonParts.push('resurrect(engagement<' + windowDays + 'j)');
          bump('resurrect_recent_engagement');
        }

        const item = {
          id: doc.id, nom: d.nom || null, email: d.email || null, telephone: d.telephone || null,
          stage: d.stage || null, createdAtType: c.caType,
          action: kind, reason: reasonParts.join(' + '),
          derivedCreatedAt: needNormalize ? isoOrNull(derived.ms) : null,
          becomesVisible: needNormalize ? !!visibleAfterNormalize : null,
          lastActivity: isoOrNull(c.anyRecentMs),
        };
        if (items.length < ITEM_CAP) items.push(item);

        mutations.push({ id: doc.id, ref: doc.ref, update, kind, item });

        // Cap de mutations par run → on s'arrête proprement et on renvoie un curseur.
        if (mutations.length >= applyLimit) { stopForApplyCap = true; break; }
      }

      if (stopForApplyCap) { hasMore = true; break; }
      if (snap.size < pageSize) { hasMore = false; break; }
      if (scanned >= scanCap) { hasMore = true; break; }
    }

    // ─── Propagation des résurrections depuis les doublons _merged ───
    // Pour chaque originale ciblée par un doublon ré-optiné récemment : on la
    // charge, et si elle est bien cachée (visibilité 30j) et non-cliente, on la
    // résurrecte. C'est ce qui rattrape les « Sarah » (re-opt-in atterri sur le
    // doublon _merged que Leads Live masque).
    let resurrectedFromMerged = 0;
    const alreadyMutated = new Set(mutations.map((m) => m.id));
    const targetIds = Array.from(mergeResurrectTargets.keys())
      .filter((id) => !alreadyMutated.has(id));
    for (const origId of targetIds) {
      if (mutations.length >= applyLimit) { hasMore = true; break; }
      let snapDoc;
      try {
        snapDoc = await db.collection('leads').doc(origId).get();
      } catch (e) { continue; }
      if (!snapDoc.exists) continue;
      const od = snapDoc.data() || {};
      if (od._merged === true) continue; // l'originale ne devrait pas être elle-même un doublon
      const oc = classify(od, cutoff, resCutoff);
      const oClient = isClientLead(od);
      if (oc.visibleNow || oClient) continue; // déjà visible ou cliente → on laisse
      const src = mergeResurrectTargets.get(origId);
      const update = {
        lastOptinAt: admin.firestore.FieldValue.serverTimestamp(),
        visibilityResurrectedAt: admin.firestore.FieldValue.serverTimestamp(),
        resurrectedFromMergedTwin: src ? src.fromMergedId : true,
      };
      const item = {
        id: origId, nom: od.nom || null, email: od.email || null, telephone: od.telephone || null,
        stage: od.stage || null, createdAtType: fieldType(od.createdAt),
        action: 'resurrect_from_merged', reason: 'reoptin_landed_on_merged_twin(' + (src ? src.fromMergedId : '?') + ')',
        derivedCreatedAt: null, becomesVisible: true,
        lastActivity: isoOrNull(src ? src.engagementMs : null),
      };
      if (items.length < ITEM_CAP) items.push(item);
      mutations.push({ id: origId, ref: snapDoc.ref, update, kind: 'resurrect', item });
      bump('resurrect_from_merged_twin');
      resurrectedFromMerged++;
    }

    const normalizeCount = mutations.filter((m) => m.kind.indexOf('normalize') >= 0).length;
    const resurrectCount = mutations.filter((m) => m.kind.indexOf('resurrect') >= 0).length;

    const summary = {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      windowDays,
      resurrectDays,
      cutoffISO: new Date(cutoff).toISOString(),
      resurrectCutoffISO: new Date(resCutoff).toISOString(),
      scanned,
      skippedMerged,
      skippedMergedStale,
      mergeReoptinTargets: mergeResurrectTargets.size,
      resurrectedFromMerged,
      skippedExcludedSource,
      visibleAlready,
      candidates: mutations.length,
      toNormalize: normalizeCount,
      toResurrect: resurrectCount,
      hiddenNoAction,
      byReason,
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
      summary.applied = { normalized: 0, resurrected: 0, writes: 0 };
      return res.status(200).json(summary);
    }

    // ─── AUDIT : intent avant écriture ───
    const auditRef = db.collection('audit_log').doc();
    const auditIntent = {
      type: 'leads_visibility_repair',
      phase: 'intent',
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      windowDays,
      resurrectDays,
      cutoffISO: summary.cutoffISO,
      scanned,
      toNormalize: normalizeCount,
      toResurrect: resurrectCount,
      cursorStart: afterId || null,
      cursorEnd: lastDocId || null,
      hasMore,
      // Détail capé pour rester sous la limite 1 Mo / doc Firestore.
      affected: mutations.slice(0, 2000).map((m) => ({ id: m.id, kind: m.kind, reason: m.item.reason })),
      affectedTruncated: mutations.length > 2000,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await auditRef.set(auditIntent);

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
      type: 'leads_visibility_repair',
      phase: 'result',
      intentAuditId: auditRef.id,
      actorUid: auth.uid,
      actorEmail: auth.email || null,
      normalized: normalizeCount,
      resurrected: resurrectCount,
      writes,
      cursorEnd: lastDocId || null,
      hasMore,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    summary.applied = { normalized: normalizeCount, resurrected: resurrectCount, writes };
    summary.auditId = auditRef.id;
    return res.status(200).json(summary);

  } catch (e) {
    console.error('[admin-leads-visibility-repair] error:', e && e.message, e && e.stack);
    return res.status(500).json({ ok: false, error: (e && e.message) || 'internal_error' });
  }
};
