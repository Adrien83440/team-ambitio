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
//   POST { action:'link', uid, apiKey, confirmUnverified? }
//        → la clé est essayée chez Ringover pour trouver son propriétaire :
//          1. GET /users — sans Monitoring, Ringover ne renvoie QUE le
//             propriétaire. Mais l'écran Ringover grise la permission
//             « Utilisateurs » quand Monitoring est désactivé (20/10/2026) :
//             une clé normale reçoit donc 401 ici ;
//          2. GET /teams — aucune permission requise (sert aussi de test de
//             validité de la clé) ; sans Monitoring, données « limitées » :
//             un seul utilisateur renvoyé = le propriétaire.
//          Refus si la clé est invalide, si elle voit toute l'équipe
//          (Monitoring), ou si son propriétaire n'est pas le poste de la ligne
//          du membre. Si Ringover ne permet pas d'identifier le propriétaire,
//          409 code 'owner_unknown' : l'admin peut confirmer (champ
//          « Utilisateur » de la clé dans Ringover) et renvoyer avec
//          confirmUnverified:true → liaison enregistrée verified:false.
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

function nomRingover(u) {
  return u.concat_name || [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email || String(u.user_id);
}

/* Propriétaire d'une clé API Ringover.
   → { owner: { id, name } } | { owner: null } (clé valide, propriétaire inconnu)
   | { error, status } (clé refusée, Monitoring, Ringover indisponible). */
async function proprietaireCle(apiKey) {
  // 1. /users (permission « Users Read », rarement disponible sans Monitoring)
  try {
    const d = await ringoverFetch('/users', { apiKey });
    const list = (d && Array.isArray(d.list)) ? d.list : [];
    if (list.length > 1) {
      return { status: 409, error: "Cette clé voit " + list.length + " utilisateurs Ringover (option « Monitoring » activée) : impossible de savoir quel téléphone sonnerait. Créer la clé SANS Monitoring." };
    }
    if (list.length === 1 && list[0].user_id != null) return { owner: { id: String(list[0].user_id), name: nomRingover(list[0]) } };
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) console.warn('[admin-ringover-link] /users:', e.status, e.message);
  }
  // 2. /teams (aucune permission requise : sert aussi de test de validité)
  try {
    const t = await ringoverFetch('/teams', { apiKey });
    const users = (t && Array.isArray(t.users)) ? t.users : [];
    if (users.length === 1 && users[0].user_id != null) return { owner: { id: String(users[0].user_id), name: nomRingover(users[0]) } };
    return { owner: null };
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { status: 400, error: "Ringover refuse cette clé : elle est invalide ou a été supprimée. Copier la clé entière depuis Ringover → Développeur → Clé API." };
    }
    console.error('[admin-ringover-link] /teams:', e.status, e.message);
    return { status: 502, error: 'Ringover ne répond pas (' + (e.status || 'réseau') + ') : réessayer dans un instant.' };
  }
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
          verified: u.verified !== false,
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
    const probe = await proprietaireCle(apiKey);
    if (probe.error) return res.status(probe.status).json({ error: probe.error });
    let ownerId, ownerName, verified;
    if (probe.owner) {
      ownerId = probe.owner.id; ownerName = probe.owner.name; verified = true;
    } else if (body.confirmUnverified === true) {
      ownerId = poste; ownerName = null; verified = false;
    } else {
      return res.status(409).json({
        code: 'owner_unknown',
        error: "La clé est valide, mais Ringover ne dit pas à quel utilisateur elle appartient (droit « Utilisateurs » indisponible sans Monitoring). Vérifier dans Ringover que le champ « Utilisateur » de cette clé est bien ce commercial, puis confirmer ci-dessous.",
      });
    }
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
      ownerName: ownerName || null,
      verified,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
      linkedBy: auth.uid,
      linkedByName: auteur,
    };
    if (prev && prev.device) entree.device = prev.device;
    await CRED_REF().update(fieldPath, entree);
    await db.collection('telco_link_log').add({
      action: prev ? 'replace' : 'link', provider: 'ringover', uid, slug: ligne.slug,
      userId: ownerId, ownerName: ownerName || null, verified, keyEnd: keyEnd(apiKey), previousKeyEnd: prev ? keyEnd(prev.apiKey) : null,
      by: auth.uid, byName: auteur, at: admin.firestore.FieldValue.serverTimestamp(),
    });
    clearRingoverCredsCache();
    return res.status(200).json({ ok: true, link: { dedicated: true, keyEnd: keyEnd(apiKey), userId: ownerId, ownerName: ownerName || null, verified } });
  } catch (e) {
    console.error('[admin-ringover-link]', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
