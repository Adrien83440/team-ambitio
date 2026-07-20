// ============================================================================
// client-deactivate-ui.js — MODALE « FIN D'ACCOMPAGNEMENT » (07/2026)
// ----------------------------------------------------------------------------
// Module frontend partagé (csm-clients.html + admin-persons.html) qui pilote
// l'endpoint /api/client-deactivate : UN bouton, UNE confirmation, et le
// client passe en « ancien client » partout (coaching, Academy, RDV à venir,
// fiche CRM, persons).
//
// UTILISATION (pages Firebase COMPAT uniquement) :
//   <script src="client-deactivate-ui.js"></script>
//   ClientDeactivate.open({ clientId, clientName, onDone: function(report){} });
//   ClientDeactivate.reactivate({ clientId, clientName, onDone: ... });
//
// La modale est appendue à document.body (jamais dans un conteneur avec
// backdrop-filter — piège WebKit position:fixed connu du repo).
// Fail-soft : chaque étape serveur remonte ses warnings, affichés dans le
// rapport final — rien n'est silencieux.
// ============================================================================

(function () {
  'use strict';

  var API = '/api/client-deactivate';

  var CSS = ''
    + '.cdx-overlay{position:fixed;inset:0;background:rgba(10,8,24,0.62);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}'
    + '.cdx-modal{background:#14162a;border:1px solid rgba(255,255,255,0.10);border-radius:16px;max-width:520px;width:100%;padding:22px 22px 18px;color:rgba(255,255,255,0.92);font-family:inherit;font-size:13px;line-height:1.55;box-shadow:0 18px 60px rgba(0,0,0,0.5);max-height:calc(100vh - 40px);overflow:auto}'
    + '.cdx-title{font-size:17px;font-weight:800;display:flex;align-items:center;gap:8px;margin-bottom:2px}'
    + '.cdx-sub{font-size:12px;color:rgba(255,255,255,0.55);margin-bottom:14px}'
    + '.cdx-sec{margin-top:12px;padding:11px 13px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:11px}'
    + '.cdx-sec-t{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:rgba(255,255,255,0.5);margin-bottom:7px}'
    + '.cdx-line{display:flex;gap:8px;align-items:flex-start;margin:5px 0;font-size:12.5px}'
    + '.cdx-line .ic{flex-shrink:0;width:18px;text-align:center}'
    + '.cdx-muted{color:rgba(255,255,255,0.5)}'
    + '.cdx-warn{background:rgba(251,146,60,0.10);border:1px solid rgba(251,146,60,0.35);border-radius:10px;padding:9px 12px;margin-top:12px;font-size:12px;color:#fdba74}'
    + '.cdx-modes{display:flex;gap:8px;margin-top:4px}'
    + '.cdx-mode{flex:1;padding:10px 8px;border-radius:10px;border:1.5px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.03);cursor:pointer;text-align:center;font-weight:700;font-size:12.5px;color:rgba(255,255,255,0.75);transition:all .15s}'
    + '.cdx-mode.on{border-color:#a78bfa;color:#c4b5fd;background:rgba(167,139,250,0.12)}'
    + '.cdx-mode.on.stop{border-color:#ef4444;color:#fca5a5;background:rgba(239,68,68,0.10)}'
    + '.cdx-mode .sm{display:block;font-weight:500;font-size:10.5px;color:rgba(255,255,255,0.45);margin-top:2px}'
    + '.cdx-note{width:100%;margin-top:6px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:9px;color:inherit;font-family:inherit;font-size:12.5px;padding:8px 10px;resize:vertical;min-height:52px;box-sizing:border-box}'
    + '.cdx-actions{display:flex;gap:10px;margin-top:16px}'
    + '.cdx-btn{flex:1;padding:11px 14px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.8);font-family:inherit}'
    + '.cdx-btn:hover{background:rgba(255,255,255,0.09)}'
    + '.cdx-btn.danger{background:#b91c1c;border-color:#ef4444;color:#fff}'
    + '.cdx-btn.danger:hover{background:#dc2626}'
    + '.cdx-btn.ok{background:#166534;border-color:#22c55e;color:#fff}'
    + '.cdx-btn:disabled{opacity:0.5;cursor:not-allowed}'
    + '.cdx-loading{text-align:center;padding:26px 10px;color:rgba(255,255,255,0.55)}'
    + '.cdx-spin{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(255,255,255,0.18);border-top-color:#a78bfa;border-radius:50%;animation:cdxspin .8s linear infinite;vertical-align:-4px;margin-right:8px}'
    + '@keyframes cdxspin{to{transform:rotate(360deg)}}'
    + '.cdx-report .cdx-line{font-size:12.5px}'
    + '.cdx-rdv{margin:3px 0 3px 26px;font-size:11.5px;color:rgba(255,255,255,0.6)}';

  var cssDone = false;
  function injectCss() {
    if (cssDone) return;
    cssDone = true;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDateFr(iso) {
    try {
      var d = new Date(iso + 'T12:00:00');
      return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
    } catch (e) { return iso || ''; }
  }

  function getToken() {
    try {
      var u = window.firebase && firebase.auth && firebase.auth().currentUser;
      if (!u) return Promise.reject(new Error('non connecté'));
      return u.getIdToken();
    } catch (e) { return Promise.reject(e); }
  }

  function api(payload) {
    return getToken().then(function (token) {
      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload),
      });
    }).then(function (r) { return r.json(); });
  }

  // ─── Modale ───────────────────────────────────────────────────────────

  var overlay = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function openShell() {
    injectCss();
    close();
    overlay = document.createElement('div');
    overlay.className = 'cdx-overlay';
    overlay.innerHTML = '<div class="cdx-modal"><div class="cdx-loading"><span class="cdx-spin"></span>Chargement de l\'état du client…</div></div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return overlay.querySelector('.cdx-modal');
  }

  function academyLine(a) {
    if (!a || !a.configured) return '<span class="cdx-muted">pont non configuré — à gérer depuis l\'onglet Academy</span>';
    if (!a.ok) return '<span class="cdx-muted">Academy injoignable — sera retenté à la confirmation</span>';
    if (!a.found) return '<span class="cdx-muted">aucun compte élève trouvé pour cet email</span>';
    if (!a.exists) return 'profil élève trouvé (jamais connecté) — sera marqué désactivé';
    if (a.disabled) return 'connexion déjà désactivée ✓';
    return 'connexion active → sera <strong>désactivée</strong> (progression conservée, réversible)';
  }

  function renderConfirm(box, pv, opts) {
    var c = pv.client || {};
    var name = opts.clientName || c.nom || c.email || 'ce client';
    var state = { mode: 'completed' };

    var h = '';
    h += '<div class="cdx-title">🚪 Fin d\'accompagnement</div>';
    h += '<div class="cdx-sub">' + esc(name) + (c.email ? ' · ' + esc(c.email) : '') + '</div>';

    if (c.ancienClient) {
      h += '<div class="cdx-warn">Cette fiche est déjà en « ancien client ». Confirmer ré-appliquera toutes les étapes (utile si une étape avait échoué).</div>';
    }

    // Motif
    h += '<div class="cdx-sec"><div class="cdx-sec-t">Motif</div><div class="cdx-modes">';
    h += '<div class="cdx-mode on" data-mode="completed">🎉 Terminé<span class="sm">Fin de programme</span></div>';
    h += '<div class="cdx-mode" data-mode="stopped">🛑 Stoppé<span class="sm">Arrêt anticipé</span></div>';
    h += '</div></div>';

    // Ce qui va se passer
    h += '<div class="cdx-sec"><div class="cdx-sec-t">Ce qui va se passer</div>';
    h += '<div class="cdx-line"><span class="ic">⚫</span><div>Fiche coaching → <strong>inactif</strong> (disparaît des listes actives des coachs)</div></div>';
    h += '<div class="cdx-line"><span class="ic">🎓</span><div>AE Academy : ' + academyLine(pv.academy) + '</div></div>';

    var bks = pv.bookings || [];
    if (bks.length) {
      h += '<div class="cdx-line"><span class="ic">📅</span><div><strong>' + bks.length + ' RDV coaching à venir</strong> ser' + (bks.length > 1 ? 'ont annulés' : 'a annulé') + ' (le client reçoit l\'annulation Google) :</div></div>';
      for (var i = 0; i < bks.length; i++) {
        var b = bks[i];
        h += '<div class="cdx-rdv">• ' + esc(fmtDateFr(b.date)) + ' ' + esc(b.time || '') + ' — ' + esc(b.typeLabel || 'Coaching') + (b.personName ? ' (' + esc(b.personName) + ')' : '') + '</div>';
      }
    } else {
      h += '<div class="cdx-line"><span class="ic">📅</span><div class="cdx-muted">Aucun RDV coaching à venir</div></div>';
    }

    if (pv.lead && pv.lead.found) {
      h += '<div class="cdx-line"><span class="ic">👤</span><div>Fiche CRM → badge <strong>🎓 Ancien client</strong></div></div>';
    } else {
      h += '<div class="cdx-line"><span class="ic">👤</span><div class="cdx-muted">Pas de lead CRM lié (rien à faire côté CRM)</div></div>';
    }
    h += '<div class="cdx-line"><span class="ic">🔒</span><div class="cdx-muted">Il ne pourra plus réserver de coaching ni recevoir de replays. Réversible via « Réactiver ».</div></div>';
    h += '</div>';

    // Avertissement paiements
    var pay = pv.payments || {};
    var nbPay = (pay.payments || 0) + (pay.subscriptions || 0);
    if (nbPay > 0) {
      h += '<div class="cdx-warn">⚠️ <strong>' + nbPay + ' prélèvement(s) GoCardless encore actif(s)</strong> — la fin d\'accompagnement ne les annule pas. À gérer dans le module Paiements si besoin.</div>';
    }

    // Note
    h += '<div class="cdx-sec"><div class="cdx-sec-t">Note (facultatif)</div>'
      + '<textarea class="cdx-note" placeholder="Ex : programme terminé le 18/07, très satisfait…"></textarea></div>';

    h += '<div class="cdx-actions">'
      + '<button type="button" class="cdx-btn" data-act="cancel">Annuler</button>'
      + '<button type="button" class="cdx-btn danger" data-act="go">🚪 Confirmer la fin d\'accompagnement</button>'
      + '</div>';

    box.innerHTML = h;

    // Interactions
    var modes = box.querySelectorAll('.cdx-mode');
    for (var m = 0; m < modes.length; m++) {
      modes[m].addEventListener('click', function () {
        state.mode = this.getAttribute('data-mode');
        for (var k = 0; k < modes.length; k++) {
          modes[k].className = 'cdx-mode' + (modes[k] === this ? ' on' + (state.mode === 'stopped' ? ' stop' : '') : '');
        }
      });
    }
    box.querySelector('[data-act="cancel"]').addEventListener('click', close);
    var goBtn = box.querySelector('[data-act="go"]');
    goBtn.addEventListener('click', function () {
      goBtn.disabled = true;
      goBtn.textContent = 'Désactivation en cours…';
      var note = (box.querySelector('.cdx-note').value || '').trim();
      api({ action: 'deactivate', clientId: opts.clientId, mode: state.mode, note: note })
        .then(function (j) {
          if (!j || j.ok !== true) throw new Error((j && j.error) || 'Erreur serveur');
          renderReport(box, j, opts, 'deactivate');
        })
        .catch(function (e) {
          goBtn.disabled = false;
          goBtn.textContent = '🚪 Confirmer la fin d\'accompagnement';
          alert('❌ Désactivation impossible : ' + e.message);
        });
    });
  }

  function renderReport(box, j, opts, kind) {
    var r = j.report || {};
    var h = '<div class="cdx-report">';
    h += '<div class="cdx-title">' + (kind === 'deactivate' ? '🎓 Ancien client' : '↩️ Client réactivé') + '</div>';
    h += '<div class="cdx-sub">' + (kind === 'deactivate' ? 'Le client a été désactivé partout.' : 'Le client est de nouveau actif.') + '</div>';
    h += '<div class="cdx-sec">';
    h += '<div class="cdx-line"><span class="ic">✅</span><div>Fiche coaching : ' + (kind === 'deactivate' ? 'inactif — ' + (j.mode === 'stopped' ? '🛑 Stoppé' : '🎉 Terminé') : 'actif') + '</div></div>';

    var lead = r.lead || {};
    h += '<div class="cdx-line"><span class="ic">' + (lead.found ? (lead.error ? '⚠️' : '✅') : '➖') + '</span><div>Fiche CRM : '
      + (lead.found ? (lead.error ? 'erreur — ' + esc(lead.error) : (kind === 'deactivate' ? 'badge Ancien client posé' : 'réactivée')) : 'pas de lead lié') + '</div></div>';

    var person = r.person || {};
    h += '<div class="cdx-line"><span class="ic">' + (person.found ? (person.error ? '⚠️' : '✅') : '➖') + '</span><div>Persons : '
      + (person.found ? (person.error ? 'erreur — ' + esc(person.error) : 'synchronisée') : 'pas de fiche liée') + '</div></div>';

    if (kind === 'deactivate') {
      var bc = r.bookingsCancelled || [];
      if (bc.length) {
        var okN = 0;
        for (var i = 0; i < bc.length; i++) { if (bc[i].ok) okN++; }
        h += '<div class="cdx-line"><span class="ic">' + (okN === bc.length ? '✅' : '⚠️') + '</span><div>' + okN + '/' + bc.length + ' RDV coaching annulé(s)</div></div>';
      } else {
        h += '<div class="cdx-line"><span class="ic">➖</span><div>Aucun RDV à annuler</div></div>';
      }
    }

    var a = r.academy || {};
    var aTxt;
    if (a.ok && a.exists) aTxt = kind === 'deactivate' ? 'connexion désactivée' : 'connexion réactivée';
    else if (a.ok && a.found) aTxt = 'profil marqué ' + (kind === 'deactivate' ? 'désactivé' : 'actif') + ' (pas de compte de connexion)';
    else if (a.ok) aTxt = 'aucun compte élève pour cet email';
    else aTxt = 'échec — ' + esc(a.error || 'injoignable');
    h += '<div class="cdx-line"><span class="ic">' + (a.ok ? '✅' : '⚠️') + '</span><div>Academy : ' + aTxt + '</div></div>';
    h += '</div>';

    var warns = j.warnings || [];
    if (warns.length) {
      h += '<div class="cdx-warn"><strong>À vérifier :</strong>';
      for (var w = 0; w < warns.length; w++) h += '<div style="margin-top:4px">• ' + esc(warns[w]) + '</div>';
      h += '</div>';
    }

    h += '<div class="cdx-actions"><button type="button" class="cdx-btn ok" data-act="close">Fermer</button></div>';
    h += '</div>';
    box.innerHTML = h;
    box.querySelector('[data-act="close"]').addEventListener('click', function () {
      close();
      if (typeof opts.onDone === 'function') opts.onDone(j);
    });
  }

  // ─── API publique ─────────────────────────────────────────────────────

  function open(opts) {
    opts = opts || {};
    if (!opts.clientId) { alert('clientId manquant'); return; }
    var box = openShell();
    api({ action: 'preview', clientId: opts.clientId })
      .then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.error) || 'Erreur serveur');
        renderConfirm(box, j, opts);
      })
      .catch(function (e) {
        box.innerHTML = '<div class="cdx-title">🚪 Fin d\'accompagnement</div>'
          + '<div class="cdx-warn">Impossible de charger l\'état du client : ' + esc(e.message) + '</div>'
          + '<div class="cdx-actions"><button type="button" class="cdx-btn" data-act="cancel">Fermer</button></div>';
        box.querySelector('[data-act="cancel"]').addEventListener('click', close);
      });
  }

  function reactivate(opts) {
    opts = opts || {};
    if (!opts.clientId) { alert('clientId manquant'); return; }
    var name = opts.clientName || 'ce client';
    if (!confirm('Réactiver ' + name + ' ?\n\n• Fiche coaching → actif\n• Academy → connexion rouverte\n• Fiche CRM → badge Ancien client retiré\n\n(Les RDV annulés ne sont pas restaurés.)')) return;
    var box = openShell();
    box.innerHTML = '<div class="cdx-loading"><span class="cdx-spin"></span>Réactivation en cours…</div>';
    api({ action: 'reactivate', clientId: opts.clientId })
      .then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.error) || 'Erreur serveur');
        renderReport(box, j, opts, 'reactivate');
      })
      .catch(function (e) {
        box.innerHTML = '<div class="cdx-warn">❌ Réactivation impossible : ' + esc(e.message) + '</div>'
          + '<div class="cdx-actions"><button type="button" class="cdx-btn" data-act="cancel">Fermer</button></div>';
        box.querySelector('[data-act="cancel"]').addEventListener('click', close);
      });
  }

  window.ClientDeactivate = { open: open, reactivate: reactivate, close: close };
})();
