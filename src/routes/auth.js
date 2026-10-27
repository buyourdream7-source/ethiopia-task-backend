const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/jwt");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Referral codes look like YSR-K7M2P. No 0/O/1/I/L so they survive being read
// out loud or typed from a screenshot.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeReferralCode = () => {
  let s = "YSR-";
  for (let i = 0; i < 5; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
};

// Creates the worker's profile row with its one-and-only referral code.
async function createWorkerProfile(userId, referredBy) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await db.query(
        "INSERT INTO worker_profiles (user_id, referral_code, referred_by) VALUES ($1, $2, $3)",
        [userId, makeReferralCode(), referredBy || null]
      );
      return;
    } catch (e) {
      // 23505 = that code already exists; try another. Anything else is real.
      if (e.code !== "23505" || !String(e.constraint || "").includes("referral_code")) throw e;
    }
  }
  throw new Error("Could not generate a referral code");
}

// Ethiopian mobile numbers: +2519XXXXXXXX or +2517XXXXXXXX (9 or 7 series), 9 digits after country code
const PHONE_REGEX = /^\+251[97]\d{8}$/;

router.post("/register", async (req, res) => {
  const { phone, email, password, full_name, role, preferred_language, referral_code } = req.body;

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
    // A referral code is optional and only means something for workers. If one
    // is typed it has to be real, so a typo doesn't quietly cost the referrer.
    let referredBy = null;
    const typedCode = String(referral_code || "").trim().toUpperCase();
    if (finalRole === "worker" && typedCode) {
      const { rows: ref } = await db.query(
        `SELECT wp.id FROM worker_profiles wp JOIN users u ON u.id = wp.user_id
         WHERE wp.referral_code = $1 AND u.is_deleted IS NOT TRUE AND u.is_suspended IS NOT TRUE`,
        [typedCode]
      );
      if (!ref.length) return res.status(400).json({ error: "That referral code isn't valid. Check it, or leave it empty." });
      referredBy = ref[0].id;
    }

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
      try {
        try {
        await createWorkerProfile(user.id, referredBy);
      } catch (profileErr) {
        // Don't leave a worker account with no profile behind: remove it so
        // the person can simply try again with the same phone number.
        await db.query("DELETE FROM users WHERE id = $1", [user.id]).catch(() => {});
        throw profileErr;
      }
      } catch (profileErr) {
        // Don't leave a half-made account behind: without this, a failed
        // profile insert would leave the phone number taken by a user who can
        // never log in as a worker.
        await db.query("DELETE FROM users WHERE id = $1", [user.id]).catch(() => {});
        throw profileErr;
      }
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
// Phone verification (OTP) — DISABLED
//
// Removed for now: no SMS provider credit yet, and OTP isn't needed at this
// stage. New users are treated as verified (see migration_015).
//
// To re-enable later:
//   1. Restore these routes from git history
//   2. Set AFROMESSAGE_TOKEN + AFROMESSAGE_SENDER_NAME on Railway
//   3. Restore PhoneVerificationGate in App.jsx
//   4. ALTER TABLE users ALTER COLUMN is_phone_verified SET DEFAULT false;
// ─────────────────────────────────────────────────────────────────────────

module.exports = router;
