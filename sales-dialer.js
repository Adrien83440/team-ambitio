/**
 * sales-dialer.js — Softphone Ambitio
 * Twilio Voice SDK browser + Firestore live (call_logs, dialer_campaigns, dialer_sessions)
 * Bridge CRM via sessionStorage.dialer_pending_call / dialer_pending_campaign
 *                                  / dialer_pending_auto_campaign (Power Dialer)
 *
 * Ergonomie sonore :
 *   - Les bips Twilio "outgoing" (début d'appel sortant) et "disconnect" (fin
 *     d'appel) sont désactivés en permanence : la UI change déjà visuellement,
 *     ces bips sont inutiles et fatigants sur une journée.
 *   - Le ringtone "incoming" reste actif en mode normal (appels entrants
 *     imprévus) mais est désactivé pendant une session Power Dialer : dans ce
 *     contexte, on auto-accept le call dès qu'un lead décroche, et on joue un
 *     court "ding" custom (150ms, 880Hz, Web Audio) pour signaler au closer
 *     qu'il doit parler. Le ding peut être coupé via la pref dingOnAnswer.
 *
 * Power Dialer :
 *   Une session auto = queue complète [leads] + waveSize (3/4/5).
 *   Chaque vague crée un doc dialer_campaigns classique (même format),
 *   relié par un champ autoCampaignId (UUID client) + waveIndex.
 *   Quand la vague se termine (connectedCallSid raccroché OU tous no-answer) :
 *     - si connecté + raccroché → countdown 3s puis vague suivante
 *     - si aucun décroche       → enchainement immédiat (pas de countdown)
 *   Stop = cancel vague en cours + reset state + toast récap.
 */
