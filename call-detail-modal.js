/* ============================================================================
 * call-detail-modal.js
 * ----------------------------------------------------------------------------
 * Modal partagé affichant le détail d'un appel :
 *   - lecteur audio (URL signée Firebase Storage)
 *   - transcription Whisper
 *   - synthèse IA (interestLevel, objections, nextSteps, summary...)
 *
 * Dépendances :
 *   - firebase (app, auth) déjà initialisé globalement (compat SDK)
 *   - call-detail-modal.css chargé
 *
 * Usage :
 *   await window.CallDetailModal.open('CA1234abcd...');
 *
 * Le modal s'injecte tout seul dans le DOM à la première ouverture. Il fetch
 * /api/call-detail avec l'idToken Firebase, affiche un spinner pendant le
 * chargement, puis rend les sections disponibles (certaines peuvent être
 * encore "processing" si le pipeline n'est pas terminé).
 * ============================================================================ */

(function () {
  'use strict';

  let modalBg = null;
  let currentCallLogId = null;

  // ─── DOM injection ────────────────────────────────────────────────────────
  function ensureModal() {
    if (modalBg) return modalBg;
    modalBg = document.createElement('div');
    modalBg.className = 'cdm-bg';
    modalBg.innerHTML = `
      <div class="cdm-panel">
        <div class="cdm-head">
          <div class="cdm-head-icon" id="cdmHeadIcon">📞</div>
          <div class="cdm-head-meta">
            <div class="cdm-head-name" id="cdmHeadName">Chargement…</div>
            <div class="cdm-head-sub" id="cdmHeadSub"></div>
          </div>
          <button class="cdm-close" id="cdmClose" aria-label="Fermer">✕</button>
        </div>
        <div class="cdm-body" id="cdmBody">
          <div class="cdm-loading">
            <div class="cdm-spinner"></div>
            <div>Chargement de l'appel…</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalBg);

    // Close handlers
    modalBg.addEventListener('click', function (e) {
      if (e.target === modalBg) closeModal();
    });
    modalBg.querySelector('#cdmClose').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalBg.classList.contains('open')) closeModal();
    });

    return modalBg;
  }

  function closeModal() {
    if (!modalBg) return;
    // Stop audio playback on close
    const audio = modalBg.querySelector('audio');
    if (audio) { try { audio.pause(); } catch (_) {} }
    modalBg.classList.remove('open');
    currentCallLogId = null;
  }

  // ─── Auth helper (idToken Firebase) ────────────────────────────────────────
  async function getIdToken() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase Auth non disponible');
    }
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Utilisateur non authentifié');
    return user.getIdToken();
  }

  async function fetchCallDetail(callLogId) {
    const token = await getIdToken();
    const res = await fetch('/api/call-detail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ callLogId }),
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return res.json();
  }

  // ─── Formatters ────────────────────────────────────────────────────────────
  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + 'm' + (s ? String(s).padStart(2, '0') + 's' : '');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString('fr-FR', {
        weekday: 'short', day: '2-digit', month: 'long',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return iso; }
  }

  function interestClass(level) {
    if (level == null) return '';
    if (level <= 3) return 'low';
    if (level <= 6) return 'mid';
    return 'high';
  }

  function statusPill(status) {
    const label = {
      pending: 'En attente',
      processing: 'En cours',
      available: 'Prêt',
      failed: 'Échec',
    }[status] || status || 'pending';
    return `<span class="cdm-status-pill ${status || 'pending'}">${label}</span>`;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────
  function render(detail) {
    const head = modalBg.querySelector('.cdm-head');
    const body = modalBg.querySelector('#cdmBody');
    const icon = modalBg.querySelector('#cdmHeadIcon');
    const name = modalBg.querySelector('#cdmHeadName');
    const sub = modalBg.querySelector('#cdmHeadSub');

    // Header
    const isMissed = ['no-answer', 'busy', 'failed', 'canceled'].indexOf(detail.status) >= 0;
    icon.className = 'cdm-head-icon' + (isMissed ? ' miss' : '');
    icon.textContent = detail.direction === 'outbound'
      ? (isMissed ? '✕' : '↗')
      : (isMissed ? '✕' : '↙');

    const displayName = detail.leadNameSnapshot
      || (detail.direction === 'outbound' ? detail.toNumber : detail.fromNumber)
      || 'Appel';
    name.textContent = displayName;

    const parts = [];
    if (detail.initiatedAt) parts.push(formatDate(detail.initiatedAt));
    if (detail.durationSec) parts.push(formatDuration(detail.durationSec));
    if (detail.userName) parts.push(detail.userName);
    sub.textContent = parts.join(' · ');

    // Body
    let h = '';

    // — Recording player
    h += '<div class="cdm-section">';
    h += '<div class="cdm-section-title">🎙 Enregistrement ' + statusPill(detail.recordingStatus) + '</div>';
    if (detail.recordingSignedUrl) {
      h += '<div class="cdm-audio-wrap">';
      h += '<audio controls preload="metadata" src="' + escHtml(detail.recordingSignedUrl) + '"></audio>';
      h += '</div>';
    } else if (detail.recordingStatus === 'processing') {
      h += '<div class="cdm-audio-empty">Traitement en cours…</div>';
    } else if (detail.recordingStatus === 'failed') {
      h += '<div class="cdm-audio-empty">Échec du téléchargement de l\'enregistrement</div>';
    } else {
      h += '<div class="cdm-audio-empty">Pas d\'enregistrement disponible</div>';
    }
    h += '</div>';

    // — Transcription
    h += '<div class="cdm-section">';
    h += '<div class="cdm-section-title">📄 Transcription ' + statusPill(detail.transcriptionStatus) + '</div>';
    if (detail.transcriptionText) {
      h += '<div class="cdm-transcript">' + escHtml(detail.transcriptionText) + '</div>';
    } else if (detail.transcriptionStatus === 'processing') {
      h += '<div class="cdm-audio-empty">Transcription en cours (Whisper)…</div>';
    } else if (detail.transcriptionStatus === 'failed') {
      h += '<div class="cdm-audio-empty">Échec de la transcription</div>';
    } else {
      h += '<div class="cdm-audio-empty">Pas de transcription disponible</div>';
    }
    h += '</div>';

    // — AI Analysis
    h += '<div class="cdm-section">';
    h += '<div class="cdm-section-title">🤖 Analyse IA ' + statusPill(detail.aiAnalysisStatus) + '</div>';
    const a = detail.aiAnalysis;
    if (a && a.summary) {
      h += '<div class="cdm-ai-grid">';

      if (typeof a.interestLevel === 'number') {
        h += '<div class="cdm-interest-wrap">';
        h += '<div class="cdm-interest-label">Niveau d\'intérêt du prospect</div>';
        h += '<div class="cdm-interest-badge ' + interestClass(a.interestLevel) + '">' + a.interestLevel + '/10</div>';
        h += '</div>';
      }

      if (a.summary) {
        h += '<div class="cdm-summary">' + escHtml(a.summary) + '</div>';
      }

      if (Array.isArray(a.objections) && a.objections.length) {
        h += '<div class="cdm-section-title" style="margin-top:6px">⚠️ Objections</div>';
        h += '<div class="cdm-list">';
        a.objections.forEach(function (o) {
          h += '<div class="cdm-list-item">' + escHtml(o) + '</div>';
        });
        h += '</div>';
      }

      if (Array.isArray(a.nextSteps) && a.nextSteps.length) {
        h += '<div class="cdm-section-title" style="margin-top:6px">🎯 Prochaines étapes</div>';
        h += '<div class="cdm-list">';
        a.nextSteps.forEach(function (s) {
          h += '<div class="cdm-list-item">' + escHtml(s) + '</div>';
        });
        h += '</div>';
      }

      if (Array.isArray(a.suggestedFollowUps) && a.suggestedFollowUps.length) {
        h += '<div class="cdm-section-title" style="margin-top:6px">💡 Suggestions de relance</div>';
        h += '<div class="cdm-list">';
        a.suggestedFollowUps.forEach(function (s) {
          h += '<div class="cdm-list-item">' + escHtml(s) + '</div>';
        });
        h += '</div>';
      }

      h += '</div>';
    } else if (detail.aiAnalysisStatus === 'processing') {
      h += '<div class="cdm-audio-empty">Analyse en cours (Claude)…</div>';
    } else if (detail.aiAnalysisStatus === 'failed') {
      h += '<div class="cdm-audio-empty">Échec de l\'analyse IA</div>';
    } else {
      h += '<div class="cdm-audio-empty">Pas d\'analyse disponible</div>';
    }
    h += '</div>';

    body.innerHTML = h;
  }

  function renderError(message) {
    const body = modalBg.querySelector('#cdmBody');
    const name = modalBg.querySelector('#cdmHeadName');
    name.textContent = 'Erreur';
    body.innerHTML = '<div class="cdm-error">❌ ' + escHtml(message) + '</div>';
  }

  function renderLoading() {
    const body = modalBg.querySelector('#cdmBody');
    const name = modalBg.querySelector('#cdmHeadName');
    const sub = modalBg.querySelector('#cdmHeadSub');
    name.textContent = 'Chargement…';
    sub.textContent = '';
    body.innerHTML =
      '<div class="cdm-loading"><div class="cdm-spinner"></div><div>Chargement de l\'appel…</div></div>';
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  async function open(callLogId) {
    if (!callLogId) {
      console.warn('[CallDetailModal] open() called without callLogId');
      return;
    }
    ensureModal();
    currentCallLogId = callLogId;
    renderLoading();
    modalBg.classList.add('open');

    try {
      const detail = await fetchCallDetail(callLogId);
      // Évite de rendre si l'utilisateur a fermé entre-temps
      if (currentCallLogId !== callLogId) return;
      render(detail);
    } catch (err) {
      console.error('[CallDetailModal]', err);
      if (currentCallLogId !== callLogId) return;
      renderError(err.message || 'Impossible de charger l\'appel');
    }
  }

  window.CallDetailModal = { open: open, close: closeModal };
})();
