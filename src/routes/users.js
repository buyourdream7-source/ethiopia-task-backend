const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, phone, email, full_name, role, preferred_language,
            profile_photo_url, is_phone_verified, subscription_active, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  const user = rows[0];

  if (user.role === "customer") {
    const { rows: countRows } = await db.query(
      "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = $1 AND status = 'confirmed'",
      [req.user.id]
    );
    user.free_jobs_used = Number(countRows[0].n);

    const { rows: priceRows } = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'subscription_price_etb'"
    );
    user.subscription_price_etb = parseFloat(priceRows[0]?.value || "811.75");
  }

  res.json(user);
});

router.patch("/me", requireAuth, async (req, res) => {
  const { full_name, email, preferred_language, profile_photo_url } = req.body;
  const { rows } = await db.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       email = COALESCE($2, email),
       preferred_language = COALESCE($3, preferred_language),
       profile_photo_url = COALESCE($4, profile_photo_url),
       updated_at = now()
     WHERE id = $5
     RETURNING id, phone, email, full_name, role, preferred_language, profile_photo_url`,
    [full_name, email, preferred_language, profile_photo_url, req.user.id]
  );
  res.json(rows[0]);
});

// --- Saved addresses ---

router.get("/me/addresses", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC",
    [req.user.id]
  );
  res.json(rows);
});

router.post("/me/addresses", requireAuth, async (req, res) => {
  const { label, city, subcity, area_text, latitude, longitude, is_default } = req.body;
  if (!area_text || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "area_text, latitude and longitude are required" });
  }

  if (is_default) {
    await db.query("UPDATE addresses SET is_default = false WHERE user_id = $1", [req.user.id]);
  }

  const { rows } = await db.query(
    `INSERT INTO addresses (user_id, label, city, subcity, area_text, latitude, longitude, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, label || null, city || "Addis Ababa", subcity || null, area_text, latitude, longitude, !!is_default]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
