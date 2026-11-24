// ============================================================================
// api/followup-calendar-repair.js — TEMPORAIRE (24/11/2026)
// ----------------------------------------------------------------------------
// Rattrapage du bug corrigé dans api/calendar-followup-event.js : les rappels
// (follow-ups « 📅 Calendrier Stratégie ») partaient dans l'agenda du membre
// ASSIGNÉ au lead, pas dans celui de leur auteur (rappels de Claire dans
// l'agenda d'Anthony, qui y bloquaient des créneaux réservables).
//
// Périmètre : FU À VENIR (dateTime ≥ maintenant, heure de Paris) portant un
// calendarEventId SANS calendarId (= créés avant le correctif), dont l'auteur
// (createdBy, nom court de l'équipe) n'est pas le propriétaire de l'agenda
// qui a reçu l'événement (calendarPersonId).
//
//   - FU non fait → événement RECRÉÉ dans l'agenda Booking de l'auteur
//     (« Calendrier pour créer les événements », primary à défaut), le FU
//     est mis à jour (nouvel id + trace calendarMovedFrom), puis l'ancien
//     événement est retiré de l'agenda qui l'a reçu à tort.
//   - FU déjà fait → l'ancien événement est seulement retiré (il bloquait
//     un créneau pour rien) ; trace calendarRemovedFrom sur le FU.
//   - Auteur introuvable / ambigu, fiche Booking absente ou non connectée,
//     ou même agenda des deux côtés (boîte partagée sans sous-agenda choisi)
//     → rien n'est touché, la ligne est signalée.
//
// Rien n'est supprimé dans Firestore. Trace de chaque passage réel :
// fu_calendar_repair_log (Admin SDK seul).
//
// Accès : GET ?key=<FU_CAL_REPAIR_KEY>            → à blanc (aucune écriture)
//         GET ?key=<FU_CAL_REPAIR_KEY>&apply=1    → exécution (40 FU max par
//         appel, relancer jusqu'à « restants : 0 »)
// Sortie : aucune donnée de prospect (ni nom, ni téléphone, ni e-mail) —
// identifiants, dates et prénoms de l'équipe seulement.
// À supprimer (fichier + variable Vercel) une fois le rattrapage fait.
// ============================================================================

const crypto = require('crypto');
const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');

