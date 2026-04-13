// ============================================================================
// Functions/pipelines/callAnalysisPipeline.js
// ----------------------------------------------------------------------------
// Pipeline complet post-appel, déclenché quand Twilio notifie qu'un
// enregistrement est prêt. Séquence :
//
//   1. Download MP3 depuis Twilio (auth HTTP Basic)
//   2. Upload dans Firebase Storage → call_recordings/{yyyy-mm}/{callSid}.mp3
//   3. Update call_logs.recordingUrl + recordingStatus = "available"
//   4. Transcription Whisper (OpenAI API, modèle whisper-1, langue FR)
//   5. Update call_logs.transcriptionText + transcriptionStatus
//   6. Analyse Claude (Anthropic API, claude-sonnet-4-6) avec contexte lead
//   7. Update call_logs.aiAnalysis + aiAnalysisStatus
//
// Chaque étape est idempotente et les statuts intermédiaires sont persistés
// pour que le frontend puisse afficher l'état en cours.
// ============================================================================

const admin = require('firebase-admin');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const Anthropic = require('@anthropic-ai/sdk');
const twilioProvider = require('../telcoProviders/twilioProvider');

// Caches niveau module
let _openaiClient = null;
let _anthropicClient = null;
let _aiCreds = null;

// ============================================================================
// Chargement des credentials IA (avec cache)
// ============================================================================

async function loadAiCreds(db) {
  if (_aiCreds) return _aiCreds;

  const snap = await db.collection('_config').doc('ai_credentials').get();
  if (!snap.exists) {
    throw new Error('_config/ai_credentials document not found');
  }

  const data = snap.data();
  if (!data.openai || !data.openai.apiKey) {
    throw new Error('ai_credentials missing openai.apiKey');
  }
  if (!data.anthropic || !data.anthropic.apiKey) {
    throw new Error('ai_credentials missing anthropic.apiKey');
  }

  _aiCreds = data;
  return data;
}

async function getOpenAI(db) {
  if (_openaiClient) return _openaiClient;
  const creds = await loadAiCreds(db);
  _openaiClient = new OpenAI({ apiKey: creds.openai.apiKey });
  return _openaiClient;
}

async function getAnthropic(db) {
  if (_anthropicClient) return _anthropicClient;
  const creds = await loadAiCreds(db);
  _anthropicClient = new Anthropic({ apiKey: creds.anthropic.apiKey });
  return _anthropicClient;
}

// ============================================================================
// Étape 1-2 : Download Twilio + Upload Firebase Storage
// ============================================================================

async function downloadAndStoreRecording(db, storage, callSid, recordingSid) {
  // 1. Download depuis Twilio
  const buffer = await twilioProvider.downloadRecording(db, recordingSid);

  // 2. Détermine le chemin de stockage
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const storagePath = `call_recordings/${yyyy}-${mm}/${callSid}.mp3`;

  // 3. Upload dans le bucket par défaut
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType: 'audio/mpeg',
    metadata: {
      metadata: {
        callSid,
        recordingSid,
        uploadedAt: now.toISOString(),
        source: 'twilio',
      },
    },
  });

  return {
    storagePath,
    gsUri: `gs://${bucket.name}/${storagePath}`,
    buffer, // Réutilisé à l'étape 3 sans re-download
  };
}

// ============================================================================
// Étape 3 : Transcription Whisper
// ============================================================================

async function transcribeWithWhisper(db, buffer, callSid) {
  const openai = await getOpenAI(db);
  const creds = await loadAiCreds(db);

  // Whisper API limite à 25MB par fichier
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB > 24) {
    throw new Error(
      `Recording too large for Whisper API: ${sizeMB.toFixed(1)}MB > 24MB limit`
    );
  }

  // Convertit le Buffer en File-like objet pour l'API OpenAI
  const file = await toFile(buffer, `${callSid}.mp3`, { type: 'audio/mpeg' });

  const response = await openai.audio.transcriptions.create({
    file,
    model: creds.openai.whisperModel || 'whisper-1',
    language: 'fr',
    response_format: 'verbose_json',
  });

  return {
    text: response.text || '',
    language: response.language || 'fr',
    duration: response.duration || null,
    segments: response.segments || [],
  };
}

