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

/**
 * Validate API key from Authorization header.
 * Key is stored in Firestore: _config/webhook_keys { keys: ["key1", "key2"] }
 */
async function validateApiKey(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const key = auth.slice(7).trim();
  if (!key) return false;
  try {
    const doc = await db.collection("_config").doc("webhook_keys").get();
    if (!doc.exists) return false;
    const keys = doc.data().keys || [];
    return keys.includes(key);
  } catch (e) {
    console.error("validateApiKey error:", e.message);
    return false;
  }
}

/**
 * CORS headers for Make.com HTTP module
 */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * Find a lead by email or phone.
 * Returns { id, data } or null.
 */
async function findLead(email, phone) {
  // Try email first (more reliable identifier)
  if (email) {
    const emailNorm = email.trim().toLowerCase();
    const snap = await db.collection("leads")
      .where("email", "==", emailNorm)
      .limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { id: doc.id, data: doc.data() };
    }
    // Try case-sensitive (some leads may have mixed case)
    const snap2 = await db.collection("leads")
      .where("email", "==", email.trim())
      .limit(1).get();
    if (!snap2.empty) {
      const doc = snap2.docs[0];
      return { id: doc.id, data: doc.data() };
    }
  }
  // Fallback: phone
  if (phone) {
    const phoneClean = phone.replace(/\s+/g, "").replace(/^(\+33)/, "0");
    const snap = await db.collection("leads")
      .where("telephone", "==", phoneClean)
      .limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { id: doc.id, data: doc.data() };
    }
    // Also try with +33 format
    const snap2 = await db.collection("leads")
      .where("telephone", "==", phone.replace(/\s+/g, ""))
      .limit(1).get();
    if (!snap2.empty) {
      const doc = snap2.docs[0];
      return { id: doc.id, data: doc.data() };
    }
  }
  return null;
}

/**
 * Format date for timeline_history entries.
 */
function fmtNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear()
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/**
 * Stage-to-status mapping (mirrors S2S in sales-crm-app.js)
 */
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
   Triggered when admin writes auth code to Firestore.
   Exchanges code for tokens server-side.
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

      // Get user email
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email || "";

      // Store tokens securely
      await db.collection("calendar_tokens").doc(personId).set({
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || "",
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        email: email,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update expert doc
      await db.collection("booking_config").doc(personId).update({
        calendarConnected: true,
        calendarEmail: email
      });

      // Mark request as done
      await snap.ref.update({ status: "success", email: email });

      // Sync busy times immediately
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
   Triggered when a new booking is created.
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
   Triggered when booking.html requests a refresh.
   ═══════════════════════════════════════════════════ */

exports.onCalendarSyncRequest = functions.firestore
  .document("calendar_sync_requests/{personId}")
  .onWrite(async (change, context) => {
    await fetchAndStoreBusy(context.params.personId);
    return null;
  });


/* ═══════════════════════════════════════════════════
   5. SCHEDULED SYNC — every 30 minutes
   Refreshes busy times for all connected experts.
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
   6. WEBHOOK — LEAD UPDATE
   Called by Make.com to update a lead (stage, tags,
   contract info, subscription, etc.)
   ═══════════════════════════════════════════════════

   POST /webhookLeadUpdate
   Headers: Authorization: Bearer <API_KEY>
   Body JSON:
   {
     "email": "client@example.com",       // required (or phone)
     "phone": "+33612345678",             // fallback lookup
     "stage": "closed_won_setting",       // optional — pipeline stage
     "addTags": ["client", "elite"],      // optional — tags to add
     "removeTags": ["prospect"],          // optional — tags to remove
     "contractUrl": "https://...",        // optional — signed doc link
     "contractSignedAt": "2026-04-04",    // optional — ISO date
     "subscriptionType": "Elite 6 mois", // optional
     "accompagnementStart": "2026-04-07", // optional — ISO date
     "accompagnementEnd": "2026-10-07",   // optional — ISO date
     "fields": { "closeur": "adrien" }    // optional — any extra fields
   }
   ═══════════════════════════════════════════════════ */

exports.webhookLeadUpdate = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  // Auth
  const valid = await validateApiKey(req);
  if (!valid) { res.status(401).json({ error: "Invalid API key" }); return; }

  const body = req.body || {};
  const { email, phone } = body;
  if (!email && !phone) {
    res.status(400).json({ error: "email or phone required to identify the lead" });
    return;
  }

  try {
    // Find the lead
    const found = await findLead(email, phone);
    if (!found) {
      res.status(404).json({ error: "Lead not found", email, phone });
      return;
    }

    const leadId = found.id;
    const existing = found.data;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    const timelineEntries = [];

    // Stage change
    if (body.stage && body.stage !== existing.stage) {
      update.stage = body.stage;
      if (S2S[body.stage]) update.status = S2S[body.stage];
      timelineEntries.push({
        text: "⚡ " + (existing.stage || "lead") + " → " + body.stage + " (via webhook)",
        date: fmtNow(),
        color: "#a78bfa"
      });
      // If closing as won, add isClient flag
      if (body.stage === "closed_won_setting" || body.stage === "closed_won_self") {
        update.isClient = true;
        timelineEntries.push({
          text: "🎉 Converti en client ! (automatique)",
          date: fmtNow(),
          color: "#10b981"
        });
      }
    }

    // Tags
    let currentTags = existing.tags || [];
    if (body.addTags && Array.isArray(body.addTags)) {
      body.addTags.forEach((t) => {
        if (t && currentTags.indexOf(t) < 0) currentTags.push(t);
      });
      update.tags = currentTags;
    }
    if (body.removeTags && Array.isArray(body.removeTags)) {
      currentTags = currentTags.filter((t) => !(body.removeTags || []).includes(t));
      update.tags = currentTags;
    }

    // Contract info
    if (body.contractUrl) {
      update.contractUrl = body.contractUrl;
      timelineEntries.push({
        text: "📝 Contrat signé reçu",
        date: fmtNow(),
        color: "#34d399"
      });
    }
    if (body.contractSignedAt) update.contractSignedAt = body.contractSignedAt;
    if (body.subscriptionType) {
      update.subscriptionType = body.subscriptionType;
      timelineEntries.push({
        text: "📦 Abonnement : " + body.subscriptionType,
        date: fmtNow(),
        color: "#60a5fa"
      });
    }
    if (body.accompagnementStart) update.accompagnementStart = body.accompagnementStart;
    if (body.accompagnementEnd) {
      update.accompagnementEnd = body.accompagnementEnd;
      timelineEntries.push({
        text: "📅 Accompagnement : " + (body.accompagnementStart || "?") + " → " + body.accompagnementEnd,
        date: fmtNow(),
        color: "#f59e0b"
      });
    }

    // Extra fields
    if (body.fields && typeof body.fields === "object") {
      Object.keys(body.fields).forEach((k) => {
        // Safety: don't allow overwriting system fields
        if (!["id", "createdAt", "timeline_history", "notesHistory"].includes(k)) {
          update[k] = body.fields[k];
        }
      });
    }

    // Append timeline entries
    if (timelineEntries.length > 0) {
      const currentTimeline = existing.timeline_history || [];
      update.timeline_history = currentTimeline.concat(timelineEntries);
    }

    await db.collection("leads").doc(leadId).update(update);

    console.log("webhookLeadUpdate: updated lead " + leadId + " (" + (email || phone) + ")");
    res.status(200).json({
      success: true,
      leadId: leadId,
      updated: Object.keys(update).filter((k) => k !== "updatedAt")
    });

  } catch (e) {
    console.error("webhookLeadUpdate error:", e.message);
    res.status(500).json({ error: "Internal error", message: e.message });
  }
});


/* ═══════════════════════════════════════════════════
   7. WEBHOOK — LEAD ACTIVITY
   Called by Make.com to log an activity on a lead
   (Ringover call/SMS, email events, etc.)
   ═══════════════════════════════════════════════════

   POST /webhookLeadActivity
   Headers: Authorization: Bearer <API_KEY>
   Body JSON:
   {
     "email": "client@example.com",     // required (or phone)
     "phone": "+33612345678",           // fallback lookup
     "type": "call",                    // required: call | sms | email | note | other
     "direction": "inbound",            // optional: inbound | outbound
     "content": "Discussion abonnement...",  // optional — summary
     "duration": 180,                   // optional — seconds (for calls)
     "source": "ringover",              // optional — origin system
     "date": "2026-04-04T14:30:00"      // optional — ISO, defaults to now
   }
   ═══════════════════════════════════════════════════ */

