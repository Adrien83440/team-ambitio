const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");

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
  var client = await getAuthClientForPerson(personId);
  if (!client) return;
  var calendar = google.calendar({ version: "v3", auth: client });
  var now = new Date();
  var end = new Date();
  end.setDate(end.getDate() + 60);
  try {
    var resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: "Europe/Paris",
        items: [{ id: "primary" }]
      }
    });
    var busy = (resp.data.calendars && resp.data.calendars.primary && resp.data.calendars.primary.busy) || [];
    await db.collection("calendar_busy").doc(personId).set({
      busy: busy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("Synced " + busy.length + " busy slots for " + personId);
  } catch (e) {
    console.error("fetchAndStoreBusy error for " + personId + ":", e.message);
  }
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

async function findLead(email, phone) {
  if (email) {
    const emailNorm = email.trim().toLowerCase();
    const snap = await db.collection("leads").where("email", "==", emailNorm).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    const snap2 = await db.collection("leads").where("email", "==", email.trim()).limit(1).get();
    if (!snap2.empty) return { id: snap2.docs[0].id, data: snap2.docs[0].data() };
  }
  if (phone) {
    // Normalize: strip spaces, then convert all formats to 0XXXXXXXXX
    const raw = phone.replace(/\s+/g, "");
    const variants = new Set();
    variants.add(raw);
    // +33612345678 → 0612345678
    if (raw.startsWith("+33")) variants.add("0" + raw.slice(3));
    // 33612345678 → 0612345678
    if (raw.startsWith("33") && raw.length >= 11) variants.add("0" + raw.slice(2));
    // 0612345678 → +33612345678 and 33612345678
    if (raw.startsWith("0") && raw.length === 10) {
      variants.add("+33" + raw.slice(1));
      variants.add("33" + raw.slice(1));
    }
    for (const v of variants) {
      const snap = await db.collection("leads").where("telephone", "==", v).limit(1).get();
      if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    }
  }
  return null;
}

function fmtNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear()
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

const S2S = {
  lead: "nouveau", nrp1: "nrp1", nrp2: "nrp2", nrp3: "nrp3",
  all_nrp: "nrp3", poubelle: "disqualifie", disqualification: "disqualifie",
  // rdv_self_booking → statut dédié SB (fix 17/07) : rdv_pose est réservé
  // aux RDV posés par le setting (il déclenche le badge No Booking).
  follow_up_pm: "appele", set: "rdv_pose", rdv_self_booking: "rdv_self_booking",
  rdv_confirmes: "rdv_pose", rdv_annules_prospect: "pas_interesse",
  rdv_annules_equipe: "pas_interesse", no_show_self: "pas_interesse",
  no_show_setting: "pas_interesse", partenariats: "rdv_pose",
  closed_won_setting: "rdv_pose", closed_won_self: "rdv_pose",
  closed_lost: "pas_interesse", follow_up_closing: "appele",
  disqualifie_closing: "disqualifie"
};


/* ═══════════════════════════════════════════════════
   1. PUSH NOTIFICATIONS ON NEW LEAD
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
    const typeLabels = { vsl_elite: "VSL Élite", self_booking: "Self Booking" };
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
      await db.collection("calendar_tokens").doc(personId).set({
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || "",
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        email: email,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection("booking_config").doc(personId).update({
        calendarConnected: true,
        calendarEmail: email
      });
      await snap.ref.update({ status: "success", email: email });
      await fetchAndStoreBusy(personId);
      console.log("Calendar connected for " + personId + " (" + email + ")");
    } catch (e) {
      console.error("Auth exchange error:", e.message);
      await snap.ref.update({ status: "error", error: e.message });
    }
    return null;
  });


/* ═══════════════════════════════════════════════════
   3. GOOGLE CALENDAR — AUTO-CREATE EVENT ON BOOKING
   ═══════════════════════════════════════════════════ */

exports.onBookingCreated = functions.firestore
  .document("bookings/{bookingId}")
  .onCreate(async (snap, context) => {
    const booking = snap.data();
    const bookingId = context.params.bookingId;
    const personId = booking.personId;
    if (!personId) return null;
    const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
    if (!tokenDoc.exists) return null;
    try {
      const client = await getAuthClientForPerson(personId);
      if (!client) return null;
      const dur = booking.duration || 30;
      const time = booking.time || "09:00";
      const parts = time.split(":");
      const startMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
      const endMin = startMin + dur;
      const endTime = String(Math.floor(endMin / 60)).padStart(2, "0") + ":" + String(endMin % 60).padStart(2, "0");
      const prospect = booking.prospect || {};
      const clientName = ((prospect.prenom || "") + " " + (prospect.nom || "")).trim();
      const summary = (booking.typeLabel || "RDV") + (clientName ? " — " + clientName : "");
      const event = {
        summary: summary,
        description: "Réservé via Ambitio Booking",
        start: { dateTime: booking.date + "T" + time + ":00", timeZone: "Europe/Paris" },
        end: { dateTime: booking.date + "T" + endTime + ":00", timeZone: "Europe/Paris" }
      };
      if (prospect.email) event.attendees = [{ email: prospect.email, displayName: clientName }];
      const calendar = google.calendar({ version: "v3", auth: client });
      const resp = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
        sendUpdates: prospect.email ? "all" : "none"
      });
      await snap.ref.update({
        calendarEventId: resp.data.id,
        calendarEventLink: resp.data.htmlLink || ""
      });
      console.log("Event created for booking " + bookingId + ": " + resp.data.id);
      await fetchAndStoreBusy(personId);
    } catch (e) {
      console.error("Event creation error for " + bookingId + ":", e.message);
    }
    return null;
  });


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
   ═══════════════════════════════════════════════════

   Make.com creates a document in webhook_inbox/.
   This function picks it up, processes the action,
   updates the lead, and cleans up.

   No HTTP permissions / IAM needed.

   Make.com uses a simple HTTP POST to Firestore REST API:
   POST https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents/webhook_inbox

   ═══════════════════════════════════════════════════ */

