const db = require("../db");

// Creates an in-app notification for a user, unless they've turned
// notifications off in Settings. Silently does nothing on any failure —
// a notification is never allowed to break the booking action that triggered it.
async function notify(userId, title, body, bookingId = null) {
  try {
    const { rows } = await db.query("SELECT notifications_enabled FROM users WHERE id = $1", [userId]);
    if (!rows.length || rows[0].notifications_enabled === false) return;
    await db.query(
      "INSERT INTO notifications (user_id, title, body, booking_id) VALUES ($1,$2,$3,$4)",
      [userId, title, body, bookingId]
    );
  } catch (e) {
    console.error("notify() failed:", e.message);
  }
}

module.exports = { notify };
