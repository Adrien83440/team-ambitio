// ==========================================================================
// api/booking-toggle-slot.js
// --------------------------------------------------------------------------
// Permet à un setter (sales/admin) d'ouvrir ou fermer un créneau de RDV.
//
// Sémantique :
//   - "Fermé" (slotOpen=false) : le créneau est verrouillé, aucun nouveau
//     prospect ne peut réserver dessus. État par défaut.
//   - "Ouvert" (slotOpen=true) : le créneau est rendu re-bookable jusqu'à
//     atteindre maxBookingsPerOpenSlot (configuré dans _meta/booking_slot_settings).
//     Sert à compenser les no-shows quand le setter n'a pas pu confirmer
//     la présence du prospect.
//
// Action="open" :
//   - Passe slotOpen à true sur bookings/{id}
//   - Envoie SMS de reconfirmation au prospect via /api/twilio-sms-send
//   - Envoie email de reconfirmation via Gmail OAuth (compte 'strategie')
//   - Logue dans bookings/{id}.slotEvents[]
//
// Action="close" :
//   - Passe slotOpen à false sur bookings/{id}
//   - Logue dans slotEvents[]
//
// Templates SMS/email : récupérés depuis _meta/booking_slot_settings ou
// fallback hardcodé. Variables : {{prospectName}}, {{date}}, {{time}}.
//
// Body : { bookingId, action: 'open'|'close', skipNotify?: boolean }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { ok: true, slotOpen, smsSent, emailSent, errors }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');

// Templates par défaut (utilisés si pas configurés dans Firestore)
const DEFAULT_SMS_TEMPLATE =
  'Bonjour {{prospectName}}, nous confirmons votre RDV du {{date}} à {{time}}. ' +
  'Merci de répondre OUI pour confirmer votre présence, sans réponse de votre part nous risquons d\'attribuer le créneau à un autre client. À très vite !';

const DEFAULT_EMAIL_SUBJECT =
  'Confirmation de votre RDV du {{date}} à {{time}}';

const DEFAULT_EMAIL_HTML =
  '<p>Bonjour {{prospectName}},</p>' +
  '<p>Nous souhaitons vous confirmer votre rendez-vous prévu le <strong>{{date}} à {{time}}</strong>.</p>' +
  '<p>Merci de nous confirmer votre présence en répondant à cet email ou par SMS. Sans réponse de votre part, nous risquons d\'attribuer le créneau à un autre client.</p>' +
  '<p>À très vite,<br>L\'équipe Ambitio</p>';

// Format date FR : "lundi 15 avril 2026"
function formatDateFr(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    return jours[d.getDay()] + ' ' + d.getDate() + ' ' + mois[d.getMonth()] + ' ' + d.getFullYear();
  } catch (e) {
    return dateStr;
  }
}

// Remplit un template avec les variables {{xxx}}
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  let out = tpl;
  for (const k in vars) {
    out = out.split('{{' + k + '}}').join(vars[k] != null ? String(vars[k]) : '');
  }
  return out;
}

async function loadSettings() {
  try {
    const snap = await db.collection('_meta').doc('booking_slot_settings').get();
    if (snap.exists) {
      const d = snap.data();
      return {
        maxBookingsPerOpenSlot: typeof d.maxBookingsPerOpenSlot === 'number' ? d.maxBookingsPerOpenSlot : 2,
        smsTemplate: d.smsTemplate || DEFAULT_SMS_TEMPLATE,
        emailSubject: d.emailSubject || DEFAULT_EMAIL_SUBJECT,
        emailHtml: d.emailHtml || DEFAULT_EMAIL_HTML,
        emailAccount: d.emailAccount || 'strategie',
      };
    }
  } catch (e) { /* fallback */ }
  return {
    maxBookingsPerOpenSlot: 2,
    smsTemplate: DEFAULT_SMS_TEMPLATE,
    emailSubject: DEFAULT_EMAIL_SUBJECT,
    emailHtml: DEFAULT_EMAIL_HTML,
    emailAccount: 'strategie',
  };
}

