// ============================================================================
// api/booking-resend-confirmation.js
// ----------------------------------------------------------------------------
// Renvoie au client l'e-mail de confirmation d'un RDV, depuis booking-admin.
//
// URL  : POST /api/booking-resend-confirmation
// Auth : Bearer Firebase ID token — tout membre connecté (admin, sales, csm,
//        coach). Le message part vers l'adresse déjà enregistrée sur le RDV,
//        jamais vers une adresse saisie librement : aucun risque d'envoi à
//        un tiers.
//
// Body : { bookingId: string }
//
// ─────────────────────────────────────────────────────────────────────────────
// POURQUOI CET ENDPOINT EXISTE
// ─────────────────────────────────────────────────────────────────────────────
// Des clients perdent l'e-mail de confirmation reçu à la réservation et le
// redemandent par téléphone ou par SMS. Jusqu'ici l'équipe devait retaper les
// informations à la main. Le bouton ✉️ de booking-admin appelle cet endpoint,
// qui reconstruit le MÊME e-mail que celui de la création (Cloud Function
// onBookingCreated dans Functions/index.js) et le renvoie tel quel :
//   - même objet « Confirmation de votre RDV — {type} », pour que le client
//     le retrouve d'un coup en cherchant dans sa boîte ;
//   - même gabarit stylé Adrien & Emily ;
//   - même tableau Type / Avec / Date / Heure ;
//   - même bloc « Lien de visioconférence » quand le RDV en a un.
//
// Une seule différence : la phrase « Une invitation Google Calendar vient de
// vous être envoyée séparément » est retirée, puisqu'aucune invitation ne
// repart. Le lien Meet, lui, est relu depuis le document du RDV (posé par
// onBookingCreated), donc identique à celui de l'invitation d'origine.
//
// ⚠ Ce fichier duplique volontairement le gabarit de onBookingCreated. Les
// Cloud Functions ne sont pas appelables en HTTP sur ce projet (policy
// iam.allowedPolicyMemberDomains), et le code de Functions/index.js n'est pas
// un module importable depuis Vercel. Si le gabarit de confirmation évolue
// côté Cloud Function, reporter la modification ici.
//
// Ce que fait cet endpoint, dans l'ordre :
//   1. Vérifie que le RDV existe et n'est pas annulé.
//   2. Vérifie qu'une adresse e-mail est enregistrée sur le RDV.
//   3. Reconstruit l'e-mail de confirmation et l'envoie depuis le compte
//      Gmail configuré sur la consultation (notifications.emailAccount),
//      « strategie » à défaut — même règle que la Cloud Function.
//   4. Trace le renvoi sur le document du RDV (confirmationResends[]) AVANT
//      de répondre — Vercel coupe la fonction dès res.end().
//
// Réponse 200 : { ok:true, bookingId, to, from, messageId, resendCount }
// Erreurs : 400 (bookingId absent, pas d'e-mail client) · 401 (auth)
//           404 (RDV introuvable) · 409 (RDV annulé) · 405 · 502 (Gmail) · 500
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');

// Compte Gmail par défaut — miroir de onBookingCreated
const DEFAULT_EMAIL_ACCOUNT = 'strategie';

// ─── Helpers repris de Functions/index.js (_abFmtDate, _abBuildStyledEmail,
//     _abGetTypeNotif) — à garder alignés ─────────────────────────────────────

