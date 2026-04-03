const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/* ═══════════════════════════════════════════════════
   CONFIG — read from Firestore document _config/oauth
   Set these values in Firebase Console → Firestore → _config/oauth
   ═══════════════════════════════════════════════════ */

const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email"
];

// Cache config in memory (cold start loads once)
let _oauthConfig = null;

async function getOAuthConfig() {
  if (_oauthConfig) return _oauthConfig;
  const doc = await db.collection("_config").doc("oauth").get();
  if (!doc.exists) {
    throw new Error("OAuth non configuré. Créez le document _config/oauth dans Firestore avec client_id, client_secret, redirect_uri, app_url.");
  }
  _oauthConfig = doc.data();
  return _oauthConfig;
}

async function getOAuth2Client() {
  const conf = await getOAuthConfig();
  if (!conf.client_id || !conf.client_secret || !conf.redirect_uri) {
    throw new Error("Champs manquants dans _config/oauth : client_id, client_secret, redirect_uri");
  }
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri);
}

async function getAppUrl() {
  const conf = await getOAuthConfig();
  return conf.app_url || "https://team.alteore.com";
}

/**
 * Helper: get an authenticated OAuth2 client for a person.
 * Handles token refresh automatically.
 */
async function getAuthClientForPerson(personId) {
  const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
  if (!tokenDoc.exists) return null;

  const data = tokenDoc.data();
  const client = await getOAuth2Client();
  client.setCredentials({
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
    expiry_date: data.expiresAt ? data.expiresAt.toDate().getTime() : 0
  });

  // Auto-refresh listener: persist new tokens
  client.on("tokens", async (newTokens) => {
    const update = {};
    if (newTokens.access_token) update.accessToken = newTokens.access_token;
    if (newTokens.expiry_date) update.expiresAt = new Date(newTokens.expiry_date);
    if (newTokens.refresh_token) update.refreshToken = newTokens.refresh_token;
    if (Object.keys(update).length) {
      await db.collection("calendar_tokens").doc(personId).update(update);
    }
  });

  return client;
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

    const typeLabels = {
      vsl_elite: "VSL Élite",
      self_booking: "Self Booking",
    };
    const typeLabel = typeLabels[type] || type || "Lead";

    const title = "🔔 Nouveau lead : " + nom;
    let body = typeLabel;
    if (tel) body += " · " + tel;
    if (email) body += " · " + email;

    const tokensSnap = await db.collection("fcm_tokens").get();
    if (tokensSnap.empty) {
      console.log("No FCM tokens registered, skipping push.");
      return null;
    }

    const tokens = [];
    tokensSnap.forEach((doc) => {
      const t = doc.data().token;
      if (t) tokens.push(t);
    });

    if (!tokens.length) {
      console.log("No valid tokens found.");
      return null;
    }

    console.log("Sending push to " + tokens.length + " device(s) for lead: " + nom);

    const message = {
      data: {
        title: title,
        body: body,
        leadId: leadId,
        url: "/sales-leads.html?app=1",
      },
      tokens: tokens,
    };

    const response = await messaging.sendEachForMulticast(message);

    if (response.failureCount > 0) {
      const tokensToRemove = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            tokensToRemove.push(tokens[idx]);
          }
        }
      });
      const batch = db.batch();
      tokensToRemove.forEach((t) => {
        batch.delete(db.collection("fcm_tokens").doc(t));
      });
      if (tokensToRemove.length) {
        await batch.commit();
        console.log("Cleaned " + tokensToRemove.length + " invalid token(s).");
      }
    }

    console.log(
      "Push sent: " +
        response.successCount +
        " success, " +
        response.failureCount +
        " failures."
    );
    return null;
  });


/* ═══════════════════════════════════════════════════
   2. GOOGLE CALENDAR — OAUTH START
   Callable: returns the Google OAuth URL.
   Only authenticated admins can trigger this.
   ═══════════════════════════════════════════════════ */

