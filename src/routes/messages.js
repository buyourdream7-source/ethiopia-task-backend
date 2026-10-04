const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { notify } = require("../utils/notify");

const { makeSafe } = require("../utils/safeRouter");

const router = express.Router();
// A thrown error here returns 500 instead of killing the whole process.
makeSafe(router);

async function loadConversation(bookingId, userId) {
  const { rows } = await db.query(
    "SELECT * FROM conversations WHERE booking_id = $1 AND (customer_id = $2 OR worker_id = $2)",
    [bookingId, userId]
  );
  return rows[0] || null;
}

router.get("/:bookingId/messages", requireAuth, async (req, res) => {
  const convo = await loadConversation(req.params.bookingId, req.user.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });

  const { rows } = await db.query(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [convo.id]
  );
  res.json(rows);
});

// Spots phone numbers and other off-platform contact details in a message.
// Deliberately loose — this drives a gentle reminder, not a block, so a few
// false positives cost nothing.
function hasContactDetails(text) {
  const t = String(text);
  return (
    /(\+?251|0)\s*[79][\d\s-]{7,}/.test(t) ||      // Ethiopian mobile numbers
    /\b\d[\d\s-]{8,}\b/.test(t) ||                  // any long digit run
    /\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(t) ||        // email
    /\b(telegram|whatsapp|viber|imo)\b/i.test(t)    // other messaging apps
  );
}

router.post("/:bookingId/messages", requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  const convo = await loadConversation(req.params.bookingId, req.user.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });

  const { rows } = await db.query(
    "INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1,$2,$3) RETURNING *",
    [convo.id, req.user.id, content.trim()]
  );

  // Tell the other side. Without this a message just sits in the app until
  // someone happens to open it, which is how jobs stall — of everything we
  // notify about, an unanswered question is the one that actually blocks work.
  //
  // The conversation carries both user ids, so the recipient is simply
  // whichever one isn't the sender. Deliberately not awaited: notify() already
  // swallows its own errors, and a slow push should never hold up the reply
  // that puts the message on the sender's screen.
  const recipientId = String(convo.customer_id) === String(req.user.id)
    ? convo.worker_id
    : convo.customer_id;

  if (recipientId) {
    (async () => {
      let senderName = "New message";
      try {
        const { rows: s } = await db.query("SELECT full_name FROM users WHERE id = $1", [req.user.id]);
        if (s.length && s[0].full_name) senderName = s[0].full_name;
      } catch { /* fall back to the generic title */ }

      // The message itself is the body, trimmed to something a notification
      // tray can actually show. Title is the sender's name, because "Abebe"
      // gets opened and "New message" gets swiped away.
      const preview = content.trim().length > 120
        ? `${content.trim().slice(0, 117)}…`
        : content.trim();

      await notify(recipientId, senderName, preview, convo.booking_id);
    })();
  }

  // The message still sends — workers and customers genuinely need to share
  // addresses and sometimes numbers to get a job done. But flag it so the app
  // can remind them that moving off Y S R loses them the payment protection
  // and dispute support that comes with booking through the platform.
  res.status(201).json({ ...rows[0], contact_warning: hasContactDetails(content) });
});

module.exports = router;
