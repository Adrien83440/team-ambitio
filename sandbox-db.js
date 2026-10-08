/* ═══════════════════════════════════════════════════════════════════════
   sandbox-db.js — BAC À SABLE : une fausse base Firestore, dans le navigateur
   ─────────────────────────────────────────────────────────────────────────
   Le bac à sable fait tourner les VRAIES pages (sign.html,
   sales-signatures.html, payments.html) et le VRAI code serveur (api/*,
   empaqueté dans sandbox-server.js). Les deux parlent à Firebase : ici,
   Firebase est remplacé par cette base locale.

   Organisation :
     · LE MAGASIN (window.top.__SBX_STORE) — créé une seule fois, dans la
       fenêtre principale (sandbox-closer.html). Données en JSON « encodé »
       (dates : {__ts: ms}), écritures atomiques, écouteurs, sauvegarde dans
       IndexedDB (le navigateur seulement — jamais le réseau).
     · LES FAÇADES — window.SBXDB.compat(win) imite le SDK compat v9
       (firebase.firestore(), firebase.auth()) pour une page ; SBXDB.admin()
       imite firebase-admin pour le code serveur. Chaque fenêtre charge ce
       fichier : ses objets sont créés dans SA fenêtre (pas d'objets
       « étrangers » pour le code des pages).
     · LA SURCOUCHE EN LECTURE SEULE — les modèles de contrat réels
       (signature_templates), lus une fois dans Firestore par la fenêtre
       principale, posés ici. Une modification faite dans le bac à sable
       n'écrit que dans la copie locale.

   Sous-ensemble implémenté = ce qu'utilisent les pages et le code serveur :
   collection/doc/add/set(merge)/update (chemins pointés)/delete, where
   (== != < <= > >= in array-contains array-contains-any), orderBy, limit,
   limitToLast, get, onSnapshot, batch, runTransaction, FieldValue
   (serverTimestamp, increment, arrayUnion, arrayRemove, delete), Timestamp.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var IDB_NAME = 'ambitio_sandbox_closer';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'db_v2';

  /* ═══ Outils JSON ════════════════════════════════════════════════════ */
  function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clonePlain(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function randId(n) {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    var a = new Uint8Array(n || 20);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += c.charAt(a[i] % c.length);
    return s;
  }
  function getPath(obj, field) {
    var parts = String(field).split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) { if (!isPlainObj(cur)) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  /* ═══ LE MAGASIN (fenêtre principale uniquement) ═════════════════════ */
  function createStore() {
    var docs = {};          // chemin → { d: données encodées, ct, ut }
    var overlay = {};       // chemin → données encodées (lecture seule, réel)
    var overlayLoaders = []; // fonctions(chemin de collection) → Promise
    var loadedCols = {};
    var tomb = {};          // chemins de la surcouche supprimés localement
    var listeners = {};
    var lid = 0;
    var saveTimer = null;
    var S = {
      identity: { uid: 'sandbox', email: '', name: 'Toi', role: 'sales' },
      host: null,          // branché par sandbox-core.js (téléphone, horloge…)
      version: 0
    };

    function segs(p) { return String(p).replace(/^\/+|\/+$/g, '').split('/'); }
    function parentCol(p) { var s = segs(p); s.pop(); return s.join('/'); }
    function readEnc(path) {
      if (docs[path]) return docs[path].d;
      if (!tomb[path] && overlay[path]) return overlay[path];
      return null;
    }
    S.exists = function (path) { return !!readEnc(path); };
    S.read = function (path) { var d = readEnc(path); return d ? clonePlain(d) : null; };
    /* Les sous-collections de la surcouche (ex. pdf/ d'un modèle) peuvent
       être chargées à la demande : on attend le chargeur avant de lire. */
    S.ensure = function (colPath) {
      if (loadedCols[colPath] || !overlayLoaders.length) return Promise.resolve();
      loadedCols[colPath] = true;
      return Promise.all(overlayLoaders.map(function (fn) { try { return fn(colPath); } catch (e) { return null; } })).then(function () {});
    };
    S.list = function (colPath) {
      var n = segs(colPath).length + 1, prefix = colPath + '/', out = {}, k;
      for (k in overlay) if (k.indexOf(prefix) === 0 && segs(k).length === n && !tomb[k]) out[k] = overlay[k];
      for (k in docs) if (k.indexOf(prefix) === 0 && segs(k).length === n) out[k] = docs[k].d;
      return Object.keys(out).map(function (p) { return { id: segs(p).pop(), path: p, d: clonePlain(out[p]) }; });
    };
    S.setOverlay = function (path, data) { overlay[path] = clonePlain(data); };
    S.addOverlayLoader = function (fn) { overlayLoaders.push(fn); };

    /* Résolution des sentinelles FieldValue au moment de l'écriture. */
    function resolve(v, cur, now) {
      if (v && typeof v === 'object' && v.__fv) {
        if (v.__fv === 'serverTimestamp') return { __ts: now };
        if (v.__fv === 'increment') return (typeof cur === 'number' ? cur : 0) + Number(v.v || 0);
        if (v.__fv === 'arrayUnion') {
          var a = Array.isArray(cur) ? cur.slice() : [];
          v.v.forEach(function (x) { if (!a.some(function (y) { return deepEq(x, y); })) a.push(x); });
          return a;
        }
        if (v.__fv === 'arrayRemove') {
          return (Array.isArray(cur) ? cur : []).filter(function (y) { return !v.v.some(function (x) { return deepEq(x, y); }); });
        }
        if (v.__fv === 'delete') return undefined;
      }
      if (Array.isArray(v)) return v.map(function (x) { return resolve(x, undefined, now); });
      if (isPlainObj(v)) {
        var o = {};
        Object.keys(v).forEach(function (k) { var r = resolve(v[k], cur && isPlainObj(cur) ? cur[k] : undefined, now); if (r !== undefined) o[k] = r; });
        return o;
      }
      return v;
    }
    function mergeInto(target, src, now) {
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (v && typeof v === 'object' && v.__fv) {
          var r = resolve(v, target[k], now);
          if (r === undefined) delete target[k]; else target[k] = r;
        } else if (isPlainObj(v) && !v.__ts) {
          if (!isPlainObj(target[k]) || target[k].__ts) target[k] = {};
          mergeInto(target[k], v, now);
        } else {
          target[k] = resolve(v, undefined, now);
        }
      });
    }
    function setPathVal(obj, field, v, now) {
      var parts = String(field).split('.'), cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!isPlainObj(cur[parts[i]]) || cur[parts[i]].__ts) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      var last = parts[parts.length - 1], r = resolve(v, cur[last], now);
      if (r === undefined) delete cur[last]; else cur[last] = r;
    }

    /* writes : [{ op:'set'|'update'|'delete', path, data, merge }] — tout
       ou rien : une erreur (document absent pour un update) n'écrit rien. */
    S.commit = function (writes) {
      var now = Date.now(), staged = {}, i, w;
      function cur(p) { return staged.hasOwnProperty(p) ? staged[p] : (readEnc(p) ? clonePlain(readEnc(p)) : null); }
      for (i = 0; i < writes.length; i++) {
        w = writes[i];
        if (w.op === 'delete') { staged[w.path] = null; continue; }
        var base = cur(w.path);
        if (w.op === 'update') {
          if (!base) { var e = new Error('5 NOT_FOUND: No document to update: ' + w.path); e.code = 'not-found'; throw e; }
          Object.keys(w.data).forEach(function (k) { setPathVal(base, k, w.data[k], now); });
          staged[w.path] = base;
        } else if (w.merge) {
          base = base || {};
          mergeInto(base, w.data, now);
          staged[w.path] = base;
        } else {
          staged[w.path] = resolve(w.data, undefined, now);
        }
      }
      Object.keys(staged).forEach(function (p) {
        if (staged[p] === null) { delete docs[p]; if (overlay[p]) tomb[p] = true; }
        else docs[p] = { d: staged[p], ct: docs[p] ? docs[p].ct : now, ut: now };
      });
      S.version++;
      scheduleSave();
      notifyAll(Object.keys(staged));
    };

    /* ── Requêtes ── */
    function cmpVal(a, b) {
      if (a && a.__ts !== undefined) a = a.__ts;
      if (b && b.__ts !== undefined) b = b.__ts;
      if (a === b) return 0;
      if (a === undefined || a === null) return -1;
      if (b === undefined || b === null) return 1;
      if (typeof a !== typeof b) return String(typeof a) < String(typeof b) ? -1 : 1;
      return a < b ? -1 : 1;
    }
    function match(d, f) {
      var v = f[0] === '__name__' ? undefined : getPath(d, f[0]), op = f[1], x = f[2];
      if (x && x.__ts !== undefined) x = x;
      switch (op) {
        case '==': return cmpVal(v, x) === 0 && v !== undefined;
        case '!=': return v !== undefined && cmpVal(v, x) !== 0;
        case '<': return v !== undefined && cmpVal(v, x) < 0;
        case '<=': return v !== undefined && cmpVal(v, x) <= 0;
        case '>': return v !== undefined && cmpVal(v, x) > 0;
        case '>=': return v !== undefined && cmpVal(v, x) >= 0;
        case 'in': return (x || []).some(function (y) { return cmpVal(v, y) === 0; });
        case 'not-in': return v !== undefined && !(x || []).some(function (y) { return cmpVal(v, y) === 0; });
        case 'array-contains': return Array.isArray(v) && v.some(function (y) { return deepEq(y, x); });
        case 'array-contains-any': return Array.isArray(v) && v.some(function (y) { return (x || []).some(function (z) { return deepEq(y, z); }); });
      }
      return false;
    }
    S.query = function (q) {
      var rows = S.list(q.col).filter(function (r) { return q.filters.every(function (f) { return match(r.d, f); }); });
      /* Firestore exclut d'un orderBy les documents sans le champ. */
      q.orders.forEach(function (o) { rows = rows.filter(function (r) { return getPath(r.d, o[0]) !== undefined; }); });
      rows.sort(function (a, b) {
        for (var i = 0; i < q.orders.length; i++) {
          var c = cmpVal(getPath(a.d, q.orders[i][0]), getPath(b.d, q.orders[i][0]));
          if (c) return q.orders[i][1] === 'desc' ? -c : c;
        }
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      if (q.limit != null) rows = q.limitToLast ? rows.slice(Math.max(0, rows.length - q.limit)) : rows.slice(0, q.limit);
      return rows;
    };

    /* ── Écouteurs ── */
    S.listen = function (fn, win) { lid++; listeners[lid] = { fn: fn, win: win }; return lid; };
    S.unlisten = function (id) { delete listeners[id]; };
    S.dropWindow = function (win) { Object.keys(listeners).forEach(function (k) { if (listeners[k].win === win) delete listeners[k]; }); };
    function notifyAll(paths) {
      Object.keys(listeners).forEach(function (k) {
        var L = listeners[k];
        setTimeout(function () {
          if (!listeners[k]) return;
          try {
            if (L.win && (L.win.closed || !L.win.document)) { delete listeners[k]; return; }
            L.fn(paths);
          } catch (e) { if (window.console) console.warn('[sandbox-db] écouteur', e && e.message); }
        }, 0);
      });
    }

    /* ── Sauvegarde locale (IndexedDB) — jamais le réseau ── */
    function idb() {
      return new Promise(function (ok, ko) {
        var r = indexedDB.open(IDB_NAME, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(IDB_STORE); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { ko(r.error); };
      });
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        var snap = { docs: docs, tomb: tomb };
        idb().then(function (db) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(JSON.stringify(snap), IDB_KEY);
        }).catch(function (e) { if (window.console) console.warn('[sandbox-db] sauvegarde', e && e.message); });
      }, 400);
    }
    S.load = function () {
      return idb().then(function (db) {
        return new Promise(function (ok) {
          var r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
          r.onsuccess = function () {
            try { var s = r.result ? JSON.parse(r.result) : null; if (s) { docs = s.docs || {}; tomb = s.tomb || {}; } } catch (e) {}
            ok();
          };
          r.onerror = function () { ok(); };
        });
      }).catch(function () {});
    };
    /* Efface des documents (et leurs sous-collections). filter(chemin) → bool. */
    S.wipe = function (filter) {
      Object.keys(docs).forEach(function (p) { if (!filter || filter(p, docs[p].d)) delete docs[p]; });
      Object.keys(tomb).forEach(function (p) { if (!filter || filter(p)) delete tomb[p]; });
      S.version++; scheduleSave(); notifyAll([]);
    };
    S.flush = function () { clearTimeout(saveTimer); saveTimer = null; scheduleSave(); };
    return S;
  }

  /* ═══ LES FAÇADES (une par fenêtre) ══════════════════════════════════ */
  function store() {
    var t = null;
    try { t = window.top.__SBX_STORE; } catch (e) { t = null; }
    if (!t) throw new Error('Bac à sable : ouvre cette page depuis Outils → Bac à sable closer.');
    return t;
  }

  /* Horodatage, dans la fenêtre de l'appelant. */
  function Timestamp(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds || 0; this.__sbxTs = true; }
  Timestamp.prototype.toMillis = function () { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); };
  Timestamp.prototype.toDate = function () { return new Date(this.toMillis()); };
  Timestamp.prototype.isEqual = function (o) { return o && o.toMillis && o.toMillis() === this.toMillis(); };
  Timestamp.prototype.valueOf = function () { return String(this.toMillis()).padStart(15, '0'); };
  Timestamp.prototype.toJSON = function () { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; };
  Timestamp.fromMillis = function (ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); };
  Timestamp.fromDate = function (d) { return Timestamp.fromMillis(d.getTime()); };
  Timestamp.now = function () { return Timestamp.fromMillis(Date.now()); };

  var FieldValue = {
    serverTimestamp: function () { return { __fv: 'serverTimestamp' }; },
    increment: function (n) { return { __fv: 'increment', v: n }; },
    arrayUnion: function () { return { __fv: 'arrayUnion', v: encode(Array.prototype.slice.call(arguments)) }; },
    arrayRemove: function () { return { __fv: 'arrayRemove', v: encode(Array.prototype.slice.call(arguments)) }; },
    delete: function () { return { __fv: 'delete' }; }
  };

  function encode(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (v.__fv) return v.__fv === 'arrayUnion' || v.__fv === 'arrayRemove' ? { __fv: v.__fv, v: v.v } : { __fv: v.__fv, v: v.v };
    if (v.__sbxTs || (typeof v.toMillis === 'function' && typeof v.seconds === 'number')) return { __ts: v.toMillis() };
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return { __ts: v.getTime() };
    if (v && v.__sbxRef) return { __ref: v.path };
    if (Array.isArray(v)) return v.map(function (x) { var e = encode(x); return e === undefined ? null : e; });
    var o = {};
    Object.keys(v).forEach(function (k) { var e = encode(v[k]); if (e !== undefined) o[k] = e; });
    return o;
  }
  function decode(v, fs) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(function (x) { return decode(x, fs); });
    if (v.__ts !== undefined && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
    if (v.__ref !== undefined && Object.keys(v).length === 1) return fs.doc(v.__ref);
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = decode(v[k], fs); });
    return o;
  }

  function makeFirestore(opts) {
    opts = opts || {};
    var fs = {};
    var win = opts.win || window;

    function DocSnap(ref, enc) {
      this.id = ref.id; this.ref = ref; this.exists = !!enc;
      this._d = enc;
      this.metadata = { hasPendingWrites: false, fromCache: false };
    }
    DocSnap.prototype.data = function () { return this._d ? decode(clonePlain(this._d), fs) : undefined; };
    DocSnap.prototype.get = function (f) { var d = this.data(); return d ? getPath(d, f) : undefined; };

    function QuerySnap(query, rows, prevIds) {
      var self = this;
      this.query = query;
      this.docs = rows.map(function (r) { return new DocSnap(fs.doc(r.path), r.d); });
      this.size = this.docs.length;
      this.empty = this.docs.length === 0;
      this._prev = prevIds;
      this.metadata = { hasPendingWrites: false, fromCache: false };
      this.forEach = function (cb, thisArg) { self.docs.forEach(cb, thisArg); };
    }
    QuerySnap.prototype.docChanges = function () {
      var prev = this._prev || {}, cur = {}, out = [];
      this.docs.forEach(function (d, i) {
        cur[d.id] = 1;
        out.push({ type: prev[d.id] ? 'modified' : 'added', doc: d, newIndex: i, oldIndex: prev[d.id] ? 0 : -1 });
      });
      Object.keys(prev).forEach(function (id) { if (!cur[id]) out.push({ type: 'removed', doc: new DocSnap(fs.doc(prev[id]), null), newIndex: -1, oldIndex: 0 }); });
      return out;
    };

    function normPath(p) { return String(p).replace(/^\/+|\/+$/g, ''); }

    function DocRef(path) {
      this.path = normPath(path);
      var s = this.path.split('/');
      this.id = s[s.length - 1];
      this.__sbxRef = true;
      this.firestore = fs;
    }
    Object.defineProperty(DocRef.prototype, 'parent', { get: function () { var s = this.path.split('/'); s.pop(); return new ColRef(s.join('/')); } });
    DocRef.prototype.collection = function (sub) { return new ColRef(this.path + '/' + sub); };
    DocRef.prototype.get = function () {
      var self = this, st = store();
      return st.ensure(this.parent.path).then(function () { return new DocSnap(self, st.read(self.path)); });
    };
    DocRef.prototype.set = function (data, o) {
      var p = this.path;
      return Promise.resolve().then(function () { store().commit([{ op: 'set', path: p, data: encode(data), merge: !!(o && (o.merge || o.mergeFields)) }]); return opts.admin ? { writeTime: Timestamp.now() } : undefined; });
    };
    DocRef.prototype.update = function (a, b) {
      var p = this.path, data = {};
      if (typeof a === 'string') { var args = Array.prototype.slice.call(arguments); for (var i = 0; i < args.length; i += 2) data[args[i]] = args[i + 1]; }
      else data = a;
      return Promise.resolve().then(function () { store().commit([{ op: 'update', path: p, data: encode(data) }]); return opts.admin ? { writeTime: Timestamp.now() } : undefined; });
    };
    DocRef.prototype.delete = function () { var p = this.path; return Promise.resolve().then(function () { store().commit([{ op: 'delete', path: p }]); }); };
    DocRef.prototype.onSnapshot = function () {
      var self = this, h = handlers(arguments), st = store(), last = null;
      function fire() {
        var enc = st.read(self.path), key = JSON.stringify(enc);
        if (key === last) return; last = key;
        try { h.next(new DocSnap(self, enc)); } catch (e) { if (window.console) console.error(e); }
      }
      st.ensure(this.parent.path).then(function () { last = null; fire(); });
      var id = st.listen(function () { fire(); }, win);
      return function () { st.unlisten(id); };
    };
    DocRef.prototype.isEqual = function (o) { return o && o.path === this.path; };

    function Query(col, spec) { this._col = col; this._s = spec || { col: col, filters: [], orders: [], limit: null, limitToLast: false }; this.firestore = fs; }
    function clone(q, patch) { var s = JSON.parse(JSON.stringify(q._s)); Object.keys(patch).forEach(function (k) { s[k] = patch[k]; }); return new Query(q._col, s); }
    Query.prototype.where = function (f, op, v) {
      var field = (f && f._sbxDocId) ? '__name__' : String(f);
      return clone(this, { filters: this._s.filters.concat([[field, op, encode(v)]]) });
    };
    Query.prototype.orderBy = function (f, dir) { return clone(this, { orders: this._s.orders.concat([[String(f), dir === 'desc' ? 'desc' : 'asc']]) }); };
    Query.prototype.limit = function (n) { return clone(this, { limit: n, limitToLast: false }); };
    Query.prototype.limitToLast = function (n) { return clone(this, { limit: n, limitToLast: true }); };
    Query.prototype.startAfter = function () { return this; };
    Query.prototype.get = function () {
      var self = this, st = store();
      return st.ensure(this._col).then(function () { return new QuerySnap(self, st.query(self._s), null); });
    };
    Query.prototype.onSnapshot = function () {
      var self = this, h = handlers(arguments), st = store(), last = null, prevIds = null;
      function fire() {
        var rows = st.query(self._s), key = JSON.stringify(rows);
        if (key === last) return; last = key;
        var snap = new QuerySnap(self, rows, prevIds);
        prevIds = {}; rows.forEach(function (r) { prevIds[r.id] = r.path; });
        try { h.next(snap); } catch (e) { if (window.console) console.error(e); }
      }
      st.ensure(this._col).then(fire);
      var id = st.listen(function () { fire(); }, win);
      return function () { st.unlisten(id); };
    };
    Query.prototype.count = function () {
      var self = this;
      return { get: function () { return self.get().then(function (s) { return { data: function () { return { count: s.size }; } }; }); } };
    };

    function ColRef(path) {
      Query.call(this, normPath(path));
      this.path = normPath(path);
      var s = this.path.split('/');
      this.id = s[s.length - 1];
    }
    ColRef.prototype = Object.create(Query.prototype);
    ColRef.prototype.doc = function (id) { return new DocRef(this.path + '/' + (id || randId(20))); };
    ColRef.prototype.add = function (data) { var r = this.doc(); return r.set(data).then(function () { return r; }); };
    Object.defineProperty(ColRef.prototype, 'parent', { get: function () { var s = this.path.split('/'); if (s.length < 2) return null; s.pop(); return new DocRef(s.join('/')); } });

    function handlers(args) {
      var a = Array.prototype.slice.call(args);
      if (a.length && typeof a[0] === 'object' && a[0] && typeof a[0].next !== 'function' && typeof a[1] === 'function') a.shift(); /* options */
      if (a[0] && typeof a[0] === 'object' && typeof a[0].next === 'function') return { next: a[0].next.bind(a[0]), error: (a[0].error || function () {}).bind(a[0]) };
      return { next: a[0] || function () {}, error: a[1] || function () {} };
    }

    function Batch() { this._w = []; }
    Batch.prototype.set = function (ref, d, o) { this._w.push({ op: 'set', path: ref.path, data: encode(d), merge: !!(o && o.merge) }); return this; };
    Batch.prototype.update = function (ref, d) { this._w.push({ op: 'update', path: ref.path, data: encode(d) }); return this; };
    Batch.prototype.delete = function (ref) { this._w.push({ op: 'delete', path: ref.path }); return this; };
    Batch.prototype.create = function (ref, d) { return this.set(ref, d); };
    Batch.prototype.commit = function () { var w = this._w; return Promise.resolve().then(function () { store().commit(w); return []; }); };

    fs.collection = function (p) { return new ColRef(p); };
    fs.doc = function (p) { return new DocRef(p); };
    fs.batch = function () { return new Batch(); };
    fs.runTransaction = function (fn) {
      var b = new Batch();
      var tx = {
        get: function (r) { return r.get(); },
        set: function (r, d, o) { b.set(r, d, o); return tx; },
        update: function (r, d) { b.update(r, d); return tx; },
        delete: function (r) { b.delete(r); return tx; },
        create: function (r, d) { b.set(r, d); return tx; }
      };
      return Promise.resolve().then(function () { return fn(tx); }).then(function (res) { return b.commit().then(function () { return res; }); });
    };
    fs.settings = function () {};
    fs.enablePersistence = function () { return Promise.resolve(); };
    fs.enableNetwork = fs.disableNetwork = function () { return Promise.resolve(); };
    fs.terminate = function () { return Promise.resolve(); };
    fs.getAll = function () { return Promise.all(Array.prototype.slice.call(arguments).map(function (r) { return r.get(); })); };
    fs.FieldValue = FieldValue;
    fs.Timestamp = Timestamp;
    return fs;
  }

  /* Le SDK compat v9 (firebase.*) tel que l'utilisent les pages. */
  function compat(win) {
    win = win || window;
    var fsInst = null, authInst = null, apps = [];
    function identity() { return store().identity; }
    function user() {
      var I = identity();
      return {
        uid: I.uid, email: I.email, displayName: I.name, emailVerified: true, isAnonymous: false, providerData: [],
        getIdToken: function () { return Promise.resolve('sbx.' + I.uid); },
        getIdTokenResult: function () { return Promise.resolve({ token: 'sbx.' + I.uid, claims: {} }); },
        reload: function () { return Promise.resolve(); }
      };
    }
    var fb = {
      SDK_VERSION: '9.23.0-bac-a-sable',
      apps: apps,
      initializeApp: function (cfg) { if (!apps.length) apps.push({ name: '[DEFAULT]', options: cfg || {} }); return apps[0]; },
      app: function () { return apps[0] || fb.initializeApp({}); },
      firestore: function () { if (!fsInst) fsInst = makeFirestore({ win: win }); return fsInst; },
      auth: function () {
        if (!authInst) {
          var u = user();
          authInst = {
            currentUser: u,
            onAuthStateChanged: function (cb) { setTimeout(function () { cb(u); }, 0); return function () {}; },
            onIdTokenChanged: function (cb) { setTimeout(function () { cb(u); }, 0); return function () {}; },
            signOut: function () { return Promise.resolve(); },
            setPersistence: function () { return Promise.resolve(); },
            useDeviceLanguage: function () {}
          };
        }
        return authInst;
      },
      storage: function () { throw new Error('Stockage indisponible dans le bac à sable.'); },
      functions: function () { return { httpsCallable: function () { return function () { return Promise.reject(new Error('Bloqué par le bac à sable.')); }; } }; }
    };
    fb.firestore.FieldValue = FieldValue;
    fb.firestore.Timestamp = Timestamp;
    fb.firestore.FieldPath = { documentId: function () { return { _sbxDocId: true }; } };
    fb.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
    fb.auth.GoogleAuthProvider = function () {};
    win.addEventListener('pagehide', function () { try { store().dropWindow(win); } catch (e) {} });
    return fb;
  }

  /* firebase-admin, tel que l'utilise le code serveur (api/*). */
  function admin() {
    var fsInst = null;
    var a = {
      apps: [{ name: '[DEFAULT]' }],
      initializeApp: function () { return a.apps[0]; },
      credential: { cert: function () { return {}; }, applicationDefault: function () { return {}; } },
      firestore: function () { if (!fsInst) fsInst = makeFirestore({ admin: true }); return fsInst; },
      auth: function () {
        return {
          verifyIdToken: function (tok) {
            var I = store().identity;
            if (String(tok || '') !== 'sbx.' + I.uid) return Promise.reject(new Error('Jeton invalide (bac à sable)'));
            return Promise.resolve({ uid: I.uid, email: I.email });
          },
          getUser: function (uid) { var I = store().identity; return Promise.resolve({ uid: uid, email: I.email, displayName: I.name }); }
        };
      },
      storage: function () { throw new Error('Stockage indisponible dans le bac à sable.'); }
    };
    a.firestore.FieldValue = FieldValue;
    a.firestore.Timestamp = Timestamp;
    a.firestore.FieldPath = { documentId: function () { return { _sbxDocId: true }; } };
    return a;
  }

  /* La fenêtre principale crée le magasin. */
  try { if (window === window.top && !window.__SBX_STORE) window.__SBX_STORE = createStore(); } catch (e) {}

  window.SBXDB = { compat: compat, admin: admin, Timestamp: Timestamp, FieldValue: FieldValue, encode: encode, store: store };
})();
