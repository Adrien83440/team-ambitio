// ============================================================================
// scripts/fix-bot-bookings-2026-10.js — rattrapage du 26/10/2026
// ----------------------------------------------------------------------------
// Le bot « LoulouNina Sagas Sega Commentaires » (julienung6@gmail.com,
// 06 52 25 43 34, leads/57fjeP7UJZ1GhCYNe1Uy) a pris 4 RDV le 25/10 entre
// 05:51 et 05:58, alors que son numéro était blacklisté depuis le 13/10 :
// booking.html ne lisait pas la liste de blocage (corrigé : api/booking-guard.js).
// Le 25/10 vers 07:35, les 4 RDV ont été statués « Disqua » / « Non close »
// au lieu d'« Annulé » : status 'completed', donc événements Google restés
// dans les agendas (stratégie@ et Claire), rappels SMS / e-mail partis vers
// le bot, RDV comptés comme tenus.
//
// Ce script, pour chacun des 4 RDV :
//   1. retire l'événement Google (sendUpdates=none : aucun mail au bot) ;
//   2. passe le RDV en Annulé par l'équipe, raison « Bot — contact
//      blacklisté » : status 'cancelled', outcome 'annule' (l'ancien
//      résultat reste dans outcomeHistory), bloc `cancellation` ;
//      cancelHandledAt posé dans la même écriture → onBookingUpdated ne
//      renvoie ni e-mail d'annulation au bot ni notification équipe.
// La fiche lead n'est pas touchée (déjà sortie des files par le blocage).
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-bot-bookings-2026-10.js            # dry-run
//   ... node scripts/fix-bot-bookings-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BOT_EMAIL = 'julienung6@gmail.com';
const LEAD_ID = '57fjeP7UJZ1GhCYNe1Uy';
const BOOKING_IDS = [
  'sl-2026-10-25-12-00-vbcdoa',
  'sl-2026-10-25-13-15-m2bin3',
  'sl-2026-10-26-09-00-1iv4659',
  'sl-2026-10-26-12-00-1yss59z',
];
const ADRIEN_UID = 'JLVoTOGWIjNuWcZLj3HBquF448R2';
const REASON = 'Bot — contact blacklisté';

/* Jeton Google Calendar de l'expert (calendar_tokens/{personId}), rafraîchi
   avec le client OAuth de _config/oauth_calendar (repli _config/oauth) —
   même résolution que les API Vercel. */
