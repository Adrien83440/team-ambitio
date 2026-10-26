// ============================================================================
// api/booking-guard.js
// ----------------------------------------------------------------------------
// LISTE DE BLOCAGE — vérification avant la prise de RDV (booking.html).
//
// URL  : POST https://team.alteore.com/api/booking-guard
// Auth : aucune — booking.html est une page publique.
// Body : { email?, telephone?, typeId?, personId?, date?, time? }
//
// Réponse (toujours 200, sauf méthode) :
//   { ok:true, allowed:true }
//   { ok:true, allowed:false }   → booking.html n'écrit RIEN et affiche une
//                                  confirmation normale (le bot ne doit pas
//                                  savoir qu'il est bloqué).
//
// ─── POURQUOI ──────────────────────────────────────────────────────────
// Incident 25/10/2026 : un bot (« LoulouNina Sagas Sega… ») dont le numéro
// était blacklisté depuis le 13/10 a repris 4 RDV en 7 minutes. La liste
// blocked_contacts (api/lead-block.js) n'était lue qu'à l'opt-in
// (lead-optin, tunnel-optin, alteoform-submit) : booking.html écrit le RDV
// directement dans Firestore et ne la consultait jamais. Chaque RDV créait
// un événement Google dans l'agenda d'un closer, un e-mail, des SMS de
// rappel — et remontait dans les RDV de l'équipe.
//
// booking.html appelle cet endpoint AVANT /api/booking-attribution et
// /api/booking-setter-attribution, qui créent ou mettent à jour la fiche
// lead : un contact bloqué ne touche donc à rien.
//
// ─── FAIL-OPEN ─────────────────────────────────────────────────────────
// Firestore injoignable → allowed:true, comme les vérifications d'opt-in :
// mieux vaut laisser passer un bot que refuser un vrai prospect. Côté page,
// une erreur réseau laisse aussi passer.
//
// ─── TRACE ─────────────────────────────────────────────────────────────
// Chaque tentative refusée est notée dans audit_log (type booking_blocked)
// pour qu'on voie le bot revenir. Best-effort, n'empêche jamais la réponse.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

/* 9 derniers chiffres — MÊME normalisation que api/lead-block.js,
   api/lead-optin.js et api/alteoform-submit.js. Toute divergence ici
   laisserait passer un numéro pourtant bloqué. */
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

/* Lecture par ID de document (clés déterministes de lead-block.js) : deux
   get() au pire, aucune requête ni index. Retourne la clé qui a matché, ou
   null — y compris en cas d'erreur Firestore (fail-open). */
async function isBlockedContact(emailLc, phoneNorm) {
  const keys = [];
  if (emailLc) keys.push('email:' + emailLc.replace(/\//g, '_'));
  if (phoneNorm) keys.push('phone:' + String(phoneNorm).replace(/\//g, '_'));
  if (!keys.length) return null;
  try {
    const snaps = await Promise.all(keys.map((k) => db.collection('blocked_contacts').doc(k).get()));
    for (let i = 0; i < snaps.length; i++) if (snaps[i].exists) return keys[i];
    return null;
  } catch (e) {
    console.warn('[booking-guard] blocklist injoignable, on laisse passer :', e && e.message);
    return null;
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max || 200) : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req);
  const emailLc = String(body.email || '').trim().toLowerCase();
  const phoneNorm = phoneNormalized(body.telephone);

  const blockHit = await isBlockedContact(emailLc, phoneNorm);
  if (!blockHit) {
    res.status(200).json({ ok: true, allowed: true });
    return;
  }

  console.log('[booking-guard] RDV refusé, contact bloqué :', blockHit);

  /* Écrit AVANT la réponse : Vercel coupe la fonction dès res.end(). */
  try {
    await db.collection('audit_log').add({
      type: 'booking_blocked',
      key: blockHit,
      email: emailLc || null,
      phone: phoneNorm || null,
      typeId: str(body.typeId, 120),
      personId: str(body.personId, 120),
      date: str(body.date, 10),
      time: str(body.time, 5),
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[booking-guard] audit_log:', e && e.message);
  }

  res.status(200).json({ ok: true, allowed: false });
};
