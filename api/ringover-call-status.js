// api/ringover-call-status.js  (v5 — webhooks Ringover 2.0)
// Format 2.0 : { resource, event, timestamp, attempt, data: { id (UUID),
//               call_id (uint64), channel_id, direction, from_number,
//               to_number, user_id, user, start_time, start_date_time_atom,
//               duration_in_seconds, record, answering_machine_detection, … } }
//
// ─── v5 (correctif 14/09/2026) — RINGOVER EST PASSÉ AUX WEBHOOKS 2.0 ────────
//
// Constaté dans les logs Vercel du 14/09 : les événements arrivent avec
// data.id = UUID (ex. « d79e053a-… ») alors que l'appel est créé par
// ringover-call-initiate sous son call_id NUMÉRIQUE (ex.
// « 7534779999276888538 »). La v4 prenait data.id en priorité : chaque
// webhook écrivait donc dans un doc call_logs orphelin (UUID, sans userId ni
// initiatedAt — invisible partout), et ne retrouvait jamais le leg de
// dialer_campaigns. Conséquences en chaîne :
//   - historique du dialer figé sur « initiated » (l'historique d'Élodie) ;
//   - campagne jamais 'connected' ni 'ended' → UI du dialer bloquée sur
//     « composition », Power Dialer qui n'enchaîne plus ;
//   - le beacon de navigation (dialer-cancel-campaign) voyait le leg encore
//     actif et RACCROCHAIT L'APPEL EN COURS quand Élodie revenait sur la
//     fiche du lead ;
//   - dialer_attempts jamais incrémenté, pipeline enregistrement jamais
//     déclenché.
//
// Changements v5 :
//   1. Id d'appel : data.call_id prioritaire (pickCallId), data.id en dernier
//      recours (compat ancien format).
//   2. Corps lu en BRUT (readRingoverPayload) : les call_id uint64 dépassent
//      Number.MAX_SAFE_INTEGER — via req.body pré-parsé ils sont arrondis et
//      ne matchent plus rien.
//   3. Clé de webhook : les webhooks 2.0 envoient un JWT HS signé avec la clé
//      (Bearer eyJ…) — vérifié par checkRingoverAuth, en plus des formes
//      historiques. Le rejet reste piloté par le flag
//      _config/telco_credentials.ringover.webhookKeyEnforce (défaut : log).
//   4. Champs 2.0 : record (URL d'enregistrement), duration_in_seconds
//      (durée totale), answering_machine_detection (répondeur).
//   5. Appels passés HORS dialer (app Ringover directe, entrants) : au
//      HANGUP/MISSED, si le doc call_logs n'a pas d'identité (initiatedAt,
//      direction, userId…), on la pose depuis le payload + le mapping
//      phone_numbers — l'historique est complet en temps réel, sans attendre
//      le sync de 03h30.
//   6. Retry unique sur les erreurs réseau Firestore (EPIPE / socket hang up
//      d'une connexion REST recyclée après un gel Vercel — vu en masse dans
//      les logs).
//
// ─── v4 (rappel) ────────────────────────────────────────────────────────────
// Écritures attendues AVANT la réponse : Vercel gèle la fonction dès
// res.end(), tout ce qui court après est perdu (statuts manquants,
// compteurs faux, transcriptions jamais lancées). On répond toujours 200,
// même en erreur, pour éviter les rejeux Ringover.

const { db, admin } = require('./_firebaseAdmin');
const { readRingoverPayload, pickCallId, checkRingoverAuth } = require('./_ringoverWebhook');

/* Cache de la config Ringover. Une seule lecture par instance chaude —
   on récupère la clé ET le flag d'application en même temps. */
let _ringoverCfg = null;
async function getRingoverCfg() {
  if (_ringoverCfg) return _ringoverCfg;
  let cfg = { webhookKey: null, enforce: false };
  try {
    const snap = await db.collection('_config').doc('telco_credentials').get();
    if (snap.exists) {
      const r = (snap.data() || {}).ringover || {};
      cfg = { webhookKey: r.webhookKey || null, enforce: r.webhookKeyEnforce === true };
    }
  } catch (_) { /* config illisible : on n'applique jamais le rejet */ }
  _ringoverCfg = cfg;
  return cfg;
}

/* Mapping ringoverUserId → firebaseUid, pour rattacher les appels passés
   hors dialer au bon commercial (même source que ringover-sync-cron :
   phone_numbers déclarés dans admin-numbers.html). Cache 10 min. */
