/* ═══════════════════════════════════════════════════════════════════════════
   coaching-plan.js — PLAN D'ACTION ELITE PHÉNIX
   ─────────────────────────────────────────────────────────────────────────
   Génère, édite et exporte le plan d'action d'un client depuis sa fiche
   coaching. Quatre temps :

     1. ASSISTANT — 5 étapes qui posent les questions AU MENTOR (pas au
        client). Chaque étape affiche en regard les réponses du questionnaire
        AlteoForms, pour répondre sans changer d'écran, et porte une case
        « Infos collectées » pour ce que le mentor sait d'ailleurs. Un micro
        dicte dans n'importe quel champ ; le panneau vocal permet de raconter
        la séance et de laisser l'IA remplir.
        Rien n'est inventé : un champ vide reste « À compléter ».
     2. PLAN — Point A→B · Diagnostic · 6 étapes datées · Actions de la
        semaine · Indicateurs · Vigilance. Statuts modifiables en un clic.
        ⚠ Pas de « chantiers » : l'accompagnement n'est plus adossé à des
        modules ni à des vidéos (décision Adrien 31/07). Le plan tient
        dans les jalons et les étapes.
     3. ÉDITION — deux chemins. À la main (openEditor : tout le plan, champ
        par champ, y compris le décalage en jours de chaque étape et l'ajout
        de semaines) ou en langage naturel (revise : on décrit le changement,
        le serveur renvoie le plan corrigé sans toucher au reste).
     4. EXPORT PDF — mise en page vectorielle (jsPDF), texte sélectionnable,
        aux couleurs bleues de la maison. Pas de capture d'écran : un
        screenshot en PDF est flou et pèse dix fois plus.

   API :
     CoachingPlan.openWizard(client, { onSave })   → assistant
     CoachingPlan.openEditor(client, { onSave })   → édition manuelle
     CoachingPlan.revise(clientId, plan, instr)    → retouche IA (Promise)
     CoachingPlan.render(plan, clientId, opts)     → HTML du plan
     CoachingPlan.exportPdf(plan, client)          → télécharge le PDF
     CoachingPlan.emptyPlan() / normalize(plan)    → structure du plan
     CoachingPlan.voiceSupported() / stopVoice()   → dictée

   Dépend de : jsPDF (UMD, chargé par coaching.html) pour l'export seul.
   Le reste fonctionne sans aucune dépendance externe — la dictée utilise
   la reconnaissance vocale native du navigateur (absente de Firefox).
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

  /* ═══════════════════════════════════════════════════════════════════
     LES 5 MILESTONES — référentiel du parcours 6 mois
     ───────────────────────────────────────────────────────────────────
     Repris mot pour mot du document « Elite Phénix — parcours 6 mois,
     version 2.0 du 31/07/2026 », qui remplace la version 9 mois.

     ⚠ Les échéances sont des MOYENNES CONSTATÉES, pas des délais dus. Le
     document est explicite : « Ce qui compte n'est pas la date, c'est qu'un
     milestone soit validé avant d'ouvrir le suivant. » Elles sont donc
     affichées en second plan, jamais comme un engagement.

     ⚠ L'ORDRE N'EST PAS NÉGOCIABLE — « on ne délègue pas dans une
     organisation dont personne ne connaît la direction ». Ce qui varie
     d'un dirigeant à l'autre, c'est la PROFONDEUR donnée à chaque
     milestone (champ « renforces » du plan), jamais leur ordre.

     Les notes marquées « ne pas présenter au client » du document ne
     figurent PAS ici : ce référentiel alimente aussi le lien client. */
  var MILESTONES = [
    { k: 'M1', j: 30,  periode: 'Mois 1',
      obj: 'Libérer le temps du dirigeant',
      objectif: 'Récupérer des heures dès le premier mois, sans rien casser, pour avoir de quoi travailler sur son entreprise au lieu de dedans.',
      livrable: 'Outil 01 — Audit du temps complété, plan de sortie 30 jours daté et attribué.',
      preuve: 'Un relevé chiffré de la semaine, une décision écrite sur chaque tâche, et les premières heures effectivement sorties : le comparatif de la semaine 5 avec la semaine 1, sur la même grille, le montre.' },
    { k: 'M2', j: 60,  periode: 'Mois 2',
      obj: 'Poser le cap et le cadre : vision, valeurs, organisation',
      objectif: 'Décider où va l\'entreprise et quel est le rôle du dirigeant dedans, puis donner à chaque poste un périmètre, un standard et des indicateurs.',
      livrable: 'Document de vision et de valeurs diffusé à l\'équipe. Outil 04 — Organigramme cible et fiches de poste signées.',
      preuve: 'L\'équipe peut redire où va l\'entreprise et ce qui ne se négocie pas. Chaque poste a une fiche signée avec au moins deux indicateurs, et le rituel hebdomadaire tient quatre semaines sans relance du dirigeant.' },
    { k: 'M3', j: 120, periode: 'Mois 3 et 4',
      obj: 'Déléguer pour de bon, et faire en sorte que cela rapporte',
      objectif: 'Transférer cinq à huit responsabilités qui ne reviennent pas, et s\'assurer que ce qui est vendu rapporte avant d\'en vendre davantage.',
      livrable: 'Outil 02 — Matrice de délégation avec taux de conformité. Outil 05 — Trame de brief en usage. Outil 03 — Marge par offre et par client. Grille tarifaire arrêtée.',
      preuve: 'Cinq responsabilités au moins au statut conforme, un taux de conformité supérieur à 70 % et deux reprises maximum du dirigeant. Chaque offre a un prix justifié par sa marge par heure.' },
    { k: 'M4', j: 150, periode: 'Mois 5',
      obj: 'Piloter par les chiffres et installer votre relais',
      objectif: 'Remplacer la présence du dirigeant par un tableau de bord, et sa disponibilité permanente par quelqu\'un qui absorbe le quotidien.',
      livrable: 'Outil 03 — Charges arbitrées et plan de trésorerie tenu. Outil 06 — Tableau de bord alimenté quatre semaines de suite par l\'équipe. Kit recrutement complété.',
      preuve: 'L\'entreprise se lit en moins de quinze minutes par semaine sans reconstituer les chiffres, la visibilité cash est à trois mois, le relais est en poste, et une semaine complète passe sans arbitrage du dirigeant.' },
    { k: 'M5', j: 180, periode: 'Mois 6',
      obj: 'L\'entreprise tourne sans vous, et la croissance peut repartir',
      objectif: 'Prouver que l\'entreprise tient en l\'absence du dirigeant, industrialiser ce qui repose encore sur des personnes, puis ouvrir l\'acquisition sur une structure capable de l\'absorber.',
      livrable: 'Protocole de test d\'absence débriefé. Parcours client documenté. Blueprint de duplication et plan douze mois, validés en séance.',
      preuve: 'Dix jours d\'absence, chiffre d\'affaires du mois tenu, aucune décision bloquée en attente du dirigeant.' }
  ];

  /* Les 6 jalons de l'ancienne trame. Conservés UNIQUEMENT pour continuer
     d'afficher les plans validés avant le passage aux milestones : on ne
     réécrit pas derrière le dos du coach un plan qu'il a déjà remis au
     client. Aucun plan neuf ne les utilise. */
  var JALONS_LEGACY = [
    { k: 'A1', j: 10,  obj: 'Identification des tâches + premiers process', preuve: '~30 % de charge allégée' },
    { k: 'A2', j: 20,  obj: 'Recrutement / désignation bras droit',         preuve: 'Dirigeant sorti du cycle de vente' },
    { k: 'A3', j: 45,  obj: 'Sortie de la production',                      preuve: 'Process tenus par l\'équipe sur 1 pôle' },
    { k: 'A4', j: 90,  obj: 'Pilotage par les chiffres',                    preuve: 'Tableau de bord actif, KPI suivis' },
    { k: 'A5', j: 135, obj: 'Marge & trésorerie structurées',               preuve: 'Marge nette en progression' },
    { k: 'B',  j: 180, obj: 'Consolidation',                                preuve: '50 % tâches déléguées, croissance absorbée' }
  ];

  /* Un plan porte-t-il l'ancienne trame ? On regarde ce qui est RÉELLEMENT
     rempli, pas la version déclarée : un plan peut avoir été créé en v2 puis
     retouché. Les clés M gagnent dès qu'elles apparaissent. */
  function estLegacy(p) {
    var j = (p && p.jalons) || {}, s = (p && p.jalonStatus) || {};
    var aDesM = MILESTONES.some(function (m) { return j[m.k] || s[m.k]; });
    if (aDesM) return false;
    return JALONS_LEGACY.some(function (x) { return j[x.k] || s[x.k]; });
  }

  /* Les étapes d'UN plan donné. Tout le rendu passe par là. */
  function etapes(p) { return estLegacy(p) ? JALONS_LEGACY : MILESTONES; }

  /* Compat : l'ancien nom reste exporté et pointe sur le référentiel courant. */
  var JALONS = MILESTONES;

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

  /* ═════════════════════════════════════════════════════════════════════
     MODE VOCAL — dictée dans n'importe quel champ
     ─────────────────────────────────────────────────────────────────────
     Reconnaissance vocale NATIVE du navigateur (SpeechRecognition), en
     français. Aucun upload, aucune clé, aucun coût, aucune donnée client qui
     part chez un tiers : le texte est produit sur la machine du mentor.
     Non supporté par Firefox → on le dit clairement plutôt que d'afficher un
     bouton mort.

     Un seul micro actif à la fois : deux dictées simultanées se voleraient le
     flux audio et rempliraient le mauvais champ.
     ═══════════════════════════════════════════════════════════════════ */
  var VOX = {
    rec: null, target: null, btn: null, base: '', keep: false,

    supported: function () {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },

    paint: function (on) {
      if (!this.btn) return;
      if (on) this.btn.classList.add('on'); else this.btn.classList.remove('on');
      this.btn.textContent = on ? '⏹' : '🎤';
      this.btn.title = on ? 'Arrêter la dictée' : 'Dicter (français)';
    },

    stop: function () {
      this.keep = false;
      if (this.rec) { try { this.rec.stop(); } catch (e) { /* déjà arrêtée */ } }
    },

    toggle: function (el, btn) {
      var self = this;
      if (!el) return;
      /* Re-clic sur le même micro = on arrête. Clic sur un autre = on bascule. */
      if (this.rec && this.target === el) { this.stop(); return; }
      if (this.rec) this.stop();

      var Reco = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Reco) {
        alert('La dictée vocale n\'est pas disponible dans ce navigateur.\n\nUtilise Chrome, Edge ou Safari — la saisie au clavier reste possible partout.');
        return;
      }
      var rec;
      try { rec = new Reco(); }
      catch (e) {
        console.error('[plan] dictée indisponible', e);
        alert('Impossible de démarrer la dictée : ' + (e && e.message ? e.message : 'micro indisponible'));
        return;
      }
      rec.lang = 'fr-FR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      this.rec = rec; this.target = el; this.btn = btn || null; this.keep = true;
      /* On repart de ce qui est déjà écrit : la dictée complète, elle n'efface
         jamais une saisie au clavier. */
      this.base = el.value ? (String(el.value).replace(/\s+$/, '') + ' ') : '';
      this.paint(true);

      rec.onresult = function (ev) {
        var fin = '', interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) fin += t; else interim += t;
        }
        if (fin.trim()) self.base = self.base + fin.trim() + ' ';
        el.value = self.base + interim;
        if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* vieux navigateur */ }
      };

      rec.onerror = function (ev) {
        var code = ev && ev.error;
        console.warn('[plan] dictée', code);
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          self.keep = false;
          alert('Le micro est bloqué pour ce site.\n\nAutorise-le dans la barre d\'adresse (icône 🎤), puis réessaie.');
        }
        /* « no-speech » et « aborted » sont normaux : onend relancera. */
      };

      rec.onend = function () {
        /* Chrome coupe tout seul après quelques secondes de silence. Tant que
           le mentor n'a pas cliqué sur stop, on relance : il parle à son
           rythme, pas à celui du navigateur. */
        if (self.keep) {
          try { rec.start(); return; } catch (e) { /* relance impossible → on ferme proprement */ }
        }
        el.value = self.base.replace(/\s+$/, '');
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* idem */ }
        self.paint(false);
        self.rec = null; self.target = null; self.btn = null;
      };

      try { rec.start(); }
      catch (e) {
        console.error('[plan] démarrage dictée', e);
        this.keep = false; this.paint(false); this.rec = null; this.target = null; this.btn = null;
        alert('Impossible de démarrer la dictée : ' + (e && e.message ? e.message : 'micro occupé'));
      }
    }
  };

  /* ═════════════════════════════════════════════════════════════════════
     BROUILLON LOCAL — ne jamais tout recommencer
     ─────────────────────────────────────────────────────────────────────
     Un assistant qui se ferme par mégarde (clic à côté, onglet fermé, coup
     de fil au mauvais moment) faisait perdre toute la saisie. Le brouillon
     est écrit dans le navigateur à chaque frappe, avec un temps mort : coût
     nul, aucune écriture Firestore parasite, aucune latence.

     ⚠ Ce n'est PAS une sauvegarde. Le plan n'existe pour de bon qu'après
     « Générer le plan » ou « Enregistrer » — le brouillon est un filet, et
     il est local à ce navigateur.
     ═══════════════════════════════════════════════════════════════════ */
  var DRAFT_TTL = 7 * 24 * 3600 * 1000;   // au-delà, c'est un oubli, pas un brouillon

  function draftKey(kind, clientId) { return 'cp.brouillon.' + kind + '.' + (clientId || '?'); }

  function draftSave(kind, clientId, plan) {
    if (!clientId) return;
    try {
      localStorage.setItem(draftKey(kind, clientId), JSON.stringify({ at: Date.now(), plan: plan }));
    } catch (e) {
      /* Quota plein ou navigation privée : on le dit, on ne bloque rien. */
      console.warn('[plan] brouillon non enregistré :', e && e.message);
    }
  }

  function draftLoad(kind, clientId) {
    if (!clientId) return null;
    try {
      var raw = localStorage.getItem(draftKey(kind, clientId));
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.plan || typeof d.plan !== 'object') return null;
      if (Date.now() - (d.at || 0) > DRAFT_TTL) { draftClear(kind, clientId); return null; }
      return d;
    } catch (e) { return null; }
  }

  function draftClear(kind, clientId) {
    if (!clientId) return;
    try { localStorage.removeItem(draftKey(kind, clientId)); } catch (e) { /* rien à faire */ }
  }

  function draftQuand(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' à ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* Un brouillon ne reprend la main que s'il est POSTÉRIEUR au plan
     enregistré : sinon on ressusciterait une saisie déjà remplacée. */
  function draftPlusRecent(d, planEnregistre) {
    if (!d) return false;
    var maj = planEnregistre && planEnregistre.updatedAt ? Date.parse(planEnregistre.updatedAt) : 0;
    if (isNaN(maj)) maj = 0;
    return (d.at || 0) > maj;
  }

  function clientIdDe(client) {
    return client ? (client._id || client.id || '') : '';
  }

  /* Bouton micro rattaché à un champ par son id. Délégation d'événement plus
     bas : les formulaires sont ré-rendus en permanence, un listener par bouton
     ne survivrait pas. */
  function mic(id, label) {
    return '<button type="button" class="cp-mic" data-mic="' + esc(id) + '"'
      + ' title="Dicter (français)" aria-label="Dicter">' + (label || '🎤') + '</button>';
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-mic]') : null;
    if (!b) return;
    e.preventDefault();
    VOX.toggle(document.getElementById(b.getAttribute('data-mic')), b);
  });

  /* ── Styles communs (micro + compléments du plan affiché) ──────────────
     Posés au chargement du module, donc valables sur la fiche coach ET sur
     la page client, sans dupliquer une ligne de CSS dans les deux pages. */
  function ensureViewCss() {
    if (document.getElementById('cpViewCss')) return;
    var s = document.createElement('style');
    s.id = 'cpViewCss';
    s.textContent = [
      '.cp-mic{border:1.5px solid ' + C.line + ';background:#fff;color:' + C.main + ';border-radius:999px;width:26px;height:26px;line-height:1;padding:0;font-size:12px;cursor:pointer;font-family:inherit;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;transition:all .12s}',
      '.cp-mic:hover{border-color:' + C.light + ';background:' + C.ghost + '}',
      '.cp-mic.on{background:' + C.red + ';border-color:' + C.red + ';color:#fff;animation:cpmic 1.15s ease-in-out infinite}',
      '@keyframes cpmic{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 7px rgba(239,68,68,0)}}',
      '.cp-mic.big{width:auto;height:auto;border-radius:10px;padding:9px 15px;font-size:12.5px;font-weight:700;gap:6px}',

      /* Bandeau d'avancement en tête de la feuille de route. */
      '.cpv2-prog{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin:0 0 13px;padding:10px 13px;border:1px solid ' + C.line + ';border-radius:12px;background:#fff}',
      '.cpv2-prog .lb{font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:' + C.muted + '}',
      '.cpv2-prog .tr{flex:1;min-width:110px;height:8px;border-radius:999px;background:#eef1fb;overflow:hidden}',
      '.cpv2-prog .fi{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,' + C.light + ',' + C.green + ')}',
      '.cpv2-prog .vv{font-size:12px;font-weight:800;color:' + C.dark + ';font-variant-numeric:tabular-nums;white-space:nowrap}',

      /* Barre de retouche IA (fiche coach uniquement — jamais côté client). */
      '.cpv2-ai{border:1.5px solid ' + C.line + ';border-radius:12px;background:' + C.ghost + ';padding:11px 13px;margin-bottom:12px}',
      '.cpv2-ai-h{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.main + ';margin-bottom:8px}',
      '.cpv2-ai textarea{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5;font-family:inherit;color:' + C.ink + ';background:#fff;outline:none;resize:vertical;min-height:58px}',
      '.cpv2-ai textarea:focus{border-color:' + C.light + '}',
      '.cpv2-ai-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}',
      '.cpv2-ai-n{font-size:10.5px;color:' + C.muted + ';line-height:1.5;margin-top:7px}',
      '.cpv2-btn{border:1.5px solid ' + C.main + ';background:' + C.main + ';color:#fff;border-radius:10px;padding:9px 15px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.cpv2-btn:hover{background:' + C.dark + ';border-color:' + C.dark + '}',
      '.cpv2-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.cpv2-btn.ghost{background:#fff;color:' + C.ink + ';border-color:' + C.line + '}',
      '.cpv2-btn.ghost:hover{border-color:' + C.light + ';background:' + C.ghost + '}',
      '.cpv2-spin{display:inline-block;width:11px;height:11px;border:2px solid ' + C.line + ';border-top-color:' + C.main + ';border-radius:50%;animation:cpspin2 .7s linear infinite;vertical-align:-1px;margin-right:5px}',
      '@keyframes cpspin2{to{transform:rotate(360deg)}}',

      /* Compteur d'actions faites, en tête de chaque semaine. */
      '.cpv2-cnt{font-size:10.5px;font-weight:800;color:' + C.main + ';background:' + C.ghost + ';border-radius:999px;padding:2px 9px;white-space:nowrap}',

      /* Ordre de traitement : trois pastilles numérotées. */
      '.cpv2-ordre{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:2px 0 4px}',
      '.cpv2-ordre .cpv-org{display:inline-flex;align-items:center;gap:7px;margin:0}',
      '.cpv2-ordre .cpv-org b{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:rgba(255,255,255,.28);font-size:10px}',
      '.cpv2-ordre .cpv-org:nth-child(2){background:' + C.light + '}',
      '.cpv2-ordre .cpv-org:nth-child(3){background:#9aa8d8}',

      /* Milestone renforcé pour ce dossier. */
      '.cpv2-renf{display:inline-block;margin-left:7px;font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#8a5a08;background:#fff8ec;border:1px solid #f3dcc3;border-radius:999px;padding:1px 8px;vertical-align:1px}',

      /* Livrable de contrôle du milestone. */
      '.cpv-stepl{font-size:11.5px;line-height:1.5;color:' + C.dark + ';background:' + C.ghost + ';border-radius:8px;padding:7px 10px;margin-top:8px}',

      /* Les deux repères longs — discrets par construction. */
      '.cpv2-horizon{display:flex;gap:18px;flex-wrap:wrap;margin-top:13px;padding-top:11px;border-top:1px dashed ' + C.line + '}',
      '.cpv2-horizon div{font-size:11.5px;color:' + C.muted + ';line-height:1.5;flex:1;min-width:180px}',
      '.cpv2-horizon span{display:block;font-size:9.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:' + C.light + ';margin-bottom:2px}'
    ].join('\n');
    document.head.appendChild(s);
  }
  ensureViewCss();

  function emptyPlan() {
    return {
      version: 4,
      startDate: toYMD(new Date()),
      coach: '',
      resume72h: '',            // le compte rendu du call des 72 h — la matière de base
      pointA: '', pointB: '',
      verrou: '',               // LE blocage à lever en premier
      verrouPlan: '',           // ce qu'on va faire pour le lever — jamais de durée ici
      horizon12: '',            // où l'entreprise doit être dans 12 mois
      horizon36: '',            // et dans 3 ans — deux repères discrets, pas des objectifs
      organisme: '', synthese: '',
      chiffres: [],             // [{label, valeur}]  repères du dossier
      ditClient: [],            // [{titre, detail}]  ce que le dirigeant a dit
      jalons: {},               // { A1:{titre, focus, actions[], preuve, j}, … }
      problemes: [],            // [{titre, detail}]
      objectifs: [],            // ['…']
      kpis: [],                 // [{cat, nom, freq, actuel, cible}]
      risques: [],              // [{titre, detail}]
      jalonStatus: {},          // { A1:'todo', … }
      semaines: [],             // [{ n, from, to, coach, focus, actions:[{txt,who,due,st}] }]
      collecte: {},             // { cadrage:'…', pointA:'…', … } infos relevées par le mentor
      vocal: '',                // dictée libre de la séance (mode vocal)
      historique: [],           // [{at, by, instruction}] retouches demandées à l'IA
      createdAt: null, updatedAt: null, updatedBy: null
    };
  }

  /* Un plan d'avant la v3 n'a ni collecte, ni vocal, ni historique : on les
     pose à l'ouverture plutôt que de tester partout ailleurs. Additif — aucune
     donnée existante n'est touchée. */
  function normalize(p) {
    if (!p || typeof p !== 'object') return emptyPlan();
    /* Champs apparus avec la trame « milestones » : posés à l'ouverture plutôt
       que testés partout ailleurs. Un plan d'avant continue de s'afficher. */
    ['resume72h', 'verrouPlan', 'horizon12', 'horizon36', 'prioriteNote'].forEach(function (k) {
      if (typeof p[k] !== 'string') p[k] = '';
    });
    if (!Array.isArray(p.renforces)) p.renforces = [];
    if (!Array.isArray(p.organismes)) {
      /* Reprise de l'ancien champ « un seul organisme » : on ne perd pas le
         choix déjà fait par le coach. */
      p.organismes = p.organisme ? [p.organisme] : [];
    }
    if (!p.organisme && p.organismes.length) p.organisme = p.organismes[0];
    if (!p.collecte || typeof p.collecte !== 'object') p.collecte = {};
    if (typeof p.vocal !== 'string') p.vocal = '';
    if (!Array.isArray(p.historique)) p.historique = [];
    if (!p.jalons || typeof p.jalons !== 'object') p.jalons = {};
    if (!p.jalonStatus || typeof p.jalonStatus !== 'object') p.jalonStatus = {};
    if (!Array.isArray(p.semaines)) p.semaines = [];
    ['chiffres', 'ditClient', 'problemes', 'objectifs', 'kpis', 'risques'].forEach(function (k) {
      if (!Array.isArray(p[k])) p[k] = [];
    });
    return p;
  }

  /* Date d'échéance d'un jalon, calculée depuis J0. */
  function jalonDate(plan, j) {
    var d0 = fromYMD(plan.startDate);
    return d0 ? toYMD(addDays(d0, j)) : '';
  }

  /* Décalage en jours d'un jalon : celui saisi pour CE dossier s'il existe,
     sinon celui du programme. ⚠ 0 est une valeur légitime (« dès J0 ») → on
     teste le type, jamais la vérité de la valeur. */
  function jOf(p, j) {
    var c = (p.jalons || {})[j.k];
    var v = c ? c.j : null;
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : j.j;
  }

  /* Preuve attendue : celle écrite pour ce dossier, sinon celle du programme. */
  function jalonPreuve(p, j) {
    var c = (p.jalons || {})[j.k];
    return (c && String(c.preuve || '').trim()) ? String(c.preuve).trim() : j.preuve;
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
  function loadSuggestion(force, overwrite) {
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
        body: JSON.stringify({ clientId: id, force: !!force, notes: notesText() })
      });
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.ok !== true || !j.suggestion) {
        var err = j && j.error;
        W.suggState = err === 'no_questionnaire' ? 'none' : (err === 'ai_refused' ? 'refused' : 'error');
        paintSuggBar();
        return;
      }
      W.sugg = j.suggestion;
      W.suggState = 'ready';
      /* overwrite : le mentor vient explicitement de demander « remplis les
         champs » depuis le mode vocal — sa dictée fait autorité sur ce qui
         était là. Sinon on ne touche QU'AUX champs vides. */
      applySuggestion(!!overwrite);
      go(W.step);
      /* La dictée a fait son travail : on replie le panneau pour rendre
         l'écran au formulaire. Le texte n'est pas perdu, juste rangé —
         c'est lui qui nourrira la prochaine régénération. */
      if (overwrite) {
        var vx = document.getElementById('cpVox');
        if (vx) vx.open = false;
      }
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
    ['pointA', 'pointB', 'verrou', 'verrouPlan', 'horizon12', 'horizon36'].forEach(function (k) {
      if (s[k] && (overwrite || isTodo(p[k]))) p[k] = s[k];
    });
    if ((s.organismes || []).length && (overwrite || !(p.organismes || []).length)) {
      p.organismes = s.organismes.slice();
      p.organisme = p.organismes[0] || '';
    }
    if ((s.renforces || []).length && (overwrite || !(p.renforces || []).length)) {
      p.renforces = s.renforces.slice();
    }
    if (s.synthese && (overwrite || isTodo(p.synthese))) p.synthese = s.synthese;
    ['chiffres', 'ditClient', 'problemes', 'objectifs', 'kpis', 'risques'].forEach(function (k) {
      if ((s[k] || []).length && (overwrite || !(p[k] || []).length)) p[k] = s[k];
    });
    if (s.jalons && Object.keys(s.jalons).length && (overwrite || !Object.keys(p.jalons || {}).length)) {
      p.jalons = s.jalons;
    }
  }

  /* Tout ce que le mentor a apporté lui-même : la dictée libre + les cases
     « Infos collectées » de chaque étape. C'est ce qu'on envoie à l'IA en plus
     du questionnaire — et ce qui fait la différence entre un plan générique et
     un plan qui ressemble à CE dossier. */
  function notesText() {
    var p = W.plan || {};
    var out = [];
    if (String(p.vocal || '').trim()) out.push('— Ce que le mentor raconte de la séance :\n' + String(p.vocal).trim());
    var col = p.collecte || {};
    STEPS.forEach(function (s) {
      var v = String(col[s.key] || '').trim();
      if (v) out.push('— Infos collectées sur « ' + s.t + ' » :\n' + v);
    });
    return out.join('\n\n');
  }

  function paintVox() {
    var el = document.getElementById('cpVoxBody');
    if (!el) return;
    var h = '<textarea id="cpVoxTxt" placeholder="Raconte à voix haute ce que tu sais du dossier : son activité, ses chiffres, ce qui le bloque, ce qu\'il veut dans 6 mois. Pas besoin de faire des phrases — l\'IA range.">'
      + esc(W.plan && W.plan.vocal ? W.plan.vocal : '') + '</textarea>';
    h += '<div class="cp-vox-a">'
      + (VOX.supported() ? '<button type="button" class="cp-mic big" data-mic="cpVoxTxt">🎤 Parler</button>' : '')
      + '<button type="button" class="cp-btn primary" id="cpVoxGo">✨ Remplir les champs</button>'
      + '</div>';
    if (!VOX.supported()) {
      h += '<div class="cp-vox-ko">La dictée n\'est pas disponible dans ce navigateur — Chrome, Edge et Safari la gèrent. '
        + 'Tu peux écrire dans la case ci-dessus : l\'IA la lit exactement de la même façon.</div>';
    }
    h += '<div class="cp-vox-n">Le texte reste dans la fiche : il sert de mémoire de séance et nourrit chaque régénération du plan.</div>';
    el.innerHTML = h;

    var t = document.getElementById('cpVoxTxt');
    if (t) t.addEventListener('input', function () { W.plan.vocal = this.value; });

    var go = document.getElementById('cpVoxGo');
    if (go) go.addEventListener('click', function () {
      collect();
      var tx = document.getElementById('cpVoxTxt');
      if (tx) W.plan.vocal = tx.value;
      if (!notesText().trim()) {
        alert('Dis (ou écris) d\'abord ce que tu sais de ce dossier — l\'IA ne peut pas inventer.');
        return;
      }
      var dejaRempli = !isTodo(W.plan.pointA) || !isTodo(W.plan.pointB) || !isTodo(W.plan.verrou);
      if (dejaRempli && !confirm('Les champs déjà remplis seront REMPLACÉS par la nouvelle proposition.\n\nContinuer ?')) return;
      loadSuggestion(true, true);
    });
  }

  function paintSuggBar() {
    var el = document.getElementById('cpSugg');
    if (!el) return;
    var msg = {
      loading: '<span class="sp"></span> Analyse en cours — le modèle réfléchit avant de proposer, compte une minute.',
      ready: '✨ Champs pré-remplis à partir du questionnaire et de tes notes — <b>relis et corrige</b>, c\'est une proposition.',
      none: 'Ni questionnaire ni notes pour ce client — utilise le mode vocal ci-dessous, ou saisis à la main.',
      refused: 'Le modèle a refusé de traiter ce contenu. Reformule tes notes, ou saisis à la main.',
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
    { key: 'cadrage',   t: 'Cadrage',            ico: '📆', sub: 'Le compte rendu du call des 72 h et le coach référent — tout le plan part de là.' },
    { key: 'pointA',    t: 'Point A',            ico: '📍', sub: 'La situation de départ, telle que le dirigeant la vit aujourd\'hui.' },
    { key: 'pointB',    t: 'Point B à 6 mois',   ico: '🎯', sub: 'Où il veut être dans six mois. Ses objectifs, avec ses mots et ses chiffres.' },
    { key: 'verrou',    t: 'Verrou principal',   ico: '🔒', sub: 'Le blocage à lever en premier, et ce qu\'on va faire pour le lever.' },
    { key: 'priorites', t: 'Priorités',          ico: '🧭', sub: 'L\'ordre de traitement, et les milestones à renforcer pour ce dossier.' }
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
      '.cp-sugg.none,.cp-sugg.error,.cp-sugg.refused{background:#fdf6e6;border:1px solid #f0dfae;color:#8a6412}',
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
      '@media(max-width:820px){.cp-body{grid-template-columns:1fr}.cp-aside{display:none}}',

      /* ── Correctifs de lisibilité (couche v3) ────────────────────────────
         Les champs de la semaine 1 vivaient hors de .cp-f : ils n'héritaient
         d'AUCUN style et s'affichaient en champs bruts minuscules, quasi
         invisibles sur fond blanc. On les rhabille ici, à l'identique du
         reste de l'assistant. Ces règles sont en fin de feuille : elles
         gagnent sur les précédentes sans qu'on ait à y toucher. */
      '.cp-f label{display:flex;align-items:center;gap:8px}',
      '.cp-act{border:1.5px solid ' + C.line + ';border-radius:12px;padding:12px 12px 13px;margin-bottom:10px;background:#fbfbff}',
      '.cp-act > label{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:7px}',
      '.cp-act input{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:9px;padding:10px 12px;font-size:13px;line-height:1.35;font-family:inherit;color:' + C.ink + ';background:#fff;outline:none}',
      '.cp-act input:focus{border-color:' + C.light + ';box-shadow:0 0 0 3px rgba(79,126,248,.15)}',
      '.cp-act input::placeholder{color:#9aa3b8;opacity:1}',
      '.cp-act .row{display:grid;grid-template-columns:1fr 160px;gap:8px;margin-top:8px}',
      '@media(max-width:520px){.cp-act .row{grid-template-columns:1fr}}',

      /* ── Infos collectées : ce que le mentor a relevé de son côté ── */
      '.cp-collect{margin:2px 0 16px;border:1.5px dashed ' + C.line + ';border-radius:12px;padding:11px 12px;background:#fcfcff}',
      '.cp-collect-h{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.main + ';margin-bottom:7px}',
      '.cp-collect textarea{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:9px;padding:9px 11px;font-size:12.5px;line-height:1.5;font-family:inherit;color:' + C.ink + ';background:#fff;outline:none;resize:vertical;min-height:56px}',
      '.cp-collect textarea:focus{border-color:' + C.light + '}',
      '.cp-collect .n{font-size:10.5px;color:' + C.muted + ';line-height:1.45;margin-top:6px}',

      /* ── Panneau du mode vocal ── */
      '.cp-vox{border:1.5px solid ' + C.line + ';border-radius:12px;background:' + C.ghost + ';margin-bottom:14px;overflow:hidden}',
      '.cp-vox > summary{list-style:none;cursor:pointer;padding:10px 13px;font-size:12px;font-weight:800;color:' + C.main + ';display:flex;align-items:center;gap:8px}',
      '.cp-vox > summary::-webkit-details-marker{display:none}',
      '.cp-vox-b{padding:0 13px 13px}',
      '.cp-vox textarea{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.55;font-family:inherit;color:' + C.ink + ';background:#fff;outline:none;resize:vertical;min-height:92px}',
      '.cp-vox textarea:focus{border-color:' + C.light + '}',
      '.cp-vox-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}',
      '.cp-vox-n{font-size:10.5px;color:' + C.muted + ';line-height:1.5;margin-top:8px}',
      '.cp-vox-ko{font-size:11.5px;color:#8a6412;background:#fdf6e6;border:1px solid #f0dfae;border-radius:9px;padding:8px 10px;margin-top:8px;line-height:1.5}',

      /* ── Défilement de l'assistant ───────────────────────────────────────
         La hauteur était plafonnée sur .cp-body (la GRILLE). Or une ligne de
         grille se dimensionne sur son contenu : elle débordait du conteneur
         plafonné au lieu de le faire défiler, et le bas du formulaire passait
         sous la barre de boutons — impossible d'atteindre « Infos collectées »
         dès que le mode vocal contenait quelques phrases.

         On plafonne donc la COLONNE qui défile, pas la grille. min-height:0
         est indispensable : sans lui, un élément de grille refuse de devenir
         plus petit que son contenu et overflow-y n'a aucun effet.
         La hauteur suit la fenêtre : sur un écran court, le formulaire reste
         entièrement atteignable. */
      '.cp-body{max-height:none}',
      '.cp-main,.cp-aside{min-height:0;max-height:min(68vh,calc(100vh - 230px));overflow-y:auto;overscroll-behavior:contain}',

      /* ── Brouillon : bandeau de reprise + témoin discret ── */
      '.cp-draft-bar{font-size:11.5px;line-height:1.5;background:#fdf6e6;border:1px solid #f0dfae;color:#8a6412;border-radius:9px;padding:9px 11px;margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cp-draft-bar button{border:1px solid currentColor;background:none;color:inherit;border-radius:7px;padding:3px 9px;font-size:10.5px;font-weight:800;cursor:pointer;font-family:inherit}',
      '.cp-draft{font-size:11px;color:' + C.muted + ';white-space:nowrap;transition:opacity .3s}',
      '.cp-draft.off{opacity:0}',

      /* ── Trame milestones : grandes zones, classement, renforcement ── */
      '.cp-f textarea.cp-grand{min-height:150px;line-height:1.6}',
      '.cp-deux{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '@media(max-width:560px){.cp-deux{grid-template-columns:1fr}}',
      '.cp-org button .r{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:' + C.main + ';color:#fff;font-size:10px;margin-right:6px;vertical-align:-2px}',
      '.cp-ms{display:flex;flex-direction:column;gap:7px}',
      '.cp-ms label{display:flex;gap:10px;align-items:flex-start;border:1.5px solid ' + C.line + ';border-radius:11px;padding:10px 12px;cursor:pointer;background:#fff;transition:all .12s}',
      '.cp-ms label.on{border-color:' + C.main + ';background:' + C.ghost + '}',
      '.cp-ms label:hover{border-color:' + C.light + '}',
      '.cp-ms input{margin-top:3px;flex-shrink:0;accent-color:' + C.main + '}',
      '.cp-ms .t{display:block;font-size:12.5px;font-weight:800;color:' + C.dark + '}',
      '.cp-ms .d{display:block;font-size:11px;color:' + C.muted + ';line-height:1.5;margin-top:2px}'
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
          '<div class="cp-main">' +
            '<div class="cp-draft-bar" id="cpDraftBar" style="display:none"></div>' +
            '<div class="cp-sugg" id="cpSugg" style="display:none"></div>' +
            /* Le panneau vocal vit HORS de #cpMain : il survit au changement
               d'étape, donc une dictée en cours n'est jamais coupée. */
            '<details class="cp-vox" id="cpVox">' +
              '<summary>🎙️ Mode vocal — raconte la séance, l\'IA remplit le plan</summary>' +
              '<div class="cp-vox-b" id="cpVoxBody"></div>' +
            '</details>' +
            '<div id="cpMain"></div>' +
          '</div>' +
          '<div class="cp-aside" id="cpAside"></div>' +
        '</div>' +
        '<div class="cp-foot">' +
          '<button class="cp-btn" id="cpPrev">← Précédent</button>' +
          '<div style="flex:1"></div>' +
          '<span class="cp-draft" id="cpDraft"></span>' +
          '<button class="cp-btn" id="cpCancel">Annuler</button>' +
          '<button class="cp-btn primary" id="cpNext">Suivant →</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);

    /* Clic à côté : on ne ferme plus en silence. C'était LA façon de tout
       perdre d'un geste — et même avec le brouillon, se faire éjecter au
       milieu d'une saisie reste désagréable. */
    bg.addEventListener('click', function (e) {
      if (e.target !== bg) return;
      if (confirm('Fermer l\'assistant ?\n\nTon brouillon est conservé : tu retrouveras ta saisie en rouvrant.')) closeWizard();
    });
    /* Sauvegarde automatique : une seule écoute déléguée sur toute la fenêtre,
       donc valable pour les champs ré-affichés à chaque étape. */
    bg.addEventListener('input', planifierBrouillon);
    bg.addEventListener('change', planifierBrouillon);
    document.getElementById('cpCancel').addEventListener('click', function () {
      if (confirm('Fermer l\'assistant ?\n\nTon brouillon est conservé : tu retrouveras ta saisie en rouvrant.')) closeWizard();
    });
    document.getElementById('cpPrev').addEventListener('click', function () { collect(); go(W.step - 1); });
    document.getElementById('cpNext').addEventListener('click', function () {
      collect();
      if (W.step < STEPS.length - 1) { go(W.step + 1); return; }
      finish();
    });
  }

  function closeWizard() {
    /* On coupe le micro en fermant : sinon il continue d'écouter derrière une
       fenêtre invisible, ce qui est autant un bug qu'un problème de confiance. */
    VOX.stop();
    /* Dernière écriture avant de partir — le temps mort de 800 ms n'a
       peut-être pas encore expiré au moment du clic. */
    ecrireBrouillon();
    var bg = document.getElementById('cpBg');
    if (bg) bg.classList.remove('show');
  }

  /* ── Brouillon de l'assistant ──────────────────────────────────────── */
  var brouillonTimer = null;

  function ecrireBrouillon() {
    if (!W.plan || !W.client) return;
    var id = clientIdDe(W.client);
    if (!id) return;
    collect();
    draftSave('wizard', id, W.plan);
    var el = document.getElementById('cpDraft');
    if (el) {
      el.textContent = '✓ brouillon enregistré';
      el.classList.remove('off');
      /* Le témoin s'efface : il rassure au moment utile, il n'encombre pas. */
      setTimeout(function () { if (el) el.classList.add('off'); }, 2200);
    }
  }

  function planifierBrouillon() {
    if (brouillonTimer) clearTimeout(brouillonTimer);
    brouillonTimer = setTimeout(function () { brouillonTimer = null; ecrireBrouillon(); }, 800);
  }

  function paintDraftBar() {
    var el = document.getElementById('cpDraftBar');
    if (!el) return;
    if (!W.draftAt) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = '📝 <span>Brouillon repris — dernière frappe le <b>' + esc(draftQuand(W.draftAt))
      + '</b>. Rien n\'a encore été enregistré dans la fiche.</span>'
      + '<button type="button" id="cpDraftReset">Repartir du plan enregistré</button>';
    var b = document.getElementById('cpDraftReset');
    if (b) b.onclick = function () {
      if (!confirm('Abandonner ce brouillon et repartir du plan enregistré ?\n\nCette action est définitive.')) return;
      var id = clientIdDe(W.client);
      draftClear('wizard', id);
      W.draftAt = null;
      W.plan = normalize(W.client && W.client.planV2
        ? JSON.parse(JSON.stringify(W.client.planV2))
        : emptyPlan());
      if (!W.plan.coach) W.plan.coach = W.client && W.client.coach ? W.client.coach : '';
      go(W.step);
      paintVox();
      paintDraftBar();
    };
  }

  function openWizard(client, opts) {
    ensureDom();
    opts = opts || {};
    W.client = client || {};
    W.onSave = opts.onSave || null;
    /* Régénérer part du plan existant : on ne perd pas les réponses déjà
       validées par le mentor. */
    W.plan = normalize(client && client.planV2
      ? JSON.parse(JSON.stringify(client.planV2))
      : emptyPlan());
    if (!W.plan.coach) W.plan.coach = client && client.coach ? client.coach : '';

    /* Reprise du brouillon : uniquement s'il est plus récent que le plan
       enregistré, sinon on ressusciterait une saisie déjà remplacée. */
    W.draftAt = null;
    var d = draftLoad('wizard', clientIdDe(client));
    if (d) {
      if (draftPlusRecent(d, client && client.planV2)) {
        W.plan = normalize(d.plan);
        W.draftAt = d.at;
      } else {
        draftClear('wizard', clientIdDe(client));
      }
    }

    W.step = 0;
    W.sugg = null;
    W.suggState = 'idle';
    go(0);
    paintDraftBar();
    /* Le panneau vocal est peint UNE fois : il vit hors de #cpMain, donc une
       dictée en cours n'est pas interrompue quand on change d'étape. */
    paintVox();
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

  function f(label, inner, hint, micId) {
    return '<div class="cp-f"><label>' + label + (micId ? mic(micId) : '') + '</label>' + inner
      + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }

  /* Case « Infos collectées » présente sur CHAQUE étape : ce que le mentor a
     appris et qui n'est nulle part ailleurs (au téléphone, en visio, sur le
     terrain). Repris tel quel par l'IA, et conservé dans la fiche. */
  function collecteBlock(key, exemple) {
    var v = (W.plan.collecte || {})[key] || '';
    return '<div class="cp-collect">'
      + '<div class="cp-collect-h"><span>📎 Infos collectées</span>' + mic('cpCol_' + key) + '</div>'
      + '<textarea id="cpCol_' + key + '" data-col="' + key + '" placeholder="' + esc(exemple) + '">' + esc(v) + '</textarea>'
      + '<div class="n">Ce que tu notes ici alimente la proposition de l\'IA et reste dans la fiche du client.</div>'
      + '</div>';
  }

  var STEP_HTML = {
    cadrage: function () {
      var p = W.plan;
      var d0 = fromYMD(p.startDate);
      var apercu = d0
        ? etapes(p).map(function (j) { return j.k + ' ' + frDate(jalonDate(p, jOf(p, j))); }).join(' · ')
        : '';
      return f('📋 Compte rendu du call des 72 h',
          '<textarea id="cpResume" class="cp-grand" placeholder="Colle ici le compte rendu du call — ou clique sur le micro et raconte-le. C\'est la matière première : le point A, le point B et le verrou en découlent.">'
          + esc(p.resume72h || '') + '</textarea>',
          'Tout le plan est généré à partir de ça et du questionnaire. Plus c\'est précis ici, plus le plan sera juste.',
          'cpResume')
        + '<div class="cp-deux">'
        + f('Date de démarrage (J0)', '<input type="date" id="cpStart" value="' + esc(p.startDate || '') + '">',
              apercu ? 'Repères : ' + esc(apercu) : 'Les échéances des milestones se calculent à partir de J0.')
        + f('Coach référent', '<input type="text" id="cpCoach" value="' + esc(p.coach || '') + '" placeholder="Prénom du coach">',
              'Un coach référent unique du premier au dernier jour.')
        + '</div>';
    },
    pointA: function () {
      return f('Point A — la situation de départ',
        '<textarea id="cpA" class="cp-grand" placeholder="Généré à partir du compte rendu et du questionnaire. Ce que le dirigeant vit aujourd\'hui, avec ses chiffres.">' + esc(W.plan.pointA || '') + '</textarea>',
        'Le constat, au présent, factuel et sans jugement — précis et détaillé. Reprends ses mots et ses chiffres ; n\'en invente aucun.',
        'cpA');
    },
    pointB: function () {
      return f('Point B — où il veut être dans 6 mois',
        '<textarea id="cpB" class="cp-grand" placeholder="Généré à partir du compte rendu, du questionnaire et de la synthèse de réunion. Ses objectifs à six mois.">' + esc(W.plan.pointB || '') + '</textarea>',
        'Détaillé et concret : ce sont SES objectifs à six mois, pas les nôtres. Ce qui n\'est pas mesurable ne se pilote pas.',
        'cpB');
    },
    verrou: function () {
      var p = W.plan;
      var h = f('Le verrou principal',
        '<textarea id="cpVerrou" placeholder="Le plus gros blocage aujourd\'hui — celui qu\'on doit lever en priorité.">' + esc(p.verrou || '') + '</textarea>',
        'Le vrai problème, pas le symptôme. C\'est lui qui décide par où on attaque, et il oriente les premiers coachings.',
        'cpVerrou');
      h += f('Ce qu\'on va faire pour le lever',
        '<textarea id="cpVerrouPlan" class="cp-grand" placeholder="Explique — ou dicte — ce qui doit être fait pour lever ce verrou.">' + esc(p.verrouPlan || '') + '</textarea>',
        '⚠ Aucune durée ici. Ce qui compte n\'est pas la date, c\'est que ce soit levé — le rythme dépend de l\'avancement et de la validation du coach.',
        'cpVerrouPlan');
      return h;
    },
    priorites: function () {
      var p = W.plan;
      var ordre = Array.isArray(p.organismes) ? p.organismes : [];
      var h = '<div class="cp-f"><label>Ordre de traitement</label><div class="cp-org" id="cpOrg">';
      Object.keys(ORGANISMES).forEach(function (k) {
        var rang = ordre.indexOf(k);
        h += '<button type="button" data-org="' + k + '" class="' + (rang >= 0 ? 'on' : '') + '">'
          + (rang >= 0 ? '<span class="r">' + (rang + 1) + '</span>' : '') + ORGANISMES[k].label + '</button>';
      });
      h += '</div><div class="hint">Clique dans l\'ordre où on les traite. L\'acquisition ne s\'ouvre qu\'une fois que la machine tient sans lui — c\'est une règle du programme, pas une préférence.'
        + (ordre.length ? '<br>' + esc(ORGANISMES[ordre[0]].note) : '') + '</div></div>';

      h += '<div class="cp-f"><label>Milestones à renforcer pour ce dossier</label><div class="cp-ms">';
      MILESTONES.forEach(function (m) {
        var on = (p.renforces || []).indexOf(m.k) >= 0;
        h += '<label class="' + (on ? 'on' : '') + '"><input type="checkbox" data-renf="' + m.k + '"' + (on ? ' checked' : '') + '>'
          + '<span><span class="t">' + m.k + ' · ' + esc(m.obj) + '</span>'
          + '<span class="d">' + esc(m.periode) + ' — ' + esc(m.objectif) + '</span></span></label>';
      });
      h += '</div><div class="hint">Le chemin est le même pour tous ; la profondeur donnée à chaque milestone, non. '
        + 'Urgence rentabilité → renforcer M3. Urgence équipe → M2 et M3. Recrutement déjà lancé → M4.</div></div>';

      h += f('Note de priorisation',
        '<textarea id="cpPrioNote" placeholder="Pourquoi cet ordre pour ce dirigeant-là.">' + esc(p.prioriteNote || '') + '</textarea>',
        null, 'cpPrioNote');
      return h;
    }
  };

  function bindStep(key) {
    if (key === 'cadrage') {
      document.getElementById('cpStart').addEventListener('change', function () {
        W.plan.startDate = this.value;
        go(W.step);
      });
    }
    if (key === 'priorites') {
      /* Clic = on ajoute à la suite du classement ; re-clic = on retire et les
         suivants remontent. Pas de glisser-déposer : trois éléments, autant
         que ça marche au doigt sur un portable. */
      Array.prototype.forEach.call(document.querySelectorAll('#cpOrg button'), function (b) {
        b.addEventListener('click', function () {
          collect();
          var k = b.getAttribute('data-org');
          var o = Array.isArray(W.plan.organismes) ? W.plan.organismes.slice() : [];
          var i = o.indexOf(k);
          if (i >= 0) o.splice(i, 1); else o.push(k);
          W.plan.organismes = o;
          /* Le champ historique reste alimenté : tout ce qui l'affiche
             (plans existants, PDF, lien client) continue de fonctionner. */
          W.plan.organisme = o[0] || '';
          go(W.step);
        });
      });
      /* Les cases se marquent sans re-rendu : re-peindre l'étape ferait
         perdre le focus et la position de défilement à chaque clic. */
      Array.prototype.forEach.call(document.querySelectorAll('[data-renf]'), function (c) {
        c.addEventListener('change', function () {
          var lab = c.closest ? c.closest('label') : null;
          if (lab) { if (c.checked) lab.classList.add('on'); else lab.classList.remove('on'); }
          collect();
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
    if ((v = g('cpResume')) !== null) p.resume72h = v.trim();
    if ((v = g('cpA')) !== null) p.pointA = v.trim();
    if ((v = g('cpB')) !== null) p.pointB = v.trim();
    if ((v = g('cpVerrou')) !== null) p.verrou = v.trim();
    if ((v = g('cpVerrouPlan')) !== null) p.verrouPlan = v.trim();
    if ((v = g('cpPrioNote')) !== null) p.prioriteNote = v.trim();
    /* Milestones renforcés — lus seulement si l'étape est à l'écran, sinon on
       viderait la liste en naviguant. */
    var cases = document.querySelectorAll('#cpMain [data-renf]');
    if (cases.length) {
      p.renforces = Array.prototype.filter.call(cases, function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-renf'); });
    }
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
    /* Cases « Infos collectées » de l'étape affichée + dictée libre. Lues à
       chaque navigation : rien ne se perd en changeant d'écran. */
    p.collecte = p.collecte || {};
    Array.prototype.forEach.call(document.querySelectorAll('#cpMain [data-col]'), function (t) {
      p.collecte[t.getAttribute('data-col')] = t.value.trim();
    });
    var vx = document.getElementById('cpVoxTxt');
    if (vx) p.vocal = vx.value;
  }

  function finish() {
    var p = W.plan;
    etapes(p).forEach(function (j) { if (!p.jalonStatus[j.k]) p.jalonStatus[j.k] = 'todo'; });
    p.updatedAt = new Date().toISOString();
    if (!p.createdAt) p.createdAt = p.updatedAt;
    /* Le plan part en base : le brouillon n'a plus lieu d'être, et le garder
       ferait réapparaître un bandeau de reprise à la prochaine ouverture. */
    draftClear('wizard', clientIdDe(W.client));
    W.draftAt = null;
    if (brouillonTimer) { clearTimeout(brouillonTimer); brouillonTimer = null; }
    VOX.stop();
    var bg = document.getElementById('cpBg');
    if (bg) bg.classList.remove('show');
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

    /* Barre de retouche — fiche coach uniquement. En vue client (readonly),
       rien de tout ça n'est rendu : il lit son plan, il ne le pilote pas. */
    if (!ro && clientId) h += aiBar(clientId);

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
    /* Les deux repères longs. Volontairement discrets et en fin de bloc :
       ce ne sont pas des objectifs du parcours, juste la direction qu'on
       garde en tête pendant les six mois. */
    if (!isTodo(p.horizon12) || !isTodo(p.horizon36)) {
      h += '<div class="cpv2-horizon">';
      if (!isTodo(p.horizon12)) h += '<div><span>Dans 12 mois</span>' + esc(p.horizon12) + '</div>';
      if (!isTodo(p.horizon36)) h += '<div><span>Dans 3 ans</span>' + esc(p.horizon36) + '</div>';
      h += '</div>';
    }
    h += '</div>';

    /* BLOC — Diagnostic : verrou, organisme, problématiques */
    var ordre = (p.organismes && p.organismes.length) ? p.organismes : (p.organisme ? [p.organisme] : []);
    var org = ORGANISMES[ordre[0]];
    h += blocOpen(++n, '🔍', 'Diagnostic');
    h += '<div class="cpv-k">Verrou principal</div><div class="cpv-p' + (isTodo(p.verrou) ? ' todo' : '') + '">' + esc(val(p.verrou)) + '</div>';
    if (!isTodo(p.verrouPlan)) {
      h += '<div class="cpv-k" style="margin-top:13px">Ce qu\'on fait pour le lever</div>'
        + '<div class="cpv-p">' + esc(p.verrouPlan) + '</div>';
    }
    h += '<div class="cpv-k" style="margin-top:13px">Ordre de traitement</div>';
    if (ordre.length) {
      h += '<div class="cpv2-ordre">';
      ordre.forEach(function (k, i) {
        if (!ORGANISMES[k]) return;
        h += '<span class="cpv-org"><b>' + (i + 1) + '</b>' + esc(ORGANISMES[k].label) + '</span>';
      });
      h += '</div>';
    } else {
      h += '<div class="cpv-org">' + TODO + '</div>';
    }
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
    h += progBar(p);
    h += roadSvg(p);
    h += '<div class="cpv-steps">';
    etapes(p).forEach(function (j) {
      var st = STATUTS[p.jalonStatus && p.jalonStatus[j.k]] || STATUTS.todo;
      var c = (p.jalons || {})[j.k] || {};
      var jj = jOf(p, j);
      /* Liseré coloré à gauche : le statut se lit sans chercher le bouton. */
      h += '<div class="cpv-step ' + (st === STATUTS.ok ? 'done' : '') + '" style="border-left:4px solid ' + st.col + '">';
      var renf = (p.renforces || []).indexOf(j.k) >= 0;
      h += '<div class="cpv-steph"><span class="b" style="border-color:' + st.col + ';color:' + st.col + '">' + j.k + '</span>'
        + '<span class="t">' + esc(jalonTitre(p, j)) + (renf ? '<span class="cpv2-renf">renforcé</span>' : '') + '</span>'
        + '<span class="dt">' + (j.periode ? esc(j.periode) + ' · ' : '') + 'repère ' + esc(frDate(jalonDate(p, jj))) + '</span>'
        + (ro
            ? '<span class="cpv-st ro" style="color:' + st.col + '">' + st.ico + ' ' + st.lbl + '</span>'
            : '<button class="cpv-st" data-cp-jalon="' + j.k + '" data-cp-id="' + esc(clientId || '') + '" style="color:' + st.col + '">' + st.ico + ' ' + st.lbl + '</button>')
        + '</div>';
      if (c.focus) h += '<div class="cpv-stepf">' + esc(c.focus) + '</div>';
      else if (j.objectif) h += '<div class="cpv-stepf">' + esc(j.objectif) + '</div>';
      if ((c.actions || []).length) {
        h += '<ul class="cpv-ul">';
        c.actions.forEach(function (a) { h += '<li>' + esc(a) + '</li>'; });
        h += '</ul>';
      }
      if (j.livrable) h += '<div class="cpv-stepl">📎 ' + esc(j.livrable) + '</div>';
      h += '<div class="cpv-stepp">Preuve attendue : ' + esc(jalonPreuve(p, j)) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    /* La règle du programme, mot pour mot : c'est elle qui justifie que les
       dates soient au second plan partout ailleurs. */
    h += '<div class="cpv-rule">Les échéances sont des <b>moyennes constatées</b>. Ce qui compte n\'est pas la date, '
      + 'c\'est qu\'un milestone soit <b>validé avant d\'ouvrir le suivant</b>.<br>'
      + 'Une étape manquée → on cherche la cause avant d\'avancer. Jamais un simple report.</div>';
    h += '</div>';

    /* BLOC — Actions de la semaine */
    /* Bloc affiché seulement s'il porte quelque chose. La trame milestones ne
       crée plus de « semaine 1 » d'office ; les plans qui en ont déjà une la
       gardent, et le coach peut toujours en ajouter depuis l'éditeur. */
    if ((p.semaines || []).length) {
    h += blocOpen(++n, '⚡', 'Actions de la semaine');
    (p.semaines || []).forEach(function (s, si) {
      var tot = (s.actions || []).length;
      var faites = (s.actions || []).filter(function (a) { return a && a.st === 'ok'; }).length;
      h += '<div class="cpv-sem"><div class="cpv-semh"><b>Semaine ' + (s.n || si + 1) + '</b>'
        + '<span>du ' + esc(frDate(s.from)) + ' au ' + esc(frDate(s.to)) + '</span>'
        + '<span class="c">' + esc(s.coach || p.coach || TODO) + '</span>'
        + (tot ? '<span class="cpv2-cnt">' + faites + '/' + tot + ' faites</span>' : '')
        + '</div>';
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
    }

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
    var LIST = etapes(p);
    var n = LIST.length;
    var W_ = 300, STEP = 108, TOP = 46, PAD = 58;
    var H = TOP + (n - 1) * STEP + PAD;
    var pts = LIST.map(function (j, i) {
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
      var jj = jOf(p, pt.j);
      h += '<text x="' + tx + '" y="' + (pt.y - 3) + '" text-anchor="' + anchor + '" class="rt">' + esc(jalonTitre(p, pt.j)) + '</text>';
      h += '<text x="' + tx + '" y="' + (pt.y + 12) + '" text-anchor="' + anchor + '" class="rd">' + esc(frDate(jalonDate(p, jj))) + ' · J+' + jj + '</text>';
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

  /* Où on en est, en une ligne : plus lisible qu'un parcours à décoder. */
  function progBar(p) {
    var ok = 0;
    var LIST = etapes(p);
    LIST.forEach(function (j) { if ((p.jalonStatus || {})[j.k] === 'ok') ok++; });
    var pct = Math.round(ok / LIST.length * 100);
    return '<div class="cpv2-prog"><span class="lb">Avancement</span>'
      + '<span class="tr"><span class="fi" style="width:' + pct + '%"></span></span>'
      + '<span class="vv">' + ok + ' / ' + LIST.length + ' étapes · ' + pct + ' %</span></div>';
  }

  /* Retouche en langage naturel + accès à l'éditeur manuel. Le bouton porte
     data-cp-ai / data-cp-edit : coaching.html branche les deux en délégation,
     comme les statuts — le plan est ré-rendu en permanence. */
  function aiBar(clientId) {
    var id = 'cpAi_' + clientId;
    return '<div class="cpv2-ai">'
      + '<div class="cpv2-ai-h"><span>✍️ Dis ce que tu veux changer</span>' + mic(id) + '</div>'
      + '<textarea id="' + esc(id) + '" placeholder="Ex : « le point B est trop ambitieux, mets 28 000 € par mois » · « décale l\'étape A3 à J+60 » · « ajoute une semaine 2 sur le tri des devis, échéance vendredi » · « la preuve de A2 doit être un contrat signé »"></textarea>'
      + '<div class="cpv2-ai-a">'
      + '<button type="button" class="cpv2-btn" data-cp-ai="' + esc(clientId) + '">✨ Appliquer</button>'
      + '<button type="button" class="cpv2-btn ghost" data-cp-edit="' + esc(clientId) + '">✏️ Tout modifier à la main</button>'
      + '</div>'
      + '<div class="cpv2-ai-n">Écris ou dicte en français, comme à un assistant. Tout ce que tu ne mentionnes pas est conservé mot pour mot — statuts d\'avancement et dates de séance compris.</div>'
      + '</div>';
  }

  /* Cycle de statut au clic — todo → wip → ok → ko → todo. */
  function cycle(cur) {
    var i = STATUT_ORDER.indexOf(cur || 'todo');
    return STATUT_ORDER[(i + 1) % STATUT_ORDER.length];
  }

  /* ═════════════════════════════════════════════════════════════════════
     ÉDITEUR MANUEL — tout le plan, champ par champ
     ─────────────────────────────────────────────────────────────────────
     L'assistant sert à CRÉER le plan ; l'éditeur sert à le VIVRE : décaler une
     étape, réécrire une preuve, ajouter la semaine 4 après la séance. Tout est
     modifiable, y compris ce que l'IA avait proposé — elle propose, le mentor
     décide.

     Rien n'est enregistré tant qu'on n'a pas cliqué sur « Enregistrer » :
     l'éditeur travaille sur une COPIE du plan.
     ═══════════════════════════════════════════════════════════════════ */
  var E = { plan: null, client: null, onSave: null };

  function ensureEditorDom() {
    if (document.getElementById('ceBg')) return;
    var css = document.createElement('style');
    css.id = 'ceCss';
    css.textContent = [
      '#ceBg{position:fixed;inset:0;background:rgba(11,13,23,.55);backdrop-filter:blur(4px);z-index:99991;display:none;align-items:flex-start;justify-content:center;padding:3vh 16px;overflow-y:auto}',
      '#ceBg.show{display:flex}',
      '.ce{background:#fff;border-radius:18px;width:min(980px,100%);box-shadow:0 30px 90px rgba(15,31,92,.28);overflow:hidden;color:' + C.ink + ';font-family:inherit}',
      '.ce-head{background:linear-gradient(135deg,' + C.main + ',' + C.dark + ');color:#fff;padding:17px 22px}',
      '.ce-head h3{margin:0;font-size:17px;font-weight:800}',
      '.ce-head p{margin:4px 0 0;font-size:12.5px;opacity:.82;line-height:1.45}',
      '.ce-body{padding:16px 18px;max-height:66vh;overflow-y:auto;background:#fbfbfe}',
      '.ce-s{border:1px solid ' + C.line + ';border-radius:12px;background:#fff;margin-bottom:10px;overflow:hidden}',
      '.ce-s > summary{list-style:none;cursor:pointer;padding:11px 14px;font-size:13px;font-weight:800;color:' + C.dark + ';background:linear-gradient(90deg,' + C.ghost + ',#fff);display:flex;align-items:center;gap:8px}',
      '.ce-s > summary::-webkit-details-marker{display:none}',
      '.ce-sb{padding:13px 15px 15px}',
      '.ce-f{margin-bottom:12px}',
      '.ce-f > label{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:5px}',
      '.ce-i{width:100%;box-sizing:border-box;border:1.5px solid ' + C.line + ';border-radius:9px;padding:9px 11px;font-size:13px;line-height:1.4;font-family:inherit;color:' + C.ink + ';background:#fff;outline:none}',
      '.ce-i:focus{border-color:' + C.light + ';box-shadow:0 0 0 3px rgba(79,126,248,.15)}',
      '.ce-i::placeholder{color:#9aa3b8;opacity:1}',
      'textarea.ce-i{resize:vertical;min-height:60px;line-height:1.5}',
      '.ce-hint{font-size:11px;color:' + C.muted + ';line-height:1.45;margin-top:5px}',
      '.ce-row{display:grid;gap:8px;align-items:start;margin-bottom:8px}',
      '.ce-row.a{grid-template-columns:1fr 34px}',
      '.ce-row.b{grid-template-columns:1fr 1.4fr 34px}',
      '.ce-row.k{grid-template-columns:132px 1fr 106px 106px 106px 34px}',
      '.ce-row.act{grid-template-columns:1fr 150px 148px 116px 34px}',
      '@media(max-width:760px){.ce-row.k,.ce-row.b,.ce-row.act{grid-template-columns:1fr}}',
      '.ce-x{border:1.5px solid ' + C.line + ';background:#fff;color:' + C.red + ';border-radius:9px;height:36px;cursor:pointer;font-size:13px;font-family:inherit;padding:0}',
      '.ce-x:hover{border-color:' + C.red + ';background:#fff5f5}',
      '.ce-add{border:1.5px dashed ' + C.line + ';background:#fff;color:' + C.main + ';border-radius:9px;padding:7px 13px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:2px}',
      '.ce-add:hover{border-color:' + C.main + ';background:' + C.ghost + '}',
      '.ce-j,.ce-sem{border:1.5px solid ' + C.line + ';border-radius:12px;padding:12px 13px 13px;margin-bottom:10px;background:#fcfcff}',
      '.ce-jh,.ce-semh{display:flex;align-items:center;gap:9px;margin-bottom:11px;flex-wrap:wrap}',
      '.ce-jk{min-width:36px;height:28px;padding:0 8px;border-radius:8px;background:' + C.main + ';color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.ce-jn{font-size:11px;color:' + C.muted + ';flex:1;min-width:130px;line-height:1.4}',
      '.ce-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}',
      '@media(max-width:720px){.ce-grid{grid-template-columns:1fr}}',
      '.ce-foot{display:flex;align-items:center;gap:9px;padding:13px 20px;border-top:1px solid ' + C.line + ';background:#fff;flex-wrap:wrap}',
      '.ce-org{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
      '.ce-org button{border:1.5px solid ' + C.line + ';background:#fff;border-radius:10px;padding:10px 8px;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:800;color:' + C.muted + '}',
      '.ce-org button.on{border-color:' + C.main + ';background:' + C.ghost + ';color:' + C.main + '}',
      '.ce-org button .r{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:' + C.main + ';color:#fff;font-size:10px;margin-right:6px;vertical-align:-2px}'
    ].join('\n');
    document.head.appendChild(css);

    var bg = document.createElement('div');
    bg.id = 'ceBg';
    bg.innerHTML =
      '<div class="ce">' +
        '<div class="ce-head"><h3 id="ceTitle">✏️ Modifier le plan d\'action</h3>' +
          '<p>Tout est modifiable. Le micro 🎤 dicte dans le champ d\'à côté. Rien n\'est enregistré tant que tu n\'as pas cliqué sur « Enregistrer ».</p></div>' +
        '<div class="ce-body" id="ceBody"></div>' +
        '<div class="ce-foot">' +
          '<button type="button" class="cpv2-btn ghost" id="ceCancel">Annuler</button>' +
          '<div style="flex:1"></div>' +
          '<span class="cp-draft" id="ceDraft"></span>' +
          '<button type="button" class="cpv2-btn" id="ceSave">💾 Enregistrer</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);

    /* Même règle que l'assistant : un clic à côté ne jette plus la saisie. */
    var demanderFermeture = function () {
      if (confirm('Fermer l\'éditeur ?\n\nTon brouillon est conservé : tu retrouveras tes modifications en rouvrant.')) closeEditor();
    };
    bg.addEventListener('click', function (e) { if (e.target === bg) demanderFermeture(); });
    bg.addEventListener('input', planifierBrouillonEditeur);
    bg.addEventListener('change', planifierBrouillonEditeur);
    document.getElementById('ceCancel').addEventListener('click', demanderFermeture);
    document.getElementById('ceSave').addEventListener('click', function () {
      editorCollect();
      var p = E.plan;
      p.updatedAt = new Date().toISOString();
      if (!p.createdAt) p.createdAt = p.updatedAt;
      /* Enregistré pour de bon → le brouillon disparaît. Fermeture directe :
         passer par closeEditor() réécrirait le brouillon qu'on vient d'effacer. */
      draftClear('editor', clientIdDe(E.client));
      E.draftAt = null;
      if (brouillonEditeurTimer) { clearTimeout(brouillonEditeurTimer); brouillonEditeurTimer = null; }
      VOX.stop();
      var b = document.getElementById('ceBg');
      if (b) b.classList.remove('show');
      if (typeof E.onSave === 'function') E.onSave(p);
    });

    /* Ajout / suppression de lignes : délégation, le corps est repeint à
       chaque changement de structure. */
    document.getElementById('ceBody').addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-add],[data-del],[data-eorg],[data-draft-reset]') : null;
      if (!t) return;
      e.preventDefault();
      /* Abandon du brouillon : surtout PAS de editorCollect() avant, on
         relirait le formulaire qu'on s'apprête à remplacer. */
      if (t.hasAttribute('data-draft-reset')) { editorDraftReset(); return; }
      editorCollect();
      var add = t.getAttribute('data-add');
      var del = t.getAttribute('data-del');
      var org = t.getAttribute('data-eorg');
      if (org) {
        /* Même logique que l'assistant : clic = on ajoute au classement,
           re-clic = on retire et les suivants remontent. */
        var oe = Array.isArray(E.plan.organismes) ? E.plan.organismes.slice() : [];
        var ie = oe.indexOf(org);
        if (ie >= 0) oe.splice(ie, 1); else oe.push(org);
        E.plan.organismes = oe;
        E.plan.organisme = oe[0] || '';
      }
      else if (add) editorAdd(add);
      else if (del) editorDel(del);
      paintEditor(true);
    });
  }

  function closeEditor() {
    VOX.stop();
    ecrireBrouillonEditeur();
    var bg = document.getElementById('ceBg');
    if (bg) bg.classList.remove('show');
  }

  /* ── Brouillon de l'éditeur ────────────────────────────────────────── */
  var brouillonEditeurTimer = null;

  function ecrireBrouillonEditeur() {
    if (!E.plan || !E.client) return;
    var id = clientIdDe(E.client);
    if (!id) return;
    editorCollect();
    draftSave('editor', id, E.plan);
    var el = document.getElementById('ceDraft');
    if (el) {
      el.textContent = '✓ brouillon enregistré';
      el.classList.remove('off');
      setTimeout(function () { if (el) el.classList.add('off'); }, 2200);
    }
  }

  function planifierBrouillonEditeur() {
    if (brouillonEditeurTimer) clearTimeout(brouillonEditeurTimer);
    brouillonEditeurTimer = setTimeout(function () { brouillonEditeurTimer = null; ecrireBrouillonEditeur(); }, 800);
  }

  function openEditor(client, opts) {
    ensureEditorDom();
    opts = opts || {};
    E.client = client || {};
    E.onSave = opts.onSave || null;
    E.plan = normalize(client && client.planV2
      ? JSON.parse(JSON.stringify(client.planV2))
      : emptyPlan());

    E.draftAt = null;
    var d = draftLoad('editor', clientIdDe(client));
    if (d) {
      if (draftPlusRecent(d, client && client.planV2)) {
        E.plan = normalize(d.plan);
        E.draftAt = d.at;
      } else {
        draftClear('editor', clientIdDe(client));
      }
    }

    paintEditor(false);
    document.getElementById('ceBg').classList.add('show');
  }

  function editorAdd(what) {
    var p = E.plan, m = String(what).split('.');
    if (m[0] === 'semaine') {
      var last = p.semaines[p.semaines.length - 1];
      /* La semaine suivante démarre le lendemain de la précédente : le mentor
         n'a pas à recalculer des dates à la main. */
      var from = last && fromYMD(last.to) ? addDays(fromYMD(last.to), 1) : (fromYMD(p.startDate) || new Date());
      p.semaines.push({
        n: p.semaines.length + 1,
        from: toYMD(from), to: toYMD(addDays(from, 6)),
        coach: p.coach || '', focus: '',
        actions: [{ txt: '', who: '', due: '', st: 'todo' }]
      });
      return;
    }
    if (m[0] === 'sact') {
      var s = p.semaines[+m[1]];
      if (s) { s.actions = s.actions || []; s.actions.push({ txt: '', who: '', due: '', st: 'todo' }); }
      return;
    }
    if (m[0] === 'objectifs') { p.objectifs.push(''); return; }
    if (['problemes', 'risques', 'ditClient'].indexOf(m[0]) >= 0) { p[m[0]].push({ titre: '', detail: '' }); return; }
    if (m[0] === 'chiffres') { p.chiffres.push({ label: '', valeur: '' }); return; }
    if (m[0] === 'kpis') { p.kpis.push({ cat: 'Financier', nom: '', freq: 'Mensuel', actuel: '—', cible: '' }); return; }
  }

  function editorDel(what) {
    var p = E.plan, m = String(what).split('.');
    if (m[0] === 'semaine') { p.semaines.splice(+m[1], 1); return; }
    if (m[0] === 'sact') {
      var s = p.semaines[+m[1]];
      if (s && s.actions) s.actions.splice(+m[2], 1);
      return;
    }
    if (Array.isArray(p[m[0]])) p[m[0]].splice(+m[1], 1);
  }

  /* ── Briques de formulaire ───────────────────────────────────────────── */
  function ceF(label, inner, hint, micId) {
    return '<div class="ce-f"><label>' + label + (micId ? mic(micId) : '') + '</label>' + inner
      + (hint ? '<div class="ce-hint">' + hint + '</div>' : '') + '</div>';
  }
  function ceIn(attr, value, ph, type) {
    return '<input type="' + (type || 'text') + '" class="ce-i" ' + attr
      + ' value="' + esc(value == null ? '' : value) + '"'
      + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
  }
  function ceTa(attr, value, ph, id) {
    return '<textarea class="ce-i" ' + attr + (id ? ' id="' + esc(id) + '"' : '')
      + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>' + esc(value == null ? '' : value) + '</textarea>';
  }
  function ceStatut(attr, cur) {
    var h = '<select class="ce-i" ' + attr + '>';
    STATUT_ORDER.forEach(function (k) {
      h += '<option value="' + k + '"' + ((cur || 'todo') === k ? ' selected' : '') + '>' + STATUTS[k].ico + ' ' + STATUTS[k].lbl + '</option>';
    });
    return h + '</select>';
  }
  function ceDel(ref, titre) {
    return '<button type="button" class="ce-x" data-del="' + esc(ref) + '" title="' + esc(titre || 'Supprimer cette ligne') + '">✕</button>';
  }
  function ceAdd(ref, txt) {
    return '<button type="button" class="ce-add" data-add="' + esc(ref) + '">+ ' + esc(txt) + '</button>';
  }
  function ceSection(titre, corps, open) {
    return '<details class="ce-s"' + (open === false ? '' : ' open') + '><summary>' + titre + '</summary><div class="ce-sb">' + corps + '</div></details>';
  }

  /* Listes « titre + détail » (problématiques, vigilance, ce qu'il a dit). */
  function ceListeTD(cle, rows, phT, phD) {
    var h = '';
    (rows || []).forEach(function (x, i) {
      h += '<div class="ce-row b">'
        + ceIn('data-p="' + cle + '.' + i + '.titre"', x.titre, phT)
        + ceIn('data-p="' + cle + '.' + i + '.detail"', x.detail, phD)
        + ceDel(cle + '.' + i) + '</div>';
    });
    return h + ceAdd(cle, 'Ajouter une ligne');
  }

  function editorDraftReset() {
    if (!confirm('Abandonner ce brouillon et repartir du plan enregistré ?\n\nCette action est définitive.')) return;
    draftClear('editor', clientIdDe(E.client));
    E.draftAt = null;
    E.plan = normalize(E.client && E.client.planV2
      ? JSON.parse(JSON.stringify(E.client.planV2))
      : emptyPlan());
    paintEditor(false);
  }

  function paintEditor(keepScroll) {
    var body = document.getElementById('ceBody');
    if (!body) return;
    var top = keepScroll ? body.scrollTop : 0;
    var p = E.plan;
    var h = '';

    if (E.draftAt) {
      h += '<div class="cp-draft-bar">📝 <span>Brouillon repris — dernière frappe le <b>'
        + esc(draftQuand(E.draftAt)) + '</b>. Rien n\'a encore été enregistré dans la fiche.</span>'
        + '<button type="button" data-draft-reset="1">Repartir du plan enregistré</button></div>';
    }

    /* 1. Cadrage */
    h += ceSection('📆 Cadrage',
      ceF('Compte rendu du call des 72 h',
          ceTa('data-e="resume72h"', p.resume72h, 'La matière première du plan.', 'ceResume'),
          'C\'est de là que sortent le point A, le point B et le verrou. Repris par l\'IA à chaque régénération.', 'ceResume')
      + '<div class="ce-grid">'
      + ceF('Date de démarrage (J0)', ceIn('data-e="startDate"', p.startDate, '', 'date'),
            'Les repères des milestones se recalculent à partir d\'ici.')
      + ceF('Coach référent', ceIn('data-e="coach"', p.coach, 'Prénom du coach'))
      + '</div>'
      + ceF('Ce qu\'on vise en 6 mois', ceTa('data-e="synthese"', p.synthese, 'La phrase qui résume l\'accompagnement, affichée en tête du plan.', 'ceSynthese'),
            'Une phrase forte : d\'où on part, où on l\'emmène.', 'ceSynthese'));

    /* 2. Point A → B */
    h += ceSection('📍 Point A → Point B',
      ceF('Point A — aujourd\'hui', ceTa('data-e="pointA"', p.pointA, 'La situation actuelle, factuelle et sans jugement.', 'cePointA'), null, 'cePointA')
      + ceF('Point B — à 6 mois', ceTa('data-e="pointB"', p.pointB, 'L\'objectif, concret et mesurable.', 'cePointB'), null, 'cePointB')
      + '<label style="display:block;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:6px">Objectifs des 6 mois</label>'
      + (function () {
          var s = '';
          (p.objectifs || []).forEach(function (o, i) {
            s += '<div class="ce-row a">' + ceIn('data-l="objectifs.' + i + '"', o, 'Un objectif concret') + ceDel('objectifs.' + i) + '</div>';
          });
          return s + ceAdd('objectifs', 'Ajouter un objectif');
        })());

    /* 3. Diagnostic */
    var ordreE = Array.isArray(p.organismes) ? p.organismes : [];
    h += ceSection('🔍 Diagnostic',
      ceF('Verrou principal', ceTa('data-e="verrou"', p.verrou, 'Le vrai problème — pas le symptôme.', 'ceVerrou'), null, 'ceVerrou')
      + ceF('Ce qu\'on fait pour le lever', ceTa('data-e="verrouPlan"', p.verrouPlan, 'Ce qui doit être fait.', 'ceVerrouPlan'),
            'Aucune durée ici : le rythme dépend de l\'avancement et de la validation du coach.', 'ceVerrouPlan')
      + '<div class="ce-f"><label>Ordre de traitement</label><div class="ce-org">'
      + Object.keys(ORGANISMES).map(function (k) {
          var r = ordreE.indexOf(k);
          return '<button type="button" data-eorg="' + k + '" class="' + (r >= 0 ? 'on' : '') + '">'
            + (r >= 0 ? '<span class="r">' + (r + 1) + '</span>' : '') + ORGANISMES[k].label + '</button>';
        }).join('')
      + '</div><div class="ce-hint">Clique dans l\'ordre où on les traite ; re-clic pour retirer. L\'acquisition ne s\'ouvre qu\'au dernier milestone.</div></div>'
      + '<div class="ce-grid">'
      + ceF('Dans 12 mois', ceTa('data-e="horizon12"', p.horizon12, 'Repère de direction, discret.', 'ceH12'), null, 'ceH12')
      + ceF('Dans 3 ans', ceTa('data-e="horizon36"', p.horizon36, 'Repère de direction, discret.', 'ceH36'), null, 'ceH36')
      + '</div>'
      + '<label style="display:block;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:6px">Ce qui bloque aujourd\'hui</label>'
      + ceListeTD('problemes', p.problemes, 'Problématique', 'Une phrase factuelle'));

    /* 4. Les 6 étapes */
    var hj = '';
    etapes(p).forEach(function (j) {
      var c = (p.jalons || {})[j.k] || {};
      var acts = (c.actions || []).slice(0, 3);
      while (acts.length < 3) acts.push('');
      hj += '<div class="ce-j">'
        + '<div class="ce-jh"><span class="ce-jk">' + j.k + '</span>'
        + '<span class="ce-jn">' + (j.periode ? j.periode + ' — ' : '') + j.obj + '</span>'
        + ceStatut('data-j="' + j.k + '.st" style="max-width:150px"', (p.jalonStatus || {})[j.k])
        + '</div>'
        + '<div class="ce-grid">'
        + ceF('Titre de l\'étape', ceIn('data-j="' + j.k + '.titre"', c.titre, j.obj))
        + ceF('Repère — jours depuis J0', ceIn('data-j="' + j.k + '.j"', (typeof c.j === 'number' ? c.j : ''), 'Par défaut : ' + j.j, 'number'),
              'Vide = ' + j.j + ' jours. Repère indicatif, pas un délai dû : ' + frDate(jalonDate(p, jOf(p, j))))
        + '</div>'
        + ceF('Ce qu\'on traite à cette étape', ceTa('data-j="' + j.k + '.focus"', c.focus, 'Une phrase.', 'ceJf' + j.k), null, 'ceJf' + j.k)
        + '<label style="display:block;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:6px">Actions de l\'étape</label>'
        + acts.map(function (a, i) {
            return '<div class="ce-row" style="grid-template-columns:1fr">' + ceIn('data-ja="' + j.k + '.' + i + '"', a, 'Action ' + (i + 1) + ' — verbe à l\'infinitif') + '</div>';
          }).join('')
        + ceF('Preuve attendue', ceIn('data-j="' + j.k + '.preuve"', c.preuve, j.preuve),
              'Un fait vérifiable sans discussion. Vide = « ' + j.preuve + ' ».')
        + '</div>';
    });
    h += ceSection('🛣️ Les 5 milestones', hj);

    /* 5. Semaines */
    var hs = '';
    (p.semaines || []).forEach(function (s, i) {
      var acts = Array.isArray(s.actions) ? s.actions : [];
      hs += '<div class="ce-sem">'
        + '<div class="ce-semh"><span class="ce-jk">S' + (s.n || i + 1) + '</span>'
        + '<b style="flex:1;min-width:120px">Semaine ' + (s.n || i + 1) + '</b>'
        + ceDel('semaine.' + i, 'Supprimer la semaine') + '</div>'
        + '<div class="ce-grid">'
        + ceF('Du', ceIn('data-s="' + i + '.from"', s.from, '', 'date'))
        + ceF('Au', ceIn('data-s="' + i + '.to"', s.to, '', 'date'))
        + '</div>'
        + '<div class="ce-grid">'
        + ceF('Numéro de semaine', ceIn('data-s="' + i + '.n"', s.n, '', 'number'))
        + ceF('Coach de la séance', ceIn('data-s="' + i + '.coach"', s.coach, 'Adrien / Emily'))
        + '</div>'
        + ceF('Point de focus de la séance', ceTa('data-s="' + i + '.focus"', s.focus, 'Ce qu\'on cherche à obtenir cette semaine.', 'ceSf' + i), null, 'ceSf' + i)
        + '<label style="display:block;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:' + C.muted + ';margin-bottom:6px">Actions de la semaine</label>'
        + acts.map(function (a, k) {
            return '<div class="ce-row act">'
              + ceIn('data-sa="' + i + '.' + k + '.txt"', a.txt, 'Verbe + quoi + comment')
              + ceIn('data-sa="' + i + '.' + k + '.who"', a.who, 'Responsable')
              + ceIn('data-sa="' + i + '.' + k + '.due"', a.due, '', 'date')
              + ceStatut('data-sa="' + i + '.' + k + '.st"', a.st)
              + ceDel('sact.' + i + '.' + k, 'Supprimer l\'action') + '</div>';
          }).join('')
        + ceAdd('sact.' + i, 'Ajouter une action')
        + '</div>';
    });
    if (!(p.semaines || []).length) {
      hs += '<div class="ce-hint" style="margin-bottom:10px">Aucune semaine pour l\'instant.</div>';
    }
    hs += ceAdd('semaine', 'Ajouter une semaine');
    h += ceSection('⚡ Semaines & actions', hs);

    /* 6. Repères chiffrés */
    h += ceSection('🔢 Repères chiffrés du dossier', (function () {
      var s = '';
      (p.chiffres || []).forEach(function (x, i) {
        s += '<div class="ce-row b">'
          + ceIn('data-p="chiffres.' + i + '.label"', x.label, 'Libellé (ex : CA annuel)')
          + ceIn('data-p="chiffres.' + i + '.valeur"', x.valeur, 'Valeur (ex : 480 000 €)')
          + ceDel('chiffres.' + i) + '</div>';
      });
      return s + ceAdd('chiffres', 'Ajouter un repère')
        + '<div class="ce-hint">Uniquement des chiffres réels, donnés par le client. Rien d\'estimé.</div>';
    })(), false);

    /* 7. Ce qu'il nous a dit */
    h += ceSection('💬 Ce qu\'il nous a dit', ceListeTD('ditClient', p.ditClient, 'En une ligne', 'Précision'), false);

    /* 8. Indicateurs */
    h += ceSection('📊 Indicateurs de pilotage', (function () {
      var s = '';
      (p.kpis || []).forEach(function (k, i) {
        var sel = '<select class="ce-i" data-p="kpis.' + i + '.cat">';
        ['Financier', 'Commercial', 'Opérationnel', 'Humain'].forEach(function (c2) {
          sel += '<option value="' + c2 + '"' + (k.cat === c2 ? ' selected' : '') + '>' + c2 + '</option>';
        });
        sel += '</select>';
        s += '<div class="ce-row k">' + sel
          + ceIn('data-p="kpis.' + i + '.nom"', k.nom, 'Indicateur')
          + ceIn('data-p="kpis.' + i + '.freq"', k.freq, 'Suivi')
          + ceIn('data-p="kpis.' + i + '.actuel"', k.actuel, 'Aujourd\'hui')
          + ceIn('data-p="kpis.' + i + '.cible"', k.cible, 'Objectif')
          + ceDel('kpis.' + i) + '</div>';
      });
      return s + ceAdd('kpis', 'Ajouter un indicateur');
    })(), false);

    /* 9. Vigilance */
    h += ceSection('⚠️ Points de vigilance', ceListeTD('risques', p.risques, 'Risque ou frein', 'Précision'), false);

    /* 10. Mémoire de séance — modifiable, c'est ce que relit l'IA */
    h += ceSection('📎 Notes & mémoire de séance', (function () {
      var s = ceF('Dictée / notes libres', ceTa('data-e="vocal"', p.vocal, 'Ce que tu sais du dossier, en vrac.', 'ceVocal'),
        'Repris par l\'IA à chaque régénération ou retouche du plan. Jamais montré au client.', 'ceVocal');
      STEPS.forEach(function (st) {
        s += ceF('Infos collectées — ' + st.t,
          ceTa('data-col="' + st.key + '"', (p.collecte || {})[st.key], '', 'ceCol_' + st.key), null, 'ceCol_' + st.key);
      });
      return s;
    })(), false);

    body.innerHTML = h;
    body.scrollTop = top;
  }

  /* Lit tout le formulaire dans E.plan. Appelé avant chaque ajout/suppression
     et avant l'enregistrement : aucune saisie ne se perd. */
  function editorCollect() {
    var body = document.getElementById('ceBody');
    if (!body || !E.plan) return;
    var p = E.plan;
    var q = function (sel) { return Array.prototype.slice.call(body.querySelectorAll(sel)); };
    var vide = function (o) {
      return !Object.keys(o).some(function (f) { return String(o[f] == null ? '' : o[f]).trim(); });
    };

    /* Champs simples. */
    q('[data-e]').forEach(function (el) {
      var k = el.getAttribute('data-e');
      p[k] = (k === 'vocal') ? el.value : el.value.trim();
    });

    /* Infos collectées. */
    p.collecte = p.collecte || {};
    q('[data-col]').forEach(function (el) { p.collecte[el.getAttribute('data-col')] = el.value.trim(); });

    /* Listes de chaînes. */
    var simples = {};
    q('[data-l]').forEach(function (el) {
      var m = el.getAttribute('data-l').split('.');
      (simples[m[0]] = simples[m[0]] || [])[+m[1]] = el.value.trim();
    });
    Object.keys(simples).forEach(function (k) {
      p[k] = simples[k].filter(function (v) { return v; });
    });

    /* Listes d'objets. */
    var objs = {};
    q('[data-p]').forEach(function (el) {
      var m = el.getAttribute('data-p').split('.');
      objs[m[0]] = objs[m[0]] || [];
      objs[m[0]][+m[1]] = objs[m[0]][+m[1]] || {};
      objs[m[0]][+m[1]][m[2]] = el.value.trim();
    });
    /* Une ligne ne compte que si son champ identifiant est rempli : sinon un
       indicateur créé puis laissé vide se retrouverait dans le tableau du
       client avec une catégorie et une fréquence, mais aucun nom. */
    var CLE = { chiffres: 'label', kpis: 'nom', problemes: 'titre', risques: 'titre', ditClient: 'titre' };
    Object.keys(objs).forEach(function (k) {
      var cle = CLE[k];
      p[k] = objs[k].filter(function (o) {
        if (!o) return false;
        return cle ? !!String(o[cle] || '').trim() : !vide(o);
      });
    });

    /* Jalons : contenu, décalage et statut. */
    p.jalons = p.jalons || {};
    p.jalonStatus = p.jalonStatus || {};
    q('[data-j]').forEach(function (el) {
      var m = el.getAttribute('data-j').split('.'), k = m[0], f = m[1];
      if (f === 'st') {
        p.jalonStatus[k] = STATUT_ORDER.indexOf(el.value) >= 0 ? el.value : 'todo';
        return;
      }
      p.jalons[k] = p.jalons[k] || {};
      if (f === 'j') {
        var n = parseInt(String(el.value).replace(/[^\d]/g, ''), 10);
        /* Champ vide = on retombe sur le repère du programme. 0 reste une
           valeur valide (« dès le premier jour ») → test sur isFinite. */
        if (String(el.value).trim() !== '' && isFinite(n) && n >= 0 && n <= 400) p.jalons[k].j = n;
        else delete p.jalons[k].j;
        return;
      }
      p.jalons[k][f] = el.value.trim();
    });
    var jacts = {};
    q('[data-ja]').forEach(function (el) {
      var m = el.getAttribute('data-ja').split('.');
      (jacts[m[0]] = jacts[m[0]] || [])[+m[1]] = el.value.trim();
    });
    Object.keys(jacts).forEach(function (k) {
      p.jalons[k] = p.jalons[k] || {};
      p.jalons[k].actions = jacts[k].filter(function (v) { return v; });
    });

    /* Semaines et leurs actions. */
    var sem = [];
    q('[data-s]').forEach(function (el) {
      var m = el.getAttribute('data-s').split('.'), i = +m[0];
      sem[i] = sem[i] || { actions: [] };
      sem[i][m[1]] = el.value.trim();
    });
    q('[data-sa]').forEach(function (el) {
      var m = el.getAttribute('data-sa').split('.'), i = +m[0], k = +m[1];
      sem[i] = sem[i] || { actions: [] };
      sem[i].actions = sem[i].actions || [];
      sem[i].actions[k] = sem[i].actions[k] || {};
      sem[i].actions[k][m[2]] = el.value.trim();
    });
    p.semaines = sem.filter(Boolean).map(function (s, i) {
      var n = parseInt(s.n, 10);
      return {
        n: (isFinite(n) && n > 0) ? n : (i + 1),
        from: s.from || '', to: s.to || '', coach: s.coach || '', focus: s.focus || '',
        actions: (s.actions || []).filter(Boolean)
          .filter(function (a) { return String(a.txt || '').trim(); })
          .map(function (a) {
            return {
              txt: a.txt, who: a.who || '', due: a.due || '',
              st: STATUT_ORDER.indexOf(a.st) >= 0 ? a.st : 'todo'
            };
          })
      };
    });
  }

  /* ═════════════════════════════════════════════════════════════════════
     RETOUCHE PAR L'IA — « dis ce que tu veux changer »
     ═══════════════════════════════════════════════════════════════════ */
  function revise(clientId, plan, instructions) {
    var getTok = (window._auth && window._auth.currentUser)
      ? window._auth.currentUser.getIdToken()
      : Promise.reject(new Error('non authentifié'));
    return getTok.then(function (tok) {
      return fetch('/api/coaching-plan-revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({ clientId: clientId, plan: plan, instructions: instructions })
      });
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.ok !== true || !j.plan) {
        var msg = {
          ai_refused: 'Le modèle a refusé de traiter cette demande. Reformule-la.',
          ai_unparsable: 'Réponse inexploitable du modèle. Réessaie en formulant autrement.',
          ai_unavailable: 'Service IA momentanément indisponible. Réessaie dans un instant.',
          ai_not_configured: 'L\'IA n\'est pas configurée sur ce serveur.'
        }[j && j.error] || 'Retouche impossible.';
        throw new Error(msg);
      }
      return j;
    });
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
    var LISTE_PDF = etapes(p);
    var jFin = jOf(p, LISTE_PDF[LISTE_PDF.length - 1]);
    doc.text('Démarrage ' + frDate(p.startDate) + '   ·   Horizon J+' + jFin + ' : ' + frDate(jalonDate(p, jFin)), M, 28.5);
    y = 46;

    /* ── 1. Point A → B ── */
    bloc(1, 'Point A → Point B');
    text('POINT A — AUJOURD\'HUI', M, 8, 'bold', C.muted);
    text(val(p.pointA), M, 10.5, 'normal', isTodo(p.pointA) ? C.muted : C.ink);
    y += 2.5;
    text('POINT B — À J180', M, 8, 'bold', C.muted);
    text(val(p.pointB), M, 10.5, 'normal', isTodo(p.pointB) ? C.muted : C.ink);

    /* Les deux repères longs, discrets, juste après le point B. */
    if (!isTodo(p.horizon12) || !isTodo(p.horizon36)) {
      y += 2;
      if (!isTodo(p.horizon12)) {
        text('DANS 12 MOIS', M, 7.4, 'bold', C.light);
        text(p.horizon12, M, 9, 'italic', C.muted);
      }
      if (!isTodo(p.horizon36)) {
        text('DANS 3 ANS', M, 7.4, 'bold', C.light);
        text(p.horizon36, M, 9, 'italic', C.muted);
      }
    }

    /* ── 2. Verrou ── */
    bloc(2, 'Verrou principal');
    text('VERROU IDENTIFIÉ', M, 8, 'bold', C.muted);
    text(val(p.verrou), M, 10.5, 'normal', isTodo(p.verrou) ? C.muted : C.ink);
    if (!isTodo(p.verrouPlan)) {
      y += 2.5;
      text('CE QU\'ON FAIT POUR LE LEVER', M, 8, 'bold', C.muted);
      text(p.verrouPlan, M, 10, 'normal', C.ink);
    }
    y += 2.5;
    var ordrePdf = (p.organismes && p.organismes.length) ? p.organismes : (p.organisme ? [p.organisme] : []);
    var org = ORGANISMES[ordrePdf[0]];
    text('ORDRE DE TRAITEMENT', M, 8, 'bold', C.muted);
    text(ordrePdf.length
      ? ordrePdf.map(function (k, i) { return (i + 1) + '. ' + (ORGANISMES[k] ? ORGANISMES[k].label : k); }).join('   ')
      : TODO, M, 12, 'bold', ordrePdf.length ? C.main : C.muted);
    y += 1.5;
    if (org) text(org.note, M, 9, 'italic', C.muted);

    /* ── 3. Jalons ── */
    bloc(3, estLegacy(p) ? 'Les 6 jalons datés' : 'Les 5 milestones');
    var cols = [16, 26, 62, 52, 22];
    var xs = [M]; cols.forEach(function (c, i) { xs.push(xs[i] + c); });
    fill(C.ghost); doc.rect(M, y - 4, w, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); color(C.dark);
    [estLegacy(p) ? 'JALON' : 'ÉTAPE', 'REPÈRE', 'CHANTIER', 'VICTOIRE VÉRIFIABLE', 'STATUT'].forEach(function (t, i) { doc.text(t, xs[i] + 1.5, y); });
    y += 5.5;
    LISTE_PDF.forEach(function (j) {
      need(13);
      var st = STATUTS[p.jalonStatus && p.jalonStatus[j.k]] || STATUTS.todo;
      var jj = jOf(p, j);
      doc.setFontSize(8.6);
      /* Titre et preuve du dossier, pas ceux du programme : le PDF doit dire
         exactement ce que le mentor a validé à l'écran. */
      var oL = doc.splitTextToSize(jalonTitre(p, j), cols[2] - 3);
      var pL = doc.splitTextToSize(jalonPreuve(p, j), cols[3] - 3);
      var rows = Math.max(oL.length, pL.length);
      doc.setFont('helvetica', 'bold'); color(C.main); doc.text(j.k, xs[0] + 1.5, y);
      doc.setFont('helvetica', 'normal'); color(C.ink);
      doc.text(frDate(jalonDate(p, jj)), xs[1] + 1.5, y);
      doc.setFontSize(6.8); color(C.muted); doc.text('J+' + jj, xs[1] + 1.5, y + 3.4);
      doc.setFontSize(8.6); color(C.ink); doc.text(oL, xs[2] + 1.5, y);
      color(C.muted); doc.text(pL, xs[3] + 1.5, y);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); color(st.col);
      doc.text(st.lbl, xs[4] + 1.5, y);
      y += Math.max(rows * 3.7, 5.6) + 2.6;
      draw(C.line); doc.setLineWidth(0.15); doc.line(M, y - 1.4, M + w, y - 1.4);
    });
    y += 1.5;
    text(estLegacy(p)
      ? 'Un jalon manqué → analyse de cause avant de continuer. Jamais un simple report.'
      : 'Les échéances sont des moyennes constatées. Ce qui compte n\'est pas la date, c\'est qu\'un milestone soit validé avant d\'ouvrir le suivant.',
      M, 8.4, 'italic', C.muted);

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
    openEditor: openEditor,       // édition manuelle, champ par champ
    revise: revise,               // retouche en langage naturel (IA)
    render: render,
    exportPdf: exportPdf,
    emptyPlan: emptyPlan,
    normalize: normalize,
    voiceSupported: function () { return VOX.supported(); },
    stopVoice: function () { VOX.stop(); },
    cycleStatus: cycle,
    JALONS: JALONS,
    ORGANISMES: ORGANISMES,
    STATUTS: STATUTS
  };
})();
