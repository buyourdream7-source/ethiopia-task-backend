// Online / last-seen presence.
//
// Deliberately crude: there is no socket connection here, just a timestamp the
// app refreshes while it's open. "Online" means "sent a ping in the last two
// minutes". That is honest enough for a marketplace — the question a customer
// is really asking is "is it worth waiting for a reply right now", and a
// two-minute window answers it without any realtime infrastructure.
//
// Mounted in src/index.js as:
//   app.use("/api/presence", require("./routes/presence"));

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const { makeSafe } = require("../utils/safeRouter");

const router = express.Router();
makeSafe(router);

// How recent a ping has to be to count as "online". Must be comfortably longer
// than the app's ping interval or people flicker offline between pings.
const ONLINE_WINDOW_SECONDS = 120;

// The app calls this while it's in the foreground. Cheap single-row update.
router.post("/ping", requireAuth, async (req, res) => {
  await db.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [req.user.id]);
  res.json({ ok: true });
});

// Whether this user is visible to others. Read by Settings.
router.get("/settings", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    "SELECT show_online_status FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json({ show_online_status: rows[0].show_online_status !== false });
});

router.patch("/settings", requireAuth, async (req, res) => {
  const { show_online_status } = req.body;
  if (typeof show_online_status !== "boolean") {
    return res.status(400).json({ error: "show_online_status must be true or false" });
  }
  await db.query(
    "UPDATE users SET show_online_status = $1 WHERE id = $2",
    [show_online_status, req.user.id]
  );
  res.json({ show_online_status });
});

// Presence of the other party on a booking.
//
// The conversation row is doing double duty here: it holds both user ids, and
// the fact that the caller appears in it is the authorization check. Someone
// who isn't on this booking gets a 404 and learns nothing.
router.get("/booking/:bookingId", requireAuth, async (req, res) => {
  const { rows: convos } = await db.query(
    "SELECT customer_id, worker_id FROM conversations WHERE booking_id = $1 AND (customer_id = $2 OR worker_id = $2)",
    [req.params.bookingId, req.user.id]
  );
  if (!convos.length) return res.status(404).json({ error: "Conversation not found" });

  const convo = convos[0];
  const peerId = String(convo.customer_id) === String(req.user.id)
    ? convo.worker_id
    : convo.customer_id;

  if (!peerId) return res.json({ hidden: true, online: false, last_seen_at: null });

  const { rows } = await db.query(
    `SELECT show_online_status, last_seen_at,
            (last_seen_at > NOW() - ($2 || ' seconds')::interval) AS is_online
       FROM users WHERE id = $1`,
    [peerId, String(ONLINE_WINDOW_SECONDS)]
  );

  if (!rows.length) return res.json({ hidden: true, online: false, last_seen_at: null });

  // Someone who has turned presence off is reported as hidden rather than as
  // offline. The app then shows nothing at all — showing "offline" would leak
  // the setting itself, and would be a lie the moment they opened the app.
  if (rows[0].show_online_status === false) {
    return res.json({ hidden: true, online: false, last_seen_at: null });
  }

  res.json({
    hidden: false,
    online: rows[0].is_online === true,
    last_seen_at: rows[0].last_seen_at,
  });
});

module.exports = router;