const _conf = { v: null };
const _tok = {};
async function oauthConf() {
  if (_conf.v) return _conf.v;
  for (const id of ['oauth_calendar', 'oauth']) {
    const d = await R.getDoc('_config/' + id);
    if (d && d.data.client_id && d.data.client_secret) { _conf.v = d.data; return d.data; }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable');
}
async function calendarToken(personId) {
  if (_tok[personId]) return _tok[personId];
  const t = await R.getDoc('calendar_tokens/' + personId);
  if (!t || !t.data.refreshToken) throw new Error('pas de refreshToken pour ' + personId);
  const c = await oauthConf();
  const body = 'client_id=' + encodeURIComponent(c.client_id)
    + '&client_secret=' + encodeURIComponent(c.client_secret)
    + '&refresh_token=' + encodeURIComponent(t.data.refreshToken)
    + '&grant_type=refresh_token';
  const r = await R.request('POST', 'https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  _tok[personId] = r.access_token;
  return r.access_token;
}
async function deleteEvent(b) {
  const at = await calendarToken(b.personId);
  const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(b.calendarIdUsed || 'primary')
    + '/events/' + encodeURIComponent(b.calendarEventId) + '?sendUpdates=none';
  try {
    await R.request('DELETE', url, { Authorization: 'Bearer ' + at });
    return 'retiré';
  } catch (e) {
    if (/HTTP (404|410)/.test(String(e.message))) return 'déjà absent';
    throw e;
  }
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const lead = await R.getDoc('leads/' + LEAD_ID);
  if (lead) {
    const L = lead.data;
    console.log('Fiche : ' + (L.nom || '') + ' — stage=' + L.stage + ' status=' + L.status
      + ' blockedPhone=' + (L.blockedPhone === true) + ' blockedEmail=' + (L.blockedEmail === true));
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now);
  let n = 0;

  for (const id of BOOKING_IDS) {
    const doc = await R.getDoc('bookings/' + id);
    if (!doc) { console.log('⛔ ' + id + ' introuvable — ignoré'); continue; }
    const b = doc.data;
    const who = (b.prospect && b.prospect.email) || '';
    console.log('\n' + id + ' — ' + b.date + ' ' + b.time + ' · ' + (b.personName || b.personId)
      + ' · status=' + b.status + ' outcome=' + (b.outcome || '-') + ' · event=' + (b.calendarEventId || '-')
      + ' (' + (b.calendarIdUsed || 'primary') + ')');

    /* Garde-fous : uniquement les RDV du bot, jamais déjà annulés. */
    if (who.toLowerCase() !== BOT_EMAIL || b.leadId !== LEAD_ID) { console.log('   ⛔ pas un RDV du bot — ignoré'); continue; }
    if (b.status === 'cancelled') { console.log('   ✅ déjà annulé — rien à faire'); continue; }

    const history = (b.outcomeHistory || []).slice();
    history.push({ outcome: 'annule', note: REASON, at: nowIso, by: ADRIEN_UID, byName: 'Adrien' });
    const fields = {
      status: 'cancelled',
      outcome: 'annule',
      outcomeNote: REASON,
      outcomeAt: now,
      outcomeBy: ADRIEN_UID,
      outcomeByName: 'Adrien',
      outcomeDay: today,
      outcomeHistory: history,
      cancelledAt: now,
      cancelledBy: ADRIEN_UID,
      cancelledByName: 'Adrien',
      cancelledOrigin: 'equipe',
      cancelledReason: REASON,
      statusUpdatedAt: now,
      statusUpdatedBy: ADRIEN_UID,
      statusUpdatedByName: 'Adrien',
      cancellation: { origin: 'equipe', via: 'blacklist', by: ADRIEN_UID, byName: 'Adrien', byRole: 'admin', reason: REASON, at: nowIso },
      cancelHandledAt: now,
      cancelHandledBy: 'fix-bot-bookings-2026-10',
      _correction: 'Statué Disqua / Non close le 25/10 au lieu d\'Annulé (bot) — rattrapage du 26/10/2026',
    };
    console.log('   → Annulé (équipe, « ' + REASON + ' »), ancien résultat « ' + (b.outcome || '-') + ' » gardé dans l\'historique');
    console.log('   → événement Google : ' + (b.calendarEventId ? 'à retirer (sans mail)' : 'aucun'));
    if (!APPLY) { n++; continue; }

    // 1. Google d'abord : une fois cancelHandledAt posé, personne ne repassera.
    if (b.calendarEventId && b.personId) {
      try {
        console.log('   ✓ événement ' + (await deleteEvent(b)));
      } catch (e) {
        console.log('   ⚠️ événement NON retiré (' + e.message.slice(0, 200) + ') — à retirer à la main ; RDV annulé quand même');
      }
    }
    // 2. Firestore
    await R.patchDoc('bookings/' + id, fields, Object.keys(fields));
    console.log('   ✓ RDV passé en Annulé');
    n++;
  }

  // Créneaux occupés rafraîchis (onCalendarSyncRequest).
  if (APPLY && n) {
    for (const personId of ['elodie', 'clairedeguelle_4gr1tx']) {
      await R.patchDoc('calendar_sync_requests/' + personId,
        { requestedAt: now, requestedBy: 'fix-bot-bookings-2026-10' }, ['requestedAt', 'requestedBy'])
        .catch(function (e) { console.log('   (sync ' + personId + ' : ' + e.message.slice(0, 120) + ')'); });
    }
  }
  console.log('\n' + n + ' RDV ' + (APPLY ? 'traité(s).' : 'seraient traités. Relancer avec --apply après validation.'));
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