exports.calendarAuthUrl = functions.https.onCall(async (data, context) => {
  // Auth check
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Connexion requise.");
  }
  const userDoc = await db.collection("users").doc(context.auth.uid).get();
  const role = userDoc.exists ? userDoc.data().role : "";
  if (role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Réservé aux administrateurs.");
  }

  const personId = data.personId;
  if (!personId) {
    throw new functions.https.HttpsError("invalid-argument", "personId requis.");
  }

  const oauth2Client = await getOAuth2Client();

  // State: encode personId for the callback
  const state = Buffer.from(JSON.stringify({
    personId: personId,
    uid: context.auth.uid,
    ts: Date.now()
  })).toString("base64url");

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: CALENDAR_SCOPES,
    prompt: "consent",
    state: state
  });

  return { url: url };
});


/* ═══════════════════════════════════════════════════
   3. GOOGLE CALENDAR — OAUTH CALLBACK
   HTTP trigger: Google redirects here after consent.
   Exchanges code for tokens, stores in Firestore.
   ═══════════════════════════════════════════════════ */

exports.calendarOAuthCallback = functions.https.onRequest(async (req, res) => {
  const baseUrl = await getAppUrl();
  const code = req.query.code;
  const state = req.query.state;
  const error = req.query.error;

  if (error) {
    console.error("OAuth error from Google:", error);
    return res.redirect(baseUrl + "/booking-admin.html?cal_error=" + encodeURIComponent(error));
  }

  if (!code || !state) {
    return res.redirect(baseUrl + "/booking-admin.html?cal_error=missing_params");
  }

  try {
    // Decode state
    const stateData = JSON.parse(Buffer.from(state, "base64url").toString());
    const personId = stateData.personId;

    if (!personId) {
      return res.redirect(baseUrl + "/booking-admin.html?cal_error=invalid_state");
    }

    // Exchange code for tokens
    const oauth2Client = await getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Get user email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || "";

    // Store tokens in secure collection
    await db.collection("calendar_tokens").doc(personId).set({
      accessToken: tokens.access_token || "",
      refreshToken: tokens.refresh_token || "",
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      email: email,
      calendarId: "primary",
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update expert's booking_config doc (public-readable fields)
    await db.collection("booking_config").doc(personId).update({
      calendarConnected: true,
      calendarEmail: email
    });

    console.log("Calendar connected for person " + personId + " (" + email + ")");
    res.redirect(baseUrl + "/booking-admin.html?cal_success=1&cal_person=" + encodeURIComponent(personId));

  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(baseUrl + "/booking-admin.html?cal_error=" + encodeURIComponent(err.message || "unknown"));
  }
});


/* ═══════════════════════════════════════════════════
   4. GOOGLE CALENDAR — FREE/BUSY CHECK
   HTTP trigger (public access for booking.html).
   Returns busy time ranges for a person in a date range.
   ═══════════════════════════════════════════════════ */

exports.calendarFreeBusy = functions.https.onRequest(async (req, res) => {
  // CORS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  const personId = req.query.personId || (req.body && req.body.personId);
  const startDate = req.query.start || (req.body && req.body.start); // YYYY-MM-DD
  const endDate = req.query.end || (req.body && req.body.end);       // YYYY-MM-DD

  if (!personId || !startDate || !endDate) {
    return res.status(400).json({ error: "personId, start, end required" });
  }

  try {
    const authClient = await getAuthClientForPerson(personId);
    if (!authClient) {
      // No calendar connected — return empty (no conflicts)
      return res.json({ busy: [], connected: false });
    }

    const calendar = google.calendar({ version: "v3", auth: authClient });
    const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
    const calendarId = tokenDoc.data().calendarId || "primary";

    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDate + "T00:00:00+02:00",
        timeMax: endDate + "T23:59:59+02:00",
        timeZone: "Europe/Paris",
        items: [{ id: calendarId }]
      }
    });

    const calendars = resp.data.calendars || {};
    const calData = calendars[calendarId] || {};
    const busy = calData.busy || [];

    // Return busy ranges as ISO strings
    res.json({
      busy: busy.map(function (b) {
        return { start: b.start, end: b.end };
      }),
      connected: true
    });

  } catch (err) {
    console.error("FreeBusy error for " + personId + ":", err.message);
    // Don't fail the booking flow — just return empty
    res.json({ busy: [], connected: false, error: err.message });
  }
});


