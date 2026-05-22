// api/ringover-call-status.js  (v3 — direct processing, correct payload parsing)
// Ringover webhook format : { event, timestamp, data: { id, from_number, to_number, ... } }

const { db, admin } = require('./_firebaseAdmin');

let _webhookKey = null;
async function getWebhookKey() {
  if (_webhookKey) return _webhookKey;
  try {
    const snap = await db.collection('_config').doc('telco_credentials').get();
    if (snap.exists) _webhookKey = ((snap.data().ringover) || {}).webhookKey || null;
  } catch (_) {}
  return _webhookKey;
}

const STATUS_MAP = {
  RINGING: 'ringing', ANSWERED: 'in-progress', HANGUP: 'completed', MISSED: 'no-answer',
  ringing: 'ringing', answered: 'in-progress', hangup: 'completed', missed: 'no-answer',
};
const TERMINAL = new Set(['HANGUP', 'MISSED', 'hangup', 'missed']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Vérif clé webhook (optionnelle — ne bloque pas si pas configurée)
  const expectedKey = await getWebhookKey().catch(() => null);
  if (expectedKey) {
    const sentKey = req.headers['authorization'] || req.headers['x-ringover-token'] || '';
    if (sentKey !== expectedKey && `Bearer ${expectedKey}` !== sentKey) {
      console.warn('[ringover-call-status] Invalid webhook key');
      return res.status(401).end();
    }
  }

  res.status(200).end(); // Répondre immédiatement à Ringover

  try {
    const payload = req.body || {};

    // ── Parsing payload Ringover ──────────────────────────────────────────
    // Format Ringover : { event: "RINGING", timestamp: 123, data: { id: "xxx", ... } }
    const event  = (payload.event || '').toUpperCase();
    const d      = payload.data || {};                          // nested data
    const callId = d.id || d.call_id || payload.call_id || null;

    console.log('[ringover-call-status]', event, callId);

    if (!callId) {
      console.warn('[ringover-call-status] No callId. Raw payload keys:', Object.keys(payload), 'data keys:', Object.keys(d));
      return;
    }

    const mappedStatus = STATUS_MAP[event] || event.toLowerCase();
    const isTerminal   = TERMINAL.has(event);
    const now          = admin.firestore.FieldValue.serverTimestamp();

    // ── 1. call_logs ─────────────────────────────────────────────────────
    const clUpdate = { status: mappedStatus, updatedAt: now };
    if (event === 'ANSWERED') clUpdate.answeredAt = now;
    if (isTerminal) {
      clUpdate.endedAt = now;
      const dur = d.duration_secs || d.duration || payload.duration || null;
      if (dur !== null) clUpdate.durationSec = Number(dur);
      const recUrl = d.recording_url || d.recording
        || (d.recording && typeof d.recording === 'object' ? d.recording.url : null)
        || null;
      if (recUrl) { clUpdate.ringoverRecordingUrl = recUrl; clUpdate.recordingStatus = 'available'; }
    }
    db.collection('call_logs').doc(callId).set(clUpdate, { merge: true })
      .catch(e => console.warn('[ringover-call-status] call_logs:', e.message));

    // ── 2. dialer_campaigns ───────────────────────────────────────────────
    try {
      const campSnap = await db.collection('dialer_campaigns')
        .where('provider', '==', 'ringover')
        .where('status', 'in', ['dialing', 'connected'])
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

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
            db.collection('leads').doc(leadId).update({
              dialer_attempts:    admin.firestore.FieldValue.increment(1),
              dialer_last_attempt: now,
              dialer_last_status:  mappedStatus,
            }).catch(() => {});
          }
        }
        upd.legs = updLegs;
        await campDoc.ref.update(upd);
        console.log('[ringover-call-status] campaign', campDoc.id, '→', upd.status || camp.status);
        break;
      }
    } catch (e) {
      console.warn('[ringover-call-status] campaign update:', e.message);
    }

    // ── 3. Recording pipeline (si URL dans le HANGUP) ─────────────────────
    if (isTerminal) {
      const recUrl = d.recording_url || d.recording || null;
      if (recUrl && typeof recUrl === 'string') {
        db.collection('webhook_inbox').add({
          source: 'ringover_recording_ready', payload,
          callId, recordingUrl: recUrl,
          receivedAt: now, processed: false,
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[ringover-call-status] error:', err.message);
  }
};
