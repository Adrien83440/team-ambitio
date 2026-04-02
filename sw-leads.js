// sw-leads.js — Service Worker for Leads Live push notifications
// Handles background push events and notification clicks

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDo30FASeWnhvx4mYWYungKOu4AMhyJz6o",
  authDomain: "ambitio-team.firebaseapp.com",
  projectId: "ambitio-team",
  storageBucket: "ambitio-team.firebasestorage.app",
  messagingSenderId: "1079366902268",
  appId: "1:1079366902268:web:b4ec1691dba54230339279"
});

var messaging = firebase.messaging();

// Background message handler
messaging.onBackgroundMessage(function(payload) {
  var data = payload.data || {};
  var title = data.title || '🔔 Nouveau lead !';
  var body = data.body || 'Un nouveau prospect vient d\'arriver';
  var url = data.url || '/sales-leads.html?app=1';

  return self.registration.showNotification(title, {
    body: body,
    icon: '/icon-leads.png',
    badge: '/icon-leads.png',
    tag: 'new-lead-' + (data.leadId || Date.now()),
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: url },
    actions: [
      { action: 'open', title: 'Voir le lead' },
      { action: 'dismiss', title: 'OK' }
    ]
  });
});

// Notification click handler
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/sales-leads.html?app=1';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Focus existing window if open
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf('sales-leads') >= 0 && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      // Otherwise open new window
      return clients.openWindow(url);
    })
  );
});
