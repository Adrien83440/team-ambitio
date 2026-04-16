/**
 * sales-dialer.js — Softphone Ambitio
 * Twilio Voice SDK browser + Firestore live (call_logs, dialer_campaigns, dialer_sessions)
 * Bridge CRM via sessionStorage.dialer_pending_call / dialer_pending_campaign
 *                                  / dialer_pending_auto_campaign (Power Dialer)
 *
 * Power Dialer (nouveau) :
 *   Une session auto = queue complète [leads] + waveSize (3/4/5).
 *   Chaque vague crée un doc dialer_campaigns classique (même format),
 *   relié par un champ autoCampaignId (UUID client) + waveIndex.
 *   Quand la vague se termine (connectedCallSid raccroché OU tous no-answer) :
 *     - si connecté + raccroché → countdown 3s puis vague suivante
 *     - si aucun décroche       → enchainement immédiat (pas de countdown)
 *   Stop = cancel vague en cours + reset state + toast récap.
 *   Fermeture onglet = auto-stop (les legs Twilio timeout seuls à 25s).
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
  // Permissions : true = voir tous les appels de l'équipe (admin OR users/{uid}.canListenCalls == true)
  //               false = voir seulement ses propres appels
  let canViewAllCalls = false;
  // Map firebaseUid → shortName pour afficher le nom du closer sur chaque item
  // d'historique quand on est en mode "voir tout"
  let uidToShortName = {};

  // ─── État Power Dialer ───────────────────────────────────────────────────
  // Session auto active : null quand aucune session, sinon objet complet.
  let autoSession = null;
  // Forme :
  //   {
  //     id: 'uuid-client',           autoCampaignId partagé entre vagues
  //     queue: [{leadId, leadName, phone}],
  //     cursor: 0,                   prochain index à lancer
  //     waveSize: 5,
  //     waveIndex: 0,                vague en cours (0-based)
  //     totalWaves: 4,               ceil(queue.length / waveSize)
  //     currentCampaignId: null,     doc id de la vague en cours
  //     fromNumberId: 'PNxxx',
  //     status: 'running'|'countdown'|'incall'|'stopped',
  //     stats: { dialed: 0, connected: 0, noAnswer: 0 },
  //     countdownTimer: null,
  //     countdownDeadline: 0,
  //     connectedLeadSeenForCurrentWave: false,
  //   }

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
  // UUID v4 simple pour autoCampaignId côté client
  const uuid = () => ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );

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
  // Détermine si l'user courant peut voir tous les appels de l'équipe
  // (admin OR users/{uid}.canListenCalls == true) et charge la map
  // firebaseUid → shortName depuis _meta/team_members pour afficher le
  // nom du closer sur chaque item d'historique en mode "voir tout".
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
    // Charge la map team_members (seulement si on est en mode "voir tout"
    // sinon ça sert à rien)
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
      device = new Twilio.Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        logLevel: 'warn',
      });
      device.on('registered', () => setStatus('Prêt', 'ready'));
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
  // Schéma canonique écrit par api/twilio-voice.js, api/twilio-inbound.js,
  // Functions/handlers/twilioHandlers.js :
  //   initiatedAt, ringingAt, answeredAt, endedAt, durationSec,
  //   direction ('outbound'|'inbound'), status ('initiated'|'ringing'|
  //   'in-progress'|'completed'|'busy'|'no-answer'|'failed'|'canceled'),
  //   fromNumber, toNumber, leadNameSnapshot, leadId, userId
  const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

  function subscribeHistory() {
    if (historyUnsub) historyUnsub();
    // Query conditionnelle : admin/canListenCalls voient tous les appels,
    // sinon seulement les leurs. L'index Firestore nécessaire diffère :
    //   - mode "mes appels"   → composite (userId ASC, initiatedAt DESC)
    //   - mode "tous"         → index simple automatique sur initiatedAt DESC
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
          // Erreur la plus probable : index composite (userId, initiatedAt desc) manquant.
          // Firebase renvoie un lien de création directe dans err.message.
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
      // Pour outbound l'interlocuteur est toNumber, pour inbound fromNumber
      const otherPhone = c.direction === 'outbound' ? (c.toNumber || '') : (c.fromNumber || '');
      const name = c.leadNameSnapshot || c.leadName || otherPhone || '—';
      const tsRaw = c.initiatedAt || c.startedAt; // startedAt = fallback legacy
      const ts = tsRaw && tsRaw.toDate ? tsRaw.toDate() : null;
      const sub = ts ? ts.toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      const dur = c.durationSec || c.duration;
      // En mode "voir tout" (admin), affiche aussi qui a fait l'appel.
      // Résout d'abord depuis userName persisté, sinon map uidToShortName.
      const closerLabel = canViewAllCalls
        ? (c.userName || uidToShortName[c.userId] || (c.userId ? c.userId.substring(0, 6) : '?'))
        : '';
      // Badge détail : c.id = callSid = doc ID de call_logs. On montre l'icône dès
      // qu'il y a quelque chose d'exploitable (recording, transcript ou analyse).
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
        // Click sur le bouton play → ouvre le modal détail au lieu de charger le lead
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
    $('sd-btn-accept').addEventListener('click', () => { if (activeConn) activeConn.accept(); });
    $('sd-btn-reject').addEventListener('click', () => { if (activeConn) { activeConn.reject(); activeConn = null; showView('idle'); } });
    // Bouton "Annuler" (mode one-shot) OU "Stop Power" (mode auto)
    $('sd-btn-cancel-campaign').addEventListener('click', cancelCampaign);
    $('sd-btn-stop-power').addEventListener('click', () => stopAutoCampaign('manual'));
    // Boutons overlay countdown
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
  // Stockées dans dialer_sessions/{uid}.powerPrefs = {enabled, waveSize}.
  // La bar CRM (dialer-bridge.js) lit et écrit la même structure, ce qui
  // permet "les deux" endroits de rester synchronisés.
  async function loadPowerPrefs() {
    try {
      const snap = await sessionDocRef.get();
      const prefs = (snap.exists && snap.data().powerPrefs) || {};
      const enabled = prefs.enabled === true;
      const size = [3, 4, 5].includes(prefs.waveSize) ? prefs.waveSize : 4;
      $('sd-pref-power-enabled').checked = enabled;
      document.querySelectorAll('#sd-pref-power-size .sd-power-size-btn').forEach(b => {
        b.classList.toggle('sd-power-size-btn-active', parseInt(b.dataset.size, 10) === size);
      });
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
  }

  async function savePowerPrefs(patch) {
    try {
      // merge partiel dans powerPrefs
      const current = {};
      const enabledCb = $('sd-pref-power-enabled');
      const activeSizeBtn = document.querySelector('#sd-pref-power-size .sd-power-size-btn-active');
      current.enabled = enabledCb ? enabledCb.checked : false;
      current.waveSize = activeSizeBtn ? parseInt(activeSizeBtn.dataset.size, 10) : 4;
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
      // 1. Campagne Power Dialer (nouveau flow) ?
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

      // 2. Campagne multi-call one-shot pending ? (ancien format)
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

      // 3. Appel single pending ?
      const raw = sessionStorage.getItem('dialer_pending_call');
      if (!raw) return;
      sessionStorage.removeItem('dialer_pending_call');
      const { leadId, phone } = JSON.parse(raw);
      if (phone) $('sd-phone-input').value = normalizePhone(phone);
      if (leadId) loadLead(leadId);
      // auto-call après 800ms si Device prêt
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
      // Résolution lead si pas déjà chargé
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
      // Marque la vague auto comme "connectée" pour déclencher le countdown
      // à la fin de l'appel plutôt que l'enchainement direct
      if (autoSession) {
        autoSession.connectedLeadSeenForCurrentWave = true;
        autoSession.status = 'incall';
        autoSession.stats.connected += 1;
        renderAutoStats();
      }
    });
    activeConn.on('disconnect', () => endCall());
    activeConn.on('cancel', () => endCall());
    activeConn.on('reject', () => endCall());
    activeConn.on('error', (e) => { toast(e.message || 'Erreur appel', 'error'); endCall(); });
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
    // Badge Power Dialer visible pendant le pitch
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
    activeConn = null;
    activeCallSid = null;
    // Si Power Dialer actif et qu'on vient de raccrocher le leg connecté :
    // afficher la vue campagne + déclencher le countdown 3s.
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
  async function handleIncoming(conn) {
    activeConn = conn;
    const from = conn.parameters.From || '';
    const leadId = (conn.customParameters && conn.customParameters.get('leadId')) || '';
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
    // Champs canoniques des docs leads/* :
    //   nom (string unique, pas firstName/lastName)
    //   email, telephone
    //   status (pas "statut")
    //   assignedTo (slug team member)
    //   dialer_attempts (maintenu par le pipeline)
    //   notes (champ libre dédié au dialer)
    const name = L.nom || '—';
    const init = (L.nom || '?').trim().charAt(0).toUpperCase() || '?';
    // Helper escape HTML pour éviter les injections dans les valeurs lead
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

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Multi-call one-shot (ancien flow, conservé) ───────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  window.SalesDialerStartCampaign = async function (leads) {
    // Garde stricte : refuse array vide / non-array
    if (!Array.isArray(leads) || leads.length === 0) {
      toast('Aucun lead à appeler', 'error');
      return;
    }
    // Filtre supplémentaire : exiger au moins un téléphone valide
    const valid = leads.filter(l => l && (l.phone || l.telephone));
    if (valid.length === 0) {
      toast('Aucun téléphone valide', 'error');
      return;
    }
    try {
      const fromId = $('sd-from-number').value;
      const { campaignId } = await SalesDialerAPI.multiCall(valid, fromId);
      // Mode one-shot : affichage simple, stats masquées, bouton Stop caché
      $('sd-campaign-title').textContent = 'Campagne en cours';
      $('sd-power-banner').style.display = 'none';
      $('sd-power-progress').style.display = 'none';
      $('sd-btn-stop-power').style.display = 'none';
      $('sd-btn-cancel-campaign').style.display = 'inline-block';
      subscribeCampaign(campaignId, /* autoMode */ false);
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

  // Helper d'échappement HTML réutilisé pour les legs
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Power Dialer : moteur auto-campagne ───────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════

  // Démarre une session Power Dialer.
  //   payload = {queue: [{leadId, leadName, phone}], waveSize: 3|4|5, fromNumberId?}
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
    // Aligne le select UI sur le fromNumberId fourni
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

    // Affiche la vue campagne en mode Power
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

  // Lance la vague suivante. Prend waveSize leads à partir du cursor.
  async function launchNextWave() {
    if (!autoSession || autoSession.status === 'stopped') return;

    // Queue épuisée ?
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

    // Payload leads pour l'API (format attendu par dialer-multi-call.js)
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
      subscribeCampaign(resp.campaignId, /* autoMode */ true);
    } catch (e) {
      console.error('[autoCampaign] launchNextWave failed:', e);
      toast(e.message || 'Échec lancement de la vague', 'error');
      // On tente de skipper cette vague et passer à la suivante après 2s,
      // sauf si l'erreur est fatale (numéro, auth, etc.) → dans ce cas on stoppe
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

  // Callback invoqué à chaque update Firestore de la vague en cours
  // (via subscribeCampaign en autoMode).
  function handleAutoCampaignUpdate(c, campaignId) {
    if (!autoSession || autoSession.id !== (c.autoCampaignId || autoSession.id)) return;
    if (autoSession.currentCampaignId !== campaignId) return;

    // Cas 1 : vague se termine sans connecté → enchainement direct
    if (c.status === 'ended' && !c.connectedCallSid && autoSession.status === 'running') {
      // Décompte des no-answer
      const noAns = (c.legs || []).filter(l =>
        ['no-answer','busy','failed','canceled'].includes(l.status)
      ).length;
      autoSession.stats.noAnswer += noAns;
      autoSession.waveIndex += 1;
      autoSession.currentCampaignId = null;
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      renderAutoStats();
      // Enchainement immédiat
      if (autoSession.cursor < autoSession.queue.length) {
        launchNextWave();
      } else {
        finishAutoCampaign('completed');
      }
      return;
    }

    // Cas 2 : vague se termine après conversation (connectedCallSid + status='ended')
    //         → le countdown a déjà été déclenché par endCall() côté browser
    if (c.status === 'ended' && c.connectedCallSid && autoSession.status === 'countdown') {
      // On se désabonne du doc campaign (on en ouvrira un nouveau pour la vague +1)
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      autoSession.currentCampaignId = null;
    }

    // Cas 3 : vague annulée (par stopAutoCampaign)
    if (c.status === 'cancelled') {
      if (campaignUnsub) { campaignUnsub(); campaignUnsub = null; }
      autoSession.currentCampaignId = null;
    }
  }

  // ─── Countdown 3s entre deux vagues ─────────────────────────────────────
  function startCountdown(seconds) {
    if (!autoSession) return;
    // Si queue déjà épuisée → pas de countdown, on finit direct
    if (autoSession.cursor >= autoSession.queue.length) {
      finishAutoCampaign('completed');
      return;
    }
    const deadline = Date.now() + seconds * 1000;
    autoSession.countdownDeadline = deadline;
    autoSession.status = 'countdown';

    // Affiche l'overlay
    const overlay = $('sd-countdown-overlay');
    const num = $('sd-countdown-number');
    const prog = $('sd-countdown-progress');
    const hint = $('sd-countdown-next-size');
    overlay.style.display = 'flex';

    // Prochaine vague taille
    const nextSize = Math.min(autoSession.waveSize, autoSession.queue.length - autoSession.cursor);
    hint.textContent = nextSize;

    // Reset animation du cercle (2π × 46 = 289.03)
    const CIRC = 289.03;
    prog.style.transition = 'none';
    prog.style.strokeDashoffset = '0';
    // Force reflow pour que la transition reparte proprement
    void prog.getBoundingClientRect();
    prog.style.transition = `stroke-dashoffset ${seconds}s linear`;
    prog.style.strokeDashoffset = String(CIRC);

    // Timer décompte affichage
    if (autoSession.countdownTimer) clearInterval(autoSession.countdownTimer);
    const tick = () => {
      if (!autoSession) return;
      const left = Math.ceil((autoSession.countdownDeadline - Date.now()) / 1000);
      if (left <= 0) {
        num.textContent = '0';
        clearInterval(autoSession.countdownTimer);
        autoSession.countdownTimer = null;
        endCountdown(/* launch */ true);
      } else {
        num.textContent = String(left);
      }
    };
    tick();
    autoSession.countdownTimer = setInterval(tick, 100);
  }

  function skipCountdown() {
    if (!autoSession) return;
    endCountdown(/* launch */ true);
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

  // ─── Stop / fin Power Dialer ────────────────────────────────────────────
  async function stopAutoCampaign(reason) {
    if (!autoSession) return;
    const session = autoSession;
    session.status = 'stopped';

    // Coupe le countdown si en cours
    if (session.countdownTimer) {
      clearInterval(session.countdownTimer);
      session.countdownTimer = null;
    }
    $('sd-countdown-overlay').style.display = 'none';

    // Annule la vague en cours si elle existe
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
    // Reset UI mode one-shot par défaut
    $('sd-power-banner').style.display = 'none';
    $('sd-power-progress').style.display = 'none';
    $('sd-btn-stop-power').style.display = 'none';
    $('sd-btn-cancel-campaign').style.display = 'inline-block';
    if (!activeConn) showView('idle');
  }

  function finishAutoCampaign(reason) {
    // Fin propre (queue épuisée ou erreur fatale)
    stopAutoCampaign(reason === 'completed' ? 'completed' : 'error');
  }

  // ─── Rendu UI Power Dialer ──────────────────────────────────────────────
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
        // Si session auto active, on tente un cancel best-effort de la vague
        if (autoSession && autoSession.currentCampaignId) {
          try {
            // sendBeacon pour avoir le temps d'envoyer avant unload ; l'API
            // accepte le même format JSON. On ne passe pas l'auth header ici,
            // mais le cancel reste safe : il n'agit que sur une campagne
            // appartenant à l'utilisateur (vérifié serveur).
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
