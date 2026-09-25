const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

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

  // The message still sends — workers and customers genuinely need to share
  // addresses and sometimes numbers to get a job done. But flag it so the app
  // can remind them that moving off Y S R loses them the payment protection
  // and dispute support that comes with booking through the platform.
  res.status(201).json({ ...rows[0], contact_warning: hasContactDetails(content) });
});

module.exports = router;