let _userMap = null;
let _userMapAt = 0;
async function getRingoverUserMap() {
  if (_userMap && Date.now() - _userMapAt < 10 * 60 * 1000) return _userMap;
  const map = {};
  try {
    const snap = await db.collection('phone_numbers')
      .where('provider', '==', 'ringover').where('active', '==', true).get();
    snap.forEach(d => {
      const x = d.data();
      if (x.ringoverUserId && x.assignedTo) map[String(x.ringoverUserId)] = x.assignedTo;
    });
  } catch (e) { console.warn('[ringover-call-status] user map:', e.message); }
  _userMap = map;
  _userMapAt = Date.now();
  return map;
}

/* Retry unique sur erreur réseau : après un gel Vercel, la première requête
   Firestore d'une instance dégelée peut partir sur une connexion morte
   (write EPIPE / socket hang up). La seconde ouvre une connexion neuve. */
async function withRetry(fn, label) {
  try { return await fn(); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/EPIPE|socket hang up|ECONNRESET|network socket disconnected|DEADLINE_EXCEEDED/i.test(msg)) {
      console.warn('[ringover-call-status] retry', label, ':', msg);
      await new Promise(r => setTimeout(r, 150));
      return fn();
    }
    throw e;
  }
}

/* start_date_time_atom (ISO) prioritaire, sinon start_time (epoch s ou ms). */
function startTimestamp(d) {
  if (d.start_date_time_atom) {
    const t = new Date(d.start_date_time_atom);
    if (!isNaN(t)) return admin.firestore.Timestamp.fromDate(t);
  }
  if (d.start_time != null) {
    let n = Number(d.start_time);
    if (isFinite(n) && n > 0) {
      if (n < 1e12) n *= 1000; // epoch secondes
      const t = new Date(n);
      if (!isNaN(t)) return admin.firestore.Timestamp.fromDate(t);
    } else {
      const t = new Date(String(d.start_time));
      if (!isNaN(t)) return admin.firestore.Timestamp.fromDate(t);
    }
  }
  return null;
}

