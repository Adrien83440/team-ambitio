/**
 * sales-dialer.js — Dialer Ambitio (v2 Ringover)
 * API-initiated click-to-call via Ringover + Firestore live (call_logs, dialer_campaigns)
 * Bridge CRM via sessionStorage.dialer_pending_call / dialer_pending_campaign
 *                                  / dialer_pending_auto_campaign (Power Dialer)
 *
 * Modèle d'appel Ringover :
 *   L'agent clique → API Ringover sonne son app → il décroche → Ringover compose le lead.
 *   L'état de l'appel est tracé via webhooks Ringover → webhook_inbox → Cloud Function
 *   → dialer_campaigns/{id} onSnapshot drive l'UI (plus de Twilio.Device côté browser).
 *
 * Power Dialer :
 *   Une session auto = queue complète [leads], 1 lead par vague (Ringover séquentiel).
 *   Chaque vague crée un doc dialer_campaigns avec autoCampaignId + waveIndex.
 *   Quand la vague se termine (HANGUP reçu OU no-answer) :
 *     - si connecté + raccroché → countdown 3s puis vague suivante
 *     - si pas de décroche      → enchaînement immédiat
 */
(function () {
  'use strict';

  const db = firebase.firestore();
  let currentUser = null;
  // Ringover : pas de Twilio.Device — appel dans l'app Ringover
  let activeCampaignConnected = false;
  let activeCampaignCallId = null;
  let activeCampaignIdActive = null;
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

  // ─── Screen Wake Lock (empêcher la mise en veille en cours d'appel) ──────
  // Sur Android Chrome (et iOS 16.4+), quand l'écran s'éteint, l'onglet est
  // mis en arrière-plan et le flux WebRTC est dégradé voire coupé. L'usager
  // doit alors rallumer l'écran pour récupérer l'audio. La Screen Wake Lock
  // API permet de demander explicitement à l'OS de garder l'écran allumé
  // tant qu'un appel est actif.
  //
  // Cycle de vie :
  // - acquireWakeLock() au démarrage d'un appel (sortant accepté ou entrant
  //   décroché)
  // - releaseWakeLock() à la fin de l'appel (endCall, cancel, reject)
  // - Auto-relâché par le navigateur quand l'onglet passe en background
  //   (swipe app, lock screen). On le re-demande au retour foreground via
  //   l'event visibilitychange tant qu'un appel reste actif.
  //
  // Compatibilité : Chrome Android 84+, Safari iOS 16.4+, Chrome/Edge/Firefox
  // desktop. Sur les navigateurs non supportés, navigator.wakeLock est
  // undefined et on no-op silencieusement (pas d'impact).
  let wakeLockSentinel = null;
  function hasActiveCall() {
    return activeCampaignConnected;
  }
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLockSentinel) return; // déjà actif
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        // L'OS ou le navigateur peut relâcher (par exemple si onglet caché).
        // On retient l'info pour permettre le ré-acquittement au retour.
        console.info('[dialer-wakelock] released by system');
        wakeLockSentinel = null;
      });
      console.info('[dialer-wakelock] acquired');
    } catch (err) {
      console.warn('[dialer-wakelock] request failed', err);
      wakeLockSentinel = null;
    }
  }
  async function releaseWakeLock() {
    if (!wakeLockSentinel) return;
    try {
      await wakeLockSentinel.release();
      console.info('[dialer-wakelock] released');
    } catch (err) {
      console.warn('[dialer-wakelock] release failed', err);
    } finally {
      wakeLockSentinel = null;
    }
  }
  // Le wake lock est auto-relâché quand l'onglet passe en background. Au
  // retour foreground, si un appel est toujours actif, on le re-demande.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hasActiveCall() && !wakeLockSentinel) {
      acquireWakeLock();
    }
  });

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
      $('sd-phone-input').value += k.dataset.k;
    }));
    $('sd-btn-clear').addEventListener('click', () => {
      const i = $('sd-phone-input');
      i.value = i.value.slice(0, -1);
    });
    $('sd-btn-call').addEventListener('click', () => ringoverPlaceCall());
    $('sd-btn-hangup').addEventListener('click', async () => {
      const cid = $('sd-btn-hangup').dataset.cid;
      try {
        await SalesDialerAPI.hangupCall({ campaignId: cid || activeCampaignIdActive, callId: activeCampaignCallId || undefined });
      } catch (e) { toast(e.message || 'Erreur raccrocher', 'error'); }
    });
    // Mute géré dans l'app Ringover (pas de contrôle API)
    const muteBtn = $('sd-btn-mute');
    if (muteBtn) muteBtn.style.opacity = '0.4';
    // Speaker routing géré par l'OS/Ringover app
    const speakerBtn = $('sd-btn-speaker');
    if (speakerBtn) speakerBtn.style.display = 'none';
    // Accept/Reject : appels entrants gérés dans l'app Ringover
    // Les boutons sont conservés dans le DOM mais cachés
    const acceptBtn = $('sd-btn-accept'); if (acceptBtn) acceptBtn.style.display = 'none';
    const rejectBtn = $('sd-btn-reject'); if (rejectBtn) rejectBtn.style.display = 'none';
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
          // Ringover : pas de Device à attendre
          setTimeout(() => startAutoCampaign(payload), 400);
          return;
        }
      }

      const rawCamp = sessionStorage.getItem('dialer_pending_campaign');
      if (rawCamp) {
        sessionStorage.removeItem('dialer_pending_campaign');
        const leads = JSON.parse(rawCamp);
        if (Array.isArray(leads) && leads.length > 0) {
          setTimeout(() => window.SalesDialerStartCampaign(leads), 400);
          return;
        }
      }

      const raw = sessionStorage.getItem('dialer_pending_call');
      if (!raw) return;
      sessionStorage.removeItem('dialer_pending_call');
      const { leadId, phone } = JSON.parse(raw);
      if (phone) $('sd-phone-input').value = normalizePhone(phone);
      if (leadId) loadLead(leadId);
      setTimeout(() => ringoverPlaceCall(), 800);
    } catch (e) { console.error(e); }
  }

  // ─── Single call sortant (Ringover click-to-call) ─────────────────────────
  async function ringoverPlaceCall() {
    const phone = normalizePhone($('sd-phone-input').value);
    if (!phone || phone.length < 8) { toast('Numéro invalide', 'error'); return; }
    try {
      if (!activeLeadId) await tryAttachLeadByPhone(phone);
      const resp = await SalesDialerAPI.ringoverCall({
        leadId: activeLeadId || null,
        phone,
        leadName: activeLeadData ? (activeLeadData.nom || activeLeadData.fullName || null) : null,
      });
      // subscribeCampaign gère la transition vers la vue in-call via onSnapshot
      activeCampaignIdActive = resp.campaignId;
      $('sd-campaign-title').textContent = 'Appel en cours';
      $('sd-btn-cancel-campaign').style.display = 'inline-block';
      $('sd-btn-cancel-campaign').dataset.cid = resp.campaignId;
      subscribeCampaign(resp.campaignId, false);
      showView('campaign');
    } catch (e) {
      console.error(e);
      toast(e.message || "Échec de l'appel", 'error');
    }
  }

    function enterInCallView(phone) {
    showView('incall');
    $('sd-incall-phone').textContent = phone || '—';
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

  function startTimer() { startTimerFromNow(); }
  function startTimerFromNow(startMs) {
    if (callTimer) clearInterval(callTimer);
    callStartTs = startMs || Date.now();
    callTimer = setInterval(() => {
      const s = Math.floor((Date.now() - callStartTs) / 1000);
      $('sd-incall-timer').textContent = fmtTimer(s);
    }, 1000);
  }

  function endCall() {
    activeCampaignConnected = false;
    activeCampaignCallId = null;
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    // Libère le wake lock écran (l'appel est terminé, on laisse le téléphone
    // se mettre en veille normalement).
    releaseWakeLock();
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
      const { campaignId } = await SalesDialerAPI.ringoverCall(valid[0]);
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
    let wasConnected = false; // tracker local pour détecter la transition connected→ended

    campaignUnsub = db.collection('dialer_campaigns').doc(campaignId).onSnapshot(doc => {
      if (!doc.exists) return;
      const c = doc.data();

      $('sd-campaign-status').textContent = c.status;
      $('sd-campaign-status').className = `sd-badge ${c.status}`;
      $('sd-btn-cancel-campaign').dataset.cid = campaignId;
      $('sd-btn-hangup').dataset.cid = campaignId;

      const html = (c.legs || []).map(l => `
        <div class="sd-leg ${l.status}">
          <div style="flex:1">
            <div class="sd-leg-name">${escapeHtml(l.leadName || '—')}</div>
            <div class="sd-leg-phone">${escapeHtml(l.phone || '')}</div>
          </div>
          <div class="sd-leg-status">${escapeHtml(l.status || '')}</div>
        </div>`).join('');
      $('sd-campaign-legs').innerHTML = html || '<div class="sd-empty">Aucun leg</div>';

      // ── Transition vers l'état "connected" (appel décroché) ────────────────
      if (c.status === 'connected' && !wasConnected) {
        wasConnected = true;
        activeCampaignConnected = true;
        activeCampaignCallId = c.connectedCallId || c.connectedCallSid || (c.legs && c.legs[0] && c.legs[0].callId) || null;
        activeCampaignIdActive = campaignId;

        // Charger le lead connecté
        const leg = c.legs && c.legs[0];
        const phone = leg ? (leg.phone || '') : '';
        if (leg && leg.leadId && leg.leadId !== activeLeadId) loadLead(leg.leadId);

        if (autoSession) {
          autoSession.connectedLeadSeenForCurrentWave = true;
          autoSession.status = 'incall';
          autoSession.stats.connected += 1;
          renderAutoStats();
        }
        enterInCallView(phone);
        startTimerFromNow();
        acquireWakeLock();
        updateSession('incall');

        // Embed mode
        try {
          if (window.IS_DIALER_EMBED && window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'dialer:lead-connected', leadId: activeLeadId || null, phone }, window.location.origin);
            window.parent.postMessage({ type: 'dialer:bubble-badge', active: true }, window.location.origin);
          }
        } catch (e) {}
      }

      // ── Transition vers la fin de l'appel ─────────────────────────────────
      if ((c.status === 'ended' || c.status === 'cancelled') && wasConnected) {
        wasConnected = false;
        endCall();
        return; // endCall gère la suite (countdown en auto mode, showView idle sinon)
      }

      if (autoMode) {
        handleAutoCampaignUpdate(c, campaignId);
      } else {
        // Mode one-shot : retour idle si terminé sans connexion
        if ((c.status === 'ended' || c.status === 'cancelled') && !activeCampaignConnected) {
          setTimeout(() => showView('idle'), 1500);
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
    // Ringover : 1 seul appel à la fois (API séquentielle)
    const waveSize = 1;
    const fromId = payload.fromNumberId || null;

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

    // Ringover : 1 seul lead par appel (API séquentielle)
    const lead = slice[0];
    renderAutoStats();

    try {
      const resp = await SalesDialerAPI.ringoverCall({
        leadId: lead.leadId || null,
        phone: lead.phone,
        leadName: lead.leadName || null,
      }, {
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

    const msg = reason === 'manual'
      ? `🛑 Power Dialer arrêté · ${session.stats.dialed}/${session.queue.length} appelés · ${session.stats.connected} décrochés`
      : `Power Dialer terminé · ${session.stats.dialed} appelés · ${session.stats.connected} décrochés`;
    toast(msg, 'success');

    autoSession = null;
    $('sd-power-banner').style.display = 'none';
    $('sd-power-progress').style.display = 'none';
    $('sd-btn-stop-power').style.display = 'none';
    $('sd-btn-cancel-campaign').style.display = 'inline-block';
    if (!activeCampaignConnected) showView('idle');
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
