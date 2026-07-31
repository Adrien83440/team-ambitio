/* ═══════════════════════════════════════════════════════════════════════════
   coaching-plan.js — PLAN D'ACTION ELITE PHÉNIX
   ─────────────────────────────────────────────────────────────────────────
   Génère, édite et exporte le plan d'action d'un client depuis sa fiche
   coaching. Trois temps :

     1. ASSISTANT — 6 cartes qui posent les questions AU MENTOR (pas au
        client). Chaque carte affiche en regard les réponses du
        questionnaire AlteoForms du client, pour répondre sans changer
        d'écran. Rien n'est inventé : un champ vide reste « À compléter ».
     2. PLAN — 4 blocs (Point A→B · Verrou · 6 jalons datés · Actions de
        la semaine). Statuts des jalons et des actions modifiables en un
        clic. Régénérable à tout moment.
        ⚠ Pas de « chantiers » : l'accompagnement n'est plus adossé à des
        modules ni à des vidéos (décision Adrien 31/07). Le plan tient
        dans les jalons et les étapes.
     3. EXPORT PDF — mise en page vectorielle (jsPDF), texte sélectionnable,
        aux couleurs bleues de la maison. Pas de capture d'écran : un
        screenshot en PDF est flou et pèse dix fois plus.

   API :
     CoachingPlan.openWizard(client, { onSave })   → assistant
     CoachingPlan.render(plan, clientId)           → HTML du plan
     CoachingPlan.exportPdf(plan, client)          → télécharge le PDF
     CoachingPlan.emptyPlan()                      → structure vierge

   Dépend de : jsPDF (UMD, chargé par coaching.html) pour l'export seul.
   Le reste fonctionne sans aucune dépendance externe.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Couleurs de la fiche coaching (--blue-*) — répétées en dur ici car le
     PDF ne peut pas lire les variables CSS. */
  var C = {
    main: '#1a3dce', dark: '#0f1f5c', light: '#4f7ef8', ghost: '#f0f4ff',
    ink: '#0b0d17', muted: '#6b7280', line: '#e4e1f7',
    green: '#10b981', orange: '#f59e0b', red: '#ef4444'
  };

  var ORGANISMES = {
    delivrabilite: {
      label: 'DÉLIVRABILITÉ',
      note: 'Les jalons A1 et A2 sont critiques — ne pas avancer sans les avoir atteints.'
    },
    rentabilite: {
      label: 'RENTABILITÉ',
      note: 'Le tableau de bord et le seuil de rentabilité sont la priorité immédiate.'
    },
    acquisition: {
      label: 'ACQUISITION',
      note: 'À n\'activer qu\'une fois la délivrabilité et la rentabilité stabilisées.'
    }
  };

  /* Les 6 jalons du programme — décalages en jours depuis J0. */
  var JALONS = [
    { k: 'A1', j: 10,  obj: 'Identification des tâches + premiers process', preuve: '~30 % de charge allégée' },
    { k: 'A2', j: 20,  obj: 'Recrutement / désignation bras droit',         preuve: 'Dirigeant sorti du cycle de vente' },
    { k: 'A3', j: 45,  obj: 'Sortie de la production',                      preuve: 'Process tenus par l\'équipe sur 1 pôle' },
    { k: 'A4', j: 90,  obj: 'Pilotage par les chiffres',                    preuve: 'Tableau de bord actif, KPI suivis' },
    { k: 'A5', j: 135, obj: 'Marge & trésorerie structurées',               preuve: 'Marge nette en progression' },
    { k: 'B',  j: 180, obj: 'Consolidation',                                preuve: '50 % tâches déléguées, croissance absorbée' }
  ];

  var STATUTS = {
    todo: { ico: '⬜', lbl: 'À venir', col: C.muted },
    wip:  { ico: '🔄', lbl: 'En cours', col: C.light },
    ok:   { ico: '✅', lbl: 'Atteint',  col: C.green },
    ko:   { ico: '⚠️', lbl: 'Manqué',   col: C.red }
  };
  var STATUT_ORDER = ['todo', 'wip', 'ok', 'ko'];

  var TODO = 'À compléter';

  /* ── Utilitaires ───────────────────────────────────────────────────── */
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  /* ⚠ Jamais toISOString() pour une clé de date : décalage de fuseau la
     nuit. Getters locaux uniquement. */
  function toYMD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fromYMD(s) {
    var p = String(s || '').split('-');
    if (p.length !== 3) return null;
    var d = new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function frDate(s) {
    var d = fromYMD(s);
    if (!d) return TODO;
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function val(v) { var s = String(v == null ? '' : v).trim(); return s || TODO; }
  function isTodo(v) { return !String(v == null ? '' : v).trim(); }

  function emptyPlan() {
    return {
      version: 2,
      startDate: toYMD(new Date()),
      coach: '',
      pointA: '', pointB: '',
      verrou: '', organisme: '', synthese: '',
      chiffres: [],             // [{label, valeur}]  repères du dossier
      ditClient: [],            // [{titre, detail}]  ce que le dirigeant a dit
      jalons: {},               // { A1:{titre, focus, actions[]}, … }
      problemes: [],            // [{titre, detail}]
      objectifs: [],            // ['…']
      kpis: [],                 // [{cat, nom, freq, actuel, cible}]
      risques: [],              // [{titre, detail}]
      jalonStatus: {},          // { A1:'todo', … }
      semaines: [],             // [{ n, from, to, coach, focus, actions:[{txt,who,due,st}] }]
      createdAt: null, updatedAt: null, updatedBy: null
    };
  }

  /* Date d'échéance d'un jalon, calculée depuis J0. */
  function jalonDate(plan, j) {
    var d0 = fromYMD(plan.startDate);
    return d0 ? toYMD(addDays(d0, j)) : '';
  }

  /* Semaine 1 = diagnostic initial, identique pour tous (brief Elite Phénix). */
  function semaine1(plan) {
    var d0 = fromYMD(plan.startDate) || new Date();
    return {
      n: 1,
      from: toYMD(d0),
      to: toYMD(addDays(d0, 6)),
      coach: 'Adrien / Emily',
      focus: 'Identifier le verrou principal et l\'organisme bloqué.',
      actions: [
        { txt: 'Collecter tous les chiffres manquants (charges, CA mensuel, marge si dispo)', who: 'Client', due: toYMD(addDays(d0, 3)), st: 'todo' },
        { txt: 'Relever le temps réellement passé sur chaque poste (semaine type)', who: 'Client', due: toYMD(addDays(d0, 5)), st: 'todo' },
        { txt: 'Formaliser le Point A et le Point B par écrit dans la fiche', who: 'Adrien / Emily', due: toYMD(addDays(d0, 7)), st: 'todo' }
      ]
    };
  }

  /* ═════════════════════════════════════════════════════════════════════
     ASSISTANT — 6 cartes
     ═══════════════════════════════════════════════════════════════════ */
  var W = { client: null, plan: null, step: 0, onSave: null, sugg: null, suggState: 'idle' };

  /* ── Propositions à partir du questionnaire ────────────────────────────
     api/coaching-plan-suggest.js lit le questionnaire du client et propose
     Point A / Point B / verrou / organisme. Le mentor n'a plus
     qu'à valider ou corriger : rien n'est écrit sans son passage.
     Silencieux en cas d'échec — l'assistant reste utilisable à la main. */
  function loadSuggestion(force) {
    var id = W.client && (W.client._id || W.client.id);
    if (!id || W.suggState === 'loading') return;
    W.suggState = 'loading';
    paintSuggBar();
    /* Même récupération de jeton que le reste de coaching.html (SDK
       modulaire, window._auth exposé par la page). */
    var getTok = (window._auth && window._auth.currentUser)
      ? window._auth.currentUser.getIdToken()
      : Promise.reject(new Error('non authentifié'));
    getTok.then(function (tok) {
      return fetch('/api/coaching-plan-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({ clientId: id, force: !!force })
      });
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.ok !== true || !j.suggestion) {
        W.suggState = (j && j.error === 'no_questionnaire') ? 'none' : 'error';
        paintSuggBar();
        return;
      }
      W.sugg = j.suggestion;
      W.suggState = 'ready';
      applySuggestion(false);      // ne remplit que les champs vides
      go(W.step);
    }).catch(function (e) {
      console.warn('[plan] suggestion', e && e.message);
      W.suggState = 'error';
      paintSuggBar();
    });
  }

  /* overwrite=false : on ne touche QU'AUX champs vides — une saisie du
     mentor n'est jamais écrasée par une proposition. */
  function applySuggestion(overwrite) {
    var s = W.sugg, p = W.plan;
    if (!s) return;
    ['pointA', 'pointB', 'verrou'].forEach(function (k) {
      if (s[k] && (overwrite || isTodo(p[k]))) p[k] = s[k];
    });
    if (s.organisme && (overwrite || !p.organisme)) p.organisme = s.organisme;
    if (s.synthese && (overwrite || isTodo(p.synthese))) p.synthese = s.synthese;
    ['chiffres', 'ditClient', 'problemes', 'objectifs', 'kpis', 'risques'].forEach(function (k) {
      if ((s[k] || []).length && (overwrite || !(p[k] || []).length)) p[k] = s[k];
    });
    if (s.jalons && Object.keys(s.jalons).length && (overwrite || !Object.keys(p.jalons || {}).length)) {
      p.jalons = s.jalons;
    }
  }

  function paintSuggBar() {
    var el = document.getElementById('cpSugg');
    if (!el) return;
    var msg = {
      loading: '<span class="sp"></span> Lecture du questionnaire et proposition en cours…',
      ready: '✨ Champs pré-remplis à partir du questionnaire — <b>relis et corrige</b>, c\'est une proposition.',
      none: 'Aucun questionnaire pour ce client — saisie manuelle.',
      error: 'Proposition automatique indisponible — saisie manuelle.',
      idle: ''
    }[W.suggState] || '';
    if (!msg) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.className = 'cp-sugg ' + W.suggState;
    el.innerHTML = msg + (W.suggState === 'ready'
      ? ' <button type="button" id="cpReSugg">↻ Reproposer</button>' : '');
    var b = document.getElementById('cpReSugg');
    if (b) b.onclick = function () { collect(); loadSuggestion(true); };
  }

  var STEPS = [
    { key: 'cadrage',   t: 'Cadrage',            ico: '📆', sub: 'Date de démarrage et coach référent — toutes les échéances en découlent.' },
    { key: 'pointA',    t: 'Point A',            ico: '📍', sub: 'La situation aujourd\'hui, en une phrase factuelle et sans jugement.' },
    { key: 'pointB',    t: 'Point B à J180',     ico: '🎯', sub: 'L\'objectif à 6 mois, concret et mesurable.' },
    { key: 'verrou',    t: 'Verrou & organisme', ico: '🔒', sub: 'Le vrai problème, et l\'organisme qu\'il bloque.' },
    { key: 'semaine',   t: 'Semaine 1',          ico: '⚡', sub: 'Le diagnostic initial. 3 actions maximum, chacune avec un responsable et une date.' }
  ];

  function ensureDom() {
    if (document.getElementById('cpBg')) return;
    var css = document.createElement('style');
    css.textContent = [
      '#cpBg{position:fixed;inset:0;background:rgba(11,13,23,.55);backdrop-filter:blur(4px);z-index:99990;display:none;align-items:flex-start;justify-content:center;padding:3vh 16px;overflow-y:auto}',
      '#cpBg.show{display:flex}',
      '.cp{background:#fff;border-radius:18px;width:min(920px,100%);box-shadow:0 30px 90px rgba(15,31,92,.28);overflow:hidden;font-family:inherit;color:' + C.ink + '}',
      '.cp-head{background:linear-gradient(135deg,' + C.main + ',' + C.dark + ');color:#fff;padding:18px 22px}',
      '.cp-head h3{margin:0;font-size:17px;font-weight:800}',
      '.cp-head p{margin:3px 0 0;font-size:12.5px;opacity:.82}',
      '.cp-steps{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap}',
      '.cp-step{font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:999px;background:rgba(255,255,255,.14);color:rgba(255,255,255,.72)}',
      '.cp-step.on{background:#fff;color:' + C.main + '}',
      '.cp-step.done{background:rgba(255,255,255,.3);color:#fff}',
      '.cp-body{display:grid;grid-template-columns:1fr 300px;gap:0;max-height:64vh}',
      '.cp-main{padding:20px 22px;overflow-y:auto}',
      '.cp-aside{background:' + C.ghost + ';border-left:1px solid ' + C.line + ';padding:16px 16px;overflow-y:auto}',
      '.cp-aside h4{margin:0 0 8px;font-size:10.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:' + C.main + '}',
      '.cp-qa{padding:7px 0;border-bottom:1px solid ' + C.line + '}',
      '.cp-qa:last-child{border-bottom:none}',
      '.cp-qa .q{font-size:10.5px;font-weight:700;color:' + C.muted + '}',
      '.cp-qa .a{font-size:12px;color:' + C.ink + ';white-space:pre-wrap;margin-top:1px}',
      '.cp-sugg{font-size:11.5px;line-height:1.5;border-radius:9px;padding:9px 11px;margin-bottom:14px}',
      '.cp-sugg.ready{background:#eef7ee;border:1px solid #bfe3c4;color:#1d6b34}',
      '.cp-sugg.loading{background:' + C.ghost + ';border:1px solid ' + C.line + ';color:' + C.main + '}',
      '.cp-sugg.none,.cp-sugg.error{background:#fdf6e6;border:1px solid #f0dfae;color:#8a6412}',
      '.cp-sugg button{margin-left:6px;border:1px solid currentColor;background:none;color:inherit;border-radius:7px;padding:2px 8px;font-size:10.5px;font-weight:800;cursor:pointer;font-family:inherit}',
      '.cp-sugg .sp{display:inline-block;width:9px;height:9px;border:2px solid ' + C.line + ';border-top-color:' + C.main + ';border-radius:50%;animation:cpspin .7s linear infinite;vertical-align:-1px}',
      '@keyframes cpspin{to{transform:rotate(360deg)}}',
      '.cp-f{margin-bottom:14px}',
      '.cp-f label{display:block;font-size:11px;font-weight:800;letter-spacing:.3px;color:' + C.muted + ';margin-bottom:5px;text-transform:uppercase}',
      '.cp-f input,.cp-f textarea,.cp-f select{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:10px;padding:10px 12px;font-size:13px;font-family:inherit;color:' + C.ink + ';outline:none;background:#fff}',
      '.cp-f input:focus,.cp-f textarea:focus,.cp-f select:focus{border-color:' + C.light + '}',
      '.cp-f textarea{resize:vertical;min-height:62px}',
      '.cp-f .hint{font-size:11px;color:' + C.muted + ';margin-top:4px;line-height:1.45}',
      '.cp-org{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
      '.cp-org button{border:1.5px solid ' + C.line + ';background:#fff;border-radius:11px;padding:11px 8px;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:800;color:' + C.muted + ';transition:all .13s}',
      '.cp-org button.on{border-color:' + C.main + ';background:' + C.ghost + ';color:' + C.main + '}',
      '.cp-act{border:1.5px solid ' + C.line + ';border-radius:11px;padding:11px;margin-bottom:9px}',
      '.cp-act .row{display:grid;grid-template-columns:1fr 130px;gap:8px;margin-top:7px}',
      '.cp-foot{display:flex;align-items:center;gap:9px;padding:14px 22px;border-top:1px solid ' + C.line + ';background:#fbfbfe}',
      '.cp-btn{border:1.5px solid ' + C.line + ';background:#fff;color:' + C.ink + ';border-radius:10px;padding:10px 17px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.cp-btn:hover{border-color:' + C.light + '}',
      '.cp-btn.primary{background:' + C.main + ';border-color:' + C.main + ';color:#fff}',
      '.cp-btn.primary:hover{background:' + C.dark + '}',
      '.cp-btn:disabled{opacity:.5;cursor:not-allowed}',
      '@media(max-width:820px){.cp-body{grid-template-columns:1fr}.cp-aside{display:none}}'
    ].join('\n');
    document.head.appendChild(css);

    var bg = document.createElement('div');
    bg.id = 'cpBg';
    bg.innerHTML =
      '<div class="cp">' +
        '<div class="cp-head">' +
          '<h3 id="cpTitle"></h3><p id="cpSub"></p>' +
          '<div class="cp-steps" id="cpSteps"></div>' +
        '</div>' +
        '<div class="cp-body">' +
          '<div class="cp-main"><div class="cp-sugg" id="cpSugg" style="display:none"></div><div id="cpMain"></div></div>' +
          '<div class="cp-aside" id="cpAside"></div>' +
        '</div>' +
        '<div class="cp-foot">' +
          '<button class="cp-btn" id="cpPrev">← Précédent</button>' +
          '<div style="flex:1"></div>' +
          '<button class="cp-btn" id="cpCancel">Annuler</button>' +
          '<button class="cp-btn primary" id="cpNext">Suivant →</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);

    bg.addEventListener('click', function (e) { if (e.target === bg) closeWizard(); });
    document.getElementById('cpCancel').addEventListener('click', closeWizard);
    document.getElementById('cpPrev').addEventListener('click', function () { collect(); go(W.step - 1); });
    document.getElementById('cpNext').addEventListener('click', function () {
      collect();
      if (W.step < STEPS.length - 1) { go(W.step + 1); return; }
      finish();
    });
  }

  function closeWizard() {
    var bg = document.getElementById('cpBg');
    if (bg) bg.classList.remove('show');
  }

  function openWizard(client, opts) {
    ensureDom();
    opts = opts || {};
    W.client = client || {};
    W.onSave = opts.onSave || null;
    /* Régénérer part du plan existant : on ne perd pas les réponses déjà
       validées par le mentor. */
    W.plan = client && client.planV2
      ? JSON.parse(JSON.stringify(client.planV2))
      : emptyPlan();
    if (!W.plan.coach) W.plan.coach = client && client.coach ? client.coach : '';
    W.step = 0;
    W.sugg = null;
    W.suggState = 'idle';
    go(0);
    document.getElementById('cpBg').classList.add('show');
    /* Proposition automatique dès l'ouverture, uniquement s'il reste des
       champs à remplir — régénérer un plan complet ne relance rien. */
    if (isTodo(W.plan.pointA) || isTodo(W.plan.pointB) || isTodo(W.plan.verrou) || !W.plan.organisme) {
      loadSuggestion(false);
    }
  }

  /* Colonne de droite : le questionnaire du client, toujours sous les yeux. */
  function renderAside() {
    var q = W.client && W.client.questionnaire;
    var el = document.getElementById('cpAside');
    if (!q || !(q.answers || []).length) {
      el.innerHTML = '<h4>Questionnaire client</h4><div style="font-size:12px;color:' + C.muted + '">Aucun questionnaire reçu pour ce client.</div>';
      return;
    }
    var h = '<h4>📋 ' + esc(q.formTitle || 'Questionnaire') + '</h4>';
    (q.answers || []).forEach(function (x) {
      h += '<div class="cp-qa"><div class="q">' + esc(x.q) + '</div><div class="a">' + esc(x.a) + '</div></div>';
    });
    el.innerHTML = h;
  }

  function go(n) {
    W.step = Math.max(0, Math.min(STEPS.length - 1, n));
    var s = STEPS[W.step];
    document.getElementById('cpTitle').textContent = s.ico + '  ' + s.t;
    document.getElementById('cpSub').textContent = s.sub;
    document.getElementById('cpSteps').innerHTML = STEPS.map(function (x, i) {
      return '<span class="cp-step' + (i === W.step ? ' on' : (i < W.step ? ' done' : '')) + '">' + (i + 1) + '. ' + esc(x.t) + '</span>';
    }).join('');
    document.getElementById('cpPrev').disabled = W.step === 0;
    document.getElementById('cpNext').textContent = W.step === STEPS.length - 1 ? '✓ Générer le plan' : 'Suivant →';
    document.getElementById('cpMain').innerHTML = STEP_HTML[s.key]();
    bindStep(s.key);
    renderAside();
    paintSuggBar();
    var sc = document.querySelector('#cpBg .cp-main');
    if (sc) sc.scrollTop = 0;
  }

  function f(label, inner, hint) {
    return '<div class="cp-f"><label>' + label + '</label>' + inner
      + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }

  var STEP_HTML = {
    cadrage: function () {
      var p = W.plan;
      var d0 = fromYMD(p.startDate);
      var apercu = d0
        ? JALONS.map(function (j) { return j.k + ' ' + frDate(jalonDate(p, j.j)); }).join(' · ')
        : '';
      return f('Date de démarrage (J0)', '<input type="date" id="cpStart" value="' + esc(p.startDate || '') + '">',
              apercu ? 'Échéances calculées : ' + esc(apercu) : 'Les 6 jalons sont datés à partir de J0.')
        + f('Coach référent', '<input type="text" id="cpCoach" value="' + esc(p.coach || '') + '" placeholder="Prénom du coach">',
              'La semaine 1 reste menée par Adrien / Emily — le coach prend la main en semaine 2.');
    },
    pointA: function () {
      return f('Point A — la situation aujourd\'hui',
        '<textarea id="cpA" placeholder="Ex : CA de 22K€/mois, trésorerie à 0, la dirigeante est présente sur tous les postes.">' + esc(W.plan.pointA || '') + '</textarea>',
        'Une phrase, au présent, factuelle et sans jugement. Reprends les chiffres du questionnaire — n\'en invente aucun : si une donnée manque, laisse-la de côté.');
    },
    pointB: function () {
      return f('Point B — l\'objectif à J180',
        '<textarea id="cpB" placeholder="Ex : 30K€/mois, marge brute à 30 %, tableau de bord actif, 50 % des tâches déléguées.">' + esc(W.plan.pointB || '') + '</textarea>',
        'Une phrase concrète et mesurable. Ce qui n\'est pas mesurable ne se pilote pas.');
    },
    verrou: function () {
      var p = W.plan;
      var h = f('Verrou principal',
        '<textarea id="cpVerrou" placeholder="Ex : Pas de prévisionnel, aucun suivi de marge — pilotage à l\'instinct depuis 5 ans.">' + esc(p.verrou || '') + '</textarea>',
        'Une phrase qui nomme le vrai problème — pas le symptôme.');
      h += '<div class="cp-f"><label>Organisme bloqué (un seul)</label><div class="cp-org" id="cpOrg">';
      Object.keys(ORGANISMES).forEach(function (k) {
        h += '<button type="button" data-org="' + k + '" class="' + (p.organisme === k ? 'on' : '') + '">' + ORGANISMES[k].label + '</button>';
      });
      h += '</div><div class="hint" id="cpOrgNote">' + (p.organisme ? esc(ORGANISMES[p.organisme].note) : 'Ordre de traitement : Délivrabilité → Rentabilité → Acquisition.') + '</div></div>';
      return h;
    },
    semaine: function () {
      var p = W.plan;
      if (!p.semaines || !p.semaines.length) p.semaines = [semaine1(p)];
      var s = p.semaines[0];
      var h = '<div class="hint" style="margin-bottom:12px;color:' + C.muted + ';font-size:12px">'
        + 'La semaine 1 est le diagnostic initial, mené par Adrien / Emily. Elle est pré-remplie — ajuste si besoin. '
        + 'Les semaines suivantes se saisissent directement dans le plan, après chaque séance.</div>';
      h += f('Point de focus de la séance', '<input type="text" id="cpFocus" value="' + esc(s.focus || '') + '">');
      s.actions.slice(0, 3).forEach(function (a, i) {
        h += '<div class="cp-act">'
          + '<label style="font-size:11px;font-weight:800;color:' + C.muted + ';text-transform:uppercase">Action ' + (i + 1) + '</label>'
          + '<input type="text" data-atxt="' + i + '" value="' + esc(a.txt || '') + '" placeholder="Verbe d\'action + quoi + comment">'
          + '<div class="row"><input type="text" data-awho="' + i + '" value="' + esc(a.who || '') + '" placeholder="Responsable">'
          + '<input type="date" data-adue="' + i + '" value="' + esc(a.due || '') + '"></div></div>';
      });
      h += '<div class="hint">Chaque action commence par un verbe, porte un responsable et une date. Une action sans date n\'existe pas.</div>';
      return h;
    }
  };

  function bindStep(key) {
    if (key === 'cadrage') {
      document.getElementById('cpStart').addEventListener('change', function () {
        W.plan.startDate = this.value;
        /* Les échéances de la semaine 1 suivent J0 tant qu'on est dans
           l'assistant : sinon le diagnostic serait daté d'avant le départ. */
        W.plan.semaines = [semaine1(W.plan)];
        go(W.step);
      });
    }
    if (key === 'verrou') {
      Array.prototype.forEach.call(document.querySelectorAll('#cpOrg button'), function (b) {
        b.addEventListener('click', function () {
          collect();
          W.plan.organisme = b.getAttribute('data-org');
          go(W.step);
        });
      });
    }
  }

  /* Lit l'écran courant dans W.plan — appelé à chaque navigation. */
  function collect() {
    var g = function (id) { var e = document.getElementById(id); return e ? e.value : null; };
    var p = W.plan;
    var v;
    if ((v = g('cpStart')) !== null) p.startDate = v;
    if ((v = g('cpCoach')) !== null) p.coach = v.trim();
    if ((v = g('cpA')) !== null) p.pointA = v.trim();
    if ((v = g('cpB')) !== null) p.pointB = v.trim();
    if ((v = g('cpVerrou')) !== null) p.verrou = v.trim();
    var focus = g('cpFocus');
    if (focus !== null) {
      if (!p.semaines || !p.semaines.length) p.semaines = [semaine1(p)];
      p.semaines[0].focus = focus.trim();
      [0, 1, 2].forEach(function (i) {
        var t = document.querySelector('[data-atxt="' + i + '"]');
        if (!t) return;
        var a = p.semaines[0].actions[i] || (p.semaines[0].actions[i] = { st: 'todo' });
        a.txt = t.value.trim();
        var w = document.querySelector('[data-awho="' + i + '"]');
        var d = document.querySelector('[data-adue="' + i + '"]');
        a.who = w ? w.value.trim() : '';
        a.due = d ? d.value : '';
      });
      p.semaines[0].actions = p.semaines[0].actions.filter(function (a) { return a && a.txt; });
    }
  }

  function finish() {
    var p = W.plan;
    JALONS.forEach(function (j) { if (!p.jalonStatus[j.k]) p.jalonStatus[j.k] = 'todo'; });
    p.updatedAt = new Date().toISOString();
    if (!p.createdAt) p.createdAt = p.updatedAt;
    closeWizard();
    if (typeof W.onSave === 'function') W.onSave(p);
  }

  /* ═════════════════════════════════════════════════════════════════════
     RENDU DU PLAN — 5 blocs, aux couleurs bleues de la maison
     ═══════════════════════════════════════════════════════════════════ */
  /* opts.readonly = vue client (lien public) : mêmes blocs, mais aucun
     statut cliquable et aucune mention interne. Un seul rendu pour les deux
     vues — deux copies auraient fini par diverger. */
  function render(plan, clientId, opts) {
    if (!plan) return '';
    var p = plan, ro = !!(opts && opts.readonly);
    var h = '<div class="cpv">';
    var n = 0;

    /* Synthèse — la phrase qui résume les 6 mois, en tête. */
    if (!isTodo(p.synthese)) {
      h += '<div class="cpv-hero"><div class="k">Ce qu\'on vise en 6 mois</div><div class="v">' + esc(p.synthese) + '</div></div>';
    }

    /* Repères du dossier — les chiffres réels, tels qu\'ils sont. */
    if ((p.chiffres || []).length) {
      h += '<div class="cpv-nums">';
      p.chiffres.forEach(function (c) {
        h += '<div class="cpv-num"><div class="l">' + esc(c.label) + '</div><div class="v">' + esc(c.valeur) + '</div></div>';
      });
      h += '</div>';
    }

    /* Ce que le client nous a dit — montre qu'on l'a écouté, et sert de
       socle factuel à tout ce qui suit. */
    if ((p.ditClient || []).length) {
      h += blocOpen(++n, '💬', 'Ce que vous nous avez dit');
      h += '<div class="cpv-said">';
      p.ditClient.forEach(function (x) {
        h += '<div class="cpv-sd"><div class="t">' + esc(x.titre) + '</div>'
          + (x.detail ? '<div class="d">' + esc(x.detail) + '</div>' : '') + '</div>';
      });
      h += '</div></div>';
    }

    /* BLOC — Point A → Point B */
    h += blocOpen(++n, '📍', 'Point A → Point B');
    h += '<div class="cpv-ab">';
    h += '<div class="cpv-ab-c"><div class="k">Point A — aujourd\'hui</div><div class="v' + (isTodo(p.pointA) ? ' todo' : '') + '">' + esc(val(p.pointA)) + '</div></div>';
    h += '<div class="cpv-arrow">→</div>';
    h += '<div class="cpv-ab-c b"><div class="k">Point B — à 6 mois</div><div class="v' + (isTodo(p.pointB) ? ' todo' : '') + '">' + esc(val(p.pointB)) + '</div></div>';
    h += '</div>';
    if ((p.objectifs || []).length) {
      h += '<div class="cpv-k" style="margin-top:13px">Objectifs</div><ul class="cpv-ul">';
      p.objectifs.forEach(function (o) { h += '<li>' + esc(o) + '</li>'; });
      h += '</ul>';
    }
    h += '</div>';

    /* BLOC — Diagnostic : verrou, organisme, problématiques */
    var org = ORGANISMES[p.organisme];
    h += blocOpen(++n, '🔍', 'Diagnostic');
    h += '<div class="cpv-k">Verrou principal</div><div class="cpv-p' + (isTodo(p.verrou) ? ' todo' : '') + '">' + esc(val(p.verrou)) + '</div>';
    h += '<div class="cpv-k" style="margin-top:13px">Priorité de traitement</div>';
    h += '<div class="cpv-org">' + (org ? esc(org.label) : TODO) + '</div>';
    if ((p.problemes || []).length) {
      h += '<div class="cpv-k" style="margin-top:13px">Ce qui bloque aujourd\'hui</div><div class="cpv-pbs">';
      p.problemes.forEach(function (x) {
        h += '<div class="cpv-pb"><div class="t">' + esc(x.titre) + '</div>'
          + (x.detail ? '<div class="d">' + esc(x.detail) + '</div>' : '') + '</div>';
      });
      h += '</div>';
    }
    h += '<div class="cpv-rule">Ordre de traitement : <b>Délivrabilité → Rentabilité → Acquisition</b>'
      + (org ? '<br>' + esc(org.note) : '') + '</div>';
    h += '</div>';

    /* BLOC — La feuille de route : la route, puis le détail de chaque étape */
    h += blocOpen(++n, '🛣️', 'Votre feuille de route');
    h += roadSvg(p);
    h += '<div class="cpv-steps">';
    JALONS.forEach(function (j) {
      var st = STATUTS[p.jalonStatus && p.jalonStatus[j.k]] || STATUTS.todo;
      var c = (p.jalons || {})[j.k] || {};
      h += '<div class="cpv-step ' + (st === STATUTS.ok ? 'done' : '') + '">';
      h += '<div class="cpv-steph"><span class="b" style="border-color:' + st.col + ';color:' + st.col + '">' + j.k + '</span>'
        + '<span class="t">' + esc(jalonTitre(p, j)) + '</span>'
        + '<span class="dt">' + esc(frDate(jalonDate(p, j.j))) + ' · J+' + j.j + '</span>'
        + (ro
            ? '<span class="cpv-st ro" style="color:' + st.col + '">' + st.ico + ' ' + st.lbl + '</span>'
            : '<button class="cpv-st" data-cp-jalon="' + j.k + '" data-cp-id="' + esc(clientId || '') + '" style="color:' + st.col + '">' + st.ico + ' ' + st.lbl + '</button>')
        + '</div>';
      if (c.focus) h += '<div class="cpv-stepf">' + esc(c.focus) + '</div>';
      if ((c.actions || []).length) {
        h += '<ul class="cpv-ul">';
        c.actions.forEach(function (a) { h += '<li>' + esc(a) + '</li>'; });
        h += '</ul>';
      }
      h += '<div class="cpv-stepp">Preuve attendue : ' + esc(c.preuve || j.preuve) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    h += '<div class="cpv-rule">Une étape manquée → on cherche la cause avant d\'avancer. Jamais un simple report.</div>';
    h += '</div>';

    /* BLOC — Actions de la semaine */
    h += blocOpen(++n, '⚡', 'Actions de la semaine');
    if (!(p.semaines || []).length) h += '<div class="cpv-p todo">' + TODO + '</div>';
    (p.semaines || []).forEach(function (s, si) {
      h += '<div class="cpv-sem"><div class="cpv-semh"><b>Semaine ' + (s.n || si + 1) + '</b>'
        + '<span>du ' + esc(frDate(s.from)) + ' au ' + esc(frDate(s.to)) + '</span>'
        + '<span class="c">' + esc(s.coach || p.coach || TODO) + '</span></div>';
      (s.actions || []).forEach(function (a, ai) {
        var st = STATUTS[a.st] || STATUTS.todo;
        h += '<div class="cpv-act">'
          + (ro
              ? '<span class="cpv-st sq ro" style="color:' + st.col + '">' + st.ico + '</span>'
              : '<button class="cpv-st sq" data-cp-act="' + si + '.' + ai + '" data-cp-id="' + esc(clientId || '') + '" style="color:' + st.col + '">' + st.ico + '</button>')
          + '<div class="x"><div class="t">' + esc(a.txt) + '</div>'
          + '<div class="m">' + esc(a.who || TODO) + ' · échéance ' + esc(frDate(a.due)) + '</div></div></div>';
      });
      if (s.focus) h += '<div class="cpv-focus">Point de focus : ' + esc(s.focus) + '</div>';
      h += '</div>';
    });
    h += '</div>';

    /* BLOC — Indicateurs de pilotage */
    if ((p.kpis || []).length) {
      h += blocOpen(++n, '📊', 'Indicateurs de pilotage');
      h += '<div class="cpv-tw"><table class="cpv-t"><thead><tr><th>Catégorie</th><th>Indicateur</th><th>Suivi</th><th>Aujourd\'hui</th><th>Objectif</th></tr></thead><tbody>';
      p.kpis.forEach(function (k) {
        h += '<tr><td><span class="cpv-cat">' + esc(k.cat) + '</span></td><td>' + esc(k.nom) + '</td>'
          + '<td class="mut">' + esc(k.freq) + '</td><td class="num">' + esc(k.actuel) + '</td>'
          + '<td class="num goal">' + esc(k.cible) + '</td></tr>';
      });
      h += '</tbody></table></div></div>';
    }

    /* BLOC — Points de vigilance */
    if ((p.risques || []).length) {
      h += blocOpen(++n, '⚠️', 'Points de vigilance');
      h += '<div class="cpv-pbs">';
      p.risques.forEach(function (x) {
        h += '<div class="cpv-pb warn"><div class="t">' + esc(x.titre) + '</div>'
          + (x.detail ? '<div class="d">' + esc(x.detail) + '</div>' : '') + '</div>';
      });
      h += '</div></div>';
    }

    h += '</div>';
    return h;
  }

  /* ── La route ────────────────────────────────────────────────────────
     Feuille de route en serpentin : les 6 jalons posés le long d'une route
     qui descend en zigzag. SVG pur (viewBox + width:100%) : net à toutes
     les tailles, et il sort proprement à l'impression — une image matricielle
     baverait. Les positions sont calculées, pas dessinées à la main. */
  function roadSvg(p) {
    var n = JALONS.length;
    var W_ = 300, STEP = 108, TOP = 46, PAD = 58;
    var H = TOP + (n - 1) * STEP + PAD;
    var pts = JALONS.map(function (j, i) {
      return { x: (i % 2 === 0) ? 86 : 214, y: TOP + i * STEP, j: j, i: i };
    });
    /* Tracé : une courbe douce d'un jalon au suivant (S-curve verticale). */
    var d = 'M ' + pts[0].x + ' ' + (pts[0].y - 26);
    pts.forEach(function (pt, i) {
      if (i === 0) { d += ' L ' + pt.x + ' ' + pt.y; return; }
      var prev = pts[i - 1], my = (prev.y + pt.y) / 2;
      d += ' C ' + prev.x + ' ' + my + ', ' + pt.x + ' ' + my + ', ' + pt.x + ' ' + pt.y;
    });
    d += ' L ' + pts[n - 1].x + ' ' + (pts[n - 1].y + 30);

    var h = '<svg class="cpv-road" viewBox="0 0 ' + W_ + ' ' + H + '" role="img" aria-label="Feuille de route en 6 étapes">';
    /* Deux traits superposés = bitume + ligne médiane discontinue. */
    h += '<path d="' + d + '" fill="none" stroke="#dfe4f7" stroke-width="26" stroke-linecap="round"/>';
    h += '<path d="' + d + '" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="9 11" opacity=".9"/>';
    pts.forEach(function (pt) {
      var st = STATUTS[p.jalonStatus && p.jalonStatus[pt.j.k]] || STATUTS.todo;
      var done = st === STATUTS.ok;
      var side = pt.x < 150 ? 1 : -1;                 // texte du côté opposé au virage
      var tx = pt.x + side * 34;
      var anchor = side > 0 ? 'start' : 'end';
      h += '<circle cx="' + pt.x + '" cy="' + pt.y + '" r="19" fill="' + (done ? '#10b981' : '#fff') + '" stroke="' + st.col + '" stroke-width="3"/>';
      h += '<text x="' + pt.x + '" y="' + (pt.y + 5) + '" text-anchor="middle" class="rk" fill="' + (done ? '#fff' : '#0f1f5c') + '">' + esc(pt.j.k) + '</text>';
      h += '<text x="' + tx + '" y="' + (pt.y - 3) + '" text-anchor="' + anchor + '" class="rt">' + esc(jalonTitre(p, pt.j)) + '</text>';
      h += '<text x="' + tx + '" y="' + (pt.y + 12) + '" text-anchor="' + anchor + '" class="rd">' + esc(frDate(jalonDate(p, pt.j.j))) + ' · J+' + pt.j.j + '</text>';
    });
    h += '</svg>';
    return h;
  }

  /* Titre d'un jalon : celui proposé pour CE dossier, sinon le libellé
     générique du programme. */
  function jalonTitre(p, j) {
    var c = (p.jalons || {})[j.k];
    return (c && c.titre) ? c.titre : j.obj;
  }

  function blocOpen(n, ico, titre) {
    return '<details class="cpv-b" open><summary><span class="n">' + n + '</span>' + ico + ' ' + esc(titre) + '</summary><div class="cpv-bb">';
  }

  /* Cycle de statut au clic — todo → wip → ok → ko → todo. */
  function cycle(cur) {
    var i = STATUT_ORDER.indexOf(cur || 'todo');
    return STATUT_ORDER[(i + 1) % STATUT_ORDER.length];
  }

  /* ═════════════════════════════════════════════════════════════════════
     EXPORT PDF — vectoriel, texte sélectionnable
     ═══════════════════════════════════════════════════════════════════ */
  function hex(h) {
    var s = h.replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  function exportPdf(plan, client) {
    var J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!J) { alert('Export PDF indisponible — la librairie jsPDF n\'est pas chargée.'); return; }
    var p = plan || emptyPlan();
    var doc = new J({ unit: 'mm', format: 'a4' });
    var W_ = 210, M = 16, w = W_ - M * 2;
    var y = 0;

    function color(c) { var r = hex(c); doc.setTextColor(r[0], r[1], r[2]); }
    function fill(c) { var r = hex(c); doc.setFillColor(r[0], r[1], r[2]); }
    function draw(c) { var r = hex(c); doc.setDrawColor(r[0], r[1], r[2]); }
    /* Saut de page quand il ne reste plus la place voulue. */
    function need(mm) { if (y + mm > 281) { doc.addPage(); y = M; } }
    function text(s, x, size, style, col, maxw) {
      doc.setFont('helvetica', style || 'normal');
      doc.setFontSize(size);
      color(col || C.ink);
      var lines = doc.splitTextToSize(String(s == null ? '' : s), maxw || w);
      doc.text(lines, x, y);
      y += lines.length * (size * 0.42) + 1.2;
      return lines.length;
    }
    function bloc(n, titre) {
      need(20);
      y += 4;
      fill(C.main); doc.roundedRect(M, y - 4.6, 6.6, 6.6, 1.4, 1.4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); color('#ffffff');
      doc.text(String(n), M + 3.3, y, { align: 'center' });
      doc.setFontSize(12); color(C.dark);
      doc.text(titre, M + 10, y);
      y += 3;
      draw(C.line); doc.setLineWidth(0.3); doc.line(M, y, M + w, y);
      y += 6;
    }

    /* ── En-tête ── */
    fill(C.main); doc.rect(0, 0, W_, 34, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(17); color('#ffffff');
    doc.text('Plan d\'action — Elite Phénix', M, 15);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    var nom = (client && (client.nom || client.name || client.prenom)) || '';
    doc.text(nom + (p.coach ? '   ·   Coach : ' + p.coach : ''), M, 22.5);
    doc.setFontSize(8.5); doc.setTextColor(210, 222, 255);
    doc.text('Démarrage ' + frDate(p.startDate) + '   ·   Horizon J180 : ' + frDate(jalonDate(p, 180)), M, 28.5);
    y = 46;

    /* ── 1. Point A → B ── */
    bloc(1, 'Point A → Point B');
    text('POINT A — AUJOURD\'HUI', M, 8, 'bold', C.muted);
    text(val(p.pointA), M, 10.5, 'normal', isTodo(p.pointA) ? C.muted : C.ink);
    y += 2.5;
    text('POINT B — À J180', M, 8, 'bold', C.muted);
    text(val(p.pointB), M, 10.5, 'normal', isTodo(p.pointB) ? C.muted : C.ink);

    /* ── 2. Verrou ── */
    bloc(2, 'Verrou principal & organisme bloqué');
    text('VERROU IDENTIFIÉ', M, 8, 'bold', C.muted);
    text(val(p.verrou), M, 10.5, 'normal', isTodo(p.verrou) ? C.muted : C.ink);
    y += 2.5;
    var org = ORGANISMES[p.organisme];
    text('ORGANISME BLOQUÉ', M, 8, 'bold', C.muted);
    text(org ? org.label : TODO, M, 13, 'bold', org ? C.main : C.muted);
    y += 1.5;
    text('Ordre de traitement : Délivrabilité → Rentabilité → Acquisition', M, 9, 'italic', C.muted);
    if (org) text(org.note, M, 9, 'italic', C.muted);

    /* ── 3. Jalons ── */
    bloc(3, 'Les 6 jalons datés');
    var cols = [16, 26, 62, 52, 22];
    var xs = [M]; cols.forEach(function (c, i) { xs.push(xs[i] + c); });
    fill(C.ghost); doc.rect(M, y - 4, w, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); color(C.dark);
    ['JALON', 'ÉCHÉANCE', 'OBJECTIF', 'PREUVE ATTENDUE', 'STATUT'].forEach(function (t, i) { doc.text(t, xs[i] + 1.5, y); });
    y += 5.5;
    JALONS.forEach(function (j) {
      need(13);
      var st = STATUTS[p.jalonStatus && p.jalonStatus[j.k]] || STATUTS.todo;
      doc.setFontSize(8.6);
      var oL = doc.splitTextToSize(j.obj, cols[2] - 3);
      var pL = doc.splitTextToSize(j.preuve, cols[3] - 3);
      var rows = Math.max(oL.length, pL.length);
      doc.setFont('helvetica', 'bold'); color(C.main); doc.text(j.k, xs[0] + 1.5, y);
      doc.setFont('helvetica', 'normal'); color(C.ink);
      doc.text(frDate(jalonDate(p, j.j)), xs[1] + 1.5, y);
      doc.setFontSize(6.8); color(C.muted); doc.text('J+' + j.j, xs[1] + 1.5, y + 3.4);
      doc.setFontSize(8.6); color(C.ink); doc.text(oL, xs[2] + 1.5, y);
      color(C.muted); doc.text(pL, xs[3] + 1.5, y);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); color(st.col);
      doc.text(st.lbl, xs[4] + 1.5, y);
      y += Math.max(rows * 3.7, 5.6) + 2.6;
      draw(C.line); doc.setLineWidth(0.15); doc.line(M, y - 1.4, M + w, y - 1.4);
    });
    y += 1.5;
    text('Un jalon manqué → analyse de cause avant de continuer. Jamais un simple report.', M, 8.4, 'italic', C.muted);

    /* ── 4. Actions ── */
    bloc(4, 'Actions de la semaine');
    (p.semaines || []).forEach(function (s, si) {
      need(20);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); color(C.dark);
      doc.text('Semaine ' + (s.n || si + 1) + '  ·  du ' + frDate(s.from) + ' au ' + frDate(s.to), M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.6); color(C.muted);
      doc.text(s.coach || p.coach || '', M + w, y, { align: 'right' });
      y += 6;
      (s.actions || []).forEach(function (a) {
        need(13);
        var st = STATUTS[a.st] || STATUTS.todo;
        draw(st.col); doc.setLineWidth(0.9); doc.line(M, y - 3.2, M, y + 4.4);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.6); color(C.ink);
        var l = doc.splitTextToSize(a.txt || '', w - 6);
        doc.text(l, M + 4, y);
        y += l.length * 4 + 0.6;
        doc.setFontSize(8); color(C.muted);
        doc.text((a.who || TODO) + '  ·  échéance ' + frDate(a.due) + '  ·  ' + st.lbl, M + 4, y);
        y += 6.5;
      });
      if (s.focus) {
        need(10);
        fill(C.ghost); doc.roundedRect(M, y - 3.6, w, 8, 1.4, 1.4, 'F');
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8.8); color(C.dark);
        doc.text(doc.splitTextToSize('Point de focus : ' + s.focus, w - 6), M + 3, y + 1);
        y += 11;
      }
    });

    /* ── Pied de page sur chaque page ── */
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      draw(C.line); doc.setLineWidth(0.2); doc.line(M, 287, M + w, 287);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.4); color(C.muted);
      doc.text('AmbitioCorp — Elite Phénix' + (nom ? '  ·  ' + nom : ''), M, 291.5);
      doc.text(i + ' / ' + n, M + w, 291.5, { align: 'right' });
    }

    var slug = String(nom || 'client').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    doc.save('plan-action-' + (slug || 'client') + '-' + toYMD(new Date()) + '.pdf');
  }

  window.CoachingPlan = {
    openWizard: openWizard,
    render: render,
    exportPdf: exportPdf,
    emptyPlan: emptyPlan,
    cycleStatus: cycle,
    JALONS: JALONS,
    ORGANISMES: ORGANISMES,
    STATUTS: STATUTS
  };
})();
