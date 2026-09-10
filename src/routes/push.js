// Sends real Android push notifications via Firebase Cloud Messaging.
// Requires a FIREBASE_SERVICE_ACCOUNT_KEY env var on Railway containing the
// full JSON key downloaded from Firebase Console → Project Settings →
// Service Accounts → Generate new private key (paste the whole JSON as one
// line — most hosts, Railway included, handle a JSON string in an env var fine).
//
// If that env var isn't set, sendPush() silently does nothing — it never
// throws, since a push notification failing must never break the booking
// action that triggered it (same principle as utils/notify.js).

let admin = null;
let initialized = false;

function getAdmin() {
  if (initialized) return admin;
  initialized = true;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) return null;
  try {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    return admin;
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    admin = null;
    return null;
  }
}

/**
 * Sends a push notification to a single device token. Safe to call even if
 * Firebase isn't configured yet, or the token is missing/invalid — always
 * resolves, never throws.
 */
async function sendPush(fcmToken, title, body, data = {}) {
  if (!fcmToken) return;
  const fb = getAdmin();
  if (!fb) return;

  try {
    await fb.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: "high" },
    });
  } catch (e) {
    // A stale/invalid token is normal (app uninstalled, token rotated) — just log it.
    console.error("Push send failed:", e.message);
  }
}

module.exports = { sendPush };
