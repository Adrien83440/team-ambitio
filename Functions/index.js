const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Triggered when a new document is created in the "leads" collection.
 * Sends a push notification to all registered FCM tokens.
 */
exports.onNewLead = functions.firestore
  .document("leads/{leadId}")
  .onCreate(async (snap, context) => {
    const lead = snap.data();
    const leadId = context.params.leadId;

    const nom = lead.nom || "Nouveau prospect";
    const type = lead.type || "";
    const tel = lead.telephone || "";
    const email = lead.email || "";

    // Build notification
    const typeLabels = {
      vsl_elite: "VSL Élite",
      self_booking: "Self Booking",
    };
    const typeLabel = typeLabels[type] || type || "Lead";

    const title = "🔔 Nouveau lead : " + nom;
    let body = typeLabel;
    if (tel) body += " · " + tel;
    if (email) body += " · " + email;

    // Get all registered FCM tokens
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

    // Send to all tokens
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

    // Clean up invalid tokens
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
      // Delete invalid tokens from Firestore
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
