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
