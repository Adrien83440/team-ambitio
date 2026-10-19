// ============================================================================
// api/csm-consignes.js — MES NOTES CSM (consignes datées par client, 10/2026)
// ----------------------------------------------------------------------------
// Les petites informations que les admins (Adrien, Emily, Vincent) donnent à
// la CSM sur un client — mise en pause, « ne pas proposer de coaching
// individuel », engagement pris, arrangement de paiement… — et qu'elle doit
// garder en tête parfois plusieurs mois. Une consigne = un document
// csm_consignes/{id}, rattaché à la fiche du cockpit (clients/{clientId}).
// La CSM peut aussi se noter ses propres rappels (perso: true, déjà lus).
//
// GET  ?count=1                     → { unread } (badge du menu, CSM)
// GET  [?clientId=<id>]             → { consignes[], clients{}, today }
// GET  ?clients=1                   → { clients[] } (sélecteur de client)
// POST { action:'create', clientId, type, texte, debut, fin, urgent, pauseClient }
// POST { action:'update', id, type, texte, debut, fin }
// POST { action:'read', id }                  → accusé de lecture
// POST { action:'archive', id }               → retirée (jamais supprimée)
// POST { action:'reactivate', clientId }      → fin de pause : statut actif
//
// Rôles : admin + csm. Écritures serveur uniquement (règle Firestore fermée).
// Statut calculé à partir des dates (jour de Paris) :
//   upcoming (début futur) · active · ending (fin ≤ 7 j) · ended · archived
// Une consigne Pause peut passer le client en clientStatus 'paused' ; à la fin
// rien n'est réactivé automatiquement — « Fin de pause à traiter ».
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db, admin } = require('./_firebaseAdmin');

const ROLES = ['admin', 'csm'];
const TYPES = ['pause', 'ne_pas_proposer', 'engagement', 'paiement', 'info'];
const TYPE_TXT = { pause: '⏸ Pause', ne_pas_proposer: '🚫 Ne pas proposer', engagement: '🤝 Engagement pris', paiement: '💳 Paiement', info: 'ℹ️ Info' };
const ENDING_DAYS = 7;
const COL = 'csm_consignes';

function parisToday() {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function iso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v.toDate) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

function statusOf(c, today) {
  if (c.archived) return 'archived';
  if (c.debut && c.debut > today) return 'upcoming';
  if (c.fin && c.fin < today) return 'ended';
  if (c.fin && daysBetween(today, c.fin) <= ENDING_DAYS) return 'ending';
  return 'active';
}

function out(id, c, today) {
  return {
    id: id,
    clientId: c.clientId || '',
    clientNom: c.clientNom || '',
    type: c.type || 'info',
    texte: c.texte || '',
    debut: c.debut || null,
    fin: c.fin || null,
    perso: c.perso === true,
    urgent: c.urgent === true,
    pauseClient: c.pauseClient === true,
    createdAt: iso(c.createdAt),
    createdBy: c.createdBy || '',
    createdByName: c.createdByName || '',
    luAt: iso(c.luAt),
    luByName: c.luByName || '',
    updatedAt: iso(c.updatedAt),
    archived: c.archived === true,
    archivedAt: iso(c.archivedAt),
    archivedByName: c.archivedByName || '',
    history: Array.isArray(c.history) ? c.history.slice(-20) : [],
    status: statusOf(c, today),
    daysLeft: c.fin ? daysBetween(today, c.fin) : null,
  };
}

async function teamMembers() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? s.data().members : null;
    return Array.isArray(raw) ? raw : Object.values(raw || {});
  } catch (e) { return []; }
}
async function memberName(uid, email) {
  const list = await teamMembers();
  const m = list.find(function (x) { return x && x.firebaseUid === uid; });
  if (m) return m.shortName || m.displayName || m.fullName || email;
  return email || '';
}

async function clientsLite() {
  const snap = await db.collection('clients').select('nom', 'statut', 'ancienClient', 'clientStatus', 'programme', 'coachAssigned', 'coach').get();
  const map = {};
  snap.forEach(function (d) {
    const c = d.data() || {};
    map[d.id] = {
      id: d.id,
      nom: c.nom || '(sans nom)',
      active: c.statut !== 'inactif' && c.ancienClient !== true,
      clientStatus: c.clientStatus || '',
      programme: c.programme || '',
      coach: c.coachAssigned || c.coach || '',
    };
  });
  return map;
}

