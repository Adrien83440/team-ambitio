// ============================================================================
// api/client-deactivate.js — FIN D'ACCOMPAGNEMENT (07/2026)
// ----------------------------------------------------------------------------
// UN SEUL geste pour passer un client en « ancien client » PARTOUT :
//
//   1. Fiche coaching  (clients/{id})   → statut 'inactif' + clientStatus
//      ('completed' ou 'stopped') + ancienClient:true + traçabilité complète.
//   2. Fiche CRM       (leads)          → clientStatus + isFormerClient:true
//      + entrée timeline. isClient reste true (historique, masquage Leads
//      Live inchangé).
//   3. Persons         (persons/{id})   → crmStatus + coachingStatus synchro
//      (le hub 360° reflète l'état sans dépendre d'un trigger Cloud).
//   4. RDV coaching à venir             → annulés (cancelledReason
//      'client_deactivated') + événement Google Calendar supprimé avec
//      sendUpdates:'all' (le client reçoit l'annulation Google) — même
//      mécanique que booking-transfer.js.
//   5. AE Academy                       → compte de connexion désactivé via
//      le pont manage-access (réversible, progression conservée) + trace
//      dans clients.academyAccessHistory.
//
// Les paiements GoCardless ne sont JAMAIS touchés — le preview remonte un
// avertissement si des prélèvements restent actifs, c'est tout.
//
// URL  : POST https://team.alteore.com/api/client-deactivate
// Auth : Bearer ID token Firebase — rôles admin / csm UNIQUEMENT.
// Body : { action:'preview'|'deactivate'|'reactivate', clientId,
//          mode?:'completed'|'stopped', note? }
//
//   preview     → état complet AVANT d'agir : RDV coaching à venir, compte
//                 Academy, lead/person liés, prélèvements actifs. Alimente
//                 la modale de confirmation (client-deactivate-ui.js).
//   deactivate  → exécute les 5 étapes ci-dessus, renvoie un rapport
//                 détaillé + warnings (chaque étape est fail-soft : un
//                 échec Academy ne bloque pas l'annulation des RDV, etc.).
//                 Idempotent : relancer sur une fiche déjà désactivée
//                 ré-applique sans dégât (utile après échec partiel).
//   reactivate  → chemin inverse (statut actif + Academy rouverte). Les
//                 RDV annulés ne sont PAS restaurés.
//
// Variables Vercel : ACADEMY_BRIDGE_KEY (déjà en place — cf academy-access).
// Dépendances : googleapis (déjà utilisée par booking-transfer.js).
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const ROLES = ['admin', 'csm'];
const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const MODES = ['completed', 'stopped'];

// ─── Petits helpers ─────────────────────────────────────────────────────

function nowParisFr() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

function futureEnough(b) {
  // Créneau non passé, marge 30 min (même règle que booking-transfer).
  try {
    const ts = new Date(b.date + 'T' + (b.time || '00:00') + ':00').getTime();
    return ts > Date.now() - 30 * 60000;
  } catch (_) { return false; }
}

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ─── Pont Academy (même pattern que academy-access.js) ──────────────────

async function academyBridge(payload) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) return { ok: false, error: 'bridge_not_configured' };
  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify(payload),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return j || { ok: false, error: 'academy_unreachable' };
  } catch (e) {
    return { ok: false, error: 'academy_unreachable: ' + e.message };
  }
}

// ─── Google Calendar : suppression d'événement (booking-transfer pattern) ─

async function getOAuthConfig() {
  const tries = ['oauth_calendar', 'oauth'];
  for (const id of tries) {
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

async function getAuthClientForPerson(personId) {
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) return null;
  const tokens = tokenDoc.data() || {};
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials(tokens);
  return client;
}

async function deleteCalendarEvent(b) {
  const eventId = b.calendarEventId;
  if (!eventId) return { deleted: false, warning: 'pas de calendarEventId' };
  try {
    const client = await getAuthClientForPerson(b.personId);
    if (!client) return { deleted: false, warning: 'tokens Google absents pour ' + b.personId };
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({
      calendarId: b.calendarIdUsed || 'primary',
      eventId,
      sendUpdates: 'all', // le client reçoit l'annulation Google
    });
    return { deleted: true };
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 404 || code === 410) return { deleted: true }; // déjà disparu
    console.warn('[client-deactivate] delete event', b.personId, eventId, e.message);
    return { deleted: false, warning: 'suppression event Google : ' + e.message };
  }
}

// ─── Résolutions (lead / person / RDV / paiements) ──────────────────────

