/**
 * dialer-bridge.js — Module réutilisable d'intégration du Dialer
 * ──────────────────────────────────────────────────────────────────────────
 * Permet à n'importe quelle page (CRM, Leads, Retargeting) d'intégrer :
 *   - Boutons "Appeler" individuels sur les fiches lead
 *   - Mode multi-sélection avec barre d'action flottante "Lancer campagne"
 *   - Badges "tentatives d'appel" basés sur lead.dialer_attempts
 *
 * Architecture : aucune dépendance, communique avec sales-dialer.html via
 * sessionStorage. Quand l'utilisateur clique "Appeler" ou "Lancer campagne",
 * on stocke l'intent dans sessionStorage et on ouvre sales-dialer.html dans
 * un nouvel onglet (qui le lit au load et déclenche l'action automatiquement).
 *
 * Usage minimal dans une page :
 *   <script src="dialer-bridge.js"></script>
 *   <script>
 *     // Après que ton kanban/liste soit rendu :
 *     DialerBridge.attachButtons('#kanban-container');
 *     DialerBridge.enableMultiSelect('#kanban-container', { maxSelection: 5 });
 *   </script>
 *
 * Convention HTML attendue sur les cards :
 *   <div class="lead-card" data-lead-id="abc123" data-phone="+33612345678" data-name="Jean Dupont">
 *     ...
 *   </div>
 *
 * Le module lit ces 3 attributs (data-lead-id, data-phone, data-name) sur
 * chaque card matchée. Tu peux personnaliser les sélecteurs via les options.
 */
