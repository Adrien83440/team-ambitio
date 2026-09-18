// ============================================================================
// academy-parcours.js — « GÉRER LE PARCOURS » DEPUIS LA FICHE COACHING
// ----------------------------------------------------------------------------
// Le coach tient sa séance dans la fiche coaching de Team Alteor. Le parcours
// de son client — jalons datés, étapes et leur validation, six outils, séances
// et devoirs — vit dans l'Academy. Cette pop-up ramène TOUT l'écran coach de
// l'Academy dans la fiche : mêmes onglets, même vocabulaire, mêmes règles.
//
//   · Jalons          constater (atteint / partiel / manqué + cause)
//   · Contrat         signature, fin prévue, crédits de séances, plan reçu
//   · Étape en cours  fiche 07 : notation 0-3, décision calculée, complétude,
//                     trancher, déverrouillage exceptionnel (admin)
//   · Ses outils      complétude des six livrables du dirigeant
//   · Séances/devoirs ce que l'élève a coché, notation de chaque devoir,
//                     verdict du cycle, devoirs pour la prochaine séance
//
// AUCUNE RÈGLE N'EST RECOPIÉE ICI. Les décisions se calculent dans l'Academy
// (la « décision calculée » affichée en direct n'est qu'un aperçu, le serveur
// recalcule). Le barème, les libellés et les statuts arrivent avec les
// réponses. Cette page affiche, saisit, envoie.
//
// CE QUI S'ÉCRIT OÙ :
//   · constats, notes d'étape, décisions, déverrouillages, notes de devoirs
//     → l'Academy, via /api/academy-jalon, -validation, -seances ;
//   · les DEVOIRS eux-mêmes (texte, outil, échéance) → la FICHE Alteore, par
//     le crochet hooks.saveDevoirs fourni par la page hôte, qui les renvoie
//     ensuite à l'Academy (api/academy-seance.js). La fiche reste la source
//     de vérité des séances, l'Academy celle des actes du coach.
//
// UTILISATION (page hôte, ex. coaching.html) :
//   <script src="academy-parcours.js"></script>
//   AcademyParcours.summary(el, { email, clientId, nom, role, hooks })
//     → un résumé compact dans `el` ; un bouton [data-ap-open] dans le même
//       conteneur [data-ap-scope] (ou dans `el`) ouvre la pop-up.
//   AcademyParcours.open({ email, clientId, nom, role, hooks })
//     → ouvre directement.
//   hooks.saveDevoirs(ref, devoirs) → Promise   ref = { seanceId, numero, annee }
//   hooks.syncAll() → Promise<nombre>           (facultatifs, tous les deux)
//
// Auth : ID token Firebase de la personne connectée (compat ou modulaire),
// envoyé à NOS relais /api/academy-*. Le secret du pont ne quitte jamais le
// serveur. Les droits (admin / coach agissent, CSM lit) sont décidés par les
// relais : la pop-up lit « peutAgir » dans les réponses.
//
// ES5 strict, délégation d'événements sur des attributs data-*, aucun
// gestionnaire inline. Fail-soft : toute indisponibilité se lit en clair.
// ============================================================================

