/**
 * dialer-bridge.js — Module réutilisable d'intégration du Dialer
 * ──────────────────────────────────────────────────────────────────────────
 * Permet à n'importe quelle page (CRM, Leads, Retargeting) d'intégrer :
 *   - Boutons "Appeler" individuels sur les fiches lead
 *   - Mode multi-sélection avec barre d'action flottante
 *     → Mode standard : campagne one-shot (max 5 leads, 1 vague)
 *     → Mode Power Dialer : queue jusqu'à 50 leads, vagues de 3/4/5
 *       auto-chainées jusqu'au stop manuel
 *   - Badges "tentatives d'appel" basés sur lead.dialer_attempts
 *
 * Sélection rapide (v2) :
 *   - Shift-click : range select entre la dernière case cochée et la
 *     nouvelle, dans l'ordre DOM. Respecte le max.
 *   - Boutons +10 / +25 / +tout visible dans la bar (Power Mode only).
 *   - Checkbox "toute la colonne" dans le header de chaque colonne Kanban
 *     (opt-in via groupSelector + groupCheckboxTarget).
 *
 * Architecture : aucune dépendance, communique avec sales-dialer.html via
 * sessionStorage (clés : dialer_pending_call, dialer_pending_campaign,
 * dialer_pending_auto_campaign).
 *
 * Préférences Power Dialer :
 *   Lues/écrites dans Firestore dialer_sessions/{uid}.powerPrefs = {
 *     enabled: bool, waveSize: 3|4|5
 *   }
 *
 * Usage CRM Kanban (avec sélection par colonne) :
 *   DialerBridge.enableMultiSelect('#crmBoard', {
 *     cardSelector: '.crm-card',
 *     maxSelection: 5,
 *     groupSelector: '.crm-col',
 *     groupCheckboxTarget: '.crm-col-head-top',
 *   });
 *
 * Usage Liste/Retargeting/Leads (sans groupes) :
 *   DialerBridge.enableMultiSelect('#container', {
 *     cardSelector: 'tr[data-lead-id]',
 *     maxSelection: 5,
 *   });
 */
