// ============================================================================
// api/lead-block.js
// ----------------------------------------------------------------------------
// LISTE DE BLOCAGE — faux numéros / emails bidon.
//
// « 06 00 00 00 00 », « test@test.fr », le même mail poubelle qui revient
// dix fois : une fois repéré depuis Leads Live, on bloque le contact et il
// ne redescend PLUS JAMAIS dans le CRM.
//
// URL  : POST https://team.alteore.com/api/lead-block
// Auth : Bearer ID token Firebase (membre d'équipe connecté).
// Body : { leadId, target:'email'|'phone', action:'block'|'unblock', reason? }
//
// Réponses
//   200 { ok:true, action, target, key }
//   400 { ok:false, error }
//   401/403 (helper d'auth)
//   404 { ok:false, error:'lead_not_found' }
//
// ─── ON BLOQUE UNE VALEUR, PAS UNE PERSONNE ───────────────────────────
// Règle Adrien 30/07 : on blackliste LE mail bidon, ou LE faux numéro —
// celui qui est faux, pas les deux d'office. Si la personne se réinscrit
// avec un autre numéro (ou un autre mail), la nouvelle fiche est CRÉÉE :
// on la garde au cas où. Bloquer les deux ensemble reviendrait à bannir
// l'individu, et ferait perdre un lead peut-être réel.
//
// ─── POURQUOI UN ENDPOINT PLUTÔT QU'UNE ÉCRITURE CLIENT ────────────────
// Écrire blocked_contacts depuis le navigateur imposerait un nouveau bloc
// de rules Firestore — donc un déploiement manuel en console, et une
// fonctionnalité muette tant qu'il n'est pas fait (leçon des snapshots du
// funnel). Ici l'Admin SDK écrit, aucune rule à toucher : la fonction
// marche dès le déploiement du code.
//
// ─── FORME DES CLÉS ────────────────────────────────────────────────────
// blocked_contacts/{clé} avec clé déterministe :
//   email:<email en minuscules>      ex. email:test@test.fr
//   phone:<9 derniers chiffres>      ex. phone:600000000
// Un ID déterministe rend le blocage idempotent (re-bloquer n'empile pas)
// et surtout la vérification à l'ingestion est un simple get() par ID :
// aucune requête, aucun index, coût constant.
//
// ─── RDV À VENIR ANNULÉS AU BLOCAGE (26/10/2026) ───────────────────────
// Bloquer un contact annule aussi ses RDV confirmés à venir (fiche liée par
// leadId, ou même e-mail de prospect) : un bot a gardé 4 RDV dans les
// agendas des closers après son blocage. Annulation SILENCIEUSE, même
// recette que api/admin-booking-dedupe.js :
//   1. événement Google retiré avec sendUpdates:'none' (aucun mail Google) ;
//   2. status:'cancelled' + cancelHandledAt dans la MÊME écriture :
//      onBookingUpdated sort aussitôt — ni e-mail au contact, ni
//      notification équipe, ni retouche du stage (la fiche part en poubelle).
// Débloquer ne restaure aucun RDV.
// La liste de blocage est aussi lue par booking.html (api/booking-guard.js) :
// le contact ne peut plus en reprendre.
// ============================================================================

const { google } = require('googleapis');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { requireAuth } = require('./_verifyFirebaseAuth');

/* 9 derniers chiffres — MÊME normalisation que api/lead-optin.js,
   api/alteoform-submit.js, api/booking-guard.js et sales-leads.html. Toute
   divergence ici laisserait passer un numéro pourtant bloqué. */
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

/* Un ID de document Firestore ne peut pas contenir « / ». Les emails et les
   chiffres n'en contiennent pas, mais on ne fait pas confiance à la donnée
   entrante pour ça. */
function safeKey(prefix, value) {
  const v = String(value || '').trim().replace(/\//g, '_');
  if (!v) return null;
  return prefix + ':' + v;
}

/* La valeur visée par la demande — UNE seule, jamais les deux. */
function targetOf(lead, target) {
  if (target === 'email') {
    const em = String(lead.email || '').trim().toLowerCase();
    if (!em) return null;
    return { key: safeKey('email', em), type: 'email', value: em };
  }
  const ph = phoneNormalized(lead.telephone || lead.phone);
  if (!ph) return null;
  return { key: safeKey('phone', ph), type: 'phone', value: ph };
}

/* ─── Annulation des RDV à venir ─────────────────────────────────────── */

function parisToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// OAuth Google — même résolution que api/admin-booking-dedupe.js.
async function getOAuthConfig() {
  for (const id of ['oauth_calendar', 'oauth']) {
    try {
      const doc = await db.collection('_config').doc(id).get();
      if (doc.exists) {
        const data = doc.data() || {};
        if (data.client_id && data.client_secret) return data;
      }
    } catch (_) { /* continue */ }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable');
}

async function getAuthClientForPerson(personId, conf) {
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) return null;
  const data = tokenDoc.data() || {};
  if (!data.refreshToken && !data.accessToken) return null;
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials({ access_token: data.accessToken || null, refresh_token: data.refreshToken || null });
  client.on('tokens', async function (t) {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) {
      try { await db.collection('calendar_tokens').doc(personId).update(u); }
      catch (e) { console.warn('[lead-block] token refresh save failed:', e.message); }
    }
  });
  return client;
}

