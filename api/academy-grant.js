// ============================================================================
// api/academy-grant.js — OUVERTURE D'ACCÈS AE ACADEMY SUR CONTRAT SIGNÉ (V11b)
// ----------------------------------------------------------------------------
// Appelé à DEUX moments :
//   1. Automatiquement par sign.html juste après la signature FINALE d'un
//      contrat (fire-and-forget, le signataire ne voit jamais une erreur) ;
//   2. Manuellement par le bouton « 🎓 Ouvrir l'accès » de sales-signatures
//      (rattrapage : échec passé, formation créée/renommée depuis, ou contrat
//      signé avant la mise en place de cette mécanique).
//
// URL  : POST https://team.alteore.com/api/academy-grant
// Body : { "requestId": "<id signature_requests>", "token": "<token signataire>" }
//
// AUTH PAR CAPACITÉ — pourquoi pas requireAuth : l'appel n°1 vient du
// navigateur du CLIENT qui signe (aucun compte équipe). La sécurité repose sur
// trois verrous, tous vérifiés CÔTÉ SERVEUR ici :
//   • le token doit correspondre à celui de la demande (le même secret de
//     64 caractères qui protège déjà l'accès à la page de signature) ;
//   • la demande doit réellement être au statut « signed » dans NOTRE
//     Firestore — impossible à falsifier depuis un navigateur ;
//   • l'ouverture côté Academy est une fusion douce idempotente : rejouer
//     l'appel n'a aucun effet de bord.
// Le secret du pont (ACADEMY_BRIDGE_KEY) ne quitte jamais ce serveur.
//
// CHOIX SUR LE MODÈLE (V11b) : signature_templates/{templateId}.academyCourseId
//   ''          → automatique (correspondance par nom du contrat, défaut)
//   '__none__'  → ce contrat n'ouvre volontairement AUCUN accès
//   '<id>'      → formation précise, transmise telle quelle au pont
//
// EFFETS :
//   • forward serveur → serveur vers l'Academy (/api/bridge/grant-access) ;
//   • tamponne le résultat sur la demande : academyGrant:{status, courseId,
//     courseName, candidates?, at} + un événement dans events[] ;
//   • si ouverture OK → dépose { action:'academy_access_granted', … } dans
//     webhook_inbox — le même canal que tes e-mails/SMS de signature : prêt
//     à brancher un e-mail de bienvenue Make/ActiveCampaign quand tu veux.
//
// Réponses 200 (fail-soft assumé pour l'appel automatique) :
//   { ok:true, granted:true, courseId, courseName, created, alreadyHadAccess }
//   { ok:true, granted:true, already:true, … }        → déjà ouvert avant
//   { ok:true, granted:false, reason:"not_found"|"ambiguous", candidates:[…] }
//   { ok:false, error:"bridge_not_configured"|"academy_unreachable" }
// Erreurs réelles : 401 (token) · 404 (demande) · 409 (pas encore signée) · 405
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