(function () {
  'use strict';

  // ─── Configuration & état ────────────────────────────────────────────────
  const DIALER_URL = 'sales-dialer.html';
  const STORAGE_PENDING_CALL = 'dialer_pending_call';
  const STORAGE_PENDING_CAMPAIGN = 'dialer_pending_campaign';

  const state = {
    selectedLeads: new Map(), // leadId -> {leadId, phone, name}
    maxSelection: 5,
    actionBarEl: null,
  };

  // ─── Injection CSS (une seule fois) ──────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('dialer-bridge-styles')) return;
    const style = document.createElement('style');
    style.id = 'dialer-bridge-styles';
    style.textContent = `
      .dbr-call-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 10px;
        background: linear-gradient(135deg, #059669, #10b981);
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .dbr-call-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.35); }
      .dbr-call-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .crm-card:has(> .dbr-checkbox) { padding-left: 40px; }
      td:has(> .dbr-checkbox) { position: relative !important; padding-left: 42px !important; }
      .ld-card:has(> .dbr-checkbox) { position: relative; }
      .ld-card:has(> .dbr-checkbox) .ld-card-head { padding-left: 44px; }
      .dbr-checkbox {
        appearance: none;
        -webkit-appearance: none;
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 6;
        width: 20px;
        height: 20px;
        margin: 0;
        border: 1.5px solid rgba(255,255,255,0.18);
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        cursor: pointer;
        flex-shrink: 0;
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
        content: '';
        position: absolute;
        inset: 0;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 10.5 8.5 14 15 7'/></svg>");
        background-repeat: no-repeat;
        background-position: center;
        background-size: 16px 16px;
        animation: dbrCheckPop 0.22s cubic-bezier(.4,0,.2,1);
      }
      @keyframes dbrCheckPop {
        0%   { opacity: 0; transform: scale(0.6); }
        60%  { opacity: 1; transform: scale(1.15); }
        100% { opacity: 1; transform: scale(1); }
      }
      .dbr-checkbox:disabled {
        opacity: 0.25;
        cursor: not-allowed;
        filter: grayscale(1);
      }
      .dbr-checkbox:disabled:hover {
        transform: none;
        background: rgba(255,255,255,0.04);
        border-color: rgba(255,255,255,0.18);
      }
      .dbr-attempts-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
      }
      .dbr-attempts-badge.zero { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.3); border-color: rgba(255,255,255,0.08); }
      .dbr-attempts-badge.high { background: rgba(239, 68, 68, 0.15); color: #ef4444; border-color: rgba(239, 68, 68, 0.3); }
      .dbr-action-bar {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(120%);
        background: #1a1a28;
        border: 1px solid rgba(255,255,255,0.13);
        border-radius: 16px;
        padding: 14px 22px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        gap: 18px;
        z-index: 9999;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: inherit;
      }
      .dbr-action-bar.show { transform: translateX(-50%) translateY(0); }
      .dbr-action-count {
        font-size: 13px;
        color: rgba(255,255,255,0.92);
        font-weight: 600;
      }
      .dbr-action-count em { color: #10b981; font-style: normal; }
      .dbr-action-btn {
        padding: 9px 18px;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        font-family: inherit;
      }
      .dbr-action-btn-primary {
        background: linear-gradient(135deg, #059669, #10b981);
        color: #fff;
      }
      .dbr-action-btn-primary:hover { transform: translateY(-1px); }
      .dbr-action-btn-ghost {
        background: transparent;
        color: rgba(255,255,255,0.48);
        border: 1px solid rgba(255,255,255,0.13);
      }
      .dbr-action-btn-ghost:hover { color: #fff; border-color: rgba(255,255,255,0.25); }
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

  function openDialer() {
    window.open(DIALER_URL, '_blank');
  }

  // ─── API publique : appel single ─────────────────────────────────────────
  function callLead(leadId, phone, name) {
    const norm = normalizePhone(phone);
    if (!norm) {
      console.warn('[DialerBridge] Numéro invalide pour', leadId);
      return;
    }
    sessionStorage.setItem(STORAGE_PENDING_CALL, JSON.stringify({
      leadId: leadId || null,
      phone: norm,
      name: name || null,
    }));
    openDialer();
  }

  // ─── API publique : campagne multi-call ──────────────────────────────────
  function startCampaign(leads) {
    if (!Array.isArray(leads) || leads.length === 0) {
      console.warn('[DialerBridge] Aucun lead à appeler');
      return;
    }
    if (leads.length > state.maxSelection) {
      console.warn('[DialerBridge] Trop de leads, max', state.maxSelection);
      leads = leads.slice(0, state.maxSelection);
    }
    const payload = leads.map(l => ({
      leadId: l.leadId || l.id || null,
      phone: normalizePhone(l.phone || l.telephone),
      leadName: l.name || l.leadName || null,
    })).filter(l => l.phone);

    if (payload.length === 0) return;

    sessionStorage.setItem(STORAGE_PENDING_CAMPAIGN, JSON.stringify(payload));
    openDialer();
  }

  // ─── API publique : badge tentatives ─────────────────────────────────────
  function renderAttemptsBadge(attempts) {
    const n = parseInt(attempts || 0, 10);
    let cls = 'zero';
    if (n >= 5) cls = 'high';
    else if (n >= 1) cls = '';
    return `<span class="dbr-attempts-badge ${cls}" title="Tentatives d'appel">📞 ${n}</span>`;
  }

  // ─── API publique : auto-injection des boutons sur cards ─────────────────
  function attachButtons(containerSelector, opts = {}) {
    injectStyles();
    const cardSelector = opts.cardSelector || '.lead-card,[data-lead-id]';
    const leadIdAttr = opts.leadIdAttr || 'data-lead-id';
    const phoneAttr = opts.phoneAttr || 'data-phone';
    const nameAttr = opts.nameAttr || 'data-name';
    const insertTarget = opts.insertTarget || null; // sélecteur dans la card où placer le bouton

    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) return;

    container.querySelectorAll(cardSelector).forEach(card => {
      if (card.querySelector('.dbr-call-btn')) return; // déjà attaché

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
      // TR: can't append directly to row — use last TD
      if (!insertTarget && card.tagName === 'TR') {
        const tds = card.querySelectorAll('td');
        if (tds.length) target = tds[tds.length - 1];
      }
      target.appendChild(btn);
    });
  }

  // ─── API publique : mode multi-sélection avec barre flottante ────────────
  function enableMultiSelect(containerSelector, opts = {}) {
    injectStyles();
    const cardSelector = opts.cardSelector || '.lead-card,[data-lead-id]';
    const leadIdAttr = opts.leadIdAttr || 'data-lead-id';
    const phoneAttr = opts.phoneAttr || 'data-phone';
    const nameAttr = opts.nameAttr || 'data-name';
    state.maxSelection = opts.maxSelection || 5;

    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) return;

    container.querySelectorAll(cardSelector).forEach(card => {
      if (card.querySelector('.dbr-checkbox')) return;

      const leadId = card.getAttribute(leadIdAttr);
      const phone = card.getAttribute(phoneAttr);
      const name = card.getAttribute(nameAttr);
      if (!phone) return;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dbr-checkbox';
      cb.title = 'Sélectionner pour campagne multi-call';
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (state.selectedLeads.size >= state.maxSelection) {
            cb.checked = false;
            return;
          }
          state.selectedLeads.set(leadId, { leadId, phone, name });
        } else {
          state.selectedLeads.delete(leadId);
        }
        updateActionBar();
        updateCheckboxesDisabled();
      });

      // TR = table row → insert into first TD (inserting directly into TR is invalid HTML)
      const cbTarget = card.tagName === 'TR' ? card.querySelector('td') : card;
      if (!cbTarget) return;
      if (card.tagName === 'TR') cbTarget.style.position = 'relative';
      cbTarget.insertBefore(cb, cbTarget.firstChild);
    });

    ensureActionBar();
  }

  function updateCheckboxesDisabled() {
    const reachedMax = state.selectedLeads.size >= state.maxSelection;
    document.querySelectorAll('.dbr-checkbox').forEach(cb => {
      cb.disabled = reachedMax && !cb.checked;
    });
  }

  function ensureActionBar() {
    if (state.actionBarEl) return;
    const bar = document.createElement('div');
    bar.className = 'dbr-action-bar';
    bar.innerHTML = `
      <div class="dbr-action-count"><em id="dbr-count">0</em> lead(s) sélectionné(s)</div>
      <button class="dbr-action-btn dbr-action-btn-primary" id="dbr-launch">📞 Lancer campagne</button>
      <button class="dbr-action-btn dbr-action-btn-ghost" id="dbr-clear">Annuler</button>
    `;
    document.body.appendChild(bar);
    state.actionBarEl = bar;

    bar.querySelector('#dbr-launch').addEventListener('click', () => {
      const leads = Array.from(state.selectedLeads.values());
      if (leads.length === 0) return;
      startCampaign(leads);
      clearSelection();
    });
    bar.querySelector('#dbr-clear').addEventListener('click', clearSelection);
  }

  function updateActionBar() {
    if (!state.actionBarEl) return;
    const n = state.selectedLeads.size;
    state.actionBarEl.querySelector('#dbr-count').textContent = n;
    state.actionBarEl.classList.toggle('show', n > 0);
  }

  function clearSelection() {
    state.selectedLeads.clear();
    document.querySelectorAll('.dbr-checkbox:checked').forEach(cb => {
      cb.checked = false;
    });
    updateActionBar();
    updateCheckboxesDisabled();
  }

  // ─── Export global ───────────────────────────────────────────────────────
  window.DialerBridge = {
    callLead,
    startCampaign,
    renderAttemptsBadge,
    attachButtons,
    enableMultiSelect,
    clearSelection,
    normalizePhone,
  };
})();
