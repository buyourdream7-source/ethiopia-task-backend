const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { deleteAccount } = require("../accountDeletion");

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, phone, email, full_name, role, preferred_language,
            profile_photo_url, is_phone_verified, subscription_active, subscription_expires_at, notifications_enabled, created_at
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

    const { rows: settingRows } = await db.query(
      "SELECT key, value FROM platform_settings WHERE key IN ('subscription_price_etb', 'subscription_period_days')"
    );
    const settingsMap = Object.fromEntries(settingRows.map((s) => [s.key, s.value]));
    user.subscription_price_etb = parseFloat(settingsMap.subscription_price_etb || "811.75");
    user.subscription_period_days = parseInt(settingsMap.subscription_period_days || "90", 10);
  }

  res.json(user);
});

router.patch("/me", requireAuth, async (req, res) => {
  const { full_name, email, preferred_language, profile_photo_url, notifications_enabled } = req.body;
  const { rows } = await db.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       email = COALESCE($2, email),
       preferred_language = COALESCE($3, preferred_language),
       profile_photo_url = COALESCE($4, profile_photo_url),
       notifications_enabled = COALESCE($5, notifications_enabled),
       updated_at = now()
     WHERE id = $6
     RETURNING id, phone, email, full_name, role, preferred_language, profile_photo_url, notifications_enabled`,
    [full_name, email, preferred_language, profile_photo_url, notifications_enabled, req.user.id]
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

// PATCH /api/users/me/fcm-token — called once the app registers for push
// notifications and gets a device token from Firebase.
router.patch("/me/fcm-token", requireAuth, async (req, res) => {
  const { fcm_token } = req.body;
  if (!fcm_token) return res.status(400).json({ error: "fcm_token is required" });
  await db.query("UPDATE users SET fcm_token = $1, updated_at = now() WHERE id = $2", [fcm_token, req.user.id]);
  res.json({ ok: true });
});

// DELETE /api/users/me — requires the current password as confirmation.
// Personal data is scrubbed; booking/payment history is kept (see
// accountDeletion.js for why) so the other party's records stay intact.
router.delete("/me", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Your current password is required to delete your account" });

  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "User not found" });

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: "Incorrect password" });

  await deleteAccount(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
