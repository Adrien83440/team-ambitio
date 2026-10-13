// ============================================================================
// api/signature-cancel.js — ANNULER UN CONTRAT DÉJÀ SIGNÉ (admin)
// ----------------------------------------------------------------------------
// POST /api/signature-cancel   { requestId, reason }  + Bearer (admin)
//   → 200 { ok:true, academy:{ status, courseId?, courseName?, reason? } }
//   → 200 { ok:true, already:true, academy }   déjà annulé
//   → 400 reason_required · 404 request_not_found · 409 not_signed
//
// POURQUOI
// --------
// Un contrat signé peut devenir caduc : Hugo Michel signe Élite le 12/10,
// ne paie pas, et repart le lendemain sur Business Phénix. Le contrat Élite
// restait « signé » partout : preuve de close pour le pilote, contrat valide
// pour Paiements, accès Elite Phénix ouvert dans l'Academy.
//
// CE QUE FAIT L'ANNULATION
// ------------------------
//   · status 'signed' → 'cancelled' : toutes les lectures « contrat signé »
//     (pilote de closing, Paiements, Leads Live, fiche coaching) l'ignorent
//     d'elles-mêmes, comme un contrat jamais signé ;
//   · RIEN n'est supprimé : PDF signé, certificat, journal de preuve et
//     signataires restent intacts. cancelledAfterSigning:true le distingue
//     d'une demande annulée avant signature ; motif, auteur et date sont
//     posés sur la demande ET dans le journal chaîné (audit) ;
//   · l'accès Academy ouvert PAR CE CONTRAT est retiré — sauf si le client
//     l'avait déjà avant (alreadyHadAccess) ou si un autre contrat signé non
//     annulé donne la même formation ;
//   · une ligne dans la timeline de la fiche lead.
// La fiche lead, les paiements et la fiche coaching ne sont PAS modifiés :
// annuler un contrat ne dit pas ce que devient le client (il peut, comme
// Hugo, avoir signé autre chose). Ces décisions restent humaines.
//
// REJEU : un appel sur un contrat déjà annulé dont le retrait Academy a
// échoué retente ce seul retrait.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { appendAudit, clientInfo } = require('./_sign-core');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

function emailDe(R) {
  const s = Array.isArray(R.signers) && R.signers[0];
  return String((s && s.email) || R.clientEmail || '').trim().toLowerCase();
}

function frNow() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

/* Retire l'accès Academy ouvert par ce contrat, si rien d'autre ne le justifie. */
async function retirerAcademy(requestId, R) {
  const g = R.academyGrant || null;
  if (!g || g.status !== 'ok' || !g.courseId) return { status: 'skipped', reason: 'aucun_acces_ouvert' };
  const base = { courseId: g.courseId, courseName: g.courseName || null };
  if (g.alreadyHadAccess === true) return Object.assign(base, { status: 'kept', reason: 'acces_anterieur' });

  const email = emailDe(R);
  if (!email) return Object.assign(base, { status: 'error', reason: 'no_client_email' });

  const autres = await db.collection('signature_requests').where('clientEmail', '==', R.clientEmail || email).get();
  const justifie = autres.docs.some(function (d) {
    if (d.id === requestId) return false;
    const x = d.data() || {};
    return x.status === 'signed' && x.academyGrant && x.academyGrant.status === 'ok' && x.academyGrant.courseId === g.courseId;
  });
  if (justifie) return Object.assign(base, { status: 'kept', reason: 'autre_contrat_signe' });

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) return Object.assign(base, { status: 'error', reason: 'bridge_not_configured' });
  let j = null;
  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ action: 'revoke', email: email, courseId: g.courseId }),
    });
    j = await r.json().catch(function () { return null; });
  } catch (e) { j = null; }
  if (!j || j.ok !== true) return Object.assign(base, { status: 'error', reason: (j && j.error) || 'academy_unreachable' });
  if (j.found === false) return Object.assign(base, { status: 'skipped', reason: 'compte_academy_introuvable' });
  return Object.assign(base, { status: 'ok' });
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req) || {};
  const requestId = String(body.requestId || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!requestId) { res.status(400).json({ ok: false, error: 'requestId_required' }); return; }

  try {
    const ref = db.collection('signature_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'request_not_found' }); return; }
    const R = snap.data() || {};
    const par = auth.email || auth.uid;

    /* Déjà annulé : seul le retrait Academy en échec se rejoue. */
    if (R.status === 'cancelled' && R.cancelledAfterSigning === true) {
      let academy = R.academyRevoke || null;
      if (academy && academy.status === 'error') {
        academy = await retirerAcademy(requestId, R);
        await ref.update({ academyRevoke: Object.assign({}, academy, { at: admin.firestore.FieldValue.serverTimestamp(), by: par }) });
      }
      res.status(200).json({ ok: true, already: true, academy: academy });
      return;
    }
    if (R.status !== 'signed') { res.status(409).json({ ok: false, error: 'not_signed' }); return; }
    if (reason.length < 3) { res.status(400).json({ ok: false, error: 'reason_required' }); return; }

    /* 1. L'annulation elle-même — écrite AVANT tout appel externe : si
       l'Academy ne répond pas, le contrat est quand même annulé. */
    await ref.update({
      status: 'cancelled',
      statusBeforeCancel: 'signed',
      cancelledAfterSigning: true,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: par,
      cancelledByUid: auth.uid,
      cancelReason: reason,
      events: admin.firestore.FieldValue.arrayUnion({ type: 'contrat_annule', date: new Date().toISOString(), by: par, reason: reason }),
    });

    /* 2. L'accès Academy ouvert par ce contrat. */
    const academy = await retirerAcademy(requestId, R);
    await ref.update({ academyRevoke: Object.assign({}, academy, { at: admin.firestore.FieldValue.serverTimestamp(), by: par }) });

    /* 3. Journal de preuve chaîné. */
    await appendAudit(ref, [{ type: 'contrat_annule', signer: null, data: { motif: reason, par: par, academy: academy.status } }], clientInfo(req))
      .catch(function (e) { console.warn('[signature-cancel] journal:', e && e.message); });

    /* 4. Trace sur la fiche lead (sans toucher à son statut). */
    if (R.leadId) {
      try {
        await db.collection('leads').doc(R.leadId).update({
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '🚫 Contrat annulé — ' + (R.templateName || 'Contrat') + ' (' + reason + ')',
            date: frNow(),
            color: '#ef4444',
          }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.warn('[signature-cancel] timeline lead:', e && e.message); }
    }

    console.log('[signature-cancel]', requestId, R.templateName || '', 'par=' + par, 'academy=' + academy.status, academy.reason || '');
    res.status(200).json({ ok: true, academy: academy });
  } catch (e) {
    console.error('[signature-cancel]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