/* RDV confirmés à venir du contact : liés à la fiche, ou portant le même
   e-mail de prospect (RDV jamais rattaché). Aujourd'hui inclus. */
async function upcomingBookings(leadId, emailLc) {
  const today = parisToday();
  const queries = [db.collection('bookings').where('leadId', '==', leadId).get()];
  if (emailLc) queries.push(db.collection('bookings').where('prospect.email', '==', emailLc).get());
  const snaps = await Promise.all(queries);
  const seen = {};
  const out = [];
  snaps.forEach(function (s) {
    s.docs.forEach(function (d) {
      if (seen[d.id]) return;
      seen[d.id] = 1;
      const b = d.data() || {};
      if (b.status !== 'confirmed' && b.status !== 'pending') return;
      if (!b.date || b.date < today) return;
      out.push({ ref: d.ref, id: d.id, data: b });
    });
  });
  return out;
}

async function cancelUpcomingBookings(lead, leadId, auth, reason) {
  const emailLc = String(lead.email || '').trim().toLowerCase();
  const list = await upcomingBookings(leadId, emailLc);
  const done = [];
  const warnings = [];
  let conf = null;
  const busyPersons = {};

  for (const b of list) {
    const item = { id: b.id, date: b.data.date || null, time: b.data.time || null, personName: b.data.personName || null, calendar: null, ok: false };

    // 1. Événement Google — avant Firestore : une fois cancelHandledAt posé,
    //    plus personne ne repassera le retirer.
    if (b.data.calendarEventId && b.data.personId) {
      try {
        if (!conf) conf = await getOAuthConfig();
        const client = await getAuthClientForPerson(b.data.personId, conf);
        if (!client) {
          item.calendar = 'no_calendar_token';
          warnings.push('Événement Google du RDV ' + b.id + ' non retiré (pas de jeton pour ' + b.data.personId + ')');
        } else {
          await google.calendar({ version: 'v3', auth: client }).events.delete({
            calendarId: b.data.calendarIdUsed || 'primary',
            eventId: b.data.calendarEventId,
            sendUpdates: 'none',
          });
          item.calendar = 'deleted';
          busyPersons[b.data.personId] = 1;
        }
      } catch (e) {
        const code = (e && e.code) || (e && e.response && e.response.status) || null;
        if (code === 404 || code === 410) {
          item.calendar = 'already_gone';
        } else {
          item.calendar = 'error';
          warnings.push('Événement Google du RDV ' + b.id + ' : ' + ((e && e.message) || e));
        }
      }
    } else {
      item.calendar = 'no_event';
    }

    // 2. Firestore — cancelHandledAt dans la même écriture (cf. en-tête).
    try {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const why = 'Contact blacklisté' + (reason ? ' — ' + reason : '');
      await b.ref.update({
        status: 'cancelled',
        cancelHandledAt: now,
        cancelHandledBy: 'lead-block',
        cancelledAt: now,
        cancelledBy: auth.uid || null,
        cancelledByName: auth.email || null,
        cancelledOrigin: 'equipe',
        cancelledReason: why,
        statusUpdatedAt: now,
        statusUpdatedBy: auth.uid || null,
        statusUpdatedByName: auth.email || null,
        cancellation: { origin: 'equipe', via: 'blacklist', by: auth.uid || null, byName: auth.email || null, byRole: null, reason: why, at: new Date().toISOString() },
      });
      item.ok = true;
    } catch (e) {
      warnings.push('RDV ' + b.id + ' non annulé : ' + ((e && e.message) || e));
    }
    done.push(item);
  }

  // 3. Créneaux occupés rafraîchis (onCalendarSyncRequest, mécanisme existant).
  for (const personId of Object.keys(busyPersons)) {
    try {
      await db.collection('calendar_sync_requests').doc(personId).set({
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        requestedBy: 'lead-block',
      }, { merge: true });
    } catch (e) {
      console.warn('[lead-block] busy refresh', personId, e.message);
    }
  }

  return { bookings: done, warnings };
}

/* Écrit le blocage (ou le déblocage) d'UNE valeur d'une fiche : blacklist,
   marquage de la fiche, RDV à venir, audit. Partagé avec api/inbox-spam.js. */
