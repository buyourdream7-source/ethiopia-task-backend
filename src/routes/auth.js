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
    if (user.is_deleted) {
      return res.status(401).json({ error: "Phone number or password incorrect" });
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
// Sends the code via AfroMessage. If AFROMESSAGE_TOKEN isn't set, or the send
// fails for any reason (bad credentials, no credit, network issue), the code
// is returned as `dev_otp` instead so registration is never fully blocked by
// an SMS problem — the app shows it on screen and says why.
// ─────────────────────────────────────────────────────────────────────────

// POST /api/auth/send-otp — generate a code and text it to the user
router.post("/send-otp", requireAuth, async (req, res) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);          // 10 minutes

    const { rows } = await db.query("SELECT phone, is_phone_verified FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    if (rows[0].is_phone_verified) return res.json({ already_verified: true });

    const phone = rows[0].phone;

    // Replace any earlier unused code for this user so only the newest works.
    await db.query("DELETE FROM otp_codes WHERE user_id = $1", [req.user.id]);
    await db.query(
      "INSERT INTO otp_codes (user_id, code, expires_at) VALUES ($1,$2,$3)",
      [req.user.id, code, expiresAt]
    );

    try {
      await sendSms(phone, `Your Y S R verification code is ${code}. It expires in 10 minutes.`);
      return res.json({ sent: true, via: "sms" });
    } catch (smsErr) {
      // SMS failed — don't strand the user. Return the code with the reason so
      // the app can show it on screen and make clear this isn't normal.
      console.error("OTP SMS send failed:", smsErr.message);
      return res.json({ sent: true, via: "fallback", dev_otp: code, reason: smsErr.message });
    }
  } catch (err) {
    console.error("POST /auth/send-otp crashed:", err);
    res.status(500).json({ error: "Could not send your verification code. Please try again." });
  }
});

// POST /api/auth/verify-otp — check the code and mark the phone verified
router.post("/verify-otp", requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Enter the code we sent you." });

    const { rows } = await db.query(
      "SELECT id, code, expires_at, attempts FROM otp_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(400).json({ error: "No code found — tap resend to get a new one." });
    }

    const otp = rows[0];

    if (new Date(otp.expires_at) < new Date()) {
      await db.query("DELETE FROM otp_codes WHERE id = $1", [otp.id]);
      return res.status(400).json({ error: "That code expired — tap resend to get a new one." });
    }

    // Cap guesses so a 6-digit code can't be brute-forced.
    if (otp.attempts >= 5) {
      await db.query("DELETE FROM otp_codes WHERE id = $1", [otp.id]);
      return res.status(429).json({ error: "Too many incorrect attempts — tap resend to get a new code." });
    }

    if (String(code).trim() !== otp.code) {
      await db.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
      return res.status(400).json({ error: "That code isn't right. Please check and try again." });
    }

    await db.query("UPDATE users SET is_phone_verified = true, updated_at = now() WHERE id = $1", [req.user.id]);
    await db.query("DELETE FROM otp_codes WHERE user_id = $1", [req.user.id]);

    res.json({ verified: true });
  } catch (err) {
    console.error("POST /auth/verify-otp crashed:", err);
    res.status(500).json({ error: "Could not verify your code. Please try again." });
  }
});

module.exports = router;
