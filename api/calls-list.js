// ============================================================================
// api/calls-list.js — liste allégée des appels (call_logs) pour la page
// « Réécoutes » (sales-appels.html).
// ----------------------------------------------------------------------------
// Pourquoi un endpoint plutôt qu'une lecture Firestore directe :
//   - les docs call_logs portent la transcription Ringover complète
//     (transcriptSpeeches avec le découpage mot à mot) : plusieurs dizaines de
//     Ko par appel. Le SDK client ne sait pas projeter, l'Admin SDK si
//     (.select) — on ne renvoie que les champs utiles à la liste ;
//   - le périmètre est appliqué côté serveur, en miroir des rules Firestore :
//       admin OU users/{uid}.canListenCalls == true → tous les appels ;
//       sinon → uniquement ses propres appels (userId == uid).
//
// POST { from?: ISO, to?: ISO, limit?: number }
//   → { ok, scope: 'all'|'own', viewerUid, from, to, limit, truncated, calls[] }
//
// Chaque entrée de calls[] : id, direction, status, leadId, leadName,
// leadMatch ('id' | 'phone' | absent — voir resolveLeads),
// fromNumber, toNumber, initiatedAt (ISO), answeredAt (ISO), durationSec,
// totalDurationSec, ringingDurationSec, amd, hangupBy, userId, userName,
// ringoverUserName, campaignId, provider, hasRecording, hasTranscript,
// hasSummary, aiSummary.
//
// Index : la requête des non-admins (userId == X + initiatedAt borné + tri)
// s'appuie sur le même index composite (userId ASC, initiatedAt DESC) que
// l'historique du Dialer (sales-dialer.js). Si Firestore renvoie
// FAILED_PRECONDITION, le lien de création est dans le message d'erreur.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { phoneNormalized, toE164 } = require('./_leadLookup');

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 500;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 400;

const FIELDS = [
  'direction', 'status', 'leadId', 'leadNameSnapshot', 'leadName',
  'fromNumber', 'toNumber', 'initiatedAt', 'answeredAt',
  'durationSec', 'totalDurationSec', 'ringingDurationSec', 'amd', 'hangupBy',
  'userId', 'userName', 'ringoverUserName', 'campaignId', 'provider',
  'recordingStatus', 'ringoverRecordingUrl', 'recordingStoragePath',
  'transcriptionStatus', 'transcribedAt', 'transcriptText', 'transcriptionText',
  'aiAnalysisStatus', 'aiSummary', 'aiAnalysis',
];

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const toIso = t => (t && t.toDate ? t.toDate().toISOString() : null);

// ── Rattachement des appels aux fiches Leads Live ──────────────────────────
// Les appels synchronisés depuis Ringover n'ont presque jamais de leadId, et
// leadNameSnapshot n'est posé que si le contact existe dans l'annuaire
// Ringover : la page n'affichait que des numéros. On résout donc ici, en lot :
//   1. leadId présent → la fiche (nom à jour) si elle est vivante ;
//   2. sinon le numéro du correspondant → phoneNormalized (9 derniers
//      chiffres), puis `telephone` en E.164 / format 0X pour les vieilles
//      fiches sans phoneNormalized.
// Les fiches `_merged: true` sont ignorées (motif pickAlive). Requêtes `in`
// par paquets de 30 (limite Firestore) et projection sur les seuls champs
// utiles : quelques lectures par chargement, pas une par appel.
const LEAD_FIELDS = ['nom', 'telephone', 'phoneNormalized', '_merged'];

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function queryIn(field, values) {
  const docs = [];
  const parts = chunks(values, 30);
  const snaps = await Promise.all(parts.map(part =>
    db.collection('leads').where(field, 'in', part).select(...LEAD_FIELDS).get()));
  snaps.forEach(sn => sn.docs.forEach(d => docs.push(d)));
  return docs;
}

function otherNumber(c) {
  return c.direction === 'inbound' ? c.fromNumber : c.toNumber;
}