async function appliquerBlocage({ lead, leadId, t, action, reason, auth }) {
  const target = t.type;
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('blocked_contacts').doc(t.key);

  if (action === 'block') {
    batch.set(ref, {
      type: t.type,
      value: t.value,
      reason: reason || null,
      leadId,
      leadName: lead.nom || null,
      by: auth.uid || null,
      byEmail: auth.email || null,
      at: now,
    });
  } else {
    batch.delete(ref);
  }

  /* Marquage de la fiche — un drapeau PAR VALEUR, jamais de suppression :
     l'historique reste, et on sait exactement laquelle des deux coordonnées
     est refusée à l'entrée. */
  const DEL = admin.firestore.FieldValue.delete();
  const flag = target === 'email' ? 'blockedEmail' : 'blockedPhone';
  const otherFlag = target === 'email' ? 'blockedPhone' : 'blockedEmail';
  const otherStillBlocked = lead[otherFlag] === true;
  const leadPatch = {
    updatedAt: now,
    timeline_history: admin.firestore.FieldValue.arrayUnion({
      text: (action === 'block' ? '🚫 Blacklist ' : '✅ Blacklist levée ')
          + (target === 'email' ? 'email ' + t.value : 'numéro ' + t.value)
          + (reason ? ' — ' + reason : '')
          + (auth.email ? ' (par ' + auth.email + ')' : ''),
      date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
      color: action === 'block' ? '#ef4444' : '#34d399',
    }),
  };
  leadPatch[flag] = action === 'block' ? true : DEL;
  /* `blocked` = au moins une coordonnée blacklistée (sert à l'affichage). */
  leadPatch.blocked = action === 'block' ? true : otherStillBlocked;
  if (action === 'block') {
    leadPatch.blockedAt = now;
    leadPatch.blockedBy = auth.email || auth.uid || null;
    leadPatch.blockedReason = reason || null;
    /* Sort la fiche des files de travail. Débloquer ne devine PAS un
       statut : c'est à l'équipe de la requalifier. */
    leadPatch.status = 'poubelle';
    leadPatch.stage = 'poubelle';
  } else if (!otherStillBlocked) {
    leadPatch.blockedAt = DEL;
    leadPatch.blockedBy = DEL;
    leadPatch.blockedReason = DEL;
  }
  batch.update(db.collection('leads').doc(leadId), leadPatch);

  await batch.commit();

  /* RDV à venir du contact — après le blocage, qui reste acquis même si
     l'annulation échoue (l'erreur est rendue dans warnings). */
  let cancelled = { bookings: [], warnings: [] };
  if (action === 'block') {
    try {
      cancelled = await cancelUpcomingBookings(lead, leadId, auth, reason);
    } catch (e) {
      console.error('[lead-block] annulation RDV:', e && e.message);
      cancelled.warnings.push('Annulation des RDV à venir en échec : ' + ((e && e.message) || e));
    }
    const nOk = cancelled.bookings.filter(function (b) { return b.ok; }).length;
    if (nOk) {
      try {
        await db.collection('leads').doc(leadId).update({
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '🔴 ' + nOk + ' RDV à venir annulé' + (nOk > 1 ? 's' : '') + ' (contact blacklisté) : '
                + cancelled.bookings.filter(function (b) { return b.ok; }).map(function (b) {
                  return (b.date || '').split('-').reverse().join('/') + ' ' + (b.time || '');
                }).join(', '),
            date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
            color: '#ef4444',
          }),
        });
      } catch (e) {
        console.warn('[lead-block] timeline RDV annulés:', e && e.message);
      }
    }
  }

  /* Trace d'audit — best-effort, ne doit jamais faire échouer l'action. */
  try {
    await db.collection('audit_log').add({
      type: 'lead_block',
      action,
      target,
      leadId,
      key: t.key,
      value: t.value,
      reason: reason || null,
      actorUid: auth.uid || null,
      actorEmail: auth.email || null,
      bookingsCancelled: cancelled.bookings.map(function (b) { return { id: b.id, ok: b.ok, calendar: b.calendar }; }),
      at: now,
    });
  } catch (e) {
    console.warn('[lead-block] audit_log:', e && e.message);
  }

  return cancelled;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;                     // le helper a déjà répondu 401/403

  let body;
  try { body = await parseBody(req); } catch (e) { body = null; }
  const leadId = body && typeof body.leadId === 'string' ? body.leadId.trim() : '';
  const action = body && body.action === 'unblock' ? 'unblock' : 'block';
  const target = body && body.target === 'email' ? 'email' : 'phone';
  const reason = body && typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;

  if (!leadId) {
    res.status(400).json({ ok: false, error: 'leadId_required' });
    return;
  }

  try {
    const snap = await db.collection('leads').doc(leadId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'lead_not_found' });
      return;
    }
    const lead = snap.data() || {};
    const t = targetOf(lead, target);

    if (!t || !t.key) {
      res.status(400).json({ ok: false, error: target === 'email' ? 'no_email_on_lead' : 'no_phone_on_lead' });
      return;
    }

    const cancelled = await appliquerBlocage({ lead, leadId, t, action, reason, auth });
    res.status(200).json({ ok: true, action, target, key: t.key, value: t.value, bookingsCancelled: cancelled.bookings, warnings: cancelled.warnings });
  } catch (e) {
    console.error('[lead-block]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

module.exports.appliquerBlocage = appliquerBlocage;