/* ═══════════════════════════════════════════════════
   5. GOOGLE CALENDAR — CREATE EVENT
   HTTP trigger (called after booking confirmation).
   Creates a Google Calendar event for the expert.
   ═══════════════════════════════════════════════════ */

exports.calendarCreateEvent = functions.https.onRequest(async (req, res) => {
  // CORS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const {
    personId, date, time, duration,
    title, description, attendeeEmail, attendeeName, location
  } = req.body;

  if (!personId || !date || !time) {
    return res.status(400).json({ error: "personId, date, time required" });
  }

  try {
    const authClient = await getAuthClientForPerson(personId);
    if (!authClient) {
      return res.json({ created: false, reason: "no_calendar" });
    }

    const dur = duration || 30;
    const startParts = time.split(":");
    const startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    const endMin = startMin + dur;
    const endTime = String(Math.floor(endMin / 60)).padStart(2, "0") + ":" + String(endMin % 60).padStart(2, "0");

    const event = {
      summary: title || "Rendez-vous Ambitio",
      description: description || "",
      start: {
        dateTime: date + "T" + time + ":00",
        timeZone: "Europe/Paris"
      },
      end: {
        dateTime: date + "T" + endTime + ":00",
        timeZone: "Europe/Paris"
      }
    };

    if (location) event.location = location;
    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail, displayName: attendeeName || "" }];
    }

    const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
    const calendarId = tokenDoc.data().calendarId || "primary";

    const calendar = google.calendar({ version: "v3", auth: authClient });
    const resp = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: event,
      sendUpdates: attendeeEmail ? "all" : "none"
    });

    console.log("Calendar event created for " + personId + ": " + resp.data.id);
    res.json({ created: true, eventId: resp.data.id, htmlLink: resp.data.htmlLink });

  } catch (err) {
    console.error("Create event error for " + personId + ":", err.message);
    res.json({ created: false, error: err.message });
  }
});


/* ═══════════════════════════════════════════════════
   6. GOOGLE CALENDAR — DISCONNECT
   Callable: revokes tokens and removes connection.
   Admin only.
   ═══════════════════════════════════════════════════ */

exports.calendarDisconnect = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Connexion requise.");
  }
  const userDoc = await db.collection("users").doc(context.auth.uid).get();
  if (!userDoc.exists || userDoc.data().role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Réservé aux administrateurs.");
  }

  const personId = data.personId;
  if (!personId) {
    throw new functions.https.HttpsError("invalid-argument", "personId requis.");
  }

  // Try to revoke the token
  const tokenDoc = await db.collection("calendar_tokens").doc(personId).get();
  if (tokenDoc.exists) {
    try {
      const oauth2Client = await getOAuth2Client();
      const tokenData = tokenDoc.data();
      if (tokenData.accessToken) {
        await oauth2Client.revokeToken(tokenData.accessToken);
      }
    } catch (e) {
      console.log("Token revocation failed (may already be expired):", e.message);
    }
    await db.collection("calendar_tokens").doc(personId).delete();
  }

  // Update expert doc
  await db.collection("booking_config").doc(personId).update({
    calendarConnected: admin.firestore.FieldValue.delete(),
    calendarEmail: admin.firestore.FieldValue.delete()
  });

  console.log("Calendar disconnected for person " + personId);
  return { success: true };
});