// Non lue = posée par quelqu'un d'autre, ni archivée ni terminée, sans accusé.
function isUnreadFor(c, auth, today) {
  if (auth.role !== 'csm') return false;
  if (c.perso || c.archived || c.luAt) return false;
  if (c.createdBy === auth.uid) return false;
  return statusOf(c, today) !== 'ended';
}

async function notifyCsm(id, c, byName) {
  // Popup « ⚡ immédiat » dans la cloche Infos équipe, ciblé sur la/les CSM.
  const us = await db.collection('users').where('role', '==', 'csm').get();
  const targets = [];
  us.forEach(function (d) { targets.push(d.id); });
  if (!targets.length) return;
  const members = await teamMembers();
  const names = targets.map(function (uid) {
    const m = members.find(function (x) { return x && x.firebaseUid === uid; });
    return m ? (m.shortName || m.displayName || m.fullName || uid) : uid;
  });
  const fin = c.fin ? ' (jusqu\'au ' + c.fin.slice(8, 10) + '/' + c.fin.slice(5, 7) + '/' + c.fin.slice(0, 4) + ')' : '';
  await db.collection('announcements').add({
    title: '📌 Consigne — ' + c.clientNom,
    body: (TYPE_TXT[c.type] || '') + fin + '\n\n' + c.texte,
    links: [{ label: 'Ouvrir dans Mes Notes', url: 'https://team.alteore.com/csm-notes.html?id=' + encodeURIComponent(id) }],
    audience: ['csm'],
    targets: targets,
    targetsNames: names,
    popup: true,
    urgent: true,
    active: true,
    createdAt: new Date(),
    createdBy: c.createdBy,
    createdByName: byName,
    source: 'csm_consigne',
    consigneId: id,
  });
}

function cleanFields(body, prev) {
  const type = TYPES.indexOf(body.type) >= 0 ? body.type : (prev ? prev.type : 'info');
  const texte = String(body.texte != null ? body.texte : (prev ? prev.texte : '')).trim().slice(0, 4000);
  const debut = isDay(body.debut) ? body.debut : (body.debut === '' || body.debut === null ? null : (prev ? prev.debut || null : null));
  const fin = isDay(body.fin) ? body.fin : (body.fin === '' || body.fin === null ? null : (prev ? prev.fin || null : null));
  return { type: type, texte: texte, debut: debut, fin: fin };
}