const STATUS_MAP = {
  RINGING: 'ringing', ANSWERED: 'in-progress', HANGUP: 'completed', MISSED: 'no-answer',
  ringing: 'ringing', answered: 'in-progress', hangup: 'completed', missed: 'no-answer',
};
const TERMINAL = new Set(['HANGUP', 'MISSED', 'hangup', 'missed']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  /* Corps lu AVANT tout accès à req.body (sinon le flux brut est perdu et
     les uint64 avec lui). */
  const payload = await readRingoverPayload(req);

  /* ── Clé de webhook ──
     Le rejet n'est appliqué que si webhookKeyEnforce === true en base.
     Par défaut on se contente de journaliser, exactement comme avant. */
  const cfg = await getRingoverCfg().catch(() => ({ webhookKey: null, enforce: false }));
  const keyOk = checkRingoverAuth(req, cfg.webhookKey);
  if (keyOk === false) {
    if (cfg.enforce) {
      console.warn('[ringover-call-status] clé NON reconnue — rejet (webhookKeyEnforce actif)');
      res.status(403).json({ error: 'invalid_webhook_key' });
      return;
    }
    console.warn('[ringover-call-status] clé NON reconnue — accepté quand même '
      + '(webhookKeyEnforce absent ou false). En-tête reçu : '
      + String(req.headers['authorization'] || req.headers['x-ringover-token'] || '(aucun)').substring(0, 40));
  } else if (keyOk === true) {
    console.log('[ringover-call-status] clé reconnue');
  }

  /* ── Traitement AVANT la réponse ──
     Vercel gèle la fonction dès `res.end()` : tout ce qui suit la réponse
     est perdu. On fait le travail d'abord, on répond ensuite — et on
     répond 200 même en erreur, pour ne pas déclencher les rejeux Ringover. */
  try {
    const event  = ((payload && payload.event) || '').toUpperCase();
    const d      = (payload && payload.data) || {};
    const callId = pickCallId(payload);

    console.log('[ringover-call-status]', event, callId, d.id && String(d.id) !== callId ? '(resource ' + d.id + ')' : '');

    if (!callId) {
      console.warn('[ringover-call-status] No callId. Raw payload keys:', Object.keys(payload || {}), 'data keys:', Object.keys(d));
      res.status(200).end();
      return;
    }

    const mappedStatus = STATUS_MAP[event] || event.toLowerCase();
    const isTerminal   = TERMINAL.has(event);
    const now          = admin.firestore.FieldValue.serverTimestamp();

    // ── 1. call_logs ─────────────────────────────────────────────────────
    /* Durées (fix 15/07) — trois vérités, jamais mélangées :
       · durationSec       = CONVERSATION (0 si non décroché)
       · totalDurationSec  = totale, sonnerie incluse
       Sources par ordre de fiabilité : champs du payload s'ils existent,
       sinon calcul depuis nos propres timestamps (answeredAt/initiatedAt).
       Un HANGUP sans answeredAt ni champ payload N'ÉCRIT PAS durationSec :
       le record_available (aftercall) ou le cron trancheront — on ne pose
       jamais un 0 sur un appel potentiellement décroché.
       Webhooks 2.0 : duration_in_seconds = durée TOTALE (candidat totalP
       uniquement — jamais en conversation, sous peine de recompter les
       répondeurs comme décrochés). */
    const numOrNull = v => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n) : null; };
    const clUpdate = { status: mappedStatus, updatedAt: now };
    if (event === 'ANSWERED') clUpdate.answeredAt = now;
    if (isTerminal) {
      clUpdate.endedAt = now;
      const incallP = numOrNull(d.incall_duration) ?? numOrNull(payload.incall_duration)
                   ?? numOrNull(d.duration_secs)   ?? numOrNull(payload.duration_secs)
                   ?? numOrNull(d.talk_duration);
      const totalP  = numOrNull(d.total_duration)  ?? numOrNull(payload.total_duration)
                   ?? numOrNull(d.duration_in_seconds)
                   ?? numOrNull(d.duration)        ?? numOrNull(payload.duration);
      let prevData = null, answeredMs = null, initiatedMs = null;
      try {
        const prev = await withRetry(() => db.collection('call_logs').doc(callId).get(), 'read prev');
        if (prev.exists) {
          prevData = prev.data() || {};
          if (prevData.answeredAt && prevData.answeredAt.toMillis)   answeredMs  = prevData.answeredAt.toMillis();
          if (prevData.initiatedAt && prevData.initiatedAt.toMillis) initiatedMs = prevData.initiatedAt.toMillis();
        }
      } catch (e) { console.warn('[ringover-call-status] read prev:', e.message); }
      const nowMs = Date.now();
      if (event === 'MISSED' || event === 'missed') {
        clUpdate.durationSec = 0;
      } else if (incallP != null) {
        clUpdate.durationSec = incallP;
      } else if (answeredMs != null) {
        clUpdate.durationSec = Math.max(0, Math.round((nowMs - answeredMs) / 1000));
      }
      const totalC = totalP != null ? totalP
        : (initiatedMs != null ? Math.max(0, Math.round((nowMs - initiatedMs) / 1000)) : null);
      if (totalC != null) clUpdate.totalDurationSec = totalC;

      /* Sonnerie (17/08/2026) — indispensable pour ne pas compter une
         messagerie comme un décroché (isAnsweredCall dans funnel-core.js). */
      const ringP = numOrNull(d.ringing_duration) ?? numOrNull(payload.ringing_duration);
      if (ringP != null && ringP >= 0) {
        clUpdate.ringingDurationSec = Math.round(ringP);
      } else if (answeredMs != null && initiatedMs != null && answeredMs >= initiatedMs) {
        clUpdate.ringingDurationSec = Math.round((answeredMs - initiatedMs) / 1000);
      }
      /* Répondeur : amd (ancien) ou answering_machine_detection (2.0).
         Seuls des booléens stricts sont acceptés. */
      const amdP = d.amd !== undefined ? d.amd
        : (d.answering_machine_detection !== undefined ? d.answering_machine_detection : payload.amd);
      if (amdP === true || amdP === false) clUpdate.amd = amdP;
      /* URL d'enregistrement : record (2.0) ou recording_url/recording. */
      const recUrl = (typeof d.record === 'string' && d.record) ? d.record
        : (typeof d.recording_url === 'string' && d.recording_url) ? d.recording_url
        : (d.recording && typeof d.recording === 'object' && d.recording.url) ? d.recording.url
        : (typeof d.recording === 'string' && d.recording) ? d.recording
        : null;
      if (recUrl) { clUpdate.ringoverRecordingUrl = recUrl; clUpdate.recordingStatus = 'available'; }

      /* ── Identité du doc (appels passés HORS dialer) ──
         Un appel lancé par ringover-call-initiate a déjà userId, leadId,
         direction, initiatedAt. Un appel passé depuis l'app Ringover (ou un
         entrant) n'existe qu'ici : sans ces champs il est invisible dans
         l'historique (where userId + orderBy initiatedAt) jusqu'au sync de
         03h30. On ne pose que ce qui MANQUE — jamais d'écrasement. */
      const addPlus = n => n ? (String(n).startsWith('+') ? String(n) : '+' + String(n)) : null;
      if (!prevData || !prevData.providerCallId) { clUpdate.providerCallId = callId; clUpdate.provider = 'ringover'; }
      if (!prevData || !prevData.initiatedAt) {
        clUpdate.initiatedAt = startTimestamp(d) || now;
        if (!prevData) clUpdate.createdAt = now;
      }
      if ((!prevData || !prevData.direction) && d.direction) {
        clUpdate.direction = d.direction === 'out' ? 'outbound' : 'inbound';
      }
      if ((!prevData || !prevData.fromNumber) && d.from_number) clUpdate.fromNumber = addPlus(d.from_number);
      if ((!prevData || !prevData.toNumber)   && d.to_number)   clUpdate.toNumber   = addPlus(d.to_number);
      if (!prevData || !prevData.userId) {
        const ruid = d.user_id != null ? String(d.user_id)
          : (d.user && d.user.user_id != null ? String(d.user.user_id) : null);
        if (ruid) {
          clUpdate.ringoverUserId = ruid;
          const map = await getRingoverUserMap();
          if (map[ruid]) clUpdate.userId = map[ruid];
        }
        if (d.user && d.user.firstname && (!prevData || !prevData.userName)) {
          clUpdate.userName = d.user.firstname;
        }
      }
    }
    /* await obligatoire : sans lui, l'écriture court après la réponse et
       Vercel la coupe. C'était la source des statuts d'appel manquants. */
    try {
      await withRetry(() => db.collection('call_logs').doc(callId).set(clUpdate, { merge: true }), 'call_logs');
    } catch (e) {
      console.warn('[ringover-call-status] call_logs:', e.message);
    }

    // ── 2. dialer_campaigns ───────────────────────────────────────────────
    try {
      const campSnap = await withRetry(() => db.collection('dialer_campaigns')
        .where('provider', '==', 'ringover')
        .where('status', 'in', ['dialing', 'connected'])
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(), 'campaign query');

      for (const campDoc of campSnap.docs) {
        const camp = campDoc.data();
        const legs = camp.legs || [];
        const idx  = legs.findIndex(l => l.callId === callId || l.callSid === callId);
        if (idx === -1) continue;

        const upd = { updatedAt: now };
        const updLegs = legs.map(l => Object.assign({}, l));

        if (event === 'ANSWERED') {
          upd.status          = 'connected';
          upd.connectedCallId  = callId;
          upd.connectedCallSid = callId;
          upd.connectedLeadId  = legs[idx].leadId || null;
          upd.connectedAt      = now;
          updLegs[idx].status  = 'in-progress';
        }
        if (isTerminal) {
          if (camp.connectedCallId === callId || !camp.connectedCallId) {
            upd.status = 'ended'; upd.endedAt = now;
          }
          updLegs[idx].status = event === 'MISSED' ? 'no-answer' : 'completed';
          const leadId = legs[idx].leadId;
          if (leadId) {
            /* await : l'incrément des tentatives se perdait après la réponse. */
            try {
              await withRetry(() => db.collection('leads').doc(leadId).update({
                dialer_attempts:    admin.firestore.FieldValue.increment(1),
                dialer_last_attempt: now,
                dialer_last_status:  mappedStatus,
              }), 'dialer_attempts');
            } catch (e) {
              console.warn('[ringover-call-status] dialer_attempts', leadId, e.message);
            }
          }
        }
        upd.legs = updLegs;
        await withRetry(() => campDoc.ref.update(upd), 'campaign update');
        console.log('[ringover-call-status] campaign', campDoc.id, '→', upd.status || camp.status);
        break;
      }
    } catch (e) {
      console.warn('[ringover-call-status] campaign update:', e.message);
    }

    // ── 3. Recording pipeline (si URL dans le HANGUP) ─────────────────────
    if (isTerminal) {
      const recUrl2 = (typeof d.record === 'string' && d.record) ? d.record
        : (typeof d.recording_url === 'string' && d.recording_url) ? d.recording_url
        : (typeof d.recording === 'string' && d.recording) ? d.recording
        : null;
      if (recUrl2) {
        /* await : c'est CE document qui déclenche tout le pipeline
           enregistrement → transcription → analyse. Perdu après la réponse,
           l'appel n'était jamais transcrit, sans aucune trace d'erreur. */
        try {
          await withRetry(() => db.collection('webhook_inbox').add({
            source: 'ringover_recording_ready', payload,
            callId, recordingUrl: recUrl2,
            receivedAt: now, processed: false,
          }), 'webhook_inbox');
        } catch (e) {
          console.warn('[ringover-call-status] webhook_inbox:', e.message);
        }
      }
    }
    res.status(200).end();
  } catch (err) {
    console.error('[ringover-call-status] error:', err.message, err.stack);
    // 200 malgré l'erreur : Ringover rejouerait indéfiniment sinon.
    res.status(200).end();
  }
};