(function () {
  'use strict';

  const db = firebase.firestore();
  let currentUser = null;
  let device = null;
  let activeConn = null;
  let activeCallSid = null;
  let activeLeadId = null;
  let activeLeadData = null;
  let sessionDocRef = null;
  let campaignUnsub = null;
  let callTimer = null;
  let callStartTs = 0;
  let fromNumbers = [];
  let historyFilter = 'all';
  let historyUnsub = null;
  let leadNotesUnsub = null;
  let leadNotesTimeout = null;
  let canViewAllCalls = false;
  let uidToShortName = {};

  // ─── État Power Dialer ───────────────────────────────────────────────────
  let autoSession = null;

  // ─── Ergonomie sonore ────────────────────────────────────────────────────
  // Préférence "ding court quand un lead décroche en Power Dialer" (défaut ON)
  let dingOnAnswer = true;
  // Contexte Web Audio partagé (créé paresseusement au premier usage)
  let audioCtx = null;

  // ─── Audio routing (mobile earpiece ↔ haut-parleur) ──────────────────────
  // Sur mobile, par défaut Twilio route le flux audio vers le speaker, ce qui
  // n'est pas le comportement attendu d'un appel téléphonique (l'utilisateur
  // veut pouvoir coller le téléphone à l'oreille). On expose un toggle qui
  // utilise device.audio.speakerDevices.set() pour basculer entre l'écouteur
  // et le haut-parleur sur Android Chrome (et iOS dans la limite du support
  // setSinkId, fonctionnel sur iOS 17+).
  //
  // - Mobile : bouton visible. Décrochage par défaut sur earpiece. Préférence
  //   utilisateur persistée dans localStorage et appliquée à chaque appel.
  // - Desktop : bouton caché. On laisse Twilio utiliser le default OS (qui
  //   correspond aux haut-parleurs / casque branché tels que configurés au
  //   niveau système).
  const SD_IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const SD_OUTPUT_PREF_KEY = 'sd_output_pref'; // 'earpiece' | 'speaker'
  let earpieceDeviceId = null;
  let speakerDeviceId = null;
  let currentOutputMode = null; // mode appliqué actuellement

  // ─── Utilitaires ─────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const toast = (msg, type = '') => {
    const t = $('sd-toast');
    t.textContent = msg;
    t.className = `sd-toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3500);
  };
  const setStatus = (text, cls = '') => {
    $('sd-status-text').textContent = text;
    $('sd-status-dot').className = `sd-status-dot ${cls}`;
  };
  const showView = (name) => {
    document.querySelectorAll('.sd-view').forEach(v => v.classList.remove('sd-view-active'));
    $(`sd-view-${name}`).classList.add('sd-view-active');
  };
  const fmtTimer = (s) => {
    const m = Math.floor(s / 60), r = s % 60;
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
  };
  const normalizePhone = (raw) => {
    if (!raw) return '';
    let p = String(raw).replace(/[^\d+]/g, '');
    if (p.startsWith('00')) p = '+' + p.slice(2);
    if (p.startsWith('0') && p.length === 10) p = '+33' + p.slice(1);
    if (!p.startsWith('+')) p = '+' + p;
    return p;
  };
  const uuid = () => ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );

  // ─── Sons Twilio : helpers de mute/restore ──────────────────────────────
  // device.audio est un AudioHelper (SDK v2). Les méthodes .incoming(),
  // .outgoing(), .disconnect() sans argument retournent l'état courant ;
  // avec un bool elles l'affectent. Elles peuvent throw si le SDK change
  // d'API → toujours wrappé dans un try/catch.
  function muteTwilioOutgoingAndDisconnect() {
    if (!device || !device.audio) return;
    try {
      if (typeof device.audio.outgoing === 'function')   device.audio.outgoing(false);
      if (typeof device.audio.disconnect === 'function') device.audio.disconnect(false);
    } catch (e) { console.warn('[sounds] mute outgoing/disconnect failed', e); }
  }
  function muteTwilioIncoming() {
    if (!device || !device.audio) return;
    try {
      if (typeof device.audio.incoming === 'function') device.audio.incoming(false);
    } catch (e) { console.warn('[sounds] mute incoming failed', e); }
  }
  function restoreTwilioIncoming() {
    if (!device || !device.audio) return;
    try {
      if (typeof device.audio.incoming === 'function') device.audio.incoming(true);
    } catch (e) { console.warn('[sounds] restore incoming failed', e); }
  }

  // Petit "ding" (880Hz, ~150ms) via Web Audio. Non bloquant, ignore les erreurs
  // (ex. AudioContext bloqué tant que l'user n'a pas interagi avec la page).
  function playDing() {
    if (!dingOnAnswer) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Certains browsers suspendent l'AudioContext → resume si besoin
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      // Enveloppe courte avec attack/decay pour éviter le clic
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.015);
      gain.gain.linearRampToValueAtTime(0, now + 0.18);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch (e) {
      // Silencieux : pas critique
    }
  }

  // ─── Audio routing helpers ───────────────────────────────────────────────
  // Twilio Voice SDK v2 expose device.audio.availableOutputDevices (Map de
  // deviceId → MediaDeviceInfo) et device.audio.speakerDevices.set([ids]).
  // On identifie l'écouteur (earpiece) et le haut-parleur (speaker) par le
  // label exposé par enumerateDevices(). Sur Android, les labels typiques
  // contiennent "earpiece" ou "receiver" pour l'écouteur et "speaker" pour
  // le haut-parleur. Si on ne trouve qu'un seul output (cas iOS Safari où
  // l'OS gère le routing en interne), le toggle devient un no-op visuel.
  function detectAudioOutputs() {
    if (!device || !device.audio || !device.audio.availableOutputDevices) return;
    earpieceDeviceId = null;
    speakerDeviceId = null;
    const all = [];
    device.audio.availableOutputDevices.forEach((info, deviceId) => {
      const label = String(info.label || '').toLowerCase();
      all.push({ deviceId, label });
      if (!speakerDeviceId && (label.includes('speaker') || label.includes('haut-parleur') || label.includes('speakerphone'))) {
        speakerDeviceId = deviceId;
      }
      if (!earpieceDeviceId && (label.includes('earpiece') || label.includes('receiver') || label.includes('écouteur'))) {
        earpieceDeviceId = deviceId;
      }
    });
    // Fallbacks si labels non explicites (cas fréquent avant interaction
    // utilisateur où enumerateDevices retourne des labels vides)
    if (!earpieceDeviceId) {
      const def = all.find(d => d.deviceId === 'default');
      earpieceDeviceId = def ? def.deviceId : (all[0] && all[0].deviceId);
    }
    if (!speakerDeviceId) {
      const other = all.find(d => d.deviceId !== earpieceDeviceId);
      speakerDeviceId = other ? other.deviceId : earpieceDeviceId;
    }
    console.log('[dialer-audio] outputs detected', { earpieceDeviceId, speakerDeviceId, all });
  }

  function getStoredOutputPref() {
    if (!SD_IS_MOBILE) return 'speaker'; // desktop : speaker = default OS
    try {
      const v = localStorage.getItem(SD_OUTPUT_PREF_KEY);
      return (v === 'speaker' || v === 'earpiece') ? v : 'earpiece';
    } catch { return 'earpiece'; }
  }

  function setStoredOutputPref(mode) {
    try { localStorage.setItem(SD_OUTPUT_PREF_KEY, mode); } catch {}
  }

  // Applique le mode (earpiece/speaker) au flux audio Twilio. Idempotent et
  // safe : peut être appelé avant ou pendant un appel. Sur desktop c'est un
  // no-op (on laisse l'OS gérer le routing).
  async function applyOutputMode(mode) {
    if (!SD_IS_MOBILE) return;
    if (!device || !device.audio || !device.audio.speakerDevices) return;
    if (!earpieceDeviceId || !speakerDeviceId) detectAudioOutputs();
    const targetId = mode === 'speaker' ? speakerDeviceId : earpieceDeviceId;
    if (!targetId) return;
    try {
      await device.audio.speakerDevices.set([targetId]);
      currentOutputMode = mode;
      const btn = $('sd-btn-speaker');
      if (btn) btn.classList.toggle('active', mode === 'speaker');
      console.log('[dialer-audio] output set →', mode, targetId);
    } catch (err) {
      console.warn('[dialer-audio] applyOutputMode failed', err);
    }
  }

  // Initialise le bouton speaker : visible mobile uniquement, état initial
  // depuis la préférence stockée. À appeler une fois le Device registered.
  function setupSpeakerButton() {
    const btn = $('sd-btn-speaker');
    if (!btn) return;
    if (!SD_IS_MOBILE) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    const pref = getStoredOutputPref();
    btn.classList.toggle('active', pref === 'speaker');
    currentOutputMode = pref;
  }

  // ─── Auth + bootstrap ────────────────────────────────────────────────────
  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    sessionDocRef = db.collection('dialer_sessions').doc(user.uid);
    await loadUserPermissions();
    await initDevice();
    await loadFromNumbers();
    subscribeHistory();
    bindUI();
    await initSession();
    await loadPowerPrefs();
    bindPowerPrefsUI();
    handlePendingCall();
  });

  // ─── Permissions & team lookup ──────────────────────────────────────────
  async function loadUserPermissions() {
    try {
      const userSnap = await db.collection('users').doc(currentUser.uid).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        canViewAllCalls = (u.role === 'admin') || (u.canListenCalls === true);
      }
    } catch (e) {
      console.warn('loadUserPermissions users:', e);
    }
    if (canViewAllCalls) {
      try {
        const metaSnap = await db.collection('_meta').doc('team_members').get();
        if (metaSnap.exists) {
          const members = metaSnap.data().members || [];
          members.forEach(m => {
            if (m.firebaseUid) {
              uidToShortName[m.firebaseUid] = m.shortName || m.displayName || '?';
            }
          });
        }
      } catch (e) {
        console.warn('loadUserPermissions team_members:', e);
      }
    }
  }

  // ─── Twilio Device init ──────────────────────────────────────────────────
  async function initDevice() {
    setStatus('Récupération du token…');
    try {
      const { token } = await SalesDialerAPI.voiceToken();
      // ⚠️ NE PAS ajouter `edge: ['dublin', ...]` ici. Les credentials Twilio
      // sont US1 et toute config edge IE1 (Dublin/Frankfurt) provoque l'erreur
      // 31005 "Error sent from gateway in HANGUP" — la gateway Twilio ne sait
      // pas router cross-realm. Tentative documentée et échouée (voir mémoire
      // projet : "no edge:'dublin' in Device").
      device = new Twilio.Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        logLevel: 'warn',
      });
      device.on('registered', () => {
        setStatus('Prêt', 'ready');
        // Désactivation permanente des bips outgoing + disconnect (ergonomie).
        // Le ringtone incoming reste actif en mode normal ; il sera coupé
        // ponctuellement pendant les sessions Power Dialer.
        muteTwilioOutgoingAndDisconnect();
        // Audio routing : détection des outputs disponibles + setup du
        // bouton haut-parleur (mobile uniquement). Re-détection sur
        // deviceChange (casque branché/débranché).
        detectAudioOutputs();
        setupSpeakerButton();
        try {
          if (device.audio && typeof device.audio.on === 'function') {
            device.audio.on('deviceChange', () => {
              detectAudioOutputs();
            });
          }
        } catch (e) { console.warn('[dialer-audio] deviceChange hook failed', e); }
      });
      device.on('error', (e) => {
        console.error('[Device]', e);
        setStatus('Erreur Device', 'error');
        toast(e.message || 'Erreur Twilio Device', 'error');
      });
      device.on('incoming', handleIncoming);
      device.on('tokenWillExpire', async () => {
        try {
          const { token: t2 } = await SalesDialerAPI.voiceToken();
          device.updateToken(t2);
        } catch (e) { console.error('Token refresh failed', e); }
      });
      await device.register();
    } catch (e) {
      console.error(e);
      setStatus('Hors-ligne', 'error');
      toast(e.message || 'Impossible de démarrer le softphone', 'error');
    }
  }

  // ─── Numéros émetteurs ──────────────────────────────────────────────────
  async function loadFromNumbers() {
    try {
      const snap = await db.collection('phone_numbers')
        .where('active', '==', true).get();
      fromNumbers = [];
      snap.forEach(d => {
        const x = d.data();
        if (x.assignedTo === currentUser.uid || (x.assignedUserIds || []).includes(currentUser.uid) || x.assignedTo === 'all') {
          fromNumbers.push({ id: d.id, ...x });
        }
      });
      const sel = $('sd-from-number');
      sel.innerHTML = fromNumbers.length
        ? fromNumbers.map(n => `<option value="${n.id}">${n.friendlyName || n.phoneNumber}</option>`).join('')
        : '<option value="">Aucun numéro</option>';
    } catch (e) { console.error('loadFromNumbers', e); }
  }

  // ─── Historique call_logs ───────────────────────────────────────────────
  const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

  function subscribeHistory() {
    if (historyUnsub) historyUnsub();
    let q = db.collection('call_logs');
    if (!canViewAllCalls) {
      q = q.where('userId', '==', currentUser.uid);
    }
    q = q.orderBy('initiatedAt', 'desc').limit(50);
    historyUnsub = q.onSnapshot(snap => {
        const items = [];
        snap.forEach(d => items.push({ id: d.id, ...d.data() }));
        renderHistory(items);
      }, err => {
        console.error('history', err);
        const list = $('sd-history-list');
        if (list) {
          list.innerHTML = '<div class="sd-empty">Erreur historique (voir console)</div>';
        }
      });
  }
  function renderHistory(items) {
    const list = $('sd-history-list');
    const filtered = items.filter(c => {
      const missed = MISSED_STATUSES.has(c.status);
      if (historyFilter === 'all') return true;
      if (historyFilter === 'outbound') return c.direction === 'outbound';
      if (historyFilter === 'inbound')  return c.direction === 'inbound' && !missed;
      if (historyFilter === 'missed')   return missed;
      return true;
    });
    if (!filtered.length) { list.innerHTML = '<div class="sd-empty">Aucun appel</div>'; return; }
    list.innerHTML = filtered.map(c => {
      const missed = MISSED_STATUSES.has(c.status);
      const cls = c.direction === 'outbound' ? (missed ? 'miss' : 'out') : (missed ? 'miss' : 'in');
      const ic  = c.direction === 'outbound' ? (missed ? '✕' : '↗') : (missed ? '✕' : '↙');
      const otherPhone = c.direction === 'outbound' ? (c.toNumber || '') : (c.fromNumber || '');
      const name = c.leadNameSnapshot || c.leadName || otherPhone || '—';
      const tsRaw = c.initiatedAt || c.startedAt;
      const ts = tsRaw && tsRaw.toDate ? tsRaw.toDate() : null;
      const sub = ts ? ts.toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      const dur = c.durationSec || c.duration;
      const closerLabel = canViewAllCalls
        ? (c.userName || uidToShortName[c.userId] || (c.userId ? c.userId.substring(0, 6) : '?'))
        : '';
      const hasDetail = c.recordingStoragePath || c.transcriptionText || (c.aiAnalysis && c.aiAnalysis.summary);
      let badges = '';
      if (c.recordingStoragePath)               badges += '🎙';
      if (c.transcriptionText)                  badges += '📄';
      if (c.aiAnalysis && c.aiAnalysis.summary) badges += '🤖';
      const playBtn = hasDetail
        ? `<button class="sd-history-play" data-cid="${c.id}" title="Écouter / Voir détail" style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);color:#34d399;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer;margin-left:8px">${badges}</button>`
        : '';
      return `<div class="sd-history-item" data-lead="${c.leadId || ''}" data-phone="${otherPhone}" data-cid="${c.id}">
        <div class="sd-history-icon ${cls}">${ic}</div>
        <div class="sd-history-meta">
          <div class="sd-history-name">${name}${closerLabel ? ` <span style="font-size:10px;color:rgba(255,255,255,0.4);font-weight:500">· ${closerLabel}</span>` : ''}</div>
          <div class="sd-history-sub">${sub}${dur ? ' · ' + dur + 's' : ''}</div>
        </div>
        ${playBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('.sd-history-item').forEach(el => {
      el.addEventListener('click', (ev) => {
        const playBtn = ev.target.closest('.sd-history-play');
        if (playBtn) {
          ev.stopPropagation();
          const cid = playBtn.dataset.cid;
          if (cid && window.CallDetailModal) window.CallDetailModal.open(cid);
          return;
        }
        const lid = el.dataset.lead, ph = el.dataset.phone;
        if (lid) loadLead(lid);
        if (ph) $('sd-phone-input').value = ph;
      });
    });
  }

  // ─── UI bindings ────────────────────────────────────────────────────────
  function bindUI() {
    document.querySelectorAll('.sd-key').forEach(k => k.addEventListener('click', () => {
      const v = k.dataset.k;
      if (activeConn) { try { activeConn.sendDigits(v); } catch(e){} return; }
      $('sd-phone-input').value += v;
    }));
    $('sd-btn-clear').addEventListener('click', () => {
      const i = $('sd-phone-input');
      i.value = i.value.slice(0, -1);
    });
    $('sd-btn-call').addEventListener('click', () => placeCall());
    $('sd-btn-hangup').addEventListener('click', () => { if (activeConn) activeConn.disconnect(); });
    $('sd-btn-mute').addEventListener('click', (e) => {
      if (!activeConn) return;
      const muted = !activeConn.isMuted();
      activeConn.mute(muted);
      e.currentTarget.classList.toggle('active', muted);
    });
    $('sd-btn-speaker').addEventListener('click', async () => {
      // Toggle earpiece ↔ speaker. Persisté dans localStorage pour les
      // appels suivants. No-op sur desktop (le bouton est caché).
      const newMode = currentOutputMode === 'speaker' ? 'earpiece' : 'speaker';
      setStoredOutputPref(newMode);
      await applyOutputMode(newMode);
    });
    $('sd-btn-accept').addEventListener('click', () => { if (activeConn) activeConn.accept(); });
    $('sd-btn-reject').addEventListener('click', () => { if (activeConn) { activeConn.reject(); activeConn = null; showView('idle'); } });
    $('sd-btn-cancel-campaign').addEventListener('click', cancelCampaign);
    $('sd-btn-stop-power').addEventListener('click', () => stopAutoCampaign('manual'));
    $('sd-btn-skip-countdown').addEventListener('click', () => skipCountdown());
    $('sd-btn-stop-countdown').addEventListener('click', () => stopAutoCampaign('manual'));
    $('sd-history-refresh').addEventListener('click', () => subscribeHistory());
    document.querySelectorAll('.sd-chip').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('.sd-chip').forEach(x => x.classList.remove('sd-chip-active'));
      c.classList.add('sd-chip-active');
      historyFilter = c.dataset.filter;
      subscribeHistory();
    }));
  }

  // ─── Power Dialer : préférences utilisateur persistées ──────────────────
  // Stockées dans dialer_sessions/{uid}.powerPrefs = {
  //   enabled: bool, waveSize: 3|4|5, dingOnAnswer: bool
  // }
  async function loadPowerPrefs() {
    try {
      const snap = await sessionDocRef.get();
      const prefs = (snap.exists && snap.data().powerPrefs) || {};
      const enabled = prefs.enabled === true;
      const size = [3, 4, 5].includes(prefs.waveSize) ? prefs.waveSize : 4;
      // dingOnAnswer : défaut true si pas défini
      dingOnAnswer = (typeof prefs.dingOnAnswer === 'boolean') ? prefs.dingOnAnswer : true;
      $('sd-pref-power-enabled').checked = enabled;
      document.querySelectorAll('#sd-pref-power-size .sd-power-size-btn').forEach(b => {
        b.classList.toggle('sd-power-size-btn-active', parseInt(b.dataset.size, 10) === size);
      });
      // Si la checkbox ding existe dans le DOM (html mis à jour), reflect state
      const dingCb = $('sd-pref-ding');
      if (dingCb) dingCb.checked = dingOnAnswer;
    } catch (e) {
      console.warn('loadPowerPrefs', e);
    }
  }

  function bindPowerPrefsUI() {
    $('sd-pref-power-enabled').addEventListener('change', (e) => {
      savePowerPrefs({ enabled: e.target.checked });
    });
    document.querySelectorAll('#sd-pref-power-size .sd-power-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sd-pref-power-size .sd-power-size-btn')
          .forEach(b => b.classList.remove('sd-power-size-btn-active'));
        btn.classList.add('sd-power-size-btn-active');
        savePowerPrefs({ waveSize: parseInt(btn.dataset.size, 10) });
      });
    });
    // Toggle ding (si présent dans le HTML)
    const dingCb = $('sd-pref-ding');
    if (dingCb) {
      dingCb.addEventListener('change', (e) => {
        dingOnAnswer = e.target.checked;
        savePowerPrefs({ dingOnAnswer });
      });
    }
  }

  async function savePowerPrefs(patch) {
    try {
      const current = {};
      const enabledCb = $('sd-pref-power-enabled');
      const activeSizeBtn = document.querySelector('#sd-pref-power-size .sd-power-size-btn-active');
      const dingCb = $('sd-pref-ding');
      current.enabled = enabledCb ? enabledCb.checked : false;
      current.waveSize = activeSizeBtn ? parseInt(activeSizeBtn.dataset.size, 10) : 4;
      current.dingOnAnswer = dingCb ? dingCb.checked : dingOnAnswer;
      const merged = { ...current, ...patch };
      await sessionDocRef.set({
        powerPrefs: merged,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn('savePowerPrefs', e);
    }
  }

  // ─── Pending call/campaign (bridge CRM) ─────────────────────────────────
  function handlePendingCall() {
    try {
      const rawAuto = sessionStorage.getItem('dialer_pending_auto_campaign');
      if (rawAuto) {
        sessionStorage.removeItem('dialer_pending_auto_campaign');
        const payload = JSON.parse(rawAuto);
        if (payload && Array.isArray(payload.queue) && payload.queue.length > 0) {
          const tryStart = (retries = 10) => {
            if (device && device.state === 'registered') {
              startAutoCampaign(payload);
            } else if (retries > 0) {
              setTimeout(() => tryStart(retries - 1), 400);
            } else {
              toast('Softphone pas prêt pour Power Dialer', 'error');
            }
          };
          setTimeout(tryStart, 400);
          return;
        }
      }

      const rawCamp = sessionStorage.getItem('dialer_pending_campaign');
      if (rawCamp) {
        sessionStorage.removeItem('dialer_pending_campaign');
        const leads = JSON.parse(rawCamp);
        if (Array.isArray(leads) && leads.length > 0) {
          const tryStart = (retries = 10) => {
            if (device && device.state === 'registered') {
              window.SalesDialerStartCampaign(leads);
            } else if (retries > 0) {
              setTimeout(() => tryStart(retries - 1), 400);
            } else {
              toast('Softphone pas prêt pour la campagne', 'error');
            }
          };
          setTimeout(tryStart, 400);
          return;
        }
      }

      const raw = sessionStorage.getItem('dialer_pending_call');
      if (!raw) return;
      sessionStorage.removeItem('dialer_pending_call');
      const { leadId, phone } = JSON.parse(raw);
      if (phone) $('sd-phone-input').value = normalizePhone(phone);
      if (leadId) loadLead(leadId);
      setTimeout(() => { if (device && device.state === 'registered') placeCall(); }, 800);
    } catch (e) { console.error(e); }
  }

  // ─── Single call sortant ────────────────────────────────────────────────
  async function placeCall() {
    const phone = normalizePhone($('sd-phone-input').value);
    if (!phone || phone.length < 8) { toast('Numéro invalide', 'error'); return; }
    if (!device || device.state !== 'registered') { toast('Softphone non prêt', 'error'); return; }
    const fromId = $('sd-from-number').value;
    if (!fromId) { toast('Aucun numéro émetteur', 'error'); return; }
    try {
      if (!activeLeadId) await tryAttachLeadByPhone(phone);
      const sessionId = `${currentUser.uid}_${Date.now()}`;
      const params = { To: phone, fromNumberId: fromId, sessionId };
      if (activeLeadId) params.leadId = activeLeadId;
      activeConn = await device.connect({ params });
      bindActiveConn();
      enterInCallView(phone);
    } catch (e) {
      console.error(e);
      toast(e.message || 'Échec de l\'appel', 'error');
    }
  }

  function bindActiveConn() {
    if (!activeConn) return;
    activeConn.on('accept', (c) => {
      activeCallSid = c.parameters.CallSid;
      $('sd-incall-state').textContent = 'EN COURS';
      callStartTs = Date.now();
      startTimer();
      updateSession('incall');
      // Audio routing : applique la préférence utilisateur (earpiece par
      // défaut sur mobile, speaker sur desktop). No-op sur desktop.
      applyOutputMode(getStoredOutputPref());
      if (autoSession) {
        autoSession.connectedLeadSeenForCurrentWave = true;
        autoSession.status = 'incall';
        autoSession.stats.connected += 1;
        renderAutoStats();
      }
      // ── Embed mode : notifier la page parent qu'un lead a décroché,
      // pour qu'elle scrolle automatiquement sur sa fiche + highlight.
      try {
        if (window.IS_DIALER_EMBED && window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'dialer:lead-connected',
            leadId: activeLeadId || null,
            phone: (activeLeadData && (activeLeadData.telephone || activeLeadData.phone)) || null
          }, window.location.origin);
          window.parent.postMessage({ type: 'dialer:bubble-badge', active: true }, window.location.origin);
        }
      } catch (e) { /* ignore cross-origin */ }
    });
    activeConn.on('disconnect', () => endCall());
    activeConn.on('cancel', () => endCall());
    activeConn.on('reject', () => endCall());
    activeConn.on('error', (e) => { toast(e.message || 'Erreur appel', 'error'); endCall(); });

    // ── Monitoring qualité réseau ─────────────────────────────────────────
    // Le SDK Twilio remonte des events `warning` quand un seuil de qualité
    // est dépassé sur le RTC peer connection. Sans ces listeners, les
    // problèmes "ça coupe" / "voix hachée" / "blancs" sont invisibles côté
    // dev — on doit attendre qu'un closer signale verbalement. On log dans
    // la console pour diagnostic (pas d'indicateur UI dans ce premier jet).
    //
    // Warnings possibles (Voice SDK v2) :
    //   - high-rtt              : round-trip time élevé (réseau lent)
    //   - high-jitter           : variation latence (instable)
    //   - high-packet-loss-percentage : perte de paquets (coupures)
    //   - low-mos               : Mean Opinion Score audio dégradé
    //   - low-bytes-sent        : pas d'audio sortant détecté
    //   - low-bytes-received    : pas d'audio entrant détecté
    //   - constant-audio-input-level  : micro muet/coupé suspecté
    //   - constant-audio-output-level : speaker muet/coupé suspecté
    //
    // Pour debug : ouvrir la DevTools console pendant un appel, filtrer
    // sur "[dialer-quality]". Si on voit beaucoup de high-rtt/high-jitter,
    // c'est un problème de routage média (edge). Si packet-loss seul,
    // c'est plutôt la connexion locale du closer.
    activeConn.on('warning', (warningName, warningData) => {
      try {
        console.warn('[dialer-quality] warning →', warningName, warningData || '');
      } catch (e) { /* ignore */ }
    });
    activeConn.on('warning-cleared', (warningName) => {
      try {
        console.info('[dialer-quality] cleared →', warningName);
      } catch (e) { /* ignore */ }
    });
  }

  function enterInCallView(phone) {
    showView('incall');
    $('sd-incall-phone').textContent = phone;
    if (activeLeadData) {
      $('sd-incall-name').textContent = activeLeadData.fullName || activeLeadData.firstName || activeLeadData.nom || 'Lead';
      const init = (activeLeadData.firstName || activeLeadData.nom || '?')[0];
      $('sd-incall-avatar').textContent = (init || '?').toUpperCase();
    } else {
      $('sd-incall-name').textContent = 'Inconnu';
      $('sd-incall-avatar').textContent = '?';
    }
    $('sd-incall-state').textContent = 'CONNEXION…';
    $('sd-incall-timer').textContent = '00:00';
    const tag = $('sd-incall-power-tag');
    if (autoSession) {
      tag.style.display = 'inline-flex';
      $('sd-incall-wave').textContent = autoSession.waveIndex + 1;
    } else {
      tag.style.display = 'none';
    }
  }

  function startTimer() {
    if (callTimer) clearInterval(callTimer);
    callTimer = setInterval(() => {
      const s = Math.floor((Date.now() - callStartTs) / 1000);
      $('sd-incall-timer').textContent = fmtTimer(s);
    }, 1000);
  }

  function endCall() {
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    // ── Embed mode : notifier la page parent que l'appel est terminé
    // (retire le point rouge de la bulle réduite).
    try {
      if (window.IS_DIALER_EMBED && window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'dialer:call-ended',
          leadId: activeLeadId || null
        }, window.location.origin);
        window.parent.postMessage({ type: 'dialer:bubble-badge', active: false }, window.location.origin);
      }
    } catch (e) { /* ignore cross-origin */ }
    activeConn = null;
    activeCallSid = null;
    if (autoSession && autoSession.status === 'incall') {
      autoSession.status = 'countdown';
      showView('campaign');
      renderAutoUI();
      startCountdown(3);
      updateSession('idle');
      return;
    }
    showView('idle');
    updateSession('idle');
  }

  // ─── Incoming ───────────────────────────────────────────────────────────
  // Deux modes de traitement :
  //   A. Hors Power Dialer (appel entrant classique) : vue "incoming" + user
  //      clique Accept/Reject. Le ringtone Twilio est actif → il sonne.
  //   B. Pendant une session Power Dialer : le lead vient de décrocher, on
  //      enchaine immédiatement (ringtone déjà coupé par startAutoCampaign,
  //      on auto-accept + ding court pour signaler au closer).
  async function handleIncoming(conn) {
    activeConn = conn;
    const from = conn.parameters.From || '';
    const leadId = (conn.customParameters && conn.customParameters.get('leadId')) || '';

    if (autoSession && autoSession.status !== 'stopped') {
      // Mode B : auto-accept Power Dialer
      if (leadId) await loadLead(leadId);
      bindActiveConn();
      // Ding discret (150ms) pour alerter le closer — s'il a désactivé la
      // pref dingOnAnswer, playDing est no-op.
      playDing();
      try { conn.accept(); } catch (e) { console.warn('auto-accept failed', e); }
      enterInCallView(from);
      return;
    }

    // Mode A : flow normal
    if (leadId) await loadLead(leadId);
    $('sd-incoming-name').textContent = activeLeadData ? (activeLeadData.fullName || activeLeadData.nom || 'Lead') : 'Appel entrant';
    $('sd-incoming-phone').textContent = from;
    showView('incoming');
    bindActiveConn();
    conn.on('accept', () => enterInCallView(from));
  }

  // ─── Lead loading ───────────────────────────────────────────────────────
  async function tryAttachLeadByPhone(phone) {
    try {
      const snap = await db.collection('leads').where('telephone', '==', phone).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0];
        activeLeadId = d.id;
        activeLeadData = d.data();
        renderLead();
      }
    } catch (e) { console.error('attach lead', e); }
  }

  async function loadLead(leadId) {
    try {
      const doc = await db.collection('leads').doc(leadId).get();
      if (!doc.exists) return;
      activeLeadId = leadId;
      activeLeadData = doc.data();
      renderLead();
    } catch (e) { console.error('loadLead', e); }
  }

  function renderLead() {
    const p = $('sd-lead-panel');
    if (!activeLeadData) { p.innerHTML = '<div class="sd-empty">Aucun lead sélectionné</div>'; return; }
    const L = activeLeadData;
    const name = L.nom || '—';
    const init = (L.nom || '?').trim().charAt(0).toUpperCase() || '?';
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    p.innerHTML = `
      <div class="sd-lead-card">
        <div class="sd-lead-header">
          <div class="sd-lead-avatar">${esc(init)}</div>
          <div>
            <div class="sd-lead-name">${esc(name)}</div>
            <div class="sd-lead-sub">${esc(L.email || '')}</div>
          </div>
        </div>
        <div class="sd-lead-row"><span>Téléphone</span><span>${esc(L.telephone || '—')}</span></div>
        <div class="sd-lead-row"><span>Statut</span><span>${esc(L.status || '—')}</span></div>
        <div class="sd-lead-row"><span>Assigné</span><span>${esc(L.assignedTo || '—')}</span></div>
        <div class="sd-lead-row"><span>Tentatives</span><span>${L.dialer_attempts || 0}</span></div>
        <div class="sd-lead-notes">
          <textarea id="sd-lead-notes-ta" placeholder="Notes en temps réel…">${esc(L.notes || '')}</textarea>
        </div>
        <a class="sd-lead-link" href="sales-contact.html?id=${activeLeadId}" target="_blank">Ouvrir la fiche complète →</a>
      </div>`;
    const ta = $('sd-lead-notes-ta');
    ta.addEventListener('input', () => {
      if (leadNotesTimeout) clearTimeout(leadNotesTimeout);
      leadNotesTimeout = setTimeout(() => {
        db.collection('leads').doc(activeLeadId).update({ notes: ta.value, notesUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() })
          .catch(e => console.error('save notes', e));
      }, 600);
    });
  }

  // ─── Multi-call one-shot (ancien flow conservé) ──────────────────────────
  window.SalesDialerStartCampaign = async function (leads) {
    if (!Array.isArray(leads) || leads.length === 0) {
      toast('Aucun lead à appeler', 'error');
      return;
    }
    const valid = leads.filter(l => l && (l.phone || l.telephone));
    if (valid.length === 0) {
      toast('Aucun téléphone valide', 'error');
      return;
    }
    try {
      const fromId = $('sd-from-number').value;
      const { campaignId } = await SalesDialerAPI.multiCall(valid, fromId);
      $('sd-campaign-title').textContent = 'Campagne en cours';
      $('sd-power-banner').style.display = 'none';
      $('sd-power-progress').style.display = 'none';
      $('sd-btn-stop-power').style.display = 'none';
      $('sd-btn-cancel-campaign').style.display = 'inline-block';
      subscribeCampaign(campaignId, false);
      showView('campaign');
    } catch (e) {
      console.error(e);
      toast(e.message || 'Échec lancement campagne', 'error');
    }
  };

  function subscribeCampaign(campaignId, autoMode = false) {
    if (campaignUnsub) campaignUnsub();
    campaignUnsub = db.collection('dialer_campaigns').doc(campaignId).onSnapshot(doc => {
      if (!doc.exists) return;
      const c = doc.data();
      $('sd-campaign-status').textContent = c.status;
      $('sd-campaign-status').className = `sd-badge ${c.status}`;
      $('sd-btn-cancel-campaign').dataset.cid = campaignId;
      const html = (c.legs || []).map(l => `
        <div class="sd-leg ${l.status}">
          <div style="flex:1">
            <div class="sd-leg-name">${escapeHtml(l.leadName || '—')}</div>
            <div class="sd-leg-phone">${escapeHtml(l.phone || '')}</div>
          </div>
          <div class="sd-leg-status">${escapeHtml(l.status || '')}</div>
        </div>`).join('');
      $('sd-campaign-legs').innerHTML = html || '<div class="sd-empty">Aucun leg</div>';

      if (autoMode) {
        handleAutoCampaignUpdate(c, campaignId);
      } else {
        if (c.status === 'connected' || c.status === 'ended' || c.status === 'cancelled') {
          if (c.status !== 'connected') setTimeout(() => { if (!activeConn) showView('idle'); }, 2000);
        }
      }
    });
  }

  async function cancelCampaign() {
    const cid = $('sd-btn-cancel-campaign').dataset.cid;
    if (!cid) return;
    try {
      await SalesDialerAPI.cancelCampaign(cid);
      toast('Campagne annulée', 'success');
    } catch (e) { toast(e.message || 'Erreur annulation', 'error'); }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Power Dialer : moteur auto-campagne
  // ═══════════════════════════════════════════════════════════════════════
  async function startAutoCampaign(payload) {
    const queue = (payload.queue || []).filter(l => l && l.phone);
    if (queue.length === 0) {
      toast('Aucun lead avec téléphone valide', 'error');
      return;
    }
    const waveSize = [3, 4, 5].includes(payload.waveSize) ? payload.waveSize : 4;
    const fromId = payload.fromNumberId || $('sd-from-number').value;
    if (!fromId) {
      toast('Aucun numéro émetteur', 'error');
      return;
    }
    if (fromId && $('sd-from-number').value !== fromId) {
      $('sd-from-number').value = fromId;
    }

    autoSession = {
      id: uuid(),
      queue,
      cursor: 0,
      waveSize,
      waveIndex: 0,
      totalWaves: Math.ceil(queue.length / waveSize),
      currentCampaignId: null,
      fromNumberId: fromId,
      status: 'running',
      stats: { dialed: 0, connected: 0, noAnswer: 0 },
      countdownTimer: null,
      countdownDeadline: 0,
      connectedLeadSeenForCurrentWave: false,
    };

    // Coupe le ringtone incoming : dès qu'un lead décroche on auto-accept,
    // pas de sonnerie agressive. Sera restauré par stopAutoCampaign().
    muteTwilioIncoming();

    $('sd-campaign-title').textContent = 'Power Dialer';
    $('sd-power-banner').style.display = 'flex';
    $('sd-pw-wavesize').textContent = waveSize;
    $('sd-power-progress').style.display = 'block';
    $('sd-btn-stop-power').style.display = 'inline-block';
    $('sd-btn-cancel-campaign').style.display = 'none';
    renderAutoStats();
    showView('campaign');

    toast(`🚀 Power Dialer démarré · ${queue.length} leads · vagues de ${waveSize}`, 'success');
    await launchNextWave();
  }

  async function launchNextWave() {
    if (!autoSession || autoSession.status === 'stopped') return;

    if (autoSession.cursor >= autoSession.queue.length) {
      finishAutoCampaign('completed');
      return;
    }

    const start = autoSession.cursor;
    const end = Math.min(start + autoSession.waveSize, autoSession.queue.length);
    const slice = autoSession.queue.slice(start, end);
    autoSession.cursor = end;
    autoSession.connectedLeadSeenForCurrentWave = false;
    autoSession.status = 'running';

    const leads = slice.map(l => ({
      id: l.leadId || null,
      leadId: l.leadId || null,
      name: l.leadName || null,
      leadName: l.leadName || null,
      phone: l.phone,
    }));

    renderAutoStats();

    try {
      const resp = await SalesDialerAPI.multiCall(leads, autoSession.fromNumberId, {
        autoCampaignId: autoSession.id,
        waveIndex: autoSession.waveIndex,
        queueSize: autoSession.queue.length,
      });
      autoSession.currentCampaignId = resp.campaignId;
      autoSession.stats.dialed += slice.length;
      renderAutoStats();
      subscribeCampaign(resp.campaignId, true);
    } catch (e) {
      console.error('[autoCampaign] launchNextWave failed:', e);
      toast(e.message || 'Échec lancement de la vague', 'error');
      if (e.status === 400 || e.status === 401 || e.status === 403) {
        finishAutoCampaign('error');
      } else {
        setTimeout(() => {
          if (autoSession && autoSession.status !== 'stopped') {
            autoSession.waveIndex += 1;
            launchNextWave();
          }
        }, 2000);
      }
    }
  }

  function handleAutoCampaignUpdate(c, campaignId) {
    if (!autoSession || autoSession.id !== (c.autoCampaignId || autoSession.id)) return;
    if (autoSession.currentCampaignId !== campaignId) return;

    if (c.status === 'ended' && !c.connectedCallSid && autoSession.status === 'running') {
      const noAns = (c.legs || []).filter(l =>
        ['no-answer','busy','failed','canceled'].includes(l.status)
      ).length;
      autoSession.stats.noAnswer += noAns;
      autoSession.waveIndex += 1;
      autoSession.currentCampaignId = null;
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      renderAutoStats();
      if (autoSession.cursor < autoSession.queue.length) {
        launchNextWave();
      } else {
        finishAutoCampaign('completed');
      }
      return;
    }

    if (c.status === 'ended' && c.connectedCallSid && autoSession.status === 'countdown') {
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      autoSession.currentCampaignId = null;
    }

    if (c.status === 'cancelled') {
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      autoSession.currentCampaignId = null;
    }
  }

  function startCountdown(seconds) {
    if (!autoSession) return;
    if (autoSession.cursor >= autoSession.queue.length) {
      finishAutoCampaign('completed');
      return;
    }
    const deadline = Date.now() + seconds * 1000;
    autoSession.countdownDeadline = deadline;
    autoSession.status = 'countdown';

    const overlay = $('sd-countdown-overlay');
    const num = $('sd-countdown-number');
    const prog = $('sd-countdown-progress');
    const hint = $('sd-countdown-next-size');
    overlay.style.display = 'flex';

    const nextSize = Math.min(autoSession.waveSize, autoSession.queue.length - autoSession.cursor);
    hint.textContent = nextSize;

    const CIRC = 289.03;
    prog.style.transition = 'none';
    prog.style.strokeDashoffset = '0';
    void prog.getBoundingClientRect();
    prog.style.transition = `stroke-dashoffset ${seconds}s linear`;
    prog.style.strokeDashoffset = String(CIRC);

    if (autoSession.countdownTimer) clearInterval(autoSession.countdownTimer);
    const tick = () => {
      if (!autoSession) return;
      const left = Math.ceil((autoSession.countdownDeadline - Date.now()) / 1000);
      if (left <= 0) {
        num.textContent = '0';
        clearInterval(autoSession.countdownTimer);
        autoSession.countdownTimer = null;
        endCountdown(true);
      } else {
        num.textContent = String(left);
      }
    };
    tick();
    autoSession.countdownTimer = setInterval(tick, 100);
  }

  function skipCountdown() {
    if (!autoSession) return;
    endCountdown(true);
  }

  function endCountdown(launch) {
    if (!autoSession) return;
    if (autoSession.countdownTimer) {
      clearInterval(autoSession.countdownTimer);
      autoSession.countdownTimer = null;
    }
    $('sd-countdown-overlay').style.display = 'none';
    if (launch && autoSession.status !== 'stopped') {
      autoSession.waveIndex += 1;
      autoSession.status = 'running';
      launchNextWave();
    }
  }

  async function stopAutoCampaign(reason) {
    if (!autoSession) return;
    const session = autoSession;
    session.status = 'stopped';

    if (session.countdownTimer) {
      clearInterval(session.countdownTimer);
      session.countdownTimer = null;
    }
    $('sd-countdown-overlay').style.display = 'none';

    if (session.currentCampaignId) {
      try {
        await SalesDialerAPI.cancelCampaign(session.currentCampaignId);
      } catch (e) {
        console.warn('[autoCampaign] cancel wave failed:', e.message);
      }
    }
    if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }

    // Restaure le ringtone incoming pour les appels normaux après la session
    restoreTwilioIncoming();

    const msg = reason === 'manual'
      ? `🛑 Power Dialer arrêté · ${session.stats.dialed}/${session.queue.length} appelés · ${session.stats.connected} décrochés`
      : `Power Dialer terminé · ${session.stats.dialed} appelés · ${session.stats.connected} décrochés`;
    toast(msg, 'success');

    autoSession = null;
    $('sd-power-banner').style.display = 'none';
    $('sd-power-progress').style.display = 'none';
    $('sd-btn-stop-power').style.display = 'none';
    $('sd-btn-cancel-campaign').style.display = 'inline-block';
    if (!activeConn) showView('idle');
  }

  function finishAutoCampaign(reason) {
    stopAutoCampaign(reason === 'completed' ? 'completed' : 'error');
  }

  function renderAutoUI() {
    if (!autoSession) return;
    $('sd-campaign-title').textContent = 'Power Dialer';
    $('sd-power-banner').style.display = 'flex';
    $('sd-pw-wavesize').textContent = autoSession.waveSize;
    $('sd-power-progress').style.display = 'block';
    $('sd-btn-stop-power').style.display = 'inline-block';
    $('sd-btn-cancel-campaign').style.display = 'none';
    renderAutoStats();
  }

  function renderAutoStats() {
    if (!autoSession) return;
    $('sd-pw-wave').textContent = autoSession.waveIndex + 1;
    $('sd-pw-total-waves').textContent = autoSession.totalWaves;
    $('sd-pw-dialed').textContent = autoSession.stats.dialed;
    $('sd-pw-queue-size').textContent = autoSession.queue.length;
    $('sd-pw-connected').textContent = autoSession.stats.connected;
    const pct = autoSession.queue.length > 0
      ? Math.round((autoSession.stats.dialed / autoSession.queue.length) * 100)
      : 0;
    $('sd-pw-bar').style.width = pct + '%';
  }

  // ─── Session monitoring ─────────────────────────────────────────────────
  async function initSession() {
    try {
      await sessionDocRef.set({
        userId: currentUser.uid,
        status: 'idle',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      window.addEventListener('beforeunload', () => {
        if (autoSession && autoSession.currentCampaignId) {
          try {
            const blob = new Blob([JSON.stringify({ campaignId: autoSession.currentCampaignId })], { type: 'application/json' });
            navigator.sendBeacon('/api/dialer-cancel-campaign', blob);
          } catch (_) {}
        }
        // Par bonne hygiène, restaurer le ringtone avant fermeture (au cas où
        // l'onglet serait réutilisé via bfcache)
        restoreTwilioIncoming();
        sessionDocRef.delete().catch(()=>{});
      });
    } catch (e) { console.error('initSession', e); }
  }
  function updateSession(status) {
    if (!sessionDocRef) return;
    sessionDocRef.set({
      status,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(()=>{});
  }
})();
