const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { deleteAccount } = require("../accountDeletion");

const router = express.Router();

// Keep this text identical to PRIVACY_TEXT in App.jsx (SettingsSheet) —
// there's no shared file between frontend and backend, so the two must be
// updated together by hand whenever the policy changes.
const PRIVACY_TEXT = `We collect only what's needed to connect customers with workers: your name, phone number, and approximate location when you use search or make a booking.

We do not sell your personal data to third parties. Location is used to find nearby workers and is not shared beyond what's needed to complete a booking.

Chat messages within a booking are visible to the customer and worker involved, and to Y S R admins for dispute resolution and safety purposes.

You can request account deletion at any time — see the Delete Account page linked below. This is placeholder policy text and should be reviewed by a lawyer before going live.`;

const TERMS_TEXT = `By using Y S R, you agree to behave respectfully toward other users and to only book services you genuinely intend to pay for.

Workers are independent service providers, not employees of Y S R. The platform facilitates the connection and payment between customers and workers and takes a commission on completed jobs.

Disputes are reviewed by platform admins, whose decisions on refunds or account actions are final within the app. This is placeholder legal text and should be reviewed by a lawyer before going live.`;

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Y S R</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #15140F; color: #F3EEE3; max-width: 640px; margin: 0 auto; padding: 32px 20px 60px; line-height: 1.6; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .sub { color: #9A947F; font-size: 13px; margin-bottom: 28px; }
    p { color: #D9D3C4; font-size: 14.5px; white-space: pre-line; margin-bottom: 16px; }
    a { color: #4FBF8F; }
    nav { margin-bottom: 24px; font-size: 13px; }
    nav a { margin-right: 16px; }
    input, textarea, button { font-family: inherit; font-size: 14px; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 10px; border: 1px solid #34301F; background: #211F1A; color: #F3EEE3; margin-bottom: 12px; }
    button { background: #0B6E4F; color: #FAF7F2; border: none; border-radius: 999px; padding: 13px 22px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.5; }
    .msg { padding: 12px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 13.5px; }
    .msg.error { background: #3a1f1c; color: #f0a89f; }
    .msg.success { background: #123b2d; color: #7fe3bd; }
  </style>
</head>
<body>
  <nav><a href="/privacy">Privacy Policy</a><a href="/terms">Terms & Policies</a><a href="/delete-account">Delete Account</a></nav>
  ${bodyHtml}
</body>
</html>`;
}

router.get("/privacy", (req, res) => {
  res.send(page("Privacy Policy", `<h1>Privacy Policy</h1><div class="sub">Y S R</div><p>${PRIVACY_TEXT.replace(/</g, "&lt;")}</p>`));
});

router.get("/terms", (req, res) => {
  res.send(page("Terms & Policies", `<h1>Terms & Policies</h1><div class="sub">Y S R</div><p>${TERMS_TEXT.replace(/</g, "&lt;")}</p>`));
});

// GET a simple self-service deletion form — reachable even if someone has
// uninstalled the app entirely, per Play Store's account-deletion requirement.
router.get("/delete-account", (req, res) => {
  res.send(page("Delete Account", `
    <h1>Delete your account</h1>
    <div class="sub">This permanently removes your personal information from Y S R. Booking and payment records are kept in anonymized form for legal/accounting purposes, as described in our Privacy Policy.</div>
    <div id="msg"></div>
    <form id="delForm">
      <input type="tel" id="phone" placeholder="Phone number (e.g. +2519XXXXXXXX)" required />
      <input type="password" id="password" placeholder="Password" required />
      <button type="submit">Delete my account</button>
    </form>
    <script>
      document.getElementById('delForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('phone').value;
        const password = document.getElementById('password').value;
        const msg = document.getElementById('msg');
        msg.innerHTML = '';
        try {
          const res = await fetch('/delete-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Something went wrong');
          msg.innerHTML = '<div class="msg success">Your account has been deleted.</div>';
          document.getElementById('delForm').style.display = 'none';
        } catch (err) {
          msg.innerHTML = '<div class="msg error">' + err.message + '</div>';
        }
      });
    </script>
  `));
});

// POST — actually performs the deletion, verified by phone + password just
// like a normal login, since this page works without the app installed.
router.post("/delete-account", express.json(), async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "Phone number and password are required" });

  const { rows } = await db.query("SELECT id, password_hash, is_deleted FROM users WHERE phone = $1", [phone]);
  if (!rows.length) return res.status(401).json({ error: "Phone number or password incorrect" });
  if (rows[0].is_deleted) return res.status(400).json({ error: "This account has already been deleted" });

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: "Phone number or password incorrect" });

  await deleteAccount(rows[0].id);
  res.json({ ok: true });
});

module.exports = router;
