/* ═══════════════════════════════════════════════════════════════════════════
   demarrage-widget.js — PANNEAU « DÉMARRAGE DIFFÉRÉ » (30/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Un seul panneau pour Persons, Coaching, CSM et Leads Live : la page pose
   simplement un conteneur, le panneau le remplit tout seul.

     <div data-demarrage data-client-id="…"></div>
     (ou data-lead-id="…" / data-person-id="…")

   Tout passe par /api/client-demarrage ; les droits viennent du serveur (le
   panneau n'affiche que les boutons autorisés). Un coach n'a que la lecture,
   et rien ne s'affiche pour un client sans démarrage différé ni verrou.

   Porte aussi le verrou « accès fermé jusqu'au paiement » (api/_accesPaiement.js).

   Aucune dépendance à un SDK Firebase : compat, modulaire et v8 coexistent
   selon les pages. Nécessite demarrage-core.js. ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.DemarrageWidget) return;

  var CACHE_MS = 30000;
  var cache = {};
  var ERREURS = {
    date_invalide: 'Choisis une date à venir (moins d\'un an).',
    deja_demarre: 'Ce client a déjà démarré.',
    contrat_signe: 'Le contrat est signé : utilise « Démarrer maintenant ».',
    rien_a_retirer: 'Aucune date à retirer.',
    pas_en_attente: 'Ce client n\'attend plus de démarrage.',
    academy_unreachable: 'Academy injoignable : rien n\'a été enregistré, réessaie.',
    bridge_not_configured: 'Pont Academy non configuré : rien n\'a été enregistré.',
    forbidden: 'Après le closing, seuls les admins et la CSM peuvent modifier la date.',
    conditions: 'Contrat ou paiement manquant.'
  };

  function Core() { return window.DemarrageCore; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function user() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function jeton() {
    return new Promise(function (ok, ko) {
      var t0 = Date.now();
      (function essai() {
        var u = user();
        if (u) { u.getIdToken().then(ok, ko); return; }
        if (Date.now() - t0 > 15000) { ko(new Error('non connecté')); return; }
        setTimeout(essai, 400);
      })();
    });
  }
  function appel(url, corps) {
    return jeton().then(function (t) {
      var o = { headers: { 'Authorization': 'Bearer ' + t } };
      if (corps) { o.method = 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(corps); }
      return fetch(url, o);
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'server_error' }; }); });
  }
  function messageErreur(j) { return ERREURS[j && j.error] || 'Enregistrement impossible, réessaie.'; }

  function cleDe(el) {
    if (el.getAttribute('data-lead-id')) return 'leadId=' + encodeURIComponent(el.getAttribute('data-lead-id'));
    if (el.getAttribute('data-client-id')) return 'clientId=' + encodeURIComponent(el.getAttribute('data-client-id'));
    if (el.getAttribute('data-person-id')) return 'personId=' + encodeURIComponent(el.getAttribute('data-person-id'));
    return '';
  }

  function ligneCondition(ok, txt) { return '<div>' + (ok ? '✅ ' : '⛔ ') + esc(txt) + '</div>'; }
  function champDate(st, valeur) {
    var demain = new Date(); demain.setDate(demain.getDate() + 1);
    var min = Core().aujourdhui(demain);
    return '<input type="date" data-dm-date min="' + esc(min) + '" value="' + esc(valeur || '') + '" style="padding:5px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;font-size:12px">';
  }
  function bouton(act, txt, fort) {
    return '<button type="button" data-dm-act="' + act + '" style="padding:5px 10px;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;font-weight:700;border:1px solid rgba(217,119,6,.55);background:' + (fort ? '#d97706' : 'transparent') + ';color:' + (fort ? '#fff' : 'inherit') + '">' + txt + '</button>';
  }

  function dessiner(el, st) {
    var C = Core(), dd = st.demarrage || null, dr = st.droits || {}, c = st.conditions || {};
    var attente = C.enAttente(dd), demarre = !!(dd && dd.statut === 'demarre');
    var ap = st.accesPaiement || null, ferme = !!(ap && ap.statut === 'verrouille');
    if (!st.leadId || (!attente && !demarre && !dr.poser && !ferme && !dr.verrouiller)) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    var cadre = 'margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid rgba(217,119,6,.4);background:rgba(217,119,6,.08);font-size:12.5px;line-height:1.5;color:inherit;text-align:left';
    var h = '';
    if (ferme) {
      h += '<div style="font-weight:800">🔒 Accès Academy fermé : paiement attendu</div>'
        + '<div style="opacity:.8;margin-top:2px">Il s\'ouvre tout seul dès que le prélèvement est déclenché.</div>';
      if (dr.forcer) h += '<div style="margin-top:6px">' + bouton('ouvrir', 'Ouvrir sans paiement') + '</div>';
      h += '<div style="border-top:1px solid rgba(217,119,6,.3);margin:8px 0"></div>';
    }
    if (attente) {
      var j = C.joursEntre(st.today, dd.date);
      h += '<div style="font-weight:800">⏳ Démarre le ' + esc(C.fr(dd.date)) + (j > 0 ? ' <span style="font-weight:500;opacity:.75">· dans ' + j + ' j</span>' : '') + '</div>';
      h += '<div style="margin-top:4px">' + ligneCondition(c.signe, c.signe ? 'Contrat signé' : 'Contrat non signé') + ligneCondition(c.paye, c.paye ? 'Paiement déclenché' : 'Paiement non déclenché') + '</div>';
      if (j <= 0 && !c.ok) h += '<div style="margin-top:4px;font-weight:700">Démarrage bloqué : son espace reste fermé.</div>';
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">';
      if (dr.poser) h += champDate(st, dd.date) + bouton('poser', 'Changer la date');
      if (dr.demarrer) h += bouton('demarrer', '🚀 Démarrer maintenant', true);
      if (dr.poser && !c.signe) h += bouton('retirer', 'Retirer');
      h += '</div>';
    } else if (demarre) {
      h += '<div style="font-weight:800">✅ Démarrage différé : a démarré le ' + esc(C.fr(dd.demarreLe || dd.date)) + '</div>';
    } else if (dr.poser) {
      h += '<details><summary style="cursor:pointer;font-weight:700">⏳ Le client démarre plus tard</summary>'
        + '<div style="margin-top:6px;opacity:.8">Accès, RDV et séances restent fermés jusqu\'à cette date. Le paiement ne se décale jamais : contrat signé et premier prélèvement déclenché.</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">' + champDate(st, '') + bouton('poser', 'Enregistrer la date', true) + '</div></details>';
    }
    if (!ferme && dr.verrouiller && !c.paye && !demarre) h += '<div style="margin-top:8px">' + bouton('verrouiller', '🔒 Fermer l\'accès jusqu\'au paiement') + '</div>';
    if (!h) { el.innerHTML = ''; el.style.display = 'none'; return; }
    var hist = ((dd && dd.historique) || []).concat((ap && ap.historique) || []);
    if (hist.length) {
      h += '<details style="margin-top:6px;opacity:.75"><summary style="cursor:pointer;font-size:11.5px">Historique</summary>';
      hist.slice().reverse().forEach(function (x) {
        h += '<div style="font-size:11.5px">' + esc(new Date(x.at).toLocaleDateString('fr-FR')) + ' · ' + esc(x.action) + (x.date ? ' · ' + esc(C.fr(x.date)) : '') + ' · ' + esc(x.par) + '</div>';
      });
      h += '</details>';
    }
    el.innerHTML = '<div style="' + cadre + '">' + h + '<div data-dm-msg style="margin-top:6px;font-weight:700;display:none"></div></div>';
  }

  function charger(el, frais) {
    var cle = cleDe(el);
    if (!cle) return;
    var c = cache[cle];
    if (c && !frais && Date.now() - c.at < CACHE_MS) { dessiner(el, c.st); return; }
    appel('/api/client-demarrage?' + cle).then(function (st) {
      if (!st || st.ok !== true) { el.innerHTML = ''; el.style.display = 'none'; return; }
      cache[cle] = { at: Date.now(), st: st };
      dessiner(el, st);
    }).catch(function (e) { console.warn('[demarrage]', e && e.message); });
  }

  function agir(el, act, btn) {
    var cle = cleDe(el), c = cache[cle], st = c && c.st;
    if (!st) return;
    var corps = { action: act, leadId: st.leadId };
    var msg = el.querySelector('[data-dm-msg]');
    function dire(t) { if (msg) { msg.textContent = t; msg.style.display = ''; } }

    if (act === 'poser') {
      var champ = el.querySelector('[data-dm-date]');
      corps.date = champ ? champ.value : '';
      if (!corps.date) { dire('Choisis une date.'); return; }
      if (!window.confirm('Fermer l\'accès de ce client jusqu\'au ' + Core().fr(corps.date) + ' ?\n\nLe paiement, lui, ne se décale pas.')) return;
    } else if (act === 'retirer') {
      if (!window.confirm('Retirer le démarrage différé ?')) return;
    } else if (act === 'verrouiller') {
      if (!window.confirm('Fermer l\'accès Academy de ce client ?\n\nIl se rouvrira tout seul dès que le prélèvement sera déclenché.')) return;
    } else if (act === 'ouvrir') {
      if (!window.confirm('Ouvrir l\'accès Academy sans paiement GoCardless ?\n\nCe sera tracé dans l\'historique.')) return;
    } else if (act === 'demarrer') {
      var cond = st.conditions || {};
      if (!cond.ok) {
        if (!(st.droits || {}).forcer) { dire('Impossible : ' + (cond.manque || []).join(', ') + '.'); return; }
        if (!window.confirm('Il manque : ' + (cond.manque || []).join(', ') + '.\n\nDémarrer quand même ? Ce sera tracé dans l\'historique.')) return;
        corps.force = true;
      } else if (!window.confirm('Démarrer ce client aujourd\'hui ?\n\nSon accès Academy s\'ouvre et son programme part de ce jour.')) return;
    }
    btn.disabled = true;
    appel('/api/client-demarrage', corps).then(function (j) {
      btn.disabled = false;
      if (!j || j.ok !== true) { dire('❌ ' + messageErreur(j)); return; }
      delete cache[cle];
      charger(el, true);
    }).catch(function () { btn.disabled = false; dire('❌ Enregistrement impossible, réessaie.'); });
  }

  function brancher(el) {
    if (el.getAttribute('data-dm-pret') === cleDe(el)) return;
    el.setAttribute('data-dm-pret', cleDe(el));
    if (!el.getAttribute('data-dm-ecoute')) {
      el.setAttribute('data-dm-ecoute', '1');
      el.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-dm-act]') : null;
        if (t) { e.stopPropagation(); agir(el, t.getAttribute('data-dm-act'), t); }
      });
    }
    charger(el);
  }

  function balayer() {
    if (!Core()) return;
    var els = document.querySelectorAll('[data-demarrage]');
    for (var i = 0; i < els.length; i++) brancher(els[i]);
  }

  /* Les pages réécrivent leur fiche en innerHTML : on suit le DOM. */
  var attente = null;
  function planifier() { if (attente) return; attente = setTimeout(function () { attente = null; balayer(); }, 120); }
  function boot() {
    balayer();
    new MutationObserver(planifier).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.DemarrageWidget = { rafraichir: function () { cache = {}; var els = document.querySelectorAll('[data-demarrage]'); for (var i = 0; i < els.length; i++) { els[i].removeAttribute('data-dm-pret'); } balayer(); } };
})();
