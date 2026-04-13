/**
 * sales-dialer.js — Softphone Ambitio
 * Twilio Voice SDK browser + Firestore live (call_logs, dialer_campaigns, dialer_sessions)
 * Bridge CRM via sessionStorage.dialer_pending_call
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

  // ─── Auth + bootstrap ────────────────────────────────────────────────────
  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    sessionDocRef = db.collection('dialer_sessions').doc(user.uid);
    await initDevice();
    await loadFromNumbers();
    subscribeHistory();
    bindUI();
    await initSession();
    handlePendingCall();
  });

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
    historyUnsub = db.collection('call_logs')
      .where('userId', '==', currentUser.uid)
      .orderBy('initiatedAt', 'desc')
      .limit(50)
      .onSnapshot(snap => {
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
          <div class="sd-history-name">${name}</div>
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
    $('sd-btn-cancel-campaign').addEventListener('click', cancelCampaign);
    $('sd-history-refresh').addEventListener('click', () => subscribeHistory());
    document.querySelectorAll('.sd-chip').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('.sd-chip').forEach(x => x.classList.remove('sd-chip-active'));
      c.classList.add('sd-chip-active');
      historyFilter = c.dataset.filter;
      subscribeHistory();
    }));
  }

  // ─── Pending call/campaign (bridge CRM) ─────────────────────────────────
  function handlePendingCall() {
    try {
      // 1. Campagne multi-call pending ?
      const rawCamp = sessionStorage.getItem('dialer_pending_campaign');
      if (rawCamp) {
        sessionStorage.removeItem('dialer_pending_campaign');
        const leads = JSON.parse(rawCamp);
        if (Array.isArray(leads) && leads.length > 0) {
          // Attendre que le device soit prêt
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

      // 2. Appel single pending ?
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
      $('sd-incall-name').textContent = activeLeadData.fullName || activeLeadData.firstName || 'Lead';
      $('sd-incall-avatar').textContent = (activeLeadData.firstName || '?')[0].toUpperCase();
    } else {
      $('sd-incall-name').textContent = 'Inconnu';
      $('sd-incall-avatar').textContent = '?';
    }
    $('sd-incall-state').textContent = 'CONNEXION…';
    $('sd-incall-timer').textContent = '00:00';
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
    showView('idle');
    updateSession('idle');
  }

  // ─── Incoming ───────────────────────────────────────────────────────────
  async function handleIncoming(conn) {
    activeConn = conn;
    const from = conn.parameters.From || '';
    const leadId = (conn.customParameters && conn.customParameters.get('leadId')) || '';
    if (leadId) await loadLead(leadId);
    $('sd-incoming-name').textContent = activeLeadData ? (activeLeadData.fullName || 'Lead') : 'Appel entrant';
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

  // ─── Multi-call campagne (écoute live) ──────────────────────────────────
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
      subscribeCampaign(campaignId);
      showView('campaign');
    } catch (e) {
      console.error(e);
      toast(e.message || 'Échec lancement campagne', 'error');
    }
  };

  function subscribeCampaign(campaignId) {
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
            <div class="sd-leg-name">${l.leadName || '—'}</div>
            <div class="sd-leg-phone">${l.phone}</div>
          </div>
          <div class="sd-leg-status">${l.status}</div>
        </div>`).join('');
      $('sd-campaign-legs').innerHTML = html || '<div class="sd-empty">Aucun leg</div>';
      if (c.status === 'connected' || c.status === 'ended' || c.status === 'cancelled') {
        if (c.status !== 'connected') setTimeout(() => { if (!activeConn) showView('idle'); }, 2000);
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

  // ─── Session monitoring ─────────────────────────────────────────────────
  async function initSession() {
    try {
      await sessionDocRef.set({
        userId: currentUser.uid,
        status: 'idle',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      window.addEventListener('beforeunload', () => {
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
