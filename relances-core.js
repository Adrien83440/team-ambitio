/* ═══════════════════════════════════════════════════════════════════════
   relances-core.js — LES RÈGLES DU MODULE « RELANCES » (12/11/2026)
   ───────────────────────────────────────────────────────────────────────
   Partagé navigateur (admin-relances.html → window.RelancesCore) et serveur
   (api/_relances.js, api/relances-cron.js → require('../relances-core.js')).
   Une seule copie des règles : l'aperçu d'un segment à l'écran et la liste
   réellement inscrite au lancement ne peuvent pas diverger.

   Contenu :
     · EXCLUSIONS automatiques, non désactivables (exclusion(l, ctx)) ;
     · FILTRES combinables d'un segment (filtrer(l, f, ctx)) ;
     · CALENDRIER : heure de Paris, plage 9 h – 19 h, jamais le dimanche ni
       un jour férié (règle de la prospection commerciale par SMS) ;
     · DÉTECTEUR DE PRIX (contientPrix) : le setter n'annonce jamais de
       tarif — aucun texte qui en contient un ne peut partir ;
     · VARIABLES : {{prenom}}, {{setter}}, {{lien_rdv}}, {{lien_stop}}.

   AUCUNE dépendance : ni Firebase, ni DOM. ES5 strict.
   La colonne Pipeline vient de pipeline-etapes.js, passé dans ctx.E (le
   serveur le charge dans un bac vm, la page l'a en window.PipelineEtapes).
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelancesCore = factory();
}(this, function () {
  'use strict';

  var JOUR_MS = 864e5;

  /* ── Valeurs par défaut de _config/relances ─────────────────────────── */
  var DEFAUTS = {
    modeTest: true,          // tant que vrai : AUCUN envoi vers un lead
    testTelephone: '',
    testEmail: '',
    plafondJour: 100,        // nouveaux leads entrés en séquence par jour
    heureDebut: 9,
    heureFin: 19,
    coutWhatsapp: 0.11,      // € par modèle Marketing (France) — réglable
    coutSms: 0.08,           // € par SMS (1 segment) — réglable
    coutEmail: 0,
    emailCompte: 'strategie',
    setterRepli: '',         // slug du setter dont on prend le lien si besoin
    pauseSiQualiteRouge: true
  };

  /* ── Statuts / étapes ───────────────────────────────────────────────── */
  var STATUTS = [
    { id: 'nouveau', t: 'Nouveau' }, { id: 'nrp1', t: 'NRP 1' }, { id: 'nrp2', t: 'NRP 2' },
    { id: 'nrp3', t: 'NRP 3' }, { id: 'all_nrp', t: 'All NRP' }, { id: 'follow_up_pm', t: 'Follow-up' },
    { id: 'appele', t: 'Appelé' }, { id: 'messagerie', t: 'Messagerie' }, { id: 'decroche', t: 'Décroché' }
  ];

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[àâä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[îï]/g, 'i')
      .replace(/[ôö]/g, 'o').replace(/[ùûü]/g, 'u').replace(/ç/g, 'c').trim();
  }

  /* ── Dates ──────────────────────────────────────────────────────────── */
  function msDe(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return 0; } }
      if (typeof v.seconds === 'number') return v.seconds * 1000;
      if (typeof v._seconds === 'number') return v._seconds * 1000;
      return 0;
    }
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }

  /* Heure de Paris d'un instant, sans dépendre du fuseau de la machine. */
  function paris(ms) {
    var f = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var jours = { 'dim.': 0, 'lun.': 1, 'mar.': 2, 'mer.': 3, 'jeu.': 4, 'ven.': 5, 'sam.': 6 };
    return {
      ymd: o.year + '-' + o.month + '-' + o.day,
      h: +o.hour, mi: +o.minute,
      dow: jours[o.weekday] != null ? jours[o.weekday] : new Date(ms).getUTCDay()
    };
  }
  function aujourdhui(ms) { return paris(ms == null ? Date.now() : ms).ymd; }

  /* Jour de la semaine d'une date AAAA-MM-JJ (0 = dimanche). Midi UTC : aucun
     changement d'heure ne peut faire basculer d'un jour. */
  function dowYmd(ymd) {
    var p = String(ymd).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).getUTCDay();
  }
  function decaler(ymd, n) {
    var p = String(ymd).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12) + n * JOUR_MS);
    return d.toISOString().slice(0, 10);
  }

  /* Jours fériés français (métropole). Pâques par l'algorithme de Butcher. */
  var _feries = {};
  function feries(annee) {
    if (_feries[annee]) return _feries[annee];
    var a = annee % 19, b = Math.floor(annee / 100), c = annee % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      mois = Math.floor((h + l - 7 * m + 114) / 31), jour = ((h + l - 7 * m + 114) % 31) + 1;
    var paques = annee + '-' + (mois < 10 ? '0' : '') + mois + '-' + (jour < 10 ? '0' : '') + jour;
    var s = {};
    ['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].forEach(function (x) { s[annee + '-' + x] = 1; });
    s[decaler(paques, 1)] = 1;   // lundi de Pâques
    s[decaler(paques, 39)] = 1;  // Ascension
    s[decaler(paques, 50)] = 1;  // lundi de Pentecôte
    _feries[annee] = s;
    return s;
  }
  function estFerie(ymd) { return !!feries(+String(ymd).slice(0, 4))[ymd]; }
  function jourOuvre(ymd) { return dowYmd(ymd) !== 0 && !estFerie(ymd); }
  /* Premier jour d'envoi possible à partir de ymd inclus. */
  function prochainJourOuvre(ymd) {
    var d = ymd, garde = 0;
    while (!jourOuvre(d) && garde++ < 10) d = decaler(d, 1);
    return d;
  }
  /* J+n calendaires, reporté au prochain jour d'envoi possible. */
  function jourEtape(ymdDepart, delaiJours) {
    return prochainJourOuvre(decaler(ymdDepart, Math.max(0, +delaiJours || 0)));
  }
  /* Le k-ième jour d'envoi d'une campagne (k = 1 → dateDebut, reporté). */
  function jourCampagne(dateDebut, k) {
    var d = prochainJourOuvre(dateDebut);
    for (var i = 1; i < k; i++) d = prochainJourOuvre(decaler(d, 1));
    return d;
  }
  /* L'instant est-il dans la plage d'envoi ? */
  function ouvert(ms, cfg) {
    cfg = cfg || DEFAUTS;
    var p = paris(ms);
    if (!jourOuvre(p.ymd)) return false;
    var deb = +cfg.heureDebut || DEFAUTS.heureDebut, fin = +cfg.heureFin || DEFAUTS.heureFin;
    return p.h >= deb && p.h < fin;
  }
  /* Instant UTC correspondant à AAAA-MM-JJ hh:00 heure de Paris. */
  function instantParis(ymd, heure) {
    var p = String(ymd).split('-');
    var guess = Date.UTC(+p[0], +p[1] - 1, +p[2], heure, 0);
    for (var i = 0; i < 3; i++) {
      var q = paris(guess);
      var ecart = ((q.ymd === ymd ? 0 : (q.ymd < ymd ? -24 : 24)) + q.h - heure) * 3600000 + q.mi * 60000;
      if (!ecart) break;
      guess -= ecart;
    }
    return guess;
  }
  /* Minutes de plage restantes aujourd'hui (0 si fermé). */
  function minutesRestantes(ms, cfg) {
    cfg = cfg || DEFAUTS;
    if (!ouvert(ms, cfg)) return 0;
    var p = paris(ms);
    return Math.max(0, (+cfg.heureFin || DEFAUTS.heureFin) * 60 - (p.h * 60 + p.mi));
  }

  /* ── Lecture d'un lead ──────────────────────────────────────────────── */
  function provenance(l) {
    return (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || l.source || 'autre';
  }
  function dateEntree(l) {
    var c = [msDe(l.dateWebinaire), msDe(l.importedCreatedAt), msDe(l.createdAt)].filter(function (x) { return x > 0; });
    return c.length ? Math.min.apply(null, c) : 0;
  }
  function prenom(l) {
    var p = String(l.prenom || '').trim();
    if (!p) p = String(l.nom || l.fullName || '').trim().split(/\s+/)[0] || '';
    if (!p) return '';
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }
  function telephoneE164(raw) {
    if (!raw) return null;
    var n = String(raw).replace(/[\s\-().]/g, ''), e = null;
    if (n.charAt(0) === '+') e = n;
    else if (n.slice(0, 2) === '00') e = '+' + n.slice(2);
    else if (n.charAt(0) === '0' && n.length === 10) e = '+33' + n.slice(1);
    else if (n.slice(0, 2) === '33' && n.length >= 11) e = '+' + n;
    if (!e) return null;
    if (/^\+330\d{9}$/.test(e)) e = '+33' + e.slice(4);
    return /^\+\d{10,15}$/.test(e) ? e : null;
  }
  function estClient(l) {
    return l.isClient === true || l.status === 'client' || l.stage === 'closed_won_setting' || l.stage === 'closed_won_self';
  }

  /* ── EXCLUSIONS — non désactivables ─────────────────────────────────────
     ctx = { rdvAVenir:{leadId:1}, bloques:{leadId:1}, exclus:{leadId:motif},
             enSequence:{leadId:campagneId}, canaux:['whatsapp','sms','email'] }
     Renvoie le motif (texte court) ou null. */
  var MOTIFS = {
    fusionne: 'Fiche fusionnée', client: 'Client', faux_numero: 'Faux numéro / poubelle',
    disqualifie: 'Disqualifié', pas_interesse: 'Pas intéressé', stop: 'A répondu STOP',
    relance_exclu: 'Exclu définitivement des relances', rdv: 'RDV à venir', bloque: 'Contact bloqué',
    en_sequence: 'Déjà dans une autre séquence', sans_coordonnees: 'Ni téléphone ni e-mail exploitable'
  };
  function exclusion(l, ctx) {
    ctx = ctx || {};
    var id = l.id;
    if (l._merged === true) return 'fusionne';
    if (estClient(l)) return 'client';
    if (l.stage === 'faux_numero' || l.status === 'faux_numero' || l.stage === 'poubelle' || l.status === 'poubelle') return 'faux_numero';
    if (l.stage === 'disqualification' || l.stage === 'disqualifie_closing' || l.status === 'disqualifie') return 'disqualifie';
    if (l.status === 'pas_interesse' || l.stage === 'closed_lost') return 'pas_interesse';
    if (l.smsOptedOut === true || l.smsOptOut === true) return 'stop';
    if (ctx.exclus && ctx.exclus[id]) return 'relance_exclu';
    if (ctx.bloques && ctx.bloques[id]) return 'bloque';
    if (ctx.rdvAVenir && ctx.rdvAVenir[id]) return 'rdv';
    if (ctx.enSequence && ctx.enSequence[id]) return 'en_sequence';
    if (!telephoneE164(l.telephone) && !String(l.email || '').trim()) return 'sans_coordonnees';
    return null;
  }

  /* ── FILTRES d'un segment ───────────────────────────────────────────────
     f = { statuts:[], etapes:[] (colonnes Pipeline), provenances:[] (texte
           contenu, sans accent ni casse), entreDu, entreAu (AAAA-MM-JJ),
           contactAvant, contactApres (AAAA-MM-JJ), setters:[slugs],
           scoreMin, scoreMax (0-100), sansScore (bool, défaut vrai) }
     Tous les critères renseignés doivent être vrais (ET) ; à l'intérieur
     d'une liste, un seul suffit (OU). */
  function ymdMs(ymd, finDeJour) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return 0;
    return instantParis(ymd, 0) + (finDeJour ? JOUR_MS : 0);
  }
  function filtrer(l, f, ctx) {
    f = f || {};
    ctx = ctx || {};
    if (f.statuts && f.statuts.length && f.statuts.indexOf(l.status || 'nouveau') < 0) return false;
    if (f.etapes && f.etapes.length) {
      if (!ctx.E) return false;
      var col = ctx.E.classify(l, (ctx.rdvs && ctx.rdvs[l.id]) || [], {}).col;
      if (f.etapes.indexOf(col) < 0) return false;
    }
    if (f.provenances && f.provenances.length) {
      var p = norm(provenance(l));
      if (!f.provenances.some(function (x) { return x && p.indexOf(norm(x)) >= 0; })) return false;
    }
    var e = dateEntree(l);
    if (f.entreDu && (!e || e < ymdMs(f.entreDu))) return false;
    if (f.entreAu && (!e || e >= ymdMs(f.entreAu, true))) return false;
    var c = msDe(l.lastContactAt);
    if (f.contactAvant && c && c >= ymdMs(f.contactAvant, true)) return false;
    if (f.contactApres && (!c || c < ymdMs(f.contactApres))) return false;
    if (f.setters && f.setters.length && f.setters.indexOf(l.assignedTo || '') < 0) return false;
    var s = l.aiLead && typeof l.aiLead.proba === 'number' ? l.aiLead.proba : null;
    var avecScore = (f.scoreMin !== '' && f.scoreMin != null) || (f.scoreMax !== '' && f.scoreMax != null);
    if (avecScore) {
      if (s === null) return f.sansScore !== false;
      if (f.scoreMin !== '' && f.scoreMin != null && s < +f.scoreMin) return false;
      if (f.scoreMax !== '' && f.scoreMax != null && s > +f.scoreMax) return false;
    }
    return true;
  }

  /* ── Répartition d'une vague sur ses jours ──────────────────────────── */
  function repartir(n, jours) {
    var j = (jours && jours.length) ? jours : [1];
    var out = [], base = Math.floor(n / j.length), reste = n % j.length;
    for (var i = 0; i < j.length; i++) out.push({ jour: j[i], nb: base + (i < reste ? 1 : 0) });
    return out;
  }

  /* ── DÉTECTEUR DE PRIX ──────────────────────────────────────────────── */
  var PRIX = [
    /€/, /\beur(o|os)?\b/i, /\bprix\b/i, /\btarif/i, /\bco[uû]te?\b/i, /\bco[uû]ts?\b/i,
    /\d\s?k\b/i, /\bHT\b/, /\bTTC\b/, /\bmensualit/i, /\bpar mois\b/i, /\b\d+\s?(x|fois)\s?\d+/i,
    /\bremise\b/i, /\bpromo/i, /\bgratuit/i, /\binvestissement\b/i, /\$/
  ];
  function contientPrix(texte) {
    var t = String(texte || '');
    for (var i = 0; i < PRIX.length; i++) if (PRIX[i].test(t)) return t.match(PRIX[i])[0];
    return null;
  }

  /* ── Variables ──────────────────────────────────────────────────────── */
  var VARIABLES = ['prenom', 'setter', 'lien_rdv', 'lien_stop'];
  function remplir(texte, v) {
    v = v || {};
    return String(texte || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) {
      return v[k] != null && v[k] !== '' ? String(v[k]) : (k === 'prenom' ? '' : m);
    }).replace(/Bonjour\s+,/g, 'Bonjour,').replace(/[ \t]{2,}/g, ' ');
  }
  function variablesInconnues(texte) {
    var out = [], re = /\{\{\s*([a-z_0-9]+)\s*\}\}/g, m;
    while ((m = re.exec(String(texte || ''))) !== null) if (VARIABLES.indexOf(m[1]) < 0 && out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }

  /* ── Une étape est-elle complète ? (message d'erreur ou null) ───────── */
  function verifierEtape(e, i) {
    var n = 'Étape ' + (i + 1) + ' : ';
    if (!e) return n + 'vide';
    if (e.canal === 'whatsapp') {
      if (!e.modele) return n + 'choisis un modèle WhatsApp approuvé';
      if (e.enteteFormat === 'VIDEO' && !/^https:\/\//.test(String(e.videoUrl || ''))) return n + 'le modèle a un en-tête vidéo : indique l\'URL https de la vidéo';
      var p = contientPrix(e.corpsModele || '');
      if (p) return n + 'le modèle contient un élément de prix (« ' + p + ' »)';
    } else if (e.canal === 'sms') {
      if (!String(e.texte || '').trim()) return n + 'texte du SMS vide';
      if (contientPrix(e.texte)) return n + 'le SMS contient un élément de prix (« ' + contientPrix(e.texte) + ' »)';
      if (variablesInconnues(e.texte).length) return n + 'variable inconnue {{' + variablesInconnues(e.texte)[0] + '}}';
    } else if (e.canal === 'email') {
      if (!String(e.objet || '').trim() || !String(e.texte || '').trim()) return n + 'objet et texte de l\'e-mail requis';
      var pe = contientPrix(e.objet + ' ' + e.texte);
      if (pe) return n + 'l\'e-mail contient un élément de prix (« ' + pe + ' »)';
      if (variablesInconnues(e.objet + ' ' + e.texte).length) return n + 'variable inconnue {{' + variablesInconnues(e.objet + ' ' + e.texte)[0] + '}}';
    } else return n + 'canal inconnu';
    if (i > 0 && !(+e.delaiJours > 0)) return n + 'délai depuis J0 requis (en jours)';
    return null;
  }
  /* Empreinte d'une séquence : le test réussi n'est valable que pour CETTE
     séquence exacte. Modifier un texte, un délai ou un modèle l'invalide. */
  function empreinte(etapes) {
    var s = JSON.stringify((etapes || []).map(function (e) {
      return [e.canal, +e.delaiJours || 0, e.modele || '', e.langue || '', e.videoUrl || '', e.texte || '', e.objet || '', (e.parametres || []).join('|')];
    }));
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'v' + (h >>> 0).toString(36) + '-' + s.length;
  }

  /* ── SMS : alphabet GSM-7 ou Unicode, et nombre de segments facturés ──
     Un seul « ê », « ’ » ou « » » fait passer TOUT le SMS en Unicode :
     70 caractères par segment au lieu de 160, donc le coût double. */
  var GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  var GSM7_EXT = '^{}\\[~]|€';
  function segmentsSms(texte) {
    var t = String(texte || ''), unicode = false, n = 0;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (GSM7.indexOf(ch) >= 0) n += 1;
      else if (GSM7_EXT.indexOf(ch) >= 0) n += 2;
      else { unicode = true; break; }
    }
    if (unicode) { n = t.length; return { unicode: true, longueur: n, segments: n <= 70 ? 1 : Math.ceil(n / 67) }; }
    return { unicode: false, longueur: n, segments: n <= 160 ? 1 : Math.ceil(n / 153) };
  }
  /* Texte d'un SMS tel qu'il partira, avec des valeurs de longueur typique
     (un lien court fait 37 caractères), pour estimer les segments. */
  function smsTypique(texte) {
    return remplir(texte, { prenom: 'Stephanie', setter: 'Valentin', lien_rdv: 'https://team.alteore.com/r/AbCdEfGhIj',
      lien_stop: 'https://team.alteore.com/r/AbCdEfGhIk' });
  }

  /* ── Coût estimé ────────────────────────────────────────────────────── */
  function coutEstime(nbLeads, etapes, cfg) {
    cfg = cfg || DEFAUTS;
    var u = { whatsapp: +cfg.coutWhatsapp || 0, sms: +cfg.coutSms || 0, email: +cfg.coutEmail || 0 };
    var parLead = 0;
    (etapes || []).forEach(function (e) {
      if (e.canal === 'sms') parLead += u.sms * segmentsSms(smsTypique(e.texte)).segments;
      else parLead += u[e.canal] || 0;
    });
    return Math.round(nbLeads * parLead * 100) / 100;
  }

  return {
    DEFAUTS: DEFAUTS, STATUTS: STATUTS, MOTIFS: MOTIFS, VARIABLES: VARIABLES,
    norm: norm, msDe: msDe, paris: paris, aujourdhui: aujourdhui, decaler: decaler, dowYmd: dowYmd,
    estFerie: estFerie, jourOuvre: jourOuvre, prochainJourOuvre: prochainJourOuvre, jourEtape: jourEtape,
    jourCampagne: jourCampagne, ouvert: ouvert, instantParis: instantParis, minutesRestantes: minutesRestantes,
    provenance: provenance, dateEntree: dateEntree, prenom: prenom, telephoneE164: telephoneE164, estClient: estClient,
    exclusion: exclusion, filtrer: filtrer, repartir: repartir, contientPrix: contientPrix,
    remplir: remplir, variablesInconnues: variablesInconnues, verifierEtape: verifierEtape, empreinte: empreinte,
    coutEstime: coutEstime, segmentsSms: segmentsSms, smsTypique: smsTypique
  };
}));