const APPLY_CAP = 40;

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Heure actuelle à Paris au format "YYYY-MM-DDTHH:mm:ss" (comparable aux
// dateTime des FU, écrits en heure locale sans fuseau).
function nowParisIso() {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = {};
  parts.forEach(function (p) { g[p.type] = p.value; });
  return g.year + '-' + g.month + '-' + g.day + 'T' + g.hour + ':' + g.minute + ':' + g.second;
}

// ─── OAuth (même logique que calendar-followup-event.js) ────────────────────
let _oauthConf = null;
async function getOAuthConfig() {
  if (_oauthConf) return _oauthConf;
  const tries = ['oauth_calendar', 'oauth'];
  for (const id of tries) {
    const doc = await db.collection('_config').doc(id).get();
    if (doc.exists) {
      const data = doc.data() || {};
      if (data.client_id && data.client_secret) { _oauthConf = data; return data; }
    }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable');
}

const _clients = {};
async function clientFor(personId) {
  if (personId in _clients) return _clients[personId];
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  const data = tokenDoc.exists ? (tokenDoc.data() || {}) : {};
  if (!data.refreshToken && !data.accessToken) { _clients[personId] = null; return null; }
  const conf = await getOAuthConfig();
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials({ access_token: data.accessToken || null, refresh_token: data.refreshToken || null });
  client.on('tokens', async function (t) {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) {
      try { await db.collection('calendar_tokens').doc(personId).update(u); } catch (e) { /* non bloquant */ }
    }
  });
  _clients[personId] = client;
  return client;
}

function eventCalendarIdOf(bc) {
  const list = (bc && bc.calendarList) || [];
  const target = list.find(function (c) { return c && c.createEvents === true && c.id; });
  return target ? target.id : 'primary';
}
function calendarNameOf(bc, calId) {
  const list = (bc && bc.calendarList) || [];
  const c = list.find(function (x) { return x && x.id === calId; });
  return c ? (c.name || calId) : calId;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const key = process.env.FU_CAL_REPAIR_KEY;
  const given = String((req.query && req.query.key) || '');
  if (!key || !safeEq(given, key)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const apply = String((req.query && req.query.apply) || '') === '1';

  try {
    // 1. Équipe : nom → membre (unique), uid → fiches Booking.
    const tmDoc = await db.collection('_meta').doc('team_members').get();
    const raw = (tmDoc.data() || {}).members || {};
    const members = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) {
      const m = raw[k] || {};
      if (!m.slug) m.slug = k;
      return m;
    });
    const byName = {};
    members.forEach(function (m) {
      const names = [m.slug, m.shortName, m.displayName, m.name, m.firstName];
      const seen = {};
      names.forEach(function (n) {
        const k = norm(n);
        if (!k || seen[k]) return;
        seen[k] = true;
        (byName[k] = byName[k] || []).push(m);
      });
    });

    const bcSnap = await db.collection('booking_config').get();
    const bcById = {};
    const bcByUid = {};
    bcSnap.docs.forEach(function (d) {
      const data = d.data() || {};
      bcById[d.id] = data;
      if (data.firebaseUid) (bcByUid[data.firebaseUid] = bcByUid[data.firebaseUid] || []).push(d.id);
    });

    async function authorFiche(uid) {
      const ids = bcByUid[uid] || [];
      for (let i = 0; i < ids.length; i++) {
        if (await clientFor(ids[i])) return ids[i];
      }
      return ids.length ? { notConnected: ids[0] } : null;
    }

    // 2. Parcours des leads (champ followUps seulement).
    const now = nowParisIso();
    const items = [];
    let scanned = 0;
    let last = null;
    const FieldPath = admin.firestore.FieldPath;
    for (;;) {
      let q = db.collection('leads').select('followUps').orderBy(FieldPath.documentId()).limit(1000);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      snap.docs.forEach(function (doc) {
        last = doc.id;
        scanned++;
        const fus = (doc.data() || {}).followUps;
        if (!Array.isArray(fus)) return;
        fus.forEach(function (fu) {
          if (!fu || !fu.calendarEventId || fu.calendarId) return;
          if (!fu.dateTime || String(fu.dateTime) < now) return;
          items.push({ leadId: doc.id, fu: fu });
        });
      });
      if (snap.size < 1000) break;
    }

    // 3. Classement.
    const rows = [];
    for (const it of items) {
      const fu = it.fu;
      const row = {
        leadId: it.leadId,
        fuId: fu.id,
        date: fu.dateTime,
        fait: !!fu.done,
        auteur: fu.createdBy || '',
        agendaActuel: (bcById[fu.calendarPersonId] || {}).name || fu.calendarPersonId || '?'
      };
      const matches = byName[norm(fu.createdBy)] || [];
      const uniq = matches.filter(function (m, i) { return matches.indexOf(m) === i; });
      if (uniq.length !== 1) {
        row.statut = uniq.length ? 'auteur_ambigu' : 'auteur_inconnu';
        rows.push(row); continue;
      }
      const author = uniq[0];
      if (!author.firebaseUid) { row.statut = 'auteur_sans_compte'; rows.push(row); continue; }
      const fiche = await authorFiche(author.firebaseUid);
      if (!fiche) { row.statut = 'auteur_sans_fiche_booking'; rows.push(row); continue; }
      if (typeof fiche === 'object') { row.statut = 'agenda_auteur_non_connecte'; rows.push(row); continue; }
      if (fiche === fu.calendarPersonId) { row.statut = 'deja_dans_son_agenda'; rows.push(row); continue; }
      const bcAuthor = bcById[fiche] || {};
      const bcOld = bcById[fu.calendarPersonId] || {};
      const targetCal = eventCalendarIdOf(bcAuthor);
      row.agendaCible = (bcAuthor.name || fiche) + ' / ' + calendarNameOf(bcAuthor, targetCal);
      if (targetCal === 'primary' && bcAuthor.calendarEmail && bcAuthor.calendarEmail === bcOld.calendarEmail) {
        // Même compte Google, même agenda principal : déplacer ne changerait rien.
        row.statut = 'meme_agenda_reglage_fiche_a_faire';
        rows.push(row); continue;
      }
      row.statut = fu.done ? 'a_retirer' : 'a_deplacer';
      row._fiche = fiche;
      row._targetCal = targetCal;
      row._oldPerson = fu.calendarPersonId;
      rows.push(row);
    }

    // 4. Exécution.
    const todo = rows.filter(function (r) { return r.statut === 'a_deplacer' || r.statut === 'a_retirer'; });
    const done = [];
    if (apply) {
      for (const r of todo.slice(0, APPLY_CAP)) {
        const it = items.find(function (x) { return x.leadId === r.leadId && x.fu.id === r.fuId; });
        const fu = it.fu;
        const oldEventId = fu.calendarEventId; // figé : le FU est réécrit plus bas
        try {
          const oldClient = await clientFor(r._oldPerson);
          let oldEvent = null;
          if (oldClient) {
            try {
              const g = await google.calendar({ version: 'v3', auth: oldClient }).events.get({ calendarId: 'primary', eventId: oldEventId });
              oldEvent = g.data;
            } catch (e) {
              const st = (e && e.code) || (e && e.response && e.response.status) || 0;
              if (st !== 404 && st !== 410) throw e;
            }
          }

          let newEvent = null;
          if (r.statut === 'a_deplacer') {
            const authorClient = await clientFor(r._fiche);
            const body = oldEvent && oldEvent.start && oldEvent.start.dateTime ? {
              summary: oldEvent.summary,
              description: oldEvent.description,
              start: oldEvent.start,
              end: oldEvent.end,
              reminders: { useDefault: true }
            } : null;
            if (!body) throw new Error('ancien_evenement_illisible');
            const ins = await google.calendar({ version: 'v3', auth: authorClient }).events.insert({
              calendarId: r._targetCal, sendUpdates: 'none', requestBody: body
            });
            newEvent = ins.data;
          }

          // FU mis à jour AVANT de retirer l'ancien événement.
          const leadRef = db.collection('leads').doc(r.leadId);
          await db.runTransaction(async function (tx) {
            const snap = await tx.get(leadRef);
            if (!snap.exists) return;
            const fus = (snap.data().followUps || []).slice();
            for (let i = 0; i < fus.length; i++) {
              if (fus[i] && fus[i].id === r.fuId && fus[i].calendarEventId === oldEventId) {
                const trace = { personId: r._oldPerson, eventId: oldEventId, at: new Date().toISOString(), via: 'followup-calendar-repair' };
                if (newEvent) {
                  fus[i].calendarEventId = newEvent.id;
                  fus[i].calendarEventLink = newEvent.htmlLink || '';
                  fus[i].calendarPersonId = r._fiche;
                  fus[i].calendarId = r._targetCal;
                  fus[i].calendarMovedFrom = trace;
                } else {
                  fus[i].calendarRemovedFrom = trace;
                  delete fus[i].calendarEventId;
                  delete fus[i].calendarEventLink;
                }
                tx.update(leadRef, { followUps: fus });
                break;
              }
            }
          });

          if (oldEvent && oldClient) {
            try {
              await google.calendar({ version: 'v3', auth: oldClient }).events.delete({ calendarId: 'primary', eventId: oldEventId, sendUpdates: 'none' });
            } catch (e) {
              const st = (e && e.code) || (e && e.response && e.response.status) || 0;
              if (st !== 404 && st !== 410) throw e;
            }
          }
          r.resultat = newEvent ? 'deplace' : 'retire';
        } catch (e) {
          r.resultat = 'erreur';
          r.erreur = (e && e.message) || String(e);
        }
        done.push(r);
      }
      await db.collection('fu_calendar_repair_log').add({
        at: new Date().toISOString(),
        traites: done.map(function (r) {
          return { leadId: r.leadId, fuId: r.fuId, statut: r.statut, resultat: r.resultat, erreur: r.erreur || null, de: r._oldPerson, vers: r._fiche || null, calendrier: r._targetCal || null };
        })
      });
    }

    // 5. Sortie (sans données de prospect, sans champs internes).
    // Les rappels déjà dans l'agenda de leur auteur ne sont que comptés.
    const out = rows.filter(function (r) { return r.statut !== 'deja_dans_son_agenda'; }).map(function (r) {
      const o = {};
      Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = r[k]; });
      return o;
    });
    const compte = {};
    rows.forEach(function (r) { compte[r.statut] = (compte[r.statut] || 0) + 1; });
    const resultats = {};
    done.forEach(function (r) { resultats[r.resultat] = (resultats[r.resultat] || 0) + 1; });

    res.status(200).json({
      mode: apply ? 'execution' : 'a_blanc',
      maintenantParis: now,
      leadsParcourus: scanned,
      rappelsAVenirAncienFormat: items.length,
      parStatut: compte,
      traitesCePassage: apply ? resultats : undefined,
      restants: todo.length - done.filter(function (r) { return r.resultat !== 'erreur'; }).length,
      lignes: out
    });
  } catch (err) {
    console.error('[followup-calendar-repair]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'internal_error', message: (err && err.message) || 'Erreur serveur.' });
  }
};
