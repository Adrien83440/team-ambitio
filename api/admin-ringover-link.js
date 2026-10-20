// api/admin-ringover-link.js — relier le poste Ringover d'un commercial au dialer
// ----------------------------------------------------------------------------
// Le dialer (ringover-call-initiate) lance l'appel avec une clé API Ringover ;
// c'est le poste PROPRIÉTAIRE de la clé qui sonne. Chaque commercial doit donc
// avoir sa propre clé dans _config/telco_credentials.ringover.users.{uid}.
// Jusqu'ici elle se saisissait à la main dans la Console ; cet endpoint (admin
// uniquement, écran Admin → Numéros) la pose après contrôle.
//
//   GET                          → état des liaisons, SANS les clés
//                                  { links: { uid: { userId, keyEnd, ... } }, sharedUserId }
//   POST { action:'link', uid, apiKey }
//        → la clé est essayée chez Ringover (GET /users) : sans Monitoring,
//          Ringover ne renvoie QUE le propriétaire de la clé. Refus si la clé
//          est invalide, si elle voit toute l'équipe (Monitoring : impossible
//          de savoir quel poste sonnerait), ou si son propriétaire n'est pas
//          le poste de la ligne Ringover déclarée pour ce membre.
//   POST { action:'unlink', uid } → retire la clé du membre.
//
// La clé n'est JAMAIS renvoyée au navigateur (4 derniers caractères seulement).
// Chaque liaison / déliaison est tracée dans telco_link_log (sans la clé).
'use strict';

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { ringoverFetch, clearRingoverCredsCache } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

const CRED_REF = () => db.collection('_config').doc('telco_credentials');

function keyEnd(k) { return k ? String(k).slice(-4) : null; }

function tsToIso(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  return String(v);
}

async function nomAuteur(uid) {
  try {
    const s = await db.collection('users').doc(uid).get();
    const d = s.exists ? s.data() : {};
    return d.displayName || d.name || (d.email ? String(d.email).split('@')[0] : null) || uid;
  } catch (_) { return uid; }
}