function tokenMatches(reqData, token) {
  if (!token) return false;
  if (reqData.token && reqData.token === token) return true;
  if (Array.isArray(reqData.signers)) {
    return reqData.signers.some((s) => s && s.token && s.token === token);
  }
  return false;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req);
  const requestId = (body.requestId || '').toString().trim();
  const token = (body.token || '').toString().trim();
  if (!requestId || !token) {
    res.status(400).json({ ok: false, error: 'requestId_and_token_required' });
    return;
  }

  try {
    // ── 1. La demande, revérifiée à la source ────────────────────────────────
    const ref = db.collection('signature_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'request_not_found' });
      return;
    }
    const r = snap.data();
    if (!tokenMatches(r, token)) {
      res.status(401).json({ ok: false, error: 'invalid_token' });
      return;
    }
    if (r.status !== 'signed') {
      res.status(409).json({ ok: false, error: 'not_signed_yet' });
      return;
    }

    // Déjà ouvert avec succès → idempotence courte, on renvoie l'existant.
    if (r.academyGrant && r.academyGrant.status === 'ok') {
      res.status(200).json({
        ok: true, granted: true, already: true,
        courseId: r.academyGrant.courseId || '', courseName: r.academyGrant.courseName || '',
      });
      return;
    }

    // Le choix explicite posé sur le modèle de contrat, s'il existe.
    let templateCourseId = '';
    if (r.templateId) {
      try {
        const tSnap = await db.collection('signature_templates').doc(r.templateId).get();
        if (tSnap.exists) templateCourseId = (tSnap.data().academyCourseId || '').toString();
      } catch (e) { /* illisible → on retombe sur l'automatique */ }
    }
    if (templateCourseId === '__none__') {
      // Volontaire : pas de tampon sur la demande, pas d'événement — silence propre.
      res.status(200).json({ ok: true, granted: false, reason: 'disabled_by_template' });
      return;
    }

    const clientEmail = ((Array.isArray(r.signers) && r.signers[0] && r.signers[0].email) || r.clientEmail || '').toString().trim().toLowerCase();
    const clientName = ((Array.isArray(r.signers) && r.signers[0] && r.signers[0].name) || r.clientName || '').toString().trim();
    const templateName = (r.templateName || '').toString().trim();
    const signedAtIso = (r.signedAt && r.signedAt.toDate) ? r.signedAt.toDate().toISOString() : new Date().toISOString();

    if (!clientEmail || !templateName) {
      await stamp(ref, { status: 'error', error: !clientEmail ? 'no_client_email' : 'no_template_name' });
      res.status(200).json({ ok: true, granted: false, reason: !clientEmail ? 'no_client_email' : 'no_template_name' });
      return;
    }

    // ── 2. Le pont, avec le secret (serveur → serveur) ──────────────────────
    const key = process.env.ACADEMY_BRIDGE_KEY || '';
    if (!key) {
      await stamp(ref, { status: 'error', error: 'bridge_not_configured' });
      res.status(200).json({ ok: false, error: 'bridge_not_configured' });
      return;
    }

    let j = null;
    try {
      const fRes = await fetch(ACADEMY_URL + '/api/bridge/grant-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
        body: JSON.stringify({ email: clientEmail, name: clientName, contractName: templateName, signedAt: signedAtIso, courseId: templateCourseId || undefined }),
      });
      j = await fRes.json().catch(() => null);
    } catch (e) {
      j = null;
    }
    if (!j || j.ok !== true) {
      await stamp(ref, { status: 'error', error: (j && j.error) || 'academy_unreachable' });
      res.status(200).json({ ok: false, error: 'academy_unreachable' });
      return;
    }

    // ── 3. Le tampon sur la demande + l'événement pipeline ──────────────────
    if (j.matched) {
      await stamp(ref, { status: 'ok', courseId: j.courseId, courseName: j.courseName, created: !!j.created, alreadyHadAccess: !!j.alreadyHadAccess });
      try {
        await db.collection('webhook_inbox').add({
          action: 'academy_access_granted',
          signatureRequestId: requestId,
          clientEmail: clientEmail,
          clientName: clientName,
          templateName: templateName,
          courseId: j.courseId,
          courseName: j.courseName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.warn('[academy-grant] webhook_inbox:', e && e.message); }
      res.status(200).json({ ok: true, granted: true, courseId: j.courseId, courseName: j.courseName, created: !!j.created, alreadyHadAccess: !!j.alreadyHadAccess });
    } else {
      await stamp(ref, { status: j.reason === 'ambiguous' ? 'ambiguous' : 'not_found', candidates: j.candidates || [] });
      res.status(200).json({ ok: true, granted: false, reason: j.reason, candidates: j.candidates || [] });
    }
  } catch (e) {
    console.error('[academy-grant]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};

// Écrit academyGrant + l'événement d'audit sur la demande (best-effort).
async function stamp(ref, grant) {
  try {
    await ref.update({
      academyGrant: Object.assign({}, grant, { at: admin.firestore.FieldValue.serverTimestamp() }),
      events: admin.firestore.FieldValue.arrayUnion({ type: 'academy_grant', status: grant.status, date: new Date().toISOString() }),
    });
  } catch (e) { console.warn('[academy-grant] stamp:', e && e.message); }
}