exports.onWebhookInbox = functions.firestore
  .document("webhook_inbox/{docId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const docId = context.params.docId;

    try {
      // Validate API key
      const valid = await validateApiKey(data.apiKey);
      if (!valid) {
        console.error("onWebhookInbox: invalid API key for doc " + docId);
        await snap.ref.update({ status: "error", error: "Invalid API key" });
        return null;
      }

      const action = data.action;
      if (!action) {
        await snap.ref.update({ status: "error", error: "Missing action field" });
        return null;
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
        const found = await findLead(data.email, data.phone);
        if (!found) {
          await snap.ref.update({ status: "error", error: "Lead not found" });
          return null;
        }

        const leadId = found.id;
        const existing = found.data;
        const type = data.type || "other";
        const now = fmtNow();

        const icons = { call: "📞", sms: "💬", email: "✉️", note: "📝", other: "📌" };
        const labels = { call: "Appel", sms: "SMS", email: "Email", note: "Note", other: "Activité" };
        const dir = data.direction === "outbound" ? " sortant" : data.direction === "inbound" ? " entrant" : "";
        const src = data.source ? " (" + data.source + ")" : "";
        let tlText = (icons[type] || "📌") + " " + (labels[type] || type) + dir + src;
        if (data.note) tlText += " — " + String(data.note).substring(0, 100);
        else if (data.content) tlText += " — " + String(data.content).substring(0, 100);
        if (type === "call" && data.duration) {
          tlText += " [" + Math.floor(data.duration / 60) + "m]";
        }
        if (type === "call" && data.recordingUrl) tlText += " 🎙";
        if (type === "call" && data.transcription) tlText += " 📄";

        const timelineEntry = {
          text: tlText,
          date: data.date ? new Date(data.date).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : now,
          color: type === "call" ? "#34d399" : type === "sms" ? "#60a5fa" : type === "email" ? "#f59e0b" : "#a78bfa"
        };

        const commEntry = {
          type: type,
          direction: data.direction || null,
          content: data.content || null,
          duration: data.duration || null,
          source: data.source || null,
          date: data.date || new Date().toISOString(),
          createdAt: now,
          recordingUrl: data.recordingUrl || null,
          transcription: data.transcription || null,
          note: data.note || null,
          callTags: data.callTags || null
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
          await snap.ref.update({ status: "error", error: "Lead already exists", existingLeadId: existing.id });
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

// ═══ DIALER MODULE (Step 5 Vague 1) ═══
Object.assign(exports, require('./dialerFunctions'));