// Lead lié : même logique que csm-clients — match par email, skip _merged,
// priorité au lead isClient:true, sinon le plus récemment mis à jour.
async function resolveLead(emailRaw) {
  const email = String(emailRaw || '').trim();
  if (!email) return null;
  const lower = email.toLowerCase();
  const candidates = {};
  const tryQuery = async (val) => {
    try {
      const snap = await db.collection('leads').where('email', '==', val).limit(5).get();
      snap.forEach((d) => {
        const data = d.data() || {};
        if (data._merged === true) return;
        candidates[d.id] = Object.assign({ _id: d.id }, data);
      });
    } catch (e) { console.warn('[client-deactivate] leads query', val, e.message); }
  };
  await tryQuery(lower);
  if (lower !== email) await tryQuery(email);
  const list = Object.keys(candidates).map((k) => candidates[k]);
  if (!list.length) return null;
  list.sort((a, b) => {
    const ac = a.isClient === true ? 1 : 0;
    const bc = b.isClient === true ? 1 : 0;
    if (ac !== bc) return bc - ac;
    const at = (a.updatedAt && a.updatedAt.toMillis) ? a.updatedAt.toMillis() : 0;
    const bt = (b.updatedAt && b.updatedAt.toMillis) ? b.updatedAt.toMillis() : 0;
    return bt - at;
  });
  return list[0];
}

// Types de consultation coaching (booking_config __type='type' isCoaching)
// pour attraper les RDV « coaching détectable uniquement via le type »
// (règle §7bis de la refonte — même classification partout).
async function loadCoachingTypeIds() {
  const ids = {};
  try {
    const snap = await db.collection('booking_config').get();
    snap.forEach((d) => {
      const t = d.data() || {};
      if (t.__type === 'type' && t.isCoaching === true) ids[d.id] = true;
    });
  } catch (e) { console.warn('[client-deactivate] booking_config', e.message); }
  return ids;
}

function isCoachingBooking(b, coachingTypeIds) {
  if (!b) return false;
  if (b.isCoaching === true) return true;
  if (b.clientId) return true;
  if (b.source === 'csm_manual') return true;
  if (b.skipLeadCreation === true) return true;
  if (b.type && coachingTypeIds[b.type]) return true;
  return false;
}

// RDV coaching à venir du client : par clientId ET par prospect.email
// (variantes de casse), dédupliqués, status confirmed, créneau futur.
async function findUpcomingCoachingBookings(clientId, emailRaw) {
  const coachingTypeIds = await loadCoachingTypeIds();
  const email = String(emailRaw || '').trim();
  const lower = email.toLowerCase();
  const byId = {};

  const collect = (snap) => {
    snap.forEach((d) => {
      const b = Object.assign({ _id: d.id }, d.data() || {});
      if (b.status !== 'confirmed') return;
      if (!futureEnough(b)) return;
      if (!isCoachingBooking(b, coachingTypeIds)) return;
      byId[d.id] = b;
    });
  };

  try {
    const s1 = await db.collection('bookings').where('clientId', '==', clientId).get();
    collect(s1);
  } catch (e) { console.warn('[client-deactivate] bookings by clientId', e.message); }

  if (email) {
    try {
      const s2 = await db.collection('bookings').where('prospect.email', '==', lower).get();
      collect(s2);
    } catch (e) { console.warn('[client-deactivate] bookings by email', e.message); }
    if (lower !== email) {
      try {
        const s3 = await db.collection('bookings').where('prospect.email', '==', email).get();
        collect(s3);
      } catch (e) { /* déjà loggé au besoin */ }
    }
  }

  const list = Object.keys(byId).map((k) => byId[k]);
  list.sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
  return list;
}

// Prélèvements encore actifs (avertissement uniquement — jamais touchés).
async function findActivePayments(lead, personId) {
  const out = { payments: 0, subscriptions: 0 };
  const ACTIVE = { active: 1, pending_mandate: 1, mandate_active: 1 };
  if (lead && lead._id) {
    try {
      const snap = await db.collection('payments').where('leadId', '==', lead._id).get();
      snap.forEach((d) => {
        const p = d.data() || {};
        if (ACTIVE[p.status]) out.payments++;
      });
    } catch (e) { console.warn('[client-deactivate] payments', e.message); }
  }
  if (personId) {
    try {
      const snap = await db.collection('subscriptions').where('personId', '==', personId).get();
      snap.forEach((d) => {
        const s = d.data() || {};
        if (s.status === 'active') out.subscriptions++;
      });
    } catch (e) { /* collection optionnelle */ }
  }
  return out;
}

// ─── Écritures ──────────────────────────────────────────────────────────

function timelineEntry(text) {
  return { text, date: nowParisFr(), color: '#a78bfa' };
}

