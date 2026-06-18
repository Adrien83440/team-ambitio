/* ==========================================================================
 * inbox-widget.js
 * --------------------------------------------------------------------------
 * Widget flottant de notifications SMS/appels entrants pour Ambitio.
 *
 * VISIBILITÉ : rôles `sales` et `admin` uniquement. Les coachs ne voient
 * jamais ce widget (filtré dans onAuthStateChanged ci-dessous).
 *
 * SOURCE DE DONNÉES : collection Firestore `inbox_notifications`
 *   - alimentée backend par : api/twilio-sms-inbound.js, api/twilio-inbound.js,
 *     onWebhookInbox (Cloud Function, pour Ringover SMS/calls + Twilio call status)
 *   - schema : voir DEPLOY-inbox-notifications.md
 *
 * VISIBILITÉ DES NOTIFS :
 *   - admin : voit toutes les notifs (queryAll)
 *   - sales : voit uniquement celles avec ownerUid == son uid
 *
 * ÉTAT LU/NON LU : per-user via map `readBy: {uid: timestamp}`. Marquer une
 * notif comme lue = écriture sur la notif uniquement (pas de doc séparé).
 *
 * NOTIFICATIONS SORTANTES :
 *   - son discret (Web Audio API, pas de fichier binaire)
 *   - Browser Notification API (demande permission au 1er load)
 *   - toast in-app (top-right)
 *
 * COMPOSER SMS : envoi via /api/twilio-sms-send (Vercel Function), récupère
 * idToken Firebase pour auth.
 *
 * ARCHI : module IIFE auto-injectant, expose window.InboxWidget pour debug.
 * ==========================================================================
 */

