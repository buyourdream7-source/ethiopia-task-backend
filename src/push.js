// Sends real Android push notifications via Firebase Cloud Messaging.
//
// Requires a FIREBASE_SERVICE_ACCOUNT_KEY env var on Railway containing the
// full JSON key from Firebase Console → Project Settings → Service Accounts →
// Generate new private key, pasted as one line. The \n sequences inside
// private_key must stay as literal backslash-n — JSON.parse turns them into
// real newlines. If they become real line breaks in the variable itself, the
// JSON no longer parses.
//
// If that env var isn't set, sendPush() silently does nothing — it never
// throws, since a push notification failing must never break the booking
// action that triggered it (same principle as utils/notify.js).
//
// NOTE ON IMPORTS: this uses the modular entry points (firebase-admin/app,
// firebase-admin/messaging) rather than the old namespaced `admin.apps` /
// `admin.credential.cert`. That namespace is gone in firebase-admin v13+,
// where `admin.apps` reads as undefined and the init fails with a confusing
// "Cannot read properties of undefined (reading 'length')".

let messaging = null;
let initialized = false;

function getMessagingClient() {
  if (initialized) return messaging;
  initialized = true;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    console.warn("FIREBASE_SERVICE_ACCOUNT_KEY is not set — push notifications are off.");
    return null;
  }

  try {
    const { getApps, initializeApp, cert } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

    // Harmless when the key already contains real newlines; rescues the case
    // where a host has double-escaped them on the way in.
    if (typeof serviceAccount.private_key === "string") {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    const app = getApps().length
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });

    messaging = getMessaging(app);
    console.log(`Firebase Admin ready (project ${serviceAccount.project_id}).`);
    return messaging;
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    messaging = null;
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
  const fb = getMessagingClient();
  if (!fb) return;

  try {
    await fb.send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: "high",
        notification: {
          // Without a channel the notification can be silently dropped on
          // Android 8+. "default" is the channel Capacitor creates for us.
          channelId: "default",
          sound: "default",
        },
      },
    });
  } catch (e) {
    // A stale/invalid token is normal (app uninstalled, token rotated) — just log it.
    console.error("Push send failed:", e.message);
  }
}

module.exports = { sendPush };
