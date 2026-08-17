// ============================================================================
// api/ringover-sync-cron.js
// ----------------------------------------------------------------------------
// Sync AUTOMATIQUE quotidienne des appels Ringover → Firestore call_logs.
//
// Pourquoi : les appels passés via le Dialer d'Alteore sont déjà tracés en
// temps réel (ringover-call-initiate + webhook ringover-call-status). Ce cron
// rattrape le reste : appels passés directement depuis l'app Ringover
// (mobile/desktop, hors Alteore) et appels ENTRANTS — pour que la section
// ☎️ du Funnel Sales soit exhaustive sans action manuelle.
//
// Déclenchement : Vercel Cron (voir vercel.json) — tous les jours 03:30 UTC
//                 (≈ 05:30 Paris en été / 04:30 en hiver).
// URL  : GET|POST https://team.alteore.com/api/ringover-sync-cron[?hours=48]
// Auth : 2 modes acceptés —
//        • Authorization: Bearer <CRON_SECRET>   (envoyé automatiquement par
//          Vercel Cron dès que la variable d'env CRON_SECRET existe)
//        • x-api-key: <CRON_SECRET>              (test manuel via curl)
//
// Fenêtre : dernières `hours` heures (défaut 48 — le chevauchement quotidien
// absorbe les retards de webhooks ; upsert idempotent par call_id, donc
// rejouable sans doublon). Cap : 168 h (7 j).
//
// ─── DIFFÉRENCES avec api/admin-sync-ringover-calls.js (conservé) ─────
//   - Auth par secret (pas de token Firebase) → appelable par un cron.
//   - PAS d'appel /transcriptions/{id} par appel : inutile pour les stats
//     et trop lent pour une serverless (le sync admin manuel reste dispo
//     pour ça). Les transcripts déjà posés ne sont pas touchés (merge).
//   - Ne touche jamais leadId (posé par le Dialer) ni les champs IA.
//
// ─── DÉPLOIEMENT ──────────────────────────────────────────────────────
//   1. Variable Vercel : CRON_SECRET (valeur forte fournie par Claude).
//   2. Ce fichier dans /api + vercel.json à la racine → push → redeploy.
//   3. Test : curl -H "x-api-key: <CRON_SECRET>"
//        https://team.alteore.com/api/ringover-sync-cron?hours=48
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');

