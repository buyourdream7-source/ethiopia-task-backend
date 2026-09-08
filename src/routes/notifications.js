const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.user.id]
  );
  res.json(rows);
});

router.get("/unread-count", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND is_read = false",
    [req.user.id]
  );
  res.json({ count: Number(rows[0].n) });
});

router.patch("/:id/read", requireAuth, async (req, res) => {
  await db.query(
    "UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.patch("/read-all", requireAuth, async (req, res) => {
  await db.query("UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false", [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
