/**
 * Functions/_tunnelHistory.js
 *
 * Historique des Tunnels de vente (19/10/2026).
 *
 * Chaque écriture sur tunnels/{tunnelId} (admin-tunnels.html, admin-site.html,
 * scripts) et sur _config/tunnels (domaines, redirections, inventaire
 * System.io) est comparée avant / après, et la liste des changements est
 * écrite dans tunnel_history/{autoId} :
 *
 *   { tunnelId, tunnelName, tunnelKind, at, op, by, changes[], count, truncated }
 *
 *   op      'create' | 'update' | 'baseline' | 'config'
 *   by      { uid, name, email, source } — lu dans le champ lastEdit posé par
 *           la page à chaque écriture (avec un nonce) ; lastEdit inchangé =
 *           écriture d'un script ou du serveur → by: null.
 *   changes [{ area, op, field, label, stepId, stepName, variantId, before, after }]
 *           area : tunnel | settings | step | variant | html | asset | config
 *           op   : add | remove | change | move
 *
 * « État de départ » : au premier changement d'un tunnel déjà existant, le
 * document AVANT modification est conservé tel quel dans
 * tunnel_history/{tunnelId}__baseline (op 'baseline').
 *
 * Le code HTML des pages n'est pas ici : chaque publication est copiée par la
 * page dans Storage tunnels/{t}/{s}/{v}/versions/{version}.html, et l'entrée
 * d'historique porte les numéros de version avant / après.
 *
 * Collection en lecture admin, écriture serveur seulement (firestore.rules) :
 * personne ne peut réécrire l'historique depuis un navigateur.
 *
 * Le préfixe underscore exclut ce fichier du routing Vercel — il n'est
 * importable que par index.js via Object.assign(exports, require('./_tunnelHistory')).
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const db = admin.firestore();

const COL = 'tunnel_history';
const MAX_VALUE = 4000;          // caractères gardés par valeur (avant / après)
const MAX_ENTRY = 700000;        // taille max d'une entrée (limite Firestore : 1 Mo)

const TUNNEL_IGNORE = { updatedAt: 1, lastEdit: 1, createdAt: 1, createdBy: 1, steps: 1, settings: 1, assets: 1 };
const STEP_IGNORE = { id: 1, variants: 1, createdAt: 1, createdBy: 1, updatedAt: 1, updatedBy: 1, archivedAt: 1, archivedBy: 1, restoredAt: 1 };
const VARIANT_IGNORE = { id: 1, html: 1, archivedAt: 1 };
const CONFIG_IGNORE = { lastEdit: 1, updatedAt: 1, sioPagesUpdatedAt: 1, redirectsUpdatedAt: 1, redirects: 1, sioPages: 1 };

const TUNNEL_LABELS = { name: 'Nom', slug: 'Slug', kind: 'Nature', status: 'Statut', homeStepId: 'Page d\'accueil', archived: 'Archivé' };
const SETTINGS_LABELS = {
  host: 'Domaine', trackingSource: 'Source de tracking', pixelId: 'ID pixel Meta', leadType: 'Type de lead', crmLabel: 'Nom affiché dans Leads Live',
  defaultChannel: 'Canal par défaut', bookingType: 'Type de RDV lié', requiredFields: 'Champs obligatoires à l\'opt-in',
  noindex: 'noindex', faviconUrl: 'Favicon', ogImage: 'Image de partage', headHtml: 'Code <head>', notes: 'Notes'
};
const STEP_LABELS = {
  name: 'Nom', slug: 'Chemin', type: 'Type', status: 'Statut', next: 'Après l\'opt-in', 'seo.title': 'Titre SEO',
  'seo.description': 'Description SEO', 'seo.ogImage': 'Image de partage', pixelEvent: 'Événement Meta',
  noindex: 'noindex', headHtml: 'Code <head>', trackingSource: 'Source de tracking', archived: 'Archivée'
};
const VARIANT_LABELS = { label: 'Libellé', weight: 'Poids', status: 'Statut', archived: 'Archivée', previews: 'Écrans d\'aperçu' };
const CONFIG_LABELS = { primaryHost: 'Domaine principal', hosts: 'Domaines' };

/* ─── Valeurs ─── */

/* Timestamps → ISO, objets triés par clé : deux valeurs égales donnent la même
   chaîne JSON, quel que soit l'ordre d'écriture des clés. */
function norm(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (e) { return null; } }
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach(function (k) { out[k] = norm(v[k]); });
    return out;
  }
  return v;
}
function same(a, b) { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); }
function isEmpty(v) { return v == null || v === '' || (Array.isArray(v) && !v.length); }

