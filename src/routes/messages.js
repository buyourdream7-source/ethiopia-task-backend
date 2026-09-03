const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

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
  res.status(201).json(rows[0]);
});

module.exports = router;
