const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/jwt");
const { requireAuth } = require("../middleware/auth");
const { sendSms } = require("../utils/afromessage");

const router = express.Router();

// Ethiopian mobile numbers: +2519XXXXXXXX or +2517XXXXXXXX (9 or 7 series), 9 digits after country code
const PHONE_REGEX = /^\+251[97]\d{8}$/;

router.post("/register", async (req, res) => {
  const { phone, email, password, full_name, role, preferred_language } = req.body;

  if (!phone || !password || !full_name) {
    return res.status(400).json({ error: "phone, password and full_name are required" });
  }
  if (!PHONE_REGEX.test(phone)) {
    return res.status(400).json({ error: "phone must be a valid Ethiopian number, e.g. +251912345678" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const finalRole = ["customer", "worker"].includes(role) ? role : "customer";
  // Admins are never created through public registration — see scripts/create-admin.js

  try {
    const existing = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: "An account with this phone number already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await db.query(
      `INSERT INTO users (phone, email, password_hash, full_name, role, preferred_language)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, phone, email, full_name, role, preferred_language, created_at`,
      [phone, email || null, passwordHash, full_name, finalRole, preferred_language || "en"]
    );
    const user = rows[0];

    // Worker accounts automatically get an empty worker_profile row to fill in next
    if (finalRole === "worker") {
      await db.query("INSERT INTO worker_profiles (user_id) VALUES ($1)", [user.id]);
    }

    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create account" });
  }
});

router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "phone and password are required" });
  }

  try {
    const { rows } = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "Phone number or password incorrect" });
    }
    if (user.is_suspended) {
      return res.status(403).json({ error: "This account has been suspended. Contact support." });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Phone number or password incorrect" });
    }

    delete user.password_hash;
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Phone verification (OTP)
//
// Sends the code via AfroMessage if AFROMESSAGE_TOKEN is set. If it's not
// set yet, or the send fails for any reason (bad credentials, no credit,
// network issue), falls back to returning the code directly as `dev_otp`
// so testing/registration never gets fully blocked by an SMS issue.
// ─────────────────────────────────────────────────────────────────────────
router.post("/send-otp", requireAuth, async (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.query("DELETE FROM phone_otps WHERE user_id = $1", [req.user.id]);
  await db.query(
    "INSERT INTO phone_otps (user_id, code, expires_at) VALUES ($1, $2, $3)",
    [req.user.id, code, expiresAt]
  );

  let smsSent = false;
  let smsError = null;
  try {
    await sendSms(req.user.phone, `Your Y S R verification code is ${code}`);
    smsSent = true;
  } catch (e) {
    smsError = e.message;
  }

  const response = { sent: smsSent, expires_in_seconds: 600 };
  if (!smsSent) {
    response.dev_otp = code;
    response.dev_note = smsError; // visible only in this fallback case, useful for debugging AfroMessage setup
  }
  res.json(response);
});

router.post("/verify-otp", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code is required" });

  const { rows } = await db.query(
    "SELECT * FROM phone_otps WHERE user_id = $1 AND code = $2 AND expires_at > now()",
    [req.user.id, String(code)]
  );
  if (!rows.length) {
    return res.status(400).json({ error: "That code is incorrect or has expired." });
  }

  await db.query("UPDATE users SET is_phone_verified = true, updated_at = now() WHERE id = $1", [req.user.id]);
  await db.query("DELETE FROM phone_otps WHERE user_id = $1", [req.user.id]);

  res.json({ verified: true });
});

module.exports = router;
