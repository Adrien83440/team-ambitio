// api/ringover-aftercall.js  (v2 — écritures Firestore AVANT res.end)
const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Écriture Firestore AVANT de répondre (évite que Vercel kill la fonction)
  try {
    const payload = req.body || {};
    const event   = (payload.event || '').toLowerCase();
    const d       = payload.data || {};
    const callId  = d.call_id ? String(d.call_id) : null;

    console.log('[aftercall] event:', event, 'callId:', callId);

    if (!callId || callId === '0') {
      console.warn('[aftercall] No callId');
      res.status(200).end();
      return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('call_logs').doc(callId);

    // ── record_available ────────────────────────────────────────────────────
    if (event === 'record_available') {
      const recordLink = d.record_link || null;
      if (recordLink) {
        await ref.set({
          ringoverRecordingUrl: recordLink,
          recordingStatus:      'available',
          durationFormatted:    d.record_duration || null,
          updatedAt:            now,
        }, { merge: true });
        console.log('[aftercall] ✓ record stored:', callId, recordLink.substring(0,60));
      } else {
        console.warn('[aftercall] record_available sans record_link');
      }
      res.status(200).end();
      return;
    }

    // ── transcription_available ─────────────────────────────────────────────
    if (event === 'transcription_available') {
      const transcriptionUrl = d.transcription_url || null;
      let transcriptText  = null;
      let speeches        = null;

      // Fetch transcription via API Ringover
      try {
        const tr    = await ringoverFetch(`/transcriptions/${callId}`);
        const items = Array.isArray(tr) ? tr : (tr ? [tr] : []);
        if (items.length > 0 && items[0]?.transcription_data) {
          const td = items[0].transcription_data;
          transcriptText = td.text     || null;
          speeches       = td.speeches || null;
          console.log('[aftercall] transcription fetched, chars:', transcriptText?.length || 0);
        }
      } catch (e) {
        console.warn('[aftercall] GET /transcriptions failed:', e.message);
      }

      await ref.set({
        transcriptionStatus:  'done',
        transcriptText:       transcriptText || null,
        transcriptSpeeches:   speeches       || null,
        transcriptionUrl:     transcriptionUrl || null,
        transcribedAt:        now,
        updatedAt:            now,
      }, { merge: true });
      console.log('[aftercall] ✓ transcription stored:', callId, 'text:', !!transcriptText);

      // Déclencher analyse IA si transcription dispo
      if (transcriptText) {
        db.collection('webhook_inbox').add({
          source:        'ringover_transcript_ready',
          callId, transcriptText, speeches,
          receivedAt:    now, processed: false,
        }).catch(() => {});
      }
      res.status(200).end();
      return;
    }

    // ── summary_available ───────────────────────────────────────────────────
    if (event === 'summary_available') {
      const summary = d.summary || null;
      if (summary) {
        await ref.set({
          aiSummary:        summary,
          aiAnalysisStatus: 'done',
          aiAnalyzedAt:     now,
          updatedAt:        now,
        }, { merge: true });
        console.log('[aftercall] ✓ summary stored:', callId, summary.substring(0,80));
      }
      res.status(200).end();
      return;
    }

    // ── empower ──────────────────────────────────────────────────────────────
    if (event === 'empower') {
      await ref.set({
        empowerPayload:   d,
        aiAnalysisStatus: 'done',
        updatedAt:        now,
      }, { merge: true });
      console.log('[aftercall] ✓ empower stored:', callId);
      res.status(200).end();
      return;
    }

    console.log('[aftercall] event ignoré:', event);
    res.status(200).end();

  } catch (err) {
    console.error('[aftercall] FATAL:', err.code || err.message);
    res.status(200).end();
  }
};
