/* ═══════════════════════════════════════════════════════════════
   voice-notes.js — Fil de vocaux par lead
   ═══════════════════════════════════════════════════════════════

   API publique :
     window.VoiceNotes.attach(mountEl, leadId, currentUser)
     window.VoiceNotes.detach(mountEl)

   Le module se monte dans un conteneur déjà présent dans le DOM
   (généré par sales-leads.html dans renderCard). Il pose un
   onSnapshot Firestore qui ne reste actif que tant que la card
   est ouverte → pas de listeners orphelins quand on referme.

   Format audio :
     - iOS Safari (iPhone/iPad) → audio/mp4 natif (m4a)
     - Desktop / Android → audio/webm;codecs=opus
     - On stocke le format natif sans conversion, le <audio> de
       lecture sait gérer les deux côté browser.

   Pipeline transcription :
     1. Upload du blob → Firebase Storage voice_notes/{leadId}/
     2. Création du doc Firestore avec transcriptionStatus:'pending'
     3. La Cloud Function onVoiceNoteCreated (trigger Firestore onCreate)
        télécharge le blob, POST Whisper, POST Claude Haiku, met à jour
        le doc avec transcription + summary + transcriptionStatus:'done'
     4. onSnapshot du fil voit l'update en live → re-render automatique

   Limite : 3 minutes max (auto-stop). 5 MB plafond côté Storage rules.
   ═══════════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  if (window.VoiceNotes) return; // déjà chargé

  var MAX_DURATION_SEC = 180;     // 3 minutes

  // État global du module : un seul recorder actif à la fois (on ne peut
  // de toute façon pas avoir deux cards ouvertes — sales-leads.html ferme
  // la précédente avant d'en ouvrir une nouvelle).
  var _activeMounts = {};   // mountId → { unsub, leadId, user, recorder, mediaStream, timerHandle, blobUrls }
  var _mountSeq = 0;

  /* ─── Détection environnement audio ──────────────────────────── */

  function detectMimeType() {
    // Liste ordonnée : on teste ce que MediaRecorder accepte côté plateforme.
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac',
      'audio/ogg;codecs=opus',
      'audio/ogg'
    ];
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      } catch (e) {}
    }
    // Fallback : laisser le browser décider (souvent audio/mp4 sur iOS)
    return '';
  }

  function extFromMime(mime) {
    if (!mime) return 'webm';
    if (mime.indexOf('webm') >= 0) return 'webm';
    if (mime.indexOf('mp4') >= 0) return 'mp4';
    if (mime.indexOf('aac') >= 0) return 'aac';
    if (mime.indexOf('ogg') >= 0) return 'ogg';
    if (mime.indexOf('wav') >= 0) return 'wav';
    return 'webm';
  }

  /* ─── Helpers ─────────────────────────────────────────────────── */

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDuration(sec) {
    if (!sec || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var ms;
    if (ts.toMillis) ms = ts.toMillis();
    else if (ts.seconds) ms = ts.seconds * 1000;
    else if (ts instanceof Date) ms = ts.getTime();
    else if (typeof ts === 'number') ms = ts;
    else return '';
    var diff = Math.floor((Date.now() - ms) / 1000);
    if (diff < 60) return 'à l\'instant';
    if (diff < 3600) return 'il y a ' + Math.floor(diff / 60) + ' min';
    if (diff < 86400) return 'il y a ' + Math.floor(diff / 3600) + ' h';
    if (diff < 604800) return 'il y a ' + Math.floor(diff / 86400) + ' j';
    var d = new Date(ms);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  function newNoteId() {
    return 'vn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* ─── Rendu ──────────────────────────────────────────────────── */

  function renderShell(state) {
    // state ∈ { 'idle', 'requesting', 'recording', 'uploading', 'unsupported', 'denied' }
    var html = '<div class="vn-thread" data-vn-thread></div>';
    html += '<div class="vn-recorder">';

    if (state === 'unsupported') {
      html += '<div class="vn-status vn-status-error">⚠ Votre navigateur ne supporte pas l\'enregistrement audio.</div>';
    } else if (state === 'denied') {
      html += '<div class="vn-status vn-status-error">🎙 Microphone bloqué. Autorise l\'accès dans les paramètres du navigateur puis recharge.</div>';
    } else if (state === 'recording') {
      html += '<div class="vn-rec-active">';
      html += '<div class="vn-rec-pulse"></div>';
      html += '<span class="vn-rec-timer" data-vn-timer>0:00</span>';
      html += '<span class="vn-rec-hint">/ ' + fmtDuration(MAX_DURATION_SEC) + '</span>';
      html += '<button class="vn-btn vn-btn-stop" data-vn-action="stop">■ Arrêter</button>';
      html += '<button class="vn-btn vn-btn-cancel" data-vn-action="cancel">Annuler</button>';
      html += '</div>';
    } else if (state === 'uploading') {
      html += '<div class="vn-rec-uploading"><span class="vn-spinner"></span> Envoi du vocal…</div>';
    } else if (state === 'requesting') {
      html += '<div class="vn-rec-uploading"><span class="vn-spinner"></span> Activation du micro…</div>';
    } else {
      // idle
      html += '<button class="vn-btn vn-btn-record" data-vn-action="record" title="Enregistrer un vocal (max 3 min)">';
      html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
      html += 'Enregistrer un vocal';
      html += '</button>';
      html += '<span class="vn-rec-hint-side">3 min max</span>';
    }
    html += '</div>';
    return html;
  }

  function renderNote(note, currentUser) {
    var n = note.data || {};
    var canDelete = currentUser && (n.authorUid === currentUser.uid || currentUser.role === 'admin');
    var ts = n.createdAt;
    var dateStr = timeAgo(ts);
    var color = n.authorColor || '#6b7280';
    var initials = (n.authorInitials || '?').toUpperCase();
    var name = escHtml(n.authorName || '—');
    var dur = n.durationSec ? fmtDuration(n.durationSec) : '';
    var status = n.transcriptionStatus || 'pending';

    var h = '<div class="vn-item" data-note-id="' + escHtml(note.id) + '">';
    h += '<div class="vn-item-head">';
    h += '<div class="vn-avatar" style="background:linear-gradient(135deg,' + color + ',' + color + 'bb)">' + escHtml(initials) + '</div>';
    h += '<div class="vn-item-meta">';
    h += '<div class="vn-item-author">' + name + '</div>';
    h += '<div class="vn-item-date">' + escHtml(dateStr) + (dur ? ' · ' + dur : '') + '</div>';
    h += '</div>';
    if (canDelete) {
      h += '<button class="vn-item-del" data-vn-action="delete" data-note-id="' + escHtml(note.id) + '" title="Supprimer">✕</button>';
    }
    h += '</div>';

    // Player audio (toujours présent dès qu'il y a une downloadUrl)
    if (n.downloadUrl) {
      h += '<div class="vn-item-player" data-vn-player>';
      h += '<audio controls preload="metadata" src="' + escHtml(n.downloadUrl) + '"></audio>';
      h += '</div>';
    } else {
      h += '<div class="vn-item-player vn-item-pending"><span class="vn-spinner"></span> Préparation…</div>';
    }

    // Bouton bascule audio / résumé + zone résumé
    if (status === 'done' && n.summary) {
      h += '<div class="vn-item-toggle">';
      h += '<button class="vn-toggle-btn" data-vn-action="toggle-summary" data-note-id="' + escHtml(note.id) + '">📝 Lire le résumé</button>';
      h += '</div>';
      h += '<div class="vn-item-summary" data-vn-summary="' + escHtml(note.id) + '" style="display:none">';
      h += '<div class="vn-summary-text">' + escHtml(n.summary) + '</div>';
      if (n.transcription) {
        h += '<details class="vn-transcript-details"><summary>Voir la transcription complète</summary>';
        h += '<div class="vn-transcript-text">' + escHtml(n.transcription) + '</div>';
        h += '</details>';
      }
      h += '</div>';
    } else if (status === 'pending' || status === 'processing') {
      h += '<div class="vn-item-status"><span class="vn-spinner-sm"></span> Transcription en cours…</div>';
    } else if (status === 'error') {
      h += '<div class="vn-item-status vn-status-error" title="' + escHtml(n.transcriptionError || '') + '">⚠ Transcription échouée</div>';
    }

    h += '</div>';
    return h;
  }

  function renderThread(notes, currentUser) {
    if (!notes || notes.length === 0) {
      return '<div class="vn-empty">Aucun vocal encore. Sois le premier à en laisser un sur ce prospect.</div>';
    }
    var h = '';
    for (var i = 0; i < notes.length; i++) h += renderNote(notes[i], currentUser);
    return h;
  }

  /* ─── Recording flow ─────────────────────────────────────────── */

  function startRecording(mount) {
    var ctx = _activeMounts[mount.dataset.vnMountId];
    if (!ctx) return;

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ctx.state = 'unsupported';
      mount.innerHTML = renderShell('unsupported') + mount.querySelector('[data-vn-thread]').outerHTML;
      reattachThread(mount, ctx);
      return;
    }

    ctx.state = 'requesting';
    rerender(mount, ctx);

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      ctx.mediaStream = stream;
      var mime = detectMimeType();
      var options = mime ? { mimeType: mime } : {};
      var recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch (e) {
        // Fallback sans options
        try { recorder = new MediaRecorder(stream); }
        catch (e2) {
          console.error('[vn] MediaRecorder creation failed:', e2);
          stopMediaStream(ctx);
          ctx.state = 'unsupported';
          rerender(mount, ctx);
          return;
        }
      }

      ctx.recorder = recorder;
      ctx.chunks = [];
      ctx.recordStartMs = Date.now();
      ctx.actualMime = recorder.mimeType || mime || 'audio/webm';

      recorder.ondataavailable = function(ev) {
        if (ev.data && ev.data.size > 0) ctx.chunks.push(ev.data);
      };
      recorder.onstop = function() {
        var stopMs = Date.now();
        var durSec = Math.max(1, Math.round((stopMs - ctx.recordStartMs) / 1000));
        stopMediaStream(ctx);
        if (ctx.cancelled) {
          ctx.cancelled = false;
          ctx.chunks = [];
          ctx.state = 'idle';
          rerender(mount, ctx);
          return;
        }
        var blob = new Blob(ctx.chunks, { type: ctx.actualMime });
        ctx.chunks = [];
        uploadAndCreateNote(mount, ctx, blob, durSec);
      };

      recorder.start();
      ctx.state = 'recording';
      rerender(mount, ctx);

      // Timer + auto-stop à 3 min
      ctx.timerHandle = setInterval(function() {
        var elapsed = Math.floor((Date.now() - ctx.recordStartMs) / 1000);
        var timerEl = mount.querySelector('[data-vn-timer]');
        if (timerEl) timerEl.textContent = fmtDuration(elapsed);
        if (elapsed >= MAX_DURATION_SEC) {
          stopRecording(mount, false);
        }
      }, 250);
    }).catch(function(err) {
      console.warn('[vn] getUserMedia denied:', err);
      ctx.state = 'denied';
      rerender(mount, ctx);
    });
  }

  function stopRecording(mount, cancel) {
    var ctx = _activeMounts[mount.dataset.vnMountId];
    if (!ctx || !ctx.recorder) return;
    if (ctx.timerHandle) { clearInterval(ctx.timerHandle); ctx.timerHandle = null; }
    ctx.cancelled = !!cancel;
    if (ctx.recorder.state === 'recording') {
      try { ctx.recorder.stop(); } catch (e) { console.error('[vn] stop error:', e); }
    }
    if (!cancel) {
      ctx.state = 'uploading';
      rerender(mount, ctx);
    }
  }

  function stopMediaStream(ctx) {
    if (ctx.mediaStream) {
      try {
        ctx.mediaStream.getTracks().forEach(function(t) { t.stop(); });
      } catch (e) {}
      ctx.mediaStream = null;
    }
  }

  /* ─── Upload + Firestore + transcription ─────────────────────── */

  function uploadAndCreateNote(mount, ctx, blob, durSec) {
    if (!ctx.user || !ctx.user.uid) {
      console.error('[vn] Pas d\'utilisateur courant — abandon');
      ctx.state = 'idle';
      rerender(mount, ctx);
      return;
    }
    if (blob.size > 5 * 1024 * 1024) {
      alert('Vocal trop volumineux (>5 MB). Réessaie avec un enregistrement plus court.');
      ctx.state = 'idle';
      rerender(mount, ctx);
      return;
    }

    var leadId = ctx.leadId;
    var noteId = newNoteId();
    var ext = extFromMime(ctx.actualMime);
    var path = 'voice_notes/' + leadId + '/' + noteId + '.' + ext;

    var storage = firebase.storage();
    var ref = storage.ref(path);
    var task = ref.put(blob, { contentType: ctx.actualMime || 'audio/webm' });

    task.then(function() {
      return ref.getDownloadURL();
    }).then(function(url) {
      var noteData = {
        authorUid: ctx.user.uid,
        authorSlug: ctx.user.slug || '',
        authorName: ctx.user.name || '',
        authorColor: ctx.user.color || '#6b7280',
        authorInitials: ctx.user.initials || '?',
        storagePath: path,
        downloadUrl: url,
        mimeType: ctx.actualMime || 'audio/webm',
        durationSec: durSec,
        sizeBytes: blob.size,
        transcription: null,
        summary: null,
        transcriptionStatus: 'pending',
        transcriptionError: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      return firebase.firestore()
        .collection('leads').doc(leadId)
        .collection('voice_notes').doc(noteId)
        .set(noteData)
        .then(function() { return { noteId: noteId, ext: ext }; });
    }).then(function(out) {
      ctx.state = 'idle';
      rerender(mount, ctx);
      // La transcription est déclenchée automatiquement côté backend par
      // la Cloud Function onVoiceNoteCreated dès qu'elle voit le doc créé.
      // L'onSnapshot du fil affichera transcription + résumé en temps réel.
    }).catch(function(err) {
      console.error('[vn] upload error:', err);
      alert('Erreur d\'upload du vocal : ' + (err && err.message ? err.message : err));
      ctx.state = 'idle';
      rerender(mount, ctx);
    });
  }

  function triggerTranscription_DEPRECATED() {
    // Conservé en stub pour ne pas casser un éventuel import externe —
    // la transcription est désormais déclenchée par la Cloud Function
    // onVoiceNoteCreated (trigger Firestore onCreate).
    return Promise.resolve();
  }

  /* ─── Suppression ─────────────────────────────────────────────── */

  function deleteNote(leadId, noteId) {
    if (!confirm('Supprimer ce vocal ? Cette action est définitive.')) return;
    var db = firebase.firestore();
    var docRef = db.collection('leads').doc(leadId).collection('voice_notes').doc(noteId);
    docRef.get().then(function(snap) {
      if (!snap.exists) return;
      var d = snap.data();
      // Supprime le doc Firestore d'abord (l'UI réagit immédiatement)
      return docRef.delete().then(function() {
        // Puis le blob Storage en best-effort
        if (d.storagePath) {
          firebase.storage().ref(d.storagePath).delete().catch(function(e) {
            console.warn('[vn] storage delete failed (non bloquant):', e.message);
          });
        }
      });
    }).catch(function(err) {
      console.error('[vn] delete error:', err);
      alert('Erreur lors de la suppression : ' + err.message);
    });
  }

  /* ─── Listeners DOM ─────────────────────────────────────────── */

  function rerender(mount, ctx) {
    // Reconstruit le shell, conserve le thread déjà rendu
    var threadHtml = '';
    var threadEl = mount.querySelector('[data-vn-thread]');
    if (threadEl) threadHtml = threadEl.innerHTML;

    var newShell = renderShell(ctx.state);
    mount.innerHTML = newShell;
    var newThread = mount.querySelector('[data-vn-thread]');
    if (newThread && threadHtml) newThread.innerHTML = threadHtml;
  }

  function reattachThread(mount, ctx) {
    var threadEl = mount.querySelector('[data-vn-thread]');
    if (threadEl && ctx.lastNotes) {
      threadEl.innerHTML = renderThread(ctx.lastNotes, ctx.user);
    }
  }

  function bindEvents(mount) {
    if (mount._vnBound) return;
    mount._vnBound = true;
    mount.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-vn-action]');
      if (!btn) return;
      var action = btn.dataset.vnAction;
      var ctx = _activeMounts[mount.dataset.vnMountId];
      if (!ctx) return;

      if (action === 'record') {
        startRecording(mount);
      } else if (action === 'stop') {
        stopRecording(mount, false);
      } else if (action === 'cancel') {
        stopRecording(mount, true);
      } else if (action === 'toggle-summary') {
        var noteId = btn.dataset.noteId;
        var sumEl = mount.querySelector('[data-vn-summary="' + noteId + '"]');
        if (sumEl) {
          var open = sumEl.style.display !== 'none';
          sumEl.style.display = open ? 'none' : 'block';
          btn.textContent = open ? '📝 Lire le résumé' : '🔊 Masquer le résumé';
        }
      } else if (action === 'delete') {
        var nid = btn.dataset.noteId;
        deleteNote(ctx.leadId, nid);
      }
    });
  }

  /* ─── Snapshot Firestore ─────────────────────────────────────── */

  function startSnapshot(mount, ctx) {
    var threadEl = mount.querySelector('[data-vn-thread]');
    if (!threadEl) return;
    threadEl.innerHTML = '<div class="vn-empty"><span class="vn-spinner-sm"></span> Chargement…</div>';

    var q = firebase.firestore()
      .collection('leads').doc(ctx.leadId)
      .collection('voice_notes')
      .orderBy('createdAt', 'desc');

    ctx.unsub = q.onSnapshot(function(snap) {
      var notes = [];
      snap.forEach(function(doc) {
        notes.push({ id: doc.id, data: doc.data() });
      });
      ctx.lastNotes = notes;
      var threadElCurrent = mount.querySelector('[data-vn-thread]');
      if (threadElCurrent) threadElCurrent.innerHTML = renderThread(notes, ctx.user);
    }, function(err) {
      console.warn('[vn] snapshot error:', err.message);
      var threadElCurrent = mount.querySelector('[data-vn-thread]');
      if (threadElCurrent) threadElCurrent.innerHTML = '<div class="vn-empty vn-status-error">⚠ Erreur de chargement : ' + escHtml(err.message) + '</div>';
    });
  }

  /* ─── API publique ───────────────────────────────────────────── */

  function attach(mount, leadId, currentUser) {
    if (!mount || !leadId) return;
    if (!firebase || !firebase.firestore) {
      console.warn('[vn] Firebase non chargé');
      return;
    }

    // Si déjà attaché avec le bon leadId, on ne refait rien
    if (mount._vnLeadId === leadId && mount.dataset.vnMountId) return;
    if (mount.dataset.vnMountId) detach(mount);

    var mountId = 'vn_' + (++_mountSeq);
    mount.dataset.vnMountId = mountId;
    mount._vnLeadId = leadId;

    var ctx = {
      leadId: leadId,
      user: currentUser || null,
      state: 'idle',
      unsub: null,
      lastNotes: [],
      recorder: null,
      mediaStream: null,
      timerHandle: null,
      chunks: [],
      cancelled: false,
      actualMime: ''
    };
    _activeMounts[mountId] = ctx;

    mount.innerHTML = renderShell('idle');
    bindEvents(mount);
    startSnapshot(mount, ctx);
  }

  function detach(mount) {
    if (!mount) return;
    var mountId = mount.dataset.vnMountId;
    if (!mountId) return;
    var ctx = _activeMounts[mountId];
    if (ctx) {
      if (ctx.unsub) { try { ctx.unsub(); } catch (e) {} }
      if (ctx.timerHandle) clearInterval(ctx.timerHandle);
      stopMediaStream(ctx);
      if (ctx.recorder && ctx.recorder.state === 'recording') {
        try { ctx.recorder.stop(); } catch (e) {}
      }
      delete _activeMounts[mountId];
    }
    delete mount.dataset.vnMountId;
    delete mount._vnLeadId;
    mount.innerHTML = '';
  }

  window.VoiceNotes = {
    attach: attach,
    detach: detach,
    MAX_DURATION_SEC: MAX_DURATION_SEC
  };

})();
