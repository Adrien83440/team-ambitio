// ============================================================================
// api/academy-access.js — LES CLÉS (V12d) : gestion d'accès Academy depuis
// le canal CSM (et les fiches admin) de Team Alteor.
// ----------------------------------------------------------------------------
// Marine peut, sans quitter Alteor :
//   - DÉSACTIVER / réactiver le compte de connexion d'un client (fin de
//     contrat non renouvelé, impayé…) — réversible, aucune donnée perdue ;
//   - RETIRER l'accès à une formation terminée ;
//   - DONNER l'accès à une autre formation (bascule de programme).
//
// URL  : POST https://team.alteore.com/api/academy-access
// Auth : Bearer ID token Firebase — rôles admin / csm UNIQUEMENT
//        (les coachs voient l'avancement mais ne touchent pas aux accès).
// Body : { action:"status"|"platform"|"grant"|"revoke", email,
//          disabled?, courseId?, clientId? }
//
// Chaque modification est tracée dans la fiche client
// (clients.academyAccessHistory, fail-soft) : qui, quand, quoi.
// Variables Vercel : ACADEMY_BRIDGE_KEY (déjà en place).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'csm'];

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function bridge(key, payload) {
  const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
    body: JSON.stringify(payload),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return j;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden' });
    return;
  }

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) {
    res.status(200).json({ ok: false, error: 'bridge_not_configured' });
    return;
  }

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { body = {}; }
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();
  const clientId = String(body.clientId || '').trim();
  if (!action || !email) {
    res.status(200).json({ ok: false, error: 'action_email_required' });
    return;
  }

  try {
    const payload = { action: action, email: email };
    if (action === 'platform') payload.disabled = body.disabled === true;
    if (action === 'grant' || action === 'revoke') payload.courseId = String(body.courseId || '').trim();

    const j = await bridge(key, payload);
    if (!j || j.ok !== true) {
      res.status(200).json({ ok: false, error: (j && j.error) || 'academy_unreachable' });
      return;
    }

    // Trace dans la fiche client (fail-soft : l'action est déjà faite).
    if (clientId && action !== 'status' && j.found) {
      try {
        let resume = '';
        if (action === 'platform') resume = payload.disabled ? '🔴 Compte Academy désactivé' : '🟢 Compte Academy réactivé';
        if (action === 'grant') resume = '➕ Accès ouvert : ' + cap((j.granted && j.granted.name) || payload.courseId, 120);
        if (action === 'revoke') resume = '➖ Accès retiré : ' + cap((j.revoked && j.revoked.name) || payload.courseId, 120);
        await db.collection('clients').doc(clientId).update({
          academyAccessHistory: admin.firestore.FieldValue.arrayUnion({
            at: Date.now(),
            by: auth.email || auth.uid,
            action: action,
            resume: resume,
          }),
        });
      } catch (e) { console.warn('[academy-access] trace fiche impossible:', e && e.message); }
    }

    res.status(200).json(j);
  } catch (e) {
    console.error('[academy-access]', e && e.message);
    res.status(200).json({ ok: false, error: 'internal' });
  }
};
