const db = require("../db");
const { sendPush } = require("../push");

// Creates an in-app notification for a user, unless they've turned
// notifications off in Settings. Also sends a real push notification if the
// user has a registered device token. Silently does nothing on any failure —
// a notification is never allowed to break the booking action that triggered it.
async function notify(userId, title, body, bookingId = null) {
  try {
    const { rows } = await db.query("SELECT notifications_enabled, fcm_token FROM users WHERE id = $1", [userId]);
    if (!rows.length || rows[0].notifications_enabled === false) return;
    await db.query(
      "INSERT INTO notifications (user_id, title, body, booking_id) VALUES ($1,$2,$3,$4)",
      [userId, title, body, bookingId]
    );
    await sendPush(rows[0].fcm_token, title, body, bookingId ? { booking_id: bookingId } : {});
  } catch (e) {
    console.error("notify() failed:", e.message);
  }
}

module.exports = { notify };
