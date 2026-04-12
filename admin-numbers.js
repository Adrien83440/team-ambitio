/**
 * admin-numbers.js
 * Contrôleur de la page admin-numbers.html.
 *
 * - Liste temps-réel des numéros via Firestore onSnapshot('phone_numbers')
 * - Recherche / Achat / Libération / Sync via SalesDialerAPI
 * - Modale d'achat avec sélecteur d'utilisateurs Firebase (collection 'users')
 * - Toasts FR + garde admin
 *
 * Dépend de : firebase compat v9.23.0 (déjà chargé), nav.js (init Firebase),
 *             sales-dialer-api.js (window.SalesDialerAPI).
 */
(function () {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  let db;
  let phoneUnsub = null;
  let usersCache = []; // [{uid, displayName, email, role}]
  let numbersCache = []; // numéros depuis Firestore

  // ─── Toasts ───────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const container = $('#toast-container');
    if (!container) { console.log(`[toast:${type}]`, msg); return; }
    const el = document.createElement('div');
    el.className = `an-toast an-toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 4000);
  }

  // ─── Auth + bootstrap ─────────────────────────────────────────────────
  function init() {
    if (typeof firebase === 'undefined') {
      console.error('[admin-numbers] Firebase not loaded');
      return;
    }
    db = firebase.firestore();

    firebase.auth().onAuthStateChanged(async (user) => {
      if (!user) { window.location.href = 'login.html'; return; }
      try {
        const snap = await db.collection('users').doc(user.uid).get();
        const data = snap.exists ? snap.data() : {};
        if (data.role !== 'admin') {
          toast("Accès réservé aux administrateurs.", 'error');
          setTimeout(() => { window.location.href = 'sales-dashboard.html'; }, 1500);
          return;
        }
        await loadUsers();
        // Attend que nav.js ait chargé _meta/team_members (cache localStorage
        // ou Firestore). Si déjà dispo, on continue immédiatement.
        if (window.TEAM_MEMBERS && Object.keys(window.TEAM_MEMBERS).length > 0) {
          subscribePhoneNumbers();
          bindUI();
        } else {
          window.addEventListener('team-members-loaded', () => {
            subscribePhoneNumbers();
            bindUI();
          }, { once: true });
          // Sécurité : si l'event ne vient jamais (cache vide + erreur réseau),
          // on bind quand même au bout de 3 s avec ce qu'on a.
          setTimeout(() => {
            if (!phoneUnsub) { subscribePhoneNumbers(); bindUI(); }
          }, 3000);
        }
      } catch (e) {
        console.error('[admin-numbers] init:', e);
        toast("Erreur de chargement initial.", 'error');
      }
    });
  }

  // ─── Chargement utilisateurs (pour le sélecteur d'assignation) ────────
  async function loadUsers() {
    const snap = await db.collection('users').get();
    usersCache = [];
    snap.forEach(d => usersCache.push(Object.assign({ uid: d.id }, d.data())));
    usersCache.sort((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || ''));
  }

  function userLabel(slugOrUid, fallbackUid) {
    // Affichage prioritaire via le slug team member (cohérent avec le reste d'Ambitio).
    // nav.js expose window.TEAM_MEMBERS = { slug: memberObj }
    if (slugOrUid && window.TEAM_MEMBERS && window.TEAM_MEMBERS[slugOrUid]) {
      const m = window.TEAM_MEMBERS[slugOrUid];
      const name = m.fullName || m.shortName || slugOrUid;
      const color = m.color || '#8b949e';
      return `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${esc(color)}"></span>${esc(name)}</span>`;
    }
    // Fallback : lookup users cache via UID
    if (fallbackUid) {
      const u = usersCache.find(x => x.uid === fallbackUid);
      if (u) return esc(u.displayName || u.email || fallbackUid);
    }
    return '<span style="color:var(--an-text-muted)">—</span>';
  }

  // ─── Live phone_numbers ───────────────────────────────────────────────
  function subscribePhoneNumbers() {
    if (phoneUnsub) phoneUnsub();
    phoneUnsub = db.collection('phone_numbers')
      .where('active', '==', true)
      .onSnapshot(
        (snap) => {
          numbersCache = [];
          snap.forEach(d => numbersCache.push(Object.assign({ id: d.id }, d.data())));
          numbersCache.sort((a, b) => (a.phoneNumber || '').localeCompare(b.phoneNumber || ''));
          renderNumbers();
          renderStats();
        },
        (err) => {
          console.error('[admin-numbers] snapshot:', err);
          toast("Erreur de lecture Firestore : " + err.message, 'error');
        }
      );
  }

  // ─── Render stats ─────────────────────────────────────────────────────
  function renderStats() {
    const total = numbersCache.length;
    const local = numbersCache.filter(n => n.numberType === 'local').length;
    const mobile = numbersCache.filter(n => n.numberType === 'mobile').length;
    const cost = numbersCache.reduce((s, n) => s + (Number(n.monthlyPrice) || 0), 0);
    $('#stat-total').textContent  = total;
    $('#stat-local').textContent  = local;
    $('#stat-mobile').textContent = mobile;
    $('#stat-cost').textContent   = cost.toFixed(2) + ' €';
  }

  // ─── Render table des numéros actifs ──────────────────────────────────
  function badge(type) {
    const t = (type || 'national').toLowerCase();
    const labels = { local: 'Local', mobile: 'Mobile', national: 'National', tollfree: 'N° vert' };
    return `<span class="an-badge an-badge-${t}">${labels[t] || esc(t)}</span>`;
  }

  function renderNumbers() {
    const tbody = $('#numbers-tbody');
    if (!tbody) return;
    if (numbersCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="an-empty">Aucun numéro actif. Achetez-en un ci-dessous ou synchronisez depuis Twilio.</td></tr>';
      return;
    }
    tbody.innerHTML = numbersCache.map(n => `
      <tr>
        <td><strong>${esc(n.phoneNumber)}</strong></td>
        <td>${badge(n.numberType)}</td>
        <td>${esc(n.friendlyName || '')}</td>
        <td>${userLabel(n.assignedToSlug, n.assignedTo)}</td>
        <td>${esc(n.locality || n.region || (n.regionIndicatif ? 'Indicatif ' + String(n.regionIndicatif).replace(/^0+/, '0') : (n.countryCode || '')))}</td>
        <td class="an-row-actions">
          <button class="an-btn an-btn-ghost" data-action="edit" data-id="${esc(n.id)}">Modifier</button>
          <button class="an-btn an-btn-danger" data-action="release" data-id="${esc(n.id)}" data-num="${esc(n.phoneNumber)}">Libérer</button>
        </td>
      </tr>
    `).join('');
  }

  // ─── Render résultats de recherche ────────────────────────────────────
  let lastSearchResults = [];

  function renderResults(numbers) {
    lastSearchResults = numbers || [];
    const section = $('#results-section');
    const tbody = $('#results-tbody');
    if (!tbody || !section) return;
    if (lastSearchResults.length === 0) {
      section.hidden = false;
      tbody.innerHTML = '<tr><td colspan="5" class="an-empty">Aucun résultat. Essayez d\'autres critères.</td></tr>';
      return;
    }
    section.hidden = false;
    tbody.innerHTML = lastSearchResults.map((n, i) => {
      const caps = [];
      if (n.capabilities && n.capabilities.voice) caps.push('Voix');
      if (n.capabilities && n.capabilities.sms)   caps.push('SMS');
      if (n.capabilities && n.capabilities.mms)   caps.push('MMS');
      return `
        <tr>
          <td><strong>${esc(n.phoneNumber)}</strong></td>
          <td>${esc(n.locality || n.region || '—')}</td>
          <td>${caps.join(' · ') || '—'}</td>
          <td>~1,00 €/mois</td>
          <td class="an-row-actions">
            <button class="an-btn an-btn-primary" data-action="buy" data-idx="${i}">Acheter</button>
          </td>
        </tr>`;
    }).join('');
  }

  // ─── Modale d'achat ───────────────────────────────────────────────────
  function openPurchaseModal(searchResult) {
    $('#pm-number').textContent = searchResult.phoneNumber;
    $('#pm-friendly').value = searchResult.friendlyName || `Ambitio ${searchResult.locality || ''}`.trim();

    // Sélecteur basé sur _meta/team_members (cohérent avec le reste d'Ambitio).
    // nav.js expose window.TEAM_MEMBERS_ACTIVE (array trié, actifs uniquement).
    // Filtrage : on exclut les coachs (rôles 'Coaching', 'Coach') du module Dialer.
    const tm = Array.isArray(window.TEAM_MEMBERS_ACTIVE) ? window.TEAM_MEMBERS_ACTIVE : [];
    const eligible = tm.filter(m => {
      const r = (m.role || '').toLowerCase();
      return !r.includes('coach'); // exclut Mickael, Edouard
    });

    const select = $('#pm-assigned');
    select.innerHTML = '<option value="">— Non assigné —</option>' +
      eligible.map(m => {
        // On retrouve l'UID Firebase via l'email du team member
        const matchUser = usersCache.find(u => u.email && m.email && u.email.toLowerCase() === m.email.toLowerCase());
        const uid = matchUser ? matchUser.uid : '';
        return `<option value="${esc(m.slug)}" data-uid="${esc(uid)}" data-role="${esc(matchUser ? matchUser.role : '')}">${esc(m.fullName || m.shortName || m.slug)} (${esc(m.role || '')})</option>`;
      }).join('');

    // Restaurer libellés en mode achat (au cas où on vient de quitter le mode édition)
    $('.an-modal-content h3').textContent = "Confirmer l'achat";
    $('#pm-confirm').textContent = "Acheter";

    const modal = $('#purchase-modal');
    modal.hidden = false;
    modal.dataset.mode = 'purchase';
    modal.dataset.searchPayload = JSON.stringify(searchResult);
    delete modal.dataset.editId;
  }

  function closePurchaseModal() {
    const modal = $('#purchase-modal');
    modal.hidden = true;
    delete modal.dataset.mode;
    delete modal.dataset.editId;
    delete modal.dataset.searchPayload;
  }

  async function confirmPurchase() {
    const modal = $('#purchase-modal');
    const sr = JSON.parse(modal.dataset.searchPayload || '{}');
    const friendlyName = $('#pm-friendly').value.trim();
    const select = $('#pm-assigned');
    const slug = select.value || null;
    const opt = slug ? select.options[select.selectedIndex] : null;
    const assignedTo = opt ? (opt.dataset.uid || null) : null;
    const assignedToRole = opt ? (opt.dataset.role || null) : null;

    if (slug && !assignedTo) {
      toast(`Impossible d'assigner : aucun compte Firebase trouvé pour ${slug}. Vérifiez admin-users.html.`, 'error');
      return;
    }

    const numberType = ($('#f-type').value || 'national');
    const regionIndicatif = $('#f-area').value.trim() || null;

    const btn = $('#pm-confirm');
    btn.disabled = true; btn.textContent = 'Achat en cours…';
    try {
      const res = await window.SalesDialerAPI.purchaseNumber({
        phoneNumber: sr.phoneNumber,
        friendlyName,
        numberType,
        regionIndicatif,
        countryCode: $('#f-country').value || 'FR',
        assignedTo,
        assignedToSlug: slug,
        assignedToRole,
      });
      toast(`Numéro ${res.phoneNumber} acheté avec succès.`, 'success');
      closePurchaseModal();
      lastSearchResults = lastSearchResults.filter(x => x.phoneNumber !== sr.phoneNumber);
      renderResults(lastSearchResults);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Acheter';
    }
  }

  // ─── Modale d'édition (réassigner + renommer) ─────────────────────────
  function openEditModal(numberId) {
    const n = numbersCache.find(x => x.id === numberId);
    if (!n) { toast("Numéro introuvable.", 'error'); return; }

    $('#pm-number').textContent = n.phoneNumber;
    $('#pm-friendly').value = n.friendlyName || '';

    // Même logique de population que pour l'achat
    const tm = Array.isArray(window.TEAM_MEMBERS_ACTIVE) ? window.TEAM_MEMBERS_ACTIVE : [];
    const eligible = tm.filter(m => !((m.role || '').toLowerCase().includes('coach')));
    const select = $('#pm-assigned');
    select.innerHTML = '<option value="">— Non assigné —</option>' +
      eligible.map(m => {
        const matchUser = usersCache.find(u => u.email && m.email && u.email.toLowerCase() === m.email.toLowerCase());
        const uid = matchUser ? matchUser.uid : '';
        const sel = (m.slug === n.assignedToSlug) ? ' selected' : '';
        return `<option value="${esc(m.slug)}" data-uid="${esc(uid)}" data-role="${esc(matchUser ? matchUser.role : '')}"${sel}>${esc(m.fullName || m.shortName || m.slug)} (${esc(m.role || '')})</option>`;
      }).join('');

    // Adapter les libellés et boutons en mode édition
    $('.an-modal-content h3').textContent = "Modifier le numéro";
    $('#pm-confirm').textContent = "Enregistrer";

    const modal = $('#purchase-modal');
    modal.hidden = false;
    modal.dataset.mode = 'edit';
    modal.dataset.editId = numberId;
  }

  async function confirmEdit() {
    const modal = $('#purchase-modal');
    const numberId = modal.dataset.editId;
    if (!numberId) return;

    const friendlyName = $('#pm-friendly').value.trim();
    const select = $('#pm-assigned');
    const slug = select.value || null;
    const opt = slug ? select.options[select.selectedIndex] : null;
    const assignedTo = opt ? (opt.dataset.uid || null) : null;
    const assignedToRole = opt ? (opt.dataset.role || null) : null;

    if (slug && !assignedTo) {
      toast(`Aucun compte Firebase trouvé pour ${slug}. Vérifiez admin-users.html.`, 'error');
      return;
    }

    const btn = $('#pm-confirm');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      await db.collection('phone_numbers').doc(numberId).update({
        friendlyName: friendlyName || null,
        assignedTo,
        assignedToSlug: slug,
        assignedToRole,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: firebase.auth().currentUser.uid,
      });
      toast("Modifications enregistrées.", 'success');
      closePurchaseModal();
    } catch (e) {
      console.error('[admin-numbers] update:', e);
      toast("Erreur d'enregistrement : " + (e.message || e.code), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function handleSearch(ev) {
    ev.preventDefault();
    const params = {
      countryCode:     $('#f-country').value || 'FR',
      numberType:      $('#f-type').value || 'national',
      regionIndicatif: $('#f-area').value.trim() || undefined,
      limit: 20,
    };
    const submitBtn = ev.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true; submitBtn.textContent = 'Recherche…';
    try {
      const res = await window.SalesDialerAPI.searchNumbers(params);
      renderResults(res.numbers || []);
      toast(`${(res.numbers || []).length} résultat(s) trouvé(s).`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = 'Rechercher';
    }
  }

  async function handleRelease(numberId, label) {
    if (!confirm(`Libérer le numéro ${label} ?\n\nIl sera supprimé chez Twilio et marqué inactif.`)) return;
    try {
      await window.SalesDialerAPI.releaseNumber({ numberId });
      toast(`Numéro ${label} libéré.`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function handleSync() {
    const btn = $('#btn-sync');
    btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="an-btn-icon">⏳</span> Synchronisation…';
    try {
      const res = await window.SalesDialerAPI.syncNumbers();
      const r = res.report || {};
      toast(`Sync OK : ${r.imported || 0} importé(s), ${r.updated || 0} mis à jour, ${r.webhooksReconfigured || 0} webhook(s) reconfiguré(s).`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = old;
    }
  }

  // ─── Bind UI ──────────────────────────────────────────────────────────
  function bindUI() {
    $('#search-form').addEventListener('submit', handleSearch);
    $('#btn-sync').addEventListener('click', handleSync);
    $('#pm-cancel').addEventListener('click', closePurchaseModal);
    $('#pm-confirm').addEventListener('click', () => {
      const mode = $('#purchase-modal').dataset.mode;
      if (mode === 'edit') confirmEdit();
      else confirmPurchase();
    });

    // Délégation pour les boutons générés dynamiquement
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'buy') {
        const idx = parseInt(btn.dataset.idx, 10);
        const sr = lastSearchResults[idx];
        if (sr) openPurchaseModal(sr);
      } else if (action === 'edit') {
        openEditModal(btn.dataset.id);
      } else if (action === 'release') {
        handleRelease(btn.dataset.id, btn.dataset.num);
      }
    });

    // Fermer modale au clic extérieur
    $('#purchase-modal').addEventListener('click', (ev) => {
      if (ev.target.id === 'purchase-modal') closePurchaseModal();
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
