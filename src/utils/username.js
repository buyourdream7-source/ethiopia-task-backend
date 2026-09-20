// Usernames: unique, so a customer searching for a worker gets one person
// rather than three people called Abebe.
//
// Matching is case-insensitive — "Yasir" and "yasir" are the same person as
// far as anyone searching is concerned, so only one of them is claimable.

const db = require("../db");

const MIN_LENGTH = 3;
const MAX_LENGTH = 20;
const CHANGE_INTERVAL_DAYS = 30;

/**
 * Turns whatever someone typed into something usable as a username, or
 * returns null if nothing usable is left.
 */
function normalise(input) {
  const cleaned = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  return cleaned.length ? cleaned.slice(0, MAX_LENGTH) : null;
}

/**
 * Checks a username the user chose themselves. Returns an error message to
 * show them, or null if it's fine.
 */
function validate(username) {
  if (!username) return "Pick a username using letters, numbers or underscores.";
  if (username.length < MIN_LENGTH) return `Usernames need at least ${MIN_LENGTH} characters.`;
  if (/^\d+$/.test(username)) return "Usernames can't be only numbers.";
  return null;
}

/**
 * Builds a free username from someone's name at registration: "Yasir
 * Seyfedin" → "yasir", or "yasir2" if that's taken. Falls back to their
 * phone digits when the name has no usable letters.
 */
async function generateFrom(fullName, phone) {
  let base = normalise(String(fullName || "").split(" ")[0]);

  if (!base || base.length < MIN_LENGTH) {
    const digits = String(phone || "").replace(/\D/g, "");
    base = `user${digits.slice(-6) || Math.floor(100000 + Math.random() * 900000)}`;
  }

  let proposed = base;
  let n = 1;
  // Bounded rather than while(true): if something goes wrong with the
  // uniqueness check we'd rather fall back to a random suffix than spin.
  for (let i = 0; i < 50; i++) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE lower(username) = $1", [proposed]);
    if (!rows.length) return proposed;
    n += 1;
    proposed = `${base}${n}`.slice(0, MAX_LENGTH);
  }
  return `${base}${Date.now().toString().slice(-5)}`.slice(0, MAX_LENGTH);
}

/**
 * Whether this user is allowed to change their username yet, and when they
 * next can. Limiting changes keeps a worker's identity stable for the
 * customers who booked them before.
 */
function changeStatus(usernameChangedAt) {
  if (!usernameChangedAt) return { allowed: true, nextChangeAt: null };

  const next = new Date(usernameChangedAt);
  next.setDate(next.getDate() + CHANGE_INTERVAL_DAYS);

  return { allowed: new Date() >= next, nextChangeAt: next };
}

module.exports = { normalise, validate, generateFrom, changeStatus, CHANGE_INTERVAL_DAYS };