async function resolveLeads(calls) {
  const byId = {};
  // 1. leadId connus
  const ids = Array.from(new Set(calls.map(c => c.leadId).filter(Boolean)));
  if (ids.length) {
    const refs = ids.map(id => db.collection('leads').doc(id));
    const snaps = await db.getAll(...refs, { fieldMask: LEAD_FIELDS });
    snaps.forEach(d => {
      if (d.exists && d.data()._merged !== true) byId[d.id] = d;
    });
  }

  // 2. numéros des appels sans fiche vivante
  const pending = calls.filter(c => !(c.leadId && byId[c.leadId]) && phoneNormalized(otherNumber(c)));
  const byNorm = {};
  if (pending.length) {
    const norms = Array.from(new Set(pending.map(c => phoneNormalized(otherNumber(c))).filter(n => n.length === 9)));
    (await queryIn('phoneNormalized', norms)).forEach(d => {
      const x = d.data();
      if (x._merged === true || !x.phoneNormalized) return;
      if (!byNorm[x.phoneNormalized]) byNorm[x.phoneNormalized] = d;
    });
    const missing = norms.filter(n => !byNorm[n]);
    if (missing.length) {
      const tels = [];
      missing.forEach(n => { tels.push('+33' + n, '0' + n); });
      (await queryIn('telephone', tels)).forEach(d => {
        const x = d.data();
        if (x._merged === true) return;
        const n = phoneNormalized(toE164(x.telephone));
        if (n && !byNorm[n]) byNorm[n] = d;
      });
    }
  }

  calls.forEach(c => {
    let d = c.leadId ? byId[c.leadId] : null;
    let how = d ? 'id' : null;
    if (!d) {
      const n = phoneNormalized(otherNumber(c));
      d = n ? byNorm[n] : null;
      if (d) how = 'phone';
    }
    if (!d) return;
    const nom = String(d.data().nom || '').trim();
    c.leadId = d.id;
    if (nom) c.leadName = nom;
    c.leadMatch = how;
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = parseBody(req);

  // ── Fenêtre temporelle ────────────────────────────────────────────────────
  let to = parseDate(body.to) || new Date();
  let from = parseDate(body.from) || new Date(to.getTime() - DEFAULT_DAYS * 86400000);
  if (from.getTime() > to.getTime()) {
    res.status(400).json({ error: 'Fenêtre invalide : from > to' });
    return;
  }
  if (to.getTime() - from.getTime() > MAX_DAYS * 86400000) {
    from = new Date(to.getTime() - MAX_DAYS * 86400000);
  }

  let limit = parseInt(body.limit, 10);
  if (!(limit > 0)) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  // ── Périmètre (miroir des rules call_logs) ────────────────────────────────
  const scopeAll = auth.role === 'admin' || (auth.userData && auth.userData.canListenCalls === true);

  try {
    let q = db.collection('call_logs');
    if (!scopeAll) q = q.where('userId', '==', auth.uid);
    q = q
      .where('initiatedAt', '>=', admin.firestore.Timestamp.fromDate(from))
      .where('initiatedAt', '<=', admin.firestore.Timestamp.fromDate(to))
      .orderBy('initiatedAt', 'desc')
      .limit(limit)
      .select(...FIELDS);

    const snap = await q.get();

    const calls = snap.docs.map(d => {
      const x = d.data() || {};
      const hasRecording = !!(x.ringoverRecordingUrl || x.recordingStoragePath);
      const hasTranscript = x.transcriptionStatus === 'done'
        || !!x.transcriptText || !!x.transcriptionText || !!x.transcribedAt;
      const aiSummary = x.aiSummary
        || (x.aiAnalysis && typeof x.aiAnalysis.summary === 'string' ? x.aiAnalysis.summary : null);
      return {
        id:                 d.id,
        direction:          x.direction || null,
        status:             x.status || null,
        leadId:             x.leadId || null,
        leadName:           x.leadNameSnapshot || x.leadName || null,
        fromNumber:         x.fromNumber || null,
        toNumber:           x.toNumber || null,
        initiatedAt:        toIso(x.initiatedAt),
        answeredAt:         toIso(x.answeredAt),
        durationSec:        typeof x.durationSec === 'number' ? x.durationSec : null,
        totalDurationSec:   typeof x.totalDurationSec === 'number' ? x.totalDurationSec : null,
        ringingDurationSec: typeof x.ringingDurationSec === 'number' ? x.ringingDurationSec : null,
        amd:                x.amd === true ? true : (x.amd === false ? false : null),
        hangupBy:           x.hangupBy || null,
        userId:             x.userId || null,
        userName:           x.userName || null,
        ringoverUserName:   x.ringoverUserName || null,
        campaignId:         x.campaignId || null,
        provider:           x.provider || null,
        hasRecording,
        hasTranscript,
        hasSummary:         !!aiSummary,
        aiSummary:          aiSummary || null,
      };
    });

    // Rattachement best effort : une panne ici ne doit pas vider la page.
    try { await resolveLeads(calls); }
    catch (e) { console.warn('[calls-list] resolveLeads:', e && e.message); }

    res.status(200).json({
      ok: true,
      scope: scopeAll ? 'all' : 'own',
      viewerUid: auth.uid,
      from: from.toISOString(),
      to: to.toISOString(),
      limit,
      truncated: calls.length >= limit,
      calls,
    });
  } catch (err) {
    console.error('[calls-list] Error:', err && err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
};