// Envoi SMS via le même endpoint que celui utilisé par le module Inbox
async function sendSms({ to, body, leadId, hostFromReq }) {
  // On reproduit la logique de twilio-sms-send côté serveur via fetch interne
  // (plus simple que d'importer le handler en require, et garde la séparation propre).
  // L'endpoint twilio-sms-send vérifie un Firebase ID token en header — comme on est
  // déjà serveur-side avec admin SDK, on fait l'appel direct à Twilio ici à la place.
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  let fromNumber = process.env.TWILIO_SMS_FROM;

  // Fallback : lire depuis _config si env vars manquent
  if (!accountSid || !authToken || !fromNumber) {
    const confSnap = await db.collection('_config').doc('telco_credentials').get();
    if (confSnap.exists) {
      const tw = confSnap.data().twilio || {};
      fromNumber = fromNumber || tw.smsFromNumber || tw.smsSignatureFrom;
    }
  }

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials manquants (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars)');
  }
  if (!fromNumber) {
    throw new Error('Twilio SMS from number introuvable (TWILIO_SMS_FROM env var ou _config/telco_credentials.twilio.smsFromNumber)');
  }

  const auth = Buffer.from(accountSid + ':' + authToken).toString('base64');
  const params = new URLSearchParams({ From: fromNumber, To: to, Body: body });
  const resp = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error('Twilio ' + resp.status + ' : ' + (data.message || JSON.stringify(data)));
  }

  // Trace dans le lead si possible
  if (leadId) {
    try {
      const nowIso = new Date().toISOString();
      await db.collection('leads').doc(leadId).update({
        communications: admin.firestore.FieldValue.arrayUnion({
          type: 'sms',
          direction: 'outbound',
          content: body,
          source: 'booking-reconfirm',
          date: nowIso,
          createdAt: nowIso,
          providerMessageSid: data.sid,
          fromNumber: fromNumber,
          toNumber: to,
        }),
        lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
        lastContactType: 'sms',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { /* non-bloquant */ }
  }

  return { sid: data.sid };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { bookingId, action, skipNotify } = parseBody(req);

    if (!bookingId || (action !== 'open' && action !== 'close')) {
      res.status(400).json({ error: 'bookingId et action ("open" ou "close") requis' });
      return;
    }

    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Booking introuvable' });
      return;
    }
    const booking = snap.data();

    const newSlotOpen = (action === 'open');
    const eventEntry = {
      action: action,
      byUid: auth.uid,
      byEmail: auth.email || null,
      at: new Date().toISOString(),
    };

    // Update Firestore
    await ref.update({
      slotOpen: newSlotOpen,
      slotEvents: admin.firestore.FieldValue.arrayUnion(eventEntry),
      slotLastToggleAt: admin.firestore.FieldValue.serverTimestamp(),
      slotLastToggleBy: auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let smsResult = { sent: false };
    let emailResult = { sent: false };

    // Si on OUVRE le slot et que skipNotify n'est pas demandé : reconfirmation
    if (newSlotOpen && !skipNotify) {
      const settings = await loadSettings();

      const prospect = booking.prospect || {};
      const prospectName = (prospect.prenom || '').trim() || (prospect.nom || '').trim() || 'Client';
      const prospectPhone = prospect.telephone || prospect.phone || '';
      const prospectEmail = prospect.email || '';

      const vars = {
        prospectName: prospectName,
        date: formatDateFr(booking.date),
        time: booking.time || '',
      };

      // SMS
      if (prospectPhone) {
        try {
          const smsBody = fillTemplate(settings.smsTemplate, vars);
          const r = await sendSms({
            to: prospectPhone,
            body: smsBody,
            leadId: booking.leadId || null,
          });
          smsResult = { sent: true, sid: r.sid };
        } catch (e) {
          console.error('[booking-toggle-slot] SMS failed:', e.message);
          smsResult = { sent: false, error: e.message };
        }
      } else {
        smsResult = { sent: false, error: 'Pas de téléphone prospect' };
      }

      // Email
      if (prospectEmail) {
        try {
          const subject = fillTemplate(settings.emailSubject, vars);
          const html = fillTemplate(settings.emailHtml, vars);
          const r = await sendEmailFromAccount({
            accountKey: settings.emailAccount,
            to: prospectEmail,
            subject: subject,
            bodyHtml: html,
            bodyText: html.replace(/<[^>]+>/g, ''),
          });
          emailResult = r.ok
            ? { sent: true, messageId: r.messageId, from: r.from }
            : { sent: false, error: r.error };
        } catch (e) {
          console.error('[booking-toggle-slot] Email failed:', e.message);
          emailResult = { sent: false, error: e.message };
        }
      } else {
        emailResult = { sent: false, error: 'Pas d\'email prospect' };
      }
    }

    res.json({
      ok: true,
      bookingId: bookingId,
      slotOpen: newSlotOpen,
      action: action,
      sms: smsResult,
      email: emailResult,
    });
  } catch (e) {
    console.error('[booking-toggle-slot] error:', e);
    res.status(500).json({ error: e.message });
  }
};
