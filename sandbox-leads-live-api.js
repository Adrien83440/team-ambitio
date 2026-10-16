/* ═══════════════════════════════════════════════════════════════════════════
   sandbox-leads-live-api.js — LABO LEADS LIVE : faux serveur + pare-feu
   ─────────────────────────────────────────────────────────────────────────
   Chargé UNIQUEMENT par sandbox-leads-live.html, juste après le faux
   Firebase. Intercepte tous les appels /api/… (fetch, XHR, sendBeacon) :
   rien ne part chez Ringover, WhatsApp, Gmail ou l'IA, et aucune requête
   n'atteint un autre domaine. Les « envois » s'écrivent dans la base de test.
   Appel, agenda et modules Signatures / Paiements sont simulés.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var db = function () { return window.firebase.firestore(); };
  var ts = window.__SBX.ts;
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  var MOI = window.__SBX.moi;
  function rep(obj, status) { return Promise.resolve(new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } })); }
  function lead(id) { return (window.__SBX.db().leads || {})[id] || null; }
  function prenom(l) { return String((l && l.nom) || '').split(/\s+/)[0]; }
  function addComm(id, c) { return db().collection('leads').doc(id).update({ communications: window.firebase.firestore.FieldValue.arrayUnion(c), lastContactAt: new Date().toISOString(), updatedAt: window.firebase.firestore.FieldValue.serverTimestamp() }); }
  function attendre(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var MODELES = [
    { nom: 'ouverture_lead', langue: 'fr', categorie: 'MARKETING', corps: 'Bonjour {{1}}, c’est {{2}} d’Alteore. Je reviens vers vous suite à votre demande : quand puis-je vous appeler ?', variables: 2 },
    { nom: 'confirmation_rdv', langue: 'fr', categorie: 'UTILITY', corps: 'Bonjour {{1}}, votre rendez-vous est bien confirmé. À très vite !', variables: 1 },
    { nom: 'partage_temoignages', langue: 'fr', categorie: 'MARKETING', corps: 'Bonjour {{1}}, voici quelques retours de dirigeants que nous accompagnons.', variables: 1 }
  ];

  function route(path, body) {
    var b = body || {};
    if (/ringover-sms-send|twilio-sms-send/.test(path)) {
      var l = lead(b.leadId);
      return attendre(500).then(function () {
        return addComm(b.leadId, { type: 'sms', direction: 'outbound', content: b.message, source: 'ringover-sms', date: new Date().toISOString(), createdAt: new Date().toISOString(), ownerUid: MOI.uid, ownerName: MOI.nom, ownerSlug: MOI.slug });
      }).then(function () { return rep({ ok: true, messageId: 'sbx', to: l && l.telephone }); });
    }
    if (/whatsapp-templates/.test(path)) return rep({ ok: true, modeles: MODELES });
    if (/whatsapp-send/.test(path)) {
      var num = String(b.numero || ''), now = Date.now();
      var texte = b.texte || ('[' + (b.template || 'modèle') + ']');
      var conv = db().collection('whatsapp_conversations').doc(num);
      return attendre(400).then(function () {
        return conv.collection('messages').doc('o' + now).set({ wamid: 'o' + now, sens: 'out', texte: texte, statut: 'sent', at: now, date: new Date(now).toISOString(), modele: b.template || null, params: b.params || null, par: 'testeur@alteore.test' });
      }).then(function () {
        return conv.set({ numero: num, dernierMessage: { texte: texte, sens: 'out', at: now }, majA: now }, { merge: true });
      }).then(function () {
        var c = (window.__SBX.db().whatsapp_conversations || {})[num];
        if (c && c.leadId) return db().collection('leads').doc(c.leadId).update({ whatsappEnvoye: { at: now, premierAt: now, modele: b.template || null, par: 'testeur@alteore.test' } });
      }).then(function () { return rep({ ok: true, wamid: 'o' + now }); });
    }
    if (/ai-lead/.test(path)) {
      var la = lead(b.leadId) || {};
      var p = 35 + Math.round(Math.random() * 50);
      var ai = { proba: p, niveau: p > 70 ? 'chaud' : (p > 45 ? 'tiède' : 'froid'), raison: 'Calcul de démonstration (environnement de test).', angle: 'Parler de ' + (la.defi ? String(la.defi).toLowerCase() : 'son activité'), ouverture: 'Bonjour ' + prenom(la) + ', c’est ' + MOI.nom + ' d’Alteore, je vous appelle suite à votre demande.', brief: [la.secteur || 'Secteur non renseigné', la.ca || 'CA non renseigné', la.defi || 'Défi non renseigné'], creneau: 'Fin de matinée', key: 'sbx' };
      return attendre(700).then(function () { return db().collection('leads').doc(b.leadId).update({ aiLead: ai }); }).then(function () { return rep({ ok: true, aiLead: ai }); });
    }
    if (/ai-message/.test(path)) {
      var lm = lead(b.leadId) || {};
      if (b.action === 'sendEmail') {
        return attendre(600).then(function () {
          return addComm(b.leadId, { type: 'email', direction: 'outbound', subject: b.subject, content: (b.subject ? b.subject + '\n\n' : '') + b.body, source: 'gmail-strategie', date: new Date().toISOString(), createdAt: new Date().toISOString(), ownerUid: MOI.uid, ownerName: MOI.nom, ownerSlug: MOI.slug });
        }).then(function () { return rep({ ok: true }); });
      }
      var pr = prenom(lm);
      return attendre(900).then(function () {
        return rep({ ok: true, situation: pr + ' attend un retour de notre part (texte de démonstration).', suggestions: [
          { intention: 'Relance simple', texte: 'Bonjour ' + pr + ', c’est ' + MOI.nom + ' d’Alteore. Je vous rappelle comme convenu, êtes-vous disponible maintenant ?' },
          { intention: 'Proposer un créneau', texte: 'Bonjour ' + pr + ', je vous propose 15 min demain à 10h ou 14h pour parler de votre activité. Lequel vous arrange ? ' + MOI.nom },
          { intention: 'Envoyer le lien', texte: 'Bonjour ' + pr + ', voici le lien pour réserver directement votre appel avec moi : alteore.com/rdv. ' + MOI.nom }],
          email: { objet: 'Suite à votre demande, ' + pr, corps: 'Bonjour ' + pr + ',\n\nJ’ai essayé de vous joindre suite à votre demande. Avez-vous 15 minutes cette semaine pour en parler ?\n\nBelle journée,\n' + MOI.nom } });
      });
    }
    if (/ai-closing-prep/.test(path)) {
      return attendre(800).then(function () { return rep({ ok: true, prep: { resume: 'Dirigeant débordé qui veut structurer son équipe.', douleurs: ['Trop de charge opérationnelle', 'Peu de délégation'], motivations: ['Retrouver du temps', 'Faire grandir l’équipe'], questions: ['Combien d’heures par semaine sur l’opérationnel ?'], vigilance: ['Budget à valider avec l’associé'], offreConseillee: 'Élite Phénix en plusieurs fois', planAttaque: ['Faire chiffrer le temps perdu', 'Montrer un cas client du même secteur'], objectionsProbables: ['Le prix', 'Le timing'], generatedAt: new Date().toISOString() }, prospect: {} }); });
    }
    if (/rdv-presence/.test(path)) {
      var bk = (window.__SBX.db().bookings || {})[b.bookingId] || {};
      var lp = lead(bk.leadId) || {};
      var proofs = (lp.communications || []).filter(function (c) { return (c.type === 'call' && c.duration >= 15) || (c.type === 'sms' && /in/.test(c.direction)); }).map(function (c, i) {
        return { kind: c.type === 'call' ? 'call' : 'sms', id: 'p' + i, direction: c.type === 'call' ? 'out' : 'in', atMs: Date.parse(c.date), durationSec: c.duration || 0, text: c.content || '', userName: c.ownerName || '', hasRecording: c.type === 'call' };
      });
      var label = bk.date ? new Date(bk.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' à ' + (bk.time || '') : '';
      function confirmation(pc) {
        return { leadName: lp.nom, rdvLabel: label, confirmedAtMs: pc && pc.at && pc.at.toMillis ? pc.at.toMillis() : Date.now(), by: { name: (pc && pc.byName) || MOI.nom }, channel: (pc && pc.channel) || 'call', proof: proofs[0] || {}, summary: { verdict: 'confirme', resume: 'Le prospect confirme qu’il sera présent (résumé de démonstration).', citation: 'Oui, c’est noté, je serai là.' } };
      }
      if (b.action === 'confirm') {
        var pc = { channel: b.kind === 'call' ? 'call' : 'sms', byName: MOI.nom, bySlug: MOI.slug, at: ts(Date.now()) };
        return db().collection('bookings').doc(b.bookingId).update({ presenceConfirmed: pc })
          .then(function () { return rep({ ok: true, confirmation: confirmation(pc) }); });
      }
      if (b.action === 'get') return rep({ ok: true, confirmation: confirmation(bk.presenceConfirmed) });
      return rep({ ok: true, alreadyConfirmed: !!bk.presenceConfirmed, proofs: proofs, minCallSec: 15, booking: { date: bk.date, time: bk.time, personName: bk.personName, leadName: lp.nom } });
    }
    if (/calendar-followup-event/.test(path)) return rep({ ok: true, eventId: 'evt-test', eventLink: '#', memberName: MOI.nom, personId: MOI.slug });
    if (/call-detail/.test(path)) return rep({ ok: true, callLogId: b.callLogId, direction: 'outbound', status: 'completed', durationSec: 130, transcriptText: 'Bonjour, c’est ' + MOI.nom + ' d’Alteore… Oui c’est noté pour demain, je serai là.', aiSummary: 'Le prospect confirme sa présence.' });
    return rep({ ok: true });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/\/api\//.test(url)) {
      var body = null;
      try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
      var path = url.split('?')[0];
      return route(path, body);
    }
    if (/^https?:\/\//.test(url) && url.indexOf(location.origin) !== 0) return Promise.reject(new TypeError('Réseau coupé dans le labo'));
    return realFetch ? realFetch(input, init) : Promise.reject(new Error('fetch indisponible'));
  };

  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__sbxBloque = /\/api\//.test(String(u)) || (/^https?:\/\//.test(String(u)) && String(u).indexOf(location.origin) !== 0); return xo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () { if (this.__sbxBloque) { var x = this; setTimeout(function () { try { x.onerror && x.onerror(new Event('error')); } catch (e) {} }, 0); return; } return xs.apply(this, arguments); };
  }
  if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };

  /* Aucune vraie page du logiciel ne doit s'ouvrir en cadre ici : le vrai
     Dialer, l'agenda, les signatures ou les paiements chargeraient le VRAI
     Firebase avec la session du navigateur. Tout cadre de ce genre est retiré. */
  var CADRES_INTERDITS = /sales-dialer|booking\.html|payments\.html|sales-signatures|sign\.html/;
  function purgerCadres(racine) {
    var ifs = (racine && racine.querySelectorAll) ? racine.querySelectorAll('iframe') : [];
    for (var i = 0; i < ifs.length; i++) {
      if (CADRES_INTERDITS.test(ifs[i].getAttribute('src') || '')) {
        ifs[i].setAttribute('src', 'about:blank');
        if (ifs[i].parentNode) ifs[i].parentNode.removeChild(ifs[i]);
        if (typeof window.toast === 'function') window.toast('Le vrai Dialer et les modules externes sont coupés dans le labo');
      }
    }
  }
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'attributes' && m.target.tagName === 'IFRAME') purgerCadres(m.target.parentNode || document);
        (m.addedNodes || []).forEach && Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'IFRAME') purgerCadres(n.parentNode || document); else purgerCadres(n);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }
  /* Appel en série (barre DialerBridge) : simulé, jamais le vrai Dialer. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dbr-launch');
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var n = document.querySelectorAll('.dbr-checkbox:checked').length;
    if (typeof window.toast === 'function') window.toast('📞 Appel en série simulé sur ' + n + ' lead' + (n > 1 ? 's' : '') + ' (labo)');
  }, true);

  /* ── Remplacements après chargement de la page ── */
  function toastSbx(m) { if (typeof window.toast === 'function') window.toast(m); }
  /* Même habillage que la vraie page : le thème clair et la couche de marque
     sont rangés sous le nom « sales-leads ». */
  function habiller() {
    if (!document.body) return;
    document.body.setAttribute('data-al-page', 'sales-leads');
    document.body.classList.add('al-rebrand');
    if (!document.querySelector('link[href="brand.css"]')) {
      var lk = document.createElement('link'); lk.rel = 'stylesheet'; lk.href = 'brand.css';
      document.head.appendChild(lk);
    }
  }
  document.addEventListener('DOMContentLoaded', habiller);
  window.addEventListener('load', function () { setTimeout(habiller, 50); });

  function pret() {
    /* Appel simulé : un écran d'appel, puis la fin d'appel comme le vrai Dialer. */
    if (window.DialerBridge) {
      window.DialerBridge.callLead = function (leadId, phone, name) {
        /* Comme le vrai Dialer : une barre flottante, la page reste utilisable
           pendant l'appel (prendre un RDV, noter le résultat…). */
        var old = document.querySelector('.sbx-callbar'); if (old) old.parentNode.removeChild(old);
        var bar = document.createElement('div');
        bar.className = 'sbx-callbar';
        bar.innerHTML = '<span class="sbx-dot"></span><span class="sbx-cb-t"><b>Appel simulé · ' + (name || phone || '') + '</b><small id="sbxT">00:00</small></span><button type="button">Raccrocher</button>';
        document.body.appendChild(bar);
        var t0 = Date.now(), it = setInterval(function () { var s = Math.floor((Date.now() - t0) / 1000); var el = document.getElementById('sbxT'); if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 500);
        bar.querySelector('button').addEventListener('click', function () {
          clearInterval(it);
          var d = Math.floor((Date.now() - t0) / 1000);
          bar.parentNode.removeChild(bar);
          if (leadId) addComm(leadId, { type: 'call', direction: 'outbound', ownerName: MOI.nom, ownerUid: MOI.uid, date: new Date().toISOString(), duration: d >= 8 ? d : 0, source: 'ringover' });
          window.postMessage({ type: 'dialer:call-ended', leadId: leadId || null }, location.origin);
        });
      };
      window.DialerBridge.startCampaign = function (l) { toastSbx('📞 Appels en série simulés sur ' + (l || []).length + ' leads'); };
      window.DialerBridge.startAutoCampaign = function (l) { toastSbx('🚀 Power Dialer simulé sur ' + (l || []).length + ' leads'); };
    }
    /* Prise de RDV simulée (le vrai agenda booking n'est pas chargé ici). */
    window.openBookingModal = function (l) {
      var ov = document.createElement('div');
      ov.className = 'sbx-call';
      var jours = [1, 2, 3].map(function (n) { var d = new Date(Date.now() + n * 86400000); return d; });
      ov.innerHTML = '<div class="sbx-call-box sbx-book"><div class="sbx-call-k">Agenda simulé · labo</div><div class="sbx-call-n">RDV avec ' + (l.nom || '') + '</div>' +
        '<div class="sbx-slots">' + jours.map(function (d) { return ['10:00', '14:30'].map(function (h) { return '<button type="button" data-d="' + d.toISOString().slice(0, 10) + '" data-h="' + h + '">' + d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) + ' · ' + h + '</button>'; }).join(''); }).join('') + '</div>' +
        '<button type="button" class="sbx-call-b sbx-x">Annuler</button></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) {
        var bt = e.target.closest('button'); if (!bt) return;
        if (bt.classList.contains('sbx-x')) { ov.parentNode.removeChild(ov); return; }
        var id = 'bk' + Date.now();
        db().collection('bookings').doc(id).set({ leadId: l.id, date: bt.getAttribute('data-d'), time: bt.getAttribute('data-h'), duration: 60, status: 'confirmed', source: 'setter', bookedBySlug: MOI.slug, personName: MOI.nom, personId: MOI.slug, typeName: 'Appel stratégique Élite', prospect: { email: l.email || '', telephone: l.telephone || '' }, meetLink: 'https://meet.google.com/test-test-test', createdAt: ts(Date.now()) })
          .then(function () { return db().collection('leads').doc(l.id).update({ status: 'rdv_pose', stage: 'set', notesHistory: window.firebase.firestore.FieldValue.arrayUnion({ text: '📅 RDV posé — ' + bt.textContent + ' avec ' + MOI.nom, date: new Date().toLocaleString('fr-FR'), authorName: MOI.nom }) }); })
          .then(function () { toastSbx('✅ RDV confirmé — ' + bt.textContent); });
        ov.parentNode.removeChild(ov);
      });
    };
    window.ldOpenModule = function () { toastSbx('Signatures et paiements ne sont pas branchés dans le labo'); };
    if (window.RdvOutcome) window.RdvOutcome.openReschedule = function () { toastSbx('Déplacer un RDV ouvre le vrai agenda : non branché dans le labo'); };
    var wo = window.open;
    window.open = function (u) { if (/sales-contact|payments|sales-signatures|booking/.test(String(u))) { toastSbx('Cette page ouvrirait le vrai logiciel : désactivée dans le labo'); return null; } return wo.apply(window, arguments); };
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var h = a.getAttribute('href') || '';
      if (/^(sales-|booking|payments|login|index|admin-)/.test(h) || /meet\.google\.com/.test(h)) { e.preventDefault(); toastSbx('Ce lien ouvrirait le vrai logiciel : désactivé dans le labo'); }
    }, true);

    /* Bandeau « test » + remise à zéro */
    var bd = document.createElement('div');
    bd.className = 'sbx-band';
    bd.innerHTML = '<span>🧪 Labo · faux leads · rien n’est envoyé</span><button type="button" data-sbx="reset">Réinitialiser</button><button type="button" data-sbx="close">Fermer</button>';
    bd.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sbx]'); if (!b) return;
      if (b.getAttribute('data-sbx') === 'reset') window.__SBX.reset();
      else { window.close(); setTimeout(function () { location.href = 'sales-leads.html'; }, 150); }
    });
    document.body.appendChild(bd);
  }
  if (document.readyState === 'complete') setTimeout(pret, 0);
  else window.addEventListener('load', function () { setTimeout(pret, 0); });

  var st = document.createElement('style');
  st.textContent =
    '.sbx-band{position:fixed;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:100001;display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);padding:7px 8px 7px 14px;border-radius:999px;background:#111216;color:#fff;font:600 12.5px/1.3 "Plus Jakarta Sans",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)}' +
    '.sbx-band span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sbx-band button{flex:none;border:0;border-radius:999px;padding:6px 12px;background:#fff;color:#111216;font:700 12px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}' +
    '.sbx-call{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(5,6,10,.6)}' +
    '.sbx-call-box{width:min(360px,100%);display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 22px;border-radius:26px;background:#fff;color:#111216;font-family:"Plus Jakarta Sans",system-ui,sans-serif;text-align:center}' +
    '.sbx-call-k{font-size:12.5px;font-weight:700;color:#6c7080}.sbx-call-n{font-size:22px;font-weight:800}.sbx-call-t{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums}' +
    '.sbx-call-b{width:100%;min-height:54px;border:0;border-radius:18px;background:#dc2626;color:#fff;font:800 16px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}' +
    '.sbx-callbar{position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:100002;display:flex;align-items:center;gap:12px;width:min(420px,calc(100% - 20px));padding:10px 10px 10px 16px;border-radius:999px;background:#0f8a46;color:#fff;font-family:"Plus Jakarta Sans",system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)}' +
    '.sbx-dot{width:10px;height:10px;border-radius:50%;background:#fff;animation:sbxp 1.2s infinite}@keyframes sbxp{50%{opacity:.3}}' +
    '.sbx-cb-t{flex:1;min-width:0}.sbx-cb-t b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sbx-cb-t small{font-size:12.5px;opacity:.85;font-variant-numeric:tabular-nums}' +
    '.sbx-callbar button{flex:none;min-height:40px;padding:0 16px;border:0;border-radius:999px;background:#c4161c;color:#fff;font:800 14px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}' +
    '.sbx-book .sbx-call-b{background:#f0f1f4;color:#111216}.sbx-slots{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%}' +
    '.sbx-slots button{min-height:48px;border:0;border-radius:14px;background:#3d5af1;color:#fff;font:700 14px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}';
  (document.head || document.documentElement).appendChild(st);
})();
