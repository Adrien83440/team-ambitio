// ============================================================================
// coaching-gemini-core.js — LECTURE DES FICHIERS MEET DES COACHINGS 1:1
// ----------------------------------------------------------------------------
// Partagé navigateur ↔ serveur (même motif que bp-credits.js) :
//   · coaching.html (<script>) : scan Drive manuel « 🔍 Chercher les résumés »
//   · api/_coachingAutoSync.js (require) : synchro automatique 6 h / 19 h
// Les deux chemins lisent donc les fichiers EXACTEMENT de la même façon.
//
// Un coaching individuel enregistré par coaching@adrienemily.com produit dans
// son Drive jusqu'à trois fichiers qui partagent le même titre de base :
//   « Coaching 1:1 Business Elite — Sébastien BELLE ANNE - 2026/05/13 10:00 CEST - Notes par Gemini »
//   « … - Recording »   (la vidéo, publiée parfois plusieurs heures après)
//   « … - Chat »        (le chat du Meet : ignoré)
// Ancien format : « Coaching 1:1 Business with Belinda GIANGIULIO - 2026/05/12 … ».
//
// CONTENU GARDÉ (décision Adrien du 16/11/2026) : le RÉSUMÉ et les DÉTAILS
// des notes Gemini (+ les étapes suivantes, courtes). JAMAIS la transcription
// intégrale : la lecture s'arrête à la section « Transcription ».
//
// AUCUNE dépendance : ni Firebase, ni DOM. ES5 strict.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoachingGemini = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  var RESUME_MAX = 1500;     // champ « Résumé » de la séance (visible, éditable)
  var SYNTHESE_MAX = 8000;   // driveSummary : lu par le copilote et le Scribe

  function normName(n) {
    return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Score de ressemblance entre deux noms (même barème que le scan manuel
  // historique) : 10 par mot identique, 5 par préfixe, 3 par inclusion.
  function scoreNom(a, b) {
    var pa = normName(a).split(' ').filter(function (p) { return p.length > 2; });
    var pb = normName(b).split(' ').filter(function (p) { return p.length > 2; });
    var score = 0;
    for (var i = 0; i < pa.length; i++) {
      for (var j = 0; j < pb.length; j++) {
        if (pa[i] === pb[j]) score += 10;
        else if (pb[j].indexOf(pa[i]) === 0 || pa[i].indexOf(pb[j]) === 0) score += 5;
        else if (pb[j].indexOf(pa[i]) >= 0 || pa[i].indexOf(pb[j]) >= 0) score += 3;
      }
    }
    return score;
  }

  // Lit un titre de fichier Drive. Renvoie toujours un objet :
  //   { ok, raison, nomClient, date 'AAAA-MM-JJ', heure 'HH:MM', baseTitle,
  //     type 'coaching' | 'rdv72h', video, chat }
  // ok=false → raison : 'pas_coaching' | 'groupe' | 'chat' | 'nom_illisible'
  function lireTitre(titre, estVideo) {
    var t = String(titre || '');
    var out = { ok: false, raison: '', nomClient: '', date: null, heure: null, baseTitle: '', type: 'coaching', video: !!estVideo, chat: false };
    if (!/coaching 1:1|rdv urgent|post inscription/i.test(t)) { out.raison = 'pas_coaching'; return out; }
    if (/coaching gr/i.test(t)) { out.raison = 'groupe'; return out; }
    if (/-\s*chat\s*$/i.test(t)) { out.chat = true; out.raison = 'chat'; return out; }
    if (estVideo && !/recording|enregistrement/i.test(t)) { out.raison = 'pas_coaching'; return out; }

    var nom = null;
    var m = t.match(/with\s+(.+?)\s*-\s*\d{4}/i) || t.match(/with\s+(.+?)(?:\s*-|$)/i);
    if (m) nom = m[1];
    else {
      m = t.match(/[—–]\s*(.+?)\s*-\s*\d{4}/) || t.match(/[—–]\s*(.+?)(?:\s*-\s*\d|$)/);
      if (m) nom = m[1];
    }
    if (!nom || !normName(nom)) { out.raison = 'nom_illisible'; return out; }

    var d = t.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{1,2})[:h](\d{2}))?/);
    out.date = d ? d[1] + '-' + d[2] + '-' + d[3] : null;
    out.heure = d && d[4] ? ('0' + d[4]).slice(-2) + ':' + d[5] : null;
    out.nomClient = String(nom).trim();
    out.baseTitle = t.replace(/\s*-\s*(notes par gemini|notes by gemini|recording|enregistrement|chat)\s*$/i, '').trim();
    out.type = /rdv urgent|post inscription/i.test(t) ? 'rdv72h' : 'coaching';
    out.ok = true;
    return out;
  }

  // Écart en minutes entre deux heures 'HH:MM' (null si l'une manque).
  function ecartMinutes(h1, h2) {
    var a = /^(\d{1,2}):(\d{2})/.exec(String(h1 || ''));
    var b = /^(\d{1,2}):(\d{2})/.exec(String(h2 || ''));
    if (!a || !b) return null;
    return Math.abs((Number(a[1]) * 60 + Number(a[2])) - (Number(b[1]) * 60 + Number(b[2])));
  }

  // Titres de section des notes Gemini (FR / EN).
  var RE_RESUME = /^(r[ée]sum[ée]|summary|vue d.ensemble|overview)\s*:?$/i;
  var RE_DETAILS = /^(d[ée]tails|details)\s*:?$/i;
  var RE_ETAPES = /^([ée]tapes suivantes( sugg[ée]r[ée]es)?|next steps|suggested next steps|action items|actions? [àa] mener)\s*:?$/i;
  var RE_FIN = /^(transcription|transcript|transcript[ie]on compl[èe]te)\b/i;

  // Notes Gemini (texte brut) → { resume, synthese }
  //   resume   : la section Résumé seule (champ visible de la séance)
  //   synthese : Résumé + Détails + Étapes suivantes, sans la transcription
  function extraireNotes(texte) {
    if (!texte) return { resume: '', synthese: '' };
    var lignes = String(texte).replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/\s+$/, ''); });
    var sections = { resume: [], details: [], etapes: [] };
    var cur = null;
    var vuTitre = false;
    for (var i = 0; i < lignes.length; i++) {
      var brut = lignes[i];
      var l = brut.trim();
      if (!l) { if (cur && sections[cur].length) sections[cur].push(''); continue; }
      if (RE_FIN.test(l)) break;
      if (RE_RESUME.test(l)) { cur = 'resume'; vuTitre = true; continue; }
      if (RE_DETAILS.test(l)) { cur = 'details'; vuTitre = true; continue; }
      if (RE_ETAPES.test(l)) { cur = 'etapes'; vuTitre = true; continue; }
      if (cur) sections[cur].push(l);
    }
    function bloc(arr) { return arr.join('\n').replace(/\n{3,}/g, '\n\n').trim(); }
    var resume = bloc(sections.resume);
    var details = bloc(sections.details);
    var etapes = bloc(sections.etapes);

    // Document sans titres reconnus : repli historique (premières lignes longues).
    if (!vuTitre || (!resume && !details)) {
      var longues = lignes.map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 20 && !RE_FIN.test(x); });
      resume = longues.slice(0, 4).join('\n');
      details = longues.slice(4, 60).join('\n');
    }

    var parts = [];
    if (resume) parts.push('Résumé\n' + resume);
    if (details) parts.push('Détails\n' + details);
    if (etapes) parts.push('Étapes suivantes\n' + etapes);
    return {
      resume: resume.substring(0, RESUME_MAX),
      synthese: parts.join('\n\n').substring(0, SYNTHESE_MAX),
    };
  }

  return {
    normName: normName,
    scoreNom: scoreNom,
    lireTitre: lireTitre,
    ecartMinutes: ecartMinutes,
    extraireNotes: extraireNotes,
    RESUME_MAX: RESUME_MAX,
    SYNTHESE_MAX: SYNTHESE_MAX,
  };
}));
