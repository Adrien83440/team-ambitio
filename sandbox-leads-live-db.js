/* ═══════════════════════════════════════════════════════════════════════════
   sandbox-leads-live-db.js — LABO LEADS LIVE : faux Firebase (compat v9)
   ─────────────────────────────────────────────────────────────────────────
   Chargé UNIQUEMENT par sandbox-leads-live.html (page générée par
   scripts/build-sandbox-leads-live.js). Remplace le SDK Firebase : aucune
   connexion au vrai projet, des leads fictifs en mémoire, gardés dans le
   navigateur et remis à zéro par « Réinitialiser ».

   Cloisonnement : la page vit sur le même domaine qu'Alteore. Tout ce
   qu'elle range dans localStorage / sessionStorage est préfixé « sbxll: »
   pour ne jamais toucher aux réglages du vrai logiciel (rôle, thème,
   interrupteur ?v3…).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var PFX = 'sbxll:';
  /* Le testeur : prénom du compte Alteore ouvert sur ce navigateur, lu AVANT
     le cloisonnement et en lecture seule. À défaut : « Vincent ». */
  var MOI = 'Vincent';
  try {
    var brut = String(window.localStorage.getItem('ambitio_name') || '').replace(/[._-]+/g, ' ').trim().split(/\s+/)[0] || '';
    if (brut && !/@/.test(brut) && brut.length > 1) MOI = brut.charAt(0).toUpperCase() + brut.slice(1).toLowerCase();
  } catch (e) {}
  /* Son rôle (17/10/2026) : un sales s'entraîne avec un compte sales, pour
     voir exactement ce qu'il verra en vrai. Lu lui aussi avant le cloisonnement. */
  var ROLE = 'sales';
  try { if (window.localStorage.getItem('ambitio_role') === 'admin') ROLE = 'admin'; } catch (e) {}
  (function cloisonner() {
    try {
      var SP = Storage.prototype, ls = window.localStorage, ss = window.sessionStorage;
      var get = SP.getItem, set = SP.setItem, rem = SP.removeItem;
      var cle = function (st, k) { return (st === ls || st === ss) ? PFX + k : k; };
      SP.getItem = function (k) { return get.call(this, cle(this, k)); };
      SP.setItem = function (k, v) { return set.call(this, cle(this, k), v); };
      SP.removeItem = function (k) { return rem.call(this, cle(this, k)); };
    } catch (e) {}
  })();
  /* Désormais cloisonnées : sans effet sur le vrai logiciel. */
  try { localStorage.setItem('ll3_choix_v2', '1'); localStorage.setItem('ambitio_role', ROLE); localStorage.setItem('ambitio_name', MOI); } catch (e) {}
  /* v7 (29/10/2026) : base PARTAGÉE avec le Labo Pipeline (sandbox-pipeline.html),
     qui charge aussi ce fichier ; elle reçoit les faux leads du Pipeline
     (sandbox-pipeline-data.js) et suit les écritures de l'autre onglet. */
  var KEY = 'llsbx_db_v8';   /* v8 (30/10/2026) : anciens leads ajoutés */
  var NOW = Date.now(), MIN = 60000, H = 3600000, D = 86400000;

  /* ── Horodatages et valeurs spéciales ── */
  function TS(ms) { this._ms = ms; this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; }
  TS.prototype.toDate = function () { return new Date(this._ms); };
  TS.prototype.toMillis = function () { return this._ms; };
  TS.prototype.valueOf = function () { return this._ms; };
  TS.prototype.isEqual = function (o) { return o && o._ms === this._ms; };
  function ts(ms) { return new TS(ms); }
  function FV(op, v) { this.op = op; this.v = v; }

  function clone(v) {
    if (v instanceof TS) return ts(v._ms);
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]); return o; }
    return v;
  }
  function msOf(v) {
    if (v instanceof TS) return v._ms;
    if (v instanceof Date) return v.getTime();
    if (v && typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return Date.parse(v);
    return v;
  }
  function getPath(o, p) { var parts = String(p).split('.'); for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; } return o; }
  function resolve(cur, val) {
    if (!(val instanceof FV)) return clone(val);
    if (val.op === 'ts') return ts(Date.now());
    if (val.op === 'union') { var a = Array.isArray(cur) ? cur.slice() : []; val.v.forEach(function (x) { if (a.map(JSON.stringify).indexOf(JSON.stringify(x)) < 0) a.push(clone(x)); }); return a; }
    if (val.op === 'remove') { return (Array.isArray(cur) ? cur : []).filter(function (x) { return val.v.map(JSON.stringify).indexOf(JSON.stringify(x)) < 0; }); }
    if (val.op === 'inc') return (Number(cur) || 0) + val.v;
    return undefined;
  }
  function setPath(o, p, val) {
    var parts = String(p).split('.');
    for (var i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    var last = parts[parts.length - 1];
    if (val instanceof FV && val.op === 'del') { delete o[last]; return; }
    o[last] = resolve(o[last], val);
  }
  function mergeDeep(dst, src) {
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v && typeof v === 'object' && !(v instanceof FV) && !(v instanceof TS) && !(v instanceof Date) && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeDeep(dst[k], v);
      else setPath(dst, k, v);
    });
  }

  /* ── Sauvegarde ── */
  function enc(db) { return JSON.stringify(db, function (k, v) { if (v instanceof TS) return { __ts: v._ms }; return v; }); }
  function dec(s) {
    var o = JSON.parse(s);
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      Object.keys(x).forEach(function (k) {
        var v = x[k];
        if (v && typeof v === 'object' && typeof v.__ts === 'number' && Object.keys(v).length === 1) x[k] = ts(v.__ts);
        else walk(v);
      });
    })(o);
    return o;
  }
  var DB = null;
  try { var raw = localStorage.getItem(KEY); if (raw) DB = dec(raw); } catch (e) { DB = null; }
  if (!DB || !DB.leads) DB = seed();
  /* Base déjà gardée : on remet le rôle du testeur à jour. */
  try {
    if (DB.users && DB.users['u-moi']) DB.users['u-moi'].role = ROLE;
    var mm = DB._meta && DB._meta.team_members && DB._meta.team_members.members && DB._meta.team_members.members.moi;
    if (mm) mm.role = ROLE === 'admin' ? 'admin' : 'closer_setter';
  } catch (e) {}
  var saveT = null;
  function save() { clearTimeout(saveT); saveT = setTimeout(function () { try { localStorage.setItem(KEY, enc(DB)); } catch (e) {} }, 300); }
  save();
  window.__SBX = { moi: { slug: 'moi', nom: MOI, uid: 'u-moi' }, db: function () { return DB; }, reset: function () { try { localStorage.removeItem(KEY); localStorage.removeItem('ll5_theme_v3'); localStorage.removeItem('ll3_list'); localStorage.removeItem('ll5_tuto_v1:liste'); localStorage.removeItem('ll5_tuto_v1:fiche'); } catch (e) {} location.reload(); }, fire: function (c) { fire(c); }, ts: ts, save: save };

  /* ── Firestore ── */
  var listeners = [];
  function col(p) { if (!DB[p]) DB[p] = {}; return DB[p]; }
  function fire(colPath) { setTimeout(function () { listeners.slice().forEach(function (l) { if (l.col === colPath) try { l.fn(); } catch (e) { console.error(e); } }); }, 15); }
  function docSnap(colPath, id) {
    var v = DB[colPath] && DB[colPath][id];
    return { id: id, exists: !!v, ref: docRef(colPath, id), data: function () { return v ? clone(v) : undefined; }, get: function (p) { return v ? clone(getPath(v, p)) : undefined; } };
  }
  function cmp(a, b) { a = msOf(a); b = msOf(b); return a < b ? -1 : (a > b ? 1 : 0); }
  function match(v, f) {
    var x = getPath(v, f[0]), op = f[1], w = f[2];
    if (op === '==') return msOf(x) === msOf(w);
    if (op === '!=') return msOf(x) !== msOf(w);
    if (op === 'in') return (w || []).indexOf(x) >= 0;
    if (op === 'array-contains') return Array.isArray(x) && x.indexOf(w) >= 0;
    if (x == null) return false;
    if (op === '>=') return cmp(x, w) >= 0;
    if (op === '>') return cmp(x, w) > 0;
    if (op === '<=') return cmp(x, w) <= 0;
    if (op === '<') return cmp(x, w) < 0;
    return true;
  }
  function query(colPath, q) {
    q = q || { w: [], o: [], lim: 0, last: 0 };
    function run() {
      var c = DB[colPath] || {};
      var ids = Object.keys(c).filter(function (id) { return q.w.every(function (f) { return match(c[id], f); }); });
      q.o.forEach(function (o) { ids.sort(function (a, b) { var r = cmp(getPath(c[a], o[0]), getPath(c[b], o[0])); return o[1] === 'desc' ? -r : r; }); });
      if (q.lim) ids = ids.slice(0, q.lim);
      if (q.last) ids = ids.slice(-q.last);
      var docs = ids.map(function (id) { return docSnap(colPath, id); });
      return { empty: !docs.length, size: docs.length, docs: docs, forEach: function (cb) { docs.forEach(cb); }, docChanges: function () { return docs.map(function (d, i) { return { type: 'added', doc: d, newIndex: i, oldIndex: -1 }; }); } };
    }
    function nq(ch) { return query(colPath, { w: q.w.concat(ch.w || []), o: q.o.concat(ch.o || []), lim: ch.lim || q.lim, last: ch.last || q.last }); }
    return {
      where: function (a, b, c) { return nq({ w: [[a, b, c]] }); },
      orderBy: function (a, d) { return nq({ o: [[a, d || 'asc']] }); },
      limit: function (n) { return nq({ lim: n }); },
      limitToLast: function (n) { return nq({ last: n }); },
      startAfter: function () { return this; }, startAt: function () { return this; }, endBefore: function () { return this; }, select: function () { return this; },
      get: function () { return Promise.resolve(run()); },
      onSnapshot: function (cb, err) { var l = { col: colPath, fn: function () { cb(run()); } }; listeners.push(l); setTimeout(l.fn, 20); return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
      doc: function (id) { return docRef(colPath, id || ('x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))); },
      add: function (v) { var r = docRef(colPath, 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)); return r.set(v).then(function () { return r; }); },
      path: colPath
    };
  }
  function docRef(colPath, id) {
    return {
      id: id, path: colPath + '/' + id,
      collection: function (c) { return query(colPath + '/' + id + '/' + c); },
      get: function () { return Promise.resolve(docSnap(colPath, id)); },
      set: function (v, opt) {
        var c = col(colPath);
        if (opt && opt.merge && c[id]) mergeDeep(c[id], v);
        else { var o = {}; Object.keys(v || {}).forEach(function (k) { setPath(o, k, v[k]); }); c[id] = o; }
        save(); fire(colPath); return Promise.resolve();
      },
      update: function (v) {
        var c = col(colPath);
        if (!c[id]) return Promise.reject(new Error('Document introuvable'));
        Object.keys(v).forEach(function (k) { setPath(c[id], k, v[k]); });
        save(); fire(colPath); return Promise.resolve();
      },
      delete: function () { var c = col(colPath); delete c[id]; save(); fire(colPath); return Promise.resolve(); },
      onSnapshot: function (cb) { var l = { col: colPath, fn: function () { cb(docSnap(colPath, id)); } }; listeners.push(l); setTimeout(l.fn, 20); return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    };
  }
  function docByPath(p) { var s = String(p).split('/'); var id = s.pop(); return docRef(s.join('/'), id); }
  var fs = {
    collection: function (c) { return query(c); },
    doc: function (p) { return docByPath(p); },
    collectionGroup: function () { return query('__vide__'); },
    settings: function () {}, enablePersistence: function () { return Promise.resolve(); }, enableNetwork: function () { return Promise.resolve(); },
    batch: function () {
      var ops = [];
      return { set: function (r, v, o) { ops.push(function () { return r.set(v, o); }); return this; }, update: function (r, v) { ops.push(function () { return r.update(v); }); return this; }, delete: function (r) { ops.push(function () { return r.delete(); }); return this; }, commit: function () { return Promise.all(ops.map(function (f) { return f(); })); } };
    },
    runTransaction: function (fn) {
      var tx = { get: function (r) { return r.get(); }, set: function (r, v, o) { r.set(v, o); return tx; }, update: function (r, v) { r.update(v); return tx; }, delete: function (r) { r.delete(); return tx; } };
      return Promise.resolve().then(function () { return fn(tx); });
    }
  };
  var ffn = function () { return fs; };
  ffn.FieldValue = {
    serverTimestamp: function () { return new FV('ts'); }, delete: function () { return new FV('del'); },
    arrayUnion: function () { return new FV('union', Array.prototype.slice.call(arguments)); },
    arrayRemove: function () { return new FV('remove', Array.prototype.slice.call(arguments)); },
    increment: function (n) { return new FV('inc', n); }
  };
  ffn.Timestamp = { fromDate: function (d) { return ts(d.getTime()); }, now: function () { return ts(Date.now()); }, fromMillis: function (m) { return ts(m); } };
  ffn.FieldPath = { documentId: function () { return '__id__'; } };

  /* ── Auth, Storage, Messaging ── */
  var user = { uid: 'u-moi', email: 'testeur@alteore.test', displayName: MOI, getIdToken: function () { return Promise.resolve('jeton-de-test'); }, getIdTokenResult: function () { return Promise.resolve({ claims: {} }); } };
  var auth = {
    currentUser: user,
    onAuthStateChanged: function (cb) { setTimeout(function () { cb(user); }, 0); return function () {}; },
    signInWithEmailAndPassword: function () { return Promise.resolve({ user: user }); },
    setPersistence: function () { return Promise.resolve(); },
    signOut: function () { return Promise.resolve(); }
  };
  var authFn = function () { return auth; };
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
  function sref(p) {
    return {
      fullPath: p, child: function (c) { return sref(p + '/' + c); },
      put: function (blob) { var url = ''; try { url = URL.createObjectURL(blob); } catch (e) {} window.__SBX_FILES = window.__SBX_FILES || {}; window.__SBX_FILES[p] = url; return Promise.resolve({ ref: { getDownloadURL: function () { return Promise.resolve(url); } } }); },
      getDownloadURL: function () { return Promise.resolve((window.__SBX_FILES || {})[p] || ''); },
      delete: function () { return Promise.resolve(); }
    };
  }
  var messagingFn = function () { return { getToken: function () { return Promise.reject(new Error('indisponible en test')); }, onMessage: function () {}, useServiceWorker: function () {} }; };
  messagingFn.isSupported = function () { return false; };
  window.firebase = {
    apps: [{ name: '[DEFAULT]' }], initializeApp: function () { return {}; }, app: function () { return {}; },
    firestore: ffn, auth: authFn, storage: function () { return { ref: function (p) { return sref(p || ''); } }; }, messaging: messagingFn
  };

  /* ── Données de test (relatives à maintenant) ── */
  function seed() {
    var db = {};
    function put(c, id, v) { if (!db[c]) db[c] = {}; db[c][id] = v; }
    function iso(ms) { return new Date(ms).toISOString(); }
    function loc(ms) { var d = new Date(ms); function z(n) { return String(n).padStart(2, '0'); } return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':00'; }
    function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function hhmm(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
    function frDate(ms) { var d = new Date(ms); function z(n) { return String(n).padStart(2, '0'); } return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
    function rond(ms) { var d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); }

    put('_meta', 'team_members', { members: {
      adrien:   { slug: 'adrien', shortName: 'Adrien', displayName: 'Adrien', color: '#ef4444', initials: 'A', role: 'admin', active: true, inLeadsModule: true, firebaseUid: 'u-adrien', order: 1 },
      moi:      { slug: 'moi', shortName: MOI, displayName: MOI, color: '#3d5af1', initials: MOI.charAt(0), role: ROLE === 'admin' ? 'admin' : 'closer_setter', active: true, inLeadsModule: true, firebaseUid: 'u-moi', order: 0 },
      vincent:  { slug: 'vincent', shortName: 'Vincent', displayName: 'Vincent', color: '#fb923c', initials: 'V', role: 'admin', active: true, inLeadsModule: true, firebaseUid: 'u-vincent', order: 2 },
      elodie:   { slug: 'elodie', shortName: 'Élodie', displayName: 'Élodie', color: '#f472b6', initials: 'É', role: 'closer_setter', active: false, inLeadsModule: false, firebaseUid: 'u-elodie', order: 9 },
      anthony:  { slug: 'anthony', shortName: 'Anthony', displayName: 'Anthony', color: '#e0567a', initials: 'A', role: 'closer_setter', active: true, inLeadsModule: true, eligibleForLeads: true, firebaseUid: 'u-anthony', order: 3 },
      claire:   { slug: 'claire', shortName: 'Claire', displayName: 'Claire', color: '#d97706', initials: 'C', role: 'closer_setter', active: true, inLeadsModule: true, eligibleForLeads: true, firebaseUid: 'u-claire', order: 4 },
      steven:   { slug: 'steven', shortName: 'Steven', displayName: 'Steven', color: '#38bdf8', initials: 'S', role: 'setter_ecrit', active: true, inLeadsModule: true, firebaseUid: 'u-steven', order: 4 },
      valentin: { slug: 'valentin', shortName: 'Valentin', displayName: 'Valentin', color: '#a3e635', initials: 'V', role: 'setter', active: true, inLeadsModule: true, firebaseUid: 'u-valentin', order: 5 },
      marine:   { slug: 'marine', shortName: 'Marine', displayName: 'Marine', color: '#2dd4bf', initials: 'M', role: 'csm', active: true, firebaseUid: 'u-marine', order: 6 },
      edouard:  { slug: 'edouard', shortName: 'Edouard', displayName: 'Edouard', color: '#c084fc', initials: 'E', role: 'coach', active: true, firebaseUid: 'u-edouard', order: 7 }
    } });
    Object.keys(db._meta.team_members.members).forEach(function (k) { var m = db._meta.team_members.members[k]; m.name = m.shortName; m.fullName = m.displayName; });
    put('users', 'u-moi', { role: ROLE, email: 'testeur@alteore.test', firstname: MOI });
    put('_config', 'sales_close_pilot', { enabled: true });  /* comme en production */
    put('_config', 'leads_live_v3', { enabled: true });
    put('_config', 'crm_v2', { enabled: true });  /* Leads Live filtré par les étapes du Pipeline */

    var T0 = new Date(); T0.setHours(9, 0, 0, 0); var t9 = T0.getTime();
    function lead(id, o) { o.createdAt = ts(o._c); delete o._c; put('leads', id, o); }

    lead('l1', { nom: 'Julie Renaud', telephone: '+33612489031', email: 'julie.renaud@institut-renaud.fr', type: 'business', status: 'nrp2', stage: 'nrp2', assignedTo: 'moi', _c: NOW - 26 * H,
      secteur: 'Institut de beauté', ca: '18 000 €/mois', defi: 'Mes clientes ne reviennent pas assez', disponibilite: 'Le matin', timeline: 'Dans le mois', utm: 'meta-ads', landingFirst: { label: 'Business Phénix', variant: 'b' },
      followUps: [{ id: 'f1', dateTime: loc(NOW - 35 * MIN), note: 'Rappeler après sa réunion', duration: 30, done: false, createdBy: MOI, createdAt: iso(NOW - 3 * H) }],
      leadScore: 3, leadScoreByName: MOI, leadScoreAt: ts(NOW - 20 * H),
      notesHistory: [{ text: 'Très intéressée par la fidélisation. @elodie tu peux la prendre si je suis en RDV ?', date: frDate(NOW - 3 * H), authorName: MOI, authorSlug: 'moi' }],
      communications: [
        { type: 'call', direction: 'outbound', ownerName: MOI, date: iso(NOW - 25 * H), duration: 0, source: 'ringover' },
        { type: 'sms', direction: 'outbound', ownerName: MOI, date: iso(NOW - 25 * H + MIN), content: 'Bonjour Julie, c’est ' + MOI + ' d’Alteore. J’ai essayé de vous joindre suite à votre demande. Quand puis-je vous rappeler ? ' + MOI, source: 'ringover-sms' },
        { type: 'call', direction: 'outbound', ownerName: MOI, date: iso(NOW - 4 * H), duration: 0, source: 'ringover' }],
      whatsappFenetre: NOW + 21 * H, whatsappEnvoye: null,
      aiLead: { proba: 64, niveau: 'tiède', raison: 'Elle a répondu par écrit et proposé elle-même un horaire.', angle: 'Parler fidélisation et panier moyen avant de parler du programme', ouverture: 'Bonjour Julie, c’est ' + MOI + ', je vous rappelle comme convenu après votre réunion.', brief: ['Institut de beauté, 18 k€/mois, 2 salariées', 'Problème : les clientes ne reviennent pas', 'A écrit sur WhatsApp ce matin pour demander un rappel'], creneau: 'Entre 10h30 et 12h', key: 'sbx' },
      aiLastCall: { callAt: iso(NOW - 4 * H), resume: 'Pas de réponse, messagerie pleine. Un message WhatsApp reçu juste après demande un rappel.', resultat: 'a_rappeler', statutSuggere: 'follow_up_pm', prochaineAction: { action: 'Rappeler', quand: 'en fin de matinée', message: 'Bonjour Julie, je vous rappelle en fin de matinée comme convenu. ' + MOI } } });
    put('whatsapp_conversations', '33612489031', { numero: '33612489031', leadId: 'l1', nomLead: 'Julie Renaud', fenetreExpireA: NOW + 21 * H, dernierMessage: { texte: 'Bonjour, je suis en réunion ce matin, rappelez-moi en fin de matinée svp 🙏', sens: 'in', at: NOW - 3 * H }, nonLus: 1, majA: NOW - 3 * H });
    put('whatsapp_conversations/33612489031/messages', 'w1', { wamid: 'w1', sens: 'in', texte: 'Bonjour, je suis en réunion ce matin, rappelez-moi en fin de matinée svp 🙏', statut: 'recu', at: NOW - 3 * H, date: iso(NOW - 3 * H) });

    lead('l2', { nom: 'Karim Benali', telephone: '+33781226405', email: 'karim@benali-renov.fr', type: 'self_booking', status: 'rdv_self_booking', stage: 'rdv_self_booking', assignedTo: 'moi', _c: NOW - 28 * H,
      secteur: 'Rénovation intérieure', ca: '42 000 €/mois', defi: 'Je n’arrive plus à tout gérer seul', disponibilite: 'Début d’après-midi', timeline: 'Tout de suite', utm: 'link_in_bio',
      communications: [{ type: 'call', direction: 'outbound', ownerName: 'Élodie', date: iso(NOW - 20 * H), duration: 130, source: 'ringover' }, { type: 'sms', direction: 'inbound', date: iso(NOW - 19.7 * H), content: 'Oui c’est noté pour demain 👍', source: 'ringover-sms' }],
      aiLead: { proba: 82, niveau: 'chaud', raison: 'RDV pris par lui-même, répond vite.', angle: 'Recrutement et délégation', ouverture: 'Bonjour Karim, Vincent d’Alteore, prêt pour notre point ?', brief: ['A réservé seul depuis Instagram', '42 k€/mois, équipe de 4 à structurer', 'A confirmé par SMS hier soir'], key: 'sbx' } });
    var rdv2 = rond(NOW + 3 * H);
    put('bookings', 'b1', { leadId: 'l2', date: ymd(rdv2), time: hhmm(rdv2), duration: 45, status: 'confirmed', source: 'self_booking', personName: MOI, personId: 'moi', expertSlug: 'moi', type: 'decouverte', typeName: 'Appel découverte', prospect: { prenom: 'Karim', nom: 'Benali', email: 'karim@benali-renov.fr', telephone: '+33781226405', secteur: 'Rénovation', message: 'J’ai besoin de structurer mon équipe avant l’été.' }, meetLink: 'https://meet.google.com/abc-defg-hij', createdAt: ts(NOW - 28 * H) });

    lead('l3', { nom: 'Sophie Marchand', telephone: '+33645771092', email: 'sophie@fournil-marchand.fr', type: 'vsl_elite', status: 'nouveau', stage: 'lead', assignedTo: 'moi', _c: NOW - 2 * H,
      secteur: 'Boulangerie artisanale', ca: '35 000 €/mois', defi: 'Je fais tout moi-même', disponibilite: '14h – 16h', timeline: 'Dans les 3 mois', utm: 'meta-ads', landingFirst: { label: 'VSL Élite', variant: 'v4-b' },
      quiz: { score_global: 46, pilier_prioritaire: 'Délégation', scores: { systematisation: 52, delegation: 28, pilotage: 61, croissance: 43 }, ca_mensuel: '35 000 €', objectif: '60 000 €', equipe: '5 personnes', heures: '70 h', receivedAt: ts(NOW - 2 * H), reponses: [{ question: 'Combien d’heures travaillez-vous par semaine ?', reponse: '70 h' }, { question: 'Qui gère le planning ?', reponse: 'Moi' }] },
      formTitle: 'VSL Élite · inscription', formSubmittedAt: ts(NOW - 2 * H), formAnswers: { secteur: 'Boulangerie artisanale', ca: '35 000 €/mois', defi: 'Je fais tout moi-même' },
      aiLead: { proba: 78, niveau: 'chaud', raison: 'Diagnostic rempli ce matin, très bon profil, tunnel Élite.', angle: 'Retrouver du temps : la délégation est son point faible', ouverture: 'Bonjour Sophie, c’est ' + MOI + ' d’Alteore, vous venez de faire notre diagnostic, je peux vous en dire deux mots ?', brief: ['Boulangerie, 35 k€/mois, 5 salariés', '70 h par semaine, délégation à 28 %', 'A regardé la VSL Élite en entier'], creneau: '14h – 16h', key: 'sbx' } });

    lead('l4', { nom: 'Laura Petit', telephone: '+33766310854', email: 'laura.petit@gmail.com', type: 'vsl_elite', status: 'nouveau', stage: 'lead', assignedTo: 'steven', _c: NOW - 25 * MIN, secteur: 'Coiffure', ca: '9 000 €/mois', defi: 'Trouver de nouvelles clientes', utm: 'meta-ads',
      aiLead: { proba: 41, niveau: 'tiède', raison: 'Petit chiffre d’affaires, encore en réflexion.', brief: ['Salon de coiffure seule', '9 k€/mois', 'Cherche des clientes'], key: 'sbx' } });

    lead('l5', { nom: 'Thomas Leclerc', telephone: '+33608541277', email: 't.leclerc@garage-leclerc.fr', type: 'vsl_elite', status: 'messagerie', stage: 'lead', assignedTo: 'moi', _c: NOW - 30 * H, secteur: 'Garage automobile', ca: '60 000 €/mois', defi: 'Ma marge baisse', utm: 'google', _resurrected: true,
      zohoOrigine: 'Webinaire dimanche', zohoGestionnaire: 'Ancien gestionnaire', zohoCreatedAt: ts(NOW - 200 * D),
      communications: [{ type: 'call', direction: 'outbound', ownerName: MOI, date: iso(NOW - 29 * H), duration: 0 }, { type: 'email', direction: 'outbound', ownerName: MOI, date: iso(NOW - 29 * H + 9 * MIN), subject: 'Suite à votre demande, Thomas', content: 'Suite à votre demande, Thomas\n\nBonjour Thomas, j’ai essayé de vous joindre…' }] });

    lead('l6', { nom: 'Inès Haddad', telephone: '+33752904418', email: 'ines@haddad-conseil.fr', type: 'business', status: 'nrp1', stage: 'nrp1', assignedTo: 'valentin', _c: NOW - 27 * H, secteur: 'Conseil RH', ca: '22 000 €/mois',
      communications: [{ type: 'call', direction: 'outbound', ownerName: 'Valentin', date: iso(NOW - 26 * H), duration: 0 }] });

    lead('l7', { nom: 'Nadia Fontaine', telephone: '+33671332560', email: 'nadia@fontaine-fleurs.fr', type: 'vsl_elite', status: 'follow_up_pm', stage: 'follow_up_pm', assignedTo: 'moi', _c: NOW - 50 * H, secteur: 'Fleuriste (2 boutiques)', ca: '28 000 €/mois', defi: 'Ouvrir une 3ᵉ boutique',
      followUps: [{ id: 'f2', dateTime: loc(rond(NOW + D) - (new Date(NOW).getHours() - 9) * H), note: 'Elle en parle avec son associée', duration: 30, done: false, createdBy: MOI, createdAt: iso(NOW - 40 * H) }], leadScore: 4,
      communications: [{ type: 'call', direction: 'outbound', ownerName: MOI, date: iso(NOW - 48 * H), duration: 312 }], whatsappFenetre: NOW + 6 * H });
    put('whatsapp_conversations', '33671332560', { numero: '33671332560', leadId: 'l7', fenetreExpireA: NOW + 6 * H, dernierMessage: { texte: 'Merci, je regarde ça avec Claire ce soir', sens: 'in', at: NOW - 18 * H } });
    put('whatsapp_conversations/33671332560/messages', 'w2', { wamid: 'w2', sens: 'out', texte: 'Bonjour Nadia, voici la présentation dont on a parlé. À demain ! ' + MOI, statut: 'read', at: NOW - 19 * H, par: 'testeur@alteore.test' });
    put('whatsapp_conversations/33671332560/messages', 'w3', { wamid: 'w3', sens: 'in', texte: 'Merci, je regarde ça avec Claire ce soir', statut: 'recu', at: NOW - 18 * H });

    lead('l8', { nom: 'Marc Dubois', telephone: '+33619847203', email: 'marc@dubois-menuiserie.fr', type: 'vsl_elite', status: 'rdv_pose', stage: 'set', assignedTo: 'moi', setterSlug: 'elodie', setterName: 'Élodie', setterRole: 'closer_setter', setterAt: ts(NOW - 47 * H), _c: NOW - 52 * H, secteur: 'Menuiserie', ca: '75 000 €/mois', defi: 'Passer de 6 à 12 salariés', leadScore: 5,
      communications: [{ type: 'call', direction: 'outbound', ownerName: 'Élodie', date: iso(NOW - 47 * H), duration: 664 }] });
    var rdv8 = rond(NOW + D);
    put('bookings', 'b2', { leadId: 'l8', date: ymd(rdv8), time: hhmm(rdv8), duration: 60, status: 'confirmed', source: 'setter_booking', bookedBySlug: 'elodie', personName: MOI, personId: 'moi', expertSlug: 'moi', type: 'strat', typeName: 'Appel stratégique Élite', prospect: { email: 'marc@dubois-menuiserie.fr', telephone: '+33619847203' }, presenceConfirmed: { channel: 'call', byName: 'Élodie', at: ts(NOW - 5 * H) }, meetLink: 'https://meet.google.com/xyz-abcd-efg', createdAt: ts(NOW - 47 * H) });

    lead('l9', { nom: 'Céline Moreau', telephone: '+33627598146', email: 'celine@moreau-immo.fr', type: 'vsl_elite', status: 'client', stage: 'closed_won_setting', isClient: true, clientSince: ts(NOW - 3 * D), assignedTo: 'moi', _c: NOW - 9 * D, secteur: 'Agence immobilière', ca: '48 000 €/mois', coachAssigne: { slug: 'edouard', nom: 'Edouard' }, leadScore: 5 });
    put('bookings', 'b3', { leadId: 'l9', date: ymd(NOW - 3 * D), time: '15:00', duration: 60, status: 'completed', outcome: 'close', source: 'setter_booking', personName: 'Vincent', typeName: 'Appel stratégique Élite', createdAt: ts(NOW - 8 * D) });

    lead('l10', { nom: 'Pierre Garnier', telephone: '+33693401725', email: 'pierre.garnier@orange.fr', type: 'business', status: 'pas_interesse', stage: 'disqualification', assignedTo: 'valentin', _c: NOW - 4 * D, secteur: 'Plomberie', ca: '7 000 €/mois',
      communications: [{ type: 'call', direction: 'outbound', ownerName: 'Valentin', date: iso(NOW - 4 * D + H), duration: 100 }] });
    lead('l11', { nom: 'Antoine Roux', telephone: '+33600000001', email: 'a.roux@yopmail.com', type: 'vsl_elite', status: 'faux_numero', stage: 'faux_numero', assignedTo: 'steven', _c: NOW - 5 * D });
    lead('l12', { nom: 'Hugo Lambert', telephone: '+33658214790', email: 'hugo@lambert-resto.fr', type: 'vsl_elite', status: 'decroche', stage: 'lead', assignedTo: 'moi', _c: NOW - 3 * D, secteur: 'Restauration', ca: '30 000 €/mois',
      communications: [{ type: 'call', direction: 'outbound', ownerName: MOI, date: iso(NOW - 3 * D + 2 * H), duration: 240 }], notesHistory: [{ text: 'Intéressé mais veut d’abord voir son comptable.', date: frDate(NOW - 3 * D + 2 * H), authorName: MOI }] });
    lead('l13', { nom: 'Yann Le Goff', telephone: '+33745126681', email: 'yann@legoff-transport.bzh', type: 'business', status: 'set', stage: 'set', assignedTo: 'steven', setterSlug: 'steven', setterName: 'Steven', setterRole: 'setter_ecrit', _c: NOW - 4 * D, secteur: 'Transport', ca: '51 000 €/mois' });
    var rdv13 = rond(NOW + 3 * D);
    put('bookings', 'b4', { leadId: 'l13', date: ymd(rdv13), time: hhmm(rdv13), duration: 45, status: 'confirmed', source: 'setter_booking', bookedBySlug: 'steven', personName: 'Vincent', personId: 'vincent', typeName: 'Appel découverte', prospect: { email: 'yann@legoff-transport.bzh', telephone: '+33745126681' }, createdAt: ts(NOW - 4 * D) });
    lead('l14', { nom: 'Léa Bertin', email: 'lea.bertin@studio-lea.fr', type: 'vsl_elite', status: 'nouveau', stage: 'lead', assignedTo: 'moi', _c: NOW - 70 * MIN, secteur: 'Studio de yoga', ca: '12 000 €/mois', defi: 'Remplir mes cours du soir' });
    versePipeline(db, put);
    return db;
  }

  /* Faux leads du Labo Pipeline (sandbox-pipeline-data.js), au même format
     que ceux d'ici : dates des champs « horodatage » converties. */
  function versePipeline(db, put) {
    if (typeof window.SBX_PIPELINE_SEED !== 'function') return;
    var r = window.SBX_PIPELINE_SEED();
    function t(v) { if (!v) return v; var ms = typeof v === 'string' ? Date.parse(v) : v; return isNaN(ms) ? v : ts(ms); }
    r.leads.forEach(function (l) {
      var o = JSON.parse(JSON.stringify(l));
      delete o.id; delete o._v;
      ['createdAt', 'clientSince', 'assignedAt', 'lastOptinAt', 'updatedAt', 'importedCreatedAt'].forEach(function (k) { if (o[k]) o[k] = t(o[k]); });
      if (!o.status || o.status === 'nouveau') o.status = ({ lead: 'nouveau', nrp1: 'nrp1', nrp2: 'nrp2', nrp3: 'nrp3', all_nrp: 'all_nrp', faux_numero: 'faux_numero', poubelle: 'poubelle', disqualification: 'disqualifie', disqualifie_closing: 'disqualifie', follow_up_pm: 'follow_up_pm', set: 'set', rdv_confirmes: 'rdv_pose', rdv_self_booking: 'rdv_self_booking', closed_lost: 'pas_interesse' })[o.stage] || 'follow_up_pm';
      if (!o.phoneNormalized && o.telephone) o.phoneNormalized = String(o.telephone).replace(/\D/g, '').slice(-9);
      put('leads', l.id, o);
      (r.bookings[l.id] || []).forEach(function (b) {
        var x = JSON.parse(JSON.stringify(b)), parts = String(l.nom || '').split(' ');
        delete x.id;
        x.leadId = l.id;
        if (x.createdAt) x.createdAt = t(x.createdAt);
        if (x.presenceConfirmed && x.presenceConfirmed.at) x.presenceConfirmed.at = t(x.presenceConfirmed.at);
        if (!x.prospect) x.prospect = { prenom: parts[0] || '', nom: parts.slice(1).join(' '), email: l.email || '', telephone: l.telephone || '' };
        if (!x.typeName) x.typeName = x.typeLabel || 'Appel stratégique';
        put('bookings', b.id, x);
      });
    });
  }

  /* L'autre Labo (onglet voisin) a écrit : on recharge la base et on prévient
     tous les écouteurs, comme le ferait Firestore. */
  window.addEventListener('storage', function (e) {
    if (!e || e.key !== PFX + KEY || !e.newValue) return;
    try {
      var nv = dec(e.newValue);
      if (!nv || !nv.leads) return;
      DB = nv;
      setTimeout(function () { listeners.slice().forEach(function (l) { try { l.fn(); } catch (x) { console.error(x); } }); }, 15);
    } catch (x) {}
  });
})();