function fmtDateFr(s) {
  if (!s) return '';
  try {
    const d = new Date(s + 'T00:00:00');
    const j = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const m = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    return j[d.getDay()] + ' ' + d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
  } catch (e) {
    return s;
  }
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildStyledEmail(subject, contentHtml) {
  const subjEsc = escHtml(subject);
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body style="margin:0;padding:0;background:#f4f4f8;font-family:Helvetica,Arial,sans-serif">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:30px 0"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">'
    + '<tr><td style="background:linear-gradient(135deg,#1e3a8a,#3b82f6);border-radius:16px 16px 0 0;padding:40px 40px 30px;text-align:center">'
    + '<div style="font-size:14px;font-weight:800;color:rgba(255,255,255,0.7);letter-spacing:2px;text-transform:uppercase;margin-bottom:16px">ADRIEN &amp; EMILY</div>'
    + '<div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.3">' + subjEsc + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#ffffff;padding:36px 40px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">'
    + '<div style="font-size:15px;line-height:1.7;color:#374151">' + (contentHtml || '') + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center">'
    + '<div style="font-size:12px;color:#9ca3af;line-height:1.6">'
    + '👩‍🎓 <strong style="color:#6b7280">Adrien &amp; Emily</strong> · 🏢 <strong style="color:#6b7280">Alteore</strong><br/>'
    + 'Accompagnement des dirigeants en Francophonie<br/>'
    + '<a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a> · '
    + '<a href="https://www.alteore.com" style="color:#3b82f6;text-decoration:none">alteore.com</a>'
    + '</div></td></tr>'
    + '</table></td></tr></table></body></html>';
}

// Lit la consultation dans booking_config/_types : notifications (compte
// Gmail) et lien fixe (Zoom, Teams, lien perso) si la consultation en a un.
async function getBookingType(typeId) {
  if (!typeId) return null;
  try {
    const snap = await db.collection('booking_config').doc('_types').get();
    if (!snap.exists) return null;
    const list = (snap.data() || {}).list || [];
    return list.find(function (x) { return x && x.id === typeId; }) || null;
  } catch (e) {
    console.error('[booking-resend-confirmation] lecture _types :', e.message);
    return null;
  }
}

function htmlToText(content) {
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

// ─── Gabarit de l'e-mail — copie de onBookingCreated, sans la phrase sur
//     l'invitation Google (aucune invitation ne repart ici) ──────────────────
function buildConfirmationEmail(booking, meetLink) {
  const dur = booking.duration || 30;
  const time = booking.time || '09:00';
  const prospect = booking.prospect || {};
  const expertName = booking.personName || '';
  const typeLabel = booking.typeLabel || booking.type || 'RDV';

  const subject = 'Confirmation de votre RDV — ' + typeLabel;
  const dateFr = fmtDateFr(booking.date);
  const meetBlock = meetLink
    ? '<div style="margin:20px 0;padding:16px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px">'
      + '<div style="font-size:14px;font-weight:700;color:#166534;margin-bottom:6px">📹 Lien de visioconférence</div>'
      + '<a href="' + escHtml(meetLink) + '" style="color:#16a34a;font-size:15px;font-weight:600;text-decoration:none;word-break:break-all">' + escHtml(meetLink) + '</a>'
      + '<div style="font-size:12px;color:#6b7280;margin-top:6px">Cliquez à l\'heure du RDV pour rejoindre la réunion.</div>'
      + '</div>'
    : '';

  const greetName = (prospect.prenom || '').trim() || (prospect.nom || '').trim() || '';
  const content = '<p style="margin:0 0 18px">Bonjour' + (greetName ? ' <strong>' + escHtml(greetName) + '</strong>' : '') + ',</p>'
    + '<p style="margin:0 0 18px">Votre rendez-vous est confirmé. Vous trouverez ci-dessous les détails :</p>'
    + '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;background:#f9fafb;border-radius:10px;margin:0 0 18px">'
    + '<tbody>'
    + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;width:120px"><strong>Type</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827">' + escHtml(typeLabel) + '</td></tr>'
    + (expertName ? '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Avec</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + escHtml(expertName) + '</td></tr>' : '')
    + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Date</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + escHtml(dateFr) + '</td></tr>'
    + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Heure</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + escHtml(time) + ' (' + dur + ' min)</td></tr>'
    + '</tbody></table>'
    + meetBlock
    + '<p style="margin:0">À très vite !<br><strong>L\'équipe Adrien &amp; Emily</strong></p>';

  return {
    subject: subject,
    bodyHtml: buildStyledEmail(subject, content),
    bodyText: htmlToText(content),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const body = parseBody(req);
    const bookingId = String(body.bookingId || '').trim();
    if (!bookingId) return res.status(400).json({ error: 'bookingId requis' });

    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'RDV introuvable' });
    const booking = snap.data() || {};

    if (booking.status === 'cancelled') {
      return res.status(409).json({
        error: 'RDV annulé',
        message: 'Ce rendez-vous est annulé : aucune confirmation à renvoyer.',
      });
    }

    const prospect = booking.prospect || {};
    const to = String(prospect.email || '').trim();
    if (!to) {
      return res.status(400).json({
        error: 'Pas d\'e-mail client',
        message: 'Aucune adresse e-mail n\'est enregistrée sur ce rendez-vous.',
      });
    }

    const type = await getBookingType(booking.type);
    const notifs = (type && type.notifications) || {};
    const accountKey = notifs.emailAccount || DEFAULT_EMAIL_ACCOUNT;

    // Lien de visio : celui posé par onBookingCreated (Meet auto), sinon le
    // lien fixe de la consultation (Zoom, Teams, lien perso). Jamais le lien
    // Google Calendar de l'événement, qui n'a de sens que côté équipe.
    const meetLink = booking.meetLink || (type && type.locationUrl) || null;

    const mail = buildConfirmationEmail(booking, meetLink);

    let sent;
    try {
      sent = await sendEmailFromAccount({
        accountKey: accountKey,
        to: to,
        subject: mail.subject,
        bodyHtml: mail.bodyHtml,
        bodyText: mail.bodyText,
      });
    } catch (e) {
      sent = { ok: false, error: e.message };
    }
    if (!sent || !sent.ok) {
      console.error('[booking-resend-confirmation] Gmail :', sent && sent.error);
      return res.status(502).json({
        error: 'Envoi impossible',
        message: (sent && sent.error) || 'Erreur Gmail',
      });
    }

    // Trace sur le RDV — écrite AVANT la réponse (Vercel coupe après res.end)
    const entry = {
      at: new Date().toISOString(),
      byUid: auth.uid,
      byEmail: auth.email || null,
      to: to,
      from: sent.from || null,
      messageId: sent.messageId || null,
      account: accountKey,
    };
    const resendCount = (Array.isArray(booking.confirmationResends) ? booking.confirmationResends.length : 0) + 1;
    await ref.update({
      confirmationResends: admin.firestore.FieldValue.arrayUnion(entry),
      confirmationResentAt: admin.firestore.FieldValue.serverTimestamp(),
      confirmationResentBy: auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('[booking-resend-confirmation] ✓ ' + bookingId + ' → ' + to + ' (' + accountKey + ', renvoi n°' + resendCount + ')');
    return res.status(200).json({
      ok: true,
      bookingId: bookingId,
      to: to,
      from: sent.from || null,
      messageId: sent.messageId || null,
      resendCount: resendCount,
    });
  } catch (e) {
    console.error('[booking-resend-confirmation] error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