exports.webhookLeadActivity = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  // Auth
  const valid = await validateApiKey(req);
  if (!valid) { res.status(401).json({ error: "Invalid API key" }); return; }

  const body = req.body || {};
  const { email, phone, type } = body;
  if (!email && !phone) {
    res.status(400).json({ error: "email or phone required" });
    return;
  }
  if (!type) {
    res.status(400).json({ error: "type required (call, sms, email, note, other)" });
    return;
  }

  try {
    const found = await findLead(email, phone);
    if (!found) {
      res.status(404).json({ error: "Lead not found", email, phone });
      return;
    }

    const leadId = found.id;
    const existing = found.data;
    const now = fmtNow();

    // Build timeline entry
    const icons = { call: "📞", sms: "💬", email: "✉️", note: "📝", other: "📌" };
    const labels = { call: "Appel", sms: "SMS", email: "Email", note: "Note", other: "Activité" };
    const icon = icons[type] || "📌";
    const label = labels[type] || type;
    const dir = body.direction === "outbound" ? " sortant" : body.direction === "inbound" ? " entrant" : "";
    const src = body.source ? " (" + body.source + ")" : "";
    let tlText = icon + " " + label + dir + src;
    if (body.content) tlText += " — " + body.content.substring(0, 100);
    if (type === "call" && body.duration) {
      const mins = Math.floor(body.duration / 60);
      const secs = body.duration % 60;
      tlText += " [" + mins + "m" + (secs ? String(secs).padStart(2, "0") + "s" : "") + "]";
    }

    const timelineEntry = {
      text: tlText,
      date: body.date ? new Date(body.date).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : now,
      color: type === "call" ? "#34d399" : type === "sms" ? "#60a5fa" : type === "email" ? "#f59e0b" : "#a78bfa"
    };

    // Also store structured activity for potential detailed view
    const activityEntry = {
      type: type,
      direction: body.direction || null,
      content: body.content || null,
      duration: body.duration || null,
      source: body.source || null,
      date: body.date || new Date().toISOString(),
      createdAt: now
    };

    const currentTimeline = existing.timeline_history || [];
    const currentCommunications = existing.communications || [];

    await db.collection("leads").doc(leadId).update({
      timeline_history: currentTimeline.concat([timelineEntry]),
      communications: currentCommunications.concat([activityEntry]),
      lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
      lastContactType: type,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("webhookLeadActivity: logged " + type + " on lead " + leadId);
    res.status(200).json({
      success: true,
      leadId: leadId,
      activityType: type,
      timelineEntriesCount: currentTimeline.length + 1
    });

  } catch (e) {
    console.error("webhookLeadActivity error:", e.message);
    res.status(500).json({ error: "Internal error", message: e.message });
  }
});


/* ═══════════════════════════════════════════════════
   8. WEBHOOK — LEAD CREATE (optional)
   If the contact doesn't exist yet, create it.
   ═══════════════════════════════════════════════════

   POST /webhookLeadCreate
   Headers: Authorization: Bearer <API_KEY>
   Body JSON:
   {
     "nom": "Jean Dupont",               // required
     "email": "jean@example.com",         // required
     "telephone": "+33612345678",         // optional
     "type": "vsl_elite",                // optional — default: vsl_elite
     "stage": "lead",                    // optional — default: lead
     "source": "zoho_sign",              // optional — tracked in utm
     "fields": { "secteur": "coaching" } // optional — any extra fields
   }
   ═══════════════════════════════════════════════════ */

exports.webhookLeadCreate = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const valid = await validateApiKey(req);
  if (!valid) { res.status(401).json({ error: "Invalid API key" }); return; }

  const body = req.body || {};
  if (!body.nom || !body.email) {
    res.status(400).json({ error: "nom and email required" });
    return;
  }

  try {
    // Check if lead already exists
    const existing = await findLead(body.email, body.telephone);
    if (existing) {
      res.status(409).json({
        error: "Lead already exists",
        leadId: existing.id,
        hint: "Use /webhookLeadUpdate to update this lead"
      });
      return;
    }

    const stage = body.stage || "lead";
    const newLead = {
      nom: body.nom.trim(),
      email: body.email.trim().toLowerCase(),
      telephone: (body.telephone || "").replace(/\s+/g, ""),
      type: body.type || "vsl_elite",
      stage: stage,
      status: S2S[stage] || "nouveau",
      assignedTo: "",
      tags: [],
      notesHistory: [],
      timeline_history: [{
        text: "✨ Lead créé via webhook" + (body.source ? " (" + body.source + ")" : ""),
        date: fmtNow(),
        color: "#a78bfa"
      }],
      communications: [],
      source: body.source || "webhook",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Extra fields
    if (body.fields && typeof body.fields === "object") {
      Object.keys(body.fields).forEach((k) => {
        if (!["id", "createdAt", "timeline_history", "notesHistory"].includes(k)) {
          newLead[k] = body.fields[k];
        }
      });
    }

    const ref = await db.collection("leads").add(newLead);
    console.log("webhookLeadCreate: created lead " + ref.id + " (" + body.email + ")");
    res.status(201).json({ success: true, leadId: ref.id });

  } catch (e) {
    console.error("webhookLeadCreate error:", e.message);
    res.status(500).json({ error: "Internal error", message: e.message });
  }
});
