// ============================================================================
// api/_quizTracking.js — INSTRUMENTATION DES PAGES QUIZ (06/11/2026)
// ----------------------------------------------------------------------------
// Code partagé (une seule source) entre :
//   · api/tunnel-render.js — ajoute la MESURE (abandon question par question,
//     réponses anonymes) à la volée quand il sert une page quiz : aucune
//     écriture dans Storage, rien à lancer à la main, effectif au déploiement ;
//   · scripts/quiz-tracking-patch.js — republie la page avec la mesure ET
//     l'écran prix (CA mensuel ≤ seuil), après dry-run validé.
// Le patch repère dans le <script> de la page : STEPS, go(i[, x]),
// recordQuestion(s), l'objet A et (écran prix) stage. Une page déjà
// instrumentée (« epqTrackQ ») n'est jamais patchée deux fois.
// 10/11/2026 (brief « chiffres justes », T1) : mêmes définitions que la page
// Élite, quelle que soit la page —
//   start + q  à l'AFFICHAGE d'une question (y compris l'écran 1 pré-affiché
//              en HTML, que le démarrage de la page montre sans appeler go() :
//              accroche sur recordQuestion, limitée à l'écran affiché) ;
//   a          quand on QUITTE une question répondue (jamais à l'affichage),
//              uniquement des options du quiz (texte libre → « autre ») ;
//   done       à l'écran qui suit la dernière question.
// Question = type connu (pain, first, multi, single, rating, yesno) ou tout
// écran identifié qui n'est ni info, ni final, ni résultat.
// Tout passe par window.ALTEO.quiz (tunnel-runtime.js) : rien n'est envoyé
// en aperçu (/t/…) ni hors tunnel. Fichier préfixé `_` : hors routing Vercel.
// ============================================================================
'use strict';