module.exports = async (req, res) => {
  // ─── 1. Auth : Bearer CRON_SECRET (Vercel Cron) ou x-api-key ─────────
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[ringover-sync-cron] CRON_SECRET env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerOk = authHeader === 'Bearer ' + secret;
  const apiKeyOk = (req.headers['x-api-key'] || req.headers['X-API-Key']) === secret;
  if (!bearerOk && !apiKeyOk) {
    console.warn('[ringover-sync-cron] unauthorized');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ─── 2. Fenêtre temporelle ────────────────────────────────────────────
  const q = req.query || {};
  let hours = parseInt(q.hours, 10);
  if (isNaN(hours) || hours < 1) hours = 48;
  hours = Math.min(hours, 168); // cap 7 jours (limite chunk API Ringover)

  const t0 = Date.now();
  const now = new Date();
  const start = new Date(now.getTime() - hours * 3600000);
  console.log('[ringover-sync-cron] window:', hours + 'h', start.toISOString(), '→', now.toISOString());

  // ─── 3. Récupération des appels (pagination 200/page, fenêtre ≤ 7 j) ──
  let callList = [];
  try {
    let offset = 0;
    const limit = 200;
    while (true) {
      const qs = new URLSearchParams({
        start_date:   start.toISOString(),
        end_date:     now.toISOString(),
        limit_count:  String(limit),
        limit_offset: String(offset),
      }).toString();

      const resp = await ringoverFetch(`/calls?${qs}`, { method: 'GET' });
      const list = resp?.call_list || [];
      callList = callList.concat(list);
      const total = resp?.total_call_count || 0;

      if (list.length < limit || callList.length >= total || list.length === 0) break;
      offset += limit;
      if (offset > 5000) break; // garde-fou absolu
    }
  } catch (e) {
    console.error('[ringover-sync-cron] fetch calls error:', e.message, e.rawResponse);
    res.status(502).json({ error: 'ringover_api_error', message: e.rawResponse || e.message });
    return;
  }
  console.log('[ringover-sync-cron]', callList.length, 'appels récupérés');

  // ─── 4. Mapping ringoverUserId → firebaseUid (identique sync admin) ───
  const ringoverUserToUid = {};
  try {
    const phoneSnap = await db.collection('phone_numbers')
      .where('provider', '==', 'ringover').where('active', '==', true).get();

    phoneSnap.forEach(d => {
      const x = d.data();
      if (x.ringoverUserId && x.assignedTo) {
        ringoverUserToUid[String(x.ringoverUserId)] = x.assignedTo;
      }
    });

    if (Object.keys(ringoverUserToUid).length === 0 && phoneSnap.size > 0) {
      const credSnap = await db.collection('_config').doc('telco_credentials').get();
      const cred = credSnap.data()?.ringover;
      const assignedTo = phoneSnap.docs[0].data().assignedTo;
      if (cred?.userId && assignedTo) {
        ringoverUserToUid[String(cred.userId)] = assignedTo;
      }
    }

    if (Object.keys(ringoverUserToUid).length === 0) {
      // Ultime fallback : Élodie (seule utilisatrice Ringover actuellement)
      ringoverUserToUid['22855712'] = 'IrL8bfOrUfMH2fEPFzuojPT8bQh1';
    }
  } catch (e) {
    console.warn('[ringover-sync-cron] mapping error:', e.message);
    ringoverUserToUid['22855712'] = 'IrL8bfOrUfMH2fEPFzuojPT8bQh1';
  }

  // ─── 5. Upsert call_logs (batchs de 400, merge, SANS transcriptions) ──
  const results = { synced: 0, errors: 0 };
  const batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const fb = db.batch();
    batch.forEach(({ ref, data }) => fb.set(ref, data, { merge: true }));
    await fb.commit();
    batch.length = 0;
  };

  for (const call of callList) {
    try {
      const callId = call.call_id ? String(call.call_id) : null;
      if (!callId || callId === '0') continue;

      const addPlus = n => n ? (String(n).startsWith('+') ? String(n) : '+' + String(n)) : null;
      const fromNum = addPlus(call.from_number);
      const toNum   = addPlus(call.to_number);
      const isOut   = call.direction === 'out';

      const update = {
        providerCallId: callId,
        provider:       'ringover',
        direction:      isOut ? 'outbound' : 'inbound',
        fromNumber:     fromNum,
        toNumber:       toNum,
        status:         call.is_answered ? 'completed' : (call.last_state === 'MISSED' ? 'no-answer' : 'completed'),
        /* Durées (fix 15/07) : durationSec = CONVERSATION stricte
           (incall_duration ; 0 si non décroché — plus jamais le repli
           total_duration qui transformait la sonnerie d'un appel non
           décroché en « conversation » au sync suivant).
           totalDurationSec = durée totale, sonnerie incluse. */
        durationSec:    (function () { var n = Number(call.incall_duration); return isFinite(n) && n > 0 ? Math.round(n) : 0; })(),
        totalDurationSec: (function () { var n = Number(call.total_duration); return isFinite(n) && n > 0 ? Math.round(n) : null; })(),
        /* Sonnerie et détection de répondeur (17/08/2026) — lus depuis
           toujours par l'API, jamais stockés jusqu'ici. Ce sont eux qui
           permettent de ne plus compter une messagerie comme un décroché
           (voir isAnsweredCall dans funnel-core.js). Sur l'historique la
           sonnerie se déduit de total − incall ; à partir d'ici elle est
           mesurée, ce qui est plus sûr si Ringover ajoute un jour de
           l'attente en file ou de la mise en garde au total. */
        ringingDurationSec: (function () { var n = Number(call.ringing_duration); return isFinite(n) && n >= 0 ? Math.round(n) : null; })(),
        amd: call.amd === true ? true : (call.amd === false ? false : null),
        hangupBy: call.hangup_by || null,
        startTime:      call.start_time || null,
        endTime:        call.end_time   || null,
        syncedAt:       admin.firestore.FieldValue.serverTimestamp(),
        syncedVia:      'cron',
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      };

      if (call.record) {
        update.ringoverRecordingUrl = call.record;
        update.recordingStatus = 'available';
      }

      if (call.start_time) {
        try { update.initiatedAt = admin.firestore.Timestamp.fromDate(new Date(call.start_time)); }
        catch (_) {}
      }

      if (call.user) {
        const ruid = call.user.user_id ? String(call.user.user_id) : null;
        update.ringoverUserId = ruid;
        update.ringoverUserName = ((call.user.firstname || '') + ' ' + (call.user.lastname || '')).trim() || null;
        if (ruid && ringoverUserToUid[ruid]) update.userId = ringoverUserToUid[ruid];
        if (call.user.firstname) update.userName = call.user.firstname;
      } else if (Object.keys(ringoverUserToUid).length === 1) {
        update.userId = Object.values(ringoverUserToUid)[0];
      }

      if (call.contact) {
        update.leadNameSnapshot = call.contact.firstname
          ? ((call.contact.firstname || '') + ' ' + (call.contact.lastname || '')).trim()
          : null;
      }

      batch.push({ ref: db.collection('call_logs').doc(callId), data: update });
      results.synced++;
      if (batch.length >= 400) await flush();
    } catch (err) {
      console.warn('[ringover-sync-cron] error for call', call.call_id, err.message);
      results.errors++;
    }
  }
  await flush();

  const tookMs = Date.now() - t0;
  console.log('[ringover-sync-cron] done:', results, tookMs + 'ms');
  res.status(200).json({
    ok: true,
    hours,
    totalCalls: callList.length,
    synced: results.synced,
    errors: results.errors,
    tookMs,
  });
};