(function () {
  'use strict';

  var css = ''
    + '.ap-overlay{position:fixed;inset:0;background:rgba(15,31,92,.5);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:600;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}'
    + '.ap-panel{position:relative;background:#f7f8fc;border-radius:18px;width:100%;max-width:1120px;height:94vh;max-height:980px;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(15,31,92,.25);overflow:hidden;font-family:inherit;color:#1f2340;font-size:13px;line-height:1.5}'
    + '.ap-head{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#fff;border-bottom:1px solid #e4e6f7}'
    + '.ap-head h3{margin:0;font-size:17px;font-weight:800;color:#1f2340}'
    + '.ap-head .ap-sub{font-size:12px;color:#6b7194;margin-top:2px}'
    + '.ap-close{margin-left:4px;background:none;border:none;font-size:20px;cursor:pointer;color:#6b7194;padding:4px 8px;line-height:1}'
    + '.ap-rail{display:flex;gap:6px;padding:12px 20px 0;background:#fff;overflow-x:auto}'
    + '.ap-node{flex:1 1 0;min-width:150px;background:none;border:none;cursor:pointer;text-align:center;padding:6px 4px 10px;font:inherit;color:#1f2340;border-radius:10px}'
    + '.ap-node:hover{background:#f7f8fc}'
    + '.ap-node .per{font-size:11px;color:#6b7194;letter-spacing:.3px}'
    + '.ap-node .dot{width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #c9cbe0;margin:6px auto;box-sizing:border-box}'
    + '.ap-node.ok .dot{background:#3d7a34;border-color:#3d7a34}'
    + '.ap-node.wip .dot{background:#b8860b;border-color:#b8860b}'
    + '.ap-node.stuck .dot{background:#c2410c;border-color:#c2410c}'
    + '.ap-node.sent .dot{background:#4f46e5;border-color:#4f46e5}'
    + '.ap-node.on{background:#f3f1ff}'
    + '.ap-node .nm{font-size:12px;font-weight:600;line-height:1.3}'
    + '.ap-node .st{font-size:10.5px;color:#6b7194;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}'
    + '.ap-tabs{display:flex;gap:2px;padding:0 20px;background:#fff;border-bottom:1px solid #e4e6f7;overflow-x:auto}'
    + '.ap-tabs button{background:none;border:none;border-bottom:2px solid transparent;padding:10px 14px;font:inherit;font-size:13px;font-weight:600;color:#6b7194;cursor:pointer;white-space:nowrap}'
    + '.ap-tabs button.on{color:#1f2340;border-bottom-color:#4f46e5}'
    + '.ap-body{flex:1;overflow-y:auto;padding:18px 20px 28px}'
    + '.ap-card{background:#fff;border:1px solid #e4e6f7;border-radius:14px;padding:16px 18px;margin-bottom:14px}'
    + '.ap-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}'
    + '.ap-kpi{border:1px solid #e4e6f7;border-radius:12px;padding:12px 14px;background:#fff}'
    + '.ap-kpi .kl{font-size:11.5px;color:#6b7194}'
    + '.ap-kpi .kv{font-size:24px;font-weight:800;line-height:1.2;margin:2px 0;color:#1f2340}'
    + '.ap-kpi .kt{font-size:11px;color:#6b7194}'
    + '.ap-kv{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#6b7194;margin:12px 0 4px}'
    + '.ap-quote{border-left:3px solid #b8860b;padding:4px 12px;font-size:13.5px;line-height:1.55;color:#1f2340}'
    + '.ap-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;background:#efeff4;color:#6b7194;white-space:nowrap}'
    + '.ap-pill.gold{background:#fdf6e3;color:#8a6508}'
    + '.ap-pill.ok{background:#e8f5e5;color:#3d7a34}'
    + '.ap-pill.warn{background:#fdeeea;color:#c2410c}'
    + '.ap-pill.blue{background:#eef2ff;color:#4338ca}'
    + '.ap-muted{color:#6b7194;font-size:12.5px}'
    + '.ap-btn{display:inline-block;border:1px solid #d9d6ee;background:#fff;border-radius:9px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;color:#3f3a75;cursor:pointer;text-decoration:none;line-height:1.3}'
    + '.ap-btn:hover{background:#f3f1ff}'
    + '.ap-btn:disabled{opacity:.5;cursor:default}'
    + '.ap-btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}'
    + '.ap-btn.primary:hover{background:#4338ca}'
    + '.ap-btn.ok{background:#f4faf1;border-color:#cfe8c9;color:#3d7a34}'
    + '.ap-btn.danger{background:#fdeeea;border-color:#f3c9bd;color:#c2410c}'
    + '.ap-btn.sm{padding:4px 10px;font-size:11.5px}'
    + '.ap-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}'
    + '.ap-inp{width:100%;box-sizing:border-box;border:1px solid #d9d6ee;border-radius:9px;padding:7px 10px;font:inherit;font-size:13px;background:#fff;color:#1f2340}'
    + 'textarea.ap-inp{resize:vertical;min-height:56px}'
    + '.ap-tbl{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.ap-tbl th{text-align:left;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:#6b7194;padding:6px 8px;border-bottom:1px solid #e4e6f7;font-weight:700}'
    + '.ap-tbl td{padding:6px 8px;border-bottom:1px solid #f0f1f8;vertical-align:top}'
    + '.ap-tbl input,.ap-tbl select{width:100%;box-sizing:border-box;border:1px solid #d9d6ee;border-radius:7px;padding:5px 8px;font:inherit;font-size:12.5px;background:#fff;color:#1f2340}'
    + '.ap-tbl input:disabled,.ap-tbl select:disabled{background:#f7f8fc;color:#6b7194}'
    + '.ap-scroll{overflow-x:auto}'
    + '.ap-jauge{font-size:34px;font-weight:800;line-height:1;min-width:80px}'
    + '.ap-manques{margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5}'
    + '.ap-msg{font-size:12.5px;margin-top:8px;min-height:16px}'
    + '.ap-msg.err{color:#b91c1c}.ap-msg.ok{color:#3d7a34}'
    + '.ap-jalon{border-top:1px solid #f0f1f8;padding:14px 0}'
    + '.ap-jalon:first-of-type{border-top:none;padding-top:4px}'
    + '.ap-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}'
    + '.ap-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}'
    + '.ap-chip{border:1px solid #d9d6ee;background:#fff;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:#3f3a75}'
    + '.ap-chip.on{background:#4f46e5;border-color:#4f46e5;color:#fff}'
    + '.ap-chip.done{border-color:#cfe8c9;color:#3d7a34}'
    + '.ap-bar{height:8px;border-radius:999px;background:#e7e5f4;overflow:hidden}'
    + '.ap-bar i{display:block;height:100%;border-radius:999px;background:#4f46e5}'
    + '.ap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}'
    + '.ap-devoir-row{display:grid;grid-template-columns:3fr 1.2fr 1fr auto;gap:8px;align-items:center;margin-bottom:8px}'
    + '.ap-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:#1f2340;color:#fff;padding:8px 16px;border-radius:999px;font-size:12.5px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis}'
    + '.ap-toast.show{opacity:1}'
    + '.ap-summary{display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:#1f2340}'
    + '.ap-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}'
    + '.ap-summary-cell{border:1px solid #e4e6f7;background:#fff;border-radius:10px;padding:8px 11px}'
    + '.ap-summary-cell .kl{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:#6b7194}'
    + '.ap-summary-cell .kv{font-size:13px;font-weight:700;margin-top:2px;line-height:1.35}'
    + '@media (max-width:720px){.ap-overlay{padding:0}.ap-panel{border-radius:0;height:100vh;max-height:none;max-width:none}.ap-devoir-row{grid-template-columns:1fr}.ap-node{min-width:120px}.ap-body{padding:14px 12px 24px}}';

  function injectCss() {
    if (document.getElementById('ap-css')) return;
    var st = document.createElement('style');
    st.id = 'ap-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }

  /* Le jeton, quel que soit le SDK de la page : compat (`firebase`) ou
     modulaire (`window._auth`, pages coaching). */
  function getToken() {
    return new Promise(function (resolve) {
      try {
        var user = null;
        if (window.firebase && firebase.auth && firebase.auth().currentUser) user = firebase.auth().currentUser;
        else if (window._auth && window._auth.currentUser) user = window._auth.currentUser;
        if (user && user.getIdToken) user.getIdToken().then(resolve, function () { resolve(''); });
        else resolve('');
      } catch (e) { resolve(''); }
    });
  }

  /* Un POST authentifié vers nos relais. Toujours un objet en retour, jamais
     une exception : la pop-up affiche le message, elle ne casse pas. */
  function api(path, payload) {
    return getToken().then(function (token) {
      if (!token) return { ok: false, error: 'session_expiree' };
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) { return (j && typeof j === 'object') ? j : { ok: false, error: 'academy_unreachable' }; });
    }).catch(function () { return { ok: false, error: 'academy_unreachable' }; });
  }

  var MESSAGES = {
    forbidden: 'Réservé aux coachs et administrateurs.',
    bridge_not_configured: 'Pont Academy non configuré (variables Vercel).',
    academy_unreachable: 'Academy indisponible pour le moment.',
    session_expiree: 'Session expirée, recharge la page.',
    v2_required: 'Ce client n\'est pas sur le parcours à étapes.',
    donnees_invalides: 'Données invalides.',
    unauthorized: 'Pont Academy refusé : clé invalide.',
    motif_requis: 'Un déverrouillage exceptionnel doit être motivé, en une phrase au moins.',
  };
  function messageErreur(j) {
    if (!j) return MESSAGES.academy_unreachable;
    if (j.ok === true && j.found === false) return 'Aucun compte Academy pour cet e-mail.';
    if (j.message) return String(j.message);
    return MESSAGES[j.error] || ('Erreur : ' + (j.error || 'inconnue'));
  }

  /* Libellés d'affichage. Les RÈGLES, elles, restent côté Academy. */
  var LIB_DECISION = { validee: 'Validée', a_completer: 'À compléter', bloquant: 'Bloquant' };
  var COULEUR_DECISION = { validee: '#3d7a34', a_completer: '#8a6508', bloquant: '#c2410c' };
  var STATUT_JALON = {
    atteint: { t: 'Atteint', p: 'ok', n: 'ok' },
    partiel: { t: 'Partiel', p: 'gold', n: 'wip' },
    manque: { t: 'Manqué', p: 'warn', n: 'stuck' },
    a_venir: { t: 'À venir', p: '', n: '' },
  };
  var ETAT_ETAPE = {
    verrouillee: { t: 'à venir', c: '#6b7194', n: '' },
    en_cours: { t: 'en cours', c: '#8a6508', n: 'wip' },
    soumise: { t: 'soumise', c: '#4338ca', n: 'sent' },
    a_completer: { t: 'à compléter', c: '#8a6508', n: 'wip' },
    bloquante: { t: 'bloquante', c: '#c2410c', n: 'stuck' },
    validee: { t: 'validée', c: '#3d7a34', n: 'ok' },
  };
  var LIB_STATUT_DEVOIR = { a_faire: 'À faire', fait: 'Fait, en attente de la séance', en_retard: 'En retard', note: 'Revu en séance' };
  var PILL_STATUT_DEVOIR = { a_faire: '', fait: 'ok', en_retard: 'warn', note: 'blue' };
  var LIB_STATUT_SEANCE = { '': 'Prévue', tenue: 'Tenue', reportee: 'Reportée', non_honoree: 'Non honorée' };
  var PILL_STATUT_SEANCE = { '': '', tenue: 'blue', reportee: 'gold', non_honoree: 'warn' };

  /* ── Dates : AAAA-MM-JJ, heure locale, jamais toISOString ──────────── */
  var YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
  function ymdLocal(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dateFr(iso, court) {
    var m = YMD.exec(iso || '');
    if (!m) return iso || '—';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('fr-FR', court ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function joursEntre(a, b) {
    var ma = YMD.exec(a || ''), mb = YMD.exec(b || '');
    if (!ma || !mb) return null;
    return Math.round((Date.UTC(+mb[1], +mb[2] - 1, +mb[3]) - Date.UTC(+ma[1], +ma[2] - 1, +ma[3])) / 86400000);
  }
  function pluriel(n, mot) { return n + ' ' + mot + (n > 1 ? 's' : ''); }

  /* L'identifiant d'une séance venue de la fiche : « alteor-<année sans
     espaces>-<numéro> » ou « alteor-<numéro> ». Une séance saisie à la main
     dans l'Academy n'a pas cette forme : ses devoirs se modifient là-bas. */
  function refSeance(id) {
    var m = /^alteor-(?:(.+)-)?(\d+)$/.exec(String(id || ''));
    if (!m) return null;
    return { seanceId: String(id), annee: m[1] || '', numero: Number(m[2]) };
  }

  function options(liste, valeur) {
    var h = '';
    for (var i = 0; i < liste.length; i++) {
      var v = liste[i];
      h += '<option value="' + esc(v) + '"' + (String(valeur) === v ? ' selected' : '') + '>' + (v === '' ? '—' : esc(v)) + '</option>';
    }
    return h;
  }

  /* ── L'état de la pop-up ───────────────────────────────────────────── */
  var S = null;

  function root() { return document.getElementById('ap-overlay'); }
  function q(sel, base) { var b = base || root(); return b ? b.querySelector(sel) : null; }

  function toast(texte) {
    var t = q('[data-ap-toast]');
    if (!t) return;
    t.textContent = texte;
    t.className = 'ap-toast show';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'ap-toast'; }, 2600);
  }
  function setMsg(zone, sel, texte, ok) {
    var m = zone ? zone.querySelector(sel) : null;
    if (!m) return;
    m.textContent = texte || '';
    m.className = 'ap-msg ' + (ok ? 'ok' : 'err');
  }
  function verrouiller(zone, oui) {
    if (!zone) return;
    var b = zone.querySelectorAll('button,input,select,textarea');
    for (var i = 0; i < b.length; i++) b[i].disabled = !!oui;
  }

  function open(opts) {
    opts = opts || {};
    if (!opts.email) return;
    close(true);
    injectCss();
    S = {
      email: String(opts.email).trim().toLowerCase(),
      clientId: opts.clientId || '',
      nom: opts.nom || '',
      role: opts.role || '',
      hooks: opts.hooks || {},
      summaryEl: opts.summaryEl || null,
      onglet: 'jalons',
      etat: null, fiche: null, ficheErreur: '', etapeId: '',
      seances: null, seancesErreur: '', verdict: null, bareme: null,
      aujourdhui: ymdLocal(new Date()),
      peutAgir: false, chargement: true, erreur: '',
      jalonForm: '', editeur: null,
    };
    var ov = document.createElement('div');
    ov.className = 'ap-overlay';
    ov.id = 'ap-overlay';
    ov.innerHTML = '<div class="ap-panel" role="dialog" aria-modal="true" aria-label="Gérer le parcours">'
      + '<div class="ap-head"><div style="flex:1;min-width:0"><h3>🎓 Parcours Elite — ' + esc(S.nom || S.email) + '</h3><div class="ap-sub" data-ap-sub>Chargement…</div></div>'
      + '<button type="button" class="ap-btn sm" data-ap-reload title="Relire l\'état depuis l\'Academy">↻ Actualiser</button>'
      + '<button type="button" class="ap-close" data-ap-close aria-label="Fermer">✕</button></div>'
      + '<div data-ap-rail></div><div class="ap-tabs" data-ap-tabs></div>'
      + '<div class="ap-body" data-ap-body><p class="ap-muted">Chargement du parcours…</p></div>'
      + '<div class="ap-toast" data-ap-toast></div></div>';
    document.body.appendChild(ov);
    loadAll();
  }

  function close(silencieux) {
    var ov = root();
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var el = S && S.summaryEl;
    S = null;
    /* Le résumé de la fiche se relit : un constat ou une décision a pu
       changer le jalon ou l'étape en cours. */
    if (!silencieux && el && el._apOpts) summary(el, el._apOpts);
  }

  /* ── Chargements ───────────────────────────────────────────────────── */
  function loadAll() {
    if (!S) return;
    S.chargement = true; S.erreur = '';
    render();
    var email = S.email;
    Promise.all([
      api('/api/academy-etat', { email: email }),
      api('/api/academy-seances', { email: email, action: 'lire' }),
    ]).then(function (r) {
      if (!S || S.email !== email) return;
      var e = r[0];
      S.chargement = false;
      if (!e || e.ok !== true) { S.erreur = messageErreur(e); render(); return; }
      if (!e.found) { S.erreur = 'Aucun compte Academy pour cet e-mail.'; render(); return; }
      if (e.version !== 'v2_6mois') { S.erreur = MESSAGES.v2_required + ' Il suit le programme vidéo : son avancement est dans le bloc AE Academy de la fiche.'; render(); return; }
      S.etat = e;
      S.peutAgir = e.peutAgir === true;
      appliquerSeances(r[1]);
      var cible = S.etapeId || e.etapeCourante || ((e.etapes || [])[0] || {}).cle || '';
      render();
      if (cible) loadFiche(cible);
    });
  }
  function appliquerSeances(s) {
    if (s && s.ok === true && s.found) {
      S.seances = s.seances || [];
      S.verdict = s.verdict || null;
      S.bareme = s.bareme || S.bareme;
      if (s.aujourdhui) S.aujourdhui = s.aujourdhui;
      S.seancesErreur = '';
    } else {
      S.seances = S.seances || [];
      S.seancesErreur = messageErreur(s);
    }
  }
  function loadFiche(etapeId) {
    if (!S) return;
    S.etapeId = etapeId; S.fiche = null; S.ficheErreur = '';
    render();
    var email = S.email;
    api('/api/academy-validation', { email: email, etape: etapeId, action: 'lire' }).then(function (j) {
      if (!S || S.email !== email || S.etapeId !== etapeId) return;
      if (!j || j.ok !== true || j.found === false || !j.etape) { S.ficheErreur = messageErreur(j); render(); return; }
      S.fiche = j;
      S.bareme = S.bareme || j.bareme || null;
      render();
    });
  }
  function reloadEtat() {
    if (!S) return;
    var email = S.email;
    api('/api/academy-etat', { email: email }).then(function (e) {
      if (!S || S.email !== email) return;
      if (e && e.ok === true && e.found) { S.etat = e; S.peutAgir = e.peutAgir === true; render(); }
    });
  }
  function reloadSeances() {
    if (!S) return;
    var email = S.email;
    api('/api/academy-seances', { email: email, action: 'lire' }).then(function (s) {
      if (!S || S.email !== email) return;
      appliquerSeances(s);
      render();
    });
  }

  /* ── Rendu ─────────────────────────────────────────────────────────── */
  function render() {
    var r = root();
    if (!r || !S) return;
    var sub = q('[data-ap-sub]', r), rail = q('[data-ap-rail]', r), tabs = q('[data-ap-tabs]', r), body = q('[data-ap-body]', r);
    var scroll = body.scrollTop;
    if (S.chargement) {
      sub.textContent = 'Chargement…'; rail.innerHTML = ''; tabs.innerHTML = '';
      body.innerHTML = '<p class="ap-muted">Chargement du parcours…</p>';
      return;
    }
    if (S.erreur) {
      sub.textContent = ''; rail.innerHTML = ''; tabs.innerHTML = '';
      body.innerHTML = '<div class="ap-card"><p style="margin:0;font-size:14px">' + esc(S.erreur) + '</p></div>';
      return;
    }
    sub.textContent = sousTitre();
    rail.innerHTML = renderRail();
    tabs.innerHTML = renderTabs();
    var h = '';
    if (S.onglet === 'jalons') h = renderJalons();
    else if (S.onglet === 'contrat') h = renderContrat();
    else if (S.onglet === 'etape') h = renderEtape();
    else if (S.onglet === 'outils') h = renderOutils();
    else if (S.onglet === 'seances') h = renderSeances();
    body.innerHTML = h;
    body.scrollTop = scroll;
    if (S.onglet === 'etape' && S.fiche) afficherDecision();
    var ed = q('[data-ap-editeur]', body);
    if (ed && S.editeur && !S.editeur.vu) { S.editeur.vu = true; try { ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* vieux Safari */ } }
  }

  function prochaineSeance() {
    var l = S.seances || [];
    var best = null;
    for (var i = 0; i < l.length; i++) {
      if (l[i].date && l[i].date > S.aujourdhui && (!best || l[i].date < best.date)) best = l[i];
    }
    return best;
  }
  function dernierePassee() {
    var l = S.seances || [];
    var best = null;
    for (var i = 0; i < l.length; i++) {
      if (!l[i].date || l[i].date <= S.aujourdhui) best = l[i]; // liste triée par date
    }
    return best;
  }

  function sousTitre() {
    var d = S.etat, js = d.jalons || [], parts = [];
    var atteints = 0;
    for (var i = 0; i < js.length; i++) if (js[i].statut === 'atteint') atteints += 1;
    if (js.length) parts.push(pluriel(atteints, 'jalon') + ' atteint' + (atteints > 1 ? 's' : '') + ' sur ' + js.length);
    else parts.push(pluriel(d.validees || 0, 'étape') + ' validée' + (d.validees > 1 ? 's' : '') + ' sur ' + (d.total || 0));
    if (d.credits) parts.push(pluriel(d.credits.restantes, 'séance') + ' restante' + (d.credits.restantes > 1 ? 's' : ''));
    var p = prochaineSeance();
    parts.push(p ? 'prochaine séance le ' + dateFr(p.date) : 'aucune séance calée');
    if (!S.peutAgir) parts.push('lecture seule');
    return parts.join(' · ');
  }

  function renderRail() {
    var d = S.etat, js = d.jalons || [], h = '<div class="ap-rail">', i;
    if (js.length) {
      for (i = 0; i < js.length; i++) {
        var j = js[i];
        var st = STATUT_JALON[j.statut] || STATUT_JALON.a_venir;
        var cls = st.n || (j.enRetard ? 'stuck' : '');
        var on = S.onglet === 'jalons' && S.jalonForm === j.code;
        h += '<button type="button" class="ap-node ' + cls + (on ? ' on' : '') + '" data-ap-node="' + esc(j.code) + '" aria-label="' + esc(j.code + ' — ' + j.objectif) + '">'
          + '<div class="per">' + esc(j.dateCible || '') + '</div><div class="dot"></div>'
          + '<div class="nm">' + esc(j.objectif) + '</div>'
          + '<div class="st">' + (j.statut === 'a_venir' && j.enRetard ? 'En retard' : esc(st.t)) + '</div></button>';
      }
    } else {
      var es = d.etapes || [];
      for (i = 0; i < es.length; i++) {
        var e = es[i], ee = ETAT_ETAPE[e.etat] || ETAT_ETAPE.verrouillee;
        h += '<button type="button" class="ap-node ' + ee.n + (e.cle === S.etapeId && S.onglet === 'etape' ? ' on' : '') + '" data-ap-etape="' + esc(e.cle) + '">'
          + '<div class="per">' + esc(e.code) + '</div><div class="dot"></div><div class="nm">' + esc(e.titre) + '</div><div class="st">' + esc(ee.t) + '</div></button>';
      }
    }
    return h + '</div>';
  }

  function renderTabs() {
    var t = [['jalons', 'Jalons'], ['contrat', 'Contrat'], ['etape', 'Étape en cours'], ['outils', 'Ses outils'], ['seances', 'Séances et devoirs']];
    var h = '';
    for (var i = 0; i < t.length; i++) h += '<button type="button" class="' + (S.onglet === t[i][0] ? 'on' : '') + '" data-ap-tab="' + t[i][0] + '">' + t[i][1] + '</button>';
    return h;
  }

  function kpi(l, v, t, color) {
    return '<div class="ap-kpi"><div class="kl">' + esc(l) + '</div><div class="kv"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(v) + '</div><div class="kt">' + esc(t) + '</div></div>';
  }
  function kpisCredits(c) {
    return '<div class="ap-kpis">'
      + kpi('Séances restantes', c.restantes, 'sur ' + c.total + ' du contrat')
      + kpi('Consommées', c.consommees, 'tenues et non honorées')
      + kpi('Reportées', c.reportees, 'ne consomment aucun crédit')
      + kpi('Sans synthèse', c.sansTrace, c.sansTrace > 0 ? 'fiche à remplir dans la fiche coaching' : 'fiche à jour', c.sansTrace > 0 ? '#8a6508' : '')
      + '</div>';
  }

  /* ── Onglet Jalons ─────────────────────────────────────────────────── */
  function renderJalons() {
    var d = S.etat, js = d.jalons || [];
    if (!js.length) {
      return '<div class="ap-card"><p class="ap-muted" style="margin:0;font-size:13.5px;line-height:1.6">Ce dossier n\'a pas de date de signature côté Academy, donc pas d\'échéances. Les jalons se calculent à partir d\'elle — elle se renseigne dans l\'Academy (Suivi).</p></div>';
    }
    var h = '';
    if (d.credits) h += kpisCredits(d.credits);
    h += '<div class="ap-card">';
    h += '<p class="ap-muted" style="margin:0 0 6px;font-size:13px;line-height:1.6;max-width:80ch">Le constat se pose <b>en séance</b>, jamais tout seul. Un jalon dont l\'échéance est passée est signalé « en retard » mais reste « à venir » tant que vous n\'avez pas tranché. <b>Un jalon manqué exige une cause</b> — sans elle, personne ne saura quoi corriger.</p>';
    if (d.plan && (d.plan.pointA || d.plan.pointB)) {
      h += '<div style="margin:10px 0 4px;padding:9px 12px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;font-size:12.5px">'
        + (d.plan.pointA ? '<div><b>A :</b> ' + esc(d.plan.pointA) + '</div>' : '')
        + (d.plan.pointB ? '<div style="margin-top:3px"><b>B :</b> ' + esc(d.plan.pointB) + '</div>' : '')
        + '</div>';
    }
    for (var i = 0; i < js.length; i++) {
      var j = js[i];
      var st = STATUT_JALON[j.statut] || STATUT_JALON.a_venir;
      h += '<div class="ap-jalon" data-ap-jalon-row="' + esc(j.code) + '">'
        + '<div class="ap-row"><span class="ap-pill gold">' + esc(j.code) + '</span><span class="ap-muted">' + esc(j.dateCible || '') + '</span>'
        + '<b style="font-size:14.5px;flex:1;min-width:200px">' + esc(j.objectif) + '</b>'
        + (j.personnalise ? '<span class="ap-pill blue" title="Personnalisé par le plan d\'action de la fiche">perso</span>' : '')
        + (j.enRetard ? '<span class="ap-pill warn">En retard</span>' : '')
        + '<span class="ap-pill ' + st.p + '">' + esc(st.t) + '</span></div>'
        + '<div class="ap-muted" style="margin-top:6px">Preuve attendue : ' + esc(j.preuve || '—')
        + (j.nbOutils ? ' · ' + esc(j.nbOutilsFaits) + ' / ' + esc(j.nbOutils) + ' document' + (j.nbOutils > 1 ? 's' : '') + ' complet' + (j.nbOutilsFaits > 1 ? 's' : '') : '') + '</div>'
        + (j.cause ? '<div style="margin-top:6px;font-size:12.5px;color:#c2410c">Cause notée : ' + esc(j.cause) + '</div>' : '')
        + (j.dateConstat ? '<div class="ap-muted" style="margin-top:3px">Constaté le ' + esc(dateFr(j.dateConstat)) + '</div>' : '');
      if (S.peutAgir) {
        if (S.jalonForm === j.code) {
          h += '<div style="margin-top:12px" data-ap-jalon-form>'
            + '<label class="ap-muted" style="display:block;margin-bottom:6px">Cause — obligatoire pour « manqué », utile partout ailleurs</label>'
            + '<input class="ap-inp" data-ap-cause value="' + esc(j.cause || '') + '" placeholder="Ex : recrutement décalé, le bras droit arrive en mai">'
            + '<div class="ap-actions">'
            + '<button type="button" class="ap-btn ok" data-ap-constat="atteint">Atteint</button>'
            + '<button type="button" class="ap-btn" data-ap-constat="partiel">Partiellement</button>'
            + '<button type="button" class="ap-btn danger" data-ap-constat="manque">Manqué</button>'
            + '<button type="button" class="ap-btn" data-ap-jalon-cancel>Annuler</button></div>'
            + '<div class="ap-msg" data-ap-msg></div></div>';
        } else {
          h += '<div class="ap-actions"><button type="button" class="ap-btn sm" data-ap-jalon="' + esc(j.code) + '">' + (j.statut === 'a_venir' ? 'Constater ce jalon' : 'Revoir le constat') + '</button></div>';
        }
      }
      h += '</div>';
    }
    h += '<p class="ap-muted" style="margin:12px 0 0">Les objectifs, les preuves et les échéances viennent du <b>plan d\'action</b> de la fiche (badge « perso » quand il les a remaniés) : c\'est là qu\'ils se modifient, jamais ici.</p>';
    return h + '</div>';
  }

  function constater(statut) {
    var r = root(), form = q('[data-ap-jalon-form]', r);
    if (!form || !S) return;
    var row = form.closest('[data-ap-jalon-row]');
    var code = row ? row.getAttribute('data-ap-jalon-row') : '';
    var inp = q('[data-ap-cause]', form);
    var charge = { email: S.email, code: code, statut: statut, cause: inp ? inp.value : '' };
    verrouiller(form, true);
    setMsg(form, '[data-ap-msg]', 'Enregistrement…', true);
    api('/api/academy-jalon', charge).then(function (j) {
      if (!S) return;
      if (!j || j.ok !== true || j.found === false) { verrouiller(form, false); setMsg(form, '[data-ap-msg]', messageErreur(j), false); return; }
      toast('Constat enregistré : ' + code + ' ' + (STATUT_JALON[statut] || {}).t);
      S.jalonForm = '';
      reloadEtat();
    });
  }

  /* ── Onglet Contrat ────────────────────────────────────────────────── */
  function renderContrat() {
    var d = S.etat, ct = d.contrat || {}, h = '<div class="ap-card">';
    h += '<p class="ap-muted" style="margin:0 0 16px;font-size:13px;line-height:1.6;max-width:80ch">Le cadre du dossier, repris ici pour que cette fiche soit la seule à ouvrir avant une séance. La date de fin se calcule côté Academy depuis la signature et la durée du format.</p>';
    if (!ct.debut) {
      h += '<p style="margin:0;font-size:14px">Aucune date de signature côté Academy. C\'est elle qui commande les jalons — tant qu\'elle manque, ce dossier n\'a pas d\'échéances. Elle se renseigne dans l\'Academy (Suivi).</p>';
    } else {
      var total = joursEntre(ct.debut, ct.fin), ecoules = joursEntre(ct.debut, S.aujourdhui), restants = joursEntre(S.aujourdhui, ct.fin);
      var part = (total && total > 0 && ecoules != null) ? Math.max(0, Math.min(1, ecoules / total)) : null;
      var alerte = restants != null && restants < 45;
      h += '<div class="ap-kpis">'
        + kpi('Signature', dateFr(ct.debut), '')
        + kpi('Fin prévue', ct.fin ? dateFr(ct.fin) : '—', '')
        + kpi('Format', d.version === 'v2_6mois' ? '6 mois' : 'Historique', 'parcours à étapes')
        + kpi('Jours restants', restants == null ? '—' : Math.max(0, restants), alerte ? 'la reconduction se prépare maintenant' : 'sur les six mois', alerte ? '#8a6508' : '')
        + '</div>';
      if (part != null) {
        h += '<div class="ap-row"><div class="ap-bar" style="flex:1"><i style="width:' + Math.round(part * 100) + '%"></i></div><span class="ap-muted">' + Math.round(part * 100) + ' %</span></div>';
      }
      h += '<p class="ap-muted" style="margin:12px 0 0">Ce pourcentage mesure le TEMPS écoulé, jamais l\'avancement du client.</p>';
    }
    h += '</div>';
    if (d.credits) h += kpisCredits(d.credits);
    var p = d.plan || {};
    h += '<div class="ap-card"><div class="ap-row"><div class="ap-kv" style="margin:0">Plan d\'action reçu par l\'Academy</div>'
      + (p.recu ? '<span class="ap-pill ok">reçu' + (p.revision ? ' · révision ' + esc(p.revision) : '') + '</span>' : '<span class="ap-pill gold">plan non poussé</span>') + '</div>';
    if (p.verrou) h += '<div style="margin-top:8px"><b>Verrou :</b> ' + esc(p.verrou) + '</div>';
    if (p.ordreEtapes && p.ordreEtapes.length) h += '<div style="margin-top:4px"><b>Ordre des étapes :</b> ' + esc(p.ordreEtapes.join(' → ')) + '</div>';
    if (p.pointA) h += '<div class="ap-kv">Point A</div><div class="ap-quote">' + esc(p.pointA) + '</div>';
    if (p.pointB) h += '<div class="ap-kv">Point B</div><div class="ap-quote">' + esc(p.pointB) + '</div>';
    h += '<p class="ap-muted" style="margin:12px 0 0">Le plan se modifie dans la fiche (section Plan d\'action) et repart vers l\'Academy tout seul.</p></div>';
    return h;
  }

  /* ── Onglet Étape en cours — la fiche 07 ───────────────────────────── */
  function renderEtape() {
    var f = S.fiche, h = '', i;
    var etats = (f && f.etats) || [];
    if (!etats.length) {
      var es = S.etat.etapes || [];
      for (i = 0; i < es.length; i++) etats.push({ id: es[i].cle, code: es[i].code, titre: es[i].titre, statut: es[i].etat });
    }
    h += '<div class="ap-chips">';
    for (i = 0; i < etats.length; i++) {
      var e = etats[i];
      var cls = e.id === S.etapeId ? 'on' : (e.statut === 'validee' ? 'done' : '');
      h += '<button type="button" class="ap-chip ' + cls + '" data-ap-etape="' + esc(e.id) + '">' + esc(e.code) + ' · ' + esc(e.titre) + '</button>';
    }
    h += '</div>';
    if (S.ficheErreur) return h + '<div class="ap-card"><span class="ap-msg err">' + esc(S.ficheErreur) + '</span></div>';
    if (!f) return h + '<div class="ap-card ap-muted">Chargement de la fiche…</div>';

    var et = f.etape, ee = ETAT_ETAPE[et.statut] || { t: et.statut || '—', c: '#6b7194' };
    var peutNoter = S.peutAgir && et.ouverte;
    var peutTrancher = peutNoter && et.statut !== 'validee';
    var mode = (f.reglages || {}).mode || '';

    h += '<div class="ap-card"><div class="ap-row"><span class="ap-pill gold">' + esc(et.code) + ' · ' + esc(et.periode) + '</span>'
      + '<b style="font-size:17px">' + esc(et.titre) + '</b><span style="flex:1"></span>'
      + '<span class="ap-pill" style="color:' + ee.c + '">' + esc(ee.t) + '</span>'
      + (mode ? '<span class="ap-pill">mode ' + esc(mode) + '</span>' : '') + '</div>'
      + (et.objectif ? '<div class="ap-kv">Objectif</div><div class="ap-quote">' + esc(et.objectif) + '</div>' : '')
      + '<div class="ap-kv">Livrables attendus</div><div class="ap-quote">' + esc(et.livrable || '—') + '</div>'
      + (et.victoire ? '<div class="ap-kv">Critère de validation</div><div class="ap-quote">' + esc(et.victoire) + '</div>' : '')
      + '</div>';

    var c = f.completude || {}, manques = c.manques || [];
    h += '<div class="ap-card" style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">'
      + '<div class="ap-jauge" style="color:' + (c.ok ? '#3d7a34' : '#8a6508') + '">' + esc(c.nbOk) + '/' + esc(c.nbTotal) + '</div>'
      + '<div style="flex:1;min-width:240px"><div class="ap-kv" style="margin-top:0">Complétude des livrables — ne se contourne pas</div>';
    if (c.ok) h += '<div style="font-size:14px">Tous les livrables requis sont complets.</div>';
    else { h += '<ul class="ap-manques">'; for (i = 0; i < manques.length; i++) h += '<li>' + esc(manques[i]) + '</li>'; h += '</ul>'; }
    h += '</div></div>';

    if (!et.ouverte) {
      h += '<div class="ap-card"><span class="ap-muted">Cette étape est verrouillée : sa précédente n\'est pas validée. Rien à noter tant qu\'elle n\'est pas ouverte.</span></div>';
    } else {
      var ev = f.evaluation || {}, liv = ev.livrables || [], bareme = f.bareme || S.bareme || {};
      var cles = Object.keys(bareme), bl = [];
      for (i = 0; i < cles.length; i++) bl.push(cles[i] + ' ' + String(bareme[cles[i]]).split('—')[0].trim());
      h += '<div class="ap-card" data-ap-fiche><div class="ap-kv" style="margin-top:0">Notation des livrables</div>'
        + '<div class="ap-muted" style="margin-bottom:8px">' + (bl.length ? esc(bl.join(' · ')) + '. ' : '') + 'Un livrable non noté ne tire pas la moyenne vers le bas.</div>'
        + '<div class="ap-scroll"><table class="ap-tbl"><thead><tr><th style="min-width:240px">Livrable</th><th style="min-width:130px">Rendu avant la séance</th><th style="min-width:80px">Score</th><th style="min-width:200px">Commentaire</th></tr></thead><tbody>';
      var dis = peutNoter ? '' : ' disabled';
      for (i = 0; i < liv.length; i++) {
        var l = liv[i] || {}, sc = (l.score == null) ? '' : String(l.score);
        h += '<tr data-ap-liv="' + i + '">'
          + '<td><input data-ap-f="libelle" value="' + esc(l.libelle) + '"' + dis + '></td>'
          + '<td><select data-ap-f="renduAvantSeance"' + dis + '>' + options(['', 'Oui', 'Non'], l.renduAvantSeance || '') + '</select></td>'
          + '<td><select data-ap-f="score" title="' + esc(bareme[sc] || '') + '"' + dis + '>' + options(['', '0', '1', '2', '3'], sc) + '</select></td>'
          + '<td><input data-ap-f="commentaire" value="' + esc(l.commentaire) + '"' + dis + '></td></tr>';
      }
      h += '</tbody></table></div>';
      h += '<div class="ap-row" style="margin-top:14px;align-items:flex-start;gap:18px">'
        + '<div style="flex:1;min-width:180px"><div class="ap-kv" style="margin-top:0">Décision calculée</div><div style="font-size:21px;font-weight:800" data-ap-decision>—</div><div class="ap-muted" data-ap-moyenne></div></div>'
        + '<div style="flex:1;min-width:180px"><div class="ap-kv" style="margin-top:0">Date de la séance</div><input type="date" class="ap-inp" data-ap-date value="' + esc(ev.date || '') + '"' + dis + '></div>'
        + '<div style="flex:1;min-width:180px"><div class="ap-kv" style="margin-top:0">Ce qui en découle</div><div style="font-size:13px" data-ap-suite>—</div></div></div>';
      if (peutNoter) {
        h += '<div class="ap-actions"><button type="button" class="ap-btn" data-ap-noter>Enregistrer la notation</button>'
          + (peutTrancher ? '<button type="button" class="ap-btn primary" data-ap-trancher>Trancher et appliquer</button>' : '<span class="ap-muted">Étape validée : la notation reste consultable.</span>')
          + '</div>';
      }
      h += '<div class="ap-msg" data-ap-msg></div></div>';
    }

    var hist = et.historique || [];
    if (hist.length) {
      h += '<div class="ap-card ap-scroll"><div class="ap-kv" style="margin-top:0">Historique des décisions</div><table class="ap-tbl"><thead><tr><th>Date</th><th>Décision</th><th>Score</th><th>Coach</th></tr></thead><tbody>';
      for (i = hist.length - 1; i >= 0; i--) {
        var x = hist[i];
        h += '<tr><td>' + (x.at ? esc(new Date(x.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })) : '—') + '</td>'
          + '<td><span class="ap-pill" style="color:' + (COULEUR_DECISION[x.decision] || '#6b7194') + '">' + esc(LIB_DECISION[x.decision] || x.decision) + '</span></td>'
          + '<td>' + (x.moyenne == null ? '—' : Number(x.moyenne).toFixed(2)) + '</td><td class="ap-muted">' + esc(x.coach || '—') + '</td></tr>';
      }
      h += '</tbody></table></div>';
    }

    /* Le déverrouillage exceptionnel : un acte d'administrateur, sur une
       étape encore fermée. Le relais refuse tout autre rôle. */
    if (S.role === 'admin' && !et.ouverte && et.statut !== 'validee') {
      h += '<div class="ap-card"><div class="ap-kv" style="margin-top:0">Déverrouillage exceptionnel</div>'
        + '<div class="ap-muted" style="margin-bottom:8px">Ouvre cette étape en dehors des règles. Motif obligatoire, tracé au journal de l\'Academy avec votre nom.</div>'
        + '<textarea class="ap-inp" rows="2" data-ap-motif placeholder="Client repris en cours de programme, étapes déjà faites hors plateforme."></textarea>'
        + '<div class="ap-actions"><button type="button" class="ap-btn danger" data-ap-deverrouiller>Déverrouiller ' + esc(et.code) + '</button></div>'
        + '<div class="ap-msg" data-ap-msg-dev></div></div>';
    }
    return h;
  }

  /* La décision, recalculée à chaque note — mêmes seuils que l'Academy
     (reçus avec la fiche). Le serveur recalcule de son côté : ceci n'est
     qu'un aperçu, pas une décision. */
  function decisionLocale(form) {
    var f = S.fiche || {}, r = f.reglages || {};
    var sv = typeof r.seuilValide === 'number' ? r.seuilValide : 2.5;
    var sa = typeof r.seuilACompleter === 'number' ? r.seuilACompleter : 1.5;
    var sels = form.querySelectorAll('select[data-ap-f="score"]'), notes = [];
    for (var i = 0; i < sels.length; i++) if (sels[i].value !== '') notes.push(Number(sels[i].value));
    if (!notes.length) return { decision: '', moyenne: null };
    var somme = 0;
    for (var k = 0; k < notes.length; k++) somme += notes[k];
    var m = somme / notes.length;
    return { decision: m >= sv ? 'validee' : (m >= sa ? 'a_completer' : 'bloquant'), moyenne: m };
  }
  function afficherDecision() {
    var form = q('[data-ap-fiche]');
    if (!form || !S || !S.fiche) return;
    var d = decisionLocale(form), f = S.fiche;
    var el = q('[data-ap-decision]', form), moy = q('[data-ap-moyenne]', form), suite = q('[data-ap-suite]', form);
    if (el) {
      el.textContent = d.decision ? LIB_DECISION[d.decision] : 'En attente de notation';
      el.style.color = d.decision ? COULEUR_DECISION[d.decision] : '#6b7194';
    }
    if (moy) moy.textContent = d.moyenne == null ? 'Notez les livrables ci-dessus' : 'Score moyen ' + d.moyenne.toFixed(2) + ' / 3';
    if (suite) {
      var txt = d.decision ? ((f.actions || {})[d.decision] || '') : '—';
      if (d.decision === 'validee' && f.completude && !f.completude.ok) {
        txt += ' ⚠ Les livrables ne sont pas complets : la validation sera refusée.';
        suite.style.color = '#c2410c';
      } else suite.style.color = '';
      suite.textContent = txt;
    }
  }
  /* Ce qu'on renvoie : les livrables tels que saisis, la date, et les
     champs de preuve chiffrée REPRIS de la fiche reçue — non édités ici,
     ils ne doivent pas être effacés pour autant. */
  function lireEvaluation(form) {
    var f = S.fiche || {}, ev = f.evaluation || {};
    var rows = form.querySelectorAll('tr[data-ap-liv]'), liv = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var g = function (n) { var e = r.querySelector('[data-ap-f="' + n + '"]'); return e ? e.value : ''; };
      liv.push({ libelle: g('libelle'), renduAvantSeance: g('renduAvantSeance'), score: g('score'), commentaire: g('commentaire') });
    }
    var date = q('[data-ap-date]', form);
    return {
      date: date ? date.value : (ev.date || ''),
      preuveIndicateur: ev.preuveIndicateur || '',
      preuveDepart: ev.preuveDepart == null ? '' : ev.preuveDepart,
      preuveArrivee: ev.preuveArrivee == null ? '' : ev.preuveArrivee,
      livrables: liv,
    };
  }
  /* Enregistrer la notation, puis — si demandé — trancher. Deux appels, dans
     cet ordre : trancher sans avoir enregistré appliquerait les notes d'avant. */
  function noterEtape(puisTrancher) {
    var form = q('[data-ap-fiche]');
    if (!form || !S || !S.fiche) return;
    var email = S.email, cle = S.etapeId;
    verrouiller(form, true);
    setMsg(form, '[data-ap-msg]', puisTrancher ? 'Enregistrement, puis décision…' : 'Enregistrement…', true);
    api('/api/academy-validation', { email: email, etape: cle, action: 'noter', evaluation: lireEvaluation(form) }).then(function (j) {
      if (!S || S.etapeId !== cle) return null;
      if (!j || j.ok !== true) { verrouiller(form, false); setMsg(form, '[data-ap-msg]', messageErreur(j), false); return null; }
      S.fiche = j;
      if (!puisTrancher) {
        verrouiller(form, false);
        setMsg(form, '[data-ap-msg]', 'Notation enregistrée.', true);
        afficherDecision();
        toast('Notation enregistrée');
        return null;
      }
      return api('/api/academy-validation', { email: email, etape: cle, action: 'decider' }).then(function (k) {
        if (!S || S.etapeId !== cle) return;
        if (!k || k.ok !== true) {
          verrouiller(form, false);
          var t = messageErreur(k);
          if (k && k.manques && k.manques.length) t += ' — ' + k.manques.join(' · ');
          setMsg(form, '[data-ap-msg]', t, false);
          return;
        }
        toast('Décision appliquée : ' + (LIB_DECISION[k.appliquee] || k.appliquee) + (k.instantanePris ? ' · instantané pris' : ''));
        S.fiche = k;
        render();
        reloadEtat();     // l'étape suivante s'est peut-être ouverte
        reloadSeances();  // le verdict du cycle change avec l'étape
      });
    });
  }
  function deverrouiller() {
    var r = root(), ta = q('[data-ap-motif]', r), zone = q('[data-ap-msg-dev]', r), b = q('[data-ap-deverrouiller]', r);
    if (!S || !ta) return;
    var motif = ta.value.trim();
    if (motif.length < 10) { if (zone) { zone.textContent = 'Un motif d\'au moins dix caractères est obligatoire.'; zone.className = 'ap-msg err'; } return; }
    if (b) b.disabled = true;
    var cle = S.etapeId;
    api('/api/academy-validation', { email: S.email, etape: cle, action: 'deverrouiller', motif: motif }).then(function (j) {
      if (!S || S.etapeId !== cle) return;
      if (!j || j.ok !== true) { if (b) b.disabled = false; if (zone) { zone.textContent = messageErreur(j); zone.className = 'ap-msg err'; } return; }
      toast('Étape déverrouillée');
      S.fiche = j;
      render();
      reloadEtat();
    });
  }

  /* ── Onglet Ses outils ─────────────────────────────────────────────── */
  function renderOutils() {
    var d = S.etat, os = (d.outils && d.outils.detail) || [], es = d.etapes || [], i, k;
    var requis = {};
    for (i = 0; i < es.length; i++) {
      var req = es[i].outilsRequis || [];
      for (k = 0; k < req.length; k++) (requis[req[k]] = requis[req[k]] || []).push(es[i].code);
    }
    var h = '<div class="ap-card"><div class="ap-row"><b style="font-size:15px">' + esc(d.outils.remplis) + ' / ' + esc(d.outils.total) + ' outils complets</b>'
      + '<span class="ap-muted">— la complétude est le verrou de chaque étape. Le contenu des outils se consulte dans l\'Academy (compte Academy requis), il ne transite pas par ici.</span></div></div>';
    h += '<div class="ap-grid">';
    for (i = 0; i < os.length; i++) {
      var o = os[i], pct = o.nbTotal ? Math.round((o.nbOk / o.nbTotal) * 100) : 0;
      h += '<div class="ap-card" style="margin:0"><div class="ap-row"><span style="font-size:18px;font-weight:800;color:#8a6508">' + esc(o.numero) + '</span><b style="font-size:14.5px">' + esc(o.nom) + '</b></div>'
        + (requis[o.id] ? '<div class="ap-muted" style="margin-top:4px">Requis par ' + esc(requis[o.id].join(', ')) + '</div>' : '')
        + '<div class="ap-row" style="margin-top:12px"><div class="ap-bar" style="flex:1"><i style="width:' + pct + '%;background:' + (o.complet ? '#3d7a34' : '#c2410c') + '"></i></div><span class="ap-muted">' + (o.complet ? 'complet' : esc(o.nbOk) + '/' + esc(o.nbTotal)) + '</span></div>'
        + '<div class="ap-actions"><a class="ap-btn sm" href="https://academy.adrienemily.com/parcours/outils/' + enc(o.id) + '?client=' + enc(S.email) + '" target="_blank" rel="noreferrer">Consulter dans l\'Academy ↗</a></div></div>';
    }
    return h + '</div>';
  }

  /* ── Onglet Séances et devoirs ─────────────────────────────────────── */
  function trouverSeance(id) {
    var l = S.seances || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function renderSeances() {
    var h = '', i;
    if (S.seancesErreur) h += '<div class="ap-card"><span class="ap-msg err">' + esc(S.seancesErreur) + '</span></div>';
    var v = S.verdict;
    if (v) {
      h += '<div class="ap-card"><div class="ap-kv" style="margin-top:0">Où en est le cycle</div><div style="font-size:15px">'
        + (v.devoirs === 0 ? 'Aucun devoir n\'a encore été donné.'
          : esc(v.notes) + ' devoir(s) noté(s) sur ' + esc(v.devoirs) + (v.decision ? ' · décision : <b style="color:' + (COULEUR_DECISION[v.decision] || '#1f2340') + '">' + esc(LIB_DECISION[v.decision] || v.decision) + '</b>' : ''))
        + '</div><div style="margin-top:6px;font-size:13px;color:' + (v.peutValider ? '#3d7a34' : '#4b4f6b') + '">' + esc(v.peutValider ? v.consequence : (v.raison + ' — ' + v.consequence)) + '</div>';
      if (!v.outilsPrets && v.manques && v.manques.length) { h += '<ul class="ap-manques">'; for (i = 0; i < v.manques.length; i++) h += '<li>' + esc(v.manques[i]) + '</li>'; h += '</ul>'; }
      if (v.peutValider && S.peutAgir) h += '<div class="ap-actions"><button type="button" class="ap-btn ok" data-ap-tab="etape">Trancher l\'étape →</button></div>';
      h += '</div>';
    }

    var derniere = dernierePassee();
    h += '<div class="ap-card"><div class="ap-row"><div style="flex:1;min-width:220px"><div class="ap-kv" style="margin-top:0">Devoirs pour la prochaine séance</div><div class="ap-muted">'
      + (derniere ? 'Donnés à la séance du ' + esc(dateFr(derniere.date)) + ' — l\'élève les voit dans son espace et coche ce qu\'il a fait.' : 'Aucune séance passée n\'est arrivée dans l\'Academy. Marquez la séance « faite » dans la fiche : elle part avec ses devoirs.')
      + '</div></div>';
    if (derniere && S.peutAgir) {
      h += refSeance(derniere.id)
        ? '<button type="button" class="ap-btn primary" data-ap-devoirs-edit="' + esc(derniere.id) + '">✏️ ' + ((derniere.devoirs || []).length ? 'Modifier les devoirs' : 'Donner des devoirs') + '</button>'
        : '<span class="ap-muted">Séance saisie dans l\'Academy : ses devoirs se modifient là-bas.</span>';
    }
    if (S.hooks.syncAll && S.peutAgir) h += '<button type="button" class="ap-btn sm" data-ap-sync-all title="Renvoie toutes les séances faites de la fiche vers l\'Academy">↻ Resynchroniser la fiche</button>';
    h += '</div><div class="ap-msg" data-ap-msg-sync></div></div>';

    var liste = (S.seances || []).slice().reverse();
    if (!liste.length) h += '<div class="ap-card ap-muted" style="text-align:center;padding:28px">Aucune séance pour l\'instant.</div>';
    for (i = 0; i < liste.length; i++) h += renderSeance(liste[i]);
    return h;
  }

  function renderSeance(s) {
    var ref = refSeance(s.id), i;
    var h = '<div class="ap-card" data-ap-seance="' + esc(s.id) + '"><div class="ap-row">'
      + '<b style="font-size:15px">' + esc(dateFr(s.date)) + '</b>'
      + (s.codeEtape ? '<span class="ap-pill gold">' + esc(s.codeEtape) + '</span>' : '')
      + '<span class="ap-pill ' + (s.source === 'alteor' ? 'ok' : '') + '">' + (s.source === 'alteor' ? 'fiche coaching' : 'saisie dans l\'Academy') + '</span>'
      + '<span class="ap-pill ' + (PILL_STATUT_SEANCE[s.statut] || '') + '">' + esc(LIB_STATUT_SEANCE[s.statut] || s.statut) + '</span>'
      + (s.coach ? '<span class="ap-muted">' + esc(s.coach) + '</span>' : '')
      + '<span style="flex:1"></span>'
      + (s.lienReplay ? '<a class="ap-btn sm" href="' + esc(s.lienReplay) + '" target="_blank" rel="noreferrer">Replay</a>' : '')
      + (s.lienCompteRendu ? '<a class="ap-btn sm" href="' + esc(s.lienCompteRendu) + '" target="_blank" rel="noreferrer">Compte rendu</a>' : '')
      + (S.peutAgir && ref && !(S.editeur && S.editeur.seanceId === s.id) ? '<button type="button" class="ap-btn sm" data-ap-devoirs-edit="' + esc(s.id) + '">✏️ Devoirs</button>' : '')
      + '</div>';
    if (s.resumePartage) h += '<div class="ap-kv">Résumé partagé — l\'élève le lit</div><div class="ap-quote" style="white-space:pre-wrap">' + esc(s.resumePartage) + '</div>';
    if (s.notesInternes) h += '<div class="ap-kv">Notes internes — jamais vues par l\'élève</div><div style="font-size:13px;background:#f7f8fc;padding:8px 12px;border-radius:9px;white-space:pre-wrap">' + esc(s.notesInternes) + '</div>';
    if (S.editeur && S.editeur.seanceId === s.id) h += renderEditeur();
    var ds = s.devoirs || [];
    if (ds.length) {
      var bareme = S.bareme || {};
      h += '<div class="ap-kv">Devoirs — notez ce qui a été fait</div><div class="ap-scroll"><table class="ap-tbl"><thead><tr><th style="min-width:220px">Devoir</th><th style="min-width:150px">Déclaré par l\'élève</th><th style="min-width:80px">Score</th><th style="min-width:200px">Commentaire</th></tr></thead><tbody>';
      for (i = 0; i < ds.length; i++) {
        var d = ds[i], st = d.statut || 'a_faire';
        h += '<tr><td><div>' + esc(d.texte) + '</div><div class="ap-muted" style="font-size:11.5px">'
          + (d.outil ? 'Outil ' + esc(String(d.outil).slice(1)) + ' · ' : '') + (d.echeance ? 'pour le ' + esc(dateFr(d.echeance)) : 'sans échéance') + '</div></td>'
          + '<td><span class="ap-pill ' + (PILL_STATUT_DEVOIR[st] || '') + '">' + esc(LIB_STATUT_DEVOIR[st] || st) + '</span>'
          + (d.motEleve ? '<div class="ap-muted" style="font-size:11.5px;margin-top:3px">« ' + esc(d.motEleve) + ' »</div>' : '') + '</td>';
        if (S.peutAgir) {
          h += '<td><select data-ap-devoir-note data-seance="' + esc(s.id) + '" data-devoir="' + esc(d.id) + '" title="' + esc(bareme[String(d.note)] || '') + '">' + options(['', '0', '1', '2', '3'], d.note || '') + '</select></td>'
            + '<td><input data-ap-devoir-comment data-seance="' + esc(s.id) + '" data-devoir="' + esc(d.id) + '" value="' + esc(d.commentaire || '') + '" placeholder="Ce que vous en retenez"></td>';
        } else {
          h += '<td>' + esc(d.note || '—') + '</td><td>' + esc(d.commentaire || '') + '</td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table></div>';
    } else {
      h += '<div class="ap-muted" style="margin-top:10px">Aucun devoir donné à cette séance.</div>';
    }
    return h + '<div class="ap-msg" data-ap-msg-seance></div></div>';
  }

  /* L'éditeur des devoirs d'une séance venue de la fiche. Il écrit DANS LA
     FICHE (crochet de la page hôte), qui renvoie la séance à l'Academy. */
  function echeanceParDefaut(s) {
    var l = S.seances || [], best = '';
    for (var i = 0; i < l.length; i++) if (s.date && l[i].date && l[i].date > s.date && (!best || l[i].date < best)) best = l[i].date;
    return best;
  }
  function ouvrirEditeur(seanceId) {
    var s = trouverSeance(seanceId);
    if (!s || !S.peutAgir) return;
    var rows = [];
    for (var i = 0; i < (s.devoirs || []).length; i++) rows.push({ texte: s.devoirs[i].texte || '', outil: s.devoirs[i].outil || '', echeance: s.devoirs[i].echeance || '' });
    if (!rows.length) rows.push({ texte: '', outil: '', echeance: echeanceParDefaut(s) });
    S.editeur = { seanceId: seanceId, rows: rows, vu: false };
    render();
  }
  function renderEditeur() {
    var e = S.editeur, outils = (S.etat.outils && S.etat.outils.detail) || [], h, i, k;
    h = '<div class="ap-card" style="border-color:#4f46e5;background:#fbfaff;margin-top:12px" data-ap-editeur>'
      + '<div class="ap-kv" style="margin-top:0">Devoirs donnés pour la prochaine fois</div>'
      + '<div class="ap-muted" style="margin-bottom:10px">Un devoir = une ligne dans la fiche coaching. « Enregistrer » écrit dans la fiche puis renvoie la séance à l\'Academy : ce que l\'élève a déjà coché et vos notes sont conservés.</div>';
    for (i = 0; i < e.rows.length; i++) {
      var r = e.rows[i];
      h += '<div class="ap-devoir-row" data-ap-row="' + i + '">'
        + '<input class="ap-inp" data-ap-f="texte" placeholder="Ce que l\'élève doit faire" value="' + esc(r.texte) + '">'
        + '<select class="ap-inp" data-ap-f="outil"><option value="">Sans outil</option>';
      for (k = 0; k < outils.length; k++) h += '<option value="' + esc(outils[k].id) + '"' + (outils[k].id === r.outil ? ' selected' : '') + '>Outil ' + esc(outils[k].numero) + ' · ' + esc(outils[k].nom) + '</option>';
      h += '</select><input class="ap-inp" type="date" data-ap-f="echeance" value="' + esc(r.echeance) + '" title="Échéance — par défaut la séance suivante">'
        + '<button type="button" class="ap-btn sm" data-ap-devoir-remove="' + i + '">Retirer</button></div>';
    }
    h += '<div class="ap-actions"><button type="button" class="ap-btn sm" data-ap-devoir-add>+ Ajouter un devoir</button><span style="flex:1"></span>'
      + '<button type="button" class="ap-btn" data-ap-devoirs-cancel>Annuler</button>'
      + '<button type="button" class="ap-btn primary" data-ap-devoirs-save>Enregistrer dans la fiche et envoyer</button></div>'
      + '<div class="ap-msg" data-ap-msg-editeur></div></div>';
    return h;
  }
  function editeurLireDom() {
    var ed = q('[data-ap-editeur]');
    if (!ed || !S.editeur) return;
    var rows = ed.querySelectorAll('[data-ap-row]'), out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var g = function (n) { var e = r.querySelector('[data-ap-f="' + n + '"]'); return e ? e.value : ''; };
      out.push({ texte: g('texte'), outil: g('outil'), echeance: g('echeance') });
    }
    S.editeur.rows = out;
    S.editeur.vu = true;
  }
  function sauverDevoirs() {
    editeurLireDom();
    var e = S.editeur, ed = q('[data-ap-editeur]');
    if (!e || !ed) return;
    var rows = [];
    for (var i = 0; i < e.rows.length; i++) if (String(e.rows[i].texte || '').trim().length > 2) rows.push(e.rows[i]);
    var ref = refSeance(e.seanceId);
    if (!ref) { setMsg(ed, '[data-ap-msg-editeur]', 'Cette séance ne vient pas de la fiche : ses devoirs se modifient dans l\'Academy.', false); return; }
    if (typeof S.hooks.saveDevoirs !== 'function') { setMsg(ed, '[data-ap-msg-editeur]', 'Cette page ne sait pas écrire dans la fiche.', false); return; }
    verrouiller(ed, true);
    setMsg(ed, '[data-ap-msg-editeur]', 'Enregistrement dans la fiche, puis envoi à l\'Academy…', true);
    var email = S.email;
    Promise.resolve().then(function () { return S.hooks.saveDevoirs(ref, rows); }).then(function (n) {
      if (!S || S.email !== email) return;
      toast(pluriel(typeof n === 'number' ? n : rows.length, 'devoir') + ' enregistré' + ((typeof n === 'number' ? n : rows.length) > 1 ? 's' : '') + ' dans la fiche');
      S.editeur = null;
      reloadSeances();
      reloadEtat();
    }, function (err) {
      if (!S || S.email !== email) return;
      verrouiller(ed, false);
      setMsg(ed, '[data-ap-msg-editeur]', 'Échec : ' + ((err && err.message) || 'inconnu'), false);
    });
  }
  function noterDevoir(el) {
    if (!S) return;
    var seanceId = el.getAttribute('data-seance'), devoirId = el.getAttribute('data-devoir');
    var charge = { email: S.email, action: 'noter-devoir', seanceId: seanceId, devoirId: devoirId };
    if (el.hasAttribute('data-ap-devoir-note')) charge.note = el.value; else charge.commentaire = el.value;
    var carte = el.closest('[data-ap-seance]');
    el.disabled = true;
    var email = S.email;
    api('/api/academy-seances', charge).then(function (j) {
      if (!S || S.email !== email) return;
      el.disabled = false;
      if (!j || j.ok !== true) { setMsg(carte, '[data-ap-msg-seance]', messageErreur(j), false); return; }
      appliquerSeances(j);
      toast(charge.note !== undefined ? 'Devoir noté' : 'Commentaire enregistré');
      render();
    });
  }
  function syncAll() {
    if (!S || typeof S.hooks.syncAll !== 'function') return;
    var r = root(), b = q('[data-ap-sync-all]', r), zone = q('[data-ap-msg-sync]', r);
    if (b) b.disabled = true;
    if (zone) { zone.textContent = 'Envoi des séances faites de la fiche…'; zone.className = 'ap-msg ok'; }
    var email = S.email;
    Promise.resolve().then(function () { return S.hooks.syncAll(); }).then(function (n) {
      if (!S || S.email !== email) return;
      toast(pluriel(n || 0, 'séance') + ' renvoyée' + ((n || 0) > 1 ? 's' : '') + ' à l\'Academy');
      reloadSeances();
      reloadEtat();
    }, function (err) {
      if (!S || S.email !== email) return;
      if (b) b.disabled = false;
      if (zone) { zone.textContent = 'Échec : ' + ((err && err.message) || 'inconnu'); zone.className = 'ap-msg err'; }
    });
  }

  /* ── Le résumé compact dans la fiche ───────────────────────────────── */
  function cell(l, v) { return '<div class="ap-summary-cell"><div class="kl">' + esc(l) + '</div><div class="kv">' + v + '</div></div>'; }
  function renderSummary(d, sansBouton) {
    var js = d.jalons || [], jc = null, ec = null, i;
    for (i = 0; i < js.length; i++) if (js[i].code === d.jalonCourant) jc = js[i];
    if (!jc) for (i = 0; i < js.length; i++) if (js[i].statut === 'a_venir') { jc = js[i]; break; }
    if (!jc && js.length) jc = js[js.length - 1];
    var es = d.etapes || [];
    for (i = 0; i < es.length; i++) if (es[i].cle === d.etapeCourante) ec = es[i];
    var cells = '';
    if (jc) {
      var sj = STATUT_JALON[jc.statut] || STATUT_JALON.a_venir;
      cells += cell('Jalon en cours', esc(jc.code) + ' · ' + esc(jc.objectif) + '<div class="ap-muted">' + esc(dateFr(jc.dateCible)) + ' · ' + (jc.statut === 'a_venir' && jc.enRetard ? '<span style="color:#c2410c;font-weight:700">en retard</span>' : esc(sj.t)) + '</div>');
    } else cells += cell('Jalon en cours', '<span class="ap-muted">pas de date de signature</span>');
    if (ec) {
      var ee = ETAT_ETAPE[ec.etat] || ETAT_ETAPE.verrouillee;
      cells += cell('Étape en cours', esc(ec.code) + ' · ' + esc(ec.titre) + '<div class="ap-muted"><span style="color:' + ee.c + ';font-weight:700">' + esc(ee.t) + '</span> · ' + esc(d.validees) + '/' + esc(d.total) + ' validées</div>');
    } else cells += cell('Étapes', esc(d.validees) + ' / ' + esc(d.total) + ' validées');
    cells += cell('Outils du dirigeant', esc(d.outils.remplis) + ' / ' + esc(d.outils.total) + ' complets');
    if (d.credits) cells += cell('Séances', esc(d.credits.restantes) + ' restantes sur ' + esc(d.credits.total) + (d.credits.sansTrace ? '<div style="color:#8a6508;font-weight:600">' + esc(d.credits.sansTrace) + ' sans synthèse</div>' : ''));
    return '<div class="ap-summary"><div class="ap-summary-grid">' + cells + '</div><div class="ap-row">'
      + (sansBouton ? '' : '<button type="button" class="ap-btn primary" data-ap-open>🎛 Gérer le parcours</button>')
      + (d.plan && d.plan.recu ? '<span class="ap-pill ok">plan reçu par l\'Academy</span>' : '<span class="ap-pill gold">plan non poussé</span>')
      + (d.peutAgir ? '' : '<span class="ap-muted">lecture seule</span>')
      + '</div></div>';
  }
  function summary(el, opts) {
    if (!el) return;
    injectCss();
    el.setAttribute('data-ap-summary', '1');
    if (!opts || !opts.email) { el._apOpts = null; el.innerHTML = '<span class="ap-muted">🎓 Parcours — pas d\'e-mail sur la fiche, impossible de faire le lien.</span>'; return; }
    el._apOpts = opts;
    el.innerHTML = '<span class="ap-muted">🎓 Parcours — chargement…</span>';
    api('/api/academy-etat', { email: String(opts.email).trim().toLowerCase() }).then(function (j) {
      if (el._apOpts !== opts) return;
      if (!j || j.ok !== true) { el.innerHTML = '<span class="ap-muted">🎓 ' + esc(messageErreur(j)) + '</span>'; return; }
      if (!j.found) { el.innerHTML = '<span class="ap-muted">🎓 Aucun compte Academy pour cet e-mail.</span>'; return; }
      if (j.version !== 'v2_6mois') { el.innerHTML = '<span class="ap-muted">🎓 Ce client suit le programme vidéo, pas le parcours à étapes : rien à piloter ici.</span>'; return; }
      /* La section hôte porte déjà son bouton [data-ap-open] : pas de doublon
         dans le résumé. Sans section hôte, le résumé porte le sien. */
      var scope = el.closest ? el.closest('[data-ap-scope]') : null;
      var autre = scope ? scope.querySelector('[data-ap-open]') : null;
      var sansBouton = !!(autre && !el.contains(autre));
      try { el.innerHTML = renderSummary(j, sansBouton); } catch (e) { el.innerHTML = '<span class="ap-muted">🎓 Résumé indisponible.</span>'; console.error('[academy-parcours] résumé', e); }
    });
  }

  /* ── Délégation unique ─────────────────────────────────────────────── */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var b;

    /* Ouvrir depuis la fiche : le bouton, dans ou à côté du résumé. */
    b = t.closest('[data-ap-open]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var sum = b.closest('[data-ap-summary]');
      if (!sum) { var scope = b.closest('[data-ap-scope]'); sum = scope ? scope.querySelector('[data-ap-summary]') : null; }
      var opts = sum ? sum._apOpts : null;
      if (!opts) { if (sum) sum.innerHTML = '<span class="ap-muted">🎓 Pas d\'e-mail sur la fiche, impossible d\'ouvrir le parcours.</span>'; return; }
      opts.summaryEl = sum;
      open(opts);
      return;
    }

    var ov = root();
    if (!ov || !S || !ov.contains(t)) return;

    b = t.closest('[data-ap-close]'); if (b) { ev.preventDefault(); close(); return; }
    b = t.closest('[data-ap-reload]'); if (b) { ev.preventDefault(); loadAll(); return; }
    b = t.closest('[data-ap-tab]'); if (b) { ev.preventDefault(); S.onglet = b.getAttribute('data-ap-tab'); render(); return; }
    b = t.closest('[data-ap-node]'); if (b) { ev.preventDefault(); S.onglet = 'jalons'; S.jalonForm = b.getAttribute('data-ap-node'); render(); return; }
    b = t.closest('[data-ap-jalon]'); if (b) { ev.preventDefault(); S.jalonForm = b.getAttribute('data-ap-jalon'); render(); var inp = q('[data-ap-cause]'); if (inp) inp.focus(); return; }
    b = t.closest('[data-ap-jalon-cancel]'); if (b) { ev.preventDefault(); S.jalonForm = ''; render(); return; }
    b = t.closest('[data-ap-constat]'); if (b) { ev.preventDefault(); constater(b.getAttribute('data-ap-constat')); return; }
    b = t.closest('[data-ap-etape]'); if (b) { ev.preventDefault(); S.onglet = 'etape'; loadFiche(b.getAttribute('data-ap-etape')); return; }
    b = t.closest('[data-ap-noter]'); if (b) { ev.preventDefault(); noterEtape(false); return; }
    b = t.closest('[data-ap-trancher]'); if (b) { ev.preventDefault(); noterEtape(true); return; }
    b = t.closest('[data-ap-deverrouiller]'); if (b) { ev.preventDefault(); deverrouiller(); return; }
    b = t.closest('[data-ap-devoirs-edit]'); if (b) { ev.preventDefault(); ouvrirEditeur(b.getAttribute('data-ap-devoirs-edit')); return; }
    b = t.closest('[data-ap-devoir-add]'); if (b) { ev.preventDefault(); editeurLireDom(); if (S.editeur) { var s0 = trouverSeance(S.editeur.seanceId); S.editeur.rows.push({ texte: '', outil: '', echeance: s0 ? echeanceParDefaut(s0) : '' }); render(); } return; }
    b = t.closest('[data-ap-devoir-remove]'); if (b) { ev.preventDefault(); editeurLireDom(); if (S.editeur) { S.editeur.rows.splice(Number(b.getAttribute('data-ap-devoir-remove')), 1); render(); } return; }
    b = t.closest('[data-ap-devoirs-cancel]'); if (b) { ev.preventDefault(); S.editeur = null; render(); return; }
    b = t.closest('[data-ap-devoirs-save]'); if (b) { ev.preventDefault(); sauverDevoirs(); return; }
    b = t.closest('[data-ap-sync-all]'); if (b) { ev.preventDefault(); syncAll(); return; }
  });

  /* La décision calculée suit chaque note ; une note de devoir part tout de
     suite (« change » : au blur pour un champ texte, au choix pour une liste). */
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.closest || !S || !root() || !root().contains(t)) return;
    if (t.closest('[data-ap-fiche]')) { afficherDecision(); return; }
    if (t.hasAttribute('data-ap-devoir-note') || t.hasAttribute('data-ap-devoir-comment')) noterDevoir(t);
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && root()) {
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) { a.blur(); return; }
      close();
    }
  });

  window.AcademyParcours = { open: open, close: close, summary: summary, reload: loadAll };
})();
