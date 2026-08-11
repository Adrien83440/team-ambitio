const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const twilio = require("twilio");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/* ═══════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════ */

async function getOAuthConfig() {
  const doc = await db.collection("_config").doc("oauth").get();
  if (!doc.exists) throw new Error("_config/oauth missing in Firestore");
  return doc.data();
}

async function getAuthClientForPerson(personId) {
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
  if (!tokenDoc.exists) return null;
  var data = tokenDoc.data();
  var client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri);
  client.setCredentials({
    access_token: data.accessToken,
    refresh_token: data.refreshToken
  });
  client.on("tokens", async function(t) {
    var u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) await db.collection("calendar_tokens").doc(personId).update(u);
  });
  return client;
}

async function fetchAndStoreBusy(personId) {
  var now = new Date();
  var end = new Date();
  end.setDate(end.getDate() + 60);
  var allBusy = [];
  var allCalsChecked = [];

  // 1. Primary connection
  var client = await getAuthClientForPerson(personId);
  if (client) {
    try {
      var personDoc = await db.collection("booking_config").doc(personId).get();
      var calList = (personDoc.exists && personDoc.data().calendarList) || [];
      var calendar = google.calendar({ version: "v3", auth: client });

      // Auto-refresh calendar list if empty or on each sync
      try {
        var clResp = await calendar.calendarList.list({ maxResults: 50 });
        var freshList = (clResp.data.items || []).map(function(c) {
          // Preserve existing checkConflicts/createEvents settings
          var existing = calList.find(function(e) { return e.id === c.id; });
          return {
            id: c.id,
            name: c.summary || c.id,
            color: c.backgroundColor || "#4285f4",
            primary: c.primary === true,
            checkConflicts: existing ? existing.checkConflicts : true,
            createEvents: existing ? existing.createEvents : (c.primary === true)
          };
        });
        if (freshList.length) {
          calList = freshList;
          await db.collection("booking_config").doc(personId).update({ calendarList: freshList });
        }
      } catch (e) {
        console.error("Calendar list refresh error for " + personId + ":", e.message);
      }

      var calItems = [{ id: "primary" }];
      calList.forEach(function(cal) {
        if (cal.checkConflicts !== false && cal.id && cal.id !== "primary") {
          calItems.push({ id: cal.id });
        }
      });
      var resp = await calendar.freebusy.query({
        requestBody: { timeMin: now.toISOString(), timeMax: end.toISOString(), timeZone: "Europe/Paris", items: calItems }
      });
      var cals = resp.data.calendars || {};
      Object.keys(cals).forEach(function(calId) {
        var slots = (cals[calId] && cals[calId].busy) || [];
        allBusy = allBusy.concat(slots);
        allCalsChecked.push(calId);
      });
    } catch (e) {
      console.error("fetchAndStoreBusy primary error for " + personId + ":", e.message);
    }
  }

  // 2. Extra connections (personal agendas)
  try {
    var personDoc2 = await db.collection("booking_config").doc(personId).get();
    var extraConns = (personDoc2.exists && personDoc2.data().extraConnections) || [];
    for (var ec of extraConns) {
      var tokenDoc = await db.collection("calendar_extra_tokens").doc(personId + "__" + ec.id).get();
      if (!tokenDoc.exists) continue;
      try {
        var conf = await getOAuthConfig();
        var eClient = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri);
        var eData = tokenDoc.data();
        eClient.setCredentials({ access_token: eData.accessToken, refresh_token: eData.refreshToken });
        eClient.on("tokens", async function(t) {
          var u = {};
          if (t.access_token) u.accessToken = t.access_token;
          if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
          if (t.refresh_token) u.refreshToken = t.refresh_token;
          if (Object.keys(u).length) await db.collection("calendar_extra_tokens").doc(personId + "__" + ec.id).update(u);
        });
        var eCalItems = (ec.calendars || []).filter(function(c) { return c.checkConflicts !== false; }).map(function(c) { return { id: c.id }; });
        if (!eCalItems.length) eCalItems = [{ id: "primary" }];
        var eCal = google.calendar({ version: "v3", auth: eClient });
        var eResp = await eCal.freebusy.query({
          requestBody: { timeMin: now.toISOString(), timeMax: end.toISOString(), timeZone: "Europe/Paris", items: eCalItems }
        });
        var eCals = eResp.data.calendars || {};
        Object.keys(eCals).forEach(function(calId) {
          var slots = (eCals[calId] && eCals[calId].busy) || [];
          allBusy = allBusy.concat(slots);
          allCalsChecked.push(ec.email + ":" + calId);
        });
      } catch (e) {
        console.error("fetchAndStoreBusy extra error for " + personId + " (" + ec.email + "):", e.message);
      }
    }
  } catch (e) {
    console.error("fetchAndStoreBusy extra connections error:", e.message);
  }

  // Sort and store
  allBusy.sort(function(a, b) { return new Date(a.start) - new Date(b.start); });
  await db.collection("calendar_busy").doc(personId).set({
    busy: allBusy,
    calendarsChecked: allCalsChecked,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log("Synced " + allBusy.length + " busy slots from " + allCalsChecked.length + " calendar(s) for " + personId);
}


/**
 * Détermine le calendarId Google sur lequel créer / patcher / supprimer
 * les events de booking pour un expert donné.
 *
 * Lit booking_config/{personId}, cherche dans calendarList[] l'entrée
 * avec createEvents:true (positionnée par le picker UI dans booking-admin
 * → Expert → Paramètres du calendrier → "Calendrier pour créer les
 * événements"). Retourne son `id` Google (format soit "primary" pour le
 * compte principal, soit "xxxxx@group.calendar.google.com" pour un
 * sous-calendrier comme ceux des coachs sous coaching@adrienemily.com).
 *
 * Fallback "primary" si aucun calendrier n'a createEvents:true (cas
 * d'un expert dont le picker n'a jamais été cliqué) → préserve le
 * comportement historique sans rien casser.
 *
 * Utilisé par onBookingCreated (insert/patch/get). À la création, le
 * calendarId résolu est stocké sur le booking dans le champ
 * calendarIdUsed pour que onBookingUpdated puisse le relire et cibler
 * le bon calendrier au moment du delete, même si l'admin change la
 * préférence createEvents entre-temps.
 */
async function getEventCalendarId(personId) {
  try {
    const doc = await db.collection("booking_config").doc(personId).get();
    if (!doc.exists) return "primary";
    const list = doc.data().calendarList || [];
    const target = list.find(function(c) { return c && c.createEvents === true && c.id; });
    return target ? target.id : "primary";
  } catch (e) {
    console.error("getEventCalendarId error for " + personId + ":", e.message);
    return "primary";
  }
}


// ─────────────────────────────────────────────────────────────────────────
// FIX "deux liens Google Meet" (2026-06)
//
// SEND_GOOGLE_INVITE_TO_PROSPECT :
//   true  → le prospect reçoit l'invitation Google native (auto-ajout agenda
//           + rappels Google) ET l'email stylé Alteore, désormais avec un lien
//           Meet IDENTIQUE dans les deux (l'invitation native n'est envoyée
//           qu'APRÈS stabilisation du code Meet). Plus aucun "lequel prendre ?".
//   false → aucune invitation Google native n'est envoyée au prospect ; l'email
//           stylé Alteore devient l'unique canal (un seul email, un seul lien).
//           Le prospect ajoute le RDV via le .ics de la page de confirmation.
const SEND_GOOGLE_INVITE_TO_PROSPECT = true;

/**
 * Attend que le code Google Meet d'un événement soit DÉFINITIF avant qu'on
 * notifie qui que ce soit.
 *
 * Le code Meet d'un event créé via l'API (conferenceData.createRequest) est
 * généré de façon ASYNCHRONE, puis peut être régénéré par Google (paramètre
 * Workspace "secure meeting codes"). C'est l'origine du bug "deux liens" :
 * l'invitation native partait avant cette stabilisation (ancien code) alors
 * que l'email stylé portait le nouveau. Ici on poll events.get jusqu'à ce que
 * le createRequest soit en statut 'success' ET qu'un lien vidéo soit présent
 * (ou jusqu'au timeout). Retourne le lien final, sinon le dernier lien vu,
 * sinon le fallback fourni.
 */
async function waitForFinalMeetLink(cal, calendarId, eventId, opts) {
  opts = opts || {};
  const maxTries = opts.maxTries || 8;   // 8 essais
  const delayMs = opts.delayMs || 700;   // ~5,6 s max au total
  let lastLink = opts.fallback || null;
  for (let i = 0; i < maxTries; i++) {
    await new Promise(function (r) { setTimeout(r, delayMs); });
    try {
      const g = await cal.events.get({ calendarId: calendarId, eventId: eventId });
      const data = g.data || {};
      const cd = data.conferenceData || {};
      const status = (cd.createRequest && cd.createRequest.status && cd.createRequest.status.statusCode) || null;
      const videoUri = (cd.entryPoints || [])
        .filter(function (e) { return e && e.entryPointType === 'video'; })
        .map(function (e) { return e.uri; })[0] || null;
      const link = data.hangoutLink || videoUri || null;
      if (link) lastLink = link;
      // Lien présent ET conférence finalisée (statut absent = déjà stable).
      if (link && status !== 'pending') {
        return link;
      }
    } catch (e) {
      console.error('[waitForFinalMeetLink] get error:', e.message);
    }
  }
  return lastLink;
}


/* ═══════════════════════════════════════════════════
   WEBHOOK HELPERS
   ═══════════════════════════════════════════════════ */

async function validateApiKey(key) {
  if (!key) return false;
  try {
    const doc = await db.collection("_config").doc("webhook_keys").get();
    if (!doc.exists) return false;
    return (doc.data().keys || []).includes(key);
  } catch (e) {
    console.error("validateApiKey error:", e.message);
    return false;
  }
}

// onNewLead-placeholder-2026-05 : détecte les téléphones placeholder évidents
// (6 fois le même chiffre, etc.) qui causent des faux merges entre leads
// totalement différents. Ex: +33666666666 (utilisé par systeme.io quand le
// vrai tel n'est pas demandé sur le formulaire).
const PLACEHOLDER_PHONES_LAST9 = new Set([
  '666666666', '000000000', '111111111', '222222222', '333333333',
  '444444444', '555555555', '777777777', '888888888', '999999999',
  '700000000', '600000000', '123456789', '987654321'
]);
function isPlaceholderPhone(tel) {
  if (!tel) return false;
  const last9 = String(tel).replace(/[^\d]/g, '').slice(-9);
  return PLACEHOLDER_PHONES_LAST9.has(last9);
}

async function findLead(email, phone) {
  if (email) {
    const emailNorm = email.trim().toLowerCase();
    const snap = await db.collection("leads").where("email", "==", emailNorm).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    const snap2 = await db.collection("leads").where("email", "==", email.trim()).limit(1).get();
    if (!snap2.empty) return { id: snap2.docs[0].id, data: snap2.docs[0].data() };
  }
  if (phone) {
    const digits = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
    const variants = new Set();
    variants.add(phone.replace(/\s+/g, ""));
    variants.add(phone.trim());

    // findLead-fix-2026-05 : gestion du cas anormal "+33 suivi de 0" (12 digits
    // après le +) — fréquent dans les payloads webhook où l'utilisateur a tapé
    // "+33 0X XX XX XX XX" et le 0 du format national n'est pas strippé. Avant
    // ce fix, base devenait "00XXXXXXXXX" (11 chars) et le check `base.length
    // === 10` skippait toutes les variants → doublon silencieux.
    let base = "";
    if (digits.startsWith("33") && digits.length >= 11) {
      let after33 = digits.slice(2);
      if (after33.startsWith("0") && after33.length === 10) {
        after33 = after33.slice(1);
      }
      base = "0" + after33;
    } else if (digits.startsWith("0") && digits.length === 10) {
      base = digits;
    } else if (digits.length === 9) {
      base = "0" + digits;
    }

    if (base && base.length === 10) {
      variants.add(base);
      variants.add(base.slice(0,2) + " " + base.slice(2,4) + " " + base.slice(4,6) + " " + base.slice(6,8) + " " + base.slice(8,10));
      variants.add(base.slice(0,2) + "." + base.slice(2,4) + "." + base.slice(4,6) + "." + base.slice(6,8) + "." + base.slice(8,10));
      variants.add("+33" + base.slice(1));
      variants.add("33" + base.slice(1));
      variants.add("+33 " + base.slice(1,2) + " " + base.slice(2,4) + " " + base.slice(4,6) + " " + base.slice(6,8) + " " + base.slice(8,10));
    }

    for (const v of variants) {
      const snap = await db.collection("leads").where("telephone", "==", v).limit(1).get();
      if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    }

    // Filet de sécurité : matching par 9 derniers chiffres via phoneNormalized.
    // Rattrape tout cas tordu (espaces, formatage exotique, leads importés Bigin).
    if (digits.length >= 9) {
      const last9 = digits.slice(-9);
      const snapNorm = await db.collection("leads").where("phoneNormalized", "==", last9).limit(1).get();
      if (!snapNorm.empty) return { id: snapNorm.docs[0].id, data: snapNorm.docs[0].data() };
    }
  }
  return null;
}

/* saneCommDate-fix-2026-07-15 : une communication doit porter un timestamp
   REEL. Make envoie parfois une date sans heure ("2026-07-15") -> parsee a
   minuit UTC -> affichee 02:00 Paris sur toutes les fiches. Regle : date
   fournie AVEC heure -> normalisee ISO ; sinon (absente, jour seul,
   invalide) -> heure de traitement, la fonction tournant en quasi temps
   reel derriere webhook_inbox (ecart de quelques secondes au plus). */
function saneCommDate(v) {
  if (v == null || v === "") return new Date().toISOString();
  if (typeof v === "number" && isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const str = String(v).trim();
  const hasTime = /\d{1,2}:\d{2}/.test(str);
  const parsed = Date.parse(str);
  if (!hasTime || isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function fmtNow() {
  // fmtNow-fix-2026-05 : output en heure Europe/Paris (au lieu de l'UTC du
  // serveur Cloud Functions). Avant ce fix, les timestamps timeline posés
  // côté serveur étaient décalés de -2h par rapport au frontend (qui utilise
  // toLocaleString natif sur le browser Paris). Visible quand un event "Aussi
  // inscrit via VSL ELITE" apparaissait à 08:08 alors que le merge avait
  // réellement eu lieu à 10:08 Paris.
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return get('day') + '/' + get('month') + '/' + get('year') + ' ' + get('hour') + ':' + get('minute');
}

const S2S = {
  lead: "nouveau", nrp1: "nrp1", nrp2: "nrp2", nrp3: "nrp3",
  all_nrp: "nrp3", poubelle: "disqualifie", disqualification: "disqualifie",
  follow_up_pm: "appele", set: "rdv_pose", rdv_self_booking: "rdv_pose",
  rdv_confirmes: "rdv_pose", rdv_annules_prospect: "pas_interesse",
  rdv_annules_equipe: "pas_interesse", no_show_self: "pas_interesse",
  no_show_setting: "pas_interesse", partenariats: "rdv_pose",
  closed_won_setting: "rdv_pose", closed_won_self: "rdv_pose",
  closed_lost: "pas_interesse", follow_up_closing: "appele",
  disqualifie_closing: "disqualifie"
};


/* ═══════════════════════════════════════════════════
   SIGNATURE OTP HELPERS
   ═══════════════════════════════════════════════════ */

let _sigTwilioCreds = null;

async function getSignatureTwilioClient() {
  if (!_sigTwilioCreds) {
    const snap = await db.collection("_config").doc("telco_credentials").get();
    if (!snap.exists) throw new Error("_config/telco_credentials introuvable");
    const data = snap.data();
    const creds = data.twilio || data.Twilio;
    if (!creds || !creds.accountSid || !creds.authToken) {
      throw new Error("telco_credentials: bloc twilio incomplet (accountSid/authToken requis)");
    }
    _sigTwilioCreds = creds;
  }
  return twilio(_sigTwilioCreds.accountSid, _sigTwilioCreds.authToken);
}

async function getSignatureFromNumber() {
  if (!_sigTwilioCreds) await getSignatureTwilioClient();
  const from = _sigTwilioCreds.smsSignatureFrom;
  if (!from) {
    throw new Error(
      "telco_credentials.twilio.smsSignatureFrom non configuré. " +
      "Ajoutez ce champ dans _config/telco_credentials avec le Sender ID dédié aux SMS de signature."
    );
  }
  return from;
}

function normalizePhoneE164(phone) {
  if (!phone) return phone;
  const p = String(phone).replace(/\s+/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("33") && p.length === 11) return "+" + p;
  if (p.startsWith("0") && p.length === 10) return "+33" + p.slice(1);
  return p;
}

// Actions sans apiKey
const PUBLIC_ACTIONS = ["signature_otp_send", "signature_otp_verify", "signature_resend", "signature_completed", "ringover_call_status", "ringover_recording_ready"];


/* ═══════════════════════════════════════════════════
   1. PUSH NOTIFICATIONS ON NEW LEAD + DEDUPLICATION
   ═══════════════════════════════════════════════════ */

exports.onNewLead = functions.firestore
  .document("leads/{leadId}")
  .onCreate(async (snap, context) => {
    const lead = snap.data();
    const leadId = context.params.leadId;
    const nom = lead.nom || "Nouveau prospect";
    const type = lead.type || "";
    const tel = lead.telephone || "";
    const email = lead.email || "";

    // ─── Détection de doublon (email puis téléphone) ───────────────────────
    let existingDoc = null;
    if (email) {
      const emailClean = email.trim().toLowerCase();
      const snap1 = await db.collection("leads").where("email", "==", emailClean).limit(2).get();
      snap1.forEach((doc) => { if (doc.id !== leadId) existingDoc = doc; });
      if (!existingDoc) {
        const snap2 = await db.collection("leads").where("email", "==", email.trim()).limit(2).get();
        snap2.forEach((doc) => { if (doc.id !== leadId) existingDoc = doc; });
      }
    }
    if (!existingDoc && tel && !isPlaceholderPhone(tel)) {
      // onNewLead-fix-2026-05 : strip le 0 parasite après +33/33 (cas "+330XXX")
      // + ajout fallback phoneNormalized pour rattraper les formats exotiques.
      const phoneClean = tel.replace(/[^\d]/g, "");
      let base = "";
      if (phoneClean.startsWith("33") && phoneClean.length >= 11) {
        let after33 = phoneClean.slice(2);
        if (after33.startsWith("0") && after33.length === 10) after33 = after33.slice(1);
        base = "0" + after33;
      } else if (phoneClean.startsWith("0") && phoneClean.length === 10) {
        base = phoneClean;
      } else if (phoneClean.length === 9) {
        base = "0" + phoneClean;
      }
      if (base && base.length === 10) {
        const formats = [
          base,
          base.slice(0,2) + " " + base.slice(2,4) + " " + base.slice(4,6) + " " + base.slice(6,8) + " " + base.slice(8,10),
          base.slice(0,2) + "." + base.slice(2,4) + "." + base.slice(4,6) + "." + base.slice(6,8) + "." + base.slice(8,10),
          "+33" + base.slice(1),
          "33" + base.slice(1)
        ];
        for (const fmt of formats) {
          if (existingDoc) break;
          const s = await db.collection("leads").where("telephone", "==", fmt).limit(2).get();
          s.forEach((doc) => { if (doc.id !== leadId) existingDoc = doc; });
        }
      }
      // Filet de sécurité : matching par phoneNormalized (9 derniers chiffres)
      if (!existingDoc && phoneClean.length >= 9) {
        const last9 = phoneClean.slice(-9);
        const s = await db.collection("leads").where("phoneNormalized", "==", last9).limit(2).get();
        s.forEach((doc) => { if (doc.id !== leadId) existingDoc = doc; });
      }
    }

    // Labels de tunnels (réutilisés dans les deux branches existing/new)
    const typeLabels = {
      vsl_elite:    "VSL Élite",
      self_booking: "Self Booking",
      webinaire:    "Webinaire",
      business:     "VSL Business"
    };

    if (existingDoc) {
      const existing = existingDoc.data();

      // ═══════════════════════════════════════════════════════════════════════
      // REFONTE 2026-05-27 — "Reset visuel + Archive complète"
      // ─────────────────────────────────────────────────────────────────────
      // À chaque ré-engagement (opt-in webhook Make / VSL), on archive l'état
      // précédent du lead dans engagementHistory[] puis on reset les champs
      // déclaratifs de tunnel pour que Lead Live affiche les nouvelles infos
      // d'opt-in comme un nouveau lead "frais".
      //
      // R1 — assignedTo PERSISTE (continuité commerciale du closer)
      // R2 — notesHistory PERSISTE (audit du closer)
      // R3 — bookings PERSISTENT (collection séparée, RDV passés et futurs)
      // ═══════════════════════════════════════════════════════════════════════

      // ─── Protection client coaching : pas de soft-reset stage/status ─────
      const CLIENT_STAGES = ["closed_won_setting", "closed_won_self"];
      const isClient = existing.isClient === true
                    || CLIENT_STAGES.indexOf(existing.stage) >= 0;

      // ─── Snapshot complet de l'état actuel avant l'écrasement ────────────
      // Affiché dans le bloc accordéon "📜 Historique des passages" de Lead Live.
      const engagementSnapshot = {
        archivedAt:      new Date().toISOString(),
        archivedFor:     "optin",
        type:            existing.type            || null,
        stage:           existing.stage           || null,
        status:          existing.status          || null,
        utm:             existing.utm             || null,
        source:          existing.source          || null,
        sourceDetail:    existing.sourceDetail    || null,
        formId:          existing.formId          || null,
        formTitle:       existing.formTitle       || null,
        formAnswers:     existing.formAnswers     || null,
        formSubmittedAt: existing.formSubmittedAt || null
      };

      // ─── Construction du merge update ─────────────────────────────────────
      const merge = {
        // Résurrection Lead Live (déclencheur existant)
        updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
        lastOptinAt:     admin.firestore.FieldValue.serverTimestamp(),
        lastOptinSource: "onNewLead_merge",
        lastOptinType:   type || existing.type || null,

        // Archive de l'ancien état (nouveau pattern engagementHistory)
        engagementHistory: admin.firestore.FieldValue.arrayUnion(engagementSnapshot),

        // Reset des champs déclaratifs de formulaire
        // Les anciennes réponses sont dans engagementHistory, plus en vue principale.
        formId:          admin.firestore.FieldValue.delete(),
        formTitle:       admin.firestore.FieldValue.delete(),
        formAnswers:     admin.firestore.FieldValue.delete(),
        formSubmittedAt: admin.firestore.FieldValue.delete()
      };

      // ─── Écrasement des champs de tunnel (le dernier opt-in gagne) ───────
      // Avant : on préservait l'ancien type/utm. Maintenant : le dernier opt-in
      // gagne pour que Lead Live affiche le tunnel d'opt-in actuel.
      if (type)              merge.type         = type;
      if (lead.utm)          merge.utm          = lead.utm;
      if (lead.source)       merge.source       = lead.source;
      if (lead.sourceDetail) merge.sourceDetail = lead.sourceDetail;

      // ─── Soft-reset stage/status (sauf clients protégés) ────────────────
      // L'ancien stage/status sont déjà capturés dans engagementSnapshot.
      // previousStatus/previousStage sont conservés pour le badge "⚠️ Avant : X"
      // déjà géré côté sales-leads.html.
      if (!isClient) {
        merge.previousStatus = existing.status || null;
        merge.previousStage  = existing.stage  || null;
        merge.stage  = "lead";
        merge.status = "nouveau";
      }

      // ─── types[] cumulatif (audit lifetime des tunnels touchés) ──────────
      // Sert au filtrage Lead Live et à l'analytics. Indépendant de
      // engagementHistory qui contient les snapshots complets datés.
      if (type && type !== existing.type) {
        const types = existing.types || (existing.type ? [existing.type] : []);
        if (types.indexOf(type) < 0) types.push(type);
        merge.types = types;

        // Tag du nouveau tunnel (cumulatif)
        const currentTags = existing.tags || [];
        const newTag = typeLabels[type] || type;
        if (newTag && currentTags.indexOf(newTag) < 0) {
          currentTags.push(newTag);
          merge.tags = currentTags;
        }
      }

      // ─── Merge identité : ne touche QUE les trous ────────────────────────
      // nom/telephone/email + données business (secteur/ca/defi/disponibilite/
      // closeur/setting) : on ne les écrase JAMAIS si déjà présents côté
      // existant. Ce sont des données de la fiche, pas du tunnel.
      const mergeFields = ["nom", "telephone", "email", "secteur", "ca", "defi", "disponibilite", "closeur", "setting"];
      mergeFields.forEach((f) => {
        if (lead[f] && !existing[f]) merge[f] = lead[f];
      });

      // ─── Timeline orange #fb923c (pattern AlteoForm + bridge booking) ────
      const timeline = existing.timeline_history || [];
      timeline.push({
        text: "🔄 Nouvel opt-in " + (typeLabels[type] || type || "autre canal"),
        date: fmtNow(),
        color: "#fb923c"
      });
      merge.timeline_history = timeline;

      // ─── Apply ──────────────────────────────────────────────────────────
      await existingDoc.ref.update(merge);
      await snap.ref.delete();
      console.log("onNewLead: merged duplicate " + leadId + " into " + existingDoc.id + " (" + (email || tel) + ") with engagement archive");

      // ─── Notif iPhone "Contact existant" (inchangée) ────────────────────
      const title = "🔄 Contact existant : " + nom;
      let body = (typeLabels[type] || type) + " (déjà dans le CRM)";
      if (tel) body += " · " + tel;
      const tokensSnap = await db.collection("fcm_tokens").get();
      if (!tokensSnap.empty) {
        const tokens = [];
        tokensSnap.forEach((doc) => { const t = doc.data().token; if (t) tokens.push(t); });
        if (tokens.length) {
          await messaging.sendEachForMulticast({
            data: { title, body, leadId: existingDoc.id, url: "/sales-leads.html?app=1" },
            tokens
          });
        }
      }
      return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NOUVEAU LEAD (aucun doublon trouvé) — comportement inchangé
    // ═══════════════════════════════════════════════════════════════════════
    const typeLabel = typeLabels[type] || type || "Lead";
    const title = "🔔 Nouveau lead : " + nom;
    let body = typeLabel;
    if (tel) body += " · " + tel;
    if (email) body += " · " + email;
    const tokensSnap = await db.collection("fcm_tokens").get();
    if (tokensSnap.empty) return null;
    const tokens = [];
    tokensSnap.forEach((doc) => { const t = doc.data().token; if (t) tokens.push(t); });
    if (!tokens.length) return null;
    const message = { data: { title, body, leadId, url: "/sales-leads.html?app=1" }, tokens };
    const response = await messaging.sendEachForMulticast(message);
    if (response.failureCount > 0) {
      const bad = [];
      response.responses.forEach((r, i) => {
        if (!r.success && r.error && (r.error.code === "messaging/invalid-registration-token" || r.error.code === "messaging/registration-token-not-registered")) bad.push(tokens[i]);
      });
      const batch = db.batch();
      bad.forEach((t) => batch.delete(db.collection("fcm_tokens").doc(t)));
      if (bad.length) await batch.commit();
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   2. GOOGLE CALENDAR — AUTH REQUEST
   ═══════════════════════════════════════════════════ */

exports.onCalendarAuthRequest = functions.firestore
  .document("calendar_auth_requests/{requestId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const code = data.code;
    const personId = data.personId;
    const isExtra = data.isExtra === true;
    if (!code || !personId) {
      await snap.ref.update({ status: "error", error: "Missing code or personId" });
      return null;
    }
    try {
      const conf = await getOAuthConfig();
      const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri);
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email || "";

      const calApi = google.calendar({ version: "v3", auth: client });
      var calendarList = [];
      try {
        const clResp = await calApi.calendarList.list({ maxResults: 50 });
        calendarList = (clResp.data.items || []).map(function(c) {
          return {
            id: c.id,
            name: c.summary || c.id,
            color: c.backgroundColor || "#4285f4",
            primary: c.primary === true,
            checkConflicts: true,
            createEvents: c.primary === true
          };
        });
      } catch (e) {
        console.error("Calendar list fetch error:", e.message);
      }

      if (isExtra) {
        var connId = email.replace(/[^a-zA-Z0-9]/g, "_");
        await db.collection("calendar_extra_tokens").doc(personId + "__" + connId).set({
          accessToken: tokens.access_token || "",
          refreshToken: tokens.refresh_token || "",
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          email: email,
          personId: personId,
          connectedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        var personDoc = await db.collection("booking_config").doc(personId).get();
        var existing = personDoc.exists ? (personDoc.data().extraConnections || []) : [];
        existing = existing.filter(function(c) { return c.email !== email; });
        existing.push({
          id: connId,
          email: email,
          calendars: calendarList.map(function(c) { return { id: c.id, name: c.name, color: c.color, primary: c.primary, checkConflicts: true }; })
        });
        await db.collection("booking_config").doc(personId).update({ extraConnections: existing });
        await snap.ref.update({ status: "success", email: email, isExtra: true });
        await fetchAndStoreBusy(personId);
        console.log("Extra calendar connected for " + personId + " (" + email + ")");
      } else {
        await db.collection("calendar_tokens").doc(personId).set({
          accessToken: tokens.access_token || "",
          refreshToken: tokens.refresh_token || "",
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          email: email,
          connectedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection("booking_config").doc(personId).update({
          calendarConnected: true,
          calendarEmail: email,
          calendarList: calendarList
        });
        await snap.ref.update({ status: "success", email: email });
        await fetchAndStoreBusy(personId);
        console.log("Calendar connected for " + personId + " (" + email + ")");
      }
    } catch (e) {
      console.error("Auth exchange error:", e.message);
      await snap.ref.update({ status: "error", error: e.message });
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   3. GOOGLE CALENDAR — AUTO-CREATE EVENT ON BOOKING
   ═══════════════════════════════════════════════════ */

// [REMOVED 2026-04-25] Ancienne onBookingCreated orpheline — écrasée par celle
// de la section ~1735 (le second `exports.onBookingCreated` du fichier prenait
// le dessus en JS). Garder un seul handler évite la confusion future.


/* ═══════════════════════════════════════════════════
   4. GOOGLE CALENDAR — SYNC BUSY TIMES ON REQUEST
   ═══════════════════════════════════════════════════ */

exports.onCalendarSyncRequest = functions.firestore
  .document("calendar_sync_requests/{personId}")
  .onWrite(async (change, context) => {
    await fetchAndStoreBusy(context.params.personId);
    return null;
  });


/* ═══════════════════════════════════════════════════
   5. SCHEDULED SYNC — every 30 minutes
   ═══════════════════════════════════════════════════ */

exports.scheduledCalendarSync = functions.pubsub
  .schedule("every 30 minutes")
  .timeZone("Europe/Paris")
  .onRun(async () => {
    const snap = await db.collection("booking_config")
      .where("calendarConnected", "==", true).get();
    const promises = [];
    snap.forEach((doc) => promises.push(fetchAndStoreBusy(doc.id)));
    await Promise.all(promises);
    console.log("Scheduled sync: " + promises.length + " expert(s)");
    return null;
  });


/* ═══════════════════════════════════════════════════
   6. WEBHOOK INBOX — FIRESTORE TRIGGER
   ═══════════════════════════════════════════════════ */

exports.onWebhookInbox = functions.firestore
  .document("webhook_inbox/{docId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const docId = context.params.docId;

    try {
      const action = data.action;
      if (!action) {
        await snap.ref.update({ status: "error", error: "Missing action field" });
        return null;
      }

      // Validate API key — sauf pour les actions publiques signature
      if (!PUBLIC_ACTIONS.includes(action)) {

      // ─── RINGOVER — source routing (bypass API key check) ─────────────────
      // Ces docs sont écrits par nos Vercel Functions (Admin SDK, pas d'apiKey)
      if (data.source === "ringover_call_status") {
        // v2 : traitement direct dans ringover-call-status.js Vercel
        // Ce fallback gère les éventuels docs résiduels
        await snap.ref.delete();
        return null;
      }
      if (data.source === "ringover_recording_ready") {
        await handleRingoverRecordingReady(db, admin, storage, data);
        await snap.ref.delete();
        return null;
      }

        const valid = await validateApiKey(data.apiKey);
        if (!valid) {
          console.error("onWebhookInbox: invalid API key for doc " + docId);
          await snap.ref.update({ status: "error", error: "Invalid API key" });
          return null;
        }
      }

      let result = {};

      // ─── LEAD UPDATE ───
      if (action === "lead_update") {
        const found = await findLead(data.email, data.phone);
        if (!found) {
          await snap.ref.update({ status: "error", error: "Lead not found" });
          return null;
        }

        const leadId = found.id;
        const existing = found.data;
        const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        const timelineEntries = [];

        if (data.stage && data.stage !== existing.stage) {
          update.stage = data.stage;
          if (S2S[data.stage]) update.status = S2S[data.stage];
          timelineEntries.push({ text: "⚡ " + (existing.stage || "lead") + " → " + data.stage + " (webhook)", date: fmtNow(), color: "#a78bfa" });
          if (data.stage === "closed_won_setting" || data.stage === "closed_won_self") {
            update.isClient = true;
            timelineEntries.push({ text: "🎉 Converti en client !", date: fmtNow(), color: "#10b981" });
          }
        }

        let currentTags = existing.tags || [];
        if (data.addTags && Array.isArray(data.addTags)) {
          data.addTags.forEach((t) => { if (t && currentTags.indexOf(t) < 0) currentTags.push(t); });
          update.tags = currentTags;
        }
        if (data.removeTags && Array.isArray(data.removeTags)) {
          currentTags = currentTags.filter((t) => !(data.removeTags).includes(t));
          update.tags = currentTags;
        }

        if (data.contractUrl) {
          update.contractUrl = data.contractUrl;
          timelineEntries.push({ text: "📝 Contrat signé reçu", date: fmtNow(), color: "#34d399" });
        }
        if (data.contractSignedAt) update.contractSignedAt = data.contractSignedAt;
        if (data.subscriptionType) {
          update.subscriptionType = data.subscriptionType;
          timelineEntries.push({ text: "📦 Abonnement : " + data.subscriptionType, date: fmtNow(), color: "#60a5fa" });
        }
        if (data.accompagnementStart) update.accompagnementStart = data.accompagnementStart;
        if (data.accompagnementEnd) {
          update.accompagnementEnd = data.accompagnementEnd;
          timelineEntries.push({ text: "📅 " + (data.accompagnementStart || "?") + " → " + data.accompagnementEnd, date: fmtNow(), color: "#f59e0b" });
        }

        if (data.extraFields && typeof data.extraFields === "object") {
          Object.keys(data.extraFields).forEach((k) => {
            if (!["id", "createdAt", "timeline_history", "notesHistory"].includes(k)) update[k] = data.extraFields[k];
          });
        }

        if (timelineEntries.length > 0) {
          update.timeline_history = (existing.timeline_history || []).concat(timelineEntries);
        }

        await db.collection("leads").doc(leadId).update(update);
        result = { leadId };
        console.log("onWebhookInbox [lead_update]: " + leadId);
      }

      // ─── LEAD ACTIVITY ───
      else if (action === "lead_activity") {
        let found = null;
        let autoDirection = data.direction || "";

        if (data.phone) {
          found = await findLead(data.email, data.phone);
        } else if (data.phoneFrom || data.phoneTo) {
          if (data.phoneFrom) {
            found = await findLead(null, data.phoneFrom);
            if (found) autoDirection = autoDirection || "inbound";
          }
          if (!found && data.phoneTo) {
            found = await findLead(null, data.phoneTo);
            if (found) autoDirection = autoDirection || "outbound";
          }
        }

        if (!found && (data.emailFrom || data.emailTo)) {
          if (data.emailFrom) {
            found = await findLead(data.emailFrom, null);
            if (found) autoDirection = autoDirection || "inbound";
          }
          if (!found && data.emailTo) {
            found = await findLead(data.emailTo, null);
            if (found) autoDirection = autoDirection || "outbound";
          }
        }

        if (!found) {
          await snap.ref.update({ status: "error", error: "Lead not found" });
          return null;
        }

        const leadId = found.id;
        const existing = found.data;
        const type = data.type || "other";
        const now = fmtNow();
        const commDateIso = saneCommDate(data.date); // fix 15/07 : jamais une date a minuit pile

        let cleanContent = data.content || "";
        let parsedCaller = "";
        let parsedDuration = "";
        let parsedRecordingUrl = data.recordingUrl || "";
        if (cleanContent && cleanContent.includes("<br/>")) {
          const callerMatch = cleanContent.match(/(?:Emis|Re[cç]u|Reçu)\s+par\s+(.+?)(?:<br|$)/i);
          if (callerMatch) parsedCaller = callerMatch[1].trim();
          const durMatch = cleanContent.match(/Dur[ée]e[^:]*:\s*(\d+):(\d+):(\d+)/i);
          if (durMatch) {
            const h = parseInt(durMatch[1], 10);
            const m = parseInt(durMatch[2], 10);
            const s = parseInt(durMatch[3], 10);
            parsedDuration = (h > 0 ? h + "h" : "") + m + "m" + String(s).padStart(2, "0") + "s";
          }
          if (!parsedRecordingUrl) {
            const urlMatch = cleanContent.match(/href="([^"]+)"/i);
            if (urlMatch) parsedRecordingUrl = urlMatch[1];
          }
        }
        cleanContent = cleanContent.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

        const icons = { call: "📞", sms: "💬", email: "✉️", note: "📝", other: "📌" };
        const labels = { call: "Appel", sms: "SMS", email: "Email", note: "Note", other: "Activité" };
        const rawDir = (autoDirection || "").toLowerCase();
        const normDir = (rawDir === "out" || rawDir === "outbound") ? "outbound" : (rawDir === "in" || rawDir === "inbound") ? "inbound" : rawDir;
        const dir = normDir === "outbound" ? " sortant" : normDir === "inbound" ? " entrant" : "";
        const src = data.source ? " (" + data.source + ")" : "";
        let tlText = (icons[type] || "📌") + " " + (labels[type] || type) + dir + src;
        if (type === "email" && data.subject) {
          tlText += " — " + String(data.subject).substring(0, 80);
          if (data.emailVia) tlText += " [" + data.emailVia + "]";
        } else if (parsedCaller) {
          tlText += " — " + parsedCaller;
        } else if (data.note) {
          tlText += " — " + String(data.note).substring(0, 100);
        } else if (cleanContent && type !== "call") {
          tlText += " — " + cleanContent.substring(0, 100);
        }
        if (type === "call" && data.duration) {
          const durSec = parseInt(data.duration, 10) || 0;
          if (durSec > 0) tlText += " [" + Math.floor(durSec / 60) + "m" + String(durSec % 60).padStart(2, "0") + "s]";
        } else if (type === "call" && parsedDuration) {
          tlText += " [" + parsedDuration + "]";
        }
        if (type === "call" && parsedRecordingUrl) tlText += " 🎙";
        if (type === "call" && data.transcription) tlText += " 📄";

        const timelineEntry = {
          text: tlText,
          date: new Date(commDateIso).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
          color: type === "call" ? "#34d399" : type === "sms" ? "#60a5fa" : type === "email" ? "#f59e0b" : "#a78bfa"
        };

        const commEntry = {
          type: type,
          direction: normDir || null,
          content: cleanContent || null,
          duration: data.duration ? parseInt(data.duration, 10) || null : null,
          source: data.source || null,
          date: commDateIso,
          createdAt: now,
          recordingUrl: parsedRecordingUrl || null,
          transcription: data.transcription || null,
          note: data.note || null,
          callTags: data.callTags || null,
          caller: parsedCaller || null,
          subject: data.subject || null,
          emailFrom: data.emailFrom || null,
          emailTo: data.emailTo || null,
          emailVia: data.emailVia || null
        };

        await db.collection("leads").doc(leadId).update({
          timeline_history: (existing.timeline_history || []).concat([timelineEntry]),
          communications: (existing.communications || []).concat([commEntry]),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
          lastContactType: type,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        result = { leadId, type };
        console.log("onWebhookInbox [lead_activity]: " + type + " on " + leadId);
      }

      // ─── LEAD CREATE ───
      else if (action === "lead_create") {
        if (!data.nom || !data.email) {
          await snap.ref.update({ status: "error", error: "nom and email required" });
          return null;
        }
        const existing = await findLead(data.email, data.telephone);
        if (existing) {
          // ─── RE-OPTIN : update lead existant pour Leads Live ───
          // On ne recrée jamais de doublon, peu importe la source d'origine du lead
          // (webinar_import, bigin_import, migration_suivi_client inclus). On force
          // le statut à 'nouveau' pour que le setter le retraite, et on sauvegarde
          // l'ancien statut dans previousStatus pour affichage UI ("Avant : disqualifié").
          // assignedTo : si vide (cas typique des leads imports) → laissé vide pour
          // que le round-robin frontend l'attribue comme un vrai nouveau lead.
          // S'il était attribué, on respecte l'attribution historique.
          try {
            const existingDoc = await db.collection("leads").doc(existing.id).get();
            const existingData = existingDoc.exists ? existingDoc.data() : {};
            const typeLabelsRe = { vsl_elite: "VSL Élite", self_booking: "Self Booking", webinaire: "Webinaire", webinar: "Webinaire" };
            const typeRe = data.type || existingData.type || "vsl_elite";

            const prevStatus = existingData.status || "nouveau";
            const STATUS_LABELS = {
              nouveau: "Nouveau", appele: "Appelé", decroche: "Décroché",
              messagerie: "Messagerie", nrp1: "NRP 1", nrp2: "NRP 2", nrp3: "NRP 3",
              faux_numero: "Faux numéro", follow_up_pm: "Follow Up PM", set: "SET",
              rdv_pose: "RDV posé", pas_interesse: "Pas intéressé",
              disqualifie: "Disqualifié", poubelle: "Poubelle", client: "Client"
            };
            const prevStatusLabel = STATUS_LABELS[prevStatus] || prevStatus;

            const tlText = "🔄 Re-optin " + (typeLabelsRe[typeRe] || typeRe) + " (déjà CRM)" +
                           (data.source ? " — " + data.source : "") +
                           (prevStatus !== "nouveau" ? " · Avant : " + prevStatusLabel : "");
            const newTimeline = (existingData.timeline_history || []).concat([{
              text: tlText,
              date: fmtNow(),
              color: "#fb923c"
            }]);

            const updatePayload = {
              status:           "nouveau",
              previousStatus:   prevStatus !== "nouveau" ? prevStatus : (existingData.previousStatus || null),
              lastOptinAt:      admin.firestore.FieldValue.serverTimestamp(),
              lastOptinSource:  data.source || "webhook",
              lastOptinType:    typeRe,
              updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
              timeline_history: newTimeline
            };

            const importSources = ["webinar_import", "bigin_import", "migration_suivi_client"];
            const isImport = importSources.indexOf(existingData.source) >= 0;
            if (isImport && !existingData.assignedTo) {
              updatePayload.assignedTo = "";
            }

            await db.collection("leads").doc(existing.id).update(updatePayload);
          } catch (e) {
            console.error("onWebhookInbox [lead_create-reoptin] update error:", e.message);
          }
          await snap.ref.update({
            status: "duplicate",
            existingLeadId: existing.id,
            processedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          setTimeout(async () => { try { await snap.ref.delete(); } catch (e) {} }, 60000);
          return null;
        }

        const stage = data.stage || "lead";
        const newLead = {
          nom: data.nom.trim(),
          email: data.email.trim().toLowerCase(),
          telephone: (data.telephone || "").replace(/\s+/g, ""),
          type: data.type || "vsl_elite",
          stage: stage,
          status: S2S[stage] || "nouveau",
          assignedTo: "",
          tags: [],
          notesHistory: [],
          timeline_history: [{ text: "✨ Lead créé via webhook" + (data.source ? " (" + data.source + ")" : ""), date: fmtNow(), color: "#a78bfa" }],
          communications: [],
          source: data.source || "webhook",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (data.extraFields && typeof data.extraFields === "object") {
          Object.keys(data.extraFields).forEach((k) => {
            if (!["id", "createdAt", "timeline_history", "notesHistory"].includes(k)) newLead[k] = data.extraFields[k];
          });
        }

        const ref = await db.collection("leads").add(newLead);
        result = { leadId: ref.id };
        console.log("onWebhookInbox [lead_create]: " + ref.id);
      }

      // ─── SEND EMAIL ───
      else if (action === "send_email") {
        if (!data.emailKey || !data.to || !data.subject) {
          await snap.ref.update({ status: "error", error: "emailKey, to, and subject required" });
          return null;
        }

        const auth = await getEmailAuthClient(data.emailKey);
        if (!auth) {
          await snap.ref.update({ status: "error", error: "Email account not connected: " + data.emailKey });
          return null;
        }

        const gmail = google.gmail({ version: "v1", auth: auth.client });
        const senderEmail = auth.senderEmail;

        const senderName = data.senderName || "";
        const signatures = {
          strategie: function(name) {
            return "\n\n\nCordialement,\n" + name + "\n\nExpert stratégique\nAccompagnement des dirigeants en Francophonie\n➖➖➖➖➖➖➖➖➖➖➖➖\n👩‍🎓 Adrien&Emily\n🏢 Alteore\n➖➖➖➖➖➖➖➖➖➖➖➖\nNotre mission : Accompagner les dirigeants à obtenir des entreprises rentables et pérennes en augmentant leur trésorerie, en multipliant leurs bénéfices et en leur faisant gagner du temps pour eux et leurs proches, en seulement 3 à 12 mois.\nNotre vision : Créer un monde où chaque dirigeant peut vivre sereinement de son activité, tout en ayant la liberté de profiter de la vie et de construire un avenir durable pour ses proches et son entreprise.\nwww.adrienemily.com\nwww.alteore.com\n➖➖➖➖➖➖➖➖➖➖➖➖\n\n📧 strategie@adrienemily.com";
          },
          coaching: function(name) {
            return "\n\n\nCordialement,\n" + name + "\n\nCoach / Formateur et Mentor\nAccompagnement des dirigeants en Francophonie\n➖➖➖➖➖➖➖➖➖➖➖➖\n👩‍🎓 Adrien&Emily\n🏢 Alteore\n➖➖➖➖➖➖➖➖➖➖➖➖\nNotre mission : Accompagner les dirigeants à obtenir des entreprises rentables et pérennes en augmentant leur trésorerie, en multipliant leurs bénéfices et en leur faisant gagner du temps pour eux et leurs proches, en seulement 3 à 12 mois.\nNotre vision : Créer un monde où chaque dirigeant peut vivre sereinement de son activité, tout en ayant la liberté de profiter de la vie et de construire un avenir durable pour ses proches et son entreprise.\nwww.adrienemily.com\nwww.alteore.com\n➖➖➖➖➖➖➖➖➖➖➖➖\n\n📧 coaching@adrienemily.com";
          },
          contact: function(name) {
            return "\n\n\nCordialement,\n" + name + "\n\nCEO 🏢 Ambitio Corp / Alteore\nAccompagnement des dirigeants en Francophonie\n➖➖➖➖➖➖➖➖➖➖➖➖\n👩‍🎓 Adrien&Emily\n➖➖➖➖➖➖➖➖➖➖➖➖\nNotre mission : Accompagner les dirigeants à obtenir des entreprises rentables et pérennes en augmentant leur trésorerie, en multipliant leurs bénéfices et en leur faisant gagner du temps pour eux et leurs proches, en seulement 3 à 12 mois.\nNotre vision : Créer un monde où chaque dirigeant peut vivre sereinement de son activité, tout en ayant la liberté de profiter de la vie et de construire un avenir durable pour ses proches et son entreprise.\nwww.adrienemily.com\nwww.alteore.com\n➖➖➖➖➖➖➖➖➖➖➖➖\n\n📧 contact@adrienemily.com\n📧 contact@alteore.com";
          }
        };

        const sigFn = signatures[data.emailKey];
        const signature = sigFn ? sigFn(senderName) : "";
        const fullBody = (data.body || "") + signature;

        const fromHeader = senderName ? senderName + " <" + senderEmail + ">" : senderEmail;
        const rawEmail = buildRawEmail(fromHeader, data.to, data.subject, fullBody, [
          "Disposition-Notification-To: " + senderEmail,
          "X-Confirm-Reading-To: " + senderEmail,
          "Return-Receipt-To: " + senderEmail
        ]);

        const sendParams = { userId: "me", requestBody: { raw: rawEmail } };
        if (data.threadId) sendParams.requestBody.threadId = data.threadId;

        const resp = await gmail.users.messages.send(sendParams);
        console.log("onWebhookInbox [send_email]: sent from " + senderEmail + " to " + data.to + " id=" + resp.data.id);

        if (data.leadId) {
          const leadDoc = await db.collection("leads").doc(data.leadId).get();
          if (leadDoc.exists) {
            const existing = leadDoc.data();
            const now = fmtNow();
            const timelineEntry = {
              text: "✉️ Email sortant — " + String(data.subject).substring(0, 80) + " [" + senderEmail + "]",
              date: now,
              color: "#f59e0b"
            };
            const commEntry = {
              type: "email",
              direction: "outbound",
              content: data.body || "",
              subject: data.subject,
              emailFrom: senderEmail,
              emailTo: data.to,
              emailVia: senderEmail,
              source: "app",
              date: new Date().toISOString(),
              createdAt: now,
              gmailMessageId: resp.data.id || null
            };
            await db.collection("leads").doc(data.leadId).update({
              timeline_history: (existing.timeline_history || []).concat([timelineEntry]),
              communications: (existing.communications || []).concat([commEntry]),
              lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
              lastContactType: "email",
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }

        result = { messageId: resp.data.id, from: senderEmail, to: data.to };
      }

      // ─── SEND SMS ───
      else if (action === "send_sms") {
        if (!data.to || !data.body) {
          await snap.ref.update({ status: "error", error: "to and body required" });
          return null;
        }
        const smsResult = await sendSms(data.to, data.body);
        if (smsResult.error) {
          await snap.ref.update({ status: "error", error: smsResult.error });
          return null;
        }
        if (data.leadId) {
          const leadDoc = await db.collection("leads").doc(data.leadId).get();
          if (leadDoc.exists) {
            const existing = leadDoc.data();
            const now = fmtNow();
            const tlEntry = { text: "💬 SMS sortant — " + String(data.body).substring(0, 80), date: now, color: "#60a5fa" };
            const commEntry = { type: "sms", direction: "outbound", content: data.body, source: "twilio", date: new Date().toISOString(), createdAt: now };
            await db.collection("leads").doc(data.leadId).update({
              timeline_history: (existing.timeline_history || []).concat([tlEntry]),
              communications: (existing.communications || []).concat([commEntry]),
              lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
              lastContactType: "sms",
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
        result = { sid: smsResult.sid, to: data.to };
        console.log("onWebhookInbox [send_sms]: sent to " + data.to + " sid=" + smsResult.sid);
      }

      // ─── GOCARDLESS EVENT ───
      else if (action === "gocardless_event") {
        const eventType = data.gcEventType || "";
        const gcAction = data.gcAction || "";
        const links = data.gcLinks || {};

        if (data.gcEventId) {
          const dupSnap = await db.collection("webhook_inbox")
            .where("gcEventId", "==", data.gcEventId)
            .where("status", "==", "done")
            .limit(1).get();
          if (!dupSnap.empty) {
            await snap.ref.update({ status: "done", result: { skipped: "duplicate event", gcEventId: data.gcEventId } });
            return null;
          }
        }

        let paymentRef = null;
        let matchedBy = null;

        if (links.billing_request) {
          const q = await db.collection("payments")
            .where("gcBillingRequestId", "==", links.billing_request).limit(1).get();
          if (!q.empty) { paymentRef = q.docs[0].ref; matchedBy = "billing_request"; }
        }
        if (!paymentRef && links.mandate) {
          const q = await db.collection("payments")
            .where("gcMandateId", "==", links.mandate).limit(1).get();
          if (!q.empty) { paymentRef = q.docs[0].ref; matchedBy = "mandate"; }
        }
        if (!paymentRef && links.subscription) {
          const q = await db.collection("payments")
            .where("gcSubscriptionId", "==", links.subscription).limit(1).get();
          if (!q.empty) { paymentRef = q.docs[0].ref; matchedBy = "subscription"; }
        }
        if (!paymentRef && links.payment) {
          const q = await db.collection("payments")
            .where("gcPaymentId", "==", links.payment).limit(1).get();
          if (!q.empty) { paymentRef = q.docs[0].ref; matchedBy = "payment"; }
        }

        /* ═══ MISE À JOUR DOC PAYMENTS (cycle de vie mandate/sub) ═══ */
        if (paymentRef) {
          const update = {
            gcLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          };

          if (eventType === "billing_requests" && gcAction === "fulfilled") {
            if (links.customer) update.gcCustomerId = links.customer;
            if (links.mandate_request_mandate) update.gcMandateId = links.mandate_request_mandate;
            update.status = "mandate_active";
            update.mandateCreatedAt = admin.firestore.FieldValue.serverTimestamp();
          } else if (eventType === "mandates") {
            if (["created", "submitted", "active"].indexOf(gcAction) >= 0) {
              if (links.mandate) update.gcMandateId = links.mandate;
              if (links.customer) update.gcCustomerId = links.customer;
              update.status = "mandate_active";
              if (gcAction === "created") update.mandateCreatedAt = admin.firestore.FieldValue.serverTimestamp();
            } else if (["cancelled", "failed", "expired"].indexOf(gcAction) >= 0) {
              update.status = "mandate_failed";
              update.mandateFailedReason = gcAction;
            }
          } else if (eventType === "payments") {
            if (gcAction === "paid_out") {
              update.lastPaymentEvent = { action: gcAction, paymentId: links.payment || null, at: new Date().toISOString() };
              /* Pas d'incrémentation paidCount ici — c'est fait dans createInvoiceFromGcPayment */
            } else if (gcAction === "confirmed") {
              update.lastPaymentEvent = { action: gcAction, paymentId: links.payment || null, at: new Date().toISOString() };
            } else if (["failed", "cancelled", "chargeback_settled", "customer_approval_denied"].indexOf(gcAction) >= 0) {
              update.lastPaymentFailure = { action: gcAction, paymentId: links.payment || null, at: new Date().toISOString() };
            }
          } else if (eventType === "subscriptions") {
            if (gcAction === "finished") update.status = "completed";
            else if (gcAction === "cancelled") update.status = "cancelled";
          }

          await paymentRef.update(update);
          console.log("onWebhookInbox [gocardless_event]: " + eventType + "." + gcAction + " → payment " + paymentRef.id + " (via " + matchedBy + ")");
        }

        /* ═══ CRÉATION FACTURE — DÉCLENCHEUR UNIQUE : payments.paid_out ═══
           Règle simple : 1 paiement GC paid_out = 1 facture team, créée
           IMMÉDIATEMENT à la date du paiement, marquée paid d'emblée.
           
           Idempotence : si une facture avec ce gcPaymentId existe déjà
           (non archivée), on skip. Zéro doublon possible.
           
           Pas de matching montant TTC, pas de cron en avance, pas de
           distinction one-shot/abonnement : la même logique pour tout.
           ════════════════════════════════════════════════════════════════ */
        if (eventType === "payments" && gcAction === "paid_out" && links.payment) {
          try {
            const created = await createInvoiceFromGcPayment(links.payment, paymentRef);
            result = {
              eventType: eventType,
              gcAction: gcAction,
              gcPaymentId: links.payment,
              invoiceCreation: created,
            };
            console.log("onWebhookInbox [gocardless_event paid_out]: " + JSON.stringify(created));
          } catch (e) {
            console.error("onWebhookInbox [gocardless_event paid_out]: invoice creation failed for " + links.payment + ": " + e.message);
            result = {
              eventType: eventType,
              gcAction: gcAction,
              gcPaymentId: links.payment,
              invoiceCreation: { success: false, error: e.message },
            };
            /* Alerte explicite pour traitement manuel */
            try {
              await db.collection('_alerts').doc('billing').collection('items').add({
                type: 'invoice_creation_failed_on_paid_out',
                severity: 'warning',
                gcPaymentId: links.payment,
                gcMandateId: links.mandate || null,
                error: String(e.message || e).substring(0, 500),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                resolved: false,
              });
            } catch (_) {}
          }
        } else if (!paymentRef) {
          result = { skipped: true, reason: "no matching payment doc and not a paid_out event", eventType: eventType, gcAction: gcAction };
        } else {
          result = { paymentDocId: paymentRef.id, matchedBy: matchedBy, eventType: eventType, gcAction: gcAction };
        }
      }

      // ─── SIGNATURE OTP — SEND ───
      else if (action === "signature_otp_send") {
        const reqId = data.signatureRequestId;
        const phone = data.phone;

        if (!reqId || !phone) {
          await snap.ref.update({ status: "error", error: "signatureRequestId et phone requis" });
          return null;
        }

        const reqSnap = await db.collection("signature_requests").doc(reqId).get();
        if (!reqSnap.exists) {
          await snap.ref.update({ status: "error", error: "signature_request introuvable" });
          return null;
        }
        const reqData = reqSnap.data();
        if (reqData.signedAt || reqData.status === "signed") {
          await snap.ref.update({ status: "error", error: "Contrat déjà signé" });
          return null;
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await db.collection("signature_requests").doc(reqId).update({
          otpCode: code,
          otpExpiresAt: expiresAt,
          otpSentAt: admin.firestore.FieldValue.serverTimestamp(),
          otpVerified: admin.firestore.FieldValue.delete(),
          otpError: admin.firestore.FieldValue.delete()
        });

        const twilioClient = await getSignatureTwilioClient();
        const fromNumber = await getSignatureFromNumber();

        await twilioClient.messages.create({
          from: fromNumber,
          to: normalizePhoneE164(phone),
          body: "Votre code de signature Ambitio : " + code + "\nValable 10 minutes."
        });

        result = { sent: true };
        console.log("onWebhookInbox [signature_otp_send]: code envoyé pour " + reqId);
      }

      // ─── SIGNATURE OTP — VERIFY ───
      else if (action === "signature_otp_verify") {
        const reqId = data.signatureRequestId;
        const code = data.code;

        if (!reqId || !code) {
          await snap.ref.update({ status: "error", error: "signatureRequestId et code requis" });
          return null;
        }

        const reqSnap = await db.collection("signature_requests").doc(reqId).get();
        if (!reqSnap.exists) {
          await snap.ref.update({ status: "error", error: "signature_request introuvable" });
          return null;
        }

        const reqData = reqSnap.data();
        const storedCode = reqData.otpCode;
        const expiresAt = reqData.otpExpiresAt;

        if (!storedCode || !expiresAt) {
          await db.collection("signature_requests").doc(reqId).update({
            otpError: "Aucun code en attente. Cliquez sur \"Recevoir le code\"."
          });
          result = { verified: false };
        } else {
          const expiry = expiresAt.toDate ? expiresAt.toDate() : new Date(expiresAt);
          const expired = new Date() > expiry;
          const match = String(code).trim() === String(storedCode).trim();

          if (expired) {
            await db.collection("signature_requests").doc(reqId).update({
              otpError: "Code expiré. Demandez un nouveau code.",
              otpCode: admin.firestore.FieldValue.delete(),
              otpExpiresAt: admin.firestore.FieldValue.delete()
            });
            result = { verified: false, reason: "expired" };
          } else if (!match) {
            await db.collection("signature_requests").doc(reqId).update({
              otpError: "Code incorrect. Vérifiez et réessayez."
            });
            result = { verified: false, reason: "wrong_code" };
          } else {
            await db.collection("signature_requests").doc(reqId).update({
              otpVerified: true,
              otpVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              otpCode: admin.firestore.FieldValue.delete(),
              otpExpiresAt: admin.firestore.FieldValue.delete()
            });
            result = { verified: true };
            console.log("onWebhookInbox [signature_otp_verify]: ✅ vérifié pour " + reqId);
          }
        }
      }

      // ─── SIGNATURE COMPLETED (passage en client + Make automation) ───
      else if (action === "signature_completed") {
        try {
          const reqId = data.signatureRequestId;
          if (!reqId) {
            console.warn("[signature_completed] no signatureRequestId");
          } else {
            const reqDoc = await db.collection("signature_requests").doc(reqId).get();
            if (!reqDoc.exists) {
              console.warn("[signature_completed] request not found:", reqId);
            } else {
              const reqData = reqDoc.data();

              // Garde-fou : on ne traite que les signatures finales.
              // Empêche un éventuel doc webhook_inbox forgé avec un reqId
              // d'un contrat non-encore-signé de déclencher la promotion
              // client + le webhook Make avec des données vides.
              if (reqData.status !== "signed") {
                console.warn("[signature_completed] request not signed yet, skip:", reqId, "status=", reqData.status);
              } else {

              // ═══ PROMOTION EN CLIENT ═══
              // Indépendant de la config Make. Toute signature finale d'un lead
              // lié au CRM le passe en client (stage closed_won + status:client + isClient).
              if (reqData.leadId && !reqData.clientPromoted) {
                try {
                  const leadRef = db.collection("leads").doc(reqData.leadId);
                  const leadSnap = await leadRef.get();
                  if (leadSnap.exists) {
                    const ld = leadSnap.data();
                    const newStage = (ld.type === "self_booking") ? "closed_won_self" : "closed_won_setting";
                    const upd = {
                      stage: newStage,
                      status: "client",
                      isClient: true,
                      clientFromSignature: true,
                      clientFromTemplateId: reqData.templateId || null,
                      clientFromSignatureRequestId: reqId,
                      updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    if (!ld.isClient || !ld.clientSince) {
                      upd.clientSince = admin.firestore.FieldValue.serverTimestamp();
                    }
                    const tlNow = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
                    const tplName = reqData.templateName || "Contrat";
                    upd.timeline_history = (ld.timeline_history || []).concat([{
                      text: "🏆 Contrat signé — devenu client (" + tplName + ")",
                      date: tlNow,
                      color: "#fbbf24"
                    }]);
                    await leadRef.update(upd);
                    await db.collection("signature_requests").doc(reqId).update({
                      clientPromoted: true,
                      clientPromotedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log("[signature_completed] ✅ lead promu client :", reqData.leadId, "→", newStage);
                  } else {
                    console.warn("[signature_completed] leadId pointé mais lead introuvable :", reqData.leadId);
                  }
                } catch (e) {
                  console.error("[signature_completed] promotion client error:", e.message);
                }
              }

              if (reqData.automationStatus === "sent" || reqData.automationStatus === "skipped") {
                console.log("[signature_completed] already processed (Make), skip:", reqId);
              } else {
                const tplId = reqData.templateId;
                const tplDoc = tplId ? await db.collection("signature_templates").doc(tplId).get() : null;
                const tpl = (tplDoc && tplDoc.exists) ? tplDoc.data() : {};

                if (!tpl.automationEnabled || !tpl.automationWebhookUrl) {
                  await db.collection("signature_requests").doc(reqId).update({
                    automationStatus: "skipped",
                    automationProcessedAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                } else {
                  const fv = reqData.fieldValues || {};
                  const fullNameRaw = (fv.nom_prenom || reqData.clientName || "").trim();
                  const parts = fullNameRaw.split(/\s+/);
                  const firstName = parts[0] || "";
                  const lastName = parts.slice(1).join(" ") || "";

                  let leadData = null;
                  if (reqData.leadId) {
                    try {
                      const leadDoc = await db.collection("leads").doc(reqData.leadId).get();
                      if (leadDoc.exists) {
                        const ld = leadDoc.data();
                        leadData = {
                          id: leadDoc.id,
                          assignedTo: ld.assignedTo || null,
                          source: ld.source || null,
                          utm: ld.utm || null,
                          tags: ld.tags || [],
                          stage: ld.stage || null,
                          status: ld.status || null,
                          ca: ld.ca || ld.chiffreAffaires || null,
                          secteur: ld.secteur || null,
                          createdAt: ld.createdAt && ld.createdAt.toDate ? ld.createdAt.toDate().toISOString() : null
                        };
                      }
                    } catch (e) { console.warn("[signature_completed] lead fetch error:", e.message); }
                  }

                  const payload = {
                    event: "signature_completed",
                    test: false,
                    signatureRequestId: reqId,
                    templateId: tplId,
                    templateName: tpl.name || reqData.templateName || "",
                    client: {
                      fullName: fullNameRaw,
                      firstName: firstName,
                      lastName: lastName,
                      email: (fv.email || reqData.clientEmail || "").toLowerCase(),
                      phone: fv.telephone || reqData.clientPhone || "",
                      adresse: fv.adresse || ""
                    },
                    entreprise: {
                      name: fv.entreprise || "",
                      type: fv.type_entreprise || "",
                      siret: fv.siret || "",
                      siegeSocial: fv.siege_social || ""
                    },
                    leadId: reqData.leadId || null,
                    lead: leadData,
                    signedAt: reqData.signedAt && reqData.signedAt.toDate
                      ? reqData.signedAt.toDate().toISOString()
                      : new Date().toISOString(),
                    fieldValues: fv,
                    signers: (reqData.signers || []).map(function(s){ return {
                      name: s.name || "",
                      email: s.email || "",
                      phone: s.phone || "",
                      role: s.role || "",
                      status: s.status || "",
                      signedAtLocal: s.signedAtLocal || ""
                    };}),
                    metadata: {
                      automationNote: tpl.automationNote || "",
                      certificateId: reqData.certificateId || null,
                      documentHash: reqData.documentHash || null
                    }
                  };

                  const fetch = require("node-fetch");
                  const url = tpl.automationWebhookUrl;
                  let lastError = null;
                  let success = false;
                  let httpStatus = 0;
                  let attemptCount = 0;
                  const delays = [0, 1000, 3000, 9000];
                  for (let i = 0; i < delays.length; i++) {
                    if (delays[i] > 0) await new Promise(function(r){ setTimeout(r, delays[i]); });
                    attemptCount++;
                    try {
                      const resp = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                        timeout: 15000
                      });
                      httpStatus = resp.status;
                      if (resp.ok) { success = true; break; }
                      lastError = "HTTP " + resp.status + " " + resp.statusText;
                    } catch (e) {
                      lastError = e.message;
                    }
                  }

                  const updatePayload = {
                    automationStatus: success ? "sent" : "failed",
                    automationProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
                    automationHttpStatus: httpStatus,
                    automationAttempts: attemptCount
                  };
                  if (success) {
                    updatePayload.automationLastError = admin.firestore.FieldValue.delete();
                  } else {
                    updatePayload.automationLastError = lastError || "unknown";
                  }
                  await db.collection("signature_requests").doc(reqId).update(updatePayload);

                  console.log("[signature_completed]", success ? "✅" : "❌", reqId,
                              "→", url, success ? "OK ("+attemptCount+" tentatives)" : lastError);
                }
              }
              }
            }
          }
        } catch (e) {
          console.error("[signature_completed] handler error:", e.message);
          if (data.signatureRequestId) {
            try {
              await db.collection("signature_requests").doc(data.signatureRequestId).update({
                automationStatus: "failed",
                automationLastError: e.message,
                automationProcessedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            } catch (e2) {}
          }
        }
        await snap.ref.update({
          status: "processed",
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        setTimeout(async function(){ try { await snap.ref.delete(); } catch (e) {} }, 60000);
        return null;
      }

      // ─── SIGNATURE RESEND ───
      else if (action === "signature_resend") {
        // Multi-signataire : si data.targetSignerIndex est fourni, on cible
        // signers[targetIndex]. Sinon retro-compat avec clientPhone top-level.
        const reqId = data.signatureRequestId;
        if (!reqId) {
          await snap.ref.update({ status: "error", error: "signatureRequestId requis" });
          return null;
        }
        const reqSnap = await db.collection("signature_requests").doc(reqId).get();
        if (!reqSnap.exists) {
          await snap.ref.update({ status: "error", error: "signature_request introuvable" });
          return null;
        }
        const reqData = reqSnap.data();
        if (reqData.signedAt || reqData.status === "signed") {
          await snap.ref.update({ status: "error", error: "Contrat deja signe, renvoi inutile" });
          return null;
        }
        let targetPhone, targetName, targetToken, targetIdx;
        if (typeof data.targetSignerIndex === "number"
            && Array.isArray(reqData.signers)
            && reqData.signers[data.targetSignerIndex]) {
          targetIdx = data.targetSignerIndex;
          const s = reqData.signers[targetIdx];
          targetPhone = s.phone;
          targetName = s.name || "le client";
          targetToken = s.token;
        } else if (Array.isArray(reqData.signers) && reqData.signers.length && reqData.signers[0]) {
          targetIdx = 0;
          const s = reqData.signers[0];
          targetPhone = s.phone;
          targetName = s.name || "le client";
          targetToken = s.token;
        } else {
          targetIdx = 0;
          targetPhone = reqData.clientPhone;
          targetName = reqData.clientName || "le client";
          targetToken = reqData.token;
        }
        if (!targetPhone) {
          await snap.ref.update({ status: "error", error: "phone manquant pour le signataire cible" });
          return null;
        }
        let signUrl;
        if (targetToken) {
          signUrl = "https://team.alteore.com/sign.html?t=" + targetToken;
        } else if (reqData.signUrl) {
          signUrl = reqData.signUrl;
        } else {
          await snap.ref.update({ status: "error", error: "Impossible de construire URL (token et signUrl absents)" });
          return null;
        }
        const tplName = reqData.templateName || "votre contrat";
        const isCosigner = targetIdx > 0;
        const smsBody = isCosigner
          ? ("Bonjour " + targetName + ", le premier signataire a signe " + tplName + ". A votre tour de signer : " + signUrl)
          : ("Bonjour " + targetName + ", voici votre lien pour signer votre contrat Ambitio :\n" + signUrl);
        const twilioClient = await getSignatureTwilioClient();
        const fromNumber = await getSignatureFromNumber();
        await twilioClient.messages.create({
          from: fromNumber,
          to: normalizePhoneE164(targetPhone),
          body: smsBody
        });
        const events = reqData.events || [];
        events.push({
          type: "resent",
          targetSignerIndex: targetIdx,
          targetName: targetName,
          date: new Date().toISOString()
        });
        await db.collection("signature_requests").doc(reqId).update({
          events: events,
          resentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        result = { resent: true, phone: targetPhone, targetSignerIndex: targetIdx };
        console.log("onWebhookInbox [signature_resend]: SMS renvoye pour " + reqId + " -> " + targetPhone + " (signer " + (targetIdx + 1) + ")");
      }

      else {
        await snap.ref.update({ status: "error", error: "Unknown action: " + action });
        return null;
      }

      // Done — update status then delete after 60s
      await snap.ref.update({ status: "done", result: result, processedAt: admin.firestore.FieldValue.serverTimestamp() });
      setTimeout(async () => { try { await snap.ref.delete(); } catch (e) {} }, 60000);

    } catch (e) {
      console.error("onWebhookInbox error:", e.message);
      try { await snap.ref.update({ status: "error", error: e.message }); } catch (e2) {}
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   7. EMAIL AUTH — OAUTH EXCHANGE
   ═══════════════════════════════════════════════════ */

exports.onEmailAuthRequest = functions.firestore
  .document("email_auth_requests/{requestId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const code = data.code;
    const emailKey = data.emailKey;
    const redirectUri = data.redirectUri;

    if (!code || !emailKey) {
      await snap.ref.update({ status: "error", error: "Missing code or emailKey" });
      return null;
    }

    try {
      const conf = await getOAuthConfig();
      const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, redirectUri || conf.redirect_uri);
      const { tokens } = await client.getToken(code);

      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email || "";

      await db.collection("email_tokens").doc(emailKey).set({
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || "",
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        email: email,
        emailKey: emailKey,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await snap.ref.update({ status: "success", email: email });
      console.log("Email connected for " + emailKey + " (" + email + ")");
    } catch (e) {
      console.error("Email auth error:", e.message);
      await snap.ref.update({ status: "error", error: e.message });
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   EMAIL HELPERS
   ═══════════════════════════════════════════════════ */

async function getEmailAuthClient(emailKey) {
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection("email_tokens").doc(emailKey).get();
  if (!tokenDoc.exists) return null;
  const data = tokenDoc.data();
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret);
  client.setCredentials({
    access_token: data.accessToken,
    refresh_token: data.refreshToken
  });
  client.on("tokens", async function(t) {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) await db.collection("email_tokens").doc(emailKey).update(u);
  });
  return { client, senderEmail: data.email };
}


/* ═══════════════════════════════════════════════════
   TWILIO SMS HELPER
   ═══════════════════════════════════════════════════ */

async function sendSms(to, body) {
  try {
    const conf = await db.collection("_config").doc("twilio").get();
    if (!conf.exists) return { error: "Twilio config missing in _config/twilio" };
    const c = conf.data();
    const twilioClient = require("twilio")(c.accountSid, c.authToken);
    const params = { body: body, to: to };
    if (c.messagingServiceSid) params.messagingServiceSid = c.messagingServiceSid;
    else if (c.fromNumber) params.from = c.fromNumber;
    else return { error: "No fromNumber or messagingServiceSid in twilio config" };
    const msg = await twilioClient.messages.create(params);
    return { sid: msg.sid };
  } catch (e) {
    console.error("sendSms error:", e.message);
    return { error: e.message };
  }
}


/* ═══════════════════════════════════════════════════
   TEMPLATE / EMAIL BUILDER HELPERS
   ═══════════════════════════════════════════════════ */

function replaceTemplate(tpl, vars) {
  if (!tpl) return "";
  return tpl.replace(/\{\{(\w+)\}\}/g, function(m, k) { return vars[k] !== undefined ? vars[k] : m; });
}

function buildHtmlEmail(bodyText, subject) {
  const bodyHtml = (bodyText || "").replace(/\\n/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body style="margin:0;padding:0;background:#f4f4f8;font-family:Helvetica,Arial,sans-serif">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:30px 0"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">'
    + '<tr><td style="background:linear-gradient(135deg,#1e3a8a,#3b82f6);border-radius:16px 16px 0 0;padding:40px 40px 30px;text-align:center">'
    + '<div style="font-size:14px;font-weight:800;color:rgba(255,255,255,0.7);letter-spacing:2px;text-transform:uppercase;margin-bottom:16px">ADRIEN & EMILY</div>'
    + '<div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.3">' + (subject || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#ffffff;padding:36px 40px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">'
    + '<div style="font-size:15px;line-height:1.8;color:#374151">' + bodyHtml + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center">'
    + '<div style="font-size:12px;color:#9ca3af;line-height:1.6">'
    + '👩‍🎓 <strong style="color:#6b7280">Adrien & Emily</strong> · 🏢 <strong style="color:#6b7280">Alteore</strong><br/>'
    + 'Accompagnement des dirigeants en Francophonie<br/>'
    + '<a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a> · '
    + '<a href="https://www.alteore.com" style="color:#3b82f6;text-decoration:none">alteore.com</a>'
    + '</div></td></tr>'
    + '</table></td></tr></table></body></html>';
}

function buildRawEmail(from, to, subject, bodyText, extraHeaders) {
  const html = buildHtmlEmail(bodyText, subject);
  const lines = [
    "From: " + from,
    "To: " + to,
    "Subject: =?UTF-8?B?" + Buffer.from(subject).toString("base64") + "?=",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8"
  ];
  if (extraHeaders) extraHeaders.forEach(function(h) { lines.push(h); });
  lines.push("");
  lines.push(html);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}


/* ═══════════════════════════════════════════════════
   BOOKING HELPERS
   ═══════════════════════════════════════════════════ */

async function getBookingTypeNotifications(booking) {
  try {
    const typesDoc = await db.collection("booking_config").doc("_types").get();
    if (!typesDoc.exists) return { emailOnBook: true, smsOnBook: false, emailJ1: true, smsJ1: false, emailH1: true, smsH1: false, emailAccount: "strategie" };
    const types = typesDoc.data().list || [];
    const typeLabel = booking.typeLabel || "";
    const typeId = booking.typeId || "";
    let found = types.find(function(t) { return t.id === typeId; });
    if (!found) found = types.find(function(t) { return t.label === typeLabel; });
    if (!found) return { emailOnBook: true, smsOnBook: false, emailJ1: true, smsJ1: false, emailH1: true, smsH1: false, emailAccount: "strategie" };
    return found.notifications || {};
  } catch (e) {
    console.error("getBookingTypeNotifications error:", e.message);
    return null;
  }
}


/* ═══════════════════════════════════════════════════
   9. BOOKING CONFIRMATION
   ═══════════════════════════════════════════════════ */

exports.onBookingConfirmation = functions.firestore
  .document("bookings/{bookingId}")
  .onCreate(async (snap, context) => {
    const booking = snap.data();
    const bookingId = context.params.bookingId;

    try {
      const nf = await getBookingTypeNotifications(booking);
      if (!nf) return null;

      const emailAccount = nf.emailAccount || "strategie";
      const prospect = booking.prospect || {};
      const prenom = prospect.prenom || prospect.nom || "Client";
      const tel = prospect.telephone || prospect.tel || "";
      const email = prospect.email || "";
      const typeLabel = booking.typeLabel || "RDV";
      const dateStr = booking.date || "";
      const timeStr = booking.time || "";

      let dateDisplay = dateStr;
      try { dateDisplay = new Date(dateStr).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); } catch (e) {}

      const expertName2 = booking.personName || booking.expertName || "";
      const vars = { prenom, date: dateDisplay, time: timeStr, typeLabel, nom: prospect.nom || "", expert: expertName2 };
      const sent = {};

      const confDoc = await db.collection("_config").doc("booking_reminders").get();
      const globalTpls = confDoc.exists ? (confDoc.data().templates || {}) : {};
      const typeTpls = nf.templates || {};
      const templates = Object.assign({}, globalTpls, typeTpls);

      // ─────────────────────────────────────────────────────────────────
      // Email de confirmation prospect : DÉPLACÉ dans onBookingCreated.
      // onBookingCreated a accès au meetLink fraîchement généré par
      // events.insert, et envoie un mail enrichi (header bleu + table
      // détaillée + encart Meet vert) via _abBuildStyledEmail.
      // Conserver ce bloc ici créerait un doublon visible côté prospect.
      // SMS de confirmation : conservé ci-dessous (pas de doublon).
      // ─────────────────────────────────────────────────────────────────

      if (nf.smsOnBook && tel) {
        try {
          const smsBody = replaceTemplate(templates.confirmation_sms || "Bonjour {{prenom}}, votre RDV {{typeLabel}} est confirmé pour le {{date}} à {{time}}. À bientôt ! - Adrien&Emily", vars);
          const phoneClean = tel.replace(/\s+/g, "");
          const phoneFull = phoneClean.startsWith("+") ? phoneClean : phoneClean.startsWith("0") ? "+33" + phoneClean.slice(1) : "+" + phoneClean;
          const smsResult = await sendSms(phoneFull, smsBody);
          if (!smsResult.error) sent.confirmation_sms = true;
        } catch (e) { console.error("Booking confirmation SMS error:", e.message); }
      }

      if (Object.keys(sent).length > 0) {
        await snap.ref.update({ remindersSent: sent });
        console.log("Booking confirmation sent for " + bookingId + ": " + JSON.stringify(sent));
      }
    } catch (e) {
      console.error("Booking confirmation error:", e.message);
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   10. SCHEDULED BOOKING REMINDERS — every 15 minutes
   ═══════════════════════════════════════════════════ */

/**
 * Construit le HTML stylé d'un email de RAPPEL (J-1 / H-1) à partir du corps
 * texte issu du template, et y ajoute AUTOMATIQUEMENT l'encart Meet vert si un
 * lien de visioconférence existe sur le booking — sans dépendre d'un
 * {{meetLink}} dans le template (option A, 2026-06).
 *
 * Avant : les rappels partaient via buildRawEmail/buildHtmlEmail (HTML échappé,
 * sans header/footer Alteore, et le lien Meet n'apparaissait que si l'admin
 * avait pensé à mettre {{meetLink}} dans le template). Désormais ils utilisent
 * le même rendu stylé que l'email de confirmation (_abBuildStyledEmail) et
 * l'encart Meet est injecté d'office.
 *
 * @param {string} subject   Sujet (déjà rempli par replaceTemplate)
 * @param {string} textBody  Corps texte (déjà rempli par replaceTemplate)
 * @param {string} meetLink  Lien Meet (booking.meetLink) ou '' si absent
 * @returns {{bodyHtml:string, bodyText:string}}
 */
function _abReminderEmail(subject, textBody, meetLink) {
  // Le corps des templates de rappel est du texte (avec \n). On échappe le
  // HTML puis on convertit les sauts de ligne en <br>, pour un rendu propre
  // dans le conteneur stylé.
  const normalized = (textBody || '')
    .replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  const esc = normalized
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  const meetBlock = meetLink
    ? '<div style="margin:20px 0;padding:16px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px">'
      + '<div style="font-size:14px;font-weight:700;color:#166534;margin-bottom:6px">📹 Lien de visioconférence</div>'
      + '<a href="' + meetLink + '" style="color:#16a34a;font-size:15px;font-weight:600;text-decoration:none;word-break:break-all">' + meetLink + '</a>'
      + '<div style="font-size:12px;color:#6b7280;margin-top:6px">Cliquez à l\'heure du RDV pour rejoindre la réunion.</div>'
      + '</div>'
    : '';
  const content = '<div style="font-size:15px;line-height:1.7;color:#374151">' + esc + '</div>' + meetBlock;
  const bodyHtml = _abBuildStyledEmail(subject, content);
  // Version texte : corps + lien Meet en clair (pour les clients mail en
  // mode texte). On part du textBody d'origine, pas du HTML.
  const bodyText = normalized + (meetLink ? '\n\n📹 Lien de la visioconférence : ' + meetLink : '');
  return { bodyHtml: bodyHtml, bodyText: bodyText };
}


exports.scheduledBookingReminders = functions.pubsub
  .schedule("every 15 minutes")
  .timeZone("Europe/Paris")
  .onRun(async () => {
    try {
      const now = new Date();
      const nowMs = now.getTime();
      const todayStr = now.toISOString().split("T")[0];
      const twoDaysStr = new Date(nowMs + 48 * 60 * 60 * 1000).toISOString().split("T")[0];

      const snap = await db.collection("bookings")
        .where("date", ">=", todayStr)
        .where("date", "<=", twoDaysStr)
        .get();

      let remindersCount = 0;

      for (const doc of snap.docs) {
        const booking = doc.data();
        const bookingId = doc.id;
        const sent = booking.remindersSent || {};
        const time = booking.time || "09:00";
        if (!booking.date) continue;

        const bookingMs = new Date(booking.date + "T" + time + ":00").getTime();
        const bookingTz = booking.timezone || "Europe/Paris";
        const nowLocalStr = now.toLocaleString("en-US", { timeZone: bookingTz });
        const nowLocalMs = new Date(nowLocalStr).getTime();
        const diffMs = bookingMs - nowLocalMs;
        const diffHours = diffMs / (1000 * 60 * 60);
        if (diffHours < 0) continue;
        if (booking.status === 'cancelled') continue;

        const nf = await getBookingTypeNotifications(booking);
        if (!nf) continue;

        const emailAccount = nf.emailAccount || "strategie";
        const prospect = booking.prospect || {};
        const prenom = prospect.prenom || prospect.nom || "Client";
        const tel = prospect.telephone || prospect.tel || "";
        const email = prospect.email || "";
        const typeLabel = booking.typeLabel || "RDV";
        let dateDisplay = booking.date;
        try { dateDisplay = new Date(booking.date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); } catch (e) {}
        // ─── Lien Meet pour les rappels (FIX 2026-06) ───
        // Le lien Meet est stocké sur le document booking par
        // onBookingCreated (champ meetLink). Sans ces deux variables,
        // les templates de rappel J-1/H-1 contenant {{meetLink}} ou
        // {{meetBlock}} ressortaient vides / avec le placeholder littéral —
        // c'est l'origine du bug "pas de lien Meet dans les rappels".
        // Ces deux variables restent disponibles pour les templates SMS et
        // pour tout template email qui utiliserait explicitement {{meetLink}}.
        // Depuis l'option A (2026-06), les rappels EMAIL J-1/H-1 injectent de
        // toute façon l'encart Meet automatiquement via _abReminderEmail —
        // indépendamment de la présence de {{meetLink}} dans le template.
        const reminderMeetLink = booking.meetLink || "";
        const reminderMeetBlock = reminderMeetLink
          ? "📹 Lien de la visioconférence : " + reminderMeetLink
          : "";
        const vars = { prenom, date: dateDisplay, time, typeLabel, nom: prospect.nom || "", expert: booking.personName || booking.expertName || "", meetLink: reminderMeetLink, meetBlock: reminderMeetBlock };

        const confDoc2 = await db.collection("_config").doc("booking_reminders").get();
        const globalTpls2 = confDoc2.exists ? (confDoc2.data().templates || {}) : {};
        const typeTpls2 = nf.templates || {};
        const templates = Object.assign({}, globalTpls2, typeTpls2);

        if (diffHours >= 23 && diffHours <= 25) {
          if (nf.emailJ1 !== false && email && !sent.j1_email) {
            try {
              const subject = replaceTemplate(templates.j1_email_subject || "Rappel : votre RDV demain — {{typeLabel}}", vars);
              const body = replaceTemplate(templates.j1_email_body || "Bonjour {{prenom}},\n\nPetit rappel : votre RDV {{typeLabel}} est prévu demain à {{time}}.\n\nÀ demain !", vars);
              // Rendu stylé + encart Meet auto (option A). reminderMeetLink est
              // défini plus haut depuis booking.meetLink.
              const mail = _abReminderEmail(subject, body, reminderMeetLink);
              const r = await _abSendEmail({ accountKey: emailAccount, to: email, subject: subject, bodyHtml: mail.bodyHtml, bodyText: mail.bodyText });
              sent.j1_email = true; // at-most-once : marqué dès la tentative (anti-boucle)
              try { await doc.ref.update({ "remindersSent.j1_email": true }); }
              catch (e2) { console.error("persist j1_email error:", e2.message); }
              if (!r.ok) console.error("J-1 email send failed:", r.error);
            } catch (e) { console.error("J-1 email error:", e.message); }
          }
          if (nf.smsJ1 !== false && tel && !sent.j1_sms) {
            try {
              const smsBody = replaceTemplate(templates.j1_sms || "Rappel : votre RDV {{typeLabel}} est demain à {{time}}. À demain ! - Adrien&Emily", vars);
              const phoneFull = tel.replace(/\s+/g, "").startsWith("+") ? tel.replace(/\s+/g, "") : "+33" + tel.replace(/\s+/g, "").replace(/^0/, "");
              const r = await sendSms(phoneFull, smsBody);
              sent.j1_sms = true; // at-most-once : marqué dès la tentative
              try { await doc.ref.update({ "remindersSent.j1_sms": true }); }
              catch (e2) { console.error("persist j1_sms error:", e2.message); }
              if (r.error) console.error("J-1 SMS send failed:", r.error);
            } catch (e) { console.error("J-1 SMS error:", e.message); }
          }
          remindersCount++;
        }

        if (diffHours >= 0.75 && diffHours <= 1.25) {
          if (nf.emailH1 !== false && email && !sent.h1_email) {
            try {
              const subject = replaceTemplate(templates.h1_email_subject || "Rappel : votre RDV dans 1h — {{typeLabel}}", vars);
              const body = replaceTemplate(templates.h1_email_body || "Bonjour {{prenom}},\n\nVotre RDV {{typeLabel}} commence dans 1h ({{time}}).\n\nÀ tout de suite !", vars);
              // Rendu stylé + encart Meet auto (option A).
              const mail = _abReminderEmail(subject, body, reminderMeetLink);
              const r = await _abSendEmail({ accountKey: emailAccount, to: email, subject: subject, bodyHtml: mail.bodyHtml, bodyText: mail.bodyText });
              sent.h1_email = true; // at-most-once : marqué dès la tentative
              try { await doc.ref.update({ "remindersSent.h1_email": true }); }
              catch (e2) { console.error("persist h1_email error:", e2.message); }
              if (!r.ok) console.error("H-1 email send failed:", r.error);
            } catch (e) { console.error("H-1 email error:", e.message); }
          }
          if (nf.smsH1 !== false && tel && !sent.h1_sms) {
            try {
              const smsBody = replaceTemplate(templates.h1_sms || "Votre RDV {{typeLabel}} commence dans 1h ({{time}}). À tout de suite ! - Adrien&Emily", vars);
              const phoneFull = tel.replace(/\s+/g, "").startsWith("+") ? tel.replace(/\s+/g, "") : "+33" + tel.replace(/\s+/g, "").replace(/^0/, "");
              const r = await sendSms(phoneFull, smsBody);
              sent.h1_sms = true; // at-most-once : marqué dès la tentative
              try { await doc.ref.update({ "remindersSent.h1_sms": true }); }
              catch (e2) { console.error("persist h1_sms error:", e2.message); }
              if (r.error) console.error("H-1 SMS send failed:", r.error);
            } catch (e) { console.error("H-1 SMS error:", e.message); }
          }
          remindersCount++;
        }

        try {
          if (JSON.stringify(sent) !== JSON.stringify(booking.remindersSent || {})) {
            await doc.ref.update({ remindersSent: sent });
          }
        } catch (e3) { console.error("scheduledBookingReminders persist error (" + bookingId + "):", e3.message); }
      }

      console.log("scheduledBookingReminders: " + snap.size + " bookings checked, " + remindersCount + " reminders processed");
    } catch (e) {
      console.error("scheduledBookingReminders error:", e.message);
    }
    return null;
  });


/* ════════════════════════════════════════════════════════════════════════════
 * AMBITIO BOOKING — Patch enrichi (Meet, confirmation, annulation)
 * ════════════════════════════════════════════════════════════════════════════ */

const _abAdminEmail = 'contact@adrienemily.com';

const _abDefaultConfirm = {
  subject: 'Confirmation de votre RDV — {{typeLabel}}',
  body: '<p>Bonjour {{prenom}},</p>' +
        '<p>Votre rendez-vous <strong>{{typeLabel}}</strong> avec <strong>{{expert}}</strong> est confirmé pour le <strong>{{date}}</strong> à <strong>{{time}}</strong> ({{duration}} min).</p>' +
        '{{meetBlock}}' +
        '<p>À très vite !<br>L\'équipe Adrien&Emily</p>',
};

const _abDefaultCancel = {
  subject: 'Annulation de votre RDV — {{typeLabel}}',
  body: '<p>Bonjour {{prenom}},</p>' +
        '<p>Votre rendez-vous <strong>{{typeLabel}}</strong> avec <strong>{{expert}}</strong> prévu le <strong>{{date}}</strong> à <strong>{{time}}</strong> a été annulé.</p>' +
        '<p>N\'hésitez pas à reprendre rendez-vous quand vous le souhaitez.</p>' +
        '<p>Cordialement,<br>L\'équipe Adrien&Emily</p>',
};

function _abFmtDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s + 'T00:00:00');
    const j = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
    const m = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
    return j[d.getDay()] + ' ' + d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
  } catch (e) { return s; }
}

function _abFill(tpl, vars) {
  if (!tpl) return '';
  let out = tpl;
  for (const k in vars) {
    out = out.split('{{' + k + '}}').join(vars[k] != null ? String(vars[k]) : '');
  }
  return out;
}

async function _abGetTypeNotif(typeId) {
  if (!typeId) return null;
  const snap = await db.collection('booking_config').doc('_types').get();
  if (!snap.exists) return null;
  const list = (snap.data() || {}).list || [];
  const t = list.find(x => x.id === typeId);
  return t ? (t.notifications || {}) : null;
}

async function _abGetExpertEmail(personId) {
  if (!personId) return null;
  try {
    const snap = await db.collection('booking_config').doc(personId).get();
    if (!snap.exists) return null;
    const p = snap.data();
    // Priorité 1 : personalEmail (champ "Email de notification" de la fiche
    // expert booking-admin) — c'est la source de vérité voulue pour les
    // notifs : permet à l'admin de poser explicitement edouard@adrienemily.com
    // même si le coach se loggue avec un autre email Firebase Auth.
    if (p.personalEmail) return p.personalEmail;
    // Priorité 2 : champ email legacy posé sur le doc (rétro-compat)
    if (p.email) return p.email;
    // Priorité 3 : email du compte Firebase Auth lié
    if (p.firebaseUid) {
      const u = await db.collection('users').doc(p.firebaseUid).get();
      if (u.exists && u.data().email) return u.data().email;
    }
  } catch (e) {}
  return null;
}

async function _abLoadOauth() {
  for (const docId of ['oauth', 'oauth_calendar']) {
    const snap = await db.collection('_config').doc(docId).get();
    if (snap.exists) {
      const d = snap.data();
      const cid = d.client_id || d.clientId;
      const cs = d.client_secret || d.clientSecret;
      if (cid && cs) return { clientId: cid, clientSecret: cs };
    }
  }
  throw new Error('OAuth config introuvable dans _config/oauth');
}

async function _abRefreshGmailToken(accountKey, refreshToken, oauth) {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Refresh failed: ' + JSON.stringify(data));
  }
  await db.collection('email_tokens').doc(accountKey).set({
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
    accessTokenRefreshedAt: new Date(),
  }, { merge: true });
  return data.access_token;
}

function _abB64u(s) {
  return Buffer.from(s, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _abMime(args) {
  const boundary = '----=_b_' + Math.random().toString(36).substring(2);
  const subj = '=?UTF-8?B?' + Buffer.from(args.subject, 'utf-8').toString('base64') + '?=';
  const h = ['From: ' + args.from, 'To: ' + args.to];
  if (args.cc) h.push('Cc: ' + args.cc);
  h.push('Subject: ' + subj, 'MIME-Version: 1.0');
  if (args.bodyHtml && args.bodyText) {
    h.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    return h.join('\r\n') + '\r\n\r\n' +
      '--' + boundary + '\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n' + args.bodyText + '\r\n' +
      '--' + boundary + '\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n' + args.bodyHtml + '\r\n' +
      '--' + boundary + '--';
  }
  if (args.bodyHtml) {
    h.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit');
    return h.join('\r\n') + '\r\n\r\n' + args.bodyHtml;
  }
  h.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit');
  return h.join('\r\n') + '\r\n\r\n' + (args.bodyText || '');
}

// Wrapping HTML stylé (header bleu + footer logos) pour les mails booking
// prospect. Identique à buildHtmlEmail mais accepte du HTML pré-formaté
// pour le contenu central (utile pour insérer table détails + encart Meet).
function _abBuildStyledEmail(subject, contentHtml) {
  const subjEsc = (subject || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function _abGmailSendApi(token, mime) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: _abB64u(mime) }),
  });
  let data; try { data = await r.json(); } catch (e) { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

async function _abSendEmail(p) {
  if (!p.accountKey || !p.to || !p.subject) throw new Error('Params requis');
  if (!p.bodyHtml && !p.bodyText) throw new Error('bodyHtml ou bodyText requis');
  const tokSnap = await db.collection('email_tokens').doc(p.accountKey).get();
  if (!tokSnap.exists) throw new Error('Compte non connecté: ' + p.accountKey);
  const tok = tokSnap.data();
  if (!tok.refreshToken) throw new Error('refreshToken manquant pour ' + p.accountKey);
  const fromAddr = tok.email || (p.accountKey + '@adrienemily.com');
  const mimeArgs = { from: fromAddr, to: p.to, cc: p.cc, subject: p.subject, bodyHtml: p.bodyHtml, bodyText: p.bodyText };
  let access = tok.accessToken;
  if (access) {
    const r = await _abGmailSendApi(access, _abMime(mimeArgs));
    if (r.ok) return { ok: true, messageId: r.data.id, from: fromAddr };
    if (r.status !== 401) return { ok: false, error: 'Gmail ' + r.status + ': ' + JSON.stringify(r.data) };
  }
  const oauth = await _abLoadOauth();
  access = await _abRefreshGmailToken(p.accountKey, tok.refreshToken, oauth);
  const r2 = await _abGmailSendApi(access, _abMime(mimeArgs));
  if (r2.ok) return { ok: true, messageId: r2.data.id, from: fromAddr };
  return { ok: false, error: 'Gmail ' + r2.status + ' (after refresh): ' + JSON.stringify(r2.data) };
}

// REMPLACE l'ancien onBookingCreated
exports.onBookingCreated = functions.firestore
  .document('bookings/{bookingId}')
  .onCreate(async (snap, context) => {
    const booking = snap.data();
    const bookingId = context.params.bookingId;
    const personId = booking.personId;
    if (!personId) return null;

    const dur = booking.duration || 30;
    const time = booking.time || '09:00';
    const parts = time.split(':');
    const startMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    const endMin = startMin + dur;
    const endTime = String(Math.floor(endMin / 60)).padStart(2, '0') + ':' + String(endMin % 60).padStart(2, '0');

    const prospect = booking.prospect || {};
    const clientName = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim() || prospect.email || '';
    const expertName = booking.personName || '';
    const typeLabel = booking.typeLabel || booking.type || 'RDV';

    let meetLink = null;
    let calendarEventId = null;
    let calendarEventLink = null;

    const tokDoc = await db.collection('calendar_tokens').doc(personId).get();
    if (tokDoc.exists) {
      try {
        const client = await getAuthClientForPerson(personId);
        if (client) {
          // ─── Résolution du calendrier cible ───
          // Lit booking_config[personId].calendarList et cherche l'entrée
          // avec createEvents:true (positionnée via le picker booking-admin).
          // Pour les coachs (Edouard, Mickael, Flore...) qui partagent le
          // compte coaching@adrienemily.com, ça résout sur leur sous-
          // calendrier dédié. Fallback "primary" sinon.
          const targetCalendarId = await getEventCalendarId(personId);
          console.log('[onBookingCreated] target calendar = ' + targetCalendarId + ' (person=' + personId + ')');

          let description = 'Réservé via Ambitio Booking';
          description += '\n\n— Client —';
          if (clientName) description += '\n' + clientName;
          if (prospect.email) description += '\nEmail : ' + prospect.email;
          if (prospect.telephone) description += '\nTéléphone : ' + prospect.telephone;
          if (prospect.message) description += '\n\nMessage : ' + prospect.message;
          description += '\n\n— RDV —\nType : ' + typeLabel;
          if (expertName) description += '\nExpert : ' + expertName;
          description += '\nDurée : ' + dur + ' min';

          const event = {
            summary: typeLabel + (clientName ? ' — ' + clientName : ''),
            description: description,
            start: { dateTime: booking.date + 'T' + time + ':00', timeZone: 'Europe/Paris' },
            end: { dateTime: booking.date + 'T' + endTime + ':00', timeZone: 'Europe/Paris' },
            conferenceData: {
              createRequest: {
                requestId: 'ambitio-' + bookingId,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          };

          const cal = google.calendar({ version: 'v3', auth: client });

          // ─── Insertion SANS attendees (sendUpdates:'none' → aucun mail) ───
          // Le code Google Meet est généré de façon ASYNCHRONE : la réponse
          // d'events.insert renvoie souvent un lien provisoire (ou rien), puis
          // Google régénère le code ("secure meeting codes"). Tant qu'il n'est
          // pas stabilisé, on ne notifie personne.
          const resp = await cal.events.insert({
            calendarId: targetCalendarId,
            requestBody: event,
            conferenceDataVersion: 1,
            sendUpdates: 'none',
          });
          calendarEventId = resp.data.id;
          calendarEventLink = resp.data.htmlLink || '';

          // ─── On attend le lien Meet DÉFINITIF avant toute notification ───
          // C'est le cœur du fix "deux liens Meet" : auparavant l'invitation
          // Google native partait (patch sendUpdates:'all') AVANT cette
          // stabilisation → ancien code, tandis que l'email stylé (lu après)
          // portait le nouveau. Désormais on bloque jusqu'au code final, donc
          // l'invitation native ET l'email stylé portent le MÊME lien.
          meetLink = await waitForFinalMeetLink(cal, targetCalendarId, calendarEventId, {
            fallback: resp.data.hangoutLink ||
              (resp.data.conferenceData && resp.data.conferenceData.entryPoints
                ? (resp.data.conferenceData.entryPoints.find(e => e.entryPointType === 'video') || {}).uri
                : null) || null,
          });

          // ─── Étape 2 : ajouter le prospect comme attendee ───
          // Le code Meet est maintenant final. On n'envoie PAS de createRequest
          // ici (donc aucune régénération), uniquement les attendees.
          //   SEND_GOOGLE_INVITE_TO_PROSPECT = true  → sendUpdates:'all'
          //     (invitation Google native, lien final = celui de l'email stylé)
          //   false → sendUpdates:'none' (aucun mail Google ; email stylé seul)
          if (prospect.email) {
            try {
              await cal.events.patch({
                calendarId: targetCalendarId,
                eventId: calendarEventId,
                requestBody: {
                  attendees: [{ email: prospect.email, displayName: clientName }],
                },
                sendUpdates: SEND_GOOGLE_INVITE_TO_PROSPECT ? 'all' : 'none',
              });
              console.log('[onBookingCreated] Attendee patché (' +
                (SEND_GOOGLE_INVITE_TO_PROSPECT ? 'invitation Google envoyée' : 'silencieux, email stylé seul') +
                '), meet=' + (meetLink || 'none'));
            } catch (e) {
              console.error('[onBookingCreated] Attendee patch error:', e.message);
            }
          }

          await snap.ref.update({ calendarEventId, calendarEventLink, meetLink, calendarIdUsed: targetCalendarId });
          await fetchAndStoreBusy(personId);
          console.log('[onBookingCreated] Event ' + calendarEventId + ' meet=' + (meetLink ? 'yes' : 'no'));
        }
      } catch (e) {
        console.error('[onBookingCreated] Calendar error:', e.message);
      }
    }

    if (prospect.email) {
      try {
        const notifs = await _abGetTypeNotif(booking.type) || {};
        const accountKey = notifs.emailAccount || 'strategie';

        const subject = 'Confirmation de votre RDV — ' + typeLabel;
        const dateFr = _abFmtDate(booking.date);
        const meetBlock = meetLink
          ? '<div style="margin:20px 0;padding:16px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px">'
            + '<div style="font-size:14px;font-weight:700;color:#166534;margin-bottom:6px">📹 Lien de visioconférence</div>'
            + '<a href="' + meetLink + '" style="color:#16a34a;font-size:15px;font-weight:600;text-decoration:none;word-break:break-all">' + meetLink + '</a>'
            + '<div style="font-size:12px;color:#6b7280;margin-top:6px">Cliquez à l\'heure du RDV pour rejoindre la réunion.</div>'
            + '</div>'
          : '';

        const greetName = (prospect.prenom || '').trim() || (prospect.nom || '').trim() || '';
        const content = '<p style="margin:0 0 18px">Bonjour' + (greetName ? ' <strong>' + greetName + '</strong>' : '') + ',</p>'
          + '<p style="margin:0 0 18px">Votre rendez-vous est confirmé. Vous trouverez ci-dessous les détails :</p>'
          + '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;background:#f9fafb;border-radius:10px;margin:0 0 18px">'
          + '<tbody>'
          + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;width:120px"><strong>Type</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827">' + typeLabel + '</td></tr>'
          + (expertName ? '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Avec</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + expertName + '</td></tr>' : '')
          + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Date</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + dateFr + '</td></tr>'
          + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Heure</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + time + ' (' + dur + ' min)</td></tr>'
          + '</tbody></table>'
          + meetBlock
          + (SEND_GOOGLE_INVITE_TO_PROSPECT
              ? '<p style="margin:18px 0;font-size:13px;color:#6b7280;font-style:italic">Une invitation Google Calendar vient de vous être envoyée séparément — elle ajoutera automatiquement le RDV à votre agenda.</p>'
              : '')
          + '<p style="margin:0">À très vite !<br><strong>L\'équipe Adrien &amp; Emily</strong></p>';

        const bodyHtml = _abBuildStyledEmail(subject, content);
        const bodyText = content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
        const r = await _abSendEmail({ accountKey, to: prospect.email, subject, bodyHtml, bodyText });
        console.log('[onBookingCreated] Email prospect ' + (r.ok ? '✓' : '✗ ' + r.error));
      } catch (e) {
        console.error('[onBookingCreated] Email prospect error:', e.message);
      }
    }

    try {
      const expertEmail = await _abGetExpertEmail(personId);
      const recipients = [_abAdminEmail];
      if (expertEmail && expertEmail !== _abAdminEmail) recipients.push(expertEmail);

      const subj = '📅 Nouveau RDV — ' + typeLabel + ' avec ' + clientName + ' (' + _abFmtDate(booking.date) + ' ' + time + ')';
      const body = '<p><strong>Nouveau RDV pris !</strong></p>' +
        '<table style="border-collapse:collapse;font-size:14px"><tbody>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Client</strong></td><td>' + clientName + '</td></tr>' +
        (prospect.email ? '<tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td><a href="mailto:' + prospect.email + '">' + prospect.email + '</a></td></tr>' : '') +
        (prospect.telephone ? '<tr><td style="padding:4px 12px 4px 0"><strong>Téléphone</strong></td><td><a href="tel:' + prospect.telephone + '">' + prospect.telephone + '</a></td></tr>' : '') +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Type</strong></td><td>' + typeLabel + '</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Expert</strong></td><td>' + expertName + '</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Date</strong></td><td>' + _abFmtDate(booking.date) + '</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Heure</strong></td><td>' + time + ' (' + dur + ' min)</td></tr>' +
        (meetLink ? '<tr><td style="padding:4px 12px 4px 0"><strong>Meet</strong></td><td><a href="' + meetLink + '">' + meetLink + '</a></td></tr>' : '') +
        (prospect.message ? '<tr><td style="padding:4px 12px 4px 0;vertical-align:top"><strong>Message</strong></td><td>' + prospect.message + '</td></tr>' : '') +
        '</tbody></table>' +
        '<p style="margin-top:16px;font-size:12px;color:#666">Notification automatique — Ambitio Booking</p>';

      const notifs = await _abGetTypeNotif(booking.type) || {};
      const accountKey = notifs.emailAccount || 'strategie';
      const r = await _abSendEmail({ accountKey, to: recipients[0], cc: recipients.length > 1 ? recipients.slice(1).join(', ') : null, subject: subj, bodyHtml: body, bodyText: body.replace(/<[^>]+>/g, '') });
      console.log('[onBookingCreated] Notif équipe ' + (r.ok ? '✓ → ' + recipients.join(', ') : '✗ ' + r.error));
    } catch (e) {
      console.error('[onBookingCreated] Notif équipe error:', e.message);
    }

    /* ═══ LEAD MAPPING — source unique de vérité ═══
       Connecte le booking à un lead Lead Live / pipeline CRM.
       Priorité de lookup :
         1. booking.leadId si déjà passé par AlteoForms
         2. findLead(prospect.email, prospect.telephone) — helper existant
       Si trouvé : update (stage rdv_self_booking, lastBookingAt, timeline,
       bookingsHistory). Si rien : create lead bk_<bookingId>.

       lastBookingAt est le champ qui permet à sales-leads.html de faire
       remonter un vieux lead dans le feed Lead Live (cf. second listener).

       ─── COACHING SHORT-CIRCUIT (2026-05-05) ───
       Si booking.isCoaching === true (consultation marquée "Coaching" dans
       booking-admin), on évite toute mutation pipeline lead :
         - PAS de stage/status/type modifiés
         - PAS de lastBookingAt (sinon le lead remonte dans Leads Live)
         - PAS de création de lead bk_<bookingId>
       On ajoute uniquement une ligne timeline informative sur un lead
       historique s'il existe (traçabilité), pour qu'un closer voie que ce
       contact est passé en RDV coaching. La fiche client coaching est
       gérée par le bloc CLIENT COACHING MAPPING juste après. */
    try {
      const TERMINAL_STAGES = ['closed_won_setting', 'closed_won_self', 'closed_lost', 'poubelle', 'disqualification'];
      let leadDoc = null;

      if (booking.leadId) {
        const direct = await db.collection('leads').doc(booking.leadId).get();
        if (direct.exists) leadDoc = { id: direct.id, ref: direct.ref, data: direct.data() };
      }
      if (!leadDoc) {
        const found = await findLead(prospect.email, prospect.telephone);
        if (found) {
          leadDoc = { id: found.id, ref: db.collection('leads').doc(found.id), data: found.data };
        }
      }

      // ─── Branche coaching : timeline only, no pipeline mutation ───
      if (booking.isCoaching === true) {
        if (leadDoc) {
          await leadDoc.ref.update({
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            timeline_history: admin.firestore.FieldValue.arrayUnion({
              text: '🎯 RDV coaching · ' + typeLabel + ' avec ' + expertName + ' le ' + _abFmtDate(booking.date) + ' ' + time,
              date: fmtNow(),
              color: '#c4b5fd'
            })
          });
          await snap.ref.update({ leadId: leadDoc.id, leadLinkType: 'coaching_passive' });
          console.log('[onBookingCreated] Lead ' + leadDoc.id + ' coaching: timeline only, no pipeline mutation');
        } else {
          console.log('[onBookingCreated] Coaching booking, no lead match: skip lead creation');
        }
      } else {
        // ─── Branche prospect : logique pipeline classique ───
        const bookingHistEntry = {
          bookingId: bookingId,
          date: booking.date || '',
          time: booking.time || '',
          type: booking.type || '',
          typeLabel: typeLabel,
          personId: personId,
          personName: expertName,
          meetLink: meetLink || '',
          createdAt: fmtNow()
        };

        if (leadDoc) {
          const existing = leadDoc.data || {};
          const isResurrected = existing.stage && TERMINAL_STAGES.indexOf(existing.stage) >= 0;
          const update = {
            lastBookingAt: admin.firestore.FieldValue.serverTimestamp(),
            lastBookingId: bookingId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            bookingsHistory: admin.firestore.FieldValue.arrayUnion(bookingHistEntry)
          };

          if (existing.type !== 'self_booking') update.type = 'self_booking';

          const curStage = existing.stage || 'lead';
          let tlText;
          if (TERMINAL_STAGES.indexOf(curStage) < 0) {
            update.stage = 'rdv_self_booking';
            update.status = 'rdv_pose';
          }

          if (curStage === 'rdv_self_booking' || curStage === 'rdv_confirmes' || curStage === 'set') {
            tlText = '🔄 RDV reporté · ' + typeLabel + ' avec ' + expertName + ' le ' + _abFmtDate(booking.date) + ' ' + time;
          } else if (isResurrected) {
            tlText = '🔄 RDV repris · ancien stage : ' + curStage + ' → rdv_self_booking';
          } else {
            tlText = '📅 RDV pris · ' + typeLabel + ' avec ' + expertName + ' le ' + _abFmtDate(booking.date) + ' ' + time;
          }
          update.timeline_history = admin.firestore.FieldValue.arrayUnion({
            text: tlText, date: fmtNow(), color: '#34d399'
          });

          const mergeFields = ['nom', 'email', 'telephone', 'secteur'];
          mergeFields.forEach((f) => {
            const v = (f === 'nom') ? (((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim()) : prospect[f];
            if (v && !existing[f]) update[f] = v;
          });

          await leadDoc.ref.update(update);
          await snap.ref.update({ leadId: leadDoc.id, leadLinkType: 'matched' });
          console.log('[onBookingCreated] Lead ' + leadDoc.id + ' mis à jour (' + (isResurrected ? 'resurrected' : (TERMINAL_STAGES.indexOf(curStage) < 0 ? 'updated' : 'kept terminal') ) + ')');
        } else {
          const fullName = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim();
          const newLeadId = 'bk_' + bookingId;
          const lead = {
            nom: fullName,
            email: (prospect.email || '').trim().toLowerCase(),
            telephone: prospect.telephone || '',
            secteur: prospect.secteur || '',
            message: prospect.message || '',
            type: 'self_booking',
            source: booking.formId ? 'forms_self_booking' : 'booking_direct',
            utm: booking.formId ? ('Form ' + booking.formId) : (booking.typeLabel || 'Booking direct'),
            stage: 'rdv_self_booking',
            status: 'rdv_pose',
            assignedTo: '',
            notesHistory: [],
            timeline_history: [{
              text: '✨ Lead créé via booking · ' + typeLabel + ' avec ' + expertName + ' le ' + _abFmtDate(booking.date) + ' ' + time,
              date: fmtNow(),
              color: '#a78bfa'
            }],
            bookingsHistory: [bookingHistEntry],
            lastBookingAt: admin.firestore.FieldValue.serverTimestamp(),
            lastBookingId: bookingId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          };
          await db.collection('leads').doc(newLeadId).set(lead);
          await snap.ref.update({ leadId: newLeadId, leadLinkType: 'created' });
          console.log('[onBookingCreated] Lead ' + newLeadId + ' créé (booking sans lead matché)');
        }
      }
    } catch (e) {
      console.error('[onBookingCreated] Lead mapping error:', e.message);
    }

    /* ═══ CLIENT COACHING MAPPING ═══
       Si la consultation est marquée isCoaching=true, on tente de matcher
       l'email du prospect avec une fiche client coaching existante.
       Si match → pose clientId/clientName sur le booking + lastCoachingBookingAt
       sur la fiche client. Pas de match → log warn, aucune création auto. */
    if (booking.isCoaching === true) {
      try {
        const emailNorm = (prospect.email || '').trim().toLowerCase();
        if (!emailNorm) {
          console.log('[onBookingCreated] coaching: no email on prospect, skip');
        } else {
          const cs = await db.collection('clients').where('email', '==', emailNorm).limit(1).get();
          if (cs.empty) {
            const all = await db.collection('clients').get();
            let match = null;
            all.forEach((d) => {
              const e = (d.data().email || '').trim().toLowerCase();
              if (!match && e === emailNorm) match = { id: d.id, data: d.data() };
            });
            if (match) {
              await snap.ref.update({ clientId: match.id, clientName: match.data.nom || '' });
              await db.collection('clients').doc(match.id).update({
                lastCoachingBookingAt: admin.firestore.FieldValue.serverTimestamp(),
                lastCoachingBookingId: bookingId
              });
              console.log('[onBookingCreated] coaching: client matched (case-fallback) ' + match.id);
            } else {
              console.log('[onBookingCreated] coaching: no client found for email ' + emailNorm);
            }
          } else {
            const doc = cs.docs[0];
            await snap.ref.update({ clientId: doc.id, clientName: doc.data().nom || '' });
            await db.collection('clients').doc(doc.id).update({
              lastCoachingBookingAt: admin.firestore.FieldValue.serverTimestamp(),
              lastCoachingBookingId: bookingId
            });
            console.log('[onBookingCreated] coaching: client matched ' + doc.id);
          }
        }
      } catch (e) {
        console.error('[onBookingCreated] coaching client mapping error:', e.message);
      }
    }

    return null;
  });

exports.onBookingUpdated = functions.firestore
  .document('bookings/{bookingId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const bookingId = context.params.bookingId;

    if (after.status !== 'cancelled' || before.status === 'cancelled') return null;
    if (after.cancelHandledAt) return null;

    console.log('[onBookingUpdated] Annulation détectée: ' + bookingId);

    const personId = after.personId;
    const prospect = after.prospect || {};
    const clientName = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim() || prospect.email || '';
    const expertName = after.personName || '';
    const typeLabel = after.typeLabel || after.type || 'RDV';
    const dur = after.duration || 30;
    const time = after.time || '';

    if (after.calendarEventId && personId) {
      try {
        const client = await getAuthClientForPerson(personId);
        if (client) {
          const cal = google.calendar({ version: 'v3', auth: client });
          // Cible le même calendrier que celui utilisé à la création.
          // Fallback "primary" pour les bookings antérieurs au déploiement
          // de cette logique (qui n'ont pas calendarIdUsed posé).
          const deleteCalendarId = after.calendarIdUsed || 'primary';
          await cal.events.delete({ calendarId: deleteCalendarId, eventId: after.calendarEventId, sendUpdates: 'all' });
          await fetchAndStoreBusy(personId);
          console.log('[onBookingUpdated] Calendar event supprimé: ' + after.calendarEventId + ' (cal=' + deleteCalendarId + ')');
        }
      } catch (e) {
        console.error('[onBookingUpdated] Calendar delete error:', e.message);
      }
    }

    if (prospect.email) {
      try {
        const notifs = await _abGetTypeNotif(after.type) || {};
        const accountKey = notifs.emailAccount || 'strategie';

        const subject = 'Annulation de votre RDV — ' + typeLabel;
        const dateFr = _abFmtDate(after.date);
        const greetName = (prospect.prenom || '').trim() || (prospect.nom || '').trim() || '';

        const content = '<p style="margin:0 0 18px">Bonjour' + (greetName ? ' <strong>' + greetName + '</strong>' : '') + ',</p>'
          + '<p style="margin:0 0 18px">Votre rendez-vous a été annulé.</p>'
          + '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;background:#f9fafb;border-radius:10px;margin:0 0 18px">'
          + '<tbody>'
          + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;width:130px"><strong>Type</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827">' + typeLabel + '</td></tr>'
          + (expertName ? '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Avec</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + expertName + '</td></tr>' : '')
          + '<tr><td style="padding:10px 18px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb"><strong>Était prévu le</strong></td><td style="padding:10px 18px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb">' + dateFr + ' à ' + time + ' (' + dur + ' min)</td></tr>'
          + '</tbody></table>'
          + '<p style="margin:18px 0;font-size:13px;color:#6b7280">Le créneau a été libéré dans votre agenda Google Calendar.</p>'
          + '<p style="margin:0">N\'hésitez pas à <a href="https://team.alteore.com/booking" style="color:#3b82f6;font-weight:600;text-decoration:none">reprendre rendez-vous</a> quand vous le souhaitez.</p>'
          + '<p style="margin:18px 0 0">Cordialement,<br><strong>L\'équipe Adrien &amp; Emily</strong></p>';

        const bodyHtml = _abBuildStyledEmail(subject, content);
        const bodyText = content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
        const r = await _abSendEmail({ accountKey, to: prospect.email, subject, bodyHtml, bodyText });
        console.log('[onBookingUpdated] Email annulation prospect ' + (r.ok ? '✓' : '✗ ' + r.error));
      } catch (e) {
        console.error('[onBookingUpdated] Email annulation error:', e.message);
      }
    }

    try {
      const expertEmail = await _abGetExpertEmail(personId);
      const recipients = [_abAdminEmail];
      if (expertEmail && expertEmail !== _abAdminEmail) recipients.push(expertEmail);
      const subj = '🔴 RDV annulé — ' + typeLabel + ' avec ' + clientName + ' (' + _abFmtDate(after.date) + ' ' + time + ')';
      const body = '<p><strong>Un RDV vient d\'être annulé.</strong></p>' +
        '<table style="border-collapse:collapse;font-size:14px"><tbody>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Client</strong></td><td>' + clientName + '</td></tr>' +
        (prospect.email ? '<tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td><a href="mailto:' + prospect.email + '">' + prospect.email + '</a></td></tr>' : '') +
        (prospect.telephone ? '<tr><td style="padding:4px 12px 4px 0"><strong>Téléphone</strong></td><td><a href="tel:' + prospect.telephone + '">' + prospect.telephone + '</a></td></tr>' : '') +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Type</strong></td><td>' + typeLabel + '</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Expert</strong></td><td>' + expertName + '</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0"><strong>Date prévue</strong></td><td>' + _abFmtDate(after.date) + ' ' + time + ' (' + dur + ' min)</td></tr>' +
        '</tbody></table>' +
        '<p style="margin-top:16px;font-size:12px;color:#666">Le créneau a été libéré dans Google Calendar. Notification automatique — Ambitio Booking.</p>';
      const notifs = await _abGetTypeNotif(after.type) || {};
      const accountKey = notifs.emailAccount || 'strategie';
      const r = await _abSendEmail({ accountKey, to: recipients[0], cc: recipients.length > 1 ? recipients.slice(1).join(', ') : null, subject: subj, bodyHtml: body, bodyText: body.replace(/<[^>]+>/g, '') });
      console.log('[onBookingUpdated] Notif équipe annulation ' + (r.ok ? '✓ → ' + recipients.join(', ') : '✗ ' + r.error));
    } catch (e) {
      console.error('[onBookingUpdated] Notif équipe error:', e.message);
    }

    try {
      await change.after.ref.update({ cancelHandledAt: admin.firestore.FieldValue.serverTimestamp(), cancelHandledBy: 'cloud-function' });
    } catch (e) {}

    /* ═══ LEAD MAPPING — annulation ═══
       Si le booking a été lié à un lead (par onBookingCreated qui pose
       leadId sur le booking), on bascule le lead en rdv_annules_prospect
       et on ajoute une ligne timeline. lastBookingAt est gardé pour que
       le lead reste visible dans le feed Lead Live (rappel à faire). */
    try {
      const TERMINAL_STAGES = ['closed_won_setting', 'closed_won_self', 'closed_lost', 'poubelle', 'disqualification'];
      const linkedLeadId = after.leadId || before.leadId || null;
      if (linkedLeadId) {
        const leadRef = db.collection('leads').doc(linkedLeadId);
        const leadSnap = await leadRef.get();
        if (leadSnap.exists) {
          const cur = leadSnap.data();
          const curStage = cur.stage || 'lead';
          const update = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastBookingAt: admin.firestore.FieldValue.serverTimestamp(),
            timeline_history: admin.firestore.FieldValue.arrayUnion({
              text: '🔴 RDV annulé · ' + typeLabel + ' du ' + _abFmtDate(after.date) + ' ' + time,
              date: fmtNow(),
              color: '#ef4444'
            })
          };
          if (TERMINAL_STAGES.indexOf(curStage) < 0) {
            update.stage = 'rdv_annules_prospect';
            update.status = 'pas_interesse';
          }
          await leadRef.update(update);
          console.log('[onBookingUpdated] Lead ' + linkedLeadId + ' bascule rdv_annules_prospect');
        }
      }
    } catch (e) {
      console.error('[onBookingUpdated] Lead update error:', e.message);
    }

    return null;
  });


/* ═══════════════════════════════════════════════════
   12. VOICE NOTES — TRANSCRIPTION + RÉSUMÉ
   ═══════════════════════════════════════════════════

   Trigger : création d'un doc dans leads/{leadId}/voice_notes/{noteId}
   par voice-notes.js (frontend) après upload Firebase Storage.

   Pipeline :
     1. Status pending → processing
     2. Download du blob audio depuis Storage (via storagePath)
     3. Whisper API → transcription FR
     4. Claude Haiku → résumé bref 2-3 phrases en français
     5. Update doc Firestore avec transcription + summary +
        transcriptionStatus = 'done' (ou 'error' + transcriptionError)

   Réutilise les helpers loadAiCreds / getOpenAI / getAnthropic du
   pipeline d'analyse d'appels (call_logs) — credentials dans
   _config/ai_credentials.

   Limites :
     - 5 MB max côté Storage rules (≈10 min à 64 kbps).
     - Whisper supporte jusqu'à 25 MB par fichier — large marge.
     - Vocaux UI plafonnés à 3 min ⇒ ~3-5 MB en webm/mp4.
   ═══════════════════════════════════════════════════ */

let _vnAiCreds = null;
let _vnOpenAI = null;
let _vnAnthropic = null;

async function _vnLoadAiCreds() {
  if (_vnAiCreds) return _vnAiCreds;
  const snap = await db.collection('_config').doc('ai_credentials').get();
  if (!snap.exists) throw new Error('_config/ai_credentials introuvable');
  const data = snap.data();
  if (!data.openai || !data.openai.apiKey) throw new Error('ai_credentials.openai.apiKey manquant');
  if (!data.anthropic || !data.anthropic.apiKey) throw new Error('ai_credentials.anthropic.apiKey manquant');
  _vnAiCreds = data;
  return data;
}

async function _vnGetOpenAI() {
  if (_vnOpenAI) return _vnOpenAI;
  const OpenAI = require('openai');
  const creds = await _vnLoadAiCreds();
  _vnOpenAI = new OpenAI({ apiKey: creds.openai.apiKey });
  return _vnOpenAI;
}

async function _vnGetAnthropic() {
  if (_vnAnthropic) return _vnAnthropic;
  const Anthropic = require('@anthropic-ai/sdk');
  const creds = await _vnLoadAiCreds();
  _vnAnthropic = new Anthropic({ apiKey: creds.anthropic.apiKey });
  return _vnAnthropic;
}

exports.onVoiceNoteCreated = functions
  .runWith({ memory: '512MB', timeoutSeconds: 120 })
  .firestore
  .document('leads/{leadId}/voice_notes/{noteId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const leadId = context.params.leadId;
    const noteId = context.params.noteId;

    if (!data.storagePath) {
      console.warn('[onVoiceNoteCreated] ' + noteId + ' : storagePath manquant, skip');
      await snap.ref.update({ transcriptionStatus: 'error', transcriptionError: 'storagePath missing' });
      return null;
    }

    // Marquer en cours pour que l'UI affiche "Transcription en cours…"
    await snap.ref.update({ transcriptionStatus: 'processing' });

    let buffer;
    let mimeType = data.mimeType || 'audio/webm';
    let fileExt;
    try {
      const bucket = admin.storage().bucket();
      const file = bucket.file(data.storagePath);
      const [exists] = await file.exists();
      if (!exists) throw new Error('Blob storage introuvable: ' + data.storagePath);
      const [buf] = await file.download();
      buffer = buf;

      // Détermine l'extension à passer à Whisper. Whisper accepte
      // mp3, mp4, mpeg, mpga, m4a, wav, webm.
      const lowerPath = data.storagePath.toLowerCase();
      if (lowerPath.endsWith('.mp4') || lowerPath.endsWith('.m4a')) fileExt = 'm4a';
      else if (lowerPath.endsWith('.webm')) fileExt = 'webm';
      else if (lowerPath.endsWith('.ogg')) fileExt = 'webm'; // Whisper ne gère pas ogg, mais webm proche
      else if (lowerPath.endsWith('.wav')) fileExt = 'wav';
      else if (lowerPath.endsWith('.aac')) fileExt = 'm4a';
      else fileExt = 'webm';
    } catch (e) {
      console.error('[onVoiceNoteCreated] Download Storage error:', e.message);
      await snap.ref.update({ transcriptionStatus: 'error', transcriptionError: 'Download: ' + e.message });
      return null;
    }

    // ─── Whisper transcription ───
    let transcription = '';
    try {
      const openai = await _vnGetOpenAI();
      const { toFile } = require('openai/uploads');
      const f = await toFile(buffer, noteId + '.' + fileExt, { type: mimeType });
      const resp = await openai.audio.transcriptions.create({
        file: f,
        model: 'whisper-1',
        language: 'fr',
        response_format: 'json'
      });
      transcription = (resp && resp.text) ? resp.text.trim() : '';
      if (!transcription) {
        await snap.ref.update({
          transcriptionStatus: 'done',
          transcription: '',
          summary: '(Vocal silencieux ou trop court pour être transcrit.)',
          transcribedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return null;
      }
    } catch (e) {
      console.error('[onVoiceNoteCreated] Whisper error:', e.message);
      await snap.ref.update({ transcriptionStatus: 'error', transcriptionError: 'Whisper: ' + e.message });
      return null;
    }

    // ─── Claude Haiku — résumé bref ───
    let summary = '';
    try {
      const anthropic = await _vnGetAnthropic();

      // Charge un peu de contexte sur le lead pour rendre le résumé plus utile
      let leadContext = '';
      try {
        const leadSnap = await db.collection('leads').doc(leadId).get();
        if (leadSnap.exists) {
          const l = leadSnap.data();
          const bits = [];
          if (l.nom) bits.push('Nom : ' + l.nom);
          if (l.secteur) bits.push('Secteur : ' + l.secteur);
          if (l.stage) bits.push('Stage : ' + l.stage);
          if (l.assignedTo) bits.push('Assigné : ' + l.assignedTo);
          if (bits.length) leadContext = '\n\nContexte du prospect :\n' + bits.join('\n');
        }
      } catch (e) { /* contexte best-effort */ }

      const systemPrompt = "Tu es un assistant qui résume des notes vocales d'équipe sales B2B (Ambitio). " +
        "Une note vocale = un sales qui partage des infos sur un prospect avec son équipe. " +
        "Produis un résumé en français, en 2 ou 3 phrases courtes, factuel, qui capture les points clés. " +
        "Pas d'introduction (\"voici le résumé...\"), va droit au but. Tutoie si la note tutoie. " +
        "Si la note est trop courte ou floue pour résumer, retourne juste la phrase complète comme résumé.";

      const userPrompt = "Note vocale à résumer :\n\"\"\"\n" + transcription + "\n\"\"\"" + leadContext;

      const claudeModel = (_vnAiCreds && _vnAiCreds.anthropic && _vnAiCreds.anthropic.summaryModel) || 'claude-haiku-4-5-20251001';

      const resp = await anthropic.messages.create({
        model: claudeModel,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      if (resp && resp.content && resp.content.length > 0) {
        const txtBlock = resp.content.find(function(b) { return b.type === 'text'; });
        if (txtBlock) summary = (txtBlock.text || '').trim();
      }
      if (!summary) summary = transcription.length > 200 ? (transcription.slice(0, 200) + '…') : transcription;
    } catch (e) {
      console.error('[onVoiceNoteCreated] Claude error:', e.message);
      // On garde la transcription même si le résumé échoue — c'est utile.
      summary = transcription.length > 200 ? (transcription.slice(0, 200) + '…') : transcription;
    }

    await snap.ref.update({
      transcription: transcription,
      summary: summary,
      transcriptionStatus: 'done',
      transcribedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('[onVoiceNoteCreated] ' + noteId + ' OK · ' + transcription.length + ' chars · résumé ' + summary.length + ' chars');
    return null;
  });


/* ═══════════════════════════════════════════════════
   13. MENTIONS — NOTIFICATIONS FCM + INBOX IN-APP
   ═══════════════════════════════════════════════════

   Deux triggers pour deux sources de mentions :

   - onVoiceNoteMentionNotify  : déclenché à la création du doc
     leads/{leadId}/voice_notes/{noteId}. Si data.mentions est non vide,
     notifie immédiatement (sans attendre la transcription Whisper).

   - onLeadNoteMentionNotify   : déclenché à l'update du doc
     leads/{leadId}. Détecte si notesHistory s'est allongé. Si la
     nouvelle entrée a un champ `mentions` non vide, notifie.

   Pour chaque utilisateur mentionné (sauf l'auteur lui-même) :
     1. Push FCM via tous ses tokens enregistrés dans fcm_tokens
     2. Création d'un doc dans inbox_notifications avec ownerUid=uid
        (pour la cloche in-app)

   Les fcm_tokens sont récupérés via where('uid', 'in', [...uids]).
   Limite Firestore : 30 uids max par requête `in`. Chunking si > 30.
   ═══════════════════════════════════════════════════ */

async function _notifyMentions({ mentionedUids, authorUid, authorName, leadId, leadName, type, preview, voiceNoteId, deepLinkUrl }) {
  if (!mentionedUids || !mentionedUids.length) return;

  // Filtrer l'auteur (pas de self-notify)
  const targets = mentionedUids.filter((uid) => uid && uid !== authorUid);
  if (!targets.length) return;

  // Récupérer les fcm_tokens des cibles. `where in` est limité à 30 valeurs.
  const tokensByUid = {}; // { uid: [token, token, ...] }
  for (let i = 0; i < targets.length; i += 30) {
    const chunk = targets.slice(i, i + 30);
    try {
      const snap = await db.collection('fcm_tokens').where('uid', 'in', chunk).get();
      snap.forEach((doc) => {
        const d = doc.data();
        const u = d.uid;
        const t = d.token || doc.id;
        if (!u || !t) return;
        if (!tokensByUid[u]) tokensByUid[u] = [];
        tokensByUid[u].push(t);
      });
    } catch (e) {
      console.warn('[notifyMentions] fcm_tokens query error (peut-être pas de champ uid sur les tokens):', e.message);
    }
  }

  // Construire le payload notification
  const titleEmoji = type === 'voice' ? '🎙️' : '💬';
  const verb = type === 'voice' ? 'a laissé un vocal' : 'a écrit une note';
  const title = titleEmoji + ' ' + (authorName || 'Quelqu\'un') + ' ' + verb;
  const bodyParts = [];
  if (leadName) bodyParts.push('Lead : ' + leadName);
  if (preview) bodyParts.push(preview.length > 80 ? preview.slice(0, 80) + '…' : preview);
  const body = bodyParts.join(' · ') || 'Tu as été mentionné';

  // 1. Push FCM (un seul sendEachForMulticast pour tous les tokens fusionnés)
  const allTokens = [].concat.apply([], Object.values(tokensByUid));
  if (allTokens.length) {
    try {
      const message = {
        data: {
          title: title,
          body: body,
          leadId: leadId,
          type: 'mention_' + type,
          url: deepLinkUrl || ('/sales-leads.html?app=1&leadId=' + leadId)
        },
        tokens: allTokens
      };
      const resp = await messaging.sendEachForMulticast(message);
      console.log('[notifyMentions] FCM push : ' + resp.successCount + '/' + allTokens.length + ' OK');

      // Cleanup tokens invalides
      if (resp.failureCount > 0) {
        const bad = [];
        resp.responses.forEach((r, i) => {
          if (!r.success && r.error && (r.error.code === 'messaging/invalid-registration-token' || r.error.code === 'messaging/registration-token-not-registered')) {
            bad.push(allTokens[i]);
          }
        });
        if (bad.length) {
          const batch = db.batch();
          bad.forEach((t) => batch.delete(db.collection('fcm_tokens').doc(t)));
          await batch.commit();
        }
      }
    } catch (e) {
      console.error('[notifyMentions] FCM error:', e.message);
    }
  }

  // 2. Inbox in-app (un doc par destinataire — la cloche affiche les notifs
  //    où ownerUid == request.auth.uid, cf. firestore.rules inbox_notifications)
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  targets.forEach((uid) => {
    const ref = db.collection('inbox_notifications').doc();
    batch.set(ref, {
      ownerUid: uid,
      type: 'mention_' + type,
      authorUid: authorUid || null,
      authorName: authorName || '',
      leadId: leadId,
      leadName: leadName || '',
      preview: preview || '',
      voiceNoteId: voiceNoteId || null,
      deepLinkUrl: deepLinkUrl || ('/sales-leads.html?app=1&leadId=' + leadId),
      createdAt: now,
      readBy: {}
    });
  });
  try {
    await batch.commit();
    console.log('[notifyMentions] Inbox : ' + targets.length + ' notif(s) créée(s)');
  } catch (e) {
    console.error('[notifyMentions] Inbox batch error:', e.message);
  }
}

// Helper : récupère le nom du lead pour enrichir la notif (best-effort)
async function _fetchLeadName(leadId) {
  try {
    const snap = await db.collection('leads').doc(leadId).get();
    if (snap.exists) {
      const d = snap.data();
      return d.nom || d.email || leadId;
    }
  } catch (e) { /* best-effort */ }
  return leadId;
}

// ─── Trigger 1 : mentions sur vocaux ─────────────────────────────────
exports.onVoiceNoteMentionNotify = functions.firestore
  .document('leads/{leadId}/voice_notes/{noteId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const mentions = data.mentions || [];
    if (!Array.isArray(mentions) || mentions.length === 0) return null;

    const leadId = context.params.leadId;
    const noteId = context.params.noteId;
    const dur = data.durationSec ? Math.round(data.durationSec) + 's' : 'vocal';
    const leadName = await _fetchLeadName(leadId);

    await _notifyMentions({
      mentionedUids: mentions,
      authorUid: data.authorUid || null,
      authorName: data.authorName || '',
      leadId: leadId,
      leadName: leadName,
      type: 'voice',
      preview: 'Vocal · ' + dur,
      voiceNoteId: noteId,
      deepLinkUrl: '/sales-leads.html?app=1&leadId=' + leadId + '#vn-' + noteId
    });

    return null;
  });

// ─── Trigger 2 : mentions sur notes texte (notesHistory append) ─────
exports.onLeadNoteMentionNotify = functions.firestore
  .document('leads/{leadId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const beforeNotes = Array.isArray(before.notesHistory) ? before.notesHistory : [];
    const afterNotes = Array.isArray(after.notesHistory) ? after.notesHistory : [];

    // Note ajoutée seulement (on ignore éditions/suppressions pour ce trigger)
    if (afterNotes.length <= beforeNotes.length) return null;

    const newNote = afterNotes[afterNotes.length - 1];
    if (!newNote || typeof newNote !== 'object') return null;

    const mentions = newNote.mentions || [];
    if (!Array.isArray(mentions) || mentions.length === 0) return null;

    const leadId = context.params.leadId;
    const text = (newNote.text || '').trim();
    const preview = text || 'Note';

    await _notifyMentions({
      mentionedUids: mentions,
      authorUid: newNote.authorUid || null,
      authorName: newNote.authorName || '',
      leadId: leadId,
      leadName: after.nom || after.email || leadId,
      type: 'note',
      preview: preview,
      deepLinkUrl: '/sales-leads.html?app=1&leadId=' + leadId
    });

    return null;
  });


/* ═══════════════════════════════════════════════════
   14. USER → TEAM_MEMBERS AUTO-SYNC
   ═══════════════════════════════════════════════════

   Trigger sur users/{uid} (onCreate + onUpdate). Synchronise l'entrée
   correspondante dans le tableau _meta/team_members.

   Logique :
     - À la CRÉATION d'un user : on ajoute une entrée team_members si
       elle n'existe pas. Slug auto, couleur palette tournante, initiales
       depuis fullName/email.
     - À l'UPDATE : on met à jour UNIQUEMENT les champs "miroir" venant
       de users/ (firebaseUid, email, fullName, role). On NE TOUCHE PAS
       aux champs propres à team_members (color, slug, active, archivedAt,
       canPassCalls, signaturesAccess, shortName, initials une fois posées).

   Tous les rôles sont synchronisés (admin + coach + sales) car :
     - Admins sont mentionnables dans les vocaux et notes
     - Coachs auront aussi des vocaux dans le module coaching à venir
     - Le filtrage métier (round-robin sales, dialer, etc.) se fait via
       les flags dédiés (active, role), pas via la présence dans team_members.

   Slug collision : essaie `slug`, puis `slug + initiale_nom`, puis `slug + N`.
   ═══════════════════════════════════════════════════ */

const _TM_PALETTE = [
  '#60a5fa', // bleu clair
  '#a78bfa', // violet
  '#f472b6', // rose
  '#34d399', // vert menthe
  '#fbbf24', // jaune
  '#fb923c', // orange
  '#22d3ee', // cyan
  '#f87171', // rouge
  '#a3e635', // vert pomme
  '#c084fc'  // violet clair
];

// Champs propres à team_members qu'on NE TOUCHE JAMAIS sur update
const _TM_PRESERVED_FIELDS = [
  'color', 'slug', 'active', 'archivedAt',
  'canPassCalls', 'signaturesAccess', 'dialerEnabled',
  'inLeadsModule',
  'shortName', 'initials',
  'createdAt'
];

// Champs qu'on aligne TOUJOURS sur users/ (alignement strict)
const _TM_MIRRORED_FIELDS = [
  'firebaseUid', 'email'
];

// Champs qu'on aligne CONDITIONNELLEMENT :
//   - fullName : seulement si users/ a une version PLUS LONGUE (ne pas
//     écraser "Élodie Vidotto Siarri" par "Elodie" si quelqu'un a mis
//     une version courte dans users/).
//   - role : seulement à la CRÉATION. Une fois posé dans team_members,
//     ne pas écraser les libellés métier custom ("Closing", "Setting",
//     "Head of Sales", etc.).
// Ces champs sont gérés par une logique dédiée plus bas, pas via
// _TM_MIRRORED_FIELDS qui fait un alignement strict.

function _tmComputeFullName(userData) {
  if (userData.fullName && String(userData.fullName).trim()) return String(userData.fullName).trim();
  if (userData.displayName && String(userData.displayName).trim()) return String(userData.displayName).trim();
  if (userData.firstName || userData.lastName) {
    return ((userData.firstName || '') + ' ' + (userData.lastName || '')).trim();
  }
  if (userData.email) return userData.email.split('@')[0];
  return 'Utilisateur';
}

function _tmComputeInitials(fullName) {
  if (!fullName) return '?';
  var parts = String(fullName).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function _tmComputeShortName(fullName) {
  if (!fullName) return '?';
  return String(fullName).trim().split(/\s+/)[0];
}

function _tmComputeBaseSlug(userData) {
  // Blacklist d'emails génériques qui ne donnent pas un bon slug
  // (contact@, hello@, info@, etc. → on préfère utiliser fullName).
  const GENERIC_LOCAL_PARTS = ['contact', 'hello', 'info', 'admin', 'noreply', 'no-reply', 'support', 'team', 'sales', 'office'];

  // Préfère email local-part SAUF si c'est générique, sinon fullName, sinon uid tronqué
  var base;
  if (userData.email) {
    var localPart = userData.email.split('@')[0].toLowerCase();
    if (GENERIC_LOCAL_PARTS.indexOf(localPart) >= 0) {
      // Email générique → utilise fullName/displayName à la place
      base = _tmComputeFullName(userData).toLowerCase();
    } else {
      base = localPart;
    }
  } else {
    base = _tmComputeFullName(userData).toLowerCase();
  }
  // Normalise : retire accents, espaces, garde [a-z0-9_-]
  return base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'user';
}

function _tmFindFreeSlug(existingMembers, baseSlug, fullName) {
  var existing = {};
  (existingMembers || []).forEach(function(m) {
    if (m && m.slug) existing[m.slug.toLowerCase()] = true;
  });

  if (!existing[baseSlug]) return baseSlug;

  // Tente avec initiale du nom de famille
  var parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length >= 2) {
    var withLast = baseSlug + parts[parts.length - 1][0].toLowerCase();
    if (!existing[withLast]) return withLast;
  }

  // Sinon suffixe numérique
  var i = 2;
  while (existing[baseSlug + i] && i < 100) i++;
  return baseSlug + i;
}

function _tmPickColor(existingMembers) {
  var used = {};
  (existingMembers || []).forEach(function(m) {
    if (m && m.color) used[m.color.toLowerCase()] = true;
  });
  // Première couleur libre dans la palette
  for (var i = 0; i < _TM_PALETTE.length; i++) {
    if (!used[_TM_PALETTE[i].toLowerCase()]) return _TM_PALETTE[i];
  }
  // Sinon round-robin par taille
  return _TM_PALETTE[(existingMembers || []).length % _TM_PALETTE.length];
}

async function _tmSyncFromUser(uid, userData, isCreate) {
  if (!userData || !userData.role) {
    console.log('[tmSync] ' + uid + ' : pas de rôle, skip');
    return;
  }

  const tmRef = db.collection('_meta').doc('team_members');
  // Transaction pour éviter les races (deux user updates simultanés)
  return db.runTransaction(async (tx) => {
    const tmSnap = await tx.get(tmRef);
    const data = tmSnap.exists ? tmSnap.data() : {};
    const members = Array.isArray(data.members) ? data.members.slice() : [];

    // Cherche par firebaseUid prioritairement, sinon par email
    let idx = -1;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (!m) continue;
      if (m.firebaseUid && m.firebaseUid === uid) { idx = i; break; }
    }
    if (idx < 0 && userData.email) {
      const emailLower = String(userData.email).toLowerCase();
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (m && m.email && String(m.email).toLowerCase() === emailLower) { idx = i; break; }
      }
    }

    const fullName = _tmComputeFullName(userData);

    if (idx < 0) {
      // ─── Création nouvelle entrée ───
      const baseSlug = _tmComputeBaseSlug(userData);
      const slug = _tmFindFreeSlug(members, baseSlug, fullName);
      const color = _tmPickColor(members);
      const role = userData.role || 'sales';
      const newMember = {
        firebaseUid: uid,
        email: userData.email || '',
        fullName: fullName,
        shortName: _tmComputeShortName(fullName),
        initials: _tmComputeInitials(fullName),
        slug: slug,
        color: color,
        role: role,
        active: true,
        // Présence dans les modules : par défaut, sales+admin sont dans
        // Lead Live (pipeline, dialer, etc.). Les coachs en sont exclus
        // mais restent mentionnables (pour les vocaux dans le module
        // coaching à venir). Override manuel possible côté Firestore.
        inLeadsModule: (role === 'coach') ? false : true,
        createdAt: new Date().toISOString()
      };
      // Hérite de quelques flags si présents sur users/
      if (userData.canPassCalls === true) newMember.canPassCalls = true;
      if (userData.signaturesAccess === true) newMember.signaturesAccess = true;

      members.push(newMember);
      tx.set(tmRef, { members: members, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log('[tmSync] CRÉATION ' + slug + ' (' + fullName + ', ' + color + ', ' + newMember.role + ')');
    } else {
      // ─── Update : aligne uniquement les champs miroir stricts ───
      const cur = members[idx];
      const updated = Object.assign({}, cur);
      let changed = false;

      // Alignement strict : firebaseUid + email
      _TM_MIRRORED_FIELDS.forEach((f) => {
        const newVal = (f === 'firebaseUid') ? uid : userData[f];
        if (newVal !== undefined && newVal !== null && newVal !== updated[f]) {
          updated[f] = newVal;
          changed = true;
        }
      });

      // Règle (a) — fullName : on ne remplace QUE si la nouvelle version
      // est plus longue (ou si team_members n'avait rien posé).
      // Évite que "Élodie Vidotto Siarri" → "Elodie" via users/.
      if (fullName && fullName.length > (updated.fullName || '').length) {
        updated.fullName = fullName;
        changed = true;
      }

      // Règle (b) — role : NE JAMAIS écraser sur update. Le role dans
      // team_members peut être un libellé métier custom ("Closing",
      // "Setting", "Head of Sales") différent du role technique users/.
      // On ne pose que si vide.
      if (!updated.role && userData.role) {
        updated.role = userData.role;
        changed = true;
      }

      // Règle (c) — propagation archivage users.status → team_members.
      // Si users/{uid}.status === 'archived' et team_members.active !== false,
      // on aligne automatiquement : active=false + archivedAt + retire de tous
      // les modules. Évite qu'un user archivé continue de recevoir des leads,
      // d'apparaître dans les pills, etc.
      // Inverse : si users.status redevient actif et team_members est archivé,
      // on NE désarchive PAS automatiquement (action volontaire admin requise
      // pour ré-activer un membre).
      if (userData.status === 'archived' && updated.active !== false) {
        updated.active = false;
        updated.archivedAt = updated.archivedAt || new Date().toISOString();
        updated.inLeadsModule = false;
        updated.eligibleForLeads = false;
        changed = true;
        console.log('[tmSync] ' + (cur.slug || uid) + ' archivé via users.status');
      }

      // Champs computés non-préservés (initials/shortName) → recalculés si fullName a changé
      // mais SEULEMENT s'ils ne sont pas explicitement préservés. Note : ils SONT dans
      // _TM_PRESERVED_FIELDS, donc on ne les touche pas. C'est volontaire — l'admin a
      // pu personnaliser les initiales (ex: "AE" au lieu de "A").

      if (!changed) {
        console.log('[tmSync] ' + (cur.slug || uid) + ' : déjà à jour, skip');
        return;
      }

      members[idx] = updated;
      tx.set(tmRef, { members: members, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log('[tmSync] UPDATE ' + (cur.slug || uid) + ' : ' + Object.keys(updated).filter((k) => updated[k] !== cur[k]).join(', '));
    }
  });
}

exports.onUserSyncToTeamMembers = functions.firestore
  .document('users/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid;

    // Suppression user → on ne supprime PAS team_members (l'archivage manuel
    // reste nécessaire pour préserver l'historique et les data leads/coaching).
    if (!change.after.exists) {
      console.log('[tmSync] user ' + uid + ' supprimé — team_members non touché (archivage manuel requis)');
      return null;
    }

    const newData = change.after.data();
    const oldData = change.before.exists ? change.before.data() : null;
    const isCreate = !change.before.exists;

    // Si update et que rien de pertinent n'a changé, skip pour éviter les loops
    if (!isCreate && oldData) {
      const fieldsToWatch = ['email', 'fullName', 'displayName', 'firstName', 'lastName', 'role', 'status', 'canPassCalls', 'signaturesAccess'];
      const changed = fieldsToWatch.some((f) => oldData[f] !== newData[f]);
      if (!changed) return null;
    }

    try {
      await _tmSyncFromUser(uid, newData, isCreate);
    } catch (e) {
      console.error('[tmSync] error pour ' + uid + ' :', e.message);
    }
    return null;
  });

/* ════════════════════════════════════════════════════════════════
   HELPER — Création d'une facture team depuis un payment GoCardless
   ════════════════════════════════════════════════════════════════
   
   Source unique et atomique de création de factures.
   Déclenchée par le webhook gocardless_event sur payments.paid_out.
   Aussi appelée par /api/admin-gocardless-sync (rattrapage manuel).
   
   Flux :
     1. Idempotence : si invoice avec ce gcPaymentId existe (non archivée)
        → skip et retourne le doc existant
     2. Fetch GC /payments/{id} → amount, charge_date, links
     3. Fetch GC /mandates/{id} → customer_id
     4. Find/create invoice_clients via gcCustomerId
     5. Crée draft + appelle invoice-validate (numérotation + PDF)
        - Si PDF échoue : facture quand même validated avec pdfPending=true
     6. Mark paid avec gcPaymentId
     7. Incrémente paidCount + paymentsHistory sur le doc payments lié
   ════════════════════════════════════════════════════════════════ */

const _GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
const _GC_VERSION = '2015-07-06';

async function _gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const _fetch = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  const resp = await _fetch(_GC_BASE + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'GoCardless-Version': _GC_VERSION,
      'Accept': 'application/json',
    },
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error('GC ' + resp.status + ' on ' + path + ': ' + JSON.stringify(json.error || json));
  return json;
}

function _lowerEmail(s) { return (s || '').toString().trim().toLowerCase(); }

function _parseContactName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Trouve un invoice_clients existant par gcCustomerId, ou en crée un nouveau
 * en récupérant l'info depuis GoCardless /customers/{id}.
 */
async function _findOrCreateInvoiceClient(gcCustomerId) {
  if (!gcCustomerId) throw new Error('gcCustomerId requis');

  /* Recherche existant (deux noms de champ pour rétrocompat) */
  let snap = await db.collection('invoice_clients').where('gcCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
  snap = await db.collection('invoice_clients').where('gocardlessCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());

  /* Pas trouvé → fetch GC customer et crée */
  const gcResp = await _gcGet('/customers/' + gcCustomerId);
  if (!gcResp || !gcResp.customers) {
    throw new Error('Customer GC introuvable : ' + gcCustomerId);
  }
  const c = gcResp.customers;
  const email = _lowerEmail(c.email);
  const companyName = c.company_name || '';
  const givenName = c.given_name || '';
  const familyName = c.family_name || '';
  const clientType = companyName ? 'company' : 'individual';

  /* Recherche secondaire par email (cas où l'invoice_clients existe sans gcCustomerId) */
  if (email) {
    const emailSnap = await db.collection('invoice_clients').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      const existing = Object.assign({ id: emailSnap.docs[0].id }, emailSnap.docs[0].data());
      /* Lier le gcCustomerId à cette fiche existante */
      await db.collection('invoice_clients').doc(existing.id).update({
        gcCustomerId: gcCustomerId,
        gocardlessCustomerId: gcCustomerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      existing.gcCustomerId = gcCustomerId;
      existing.gocardlessCustomerId = gcCustomerId;
      return existing;
    }
  }

  /* Crée un nouvel invoice_clients */
  const newIc = {
    clientType: clientType,
    companyName: companyName,
    companyLegalForm: '',
    companyRcs: '',
    contactFirstName: givenName,
    contactLastName: familyName,
    email: email,
    telephone: c.phone_number || '',
    phone: c.phone_number || '',
    siret: '',
    vatNumber: '',
    vatExempt: false,
    address: {
      line1: c.address_line1 || '',
      line2: c.address_line2 || '',
      postalCode: c.postal_code || '',
      city: c.city || '',
      country: c.country_code === 'FR' ? 'France' : (c.country_code || 'France'),
    },
    gcCustomerId: gcCustomerId,
    gocardlessCustomerId: gcCustomerId,
    salesOwner: null,
    personId: null,
    archived: false,
    _needsAddressCompletion: !(c.address_line1 && c.city),
    _autoCreatedFromGc: true,
    _autoCreatedFromGcAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _createdBy: 'cf:createInvoiceFromGcPayment',
  };
  const ref = await db.collection('invoice_clients').add(newIc);
  console.log('[createInvoiceFromGcPayment] invoice_clients auto-créé : ' + ref.id + ' pour gcCustomerId=' + gcCustomerId);
  return Object.assign({ id: ref.id }, newIc);
}

function _round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

/**
 * Création d'une facture team à partir d'un GC payment ID.
 * Idempotent : si une facture (non archivée) avec ce gcPaymentId existe → retourne {success:true, skipped:true}.
 *
 * @param {string} gcPaymentId - ID GoCardless du payment (PM000...)
 * @param {DocumentReference|null} paymentRef - Ref du doc payments Firestore (optionnel, pour update paidCount)
 * @returns {Promise<{success, invoiceId?, number?, skipped?, reason?}>}
 */
async function createInvoiceFromGcPayment(gcPaymentId, paymentRef) {
  if (!gcPaymentId) throw new Error('gcPaymentId requis');

  /* ── 1. Idempotence ── */
  const existSnap = await db.collection('invoices').where('gcPaymentId', '==', gcPaymentId).limit(2).get();
  let existingNonArchived = null;
  existSnap.forEach(function(d) {
    if (!existingNonArchived && d.data()._archived !== true) {
      existingNonArchived = Object.assign({ id: d.id }, d.data());
    }
  });
  if (existingNonArchived) {
    return {
      success: true,
      skipped: true,
      reason: 'invoice_exists',
      invoiceId: existingNonArchived.id,
      number: existingNonArchived.number,
    };
  }

  /* ── 2. Fetch GC payment ── */
  const payResp = await _gcGet('/payments/' + gcPaymentId);
  if (!payResp || !payResp.payments) {
    throw new Error('Payment GC introuvable : ' + gcPaymentId);
  }
  const gcPayment = payResp.payments;
  const amountTtc = (gcPayment.amount || 0) / 100;
  if (amountTtc <= 0) throw new Error('amount invalide : ' + gcPayment.amount);

  const chargeDateStr = gcPayment.charge_date || new Date().toISOString().substring(0, 10);
  const mandateId = gcPayment.links && gcPayment.links.mandate;
  const subscriptionGcId = gcPayment.links && gcPayment.links.subscription;
  if (!mandateId) throw new Error('Payment GC sans mandate : ' + gcPaymentId);

  /* ── 3. Fetch mandate pour customer ── */
  const mandateResp = await _gcGet('/mandates/' + mandateId);
  if (!mandateResp || !mandateResp.mandates) {
    throw new Error('Mandate GC introuvable : ' + mandateId);
  }
  const gcCustomerId = mandateResp.mandates.links && mandateResp.mandates.links.customer;
  if (!gcCustomerId) throw new Error('Mandate sans customer : ' + mandateId);

  /* Filter EI customers — _config/billing.eiCustomerIds */
  const billingSnap = await db.collection('_config').doc('billing').get();
  const billing = billingSnap.exists ? billingSnap.data() : {};
  const eiCustomerIds = Array.isArray(billing.eiCustomerIds) ? billing.eiCustomerIds : [];
  if (eiCustomerIds.indexOf(gcCustomerId) >= 0) {
    return { success: true, skipped: true, reason: 'ei_customer', gcCustomerId: gcCustomerId };
  }

  /* ── 4. Find or auto-create invoice_clients ── */
  const client = await _findOrCreateInvoiceClient(gcCustomerId);

  /* ── 5. Description : ordre de priorité
        1. gcPayment.description (libellé que voit le client sur son relevé bancaire)
        2. Template subscription Firestore
        3. Description du doc payments Firestore (one-shot)
        4. Fallback générique ── */
  let firestoreSub = null;
  let description = '';
  const gcPaymentDescription = (gcPayment.description || '').trim();

  if (subscriptionGcId) {
    const subSnap = await db.collection('subscriptions').where('gcSubscriptionId', '==', subscriptionGcId).limit(1).get();
    if (!subSnap.empty) {
      firestoreSub = Object.assign({ id: subSnap.docs[0].id }, subSnap.docs[0].data());
    }
  }

  if (gcPaymentDescription) {
    description = gcPaymentDescription;
  } else if (firestoreSub) {
    const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dt = new Date(chargeDateStr + 'T12:00:00');
    const tpl = firestoreSub.descriptionTemplate || (firestoreSub.description || 'Mensualité {month_name} {year}');
    description = tpl
      .replace(/\{month_name\}/g, FR_MONTHS[dt.getMonth()])
      .replace(/\{month_number\}/g, String(dt.getMonth() + 1).padStart(2, '0'))
      .replace(/\{year\}/g, dt.getFullYear())
      .replace(/\{installment\}/g, String((firestoreSub.installmentsPaidOnGC || 0) + 1))
      .replace(/\{total\}/g, firestoreSub.totalInstallments != null ? String(firestoreSub.totalInstallments) : '?');
  } else if (subscriptionGcId) {
    description = 'Mensualité ' + chargeDateStr;
  } else if (paymentRef) {
    try {
      const pSnap = await paymentRef.get();
      if (pSnap.exists && pSnap.data().description) description = pSnap.data().description;
    } catch (_) {}
    if (!description) description = 'Paiement intégral';
  } else {
    description = 'Paiement intégral';
  }

  /* ── 6. Calcul TVA (TTC ref, retro-calcul HT) ── */
  const vatRate = client.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
  const unitPriceHt = _round2(amountTtc / (1 + vatRate / 100));

  const line = {
    productId: null,
    variantId: null,
    productName: '',
    variantLabel: '',
    description: description,
    unit: 'forfait',
    qty: 1,
    unitPriceHt: unitPriceHt,
    vatRate: vatRate,
    discountPct: 0,
  };
  const lineHt = _round2(line.qty * line.unitPriceHt);
  const lineVat = _round2(lineHt * vatRate / 100);
  const lineTtc = _round2(lineHt + lineVat);
  line.lineHtBeforeDiscount = lineHt;
  line.discountAmount = 0;
  line.lineHtAfterDiscount = lineHt;
  line.lineVat = lineVat;
  line.lineTtc = lineTtc;

  const vatBreakdown = vatRate > 0
    ? [{ rate: vatRate, base: lineHt, vat: lineVat }]
    : [{ rate: 0, base: lineHt, vat: 0 }];

  const clientSnapshot = {
    /* 100 % B2B : aucun client particulier. Un défaut à 'individual'
       produirait une facture jamais transmise sur le réseau e-invoicing
       (voir sendByEinvoice dans api/_qonto-invoice-flow.js), sans erreur.
       NB : cette correction ne prendra effet qu'au prochain déploiement des
       Cloud Functions, aujourd'hui bloqué. Sans impact tant que toutes les
       fiches portent un clientType explicite. */
    clientType: client.clientType || 'company',
    companyName: client.companyName || '',
    contactFirstName: client.contactFirstName || '',
    contactLastName: client.contactLastName || '',
    email: client.email || '',
    phone: client.phone || client.telephone || '',
    siret: client.siret || '',
    vatNumber: client.vatNumber || '',
    vatExempt: !!client.vatExempt,
    address: Object.assign({ line1: '', line2: '', postalCode: '', city: '', country: 'France' },
      client.address || {}),
  };

  /* ── 7. Création draft ── */
  const paymentTermsDays = billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30;
  const draftDoc = {
    status: 'draft',
    paymentTermsDays: paymentTermsDays,
    paymentMethod: 'gocardless',
    poNumber: '',
    clientId: client.id,
    clientSnapshot: clientSnapshot,
    issuerSnapshot: null,
    cgvSnapshot: null,
    lines: [line],
    totalGrossHt: lineHt,
    totalDiscount: 0,
    totalHt: lineHt,
    totalVat: lineVat,
    totalTtc: lineTtc,
    vatBreakdown: vatBreakdown,
    notesPublic: 'Paiement reçu via GoCardless le ' + chargeDateStr + '.',
    notesInternal: 'Facture auto-générée par webhook GC paid_out — payment ' + gcPaymentId,
    linkedPaymentId: paymentRef ? paymentRef.id : null,
    linkedSubscriptionId: firestoreSub ? firestoreSub.id : null,
    gcPaymentId: gcPaymentId,
    gcMandateId: mandateId,
    gcCustomerId: gcCustomerId,
    gcSubscriptionId: subscriptionGcId || null,
    pdfHash: null,
    isLocked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: 'cf:webhook',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'cf:webhook',
    _autoGenerated: true,
    _autoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    _autoGeneratedFromGc: true,
    /* ── CONTRÔLE MANUEL (2026-05-29) : brouillon en attente de validation ── */
    _pendingValidation: true,
    gcChargeDate: chargeDateStr,
    suggestedPaidAmount: amountTtc,
  };
  const draftRef = await db.collection('invoices').add(draftDoc);
  const invoiceId = draftRef.id;

  /* ── 8 & 9. CONTRÔLE MANUEL (2026-05-29) ─────────────────────────────────
     On NE valide PLUS et on NE marque PLUS payée automatiquement.
     La facture reste un BROUILLON (_pendingValidation:true) en attente de
     validation manuelle dans admin-facturation.html → onglet « À valider ».
     Steps 10 & 11 (avancement GC) conservés : un paid_out est un fait. */
  const invoiceNumber = null;
  const pdfPending = false;
  const paidAtTs = admin.firestore.Timestamp.fromDate(new Date(chargeDateStr + 'T12:00:00'));

  /* ── 10. Update doc payments Firestore (paidCount + paymentsHistory) ── */
  if (paymentRef) {
    try {
      const pSnap = await paymentRef.get();
      if (pSnap.exists) {
        const pData = pSnap.data();
        const alreadyRecorded = Array.isArray(pData.paymentsHistory)
          && pData.paymentsHistory.some(function(h) { return h && h.gcPaymentId === gcPaymentId; });
        if (!alreadyRecorded) {
          await paymentRef.update({
            paidCount: admin.firestore.FieldValue.increment(1),
            paidAmount: admin.firestore.FieldValue.increment(amountTtc),
            paymentsHistory: admin.firestore.FieldValue.arrayUnion({
              amount: amountTtc,
              date: chargeDateStr,
              gcPaymentId: gcPaymentId,
              status: 'paid_out',
              invoiceId: invoiceId,
              invoiceNumber: invoiceNumber,
              eventAt: new Date().toISOString(),
            }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (e) {
      console.warn('[createInvoiceFromGcPayment] payments doc update failed: ' + e.message);
    }
  }

  /* ── 11. Update subscription Firestore (installmentsPaidOnGC++) ── */
  if (firestoreSub) {
    try {
      await db.collection('subscriptions').doc(firestoreSub.id).update({
        installmentsPaidOnGC: admin.firestore.FieldValue.increment(1),
        lastPaidGcPaymentId: gcPaymentId,
        lastPaidAt: paidAtTs,
        lastPaidInvoiceId: invoiceId,
        lastPaidInvoiceNumber: invoiceNumber,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[createInvoiceFromGcPayment] subscription update failed: ' + e.message);
    }
  }

  return {
    success: true,
    invoiceId: invoiceId,
    number: invoiceNumber,
    amount: amountTtc,
    chargeDate: chargeDateStr,
    gcPaymentId: gcPaymentId,
    pdfPending: pdfPending,
    clientId: client.id,
    clientName: client.companyName || ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')).trim() || client.email,
  };
}

/* ════════════════════════════════════════════════════════════════
   ⚠️ STEP 3 — onPaymentChange — DÉSACTIVÉ (2026-05-27)
   ════════════════════════════════════════════════════════════════
   La création de facture est désormais TOTALEMENT pilotée par le
   webhook gocardless_event (createInvoiceFromGcPayment).
   
   Step 3 ne se déclenchera plus parce qu'on retire l'export.
   La fonction reste en code pour reference / rollback éventuel.
   ════════════════════════════════════════════════════════════════ */

const _DEPRECATED_onPaymentChange = functions
  .runWith({ memory: '256MB', timeoutSeconds: 60 })
  .firestore.document('payments/{paymentId}')
  .onUpdate(async (change, context) => {
    const paymentId = context.params.paymentId;
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    /* Détection : paidCount qui augmente = nouveau(x) paiement(s) GC reçu(s) */
    const beforeCount = before.paidCount || 0;
    const afterCount = after.paidCount || 0;
    if (afterCount <= beforeCount) return null;

    /* Lock anti-retrigger (en cas d'updates multiples sur le même doc) */
    const lastProcessed = after._step3LastProcessedPaidCount || 0;
    if (lastProcessed >= afterCount) return null;

    /* Vérification du toggle d'activation */
    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};
    if (!billing.autoPaymentLinking) {
      console.log('[step3] auto-linking OFF — payment ' + paymentId + ' skip (mais marqué processed)');
      /* On marque quand même pour éviter le re-traitement quand on activera : sinon
         à l'activation, tous les payments existants seraient retraités d'un coup */
      await change.after.ref.update({
        _step3LastProcessedPaidCount: afterCount,
      });
      return null;
    }

    /* Récupérer les nouveaux paiements depuis paymentsHistory[] */
    const history = after.paymentsHistory || [];
    const newPayments = history.slice(beforeCount, afterCount);

    if (!newPayments.length) {
      console.warn('[step3] paidCount augmenté (' + beforeCount + ' → ' + afterCount +
        ') mais paymentsHistory vide pour ' + paymentId);
      return null;
    }

    console.log('[step3] ' + newPayments.length + ' nouveau(x) paiement(s) à traiter pour ' + paymentId);

    for (let i = 0; i < newPayments.length; i++) {
      try {
        await _step3ProcessNewPayment(after, newPayments[i], paymentId);
      } catch (err) {
        console.error('[step3] Erreur traitement paiement #' + i + ' du doc ' + paymentId, err);
        await _step3FlagAlert('processing_error', {
          paymentId: paymentId,
          gcPaymentId: newPayments[i].gcPaymentId || null,
          amount: newPayments[i].amount || null,
          error: String(err.message || err).substring(0, 500),
        });
      }
    }

    /* Mark all as processed */
    await change.after.ref.update({
      _step3LastProcessedPaidCount: afterCount,
      _step3LastProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return null;
  });

async function _step3ProcessNewPayment(paymentDoc, newPay, paymentId) {
  const gcCustomerId = paymentDoc.gcCustomerId || paymentDoc.gocardlessCustomerId;
  const amount = parseFloat(newPay.amount);
  const gcPaymentId = newPay.gcPaymentId;
  const paidDate = newPay.date; /* "YYYY-MM-DD" */

  if (!gcCustomerId) {
    return await _step3FlagAlert('missing_gc_customer_id', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, amount: amount,
    });
  }
  if (isNaN(amount) || amount <= 0) {
    return await _step3FlagAlert('invalid_payment_amount', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, amount: newPay.amount,
    });
  }

  /* 1. Trouver le invoice_client via gocardlessCustomerId */
  const clientsSnap = await db.collection('invoice_clients')
    .where('gocardlessCustomerId', '==', gcCustomerId)
    .limit(5)
    .get();

  /* Filtrer les archivés côté code (where '!=' ne match pas l'absence du champ) */
  const candidateClients = [];
  clientsSnap.forEach(function(d) {
    const data = d.data();
    if (data.archived !== true) {
      candidateClients.push({ id: d.id, data: data });
    }
  });

  if (!candidateClients.length) {
    return await _step3FlagAlert('no_invoice_client_for_gc', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, gcCustomerId: gcCustomerId, amount: amount,
    });
  }
  if (candidateClients.length > 1) {
    return await _step3FlagAlert('multiple_invoice_clients_for_gc', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, gcCustomerId: gcCustomerId, amount: amount,
      candidateClientIds: candidateClients.map(function(c){ return c.id; }),
    });
  }

  const clientId = candidateClients[0].id;

  /* 2. Trouver les factures du client en attente de paiement */
  const validatedSnap = await db.collection('invoices')
    .where('clientId', '==', clientId)
    .where('status', '==', 'validated')
    .get();
  const sentSnap = await db.collection('invoices')
    .where('clientId', '==', clientId)
    .where('status', '==', 'sent')
    .get();

  const allInvoices = [];
  validatedSnap.forEach(function(d) {
    const inv = d.data(); inv.id = d.id; inv.ref = d.ref;
    allInvoices.push(inv);
  });
  sentSnap.forEach(function(d) {
    const inv = d.data(); inv.id = d.id; inv.ref = d.ref;
    allInvoices.push(inv);
  });

  /* Filtrer par totalTtc === amount (tolérance 1 centime) */
  const matches = allInvoices.filter(function(inv) {
    const ttc = parseFloat(inv.totalTtc || 0);
    return Math.abs(ttc - amount) < 0.01;
  });

  if (matches.length === 0) {
    return await _step3FlagAlert('no_invoice_match', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, clientId: clientId, amount: amount,
      hint: 'Aucune facture validated/sent du client avec ce montant TTC',
      availableInvoicesCount: allInvoices.length,
    });
  }

  /* Sort par dueDate ASC pour appliquer le FIFO (plus ancienne en premier) */
  matches.sort(function(a, b) {
    const aDue = (a.dueDate && a.dueDate.toMillis) ? a.dueDate.toMillis()
      : (a.issueDate && a.issueDate.toMillis ? a.issueDate.toMillis() : 0);
    const bDue = (b.dueDate && b.dueDate.toMillis) ? b.dueDate.toMillis()
      : (b.issueDate && b.issueDate.toMillis ? b.issueDate.toMillis() : 0);
    return aDue - bDue;
  });
  const selected = matches[0];

  /* 3. Mark facture comme paid */
  let paidAtTs;
  if (paidDate) {
    const dt = new Date(paidDate);
    paidAtTs = isNaN(dt.getTime())
      ? admin.firestore.Timestamp.now()
      : admin.firestore.Timestamp.fromDate(dt);
  } else {
    paidAtTs = admin.firestore.Timestamp.now();
  }

  await selected.ref.update({
    status: 'paid',
    paidAt: paidAtTs,
    paidAmount: amount,
    paidVia: 'gocardless',
    paymentRef: gcPaymentId || paymentId,
    paidBy: 'auto_step3',
    paidByEmail: 'system',
    paidMarkedAt: admin.firestore.FieldValue.serverTimestamp(),
    timeline: admin.firestore.FieldValue.arrayUnion({
      type: 'invoice_auto_paid',
      at: new Date().toISOString(),
      source: 'gocardless',
      paymentDocId: paymentId,
      gcPaymentId: gcPaymentId || null,
      amount: amount,
    }),
  });

  console.log('[step3] ✅ Facture ' + selected.id + ' (' + (selected.number || '—') +
    ') marquée payée auto via GC paiement ' + gcPaymentId);

  /* Logging info uniquement si plusieurs candidats — utile pour audit */
  if (matches.length > 1) {
    await _step3FlagAlert('multiple_invoice_matches_resolved', {
      paymentId: paymentId, gcPaymentId: gcPaymentId, clientId: clientId, amount: amount,
      selectedInvoiceId: selected.id,
      candidateIds: matches.map(function(m){ return m.id; }),
      severity: 'info',
      hint: 'Plusieurs factures candidates, sélection FIFO (plus ancienne)',
    });
  }
}

async function _step3FlagAlert(type, data) {
  const alertDoc = Object.assign({}, data, {
    type: type,
    severity: data.severity || 'warning',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolved: false,
  });
  await db.collection('_alerts').doc('billing').collection('items').add(alertDoc);
  if (alertDoc.severity === 'info') {
    console.log('[step3] ALERT (info) ' + type, JSON.stringify(data));
  } else {
    console.warn('[step3] ALERT ' + type, JSON.stringify(data));
  }
}
/* ════════════════════════════════════════════════════════════════
   STEP 4B — Génération automatique des factures depuis subscriptions
   ════════════════════════════════════════════════════════════════
   À INSÉRER à la fin de ~/Functions/index.js Cloud Shell (après Step 3).

   Trigger : Pub/Sub schedule "every day 06:00" Europe/Paris.
   
   Flux :
     1. Lire _config/billing.autoSubscriptionGeneration. Si false → skip.
     2. Lire _config/system_keys.invoiceGeneration. Si manquante → log + skip.
     3. Query subscriptions where status='active' AND nextScheduledAt <= now.
     4. Pour chaque due :
        - Si overdue > 3 jours → alerte 'subscription_overdue', ne génère pas
        - Sinon → POST sur /api/subscription-generate-invoice avec x-system-key
          (qui crée le draft + appelle invoice-validate pour numérotation+PDF)
        - Log success/failure
     5. Stats finales loggées.
   
   Toggle : _config/billing.autoSubscriptionGeneration === true
   Clé sys : _config/system_keys.invoiceGeneration (générée 1x manuellement)
   Base URL Vercel : _config/billing.publicBaseUrl (ex: "https://team.alteore.com")
                     ou fallback sur 'https://team.alteore.com'
   ════════════════════════════════════════════════════════════════ */

/* require node-fetch ou utiliser fetch global selon version Node */
const _step4bFetch = (typeof fetch !== 'undefined') ? fetch : null;

/* ════════════════════════════════════════════════════════════════
   ⚠️ STEP 4B — scheduledInvoiceGenerator — DÉSACTIVÉ (2026-05-27)
   ════════════════════════════════════════════════════════════════
   Le cron qui générait les factures "en avance" pour les subscriptions
   est désactivé. Les factures sont maintenant créées UNIQUEMENT à la
   réception du paiement GC (webhook gocardless_event paid_out).
   
   La fonction reste en code pour reference / rollback éventuel.
   ════════════════════════════════════════════════════════════════ */

const _DEPRECATED_scheduledInvoiceGenerator = functions
  .runWith({ memory: '256MB', timeoutSeconds: 540 })
  .pubsub.schedule('every day 06:00')
  .timeZone('Europe/Paris')
  .onRun(async (context) => {
    const stats = {
      scanned: 0,
      generated: 0,
      skippedToggleOff: 0,
      skippedOverdue: 0,
      skippedCompleted: 0,
      errors: 0,
    };

    /* 1. Toggle d'activation */
    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};
    if (!billing.autoSubscriptionGeneration) {
      console.log('[step4b] auto-generation OFF — skip');
      stats.skippedToggleOff = 1;
      return null;
    }

    /* 2. Clé système */
    const keysSnap = await db.collection('_config').doc('system_keys').get();
    const systemKey = keysSnap.exists ? keysSnap.data().invoiceGeneration : null;
    if (!systemKey) {
      console.error('[step4b] _config/system_keys.invoiceGeneration manquante — abort');
      await _step4bFlagAlert('missing_system_key', {
        hint: 'Crée _config/system_keys avec champ invoiceGeneration (32 hex chars min)',
      });
      return null;
    }

    /* 3. Base URL Vercel */
    const baseUrl = (billing.publicBaseUrl || 'https://team.alteore.com').replace(/\/$/, '');
    const generateUrl = baseUrl + '/api/subscription-generate-invoice';

    /* 4. Query subscriptions dues */
    const now = new Date();
    const overdueCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); /* 3 jours en arrière */

    const subsSnap = await db.collection('subscriptions')
      .where('status', '==', 'active')
      .where('nextScheduledAt', '<=', admin.firestore.Timestamp.fromDate(now))
      .get();

    console.log('[step4b] ' + subsSnap.size + ' subscription(s) due(s) — cutoff overdue=' + overdueCutoff.toISOString());

    for (const doc of subsSnap.docs) {
      stats.scanned++;
      const subId = doc.id;
      const sub = doc.data();
      const tag = '[' + subId.substring(0, 8) + ']';

      try {
        /* Cap totalInstallments → mark completed */
        const generated = sub.installmentsGenerated || 0;
        const total = sub.totalInstallments;
        if (total != null && generated >= total) {
          console.log(tag + ' SKIP — installmentsGenerated atteint (' + generated + '/' + total + ') → completed');
          await doc.ref.update({
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          stats.skippedCompleted++;
          continue;
        }

        /* Détection overdue (> 3 jours dans le passé) */
        const nextSched = sub.nextScheduledAt && sub.nextScheduledAt.toDate
          ? sub.nextScheduledAt.toDate()
          : null;

        /* PATCH 2026-05-12 : Exemption du garde-fou 3j pour les subs issues
           de la migration step4a qui n'ont jamais été facturées par team.
           Ces subs ont nextScheduledAt naturellement dans le passé (calculé
           en "last_payment_plus_one_month") et resteraient bloquées sinon.
           Une fois la 1ère facture générée, installmentsGenerated passe à 1
           et le garde-fou reprend pour les cycles suivants. */
        const _isMigrationCatchUp = sub._startDateSource === 'from_history'
          && (sub.installmentsGenerated || 0) === 0;

        if (nextSched && nextSched < overdueCutoff && !_isMigrationCatchUp) {
          console.warn(tag + ' OVERDUE — nextScheduledAt=' + nextSched.toISOString() + ' (>' + 3 + 'j passés) → alerte');
          await _step4bFlagAlert('subscription_overdue', {
            subscriptionId: subId,
            clientId: sub.clientId,
            leadName: sub.leadName,
            nextScheduledAt: nextSched.toISOString(),
            daysPast: Math.round((now - nextSched) / (24 * 60 * 60 * 1000)),
            installmentsGenerated: generated,
            totalInstallments: total,
            hint: 'Subscription due depuis plus de 3 jours. Vérifier mandat GC actif et nextScheduledAt à jour.',
          });
          stats.skippedOverdue++;
          continue;
        }

        if (_isMigrationCatchUp && nextSched && nextSched < overdueCutoff) {
          console.log(tag + ' MIGRATION CATCH-UP — _startDateSource=from_history + installmentsGenerated=0 → génère malgré overdue (' +
            Math.round((now - nextSched) / (24 * 60 * 60 * 1000)) + 'j de retard)');
        }

        /* Générer la facture via endpoint Vercel */
        const resp = await _step4bFetch(generateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-system-key': systemKey,
          },
          body: JSON.stringify({ subscriptionId: subId }),
        });

        let data = {};
        try { data = await resp.json(); } catch (_) {}

        if (!resp.ok) {
          console.error(tag + ' GEN FAILED — HTTP ' + resp.status + ' : ' + (data.error || 'unknown'));
          await _step4bFlagAlert('generation_failed', {
            subscriptionId: subId,
            clientId: sub.clientId,
            httpStatus: resp.status,
            error: (data.error || 'unknown').substring(0, 500),
          });
          stats.errors++;
          continue;
        }

        if (data.completed) {
          console.log(tag + ' COMPLETED — toutes mensualités déjà générées');
          stats.skippedCompleted++;
        } else {
          console.log(tag + ' ✅ GENERATED — facture ' + data.number +
            ' (' + (generated + 1) + '/' + (total || '?') + ')');
          stats.generated++;
        }

      } catch (err) {
        console.error(tag + ' ERROR :', err.message);
        await _step4bFlagAlert('processing_error', {
          subscriptionId: subId,
          error: String(err.message || err).substring(0, 500),
        });
        stats.errors++;
      }
    }

    console.log('[step4b] ════ DONE ════');
    console.log('[step4b] Scannées: ' + stats.scanned +
      ' | Générées: ' + stats.generated +
      ' | Overdue: ' + stats.skippedOverdue +
      ' | Completed: ' + stats.skippedCompleted +
      ' | Erreurs: ' + stats.errors);

    return null;
  });


/* Helper : crée une alerte dans _alerts/billing/items (mêmes shape que Step 3) */
async function _step4bFlagAlert(type, data) {
  const alertDoc = Object.assign({}, data, {
    type: type,
    severity: data.severity || 'warning',
    source: 'step4b',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolved: false,
  });
  try {
    await db.collection('_alerts').doc('billing').collection('items').add(alertDoc);
  } catch (e) {
    console.error('[step4b] Failed to flag alert:', type, e.message);
  }
  console.warn('[step4b] ALERT ' + type, JSON.stringify(data));
}


/* ═══════════════════════════════════════════════════════════════════════
   SYNC INTER-MODULES (Step 3+4+5) — module séparé _sync.js
   6 Cloud Functions ajoutées :
     onPersonsUpdate, onLeadUpdate, onClientUpdate,
     onInvoiceClientUpdate, onPaymentUpdate, onSubscriptionUpdate
   ═══════════════════════════════════════════════════════════════════════ */
Object.assign(exports, require('./_sync'));

/* ── BOUCLIER createdAt (fix « leads qui ne remontent pas » dans Leads Live) ──
   Force createdAt en Timestamp à la création de TOUT lead, quelle que soit la
   source (pont self-booking, écriture Make directe dans /leads/, etc.).
   Trigger additif : cohabite avec onNewLead, ne touche à rien d'autre.
   Idempotent (return immédiat si déjà un Timestamp), pas de boucle. */
exports.normalizeLeadCreatedAt = functions.firestore
  .document("leads/{leadId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const ca = data.createdAt;

    // Cas nominal : déjà un vrai Timestamp → rien à faire.
    if (ca && typeof ca.toMillis === "function") return null;

    function frOrIsoToMs(s) {
      if (typeof s !== "string" || !s.trim()) return null;
      const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,àaT]+(\d{1,2})[:hH](\d{2})(?::(\d{2}))?)?/);
      if (m) {
        const dt = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        if (!isNaN(dt.getTime())) return dt.getTime();
      }
      const p = Date.parse(s);
      return isNaN(p) ? null : p;
    }
    function anyToMs(v) {
      if (v == null) return null;
      if (typeof v.toMillis === "function") { try { return v.toMillis(); } catch (e) { return null; } }
      if (typeof v.seconds === "number") return v.seconds * 1000;
      if (typeof v === "number" && isFinite(v)) return v < 1e12 ? v * 1000 : v;
      if (typeof v === "string") return frOrIsoToMs(v);
      return null;
    }

    let ms = anyToMs(ca);
    let src = "createdAt_value";
    if (ms == null && typeof data.importedCreatedAt === "string") {
      ms = frOrIsoToMs(data.importedCreatedAt);
      if (ms != null) src = "importedCreatedAt";
    }
    if (ms == null && Array.isArray(data.communications)) {
      for (let i = 0; i < data.communications.length; i++) {
        const c = data.communications[i] || {};
        const m = anyToMs(c.createdAt) != null ? anyToMs(c.createdAt) : anyToMs(c.date);
        if (m != null && (ms == null || m < ms)) { ms = m; src = "communications"; }
      }
    }
    if (ms == null) {
      const u = anyToMs(data.updatedAt);
      if (u != null) { ms = u; src = "updatedAt"; }
    }

    const newCreatedAt = ms != null
      ? admin.firestore.Timestamp.fromMillis(ms)
      : admin.firestore.FieldValue.serverTimestamp();
    if (ms == null) src = "now";

    try {
      await snap.ref.update({
        createdAt: newCreatedAt,
        createdAtRepaired: true,
        createdAtRepairSource: src,
        createdAtRepairedBy: "normalizeLeadCreatedAt",
      });
      console.log("[normalizeLeadCreatedAt] createdAt normalisé (" + src + ") pour " + context.params.leadId);
    } catch (e) {
      console.error("[normalizeLeadCreatedAt] " + (e && e.message));
    }
    return null;
  });

/* ── RÉSURRECTION sur ré-engagement (fix « leads qui ne remontent pas ») ──────
   Un seul trigger onUpdate qui couvre les DEUX cas de fiches ré-engagées qui ne
   remontaient pas dans Leads Live :
     A) une communication ENTRANTE est ajoutée à une fiche normale (Ringover,
        Twilio, onWebhookInbox, ou la source SMS externe via Make) ;
     B) un doublon _merged reçoit un re-opt-in (le dédup a posé lastOptinAt sur le
        doublon, que Leads Live masque) → on propage la résurrection à l'ORIGINALE.
   Réutilise le listener lastOptinAt existant (popup/son/badge). Agnostique à la
   source. Anti-spam (debounce). Pas de boucle : les writes ne re-déclenchent pas
   les conditions (cas A : communications inchangé ; cas B : l'originale n'est pas
   _merged). Ce trigger REMPLACE resurrectLeadOnInboundComm (ne pas avoir les deux). */
exports.resurrectLeadOnReengagement = functions.firestore
  .document("leads/{leadId}")
  .onUpdate(async (change) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    // ── Cas B : doublon _merged ré-optiné → résurrecte l'ORIGINALE ──
    if (after._merged === true && after._mergedInto) {
      const bMs = before.lastOptinAt && before.lastOptinAt.toMillis ? before.lastOptinAt.toMillis() : 0;
      const aMs = after.lastOptinAt && after.lastOptinAt.toMillis ? after.lastOptinAt.toMillis() : 0;
      if (!aMs || aMs <= bMs) return null; // pas de nouveau opt-in sur le doublon
      const origRef = admin.firestore().collection("leads").doc(after._mergedInto);
      try {
        const o = await origRef.get();
        if (!o.exists) return null;
        const od = o.data() || {};
        const st = od.stage || "";
        if (od.isClient === true || st === "closed_won_setting" || st === "closed_won_self") return null;
        const oMs = od.lastOptinAt && od.lastOptinAt.toMillis ? od.lastOptinAt.toMillis() : 0;
        if (oMs >= aMs - 5000) return null; // déjà à jour
        await origRef.update({
          lastOptinAt: admin.firestore.FieldValue.serverTimestamp(),
          visibilityResurrectedAt: admin.firestore.FieldValue.serverTimestamp(),
          resurrectedFromMergedTwin: change.after.id,
        });
        console.log("[resurrectLeadOnReengagement] merged " + change.after.id + " -> original " + after._mergedInto);
      } catch (e) { console.error("[resurrectLeadOnReengagement] merged: " + (e && e.message)); }
      return null;
    }

    // ── Cas A : communication ENTRANTE ajoutée sur une fiche normale ──
    const beforeComms = Array.isArray(before.communications) ? before.communications : [];
    const afterComms = Array.isArray(after.communications) ? after.communications : [];
    if (afterComms.length <= beforeComms.length) return null;
    const added = afterComms.slice(beforeComms.length);
    const hasInbound = added.some(function (c) {
      const dir = ((c && c.direction) || "").toString().toLowerCase();
      return dir !== "outbound"; // inbound OU direction absente (source externe)
    });
    if (!hasInbound) return null;

    const stage = after.stage || "";
    if (after.isClient === true || stage === "closed_won_setting" || stage === "closed_won_self") return null;

    // ── Garde anti-bump (fix 2026-06) ──────────────────────────────────
    // On ne fait remonter QUE les fiches actuellement INVISIBLES dans Leads
    // Live : date effective (max createdAt/lastOptinAt/lastBookingAt) hors de
    // la fenêtre glissante 30 j. Une fiche déjà visible — lead récent OU déjà
    // ressuscitée — ne doit JAMAIS être remontée par une simple comm entrante
    // (sinon le lead saute en tête à chaque message, via le tri max(...)).
    const _ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);
    const _cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const _effMs = Math.max(_ms(after.createdAt), _ms(after.lastOptinAt), _ms(after.lastBookingAt));
    if (_effMs >= _cutoffMs) return null; // déjà visible dans Leads Live → on ne bouge rien

    try {
      await change.after.ref.update({
        lastOptinAt: admin.firestore.FieldValue.serverTimestamp(),
        lastInboundAt: admin.firestore.FieldValue.serverTimestamp(),
        resurrectedByInbound: true,
      });
      console.log("[resurrectLeadOnReengagement] inbound comm -> " + change.after.id);
    } catch (e) { console.error("[resurrectLeadOnReengagement] inbound: " + (e && e.message)); }
    return null;
  });
