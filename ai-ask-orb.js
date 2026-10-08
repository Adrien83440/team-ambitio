/* ═══════════════════════════════════════════════════════════════════════════
   ai-ask-orb.js — « DEMANDE À ALTEORE » : module vocal futuriste (IA, Lot 5)
   ─────────────────────────────────────────────────────────────────────────
   Injecté par nav.js ; s'active UNIQUEMENT pour les admins.
   • Bouton orbe flottant (bas droite) + raccourci ⌘/Ctrl + J.
   • Plein écran : un orbe animé (canvas) qui réagit en temps réel à la voix —
     la tienne quand tu parles (micro → AnalyserNode), celle de l'IA quand
     elle répond (lecteur audio → AnalyserNode) ; respiration lente au repos,
     tourbillon pendant la réflexion.
   • Push-to-talk : maintenir le bouton micro (ou la barre espace), relâcher
     pour envoyer. Champ texte en secours.
   • Chaîne : micro → api/ai-voice (stt, ElevenLabs Scribe) → api/ai-ask
     (Opus + outils lecture seule) → api/ai-voice (tts, ElevenLabs) → lecture.
   ES5, sans SDK (jeton compat ou window._auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__aiAskOrb) return;
  window.__aiAskOrb = true;

  var S = {
    open: false, state: 'idle', // idle | listening | thinking | speaking
    history: [], voiceId: null, voices: [], muted: false,
    ctx: null, analyser: null, data: null, micStream: null, rec: null, chunks: [],
    audio: null, mediaNode: null, raf: 0, t: 0, level: 0, holding: false
  };
  var el = {};

  function role() { try { return localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function post(url, body) {
    var u = user();
    if (!u) return Promise.reject(new Error('Session non prête'));
    return u.getIdToken().then(function (tok) {
      return fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || 'Erreur'); return j; });
  }

  /* ═══ Styles ═══ */
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.aio-fab{position:fixed;right:22px;bottom:88px;z-index:2600;width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;padding:0;' +
        'background:radial-gradient(circle at 35% 30%,#e0e7ff 0,#a78bfa 22%,#6366f1 48%,#0e7490 80%,#082f49 100%);box-shadow:0 0 0 1px rgba(255,255,255,.15),0 10px 30px rgba(99,102,241,.55),0 0 40px rgba(34,211,238,.35);animation:aioPulse 3.2s ease-in-out infinite}' +
      '.aio-fab:hover{transform:scale(1.06)}' +
      '@keyframes aioPulse{0%,100%{box-shadow:0 0 0 1px rgba(255,255,255,.15),0 10px 30px rgba(99,102,241,.5),0 0 30px rgba(34,211,238,.3)}50%{box-shadow:0 0 0 1px rgba(255,255,255,.2),0 10px 40px rgba(168,85,247,.65),0 0 60px rgba(34,211,238,.5)}}' +
      '.aio{position:fixed;inset:0;z-index:9500;display:none;flex-direction:column;align-items:center;justify-content:center;color:#e6f6ff;font-family:inherit;overflow:hidden;' +
        'background:radial-gradient(ellipse at 50% 40%,#111a3a 0,#070b1c 55%,#02030a 100%)}' +
      '.aio.on{display:flex;animation:aioIn .35s ease}' +
      '@keyframes aioIn{from{opacity:0;transform:scale(1.02)}to{opacity:1;transform:none}}' +
      '.aio-grid{position:absolute;inset:0;pointer-events:none;opacity:.18;background-image:linear-gradient(rgba(125,211,252,.25) 1px,transparent 1px),linear-gradient(90deg,rgba(125,211,252,.25) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(ellipse at center,#000 20%,transparent 70%);-webkit-mask-image:radial-gradient(ellipse at center,#000 20%,transparent 70%)}' +
      '.aio-top{position:absolute;top:18px;left:22px;right:22px;display:flex;align-items:center;gap:10px}' +
      '.aio-brand{font-size:12px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#7dd3fc;text-shadow:0 0 12px rgba(125,211,252,.6)}' +
      '.aio-top .sp{flex:1}' +
      '.aio-b{background:rgba(125,211,252,.08);border:1px solid rgba(125,211,252,.25);color:#cdefff;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}' +
      '.aio-b:hover{background:rgba(125,211,252,.16)}' +
      '.aio-sel{background:rgba(125,211,252,.08);border:1px solid rgba(125,211,252,.25);color:#cdefff;border-radius:999px;padding:6px 10px;font-size:12px;font-family:inherit}' +
      '.aio-sel option{background:#0b1230}' +
      '.aio-canvas{width:min(62vmin,460px);height:min(62vmin,460px);cursor:pointer;touch-action:none}' +
      '.aio-state{margin-top:6px;font-size:12px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#93c5fd;min-height:16px}' +
      '.aio-q{margin-top:14px;max-width:min(760px,90vw);text-align:center;font-size:14px;color:#94a3b8;min-height:20px}' +
      '.aio-a{margin-top:10px;max-width:min(760px,90vw);max-height:26vh;overflow-y:auto;text-align:center;font-size:18px;line-height:1.55;color:#f0f9ff;text-shadow:0 0 18px rgba(56,189,248,.25);white-space:pre-wrap}' +
      '.aio-bar{margin-top:22px;display:flex;gap:10px;align-items:center;width:min(640px,92vw)}' +
      '.aio-mic{flex:none;width:64px;height:64px;border-radius:50%;border:1px solid rgba(125,211,252,.4);cursor:pointer;font-size:24px;color:#fff;user-select:none;-webkit-user-select:none;touch-action:none;' +
        'background:radial-gradient(circle at 35% 30%,#67e8f9,#6366f1 60%,#312e81);box-shadow:0 0 30px rgba(99,102,241,.5)}' +
      '.aio-mic.rec{background:radial-gradient(circle at 35% 30%,#fda4af,#e11d48 60%,#4c0519);box-shadow:0 0 40px rgba(244,63,94,.7);animation:aioRec 1s ease-in-out infinite}' +
      '@keyframes aioRec{50%{transform:scale(1.07)}}' +
      '.aio-in{flex:1;background:rgba(15,23,42,.6);border:1px solid rgba(125,211,252,.25);border-radius:999px;padding:13px 18px;color:#e6f6ff;font-size:14px;outline:0;font-family:inherit}' +
      '.aio-in:focus{border-color:#67e8f9;box-shadow:0 0 0 3px rgba(103,232,249,.15)}' +
      '.aio-hint{margin-top:10px;font-size:11px;color:#64748b;letter-spacing:.5px}' +
      '.aio-hist{position:absolute;right:18px;top:64px;bottom:18px;width:min(360px,90vw);overflow-y:auto;background:rgba(2,6,23,.75);border:1px solid rgba(125,211,252,.15);border-radius:16px;padding:14px;display:none;backdrop-filter:blur(8px)}' +
      '.aio-hist.on{display:block}' +
      '.aio-hm{font-size:12.5px;line-height:1.5;margin-bottom:10px}.aio-hm b{display:block;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:#7dd3fc}' +
      '@media (max-width:640px){.aio-a{font-size:16px}.aio-fab{right:14px;bottom:80px}}';
    document.head.appendChild(s);
  }

  /* ═══ DOM ═══ */
  function build() {
    css();
    var fab = document.createElement('button');
    fab.className = 'aio-fab';
    fab.type = 'button';
    fab.title = 'Demande à Alteore (⌘/Ctrl + J)';
    fab.setAttribute('aria-label', 'Demande à Alteore');
    document.body.appendChild(fab);
    fab.addEventListener('click', openUi);

    var o = document.createElement('div');
    o.className = 'aio';
    o.innerHTML =
      '<div class="aio-grid"></div>' +
      '<div class="aio-top"><span class="aio-brand">◉ Alteore · IA</span><span class="sp"></span>' +
        '<select class="aio-sel" id="aioVoice" title="Voix"></select>' +
        '<button type="button" class="aio-b" id="aioMute" title="Couper / remettre la voix">🔊</button>' +
        '<button type="button" class="aio-b" id="aioHistBtn">Historique</button>' +
        '<button type="button" class="aio-b" id="aioClose">✕</button></div>' +
      '<canvas class="aio-canvas" id="aioCanvas"></canvas>' +
      '<div class="aio-state" id="aioState"></div>' +
      '<div class="aio-q" id="aioQ"></div>' +
      '<div class="aio-a" id="aioA">Pose-moi une question sur l\'activité : leads, RDV, closes, clients à risque, impayés…</div>' +
      '<div class="aio-bar"><button type="button" class="aio-mic" id="aioMic" title="Maintenir pour parler">🎙</button>' +
        '<input class="aio-in" id="aioIn" placeholder="…ou écris ta question puis Entrée"/></div>' +
      '<div class="aio-hint">Maintiens 🎙 (ou la barre espace) pour parler · Échap pour fermer</div>' +
      '<div class="aio-hist" id="aioHist"></div>';
    document.body.appendChild(o);
    el.root = o;
    ['aioCanvas', 'aioState', 'aioQ', 'aioA', 'aioMic', 'aioIn', 'aioHist', 'aioVoice', 'aioMute'].forEach(function (id) { el[id] = document.getElementById(id); });

    document.getElementById('aioClose').addEventListener('click', closeUi);
    document.getElementById('aioHistBtn').addEventListener('click', function () { el.aioHist.classList.toggle('on'); renderHist(); });
    el.aioMute.addEventListener('click', function () { S.muted = !S.muted; el.aioMute.textContent = S.muted ? '🔇' : '🔊'; if (S.muted && S.audio) S.audio.pause(); });
    el.aioVoice.addEventListener('change', function () { S.voiceId = el.aioVoice.value; });
    el.aioIn.addEventListener('keydown', function (e) { if (e.key === 'Enter' && el.aioIn.value.trim()) { var q = el.aioIn.value.trim(); el.aioIn.value = ''; ask(q); } });

    // Push-to-talk (souris / tactile) — maintien
    function down(e) { e.preventDefault(); startRec(); }
    function up(e) { e.preventDefault(); stopRec(); }
    el.aioMic.addEventListener('mousedown', down);
    el.aioMic.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('mouseup', function () { if (S.holding) stopRec(); });
    el.aioMic.addEventListener('touchend', up);
    el.aioCanvas.addEventListener('click', function () { if (S.state === 'speaking' && S.audio) { S.audio.pause(); setState('idle'); } });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); if (S.open) closeUi(); else openUi(); return; }
      if (!S.open) return;
      if (e.key === 'Escape') { closeUi(); return; }
      if (e.code === 'Space' && document.activeElement !== el.aioIn && !e.repeat) { e.preventDefault(); startRec(); }
    });
    document.addEventListener('keyup', function (e) { if (S.open && e.code === 'Space' && document.activeElement !== el.aioIn) { e.preventDefault(); stopRec(); } });
  }

  function setState(st, txt) {
    S.state = st;
    var labels = { idle: '', listening: 'Je t\'écoute…', thinking: 'Je réfléchis…', speaking: 'Alteore répond' };
    el.aioState.textContent = txt || labels[st] || '';
    el.aioMic.classList.toggle('rec', st === 'listening');
  }

  function renderHist() {
    if (!S.history.length) { el.aioHist.innerHTML = '<div class="aio-hm">Aucun échange pour l\'instant.</div>'; return; }
    el.aioHist.innerHTML = S.history.map(function (m) { return '<div class="aio-hm"><b>' + (m.role === 'user' ? 'Toi' : 'Alteore') + '</b>' + esc(m.text) + '</div>'; }).join('');
    el.aioHist.scrollTop = el.aioHist.scrollHeight;
  }

  /* ═══ Audio ═══ */
  function audioCtx() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      S.ctx = new AC();
      // Deux analyseurs : le micro n'est JAMAIS relié aux haut-parleurs (sinon
      // on s'entendrait parler) ; la voix de l'IA, si.
      S.anMic = S.ctx.createAnalyser();
      S.anOut = S.ctx.createAnalyser();
      [S.anMic, S.anOut].forEach(function (a) { a.fftSize = 256; a.smoothingTimeConstant = 0.78; });
      S.anOut.connect(S.ctx.destination);
      S.data = new Uint8Array(S.anMic.frequencyBinCount);
    }
    if (S.ctx.state === 'suspended') S.ctx.resume();
    return S.ctx;
  }

  var micSrc = null;
  // Reconnaissance vocale du navigateur, lancée EN PARALLÈLE de
  // l'enregistrement : filet de sécurité si la transcription ElevenLabs
  // échoue (clé, quota, réseau). Chrome et Safari la proposent.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var reco = null, recoText = '';
  function startReco() {
    recoText = '';
    if (!SR) return;
    try {
      reco = new SR();
      reco.lang = 'fr-FR';
      reco.continuous = true;
      reco.interimResults = true;
      reco.onresult = function (ev) {
        var t = '';
        for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
        recoText = t.trim();
      };
      reco.onerror = function () {};
      reco.start();
    } catch (e) { reco = null; }
  }
  function stopReco() { if (reco) { try { reco.stop(); } catch (e) {} reco = null; } }

  function startRec() {
    if (S.holding || S.state === 'thinking') return;
    if (S.audio) { try { S.audio.pause(); } catch (e) {} }
    S.holding = true;
    var ctx = audioCtx();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      if (!S.holding) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      S.micStream = stream;
      if (ctx) { micSrc = ctx.createMediaStreamSource(stream); micSrc.connect(S.anMic); }
      var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus'
        : ((window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) ? 'audio/mp4' : '');
      S.chunks = [];
      S.rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      S.rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) S.chunks.push(ev.data); };
      S.rec.onstop = onRecStop;
      S.rec.start();
      startReco();
      setState('listening');
    }).catch(function () { S.holding = false; setState('idle', 'Micro refusé — écris ta question'); });
  }
  function stopRec() {
    if (!S.holding) return;
    S.holding = false;
    if (S.rec && S.rec.state !== 'inactive') S.rec.stop();
    else setState('idle');
  }
  function onRecStop() {
    stopReco();
    if (micSrc) { try { micSrc.disconnect(); } catch (e) {} micSrc = null; }
    if (S.micStream) { S.micStream.getTracks().forEach(function (t) { t.stop(); }); S.micStream = null; }
    var blob = new Blob(S.chunks, { type: (S.rec && S.rec.mimeType) || 'audio/webm' });
    if (blob.size < 2500 && !recoText) { setState('idle', 'Trop court — maintiens le bouton en parlant'); return; }
    setState('thinking', 'Je transcris…');
    var fr = new FileReader();
    fr.onload = function () {
      var b64 = String(fr.result).split(',')[1] || '';
      // Petit délai : laisse la reconnaissance du navigateur livrer son dernier mot.
      var fallback = function (why) {
        setTimeout(function () {
          if (recoText) { ask(recoText); return; }
          setState('idle', 'Transcription impossible');
          el.aioA.textContent = '⚠️ ' + why + (SR ? '' : '\n(Ce navigateur n\'a pas de reconnaissance vocale de secours : écris ta question.)');
        }, 400);
      };
      post('/api/ai-voice', { action: 'stt', audio: b64, mime: blob.type }).then(function (j) {
        if (j.text) { ask(j.text); return; }
        fallback('Je n\'ai rien entendu.');
      }).catch(function (e) { fallback(e.message); });
    };
    fr.readAsDataURL(blob);
  }

  function speak(text) {
    if (S.muted) { setState('idle'); return; }
    post('/api/ai-voice', { action: 'tts', text: text, voiceId: S.voiceId }).then(function (j) {
      var ctx = audioCtx();
      if (!S.audio) {
        S.audio = new Audio();
        S.audio.crossOrigin = 'anonymous';
        if (ctx) { S.mediaNode = ctx.createMediaElementSource(S.audio); S.mediaNode.connect(S.anOut); }
        S.audio.addEventListener('ended', function () { setState('idle'); });
      }
      S.audio.src = 'data:' + (j.mime || 'audio/mpeg') + ';base64,' + j.audio;
      setState('speaking');
      S.audio.play().catch(function () { setState('idle'); });
    }).catch(function (e) {
      setState('idle', '🔇 Voix indisponible');
      // Après la fin de l'effet machine à écrire (sinon il écrase le message).
      setTimeout(function () { el.aioA.textContent = text + '\n\n🔇 ' + e.message; }, 2600);
    });
  }

  /* ═══ Question → réponse ═══ */
  function typewriter(text) {
    var i = 0;
    el.aioA.textContent = '';
    (function step() {
      if (!S.open) { el.aioA.textContent = text; return; }
      i += Math.max(1, Math.round(text.length / 120));
      el.aioA.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 16);
    })();
  }
  function ask(q) {
    el.aioQ.textContent = '« ' + q + ' »';
    el.aioA.textContent = '';
    setState('thinking');
    var hist = S.history.slice(-10);
    S.history.push({ role: 'user', text: q });
    post('/api/ai-ask', { question: q, history: hist, voice: !S.muted }).then(function (j) {
      S.history.push({ role: 'assistant', text: j.answer });
      renderHist();
      typewriter(j.answer);
      speak(j.answer);
    }).catch(function (e) { setState('idle'); el.aioA.textContent = '⚠️ ' + e.message; });
  }

  /* ═══ Orbe (canvas) ═══ */
  function draw() {
    S.raf = requestAnimationFrame(draw);
    var c = el.aioCanvas, dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // Niveau audio (micro ou voix de l'IA) — 0..1, lissé.
    var lvl = 0, bands = null;
    var an = S.state === 'listening' ? S.anMic : (S.state === 'speaking' ? S.anOut : null);
    if (an) {
      an.getByteFrequencyData(S.data);
      var sum = 0;
      for (var i = 0; i < S.data.length; i++) sum += S.data[i];
      lvl = Math.min(1, sum / S.data.length / 110);
      bands = S.data;
    }
    S.level += (lvl - S.level) * 0.25;
    var speed = S.state === 'thinking' ? 0.045 : (S.state === 'idle' ? 0.008 : 0.018);
    S.t += speed;
    var t = S.t, L = S.level;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.24;
    var breath = S.state === 'idle' ? Math.sin(t * 2.2) * 0.03 : 0;
    var hueA = S.state === 'listening' ? 340 : (S.state === 'thinking' ? 265 + Math.sin(t * 3) * 25 : 195);
    var hueB = S.state === 'listening' ? 290 : 275;

    // Halo
    var halo = g.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * (2.4 + L * 1.2));
    halo.addColorStop(0, 'hsla(' + hueA + ',95%,65%,' + (0.35 + L * 0.35) + ')');
    halo.addColorStop(0.45, 'hsla(' + hueB + ',90%,55%,' + (0.12 + L * 0.15) + ')');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, cy, R * 3.2, 0, Math.PI * 2); g.fill();

    // Anneaux déformés par le spectre
    g.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 4; k++) {
      var base = R * (1.02 + k * 0.17 + breath) * (1 + L * 0.35);
      g.beginPath();
      var N = 120;
      for (var j = 0; j <= N; j++) {
        var a = (j / N) * Math.PI * 2;
        var b = bands ? bands[(j * 3 + k * 7) % bands.length] / 255 : 0;
        var wob = Math.sin(a * (3 + k) + t * (1.4 + k * 0.5)) * (0.035 + L * 0.09) + Math.sin(a * 7 - t * 2.1) * 0.012 + b * 0.22 * L;
        var rr = base * (1 + wob);
        var x = cx + Math.cos(a + t * (k % 2 ? -0.3 : 0.3)) * rr, y = cy + Math.sin(a + t * (k % 2 ? -0.3 : 0.3)) * rr;
        if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.strokeStyle = 'hsla(' + (hueA + k * 22) + ',95%,' + (62 + k * 4) + '%,' + (0.55 - k * 0.1 + L * 0.3) + ')';
      g.lineWidth = 1.6 + L * 2.5 - k * 0.25;
      g.shadowBlur = 18 + L * 30;
      g.shadowColor = 'hsla(' + hueA + ',100%,65%,0.9)';
      g.stroke();
    }
    g.shadowBlur = 0;

    // Cœur
    var core = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.05, cx, cy, R * (0.95 + L * 0.3));
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.25, 'hsla(' + (hueA + 10) + ',95%,72%,0.85)');
    core.addColorStop(0.7, 'hsla(' + hueB + ',85%,45%,0.55)');
    core.addColorStop(1, 'hsla(' + hueB + ',80%,20%,0)');
    g.fillStyle = core;
    g.beginPath(); g.arc(cx, cy, R * (0.95 + L * 0.3 + breath), 0, Math.PI * 2); g.fill();

    // Particules en orbite
    for (var p = 0; p < 42; p++) {
      var ang = p * 2.399 + t * (0.4 + (p % 5) * 0.08) * (p % 2 ? 1 : -1);
      var dist = R * (1.5 + (p % 7) * 0.12 + Math.sin(t * 2 + p) * 0.05 + L * 0.5);
      var px = cx + Math.cos(ang) * dist, py = cy + Math.sin(ang) * dist * 0.92;
      g.fillStyle = 'hsla(' + (hueA + (p % 4) * 15) + ',100%,75%,' + (0.35 + L * 0.5) + ')';
      g.beginPath(); g.arc(px, py, 1 + (p % 3) * 0.6 + L * 1.5, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  function openUi() {
    if (S.open) return;
    S.open = true;
    el.root.classList.add('on');
    setState('idle');
    if (!S.raf) draw();
    if (!S.voices.length) {
      post('/api/ai-voice', { action: 'voices' }).then(function (j) {
        S.voices = j.voices || []; S.voiceId = j.current;
        el.aioVoice.innerHTML = S.voices.map(function (v) { return '<option value="' + v.id + '"' + (v.id === j.current ? ' selected' : '') + '>🗣 ' + esc(v.name) + '</option>'; }).join('');
        if (!j.configured) { S.muted = true; el.aioMute.textContent = '🔇'; el.aioState.textContent = 'Voix indisponible (clé ElevenLabs) — mode texte'; }
      }).catch(function () {});
    }
    setTimeout(function () { el.aioIn.focus(); }, 50);
  }
  function closeUi() {
    S.open = false;
    el.root.classList.remove('on');
    if (S.audio) { try { S.audio.pause(); } catch (e) {} }
    stopRec();
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
  }

  function start() {
    if (role() !== 'admin') return;
    var tries = 0;
    (function wait() {
      if (user()) { build(); return; }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