module.exports = async function (req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden', message: 'Réservé aux CSM et administrateurs.' }); return; }
  const today = parisToday();

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.clients) {
        const map = await clientsLite();
        const list = Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return a.nom.localeCompare(b.nom, 'fr'); });
        res.status(200).json({ ok: true, clients: list });
        return;
      }
      let query = db.collection(COL);
      if (q.clientId) query = query.where('clientId', '==', String(q.clientId));
      const snap = await query.get();
      if (q.count) {
        let n = 0;
        snap.forEach(function (d) { if (isUnreadFor(d.data() || {}, auth, today)) n++; });
        res.status(200).json({ ok: true, unread: n });
        return;
      }
      const items = [];
      snap.forEach(function (d) {
        const c = d.data() || {};
        const o = out(d.id, c, today);
        o.unread = isUnreadFor(c, auth, today);
        items.push(o);
      });
      items.sort(function (a, b) { return String(b.createdAt || '') < String(a.createdAt || '') ? -1 : 1; });
      // Statut actuel des clients concernés (fin de pause à traiter, actif…).
      const map = await clientsLite();
      const clients = {};
      items.forEach(function (it) { if (map[it.clientId]) clients[it.clientId] = map[it.clientId]; });
      res.status(200).json({ ok: true, consignes: items, clients: clients, today: today, me: { uid: auth.uid, role: auth.role } });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

    const body = parseBody(req);
    const byName = await memberName(auth.uid, auth.email);
    const nowIso = new Date().toISOString();

    if (body.action === 'create') {
      const clientId = String(body.clientId || '').trim();
      if (!clientId) { res.status(400).json({ ok: false, error: 'client_required', message: 'Choisis un client.' }); return; }
      const cRef = db.collection('clients').doc(clientId);
      const cSnap = await cRef.get();
      if (!cSnap.exists) { res.status(404).json({ ok: false, error: 'client_not_found', message: 'Client introuvable.' }); return; }
      const f = cleanFields(body, null);
      if (!f.texte) { res.status(400).json({ ok: false, error: 'empty', message: 'Écris la consigne.' }); return; }
      if (f.debut && f.fin && f.fin < f.debut) { res.status(400).json({ ok: false, error: 'bad_dates', message: 'La date de fin est avant la date de début.' }); return; }
      const perso = auth.role === 'csm';
      const doc = {
        clientId: clientId,
        clientNom: (cSnap.data() || {}).nom || '(sans nom)',
        type: f.type,
        texte: f.texte,
        debut: f.debut || today,
        fin: f.fin,
        perso: perso,
        urgent: !perso && body.urgent === true,
        pauseClient: f.type === 'pause' && body.pauseClient === true,
        archived: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: auth.uid,
        createdByName: byName,
        luAt: perso ? admin.firestore.FieldValue.serverTimestamp() : null,
        luBy: perso ? auth.uid : null,
        luByName: perso ? byName : '',
        history: [{ at: nowIso, by: auth.uid, byName: byName, action: 'create' }],
      };
      const ref = await db.collection(COL).add(doc);
      if (doc.pauseClient) {
        await cRef.update({ clientStatus: 'paused', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      if (doc.urgent) {
        try { await notifyCsm(ref.id, doc, byName); } catch (e) { console.error('[csm-consignes] notify', e); }
      }
      res.status(200).json({ ok: true, id: ref.id });
      return;
    }

    if (body.action === 'reactivate') {
      const clientId = String(body.clientId || '').trim();
      const cRef = db.collection('clients').doc(clientId);
      const cSnap = clientId ? await cRef.get() : null;
      if (!cSnap || !cSnap.exists) { res.status(404).json({ ok: false, error: 'client_not_found', message: 'Client introuvable.' }); return; }
      await cRef.update({ clientStatus: 'active', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      res.status(200).json({ ok: true });
      return;
    }

    const id = String(body.id || '').trim();
    if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
    const ref = db.collection(COL).doc(id);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'not_found', message: 'Consigne introuvable.' }); return; }
    const prev = snap.data() || {};
    // Admin : tout. CSM : ses propres rappels uniquement (+ accusé de lecture).
    const canEdit = auth.role === 'admin' || prev.createdBy === auth.uid;

    if (body.action === 'read') {
      if (prev.luAt) { res.status(200).json({ ok: true }); return; }
      await ref.update({
        luAt: admin.firestore.FieldValue.serverTimestamp(), luBy: auth.uid, luByName: byName,
        history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, by: auth.uid, byName: byName, action: 'read' }),
      });
      res.status(200).json({ ok: true });
      return;
    }
    if (!canEdit) { res.status(403).json({ ok: false, error: 'forbidden', message: 'Seul un admin (ou l\'auteur) peut modifier cette consigne.' }); return; }

    if (body.action === 'update') {
      const f = cleanFields(body, prev);
      if (!f.texte) { res.status(400).json({ ok: false, error: 'empty', message: 'Écris la consigne.' }); return; }
      if (f.debut && f.fin && f.fin < f.debut) { res.status(400).json({ ok: false, error: 'bad_dates', message: 'La date de fin est avant la date de début.' }); return; }
      const before = {};
      ['type', 'texte', 'debut', 'fin'].forEach(function (k) { if ((prev[k] || null) !== (f[k] || null)) before[k] = prev[k] || null; });
      if (!Object.keys(before).length) { res.status(200).json({ ok: true, unchanged: true }); return; }
      const upd = {
        type: f.type, texte: f.texte, debut: f.debut || prev.debut || today, fin: f.fin,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: auth.uid, updatedByName: byName,
        history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, by: auth.uid, byName: byName, action: 'update', before: before }),
      };
      // Un admin change le type, le texte ou la fin : la CSM doit relire.
      if (!prev.perso && (before.texte !== undefined || before.fin !== undefined || before.type !== undefined) && auth.role === 'admin') {
        upd.luAt = null; upd.luBy = null; upd.luByName = '';
      }
      await ref.update(upd);
      res.status(200).json({ ok: true });
      return;
    }
    if (body.action === 'archive') {
      await ref.update({
        archived: true, archivedAt: admin.firestore.FieldValue.serverTimestamp(), archivedBy: auth.uid, archivedByName: byName,
        history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, by: auth.uid, byName: byName, action: 'archive' }),
      });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[csm-consignes]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