/* Ligne Ringover active du membre (déclarée dans Admin → Numéros). */
async function ligneRingoverDe(uid) {
  const q = await db.collection('phone_numbers')
    .where('assignedTo', '==', uid)
    .where('provider', '==', 'ringover')
    .where('active', '==', true)
    .get();
  const lignes = [];
  q.forEach(d => { const x = d.data(); if (x.ringoverUserId) lignes.push({ id: d.id, phoneNumber: x.phoneNumber || null, ringoverUserId: String(x.ringoverUserId), slug: x.assignedToSlug || null }); });
  return lignes;
}

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs' });

  try {
    if (req.method === 'GET') {
      const snap = await CRED_REF().get();
      const ro = (snap.exists && snap.data().ringover) || {};
      const users = ro.users || {};
      const links = {};
      Object.keys(users).forEach(uid => {
        const u = users[uid] || {};
        links[uid] = {
          dedicated: !!u.apiKey,
          keyEnd: keyEnd(u.apiKey),
          userId: u.userId ? String(u.userId) : null,
          ownerName: u.ownerName || null,
          linkedAt: tsToIso(u.linkedAt),
          linkedByName: u.linkedByName || null,
        };
      });
      return res.status(200).json({ links, sharedUserId: ro.userId ? String(ro.userId) : null });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = parseBody(req) || {};
    const uid = String(body.uid || '').trim();
    if (!uid || uid.indexOf('.') >= 0 || uid.indexOf('/') >= 0) return res.status(400).json({ error: 'Membre invalide' });

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Compte introuvable pour ce membre' });
    const auteur = await nomAuteur(auth.uid);
    const fieldPath = new admin.firestore.FieldPath('ringover', 'users', uid);

    if (body.action === 'unlink') {
      const snap = await CRED_REF().get();
      const prev = snap.exists && snap.data().ringover && snap.data().ringover.users && snap.data().ringover.users[uid];
      if (!prev) return res.status(200).json({ ok: true, unchanged: true });
      await CRED_REF().update(fieldPath, admin.firestore.FieldValue.delete());
      await db.collection('telco_link_log').add({
        action: 'unlink', provider: 'ringover', uid, userId: prev.userId ? String(prev.userId) : null,
        keyEnd: keyEnd(prev.apiKey), by: auth.uid, byName: auteur,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      clearRingoverCredsCache();
      return res.status(200).json({ ok: true });
    }

    if (body.action !== 'link') return res.status(400).json({ error: 'Action inconnue' });

    const apiKey = String(body.apiKey || '').trim();
    if (apiKey.length < 20 || /\s/.test(apiKey)) return res.status(400).json({ error: 'Clé API invalide (copier la clé entière, sans espace).' });

    const lignes = await ligneRingoverDe(uid);
    if (!lignes.length) {
      return res.status(409).json({ error: "Ce membre n'a pas de ligne Ringover déclarée (avec son ID utilisateur Ringover). Déclarer d'abord sa ligne ci-dessous." });
    }
    const posteIds = Array.from(new Set(lignes.map(l => l.ringoverUserId)));
    if (posteIds.length > 1) {
      return res.status(409).json({ error: 'Ce membre a plusieurs lignes Ringover sur des postes différents (' + posteIds.join(', ') + ') : en retirer une avant de relier le dialer.' });
    }
    const poste = posteIds[0];

    // Contrôle chez Ringover : à qui appartient cette clé ?
    let data;
    try {
      data = await ringoverFetch('/users', { apiKey });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        return res.status(400).json({ error: "Ringover refuse cette clé : elle est invalide, ou il lui manque la permission « Users Read » (lecture des utilisateurs). Les permissions à cocher sont « Calls Write » et « Users Read »." });
      }
      console.error('[admin-ringover-link] Ringover /users:', e.status, e.message);
      return res.status(502).json({ error: 'Ringover ne répond pas (' + (e.status || 'réseau') + ') : réessayer dans un instant.' });
    }
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    if (list.length !== 1) {
      return res.status(409).json({ error: "Cette clé voit " + list.length + " utilisateurs Ringover (option « Monitoring » activée) : impossible de savoir quel téléphone sonnerait. Créer la clé SANS Monitoring, depuis le compte Ringover du commercial." });
    }
    const owner = list[0] || {};
    const ownerId = owner.user_id != null ? String(owner.user_id) : '';
    const ownerName = owner.concat_name || [owner.firstname, owner.lastname].filter(Boolean).join(' ') || owner.email || ownerId;
    if (ownerId !== poste) {
      return res.status(409).json({ error: "Cette clé appartient au poste Ringover de « " + ownerName + " » (ID " + ownerId + "), pas à celui de la ligne de ce membre (ID " + poste + "). L'enregistrer ferait sonner le mauvais téléphone." });
    }

    // Une même clé sur deux membres ferait sonner le même téléphone pour les deux.
    const snap = await CRED_REF().get();
    const ro = (snap.exists && snap.data().ringover) || {};
    const autres = Object.keys(ro.users || {}).filter(k => k !== uid && ro.users[k] && String(ro.users[k].userId || '') === ownerId);
    if (autres.length) {
      return res.status(409).json({ error: 'Ce poste Ringover (ID ' + ownerId + ') est déjà relié au dialer pour un autre membre. Le délier d\'abord.' });
    }

    const ligne = lignes[0];
    const prev = ro.users && ro.users[uid];
    const entree = {
      apiKey,
      userId: ownerId,
      fromNumber: ligne.phoneNumber || null,
      ownerName,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
      linkedBy: auth.uid,
      linkedByName: auteur,
    };
    if (prev && prev.device) entree.device = prev.device;
    await CRED_REF().update(fieldPath, entree);
    await db.collection('telco_link_log').add({
      action: prev ? 'replace' : 'link', provider: 'ringover', uid, slug: ligne.slug,
      userId: ownerId, ownerName, keyEnd: keyEnd(apiKey), previousKeyEnd: prev ? keyEnd(prev.apiKey) : null,
      by: auth.uid, byName: auteur, at: admin.firestore.FieldValue.serverTimestamp(),
    });
    clearRingoverCredsCache();
    return res.status(200).json({ ok: true, link: { dedicated: true, keyEnd: keyEnd(apiKey), userId: ownerId, ownerName } });
  } catch (e) {
    console.error('[admin-ringover-link]', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
