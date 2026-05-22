// api/ringover-aftercall.js
// Gère les webhooks Ringover "aftercall" :
//   - record_available        → stocke record_link dans call_logs
//   - transcription_available → récupère la transcription via GET /transcriptions/{callId}
//   - summary_available       → stocke le résumé Empower dans call_logs
//
// À configurer dans Ringover Dashboard → Webhooks → section After-call
// URL : https://team.alteore.com/api/ringover-aftercall

const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).end(); // Répondre immédiatement à Ringover

  try {
    const payload = req.body || {};
    const event   = (payload.event || '').toLowerCase(); // record_available | transcription_available | summary_available
    const d       = payload.data || {};
    const callId  = d.call_id ? String(d.call_id) : null;

    console.log('[ringover-aftercall]', event, 'callId:', callId);

    if (!callId || callId === '0') {
      console.warn('[ringover-aftercall] No callId in payload');
      return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ── record_available ────────────────────────────────────────────────────
    if (event === 'record_available') {
      const recordLink     = d.record_link || null;
      const recordDuration = d.record_duration || null;

      if (recordLink) {
        await db.collection('call_logs').doc(callId).set({
          ringoverRecordingUrl: recordLink,
          durationFormatted:    recordDuration || null,
          recordingStatus:      'available',
          updatedAt:            now,
        }, { merge: true });
        console.log('[ringover-aftercall] record stored:', callId, recordLink);
      }
      return;
    }

    // ── transcription_available ─────────────────────────────────────────────
    if (event === 'transcription_available') {
      const transcriptionUrl = d.transcription_url || null;

      // Tenter de récupérer la transcription via l'API Ringover
      let transcriptText = null;
      let speeches       = null;
      try {
        const resp = await ringoverFetch(`/transcriptions/${callId}`);
        // resp = tableau de transcription_list items
        const items = Array.isArray(resp) ? resp : (resp ? [resp] : []);
        if (items.length > 0) {
          const item = items[0];
          transcriptText = item?.transcription_data?.text || null;
          speeches       = item?.transcription_data?.speeches || null;
        }
        console.log('[ringover-aftercall] transcription fetched for', callId,
          '— chars:', transcriptText?.length || 0);
      } catch (e) {
        console.warn('[ringover-aftercall] GET /transcriptions failed:', e.message);
        // fallback : stocker juste l'URL
      }

      await db.collection('call_logs').doc(callId).set({
        transcriptionStatus:  'done',
        transcriptText:       transcriptText || null,
        transcriptSpeeches:   speeches || null,
        transcriptionUrl:     transcriptionUrl || null,
        transcribedAt:        now,
        updatedAt:            now,
      }, { merge: true });

      // Si transcription dispo → lancer l'analyse Claude
      if (transcriptText) {
        // Écrire dans webhook_inbox pour déclencher l'analyse IA
        // (le handler ~/index.js traitera ça comme une analyse post-call)
        await db.collection('webhook_inbox').add({
          source:        'ringover_transcript_ready',
          callId,
          transcriptText,
          speeches,
          receivedAt:    now,
          processed:     false,
        });
      }
      return;
    }

    // ── summary_available (Empower) ─────────────────────────────────────────
    if (event === 'summary_available') {
      const summary    = d.summary || null;
      const channelId  = d.channel_id ? String(d.channel_id) : null;

      if (summary) {
        await db.collection('call_logs').doc(callId).set({
          aiSummary:        summary,
          aiAnalysisStatus: 'done',
          aiAnalyzedAt:     now,
          updatedAt:        now,
        }, { merge: true });
        console.log('[ringover-aftercall] summary stored for', callId);
      }
      return;
    }

    // ── empower (summary + transcription combinés) ──────────────────────────
    if (event === 'empower') {
      await db.collection('call_logs').doc(callId).set({
        empowerPayload:   d,
        aiAnalysisStatus: 'done',
        updatedAt:        now,
      }, { merge: true });
      return;
    }

    console.log('[ringover-aftercall] Unknown event ignored:', event);
  } catch (err) {
    console.error('[ringover-aftercall] error:', err.message);
  }
};