(function () {
  'use strict';

  // ---------- GUARD : empêcher double-init ----------
  if (window.__inboxWidgetMounted) {
    console.log('[InboxWidget] Already mounted, skipping');
    return;
  }
  window.__inboxWidgetMounted = true;

  // ---------- CONFIG ----------
  const COLLECTION = 'inbox_notifications';
  const QUERY_LIMIT = 50;          // dernières N notifs chargées en mémoire
  const TOAST_TTL_MS = 6000;       // durée d'affichage d'un toast
  const SOUND_DEBOUNCE_MS = 1500;  // ne pas spammer le son
  const SMS_SEND_ENDPOINT = '/api/ringover-sms-send';

  // ---------- ÉTAT ----------
  let firebaseAuth = null;
  let firebaseDb = null;
  let currentUid = null;
  let currentRole = null;
  let unsubscribeListener = null;
  let notifications = [];          // cache local des notifs
  let lastSoundAt = 0;
  let initialSnapshotDone = false;
  let activeFilter = 'all';        // 'all' | 'unread' | 'sms' | 'calls'
  let composerLeadId = null;       // lead actuellement ouvert dans composer

  // ---------- HELPERS ----------
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    const d = new Date(ts);
    return isNaN(d) ? 0 : d.getTime();
  }

  function relativeTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return 'maintenant';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'à l\'instant';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.floor(h / 24);
    if (d < 7) return d + ' j';
    const date = new Date(ms);
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  function formatTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function isUnreadByMe(notif) {
    if (!currentUid) return false;
    const readBy = notif.readBy || {};
    return !readBy[currentUid];
  }

  function getIconForType(type) {
    if (type === 'sms')         return { cls: 'sms',    glyph: '💬' };
    if (type === 'call_missed') return { cls: 'missed', glyph: '📵' };
    if (type === 'call')        return { cls: 'call',   glyph: '📞' };
    return { cls: 'sms', glyph: '🔔' };
  }

  function getTypeLabel(type) {
    if (type === 'sms')         return 'SMS';
    if (type === 'call_missed') return 'Appel manqué';
    if (type === 'call')        return 'Appel entrant';
    return 'Notif';
  }

  function getSourceLabel(source) {
    if (!source) return '';
    if (source.includes('twilio'))   return 'Twilio';
    if (source.includes('ringover')) return 'Ringover';
    return source;
  }

  // ---------- SON ----------
  let audioCtx = null;
  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { /* navigateur ne supporte pas */ }
    return audioCtx;
  }

  function playDing() {
    const now = Date.now();
    if (now - lastSoundAt < SOUND_DEBOUNCE_MS) return;
    lastSoundAt = now;

    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      // 2-tons doux : 880 Hz puis 1175 Hz
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(1175, ctx.currentTime + 0.18);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) { /* silent */ }
  }

  // ---------- BROWSER NOTIFICATION API ----------
  function ensureNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      // Demande différée d'1s pour ne pas spammer au load
      setTimeout(() => {
        try { Notification.requestPermission().catch(() => {}); } catch (e) { /* ignore */ }
      }, 1000);
    }
  }

  function showBrowserNotification(notif) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return; // pas si la page est visible (toast suffit)

    const titleLabel = getTypeLabel(notif.type);
    const leadLabel  = notif.leadName || notif.fromNumber || 'Numéro inconnu';
    const body       = notif.preview || (notif.type === 'call_missed' ? 'Appel manqué' : '');

    try {
      const n = new Notification(titleLabel + ' — ' + leadLabel, {
        body: body,
        tag: notif.id, // évite les doublons
        icon: '/icon-leads.png',
        silent: false,
      });
      n.onclick = function () {
        window.focus();
        var target = resolveNotifTarget(notif);
        if (target) window.location.href = target;
        n.close();
      };
      setTimeout(() => { try { n.close(); } catch (e) {} }, 8000);
    } catch (e) { /* iOS Safari peut throw */ }
  }

  // ---------- TOAST IN-APP ----------
  function showToast(notif) {
    let stack = document.getElementById('ambitio-inbox-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'ambitio-inbox-toast-stack';
      document.body.appendChild(stack);
    }

    const icon = getIconForType(notif.type);
    const leadLabel = notif.leadName || notif.fromNumber || 'Numéro inconnu';
    const titleLabel = getTypeLabel(notif.type);

    const toast = document.createElement('div');
    toast.className = 'iw-toast';
    toast.innerHTML =
      '<div class="iw-toast-icon">' + icon.glyph + '</div>' +
      '<div class="iw-toast-content">' +
        '<div class="iw-toast-title">' + escapeHtml(titleLabel) + ' — ' + escapeHtml(leadLabel) + '</div>' +
        (notif.preview
          ? '<div class="iw-toast-preview">' + escapeHtml(notif.preview) + '</div>'
          : '') +
      '</div>';

    toast.addEventListener('click', function () {
      handleNotifClick(notif);
      removeToast(toast);
    });

    stack.appendChild(toast);
    setTimeout(() => removeToast(toast), TOAST_TTL_MS);
  }

  function removeToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('leaving');
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 250);
  }

  // ---------- DOM : MONTAGE DU WIDGET ----------
  function mountDom() {
    // FAB
    const fab = document.createElement('div');
    fab.id = 'ambitio-inbox-fab';
    fab.title = 'Inbox SMS & appels';
    fab.innerHTML =
      '<span class="iw-fab-glyph">🔔</span>' +
      '<span class="iw-fab-badge hidden">0</span>';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);

    // PANNEAU
    const panel = document.createElement('div');
    panel.id = 'ambitio-inbox-panel';
    panel.innerHTML =
      '<div class="iw-panel-header">' +
        '<div class="iw-panel-title">' +
          'Inbox' +
          '<span class="iw-panel-title-count hidden">0</span>' +
        '</div>' +
        '<div class="iw-panel-actions">' +
          '<button class="iw-panel-action-btn" data-act="mark-all">Tout marquer lu</button>' +
        '</div>' +
      '</div>' +
      '<div class="iw-panel-tabs">' +
        '<button class="iw-tab active" data-filter="all">Tout</button>' +
        '<button class="iw-tab" data-filter="unread">Non lu</button>' +
        '<button class="iw-tab" data-filter="sms">SMS</button>' +
        '<button class="iw-tab" data-filter="calls">Appels</button>' +
      '</div>' +
      '<div class="iw-panel-list"></div>';
    document.body.appendChild(panel);

    // Délégation events panel
    panel.addEventListener('click', function (e) {
      // Filtres tabs
      const tab = e.target.closest('.iw-tab');
      if (tab) {
        activeFilter = tab.dataset.filter;
        panel.querySelectorAll('.iw-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderList();
        return;
      }
      // Action header
      if (e.target.matches('[data-act="mark-all"]')) {
        markAllAsRead();
        return;
      }
      // Action bouton
      const actBtn = e.target.closest('.iw-action-btn');
      if (actBtn) {
        e.stopPropagation();
        const notifId = actBtn.closest('.iw-item').dataset.notifId;
        const action = actBtn.dataset.action;
        const notif = notifications.find(n => n.id === notifId);
        if (notif) handleNotifAction(notif, action);
        return;
      }
      // Clic sur item (conversation groupée)
      const item = e.target.closest('.iw-item');
      if (item) {
        const notifId = item.dataset.notifId;
        const groupIds = (item.dataset.groupIds || notifId).split(',').filter(Boolean);
        // Marque toutes les notifs de la conversation comme lues (pas seulement
        // la représentative) pour que le compteur retombe à zéro.
        markGroupAsRead(groupIds);
        const notif = notifications.find(n => n.id === notifId);
        if (notif) handleNotifClick(notif);
      }
    });

    // Composer
    const composer = document.createElement('div');
    composer.id = 'ambitio-inbox-composer';
    composer.innerHTML =
      '<div class="iw-comp-header">' +
        '<div>' +
          '<div class="iw-comp-to-name"></div>' +
          '<div class="iw-comp-to"></div>' +
        '</div>' +
        '<button class="iw-comp-close" title="Fermer">×</button>' +
      '</div>' +
      '<div class="iw-comp-thread"></div>' +
      '<div class="iw-comp-input-zone">' +
        '<textarea class="iw-comp-textarea" placeholder="Tapez votre réponse SMS…" rows="1"></textarea>' +
        '<button class="iw-comp-send" title="Envoyer">➤</button>' +
      '</div>' +
      '<div class="iw-comp-status"></div>';
    document.body.appendChild(composer);

    composer.querySelector('.iw-comp-close').addEventListener('click', closeComposer);
    composer.querySelector('.iw-comp-send').addEventListener('click', sendComposerSms);
    const ta = composer.querySelector('.iw-comp-textarea');
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendComposerSms();
      }
    });

    // Fermer panel sur clic extérieur
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target)) return;
      if (fab.contains(e.target)) return;
      if (composer.contains(e.target)) return;
      panel.classList.remove('open');
    });

    // Escape ferme tout
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        panel.classList.remove('open');
        closeComposer();
      }
    });
  }

  function togglePanel() {
    const panel = document.getElementById('ambitio-inbox-panel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      // Premier-démarrage AudioContext (geste user)
      ensureAudioCtx();
    }
  }

  // ---------- RENDU ----------
  function renderList() {
    const listEl = document.querySelector('#ambitio-inbox-panel .iw-panel-list');
    if (!listEl) return;

    let filtered = notifications.slice();
    if (activeFilter === 'unread') filtered = filtered.filter(isUnreadByMe);
    else if (activeFilter === 'sms') filtered = filtered.filter(n => n.type === 'sms');
    else if (activeFilter === 'calls') filtered = filtered.filter(n => n.type === 'call' || n.type === 'call_missed');

    if (filtered.length === 0) {
      listEl.innerHTML =
        '<div class="iw-empty">' +
          '<div class="iw-empty-icon">📭</div>' +
          '<div class="iw-empty-text">Aucune notification' +
            (activeFilter !== 'all' ? '<br>dans ce filtre' : '') +
          '</div>' +
        '</div>';
      return;
    }

    // Regroupement par conversation : clé = leadId si présent, sinon fromNumber.
    // Une seule ligne par interlocuteur, montrant le dernier message + un
    // compteur de non-lus. Le clic ouvre le fil complet (composer).
    const groups = groupNotifs(filtered);
    listEl.innerHTML = groups.map(renderGroupItem).join('');
  }

  // Regroupe une liste de notifs par conversation, triée par activité récente.
  // Chaque groupe : { rep (notif la plus récente), count, unreadCount, ids[] }.
  function groupNotifs(list) {
    const map = new Map();
    list.forEach(n => {
      const key = n.leadId ? ('lead:' + n.leadId) : (n.fromNumber ? ('num:' + n.fromNumber) : ('id:' + n.id));
      let g = map.get(key);
      if (!g) {
        g = { key: key, rep: n, count: 0, unreadCount: 0, ids: [] };
        map.set(key, g);
      }
      g.count++;
      g.ids.push(n.id);
      if (isUnreadByMe(n)) g.unreadCount++;
      // rep = notif la plus récente du groupe
      if (tsToMs(n.createdAt) > tsToMs(g.rep.createdAt)) g.rep = n;
    });
    const arr = Array.from(map.values());
    arr.sort((a, b) => tsToMs(b.rep.createdAt) - tsToMs(a.rep.createdAt));
    return arr;
  }

  // Rend une ligne de conversation groupée. On réutilise data-notif-id avec
  // l'id de la notif représentative : tout le câblage clic/actions existant
  // continue de fonctionner sans changement.
  function renderGroupItem(group) {
    const notif = group.rep;
    const icon = getIconForType(notif.type);
    const unread = group.unreadCount > 0;
    const leadLabel = notif.leadName || notif.fromNumber || 'Numéro inconnu';
    const leadCls = notif.leadName ? '' : ' no-lead';
    const sourceLabel = getSourceLabel(notif.source);
    const typeLabel = getTypeLabel(notif.type);

    const actions = [];
    if (notif.type === 'sms' && notif.leadId) {
      actions.push('<button class="iw-action-btn" data-action="reply" title="Répondre">💬</button>');
    }
    if (notif.fromNumber) {
      actions.push('<button class="iw-action-btn" data-action="call" title="Rappeler">📞</button>');
    }
    if (notif.leadId) {
      actions.push('<button class="iw-action-btn" data-action="open" title="Ouvrir fiche">👁</button>');
    }

    // Badge compteur : nombre de messages non lus dans la conversation (ou
    // nombre total de messages si tout est lu, pour signaler un fil multi-SMS).
    const countBadge = group.unreadCount > 0
      ? '<span class="iw-item-count unread">' + group.unreadCount + '</span>'
      : (group.count > 1 ? '<span class="iw-item-count">' + group.count + '</span>' : '');

    const previewText = notif.preview || notif.text || notif.content ||
      (notif.type === 'call_missed' ? 'Appel manqué' : '');

    return (
      '<div class="iw-item' + (unread ? ' unread' : '') + '" data-notif-id="' + escapeHtml(notif.id) + '" data-group-ids="' + escapeHtml(group.ids.join(',')) + '">' +
        '<div class="iw-item-icon ' + icon.cls + '">' + icon.glyph + '</div>' +
        '<div class="iw-item-body">' +
          '<div class="iw-item-row1">' +
            '<div class="iw-item-name' + leadCls + '">' + escapeHtml(leadLabel) + '</div>' +
            '<div class="iw-item-time">' + escapeHtml(relativeTime(notif.createdAt)) + '</div>' +
          '</div>' +
          (previewText
            ? '<div class="iw-item-preview' + (notif.type === 'call_missed' ? '" style="color:#ef4444;font-style:italic;' : '') + '">' + escapeHtml(previewText) + '</div>'
            : '') +
          '<div class="iw-item-meta">' +
            '<span>' + escapeHtml(typeLabel) + '</span>' +
            (sourceLabel ? '<span class="iw-meta-dot">·</span><span>' + escapeHtml(sourceLabel) + '</span>' : '') +
            (notif.fromNumber ? '<span class="iw-meta-dot">·</span><span>' + escapeHtml(notif.fromNumber) + '</span>' : '') +
          '</div>' +
        '</div>' +
        (countBadge ? '<div class="iw-item-countwrap">' + countBadge + '</div>' : '') +
        (actions.length ? '<div class="iw-item-actions">' + actions.join('') + '</div>' : '') +
      '</div>'
    );
  }

  function renderItem(notif) {
    const icon = getIconForType(notif.type);
    const unread = isUnreadByMe(notif);
    const leadLabel = notif.leadName || notif.fromNumber || 'Numéro inconnu';
    const leadCls = notif.leadName ? '' : ' no-lead';
    const sourceLabel = getSourceLabel(notif.source);
    const typeLabel = getTypeLabel(notif.type);

    const actions = [];
    if (notif.type === 'sms' && notif.leadId) {
      actions.push('<button class="iw-action-btn" data-action="reply" title="Répondre">💬</button>');
    }
    if (notif.fromNumber) {
      actions.push('<button class="iw-action-btn" data-action="call" title="Rappeler">📞</button>');
    }
    if (notif.leadId) {
      actions.push('<button class="iw-action-btn" data-action="open" title="Ouvrir fiche">👁</button>');
    }

    return (
      '<div class="iw-item' + (unread ? ' unread' : '') + '" data-notif-id="' + escapeHtml(notif.id) + '">' +
        '<div class="iw-item-icon ' + icon.cls + '">' + icon.glyph + '</div>' +
        '<div class="iw-item-body">' +
          '<div class="iw-item-row1">' +
            '<div class="iw-item-name' + leadCls + '">' + escapeHtml(leadLabel) + '</div>' +
            '<div class="iw-item-time">' + escapeHtml(relativeTime(notif.createdAt)) + '</div>' +
          '</div>' +
          (notif.preview
            ? '<div class="iw-item-preview">' + escapeHtml(notif.preview) + '</div>'
            : (notif.type === 'call_missed'
                ? '<div class="iw-item-preview" style="color:#ef4444;font-style:italic;">Appel manqué</div>'
                : '')) +
          '<div class="iw-item-meta">' +
            '<span>' + escapeHtml(typeLabel) + '</span>' +
            (sourceLabel ? '<span class="iw-meta-dot">·</span><span>' + escapeHtml(sourceLabel) + '</span>' : '') +
            (notif.fromNumber ? '<span class="iw-meta-dot">·</span><span>' + escapeHtml(notif.fromNumber) + '</span>' : '') +
          '</div>' +
        '</div>' +
        (actions.length ? '<div class="iw-item-actions">' + actions.join('') + '</div>' : '') +
      '</div>'
    );
  }

  function updateBadge() {
    const fab   = document.getElementById('ambitio-inbox-fab');
    const badge = fab ? fab.querySelector('.iw-fab-badge') : null;
    const headerCount = document.querySelector('#ambitio-inbox-panel .iw-panel-title-count');
    if (!fab || !badge) return;

    const unreadCount = notifications.filter(isUnreadByMe).length;

    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      badge.classList.remove('hidden');
      fab.classList.add('has-unread');
      if (headerCount) {
        headerCount.textContent = String(unreadCount);
        headerCount.classList.remove('hidden');
      }
    } else {
      badge.classList.add('hidden');
      fab.classList.remove('has-unread');
      if (headerCount) headerCount.classList.add('hidden');
    }

    // Favicon dynamique : on pourrait ajouter un dot, à voir plus tard.
    // Title bar bling
    const baseTitle = (window.__inboxBaseTitle = window.__inboxBaseTitle || document.title.replace(/^\(\d+\)\s*/, ''));
    document.title = unreadCount > 0 ? '(' + unreadCount + ') ' + baseTitle : baseTitle;
  }

  // ---------- ACTIONS ----------

  // Centralise la résolution de l'URL cible quand on clique sur une notif.
  // Priorité au champ `deepLinkUrl` posé par les nouvelles notifs (mentions
  // vocaux + notes texte → Lead Live). Sinon fallback historique :
  // sales-contact.html (fiche pipeline) pour SMS/appels entrants.
  function resolveNotifTarget(notif) {
    if (notif.deepLinkUrl) return notif.deepLinkUrl;
    if (notif.leadId) return 'sales-contact.html?id=' + encodeURIComponent(notif.leadId);
    return null;
  }

  function handleNotifClick(notif) {
    markAsRead(notif);
    var target = resolveNotifTarget(notif);
    if (target) {
      window.location.href = target;
    } else if (notif.fromNumber) {
      // Pas de fiche lead liée à ce numéro : on ouvre quand même le composer
      // pour LIRE le SMS (porté par la notif via notif.text/content/preview)
      // et pouvoir répondre. Avant, on bloquait l'utilisateur avec une alerte
      // et le SMS restait invisible — alors que le contenu est disponible.
      openComposer(notif);
    }
  }

  function handleNotifAction(notif, action) {
    if (action === 'reply') {
      markAsRead(notif);
      openComposer(notif);
      return;
    }
    if (action === 'call') {
      markAsRead(notif);
      // Ouvre le dialer avec contexte
      try {
        sessionStorage.setItem('dialer_pending_call', JSON.stringify({
          leadId: notif.leadId || null,
          leadName: notif.leadName || null,
          phone: notif.fromNumber,
        }));
      } catch (e) { /* ignore */ }
      window.location.href = 'sales-dialer.html';
      return;
    }
    if (action === 'open') {
      markAsRead(notif);
      var target = resolveNotifTarget(notif);
      if (target) window.location.href = target;
      return;
    }
  }

  function markAsRead(notif) {
    if (!currentUid) return;
    if (!isUnreadByMe(notif)) return;
    // Optimistic update local
    notif.readBy = notif.readBy || {};
    notif.readBy[currentUid] = new Date();
    updateBadge();
    renderList();
    // Push Firestore (merge)
    const update = {};
    update['readBy.' + currentUid] = firebase.firestore.FieldValue.serverTimestamp();
    firebaseDb.collection(COLLECTION).doc(notif.id).update(update).catch(err => {
      console.warn('[InboxWidget] markAsRead failed:', err);
    });
  }

  // Marque comme lues toutes les notifs dont l'id est dans la liste (utilisé
  // au clic sur une conversation groupée). S'appuie sur markAsRead unitaire.
  function markGroupAsRead(ids) {
    if (!Array.isArray(ids)) return;
    ids.forEach(id => {
      const n = notifications.find(x => x.id === id);
      if (n) markAsRead(n);
    });
  }

  function markAllAsRead() {
    const unread = notifications.filter(isUnreadByMe);
    if (unread.length === 0) return;
    const batch = firebaseDb.batch();
    unread.forEach(n => {
      const ref = firebaseDb.collection(COLLECTION).doc(n.id);
      const update = {};
      update['readBy.' + currentUid] = firebase.firestore.FieldValue.serverTimestamp();
      batch.update(ref, update);
      // Optimistic
      n.readBy = n.readBy || {};
      n.readBy[currentUid] = new Date();
    });
    updateBadge();
    renderList();
    batch.commit().catch(err => console.warn('[InboxWidget] markAllAsRead failed:', err));
  }

  // ---------- COMPOSER SMS ----------
  function openComposer(notif) {
    const composer = document.getElementById('ambitio-inbox-composer');
    if (!composer) return;
    composerLeadId = notif.leadId || null;

    composer.querySelector('.iw-comp-to-name').textContent = notif.leadName || 'Numéro inconnu';
    composer.querySelector('.iw-comp-to').textContent = notif.fromNumber || '';
    composer.querySelector('.iw-comp-textarea').value = '';
    composer.querySelector('.iw-comp-status').textContent = '';
    composer.querySelector('.iw-comp-status').className = 'iw-comp-status';

    // Charge les dernières comms du lead (si existant)
    const threadEl = composer.querySelector('.iw-comp-thread');
    threadEl.innerHTML = '<div class="iw-comp-thread-empty">Chargement…</div>';
    composer.dataset.toNumber = notif.fromNumber || '';
    composer.classList.add('open');

    // Focus textarea
    setTimeout(() => composer.querySelector('.iw-comp-textarea').focus(), 50);

    if (notif.leadId) {
      loadThreadForLead(notif.leadId);
    } else {
      // Numéro sans fiche lead : on affiche au moins le SMS porté par la notif
      // (ringover-sms-inbound stocke le texte dans notif.text ET notif.content ;
      //  fallback preview). L'utilisateur peut le lire et répondre directement.
      var smsText = notif.text || notif.content || notif.preview || '';
      var banner = '<div class="iw-comp-thread-banner">Numéro non enregistré' +
        (notif.fromNumber ? ' (' + escapeHtml(notif.fromNumber) + ')' : '') +
        ' — aucune fiche lead. Vous pouvez lire et répondre ici.</div>';
      if (smsText) {
        var t = formatTime(notif.date || notif.createdAt);
        threadEl.innerHTML = banner +
          '<div class="iw-comp-bubble in">' + escapeHtml(smsText) +
            '<span class="iw-comp-bubble-time">' + escapeHtml(t) + '</span>' +
          '</div>';
      } else {
        threadEl.innerHTML = banner +
          '<div class="iw-comp-thread-empty">SMS sans contenu lisible</div>';
      }
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }

  function closeComposer() {
    const composer = document.getElementById('ambitio-inbox-composer');
    if (!composer) return;
    composer.classList.remove('open');
    composerLeadId = null;
  }

  function loadThreadForLead(leadId) {
    const composer = document.getElementById('ambitio-inbox-composer');
    if (!composer) return;
    const threadEl = composer.querySelector('.iw-comp-thread');

    firebaseDb.collection('leads').doc(leadId).get()
      .then(snap => {
        if (!snap.exists) {
          threadEl.innerHTML = '<div class="iw-comp-thread-empty">Lead introuvable</div>';
          return;
        }
        const data = snap.data();
        const comms = (data.communications || [])
          .filter(c => c && c.type === 'sms')
          .sort((a, b) => tsToMs(a.date || a.createdAt) - tsToMs(b.date || b.createdAt))
          .slice(-30);
        if (comms.length === 0) {
          threadEl.innerHTML = '<div class="iw-comp-thread-empty">Aucun SMS dans l\'historique</div>';
          return;
        }
        threadEl.innerHTML = comms.map(c => {
          const dir = (c.direction === 'inbound') ? 'in' : 'out';
          const time = formatTime(c.date || c.createdAt);
          return (
            '<div class="iw-comp-bubble ' + dir + '">' +
              escapeHtml(c.content || '') +
              '<span class="iw-comp-bubble-time">' + escapeHtml(time) + '</span>' +
            '</div>'
          );
        }).join('');
        threadEl.scrollTop = threadEl.scrollHeight;
      })
      .catch(err => {
        console.warn('[InboxWidget] loadThreadForLead error:', err);
        threadEl.innerHTML = '<div class="iw-comp-thread-empty">Erreur de chargement</div>';
      });
  }

  function sendComposerSms() {
    const composer = document.getElementById('ambitio-inbox-composer');
    if (!composer || !composer.classList.contains('open')) return;

    const ta = composer.querySelector('.iw-comp-textarea');
    const sendBtn = composer.querySelector('.iw-comp-send');
    const statusEl = composer.querySelector('.iw-comp-status');
    const text = (ta.value || '').trim();
    const toNumber = composer.dataset.toNumber;

    if (!text) {
      statusEl.textContent = 'Message vide';
      statusEl.className = 'iw-comp-status error';
      return;
    }
    if (!toNumber) {
      statusEl.textContent = 'Numéro destinataire manquant';
      statusEl.className = 'iw-comp-status error';
      return;
    }

    sendBtn.disabled = true;
    statusEl.textContent = 'Envoi…';
    statusEl.className = 'iw-comp-status';

    // Récup idToken
    firebaseAuth.currentUser.getIdToken().then(idToken => {
      return fetch(SMS_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + idToken,
        },
        body: JSON.stringify({
          leadId:  composerLeadId || null,
          message: text,
          to:      toNumber,
        }),
      });
    }).then(async resp => {
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('HTTP ' + resp.status + ' — ' + txt.slice(0, 200));
      }
      return resp.json();
    }).then(() => {
      statusEl.textContent = '✅ Envoyé';
      statusEl.className = 'iw-comp-status ok';
      ta.value = '';
      ta.style.height = 'auto';
      // Recharge thread
      if (composerLeadId) setTimeout(() => loadThreadForLead(composerLeadId), 600);
      // Auto-clear status
      setTimeout(() => {
        if (composer.classList.contains('open')) statusEl.textContent = '';
      }, 2500);
    }).catch(err => {
      console.error('[InboxWidget] SMS send failed:', err);
      statusEl.textContent = '❌ ' + (err.message || 'Erreur envoi');
      statusEl.className = 'iw-comp-status error';
    }).finally(() => {
      sendBtn.disabled = false;
    });
  }

  // ---------- LISTENER FIRESTORE ----------
  function startListening() {
    if (unsubscribeListener) { unsubscribeListener(); unsubscribeListener = null; }

    const isAdmin = (currentRole === 'admin');
    let q = firebaseDb.collection(COLLECTION).orderBy('createdAt', 'desc').limit(QUERY_LIMIT);
    if (!isAdmin) {
      // Sales : seulement ses propres notifs
      q = firebaseDb.collection(COLLECTION)
        .where('ownerUid', '==', currentUid)
        .orderBy('createdAt', 'desc')
        .limit(QUERY_LIMIT);
    }

    initialSnapshotDone = false;
    unsubscribeListener = q.onSnapshot(snap => {
      const newNotifs = [];
      snap.forEach(doc => {
        newNotifs.push(Object.assign({ id: doc.id }, doc.data()));
      });

      // Détecter les arrivées (pour son + toast + browser notif)
      if (initialSnapshotDone) {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') {
            const notif = Object.assign({ id: change.doc.id }, change.doc.data());
            if (isUnreadByMe(notif)) {
              playDing();
              showToast(notif);
              showBrowserNotification(notif);
            }
          }
        });
      }

      notifications = newNotifs;
      initialSnapshotDone = true;
      updateBadge();
      renderList();
    }, err => {
      console.warn('[InboxWidget] Listener error (onSnapshot):', err.code || err);
      // Fallback Safari : onSnapshot bloqué par ITP → polling toutes les 15s
      _startPolling(q);
    });
  }

  // ── Polling secours (Safari ITP bloque les WebChannel Firestore) ──────────
  let _pollTimerId = null;
  let _lastPollIds = new Set();

  function _startPolling(q) {
    if (_pollTimerId) return; // déjà en cours
    console.log('[InboxWidget] Fallback polling actif (15s)');
    const doPoll = () => {
      q.get().then(snap => {
        const newNotifs = [];
        snap.forEach(doc => newNotifs.push(Object.assign({ id: doc.id }, doc.data())));
        // Détecter les nouvelles notifs
        newNotifs.forEach(notif => {
          if (!_lastPollIds.has(notif.id) && isUnreadByMe(notif)) {
            playDing();
            showToast(notif);
          }
        });
        _lastPollIds = new Set(newNotifs.map(n => n.id));
        notifications = newNotifs;
        initialSnapshotDone = true;
        updateBadge();
        renderList();
      }).catch(e => console.warn('[InboxWidget] Poll error:', e));
    };
    doPoll(); // Immédiatement
    _pollTimerId = setInterval(doPoll, 15000);
  }

  function stopListening() {
    if (_pollTimerId) { clearInterval(_pollTimerId); _pollTimerId = null; }
    if (unsubscribeListener) { unsubscribeListener(); unsubscribeListener = null; }
    notifications = [];
    initialSnapshotDone = false;
    updateBadge();
    renderList();
  }

  // ---------- INIT ----------
  function tryInit() {
    if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length) {
      // Firebase pas encore prêt, retry
      setTimeout(tryInit, 200);
      return;
    }
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();

    // Monte le DOM tout de suite (caché)
    mountDom();
    const fab = document.getElementById('ambitio-inbox-fab');
    if (fab) fab.style.display = 'none'; // caché tant que role inconnu

    firebaseAuth.onAuthStateChanged(async user => {
      if (!user) {
        currentUid = null;
        currentRole = null;
        if (fab) fab.style.display = 'none';
        const panel = document.getElementById('ambitio-inbox-panel');
        if (panel) panel.classList.remove('open');
        closeComposer();
        stopListening();
        return;
      }

      currentUid = user.uid;

      // Détermine le rôle
      try {
        const userDoc = await firebaseDb.collection('users').doc(user.uid).get();
        currentRole = userDoc.exists ? (userDoc.data().role || null) : null;
      } catch (e) {
        currentRole = window._currentRole || localStorage.getItem('ambitio_role') || null;
      }

      // GATING : pas pour les coachs
      if (currentRole !== 'sales' && currentRole !== 'admin') {
        if (fab) fab.style.display = 'none';
        stopListening();
        return;
      }

      // OK, on affiche
      if (fab) fab.style.display = 'flex';
      ensureNotificationPermission();
      startListening();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }

  // Expose pour debug
  window.InboxWidget = {
    open: () => { const p = document.getElementById('ambitio-inbox-panel'); if (p) p.classList.add('open'); },
    close: () => { const p = document.getElementById('ambitio-inbox-panel'); if (p) p.classList.remove('open'); },
    refresh: () => { stopListening(); startListening(); },
    state: () => ({ uid: currentUid, role: currentRole, count: notifications.length, unread: notifications.filter(isUnreadByMe).length }),
    notifications: () => notifications.slice(),
  };
})();