/* Valeur stockée dans l'historique : tronquée au-delà de MAX_VALUE caractères
   (code <head>, notes…), avec la longueur d'origine. */
function clip(v) {
  v = norm(v);
  if (v == null) return null;
  if (typeof v === 'string') return v.length > MAX_VALUE ? { __clip: true, text: v.slice(0, MAX_VALUE), length: v.length } : v;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > MAX_VALUE ? { __clip: true, text: s.slice(0, MAX_VALUE), length: s.length } : v;
  }
  return v;
}
function byId(list) {
  const map = {};
  (Array.isArray(list) ? list : []).forEach(function (x) { if (x && x.id) map[x.id] = x; });
  return map;
}

/* ─── Comparaison d'un document tunnel ─── */

function stepSummary(s) {
  return { name: s.name || '', slug: s.slug || '', type: s.type || '', status: s.status || '', variants: (s.variants || []).length };
}
function htmlMeta(h) {
  if (!h || !h.path) return null;
  return { version: h.version || null, size: h.size || 0, fileName: h.fileName || '', path: h.path, updatedAt: h.updatedAt || '' };
}
/* Champs d'une étape à plat : seo.title, seo.description… Les autres objets
   (next) sont comparés entiers. */
function flatStep(s) {
  const out = {};
  Object.keys(s || {}).forEach(function (k) {
    if (STEP_IGNORE[k]) return;
    if (k === 'seo' && s.seo && typeof s.seo === 'object') {
      Object.keys(s.seo).forEach(function (sk) { out['seo.' + sk] = s.seo[sk]; });
      return;
    }
    out[k] = s[k];
  });
  return out;
}
function diffFields(before, after, ignore, labels, base, push) {
  const keys = {};
  Object.keys(before || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(after || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).sort().forEach(function (k) {
    if (ignore && ignore[k]) return;
    const b = before ? before[k] : undefined, a = after ? after[k] : undefined;
    if (same(b, a) || (isEmpty(b) && isEmpty(a))) return;
    push(Object.assign({}, base, { op: 'change', field: k, label: labels[k] || k, before: clip(b), after: clip(a) }));
  });
}

function diffTunnel(before, after) {
  before = Object.assign({}, before, { kind: before.kind || 'funnel' });
  after = Object.assign({}, after, { kind: after.kind || 'funnel' });
  const changes = [];
  function push(c) { changes.push(c); }

  diffFields(before, after, TUNNEL_IGNORE, TUNNEL_LABELS, { area: 'tunnel' }, push);
  diffFields(before.settings || {}, after.settings || {}, null, SETTINGS_LABELS, { area: 'settings' }, push);

  /* Étapes : ajoutées, retirées (archiver une étape la retire du document :
     son contenu est gardé ici), modifiées, ordre. */
  const bs = byId(before.steps), as = byId(after.steps);
  (after.steps || []).forEach(function (s) {
    if (!s || !s.id) return;
    const o = bs[s.id];
    const ctx = { stepId: s.id, stepName: s.name || s.slug || '' };
    if (!o) { push(Object.assign({ area: 'step', op: 'add', field: 'step', label: 'Étape ajoutée', before: null, after: stepSummary(s) }, ctx)); }
    else diffFields(flatStep(o), flatStep(s), null, STEP_LABELS, Object.assign({ area: 'step' }, ctx), push);

    const bv = byId(o ? o.variants : []), av = byId(s.variants);
    (s.variants || []).forEach(function (v) {
      if (!v || !v.id) return;
      const ov = bv[v.id];
      const vctx = Object.assign({ variantId: v.id }, ctx);
      if (!ov && o) push(Object.assign({ area: 'variant', op: 'add', field: 'variant', label: 'Variante ajoutée', before: null, after: clip({ label: v.label || '', weight: v.weight, status: v.status || '' }) }, vctx));
      if (ov) diffFields(ov, v, VARIANT_IGNORE, VARIANT_LABELS, Object.assign({ area: 'variant' }, vctx), push);
      const hb = htmlMeta(ov && ov.html), ha = htmlMeta(v.html);
      if (!same(hb && hb.version, ha && ha.version) || !same(hb && hb.path, ha && ha.path)) {
        push(Object.assign({ area: 'html', op: hb ? (ha ? 'change' : 'remove') : 'add', field: 'html', label: 'Code HTML', before: hb, after: ha }, vctx));
      }
    });
    Object.keys(bv).forEach(function (vid) {
      if (av[vid]) return;
      const ov = bv[vid];
      push(Object.assign({ area: 'variant', op: 'remove', field: 'variant', label: 'Variante retirée', variantId: vid, before: clip({ label: ov.label || '', weight: ov.weight, status: ov.status || '', html: htmlMeta(ov.html) }), after: null }, ctx));
    });
  });
  (before.steps || []).forEach(function (s) {
    if (!s || !s.id || as[s.id]) return;
    push({ area: 'step', op: 'remove', field: 'step', label: 'Étape retirée (archivée)', stepId: s.id, stepName: s.name || s.slug || '', before: stepSummary(s), after: null, snapshot: clip(s) });
  });

  /* Ordre des étapes communes aux deux versions. */
  const ob = (before.steps || []).filter(function (s) { return s && as[s.id]; }).map(function (s) { return s.id; });
  const oa = (after.steps || []).filter(function (s) { return s && bs[s.id]; }).map(function (s) { return s.id; });
  if (ob.join('|') !== oa.join('|')) {
    push({
      area: 'tunnel', op: 'move', field: 'order', label: 'Ordre des étapes',
      before: ob.map(function (id) { return bs[id].name || bs[id].slug || id; }),
      after: oa.map(function (id) { return as[id].name || as[id].slug || id; })
    });
  }

  /* Médias : par chemin Storage. */
  const ba = {}, aa = {};
  (before.assets || []).forEach(function (x) { if (x && x.path) ba[x.path] = x; });
  (after.assets || []).forEach(function (x) { if (x && x.path) aa[x.path] = x; });
  Object.keys(aa).forEach(function (p) {
    if (!ba[p]) push({ area: 'asset', op: 'add', field: 'asset', label: aa[p].role === 'favicon' ? 'Favicon déposé' : 'Média déposé', before: null, after: { name: aa[p].name || '', url: aa[p].url || '', size: aa[p].size || 0 } });
  });
  Object.keys(ba).forEach(function (p) {
    if (!aa[p]) push({ area: 'asset', op: 'remove', field: 'asset', label: 'Média retiré', before: { name: ba[p].name || '', url: ba[p].url || '', size: ba[p].size || 0 }, after: null });
  });
  return changes;
}

/* ─── Comparaison de _config/tunnels ─── */

function diffKeyed(beforeList, afterList, keyOf, fields, label, push) {
  const b = {}, a = {};
  (Array.isArray(beforeList) ? beforeList : []).forEach(function (r) { if (r && keyOf(r)) b[keyOf(r)] = r; });
  (Array.isArray(afterList) ? afterList : []).forEach(function (r) { if (r && keyOf(r)) a[keyOf(r)] = r; });
  Object.keys(a).sort().forEach(function (k) {
    if (!b[k]) { push({ area: 'config', op: 'add', field: label.field, label: label.add, key: k, before: null, after: clip(a[k]) }); return; }
    fields.forEach(function (f) {
      if (same(b[k][f], a[k][f]) || (isEmpty(b[k][f]) && isEmpty(a[k][f]))) return;
      push({ area: 'config', op: 'change', field: label.field + '.' + f, label: label.change + ' /' + k + ' — ' + f, key: k, before: clip(b[k][f]), after: clip(a[k][f]) });
    });
  });
  Object.keys(b).sort().forEach(function (k) {
    if (!a[k]) push({ area: 'config', op: 'remove', field: label.field, label: label.remove, key: k, before: clip(b[k]), after: null });
  });
}
function diffConfig(before, after) {
  const changes = [];
  function push(c) { changes.push(c); }
  diffFields(before, after, CONFIG_IGNORE, CONFIG_LABELS, { area: 'config' }, push);
  diffKeyed(before.redirects, after.redirects, function (r) { return r.from; }, ['to', 'code'],
    { field: 'redirect', add: 'Redirection ajoutée', change: 'Redirection', remove: 'Redirection retirée' }, push);
  diffKeyed(before.sioPages, after.sioPages, function (r) { return r.path; }, ['decision', 'target', 'note', 'group', 'title'],
    { field: 'sioPage', add: 'Inventaire System.io : adresse ajoutée', change: 'Inventaire System.io', remove: 'Inventaire System.io : adresse retirée' }, push);
  return changes;
}

/* ─── Auteur ─── */

const _names = {};
async function authorOf(before, after) {
  const le = after && after.lastEdit;
  if (!le || !le.uid || same(before && before.lastEdit, le)) return null;
  if (!_names[le.uid]) {
    let name = '';
    try {
      const u = await db.collection('users').doc(le.uid).get();
      if (u.exists) {
        const d = u.data() || {};
        name = d.fullName || d.displayName || [d.firstName, d.lastName].filter(Boolean).join(' ') || '';
      }
    } catch (e) { console.warn('[tunnelHistory] users/' + le.uid + ' :', e.message); }
    _names[le.uid] = name || le.email || le.uid;
  }
  return { uid: le.uid, name: _names[le.uid], email: le.email || '', source: le.source || '' };
}

/* Entrée bornée à MAX_ENTRY : au-delà, les derniers changements sont comptés
   (truncated) mais pas stockés. */
function fitChanges(changes) {
  const kept = [];
  let size = 0;
  for (let i = 0; i < changes.length; i++) {
    const s = JSON.stringify(changes[i]).length;
    if (size + s > MAX_ENTRY) break;
    kept.push(changes[i]); size += s;
  }
  return { kept: kept, truncated: changes.length - kept.length };
}

async function writeBaselineOnce(tunnelId, before) {
  const ref = db.collection(COL).doc(tunnelId + '__baseline');
  const snap = await ref.get();
  if (snap.exists) return;
  let at = before.updatedAt && typeof before.updatedAt.toDate === 'function' ? before.updatedAt : null;
  if (!at) at = admin.firestore.Timestamp.fromMillis(Date.now() - 1000);
  let snapshot = norm(before);
  if (JSON.stringify(snapshot).length > MAX_ENTRY) snapshot = { __clip: true, text: JSON.stringify(snapshot).slice(0, MAX_ENTRY), length: JSON.stringify(snapshot).length };
  await ref.set({
    tunnelId: tunnelId, tunnelName: before.name || '', tunnelKind: before.kind || 'funnel',
    at: at, op: 'baseline', by: null, changes: [], count: 0, truncated: 0, snapshot: snapshot
  });
}

exports.onTunnelHistory = functions.firestore
  .document('tunnels/{tunnelId}')
  .onWrite(async (change, context) => {
    const tunnelId = context.params.tunnelId;
    if (!change.after.exists) return null;   // jamais de suppression (rules), rien à tracer
    const after = change.after.data() || {};
    const before = change.before.exists ? (change.before.data() || {}) : null;
    try {
      const by = await authorOf(before, after);
      if (!before) {
        await db.collection(COL).add({
          tunnelId: tunnelId, tunnelName: after.name || '', tunnelKind: after.kind || 'funnel',
          at: admin.firestore.FieldValue.serverTimestamp(), op: 'create',
          by: by || (after.createdBy ? { uid: after.createdBy, name: '', email: '', source: '' } : null),
          changes: [{ area: 'tunnel', op: 'add', field: 'tunnel', label: 'Création', before: null, after: { name: after.name || '', slug: after.slug || '', kind: after.kind || 'funnel', steps: (after.steps || []).length } }],
          count: 1, truncated: 0
        });
        return null;
      }
      const changes = diffTunnel(before, after);
      if (!changes.length) return null;
      await writeBaselineOnce(tunnelId, before);
      const fit = fitChanges(changes);
      await db.collection(COL).add({
        tunnelId: tunnelId, tunnelName: after.name || before.name || '', tunnelKind: after.kind || 'funnel',
        at: admin.firestore.FieldValue.serverTimestamp(), op: 'update', by: by,
        changes: fit.kept, count: changes.length, truncated: fit.truncated
      });
    } catch (e) {
      console.error('[tunnelHistory] ' + tunnelId + ' :', e && e.message);
    }
    return null;
  });

exports.onTunnelConfigHistory = functions.firestore
  .document('_config/tunnels')
  .onWrite(async (change) => {
    if (!change.after.exists) return null;
    const after = change.after.data() || {};
    const before = change.before.exists ? (change.before.data() || {}) : {};
    try {
      const changes = diffConfig(before, after);
      if (!changes.length) return null;
      const fit = fitChanges(changes);
      await db.collection(COL).add({
        tunnelId: '_config', tunnelName: 'Domaines & redirections', tunnelKind: 'config',
        at: admin.firestore.FieldValue.serverTimestamp(), op: 'config', by: await authorOf(before, after),
        changes: fit.kept, count: changes.length, truncated: fit.truncated
      });
    } catch (e) {
      console.error('[tunnelHistory] _config/tunnels :', e && e.message);
    }
    return null;
  });

/* Pour les tests locaux (node -e) — index.js n'importe que les deux triggers. */
exports.diffTunnel = diffTunnel;
exports.diffConfig = diffConfig;