module.exports = function quizTracking(opts) {
  opts = opts || {};
  const SEUIL = parseInt(opts.seuil, 10) || 20000;
  const MONTANT = opts.montant || '6 000 €';
  const MARK = 'epqTrackQ';

  /* ── Textes de l'écran prix (affichés en dry-run pour validation) ────── */
  const TXT = {
    kicker: 'Avant d\'aller plus loin',
    title: 'Une précision importante sur l\'investissement',
    body: 'Nos accompagnements s\'adressent à des dirigeants prêts à investir dans leur entreprise : '
      + 'l\'investissement dépasse ' + MONTANT + '. On préfère te le dire dès maintenant, '
      + 'pour que ton rendez-vous soit utile.',
    go: 'C\'est clair, je continue',
    back: 'Modifier ma réponse',
    stop: 'Ce n\'est pas le bon moment pour moi',
    byeTitle: 'Merci pour ta franchise',
    byeBody: 'Quand le moment sera venu, ton diagnostic t\'attendra ici.'
  };

  function jsStr(s) { return JSON.stringify(String(s)); }

  /* ── Code injecté (ES5, même portée que STEPS / A / stage / go) ────────── */
  function helpers(withGate) {
    return [
      '  /* ═════════════ MESURE DU QUIZ (scripts/quiz-tracking-patch.js, 11/2026) ═════════════',
      '     Abandon question par question + réponses (compteurs anonymes) via',
      '     window.ALTEO.quiz — onglet « Qualité leads » du Funnel Sales.',
      '     Écran prix : CA mensuel sous ' + SEUIL + ' € → avertissement avant de continuer. */',
      '  /* Question = écran à réponse : types connus (dont « first », 1re question du quiz Élections),',
      '     ou tout écran identifié qui n\'est ni info, ni final, ni résultat (10/11/2026). */',
      '  var EPQ_QTYPES = { pain: 1, first: 1, multi: 1, single: 1, rating: 1, yesno: 1 };',
      '  var EPQ_NONQ = { info: 1, final: 1, intro: 1, result: 1, results: 1, resultats: 1, form: 1, loading: 1, video: 1, merci: 1 };',
      '  function epqIsQ(s) { return !!(s && s.id && s.type && (EPQ_QTYPES[s.type] || !EPQ_NONQ[s.type])); }',
      '  /* mv : génération de la mesure (2 = 10/11/2026) — ses compteurs ne se mélangent pas avec ceux d\'avant. */',
      '  var EPQ_MV = 2;',
      '  function epqSend(kind, data) { try { data = data || {}; data.mv = EPQ_MV; if (window.ALTEO && typeof window.ALTEO.quiz === \'function\') window.ALTEO.quiz(kind, data); } catch (e) {} }',
      '  function epqQuestions() { var out = []; for (var k = 0; k < STEPS.length; k++) { if (epqIsQ(STEPS[k])) out.push(k); } return out; }',
      '  /* Titre lisible : texte de la question dans STEPS, sinon le titre affiché à l\'écran (h1/h2/h3 de la zone du quiz), sinon l\'identifiant. */',
      '  function epqDomLabel() { try { var root = (typeof stage !== \'undefined\' && stage) || document.getElementById(\'epq\') || document.body; var h = root.querySelector(\'h1, h2, h3, legend, .q-title, .q-q\'); return h ? String(h.textContent || \'\').replace(/\\s+/g, \' \').trim() : \'\'; } catch (e) { return \'\'; } }',
      '  function epqLabel(s) { var t = s && (s.q || s.question || s.title || s.text || s.label || s.t); if (!t && s && typeof s.titleFn === \'function\') { try { t = s.titleFn(); } catch (e) { t = \'\'; } } if (typeof t === \'function\') { try { t = t(); } catch (e) { t = \'\'; } } t = String(t || \'\').replace(/<[^>]*>/g, \'\').replace(/\\s+/g, \' \').trim(); if (!t || /^[a-z0-9_-]+$/i.test(t)) { var d = epqDomLabel(); if (d && d.length > 3) t = d; } return (t || (s && s.id) || \'\').slice(0, 200); }',
      '  function epqQ(idx) { var qs = epqQuestions(), pos = qs.indexOf(idx), s = STEPS[idx]; return { id: (s && s.id) || (\'q\' + idx), i: pos, n: qs.length, label: epqLabel(s) }; }',
      '  /* Options proposées (pour ne jamais envoyer de texte libre) : null si la question n\'en déclare pas. */',
      '  function epqOpts(s) { var o = null; try { o = typeof s.optsFn === \'function\' ? s.optsFn() : s.options; } catch (e) { o = null; } if (!o || !o.length) return null; var out = []; for (var k = 0; k < o.length; k++) { var x = o[k]; out.push(String(x && typeof x === \'object\' ? (x.label || x.t || x.text || x.value || \'\') : x)); } return out; }',
      '  /* Réponse anonyme d\'une question : option(s) du quiz, note « n / 5 », Oui / Non. null = pas répondu. */',
      '  function epqAnswer(s) {',
      '    var v = s.type === \'pain\' ? A.pain : A[s.id];',
      '    if (v == null || v === \'\' || (Array.isArray(v) && !v.length)) return null;',
      '    if (s.type === \'yesno\') return v ? \'Oui\' : \'Non\';',
      '    if (s.type === \'rating\') return String(v) + \' / 5\';',
      '    var opts = epqOpts(s), list = Array.isArray(v) ? v : [v], out = [];',
      '    for (var k = 0; k < list.length; k++) { var x = list[k]; if (x && typeof x === \'object\') x = x.label || x.t || x.text || \'\'; x = String(x == null ? \'\' : x); if (!x) continue; if (opts && opts.indexOf(x) < 0) x = \'(autre réponse)\'; out.push(x); }',
      '    if (!out.length) return null;',
      '    return out.join(\' | \');   // choix multiple : même format que la page Élite',
      '  }',
      '  var epqCurQ = -1, epqLastShown = -1;',
      '  /* On QUITTE une question : sa réponse part si elle existe (jamais à l\'affichage). */',
      '  function epqLeave(toIdx) {',
      '    try { if (epqCurQ < 0 || epqCurQ === toIdx) return; var s = STEPS[epqCurQ], a = s ? epqAnswer(s) : null; if (a != null) epqSend(\'a\', { q: epqQ(epqCurQ), a: a }); } catch (e) {}',
      '    epqCurQ = -1;',
      '  }',
      '  /* Une question S\'AFFICHE : 1re question → start ; chaque question → q. */',
      '  function epqShowQ(i) {',
      '    var qs = epqQuestions(); if (!qs.length) return;',
      '    epqLastShown = i;',
      '    if (epqIsQ(STEPS[i])) { epqCurQ = i; if (qs.indexOf(i) === 0) epqSend(\'start\'); setTimeout(function () { epqSend(\'q\', { q: epqQ(i) }); }, 80); return; }',
      '    if (i > qs[qs.length - 1]) epqSend(\'done\');',
      '  }',
      '  /* Tête de go(i) : quitte la question en cours, puis affiche i. */',
      '  function ' + MARK + '(i) { epqLeave(i); epqShowQ(i); }',
      '  /* Tête de recordQuestion(s) : couvre l\'écran 1 pré-affiché en HTML, dont le démarrage n\'appelle pas go().',
      '     Ignoré pour tout écran qui n\'est pas celui affiché (ex. STEPS.forEach(recordQuestion) des résultats). */',
      '  function epqShown(s) {',
      '    try { var i = STEPS.indexOf(s); if (i < 0 || i === epqCurQ || i === epqLastShown) return; if (typeof cur !== \'undefined\' && STEPS[cur] !== s) return; epqLeave(i); epqShowQ(i); } catch (e) {}',
      '  }',
      withGate ? gateCode() : '  function epqGate() { return false; }',
      ''
    ].join('\n');
  }

  function gateCode() {
    return [
      '  var EPQ_SEUIL = ' + SEUIL + ', epqGateOk = false;',
      '  /* CA mensuel « bas » : plus grand montant de la réponse ≤ seuil, ou « moins de… »,',
      '     ou pas encore de CA. « Plus de… » n\'est jamais bas. */',
      '  function epqLowCa(label) {',
      '    var s = String(label || \'\').toLowerCase();',
      '    if (/pas encore|aucun|^\\s*0\\s*€/.test(s)) return true;',
      '    if (/plus de|au-dessus|sup[ée]rieur|>/.test(s)) return false;',
      '    var t = s.replace(/[\\s\\u00a0\\u202f.]/g, \'\'), re = /(\\d+(?:,\\d+)?)(k|m)?/g, m, max = -1;',
      '    while ((m = re.exec(t))) { var n = parseFloat(m[1].replace(\',\', \'.\')); if (m[2] === \'k\') n *= 1000; if (m[2] === \'m\') n *= 1000000; if (n > max) max = n; }',
      '    return max >= 0 && max <= EPQ_SEUIL;',
      '  }',
      '  function epqCaIdx() { for (var k = 0; k < STEPS.length; k++) { if (STEPS[k] && STEPS[k].id === \'ca_mensuel\') return k; } return -1; }',
      '  function epqGate(i, resume) {',
      '    var ci = epqCaIdx();',
      '    if (epqGateOk || ci < 0 || i <= ci || typeof stage === \'undefined\' || !stage) return false;',
      '    if (!epqLowCa(A.ca_mensuel)) return false;',
      '    epqSend(\'gate\', { g: \'shown\' });',
      '    stage.innerHTML = \'<div class="r-wrap epq-gate"><div class="epq-gate-k">\' + ' + jsStr(TXT.kicker) + ' + \'</div>\'',
      '      + \'<h2 class="epq-gate-t">\' + ' + jsStr(TXT.title) + ' + \'</h2>\'',
      '      + \'<p class="epq-gate-p">\' + ' + jsStr(TXT.body) + ' + \'</p>\'',
      '      + \'<div class="r-center"><a href="#" class="q-cta" data-epq-gate="go">\' + ' + jsStr(TXT.go) + ' + \' →</a></div>\'',
      '      + \'<div class="epq-gate-links"><a href="#" data-epq-gate="back">\' + ' + jsStr(TXT.back) + ' + \'</a> · <a href="#" data-epq-gate="stop">\' + ' + jsStr(TXT.stop) + ' + \'</a></div></div>\';',
      '    stage.onclick = function (ev) {',
      '      var el = ev.target && ev.target.closest ? ev.target.closest(\'[data-epq-gate]\') : null;',
      '      if (!el) return;',
      '      ev.preventDefault(); stage.onclick = null;',
      '      var act = el.getAttribute(\'data-epq-gate\');',
      '      if (act === \'go\') { epqGateOk = true; epqSend(\'gate\', { g: \'continue\' }); resume(); }',
      '      else if (act === \'back\') { go(ci, true); }',
      '      else { epqSend(\'gate\', { g: \'exit\' }); stage.innerHTML = \'<div class="r-wrap epq-gate"><h2 class="epq-gate-t">\' + ' + jsStr(TXT.byeTitle) + ' + \' 🙏</h2><p class="epq-gate-p">\' + ' + jsStr(TXT.byeBody) + ' + \'</p></div>\'; }',
      '    };',
      '    return true;',
      '  }'
    ].join('\n');
  }

  const GATE_CSS = [
    '#epq .epq-gate{max-width:560px;margin:0 auto;text-align:center}',
    '#epq .epq-gate-k{font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.7;margin-bottom:10px}',
    '#epq .epq-gate-t{font-size:24px;line-height:1.25;margin:0 0 14px}',
    '#epq .epq-gate-p{font-size:16px;line-height:1.6;opacity:.9;margin:0 0 6px}',
    '#epq .epq-gate-links{margin-top:16px;font-size:13.5px;opacity:.75}',
    '#epq .epq-gate-links a{color:inherit;text-decoration:underline}'
  ].join('\n');

  /* ── Patch d'une page ──────────────────────────────────────────────────── */
  function patchPage(html, withGate) {
    if (html.indexOf(MARK) >= 0) return { html: html, changed: false, note: 'déjà instrumentée' };
    const notes = [];
    if (!/\bSTEPS\b/.test(html) || html.indexOf('recordQuestion(') < 0) {
      return { html: html, changed: false, skip: true, note: 'pas un quiz (STEPS / recordQuestion absents)' };
    }
    const reGo = /function go\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*\{/g;
    const goHits = html.match(reGo) || [];
    if (goHits.length !== 1) throw new Error('function go( trouvée ' + goHits.length + ' fois');
    const reRq = /function recordQuestion\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
    const rqHits = html.match(reRq) || [];
    if (rqHits.length !== 1) throw new Error('function recordQuestion( trouvée ' + rqHits.length + ' fois');

    let gate = withGate;
    if (gate && !/(?:var|let|const)\s+stage\b/.test(html)) { gate = false; notes.push('⚠ variable stage introuvable : écran prix NON ajouté'); }
    if (gate && html.indexOf('ca_mensuel') < 0) { gate = false; notes.push('⚠ question ca_mensuel absente : écran prix NON ajouté'); }
    if (!/(?:var|let|const)\s+A\s*=/.test(html)) notes.push('⚠ objet A introuvable : les réponses ne seront pas comptées (abandon oui)');

    const mGo = /function go\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*\{/.exec(html);
    const iVar = mGo[1], second = mGo[2];
    const resumeCall = 'go(' + iVar + (second ? ', ' + second : '') + ')';
    const injectGo = mGo[0] + '\n    if (epqGate(' + iVar + ', function () { ' + resumeCall + '; })) return;\n    ' + MARK + '(' + iVar + ');';
    let out = html.slice(0, mGo.index) + helpers(gate) + '\n  ' + injectGo + html.slice(mGo.index + mGo[0].length);

    const mRq = /function recordQuestion\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(out);
    out = out.slice(0, mRq.index) + mRq[0] + '\n    epqShown(' + mRq[1] + ');' + out.slice(mRq.index + mRq[0].length);

    if (gate) {
      const cssAnchor = '</style>';
      const c = out.split(cssAnchor).length - 1;
      if (c < 1) throw new Error('aucune balise </style> pour le CSS de l\'écran prix');
      const at = out.indexOf(cssAnchor);
      out = out.slice(0, at) + GATE_CSS + '\n' + out.slice(at);
    }
    notes.unshift('go(' + iVar + (second ? ', ' + second : '') + ') + recordQuestion(' + mRq[1] + ') instrumentés' + (gate ? ' · écran prix sous ' + SEUIL + ' €' : ' · sans écran prix'));
    return { html: out, changed: true, note: notes.join(' · '), gate: gate };
  }

  /* Chaque <script> inline de la page doit se parser. */
  function checkScripts(html) {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, n = 0;
    while ((m = re.exec(html))) {
      if (/type="application\/(ld\+)?json"/i.test(m[0])) continue;
      n++;
      new Function(m[1]);
    }
    return n;
  }

  return { patchPage: patchPage, checkScripts: checkScripts, TXT: TXT, MARK: MARK, SEUIL: SEUIL };
};

/* Mesure seule, pour le rendu à la volée : jamais d'exception, jamais de
   changement visible. Renvoie le HTML d'origine si la page n'est pas un quiz
   reconnu ou déjà instrumentée. */
let _measureOnly = null;
module.exports.instrument = function instrument(html) {
  try {
    if (!html || html.indexOf('recordQuestion(') < 0 || html.indexOf('epqTrackQ') >= 0) return html;
    if (!_measureOnly) _measureOnly = module.exports({});
    const r = _measureOnly.patchPage(html, false);
    if (!r.changed) return html;
    _measureOnly.checkScripts(r.html);   // lève si un bloc ne se parse plus → page d'origine
    return r.html;
  } catch (e) {
    console.warn('[quiz-tracking] page servie sans mesure :', e && e.message);
    return html;
  }
};
