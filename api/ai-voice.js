// ============================================================================
// api/ai-voice.js — VOIX DE « DEMANDE À ALTEORE » (ElevenLabs, Lot 5) — admins
// ----------------------------------------------------------------------------
// POST Bearer <ID token admin>
//   { action:'tts', text, voiceId? } → { ok, audio: base64 mp3 }
//   { action:'stt', audio: base64, mime } → { ok, text }   (Scribe, français)
//   { action:'voices' } → les 3 voix proposées + la voix choisie
// Variable Vercel requise : ELEVENLABS_API_KEY.
// Voix par défaut : _config/ai.voiceId (sinon Koraly). Les voix de la Voice
// Library doivent être ajoutées à « My Voices » du compte ElevenLabs.
// Coût : facturé sur le compte ElevenLabs (caractères / minutes), hors budget
// Claude de _config/ai.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { getAiConfig } = require('./_ai');

const XI = 'https://api.elevenlabs.io/v1';
const VOICES = [
  { id: 'F1toM6PcP54s45kOOAyV', name: 'Koraly', desc: 'Féminine, parisienne, expressive et chaleureuse' },
  { id: 'kENkNtk0xyzG09WW40xE', name: 'Marcel', desc: 'Masculine, naturelle, « le gars d\'à côté »' },
  { id: 'BVBq6HVJVdnwOMJOqvy9', name: 'Nova', desc: 'Masculine, grave, posée et proche' },
];

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  const key = process.env.ELEVENLABS_API_KEY;
  const cfg = await getAiConfig();
  const defVoice = cfg.voiceId || VOICES[0].id;

  try {
    if (body.action === 'voices') { res.status(200).json({ ok: true, voices: VOICES, current: defVoice, configured: !!key }); return; }
    if (!key) { res.status(200).json({ ok: false, error: 'elevenlabs_not_configured', message: 'Clé ElevenLabs absente (ELEVENLABS_API_KEY sur Vercel).' }); return; }

    if (body.action === 'tts') {
      const text = String(body.text || '').trim().slice(0, 2500);
      if (!text) { res.status(400).json({ ok: false, error: 'empty' }); return; }
      const voice = /^[A-Za-z0-9]{10,40}$/.test(body.voiceId || '') ? body.voiceId : defVoice;
      const r = await fetch(XI + '/text-to-speech/' + voice + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text: text, model_id: 'eleven_flash_v2_5', language_code: 'fr', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
      });
      if (!r.ok) { const t = await r.text().catch(function () { return ''; }); res.status(200).json({ ok: false, error: 'tts_' + r.status, message: 'Synthèse vocale impossible : ' + t.slice(0, 200) }); return; }
      const buf = Buffer.from(await r.arrayBuffer());
      res.status(200).json({ ok: true, audio: buf.toString('base64'), mime: 'audio/mpeg' });
      return;
    }

    if (body.action === 'stt') {
      const b64 = String(body.audio || '');
      if (!b64 || b64.length > 6000000) { res.status(400).json({ ok: false, error: 'bad_audio' }); return; }
      const mime = /^audio\/[a-z0-9.+-]+/i.test(body.mime || '') ? String(body.mime).split(';')[0] : 'audio/webm';
      const fd = new FormData();
      fd.append('model_id', 'scribe_v1');
      fd.append('language_code', 'fra');
      fd.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime }), 'question.' + (mime.split('/')[1] || 'webm'));
      const r = await fetch(XI + '/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd });
      const j = await r.json().catch(function () { return null; });
      if (!r.ok || !j) { res.status(200).json({ ok: false, error: 'stt_' + r.status, message: 'Transcription impossible' }); return; }
      res.status(200).json({ ok: true, text: String(j.text || '').trim() });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[ai-voice]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