async function applyToLead(lead, patch, tlText, warnings) {
  if (!lead || !lead._id) return { found: false };
  try {
    const upd = Object.assign({}, patch, {
      timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry(tlText)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('leads').doc(lead._id).update(upd);
    return { found: true, id: lead._id };
  } catch (e) {
    warnings.push('Fiche CRM non mise à jour : ' + e.message);
    return { found: true, id: lead._id, error: e.message };
  }
}

async function applyToPerson(personId, patch, warnings) {
  if (!personId) return { found: false };
  try {
    await db.collection('persons').doc(personId).set(
      Object.assign({}, patch, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }),
      { merge: true }
    );
    return { found: true, id: personId };
  } catch (e) {
    warnings.push('Fiche persons non mise à jour : ' + e.message);
    return { found: true, id: personId, error: e.message };
  }
}

async function applyAcademy(clientId, email, disabled, byUid, byName, warnings) {
  const j = await academyBridge({ action: 'platform', email: String(email || '').toLowerCase(), disabled });
  const out = {
    ok: !!(j && j.ok),
    found: !!(j && j.found),
    exists: !!(j && j.auth && j.auth.exists),
    disabled: !!(j && j.auth && j.auth.disabled),
    error: (j && j.ok) ? null : ((j && j.error) || 'academy_unreachable'),
  };
  if (!out.ok) {
    warnings.push('Academy : ' + out.error + ' — à faire à la main depuis l\'onglet Academy si besoin.');
  } else {
    // Trace dans la fiche coaching (même convention que academy-access.js).
    try {
      await db.collection('clients').doc(clientId).update({
        academyAccessHistory: admin.firestore.FieldValue.arrayUnion({
          at: new Date().toISOString(),
          by: byUid || null,
          byName: byName || null,
          action: disabled ? 'platform_off' : 'platform_on',
          via: 'fin_accompagnement',
        }),
      });
    } catch (e) { /* fail-soft, trace facultative */ }
  }
  return out;
}

async function cancelBookings(bookings, byUid, byName, warnings) {
  const results = [];
  for (const b of bookings) {
    const item = { id: b._id, date: b.date || null, time: b.time || null, typeLabel: b.typeLabel || b.type || null, ok: false, calendar: null };
    try {
      const ts = admin.firestore.FieldValue.serverTimestamp();
      await db.collection('bookings').doc(b._id).update({
        status: 'cancelled',
        cancelledAt: ts,
        cancelledBy: byUid || null,
        cancelledByName: byName || null,
        cancelledReason: 'client_deactivated',
        statusUpdatedAt: ts,
        statusUpdatedBy: byUid || null,
        statusUpdatedByName: byName || null,
      });
      item.ok = true;
      const cal = await deleteCalendarEvent(b);
      item.calendar = cal.deleted ? 'deleted' : (cal.warning || 'non supprimé');
      if (!cal.deleted && cal.warning) warnings.push('RDV ' + (b.date || '') + ' ' + (b.time || '') + ' : ' + cal.warning);
    } catch (e) {
      item.error = e.message;
      warnings.push('Annulation RDV ' + (b.date || '') + ' ' + (b.time || '') + ' impossible : ' + e.message);
    }
    results.push(item);
  }
  return results;
}

// ─── Handler ────────────────────────────────────────────────────────────

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
  const byName = (auth.userData && (auth.userData.displayName || auth.userData.name))
    || (auth.email || '').split('@')[0] || null;

  const body = parseBody(req);
  const action = String(body.action || '');
  const clientId = String(body.clientId || '').trim();
  if (!clientId || ['preview', 'deactivate', 'reactivate'].indexOf(action) < 0) {
    res.status(200).json({ ok: false, error: 'action_clientId_required' });
    return;
  }

  try {
    const cSnap = await db.collection('clients').doc(clientId).get();
    if (!cSnap.exists) {
      res.status(200).json({ ok: false, error: 'client_not_found' });
      return;
    }
    const client = cSnap.data() || {};
    const email = String(client.email || '').trim();
    const lead = await resolveLead(email);
    const personId = client.personId || (lead && lead.personId) || null;

    // ── PREVIEW ─────────────────────────────────────────────────────────
    if (action === 'preview') {
      const [bookings, pay, academyStatus] = await Promise.all([
        findUpcomingCoachingBookings(clientId, email),
        findActivePayments(lead, personId),
        email ? academyBridge({ action: 'status', email: email.toLowerCase() }) : Promise.resolve(null),
      ]);
      res.status(200).json({
        ok: true,
        client: {
          id: clientId,
          nom: client.nom || client.name || null,
          email: email || null,
          statut: client.statut || 'actif',
          clientStatus: client.clientStatus || 'active',
          ancienClient: client.ancienClient === true,
          deactivatedAt: client.deactivatedAt || null,
          deactivatedByName: client.deactivatedByName || null,
        },
        lead: lead ? { found: true, id: lead._id, nom: lead.nom || null } : { found: false },
        person: personId ? { found: true, id: personId } : { found: false },
        academy: {
          configured: !!process.env.ACADEMY_BRIDGE_KEY,
          ok: !!(academyStatus && academyStatus.ok),
          found: !!(academyStatus && academyStatus.found),
          exists: !!(academyStatus && academyStatus.auth && academyStatus.auth.exists),
          disabled: !!(academyStatus && academyStatus.auth && academyStatus.auth.disabled),
        },
        bookings: bookings.map((b) => ({
          id: b._id, date: b.date || null, time: b.time || null,
          typeLabel: b.typeLabel || b.type || null, personName: b.personName || null,
        })),
        payments: pay,
      });
      return;
    }

    const warnings = [];

    // ── DEACTIVATE ──────────────────────────────────────────────────────
    if (action === 'deactivate') {
      const mode = MODES.indexOf(body.mode) >= 0 ? body.mode : 'completed';
      const note = cap(body.note || '', 500) || null;

      // 1. Fiche coaching — cœur de l'état « ancien client ».
      await db.collection('clients').doc(clientId).update({
        statut: 'inactif',
        clientStatus: mode,
        ancienClient: true,
        deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deactivatedBy: auth.uid,
        deactivatedByName: byName,
        deactivationNote: note,
        deactivationHistory: admin.firestore.FieldValue.arrayUnion({
          at: new Date().toISOString(), by: auth.uid, byName: byName,
          action: 'deactivate', mode: mode, note: note,
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Fiche CRM (lead) — badge « Ancien client » + timeline.
      const leadRes = await applyToLead(lead, {
        clientStatus: mode,
        isFormerClient: true,
        formerClientAt: admin.firestore.FieldValue.serverTimestamp(),
      }, '🎓 Fin d\'accompagnement — passage en ancien client' + (byName ? ' (' + byName + ')' : ''), warnings);

      // 3. Persons — hub 360° synchro (pas de dépendance à un trigger).
      const personRes = await applyToPerson(personId, {
        crmStatus: mode,
        coachingStatus: 'inactif',
        isFormerClient: true,
      }, warnings);

      // 4. RDV coaching à venir — annulés + Google Calendar nettoyé.
      const bookings = await findUpcomingCoachingBookings(clientId, email);
      const cancelled = await cancelBookings(bookings, auth.uid, byName, warnings);

      // 5. Academy — connexion coupée (réversible, données conservées).
      const academy = email
        ? await applyAcademy(clientId, email, true, auth.uid, byName, warnings)
        : { ok: false, found: false, error: 'no_email' };
      if (!email) warnings.push('Pas d\'email sur la fiche coaching — Academy non désactivée.');

      res.status(200).json({
        ok: true,
        action: 'deactivate',
        mode: mode,
        report: {
          client: { id: clientId, statut: 'inactif', clientStatus: mode, ancienClient: true },
          lead: leadRes,
          person: personRes,
          bookingsCancelled: cancelled,
          academy: academy,
        },
        warnings: warnings,
      });
      return;
    }

    // ── REACTIVATE ──────────────────────────────────────────────────────
    if (action === 'reactivate') {
      await db.collection('clients').doc(clientId).update({
        statut: 'actif',
        clientStatus: 'active',
        ancienClient: false,
        reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        reactivatedBy: auth.uid,
        reactivatedByName: byName,
        deactivationHistory: admin.firestore.FieldValue.arrayUnion({
          at: new Date().toISOString(), by: auth.uid, byName: byName, action: 'reactivate',
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const leadRes = await applyToLead(lead, {
        clientStatus: 'active',
        isFormerClient: false,
      }, '↩️ Client réactivé' + (byName ? ' (' + byName + ')' : ''), warnings);

      const personRes = await applyToPerson(personId, {
        crmStatus: 'active',
        coachingStatus: 'actif',
        isFormerClient: false,
      }, warnings);

      const academy = email
        ? await applyAcademy(clientId, email, false, auth.uid, byName, warnings)
        : { ok: false, found: false, error: 'no_email' };

      res.status(200).json({
        ok: true,
        action: 'reactivate',
        report: {
          client: { id: clientId, statut: 'actif', clientStatus: 'active', ancienClient: false },
          lead: leadRes,
          person: personRes,
          academy: academy,
        },
        warnings: warnings,
      });
      return;
    }
  } catch (e) {
    console.error('[client-deactivate] fatal', e);
    res.status(200).json({ ok: false, error: e.message || 'unexpected_error' });
  }
};