// ============================================================================
// Étape 4 : Analyse Claude
// ============================================================================

async function analyzeWithClaude(db, transcriptionText, leadContext, callDurationSec) {
  const anthropic = await getAnthropic(db);
  const creds = await loadAiCreds(db);
  const model = creds.anthropic.analysisModel || 'claude-sonnet-4-6';

  const contextBlock = leadContext
    ? `Contexte du lead :
- Nom : ${leadContext.name || 'Inconnu'}
- Source : ${leadContext.source || 'Inconnue'}
- Stage pipeline : ${leadContext.pipelineStage || 'Inconnu'}
- Tags : ${(leadContext.tags || []).join(', ') || 'Aucun'}
- Notes précédentes : ${leadContext.notes || 'Aucune'}`
    : 'Contexte du lead : Non disponible';

  const durationLabel = callDurationSec
    ? `${Math.floor(callDurationSec / 60)}min ${callDurationSec % 60}s`
    : 'Inconnue';

  const systemPrompt = `Tu es un assistant d'analyse d'appels commerciaux pour une équipe sales B2B française (Ambitio). Tu analyses les transcriptions d'appels entre un closer et un prospect, et tu produis une analyse structurée en JSON strict qui sera stockée dans le CRM.

Ton rôle est d'aider le closer à progresser et à préparer la suite. Sois factuel, concis, et actionnable. Tu peux utiliser le tutoiement dans les suggestions (l'équipe se tutoie).`;

  const userPrompt = `${contextBlock}

Durée de l'appel : ${durationLabel}

Transcription de l'appel :
"""
${transcriptionText}
"""

Analyse cet appel et retourne UNIQUEMENT un objet JSON valide (pas de texte avant ou après, pas de markdown, pas de backticks) avec exactement cette structure :

{
  "interestLevel": <nombre entier entre 1 et 10, évaluation honnête de l'intérêt du prospect>,
  "objections": [<liste des objections soulevées par le prospect, chaque objection en une courte phrase>],
  "nextSteps": [<liste des prochaines étapes mentionnées pendant l'appel ou logiques à prévoir, chacune en une phrase actionnable>],
  "summary": "<résumé factuel de l'appel en 2-3 phrases maximum>",
  "suggestedFollowUps": [<2 à 3 suggestions concrètes pour le closer sur la suite à donner, chacune en une phrase>]
}`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Extrait le texte depuis la réponse (Claude renvoie un tableau de blocs content)
  const textContent = (response.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  if (!textContent) {
    throw new Error('Claude returned empty response');
  }

  // Parse le JSON (avec nettoyage défensif si Claude wrap en ```json)
  let analysis;
  try {
    const cleaned = textContent
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    analysis = JSON.parse(cleaned);
  } catch (err) {
    console.error(
      '[callAnalysisPipeline] Failed to parse Claude response:',
      textContent.substring(0, 500)
    );
    throw new Error('Claude returned invalid JSON: ' + (err.message || err));
  }

  // Validation du shape minimum
  if (
    typeof analysis.interestLevel !== 'number' ||
    !Array.isArray(analysis.objections) ||
    !Array.isArray(analysis.nextSteps) ||
    typeof analysis.summary !== 'string'
  ) {
    throw new Error('Claude response has invalid shape');
  }

  // Clamp interestLevel dans 1-10
  analysis.interestLevel = Math.max(1, Math.min(10, Math.round(analysis.interestLevel)));

  // Normalise les arrays manquants
  analysis.suggestedFollowUps = Array.isArray(analysis.suggestedFollowUps)
    ? analysis.suggestedFollowUps
    : [];

  return analysis;
}

// ============================================================================
// Fetch lead context
// ============================================================================

async function fetchLeadContext(db, leadId) {
  if (!leadId) return null;

  try {
    const snap = await db.collection('leads').doc(leadId).get();
    if (!snap.exists) return null;

    const d = snap.data();
    return {
      name: d.name || d.fullName || d.firstName || null,
      source: d.source || null,
      pipelineStage: d.pipeline || d.stage || d.status || null,
      tags: Array.isArray(d.tags) ? d.tags : [],
      notes: d.notes || d.lastNote || null,
    };
  } catch (err) {
    console.warn('[callAnalysisPipeline] Failed to fetch lead context:', err);
    return null;
  }
}

// ============================================================================
// Pipeline principal
// ============================================================================

/**
 * Exécute le pipeline complet post-appel.
 * Persiste les statuts intermédiaires dans call_logs pour que le frontend
 * puisse afficher l'état en cours.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {import('firebase-admin').storage.Storage} storage
 * @param {string} callSid - SID Twilio de l'appel (= doc ID call_logs)
 * @param {string} recordingSid - SID Twilio de l'enregistrement
 */
async function runFullPipeline(db, storage, callSid, recordingSid) {
  const callLogRef = db.collection('call_logs').doc(callSid);
  const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

  // ------------------------------------------------------------------
  // Étape 1-2 : Download + Storage
  // ------------------------------------------------------------------
  console.log(`[pipeline] ${callSid} — Downloading from Twilio...`);

  let downloadResult;
  try {
    downloadResult = await downloadAndStoreRecording(db, storage, callSid, recordingSid);
  } catch (err) {
    console.error(`[pipeline] ${callSid} — Download/Storage failed:`, err);
    await callLogRef.set(
      {
        recordingStatus: 'failed',
        recordingError: err.message || String(err),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    throw err;
  }

  await callLogRef.set(
    {
      recordingUrl: downloadResult.gsUri,
      recordingStoragePath: downloadResult.storagePath,
      recordingStatus: 'available',
      transcriptionStatus: 'processing',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  console.log(
    `[pipeline] ${callSid} — Audio stored at ${downloadResult.storagePath}, starting Whisper...`
  );

  // ------------------------------------------------------------------
  // Étape 3 : Whisper transcription
  // ------------------------------------------------------------------
  let transcriptionResult;
  try {
    transcriptionResult = await transcribeWithWhisper(db, downloadResult.buffer, callSid);
  } catch (err) {
    console.error(`[pipeline] ${callSid} — Whisper failed:`, err);
    await callLogRef.set(
      {
        transcriptionStatus: 'failed',
        transcriptionError: err.message || String(err),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    throw err;
  }

  await callLogRef.set(
    {
      transcriptionText: transcriptionResult.text,
      transcriptionLanguage: transcriptionResult.language,
      transcriptionStatus: 'available',
      aiAnalysisStatus: 'processing',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  console.log(
    `[pipeline] ${callSid} — Transcription done (${transcriptionResult.text.length} chars), starting Claude...`
  );

  // ------------------------------------------------------------------
  // Étape 4 : Claude analysis
  // ------------------------------------------------------------------
  let analysis;
  try {
    // Récupère le contexte du lead pour enrichir le prompt
    const callLogSnap = await callLogRef.get();
    const callLog = callLogSnap.exists ? callLogSnap.data() : {};
    const leadContext = await fetchLeadContext(db, callLog.leadId);
    const callDurationSec = callLog.durationSec || null;

    analysis = await analyzeWithClaude(
      db,
      transcriptionResult.text,
      leadContext,
      callDurationSec
    );
  } catch (err) {
    console.error(`[pipeline] ${callSid} — Claude analysis failed:`, err);
    await callLogRef.set(
      {
        aiAnalysisStatus: 'failed',
        aiAnalysisError: err.message || String(err),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    throw err;
  }

  await callLogRef.set(
    {
      aiAnalysis: analysis,
      aiAnalysisStatus: 'available',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  // ------------------------------------------------------------------
  // Étape 5 : dual-write dans leads/{leadId}.communications[]
  // Non-bloquant — si ça échoue, le pipeline a quand même réussi.
  // ------------------------------------------------------------------
  try {
    const freshSnap = await callLogRef.get();
    const freshLog = freshSnap.exists ? freshSnap.data() : null;
    if (freshLog) {
      await writeLeadCommunication(db, callSid, freshLog, analysis);
    }
  } catch (err) {
    console.error(`[pipeline] ${callSid} — writeLeadCommunication failed:`, err.message);
  }

  console.log(`[pipeline] ${callSid} — Full pipeline completed successfully.`);
}

// ============================================================================
// Étape 5 : Dual-write dans leads/{leadId}.communications[]
// ----------------------------------------------------------------------------
// Le lead card (sales-leads.html) et le pipeline CRM (sales-crm-app.js) lisent
// leads.communications[] pour afficher l'historique d'appels + SMS. On y pousse
// une entrée compacte contenant callLogId (référence vers call_logs) pour que
// le frontend puisse appeler /api/call-detail au moment de l'affichage.
// ============================================================================

async function writeLeadCommunication(db, callSid, callLog, analysis) {
  if (!callLog.leadId) {
    // Appel non rattaché à un lead (ex: inbound sur un numéro non mappé) — skip
    return;
  }

  // Résout ownerName depuis _meta/team_members via firebaseUid
  let ownerName = null;
  let ownerUid = callLog.userId || null;
  if (ownerUid) {
    try {
      const metaSnap = await db.collection('_meta').doc('team_members').get();
      if (metaSnap.exists) {
        const members = metaSnap.data().members || [];
        const m = members.find(x => x.firebaseUid === ownerUid);
        if (m) ownerName = m.shortName || m.displayName || null;
      }
    } catch (_) { /* non-bloquant */ }
  }

  // Date de l'appel = initiatedAt si dispo, sinon maintenant
  const callDate = callLog.initiatedAt && callLog.initiatedAt.toDate
    ? callLog.initiatedAt.toDate()
    : new Date();
  const isoDate = callDate.toISOString();

  const commEntry = {
    type: 'call',
    direction: callLog.direction || 'outbound',
    content: null,
    duration: callLog.durationSec || null,
    source: 'twilio-dialer',
    date: isoDate,
    createdAt: isoDate,
    ownerUid,
    ownerName,
    // Lien vers call_logs pour le modal détail
    callLogId: callSid,
    hasRecording: !!callLog.recordingStoragePath,
    hasTranscript: !!(analysis && analysis.interestLevel != null),
    hasAiAnalysis: !!(analysis && analysis.summary),
  };

  // Entrée timeline_history (format texte court + couleur)
  const hh = String(callDate.getHours()).padStart(2, '0');
  const mm = String(callDate.getMinutes()).padStart(2, '0');
  const dd = String(callDate.getDate()).padStart(2, '0');
  const mo = String(callDate.getMonth() + 1).padStart(2, '0');
  const durMin = commEntry.duration ? ' [' + Math.floor(commEntry.duration / 60) + 'm]' : '';
  const dirLabel = commEntry.direction === 'outbound' ? 'sortant' : 'entrant';
  const tlText = '📞 Appel ' + dirLabel + ' (Dialer)' + durMin + ' 🎙 📄';
  const timelineEntry = {
    text: tlText,
    date: `${dd}/${mo} ${hh}:${mm}`,
    color: '#34d399',
  };

  try {
    await db.collection('leads').doc(callLog.leadId).update({
      communications: admin.firestore.FieldValue.arrayUnion(commEntry),
      timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
      lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
      lastContactType: 'call',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Non-bloquant : si le lead a été supprimé entre-temps, on log juste.
    console.error(
      `[writeLeadCommunication] Failed to update lead ${callLog.leadId}:`,
      err.message
    );
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  runFullPipeline,
  downloadAndStoreRecording,
  transcribeWithWhisper,
  analyzeWithClaude,
  fetchLeadContext,
  writeLeadCommunication,
};