(function () {
  'use strict';

  // ─── Configuration & état ────────────────────────────────────────────────
  const DIALER_URL = 'sales-dialer.html';
  const STORAGE_PENDING_CALL = 'dialer_pending_call';
  const STORAGE_PENDING_CAMPAIGN = 'dialer_pending_campaign';
  const STORAGE_PENDING_AUTO_CAMPAIGN = 'dialer_pending_auto_campaign';

  const MAX_SELECTION_STANDARD = 5;
  const MAX_SELECTION_POWER = 50;

  const state = {
    selectedLeads: new Map(),
    maxSelection: MAX_SELECTION_STANDARD,
    maxSelectionStandard: MAX_SELECTION_STANDARD,
    maxSelectionPower: MAX_SELECTION_POWER,
    actionBarEl: null,
    powerMode: false,
    waveSize: 4,
    prefsLoaded: false,
    fromNumberId: null,
    // Contextes actifs (1 par appel à enableMultiSelect)
    // Chaque : { container, cardSelector, leadIdAttr, phoneAttr, nameAttr,
    //           groupSelector?, groupCheckboxTarget? }
    contexts: [],
    // Pour shift-click : dernière case sur laquelle l'user a cliqué
    lastInteractedCheckbox: null,
  };

  // ─── Injection CSS ───────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('dialer-bridge-styles')) return;
    const style = document.createElement('style');
    style.id = 'dialer-bridge-styles';
    style.textContent = `
      .dbr-call-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px;
        background: linear-gradient(135deg, #059669, #10b981);
        color: #fff; border: none; border-radius: 8px;
        font-size: 11px; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
        white-space: nowrap;
      }
      .dbr-call-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.35); }
      .dbr-call-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .crm-card:has(> .dbr-checkbox) { padding-left: 40px; }
      td:has(> .dbr-checkbox) { position: relative !important; padding-left: 42px !important; }
      .ld-card:has(> .dbr-checkbox) { position: relative; }
      .ld-card:has(> .dbr-checkbox) .ld-card-head { padding-left: 44px; }

      .dbr-checkbox {
        appearance: none; -webkit-appearance: none;
        position: absolute; top: 10px; left: 10px; z-index: 6;
        width: 20px; height: 20px; margin: 0;
        border: 1.5px solid rgba(255,255,255,0.18);
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        cursor: pointer; flex-shrink: 0;
        transition: all 0.18s cubic-bezier(.4,0,.2,1);
        backdrop-filter: blur(4px);
      }
      .dbr-checkbox:hover {
        border-color: rgba(239,68,68,0.55);
        background: rgba(239,68,68,0.08);
        transform: scale(1.08);
      }
      .dbr-checkbox:checked {
        background: linear-gradient(135deg,#b91c1c,#ef4444);
        border-color: #ef4444;
        box-shadow: 0 0 0 3px rgba(239,68,68,0.15), 0 2px 8px rgba(185,28,28,0.35);
      }
      .dbr-checkbox:checked::after {
        content: ''; position: absolute; inset: 0;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 10.5 8.5 14 15 7'/></svg>");
        background-repeat: no-repeat; background-position: center;
        background-size: 16px 16px;
        animation: dbrCheckPop 0.22s cubic-bezier(.4,0,.2,1);
      }
      @keyframes dbrCheckPop {
        0%   { opacity: 0; transform: scale(0.6); }
        60%  { opacity: 1; transform: scale(1.15); }
        100% { opacity: 1; transform: scale(1); }
      }
      .dbr-checkbox:disabled {
        opacity: 0.25; cursor: not-allowed; filter: grayscale(1);
      }
      .dbr-checkbox:disabled:hover {
        transform: none;
        background: rgba(255,255,255,0.04);
        border-color: rgba(255,255,255,0.18);
      }

      /* Checkbox "toute la colonne" (Kanban) */
      .dbr-group-checkbox {
        appearance: none; -webkit-appearance: none;
        width: 16px; height: 16px;
        margin: 0 8px 0 0;
        border: 1.5px solid rgba(255,255,255,0.25);
        border-radius: 5px;
        background: rgba(255,255,255,0.04);
        cursor: pointer; flex-shrink: 0;
        transition: all 0.18s cubic-bezier(.4,0,.2,1);
        position: relative; vertical-align: middle;
      }
      .dbr-group-checkbox:hover {
        border-color: rgba(239,68,68,0.55);
        background: rgba(239,68,68,0.08);
      }
      .dbr-group-checkbox:checked,
      .dbr-group-checkbox:indeterminate {
        background: linear-gradient(135deg,#b91c1c,#ef4444);
        border-color: #ef4444;
      }
      .dbr-group-checkbox:checked::after {
        content: ''; position: absolute; inset: 0;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 10.5 8.5 14 15 7'/></svg>");
        background-repeat: no-repeat; background-position: center;
        background-size: 13px 13px;
      }
      .dbr-group-checkbox:indeterminate::after {
        content: ''; position: absolute;
        left: 2.5px; right: 2.5px; top: 50%;
        height: 2px; background: #fff; border-radius: 1px;
        transform: translateY(-50%);
      }
      .dbr-group-checkbox:disabled {
        opacity: 0.25; cursor: not-allowed;
      }

      .dbr-attempts-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 2px 7px;
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: 999px;
        font-size: 10px; font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
      }
      .dbr-attempts-badge.zero { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.3); border-color: rgba(255,255,255,0.08); }
      .dbr-attempts-badge.high { background: rgba(239, 68, 68, 0.15); color: #ef4444; border-color: rgba(239, 68, 68, 0.3); }

      /* Action bar flottante */
      .dbr-action-bar {
        position: fixed;
        bottom: 24px; left: 50%;
        transform: translateX(-50%) translateY(140%);
        background: #1a1a28;
        border: 1px solid rgba(255,255,255,0.13);
        border-radius: 16px;
        padding: 12px 18px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        display: flex; align-items: center; gap: 14px;
        z-index: 9999;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: inherit; flex-wrap: wrap;
        max-width: calc(100vw - 48px);
      }
      .dbr-action-bar.show { transform: translateX(-50%) translateY(0); }
      .dbr-action-count {
        font-size: 13px; color: rgba(255,255,255,0.92);
        font-weight: 600; min-width: 120px;
      }
      .dbr-action-count em { color: #10b981; font-style: normal; }
      .dbr-action-count.power em { color: #ef4444; }

      .dbr-power-toggle {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        cursor: pointer; transition: all 0.2s;
      }
      .dbr-power-toggle:hover { background: rgba(255,255,255,0.08); }
      .dbr-power-toggle.active {
        background: rgba(239,68,68,0.12);
        border-color: rgba(239,68,68,0.35);
      }
      .dbr-power-toggle-icon { font-size: 14px; }
      .dbr-power-toggle-label {
        font-size: 11px; font-weight: 600;
        color: rgba(255,255,255,0.7);
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .dbr-power-toggle.active .dbr-power-toggle-label { color: #ef4444; }
      .dbr-power-toggle-switch {
        width: 28px; height: 16px;
        background: rgba(255,255,255,0.1);
        border-radius: 999px; position: relative;
        transition: all 0.2s;
      }
      .dbr-power-toggle-switch::after {
        content: ''; position: absolute; top: 1px; left: 1px;
        width: 12px; height: 12px;
        background: rgba(255,255,255,0.6);
        border-radius: 50%; transition: all 0.2s;
      }
      .dbr-power-toggle.active .dbr-power-toggle-switch {
        background: linear-gradient(135deg,#b91c1c,#ef4444);
      }
      .dbr-power-toggle.active .dbr-power-toggle-switch::after {
        background: #fff; transform: translateX(12px);
      }

      .dbr-wave-selector {
        display: none; align-items: center; gap: 3px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px; padding: 3px;
      }
      .dbr-wave-selector.show { display: flex; }
      .dbr-wave-btn {
        background: transparent; border: none;
        color: rgba(255,255,255,0.55);
        width: 28px; height: 26px;
        border-radius: 7px; cursor: pointer;
        font-family: inherit;
        font-size: 13px; font-weight: 600;
        transition: all 0.15s;
      }
      .dbr-wave-btn:hover { color: #fff; }
      .dbr-wave-btn.active {
        background: linear-gradient(135deg,#b91c1c,#ef4444);
        color: #fff;
        box-shadow: 0 2px 6px rgba(185,28,28,0.35);
      }
      .dbr-wave-label {
        font-size: 10px; color: rgba(255,255,255,0.45);
        text-transform: uppercase; letter-spacing: 0.6px;
        margin-right: 4px;
      }

      /* Boutons quick-select (+10 / +25 / +tout visible) */
      .dbr-quick-select {
        display: none; align-items: center; gap: 4px;
      }
      .dbr-quick-select.show { display: flex; }
      .dbr-quick-btn {
        background: rgba(239,68,68,0.08);
        border: 1px solid rgba(239,68,68,0.25);
        color: #ef4444;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
        font-family: inherit;
        font-size: 11px; font-weight: 700;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .dbr-quick-btn:hover {
        background: rgba(239,68,68,0.15);
        border-color: rgba(239,68,68,0.5);
        transform: translateY(-1px);
      }
      .dbr-quick-btn:disabled {
        opacity: 0.3; cursor: not-allowed; transform: none;
      }

      .dbr-action-btn {
        padding: 9px 16px; border-radius: 10px;
        font-size: 12px; font-weight: 600;
        cursor: pointer; border: none;
        font-family: inherit; white-space: nowrap;
      }
      .dbr-action-btn-primary {
        background: linear-gradient(135deg, #059669, #10b981);
        color: #fff;
      }
      .dbr-action-btn-primary:hover { transform: translateY(-1px); }
      .dbr-action-btn-power {
        background: linear-gradient(135deg, #b91c1c, #ef4444);
        color: #fff;
        box-shadow: 0 4px 12px rgba(185,28,28,0.35);
      }
      .dbr-action-btn-power:hover { transform: translateY(-1px); }
      .dbr-action-btn-ghost {
        background: transparent;
        color: rgba(255,255,255,0.48);
        border: 1px solid rgba(255,255,255,0.13);
      }
      .dbr-action-btn-ghost:hover { color: #fff; border-color: rgba(255,255,255,0.25); }

      .dbr-action-divider {
        width: 1px; height: 22px;
        background: rgba(255,255,255,0.08);
      }

      @media (max-width: 640px) {
        .dbr-action-bar { gap: 8px; padding: 10px 12px; }
        .dbr-action-count { min-width: 0; font-size: 12px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function normalizePhone(raw) {
    if (!raw) return '';
    let p = String(raw).replace(/[^\d+]/g, '');
    if (p.startsWith('00')) p = '+' + p.slice(2);
    if (p.startsWith('0') && p.length === 10) p = '+33' + p.slice(1);
    if (!p.startsWith('+')) p = '+' + p;
    return p;
  }

  function openDialer() { window.open(DIALER_URL, '_blank'); }

  // ─── Firestore prefs ─────────────────────────────────────────────────────
  async function loadPowerPrefs() {
    if (state.prefsLoaded) return;
    try {
      if (typeof firebase === 'undefined' || !firebase.auth || !firebase.firestore) return;
      const user = firebase.auth().currentUser;
      if (!user) return;
      const db = firebase.firestore();
      const snap = await db.collection('dialer_sessions').doc(user.uid).get();
      const prefs = (snap.exists && snap.data().powerPrefs) || {};
      if (typeof prefs.enabled === 'boolean') state.powerMode = prefs.enabled;
      if ([3, 4, 5].includes(prefs.waveSize)) state.waveSize = prefs.waveSize;
      state.prefsLoaded = true;
    } catch (e) {
      console.warn('[DialerBridge] loadPowerPrefs', e);
    }
  }

  async function savePowerPrefs() {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth || !firebase.firestore) return;
      const user = firebase.auth().currentUser;
      if (!user) return;
      const db = firebase.firestore();
      await db.collection('dialer_sessions').doc(user.uid).set({
        userId: user.uid,
        powerPrefs: { enabled: state.powerMode, waveSize: state.waveSize },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn('[DialerBridge] savePowerPrefs', e);
    }
  }

  // ─── API publique : single call / campaign / power ──────────────────────
  function callLead(leadId, phone, name) {
    const norm = normalizePhone(phone);
    if (!norm) { console.warn('[DialerBridge] Numéro invalide', leadId); return; }
    sessionStorage.setItem(STORAGE_PENDING_CALL, JSON.stringify({
      leadId: leadId || null,
      phone: norm,
      name: name || null,
    }));
    openDialer();
  }

  function startCampaign(leads) {
    if (!Array.isArray(leads) || leads.length === 0) return;
    const limit = state.maxSelectionStandard;
    if (leads.length > limit) leads = leads.slice(0, limit);
    const payload = leads.map(l => ({
      leadId: l.leadId || l.id || null,
      phone: normalizePhone(l.phone || l.telephone),
      leadName: l.name || l.leadName || null,
    })).filter(l => l.phone);
    if (payload.length === 0) return;
    sessionStorage.setItem(STORAGE_PENDING_CAMPAIGN, JSON.stringify(payload));
    openDialer();
  }

  function startAutoCampaign(leads, waveSize) {
    if (!Array.isArray(leads) || leads.length === 0) return;
    const size = [3, 4, 5].includes(waveSize) ? waveSize : state.waveSize;
    const limit = state.maxSelectionPower;
    if (leads.length > limit) leads = leads.slice(0, limit);
    const queue = leads.map(l => ({
      leadId: l.leadId || l.id || null,
      phone: normalizePhone(l.phone || l.telephone),
      leadName: l.name || l.leadName || null,
    })).filter(l => l.phone);
    if (queue.length === 0) return;
    sessionStorage.setItem(STORAGE_PENDING_AUTO_CAMPAIGN, JSON.stringify({
      queue, waveSize: size,
      fromNumberId: state.fromNumberId || null,
    }));
    openDialer();
  }

  function renderAttemptsBadge(attempts) {
    const n = parseInt(attempts || 0, 10);
    let cls = 'zero';
    if (n >= 5) cls = 'high';
    else if (n >= 1) cls = '';
    return `<span class="dbr-attempts-badge ${cls}" title="Tentatives d'appel">📞 ${n}</span>`;
  }

  // ─── attachButtons ───────────────────────────────────────────────────────
  function attachButtons(containerSelector, opts = {}) {
    injectStyles();
    const cardSelector = opts.cardSelector || '.lead-card,[data-lead-id]';
    const leadIdAttr = opts.leadIdAttr || 'data-lead-id';
    const phoneAttr = opts.phoneAttr || 'data-phone';
    const nameAttr = opts.nameAttr || 'data-name';
    const insertTarget = opts.insertTarget || null;

    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) return;

    container.querySelectorAll(cardSelector).forEach(card => {
      if (card.querySelector('.dbr-call-btn')) return;
      const leadId = card.getAttribute(leadIdAttr);
      const phone = card.getAttribute(phoneAttr);
      const name = card.getAttribute(nameAttr);
      const btn = document.createElement('button');
      btn.className = 'dbr-call-btn';
      btn.type = 'button';
      btn.innerHTML = '📞 Appeler';
      btn.disabled = !phone;
      btn.title = phone ? `Appeler ${phone}` : 'Aucun téléphone';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        callLead(leadId, phone, name);
      });
      let target = insertTarget ? card.querySelector(insertTarget) : card;
      if (!insertTarget && card.tagName === 'TR') {
        const tds = card.querySelectorAll('td');
        if (tds.length) target = tds[tds.length - 1];
      }
      target.appendChild(btn);
    });
  }

  // ─── enableMultiSelect ───────────────────────────────────────────────────
  function enableMultiSelect(containerSelector, opts = {}) {
    injectStyles();
    const cardSelector = opts.cardSelector || '.lead-card,[data-lead-id]';
    const leadIdAttr = opts.leadIdAttr || 'data-lead-id';
    const phoneAttr = opts.phoneAttr || 'data-phone';
    const nameAttr = opts.nameAttr || 'data-name';
    const groupSelector = opts.groupSelector || null;
    const groupCheckboxTarget = opts.groupCheckboxTarget || null;
    state.maxSelectionStandard = opts.maxSelection || MAX_SELECTION_STANDARD;
    state.maxSelectionPower = opts.maxSelectionPower || MAX_SELECTION_POWER;

    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) return;

    // Enregistre/remplace le contexte pour ce container
    const ctx = { container, cardSelector, leadIdAttr, phoneAttr, nameAttr, groupSelector, groupCheckboxTarget };
    const existing = state.contexts.findIndex(c => c.container === container);
    if (existing >= 0) state.contexts[existing] = ctx;
    else state.contexts.push(ctx);

    // Checkboxes individuelles sur les cards
    container.querySelectorAll(cardSelector).forEach(card => {
      if (card.querySelector('.dbr-checkbox')) return;
      const leadId = card.getAttribute(leadIdAttr);
      const phone = card.getAttribute(phoneAttr);
      const name = card.getAttribute(nameAttr);
      if (!phone) return;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dbr-checkbox';
      cb.title = 'Sélectionner (Shift+clic pour une plage)';
      cb.setAttribute('data-lead-id', leadId);

      // Intercept click AVANT le toggle natif pour gérer le shift-click.
      // Au moment de notre handler, cb.checked est l'état AVANT toggle, donc
      // targetState = !cb.checked représente l'état qui sera appliqué après
      // l'activation behavior du click natif.
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey && state.lastInteractedCheckbox && state.lastInteractedCheckbox !== cb) {
          handleShiftClick(cb);
        }
      });

      cb.addEventListener('change', (e) => {
        if (cb.checked) {
          const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
          if (state.selectedLeads.size >= currentMax) {
            cb.checked = false;
            return;
          }
          state.selectedLeads.set(leadId, { leadId, phone, name });
        } else {
          state.selectedLeads.delete(leadId);
        }
        updateActionBar();
        updateCheckboxesDisabled();
        updateGroupCheckboxes();
        // Track lastInteracted uniquement sur event utilisateur trusté
        // (les dispatchEvent synthétiques ont isTrusted=false → on ne les compte pas)
        if (e.isTrusted !== false) state.lastInteractedCheckbox = cb;
      });

      const cbTarget = card.tagName === 'TR' ? card.querySelector('td') : card;
      if (!cbTarget) return;
      if (card.tagName === 'TR') cbTarget.style.position = 'relative';
      cbTarget.insertBefore(cb, cbTarget.firstChild);
    });

    // Checkboxes de colonne (groupes) — opt-in
    if (groupSelector && groupCheckboxTarget) {
      container.querySelectorAll(groupSelector).forEach(group => {
        const target = group.querySelector(groupCheckboxTarget);
        if (!target) return;
        if (target.querySelector('.dbr-group-checkbox')) return;

        const gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'dbr-group-checkbox';
        gcb.title = 'Sélectionner toute la colonne';
        gcb.addEventListener('click', (e) => {
          e.stopPropagation();
          // État actuel AVANT toggle natif :
          //   - checked=true, indeterminate=false → on décoche tout
          //   - checked=false, indeterminate=false → on coche tout
          //   - indeterminate=true → on coche tout (convention Gmail/GitHub)
          const targetState = gcb.indeterminate ? true : !gcb.checked;
          selectGroup(group, cardSelector, targetState);
          // updateGroupCheckboxes() sera appelé via les change events
          // dispatchés dans selectGroup. On empêche juste le toggle natif
          // d'appliquer un état qui serait écrasé ensuite.
          e.preventDefault();
        });
        target.insertBefore(gcb, target.firstChild);
      });
    }

    ensureActionBar();
    loadPowerPrefs().then(() => {
      applyPowerModeToBar();
      updateGroupCheckboxes();
    });
  }

  // ─── Shift-click : range select ──────────────────────────────────────────
  function handleShiftClick(cb) {
    const allCbs = getAllCheckboxesInDomOrder();
    const lastIdx = allCbs.indexOf(state.lastInteractedCheckbox);
    const curIdx = allCbs.indexOf(cb);
    if (lastIdx === -1 || curIdx === -1) return;
    const targetState = !cb.checked;
    const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
    for (let i = from; i <= to; i++) {
      const ck = allCbs[i];
      if (ck === cb) continue; // toggle natif s'en occupe
      if (ck.disabled && !ck.checked) continue;
      if (ck.checked === targetState) continue;
      if (targetState === true) {
        const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
        if (state.selectedLeads.size >= currentMax) break;
      }
      ck.checked = targetState;
      ck.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function getAllCheckboxesInDomOrder() {
    const all = [];
    state.contexts.forEach(ctx => {
      ctx.container.querySelectorAll('.dbr-checkbox').forEach(c => all.push(c));
    });
    return all;
  }

  // ─── Quick select (+N / +tout visible) ───────────────────────────────────
  function quickSelect(qty) {
    const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
    const remaining = currentMax - state.selectedLeads.size;
    if (remaining <= 0) return;
    const target = (qty === 'all') ? Infinity : parseInt(qty, 10);
    const toAdd = Math.min(target, remaining);

    const candidates = [];
    getAllCheckboxesInDomOrder().forEach(cb => {
      if (cb.checked) return;
      // On ne respecte pas disabled ici car si on veut atteindre le max,
      // on doit pouvoir cocher les cases grisées (elles seront re-grisées
      // par updateCheckboxesDisabled après). En pratique, les disabled ne
      // sont disabled QUE parce que le max est atteint → si on atteint pas
      // le max avec cette quick-select, elles resteront disabled.
      candidates.push(cb);
    });

    const slice = candidates.slice(0, toAdd);
    slice.forEach(cb => {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // ─── Sélection par groupe (checkbox colonne Kanban) ─────────────────────
  function selectGroup(group, cardSelector, targetState) {
    const cards = group.querySelectorAll(cardSelector);
    const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
    cards.forEach(card => {
      const cb = card.querySelector('.dbr-checkbox');
      if (!cb) return;
      if (cb.checked === targetState) return;
      if (targetState === true) {
        // Skip si disabled ET le max est atteint
        if (state.selectedLeads.size >= currentMax) return;
      }
      cb.checked = targetState;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function updateGroupCheckboxes() {
    state.contexts.forEach(ctx => {
      if (!ctx.groupSelector || !ctx.groupCheckboxTarget) return;
      ctx.container.querySelectorAll(ctx.groupSelector).forEach(group => {
        const target = group.querySelector(ctx.groupCheckboxTarget);
        if (!target) return;
        const gcb = target.querySelector('.dbr-group-checkbox');
        if (!gcb) return;
        const cardCbs = Array.from(group.querySelectorAll(ctx.cardSelector))
          .map(c => c.querySelector('.dbr-checkbox'))
          .filter(Boolean);
        if (cardCbs.length === 0) {
          gcb.checked = false;
          gcb.indeterminate = false;
          gcb.disabled = true;
          return;
        }
        gcb.disabled = false;
        const checkedCount = cardCbs.filter(c => c.checked).length;
        if (checkedCount === 0) {
          gcb.checked = false;
          gcb.indeterminate = false;
        } else if (checkedCount === cardCbs.length) {
          gcb.checked = true;
          gcb.indeterminate = false;
        } else {
          gcb.checked = false;
          gcb.indeterminate = true;
        }
      });
    });
  }

  function updateCheckboxesDisabled() {
    const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
    const reachedMax = state.selectedLeads.size >= currentMax;
    getAllCheckboxesInDomOrder().forEach(cb => {
      cb.disabled = reachedMax && !cb.checked;
    });
  }

  // ─── Action bar ──────────────────────────────────────────────────────────
  function ensureActionBar() {
    if (state.actionBarEl) return;
    const bar = document.createElement('div');
    bar.className = 'dbr-action-bar';
    bar.innerHTML = `
      <div class="dbr-action-count" id="dbr-count-wrap">
        <em id="dbr-count">0</em> <span id="dbr-count-label">lead(s) sélectionné(s)</span>
      </div>

      <div class="dbr-action-divider"></div>

      <div class="dbr-power-toggle" id="dbr-power-toggle" title="Activer le Power Dialer (queue auto-chainée jusqu'au stop)">
        <span class="dbr-power-toggle-icon">🚀</span>
        <span class="dbr-power-toggle-label">Power</span>
        <span class="dbr-power-toggle-switch"></span>
      </div>

      <div class="dbr-wave-selector" id="dbr-wave-selector">
        <span class="dbr-wave-label">Vague</span>
        <button class="dbr-wave-btn" data-size="3" type="button">3</button>
        <button class="dbr-wave-btn active" data-size="4" type="button">4</button>
        <button class="dbr-wave-btn" data-size="5" type="button">5</button>
      </div>

      <div class="dbr-quick-select" id="dbr-quick-select">
        <span class="dbr-wave-label">+ rapide</span>
        <button class="dbr-quick-btn" data-qty="10" type="button">+10</button>
        <button class="dbr-quick-btn" data-qty="25" type="button">+25</button>
        <button class="dbr-quick-btn" data-qty="all" type="button">+ tout visible</button>
      </div>

      <div class="dbr-action-divider"></div>

      <button class="dbr-action-btn dbr-action-btn-primary" id="dbr-launch" type="button">📞 Lancer</button>
      <button class="dbr-action-btn dbr-action-btn-ghost" id="dbr-clear" type="button">Annuler</button>
    `;
    document.body.appendChild(bar);
    state.actionBarEl = bar;

    bar.querySelector('#dbr-launch').addEventListener('click', () => {
      const leads = Array.from(state.selectedLeads.values());
      if (leads.length === 0) return;
      if (state.powerMode) startAutoCampaign(leads, state.waveSize);
      else startCampaign(leads);
      clearSelection();
    });
    bar.querySelector('#dbr-clear').addEventListener('click', clearSelection);

    bar.querySelector('#dbr-power-toggle').addEventListener('click', () => {
      state.powerMode = !state.powerMode;
      applyPowerModeToBar();
      if (!state.powerMode && state.selectedLeads.size > state.maxSelectionStandard) {
        // Trim à maxSelectionStandard : on garde les N premiers dans l'ordre d'insertion
        const keep = Array.from(state.selectedLeads.entries()).slice(0, state.maxSelectionStandard);
        state.selectedLeads = new Map(keep);
        document.querySelectorAll('.dbr-checkbox:checked').forEach(cb => {
          const card = cb.closest('[data-lead-id]');
          const lid = card && card.getAttribute('data-lead-id');
          if (lid && !state.selectedLeads.has(lid)) cb.checked = false;
        });
        updateActionBar();
      }
      updateCheckboxesDisabled();
      updateGroupCheckboxes();
      savePowerPrefs();
    });

    bar.querySelectorAll('.dbr-wave-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        bar.querySelectorAll('.dbr-wave-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.waveSize = parseInt(btn.dataset.size, 10);
        savePowerPrefs();
      });
    });

    bar.querySelectorAll('.dbr-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => quickSelect(btn.dataset.qty));
    });
  }

  function applyPowerModeToBar() {
    if (!state.actionBarEl) return;
    const bar = state.actionBarEl;
    const toggle = bar.querySelector('#dbr-power-toggle');
    const selector = bar.querySelector('#dbr-wave-selector');
    const quickSel = bar.querySelector('#dbr-quick-select');
    const launchBtn = bar.querySelector('#dbr-launch');
    const countWrap = bar.querySelector('#dbr-count-wrap');

    bar.querySelectorAll('.dbr-wave-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.size, 10) === state.waveSize);
    });

    if (state.powerMode) {
      toggle.classList.add('active');
      selector.classList.add('show');
      quickSel.classList.add('show');
      launchBtn.classList.remove('dbr-action-btn-primary');
      launchBtn.classList.add('dbr-action-btn-power');
      launchBtn.innerHTML = '🚀 Power Dialer';
      countWrap.classList.add('power');
      state.maxSelection = state.maxSelectionPower;
    } else {
      toggle.classList.remove('active');
      selector.classList.remove('show');
      quickSel.classList.remove('show');
      launchBtn.classList.remove('dbr-action-btn-power');
      launchBtn.classList.add('dbr-action-btn-primary');
      launchBtn.innerHTML = '📞 Lancer';
      countWrap.classList.remove('power');
      state.maxSelection = state.maxSelectionStandard;
    }
    updateActionBar();
  }

  function updateActionBar() {
    if (!state.actionBarEl) return;
    const n = state.selectedLeads.size;
    const countEl = state.actionBarEl.querySelector('#dbr-count');
    const labelEl = state.actionBarEl.querySelector('#dbr-count-label');
    countEl.textContent = n;
    const currentMax = state.powerMode ? state.maxSelectionPower : state.maxSelectionStandard;
    labelEl.textContent = state.powerMode
      ? `lead${n > 1 ? 's' : ''} / ${currentMax} max`
      : `lead${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
    state.actionBarEl.classList.toggle('show', n > 0);
  }

  function clearSelection() {
    state.selectedLeads.clear();
    state.lastInteractedCheckbox = null;
    document.querySelectorAll('.dbr-checkbox:checked').forEach(cb => {
      cb.checked = false;
    });
    updateActionBar();
    updateCheckboxesDisabled();
    updateGroupCheckboxes();
  }

  // ─── Export global ───────────────────────────────────────────────────────
  window.DialerBridge = {
    callLead,
    startCampaign,
    startAutoCampaign,
    renderAttemptsBadge,
    attachButtons,
    enableMultiSelect,
    clearSelection,
    quickSelect,
    normalizePhone,
  };
})();
