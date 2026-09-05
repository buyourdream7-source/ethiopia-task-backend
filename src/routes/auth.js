const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/jwt");

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

module.exports = router;
