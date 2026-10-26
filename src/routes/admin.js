const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { signedUrlFor } = require("../storage");
const { deleteAccount } = require("../accountDeletion");
const { sendPush } = require("../push");

const { makeSafe } = require("../utils/safeRouter");

const router = express.Router();
// A thrown error here returns 500 instead of killing the whole process.
makeSafe(router);
router.use(requireAuth, requireRole("admin"));

// GET /api/admin/stats — the numbers shown on the admin dashboard home
router.get("/stats", async (req, res) => {
  // Deleted accounts keep their row so booking history stays intact, but they
  // shouldn't be counted as users — otherwise the dashboard keeps reporting
  // people who have left.
  const queries = {
    total_users: "SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer' AND is_deleted IS NOT TRUE",
    total_workers: `SELECT COUNT(*)::int AS n FROM worker_profiles wp
                    JOIN users u ON u.id = wp.user_id WHERE u.is_deleted IS NOT TRUE`,
    verified_workers: `SELECT COUNT(*)::int AS n FROM worker_profiles wp
                       JOIN users u ON u.id = wp.user_id
                       WHERE wp.verification_status = 'verified' AND u.is_deleted IS NOT TRUE`,
    active_bookings: "SELECT COUNT(*)::int AS n FROM bookings WHERE status NOT IN ('confirmed','cancelled','disputed')",
    completed_jobs: "SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'confirmed'",
    pending_verifications: `SELECT COUNT(*)::int AS n FROM worker_profiles wp
                            JOIN users u ON u.id = wp.user_id
                            WHERE wp.verification_status = 'pending' AND u.is_deleted IS NOT TRUE`,
    open_disputes: "SELECT COUNT(*)::int AS n FROM disputes WHERE status IN ('open','investigating')",
    revenue_total: "SELECT COALESCE(SUM(commission_amount),0)::numeric(12,2) AS n FROM bookings WHERE status = 'confirmed'",
  };

  const results = {};
  for (const [key, sql] of Object.entries(queries)) {
    const { rows } = await db.query(sql);
    results[key] = rows[0].n;
  }
  res.json(results);
});

// --- Verification queue ---

router.get("/verifications", async (req, res) => {
  const { rows } = await db.query(
    `SELECT wp.id AS worker_id, u.full_name, u.phone, wp.verification_status, wp.created_at,
            json_agg(json_build_object('id', vd.id, 'doc_type', vd.doc_type, 'status', vd.status,
                                       'file_url', vd.file_url, 'storage_public_id', vd.storage_public_id))
              FILTER (WHERE vd.id IS NOT NULL) AS documents
     FROM worker_profiles wp
     JOIN users u ON u.id = wp.user_id
     LEFT JOIN verification_documents vd ON vd.worker_id = wp.id
     WHERE wp.verification_status = 'pending' AND u.is_deleted IS NOT TRUE
     GROUP BY wp.id, u.full_name, u.phone
     ORDER BY wp.updated_at ASC`
  );

  // Documents are stored as private Cloudinary uploads, so the stored URL
  // won't load on its own. Swap in a short-lived signed URL for viewing.
  // Older documents (uploaded before private storage) have no public_id and
  // keep their original URL.
  const results = rows.map((row) => ({
    ...row,
    documents: (row.documents || []).map((d) => ({
      ...d,
      file_url: d.storage_public_id ? signedUrlFor(d.storage_public_id) : d.file_url,
    })),
  }));

  res.json(results);
});

router.patch("/verifications/:workerId", async (req, res) => {
  const { decision } = req.body; // "approved" | "rejected"
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const newStatus = decision === "approved" ? "verified" : "rejected";
  const { rows } = await db.query(
    "UPDATE worker_profiles SET verification_status = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [newStatus, req.params.workerId]
  );
  if (!rows.length) return res.status(404).json({ error: "Worker not found" });

  await db.query(
    "UPDATE verification_documents SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE worker_id = $3 AND status = 'pending'",
    [decision, req.user.id, req.params.workerId]
  );

  res.json(rows[0]);
});

// --- Disputes ---

router.get("/disputes", async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.*, b.status AS booking_status, u.full_name AS raised_by_name
     FROM disputes d
     JOIN bookings b ON b.id = d.booking_id
     JOIN users u ON u.id = d.raised_by
     ORDER BY d.created_at DESC`
  );
  res.json(rows);
});

router.patch("/disputes/:id", async (req, res) => {
  const { status, resolution_note } = req.body;
  const { rows } = await db.query(
    `UPDATE disputes SET
       status = COALESCE($1, status),
       resolution_note = COALESCE($2, resolution_note),
       resolved_by = CASE WHEN $1 IN ('resolved','dismissed') THEN $3 ELSE resolved_by END,
       resolved_at = CASE WHEN $1 IN ('resolved','dismissed') THEN now() ELSE resolved_at END
     WHERE id = $4 RETURNING *`,
    [status || null, resolution_note || null, req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Dispute not found" });
  res.json(rows[0]);
});

// --- Users ---

router.patch("/users/:id/suspend", async (req, res) => {
  const { suspended } = req.body;
  const { rows } = await db.query(
    "UPDATE users SET is_suspended = $1, updated_at = now() WHERE id = $2 RETURNING id, full_name, is_suspended",
    [!!suspended, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

// --- Managing accounts (admin) ---

// Customers and workers, newest first. ?role=customer|worker narrows it,
// ?q= matches name or phone. Deleted accounts are left out.
router.get("/users", async (req, res) => {
  try {
    const params = [];
    const where = ["u.role IN ('customer','worker')", "u.is_deleted IS NOT TRUE"];

    if (["customer", "worker"].includes(req.query.role)) {
      params.push(req.query.role);
      where.push(`u.role = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      where.push(`(u.full_name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.role, u.is_suspended, u.created_at
       FROM users u
       WHERE ${where.join(" AND ")}
       ORDER BY u.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /admin/users crashed:", e);
    res.status(500).json({ error: "Could not load users." });
  }
});

// Delete an account. Same scrub the user gets from the app (personal data
// removed, booking history kept), plus the phone number is released so the
// person can register again. phone is varchar(20), hence the short value.
router.delete("/users/:id", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT id, role, is_deleted FROM users WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });

    const target = rows[0];
    if (target.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account here." });
    if (target.role === "admin") return res.status(400).json({ error: "Admin accounts can't be deleted from here." });

    if (!target.is_deleted) await deleteAccount(target.id);

    await db.query(
      `UPDATE users
          SET phone = 'del-' || substr(replace(id::text, '-', ''), 1, 15),
              fcm_token = NULL,
              is_deleted = true,
              updated_at = now()
        WHERE id = $1`,
      [target.id]
    );
    await db.query("UPDATE worker_profiles SET is_available = false WHERE user_id = $1", [target.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /admin/users/:id crashed:", e);
    res.status(500).json({ error: "Could not delete that account." });
  }
});

// Set a new password for someone locked out. The old one is never shown (it
// is hashed and can't be read back); the admin types a new one and tells the
// person, who should change it from their own settings.
router.patch("/users/:id/password", async (req, res) => {
  try {
    const { new_password } = req.body;
    if (typeof new_password !== "string" || new_password.length < 8) {
      return res.status(400).json({ error: "The new password must be at least 8 characters." });
    }

    const { rows } = await db.query("SELECT id, role, is_deleted FROM users WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    if (rows[0].is_deleted) return res.status(400).json({ error: "That account has been deleted." });
    if (rows[0].role === "admin") return res.status(400).json({ error: "Admin passwords can't be changed from here." });

    const hash = await bcrypt.hash(new_password, 12);
    await db.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [hash, rows[0].id]);

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /admin/users/:id/password crashed:", e);
    res.status(500).json({ error: "Could not change the password." });
  }
});

// --- Messages from the admin ---
//
// A note from the platform to one person, or to a whole group: a "suggestion"
// (friendly nudge) or a "warning" (something they need to act on). It lands
// in the person's notification bell like any booking update, and as a push.
//
// A warning is delivered even if the person has switched notifications off in
// Settings, because "your account may be suspended" shouldn't be mutable.
// Suggestions respect that setting.

const MESSAGE_KINDS = {
  warning:    { type: "admin_warning",    prefix: "\u26A0\uFE0F " },
  suggestion: { type: "admin_suggestion", prefix: "\uD83D\uDCA1 " },
};

async function insertNotification(userId, title, body, type) {
  try {
    await db.query(
      "INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,$4)",
      [userId, title, body, type]
    );
  } catch (e) {
    // If the type column rejects the value, still deliver the message.
    await db.query("INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)", [userId, title, body]);
  }
}

// POST /api/admin/messages
// { kind: "warning" | "suggestion", title, body,
//   audience: "user" | "customers" | "workers" | "everyone", user_id? }
router.post("/messages", async (req, res) => {
  try {
    const { kind, audience } = req.body;
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();

    if (!MESSAGE_KINDS[kind]) return res.status(400).json({ error: "kind must be 'warning' or 'suggestion'." });
    if (!title || title.length > 80) return res.status(400).json({ error: "Add a short title (80 characters at most)." });
    if (!body || body.length > 500) return res.status(400).json({ error: "Write the message (500 characters at most)." });

    let recipients;
    if (audience === "user") {
      if (!req.body.user_id) return res.status(400).json({ error: "Choose who to send this to." });
      ({ rows: recipients } = await db.query(
        "SELECT id, fcm_token, notifications_enabled FROM users WHERE id = $1 AND is_deleted IS NOT TRUE",
        [req.body.user_id]
      ));
    } else if (["customers", "workers", "everyone"].includes(audience)) {
      const roles = audience === "customers" ? ["customer"] : audience === "workers" ? ["worker"] : ["customer", "worker"];
      ({ rows: recipients } = await db.query(
        "SELECT id, fcm_token, notifications_enabled FROM users WHERE role = ANY($1) AND is_deleted IS NOT TRUE",
        [roles]
      ));
    } else {
      return res.status(400).json({ error: "audience must be user, customers, workers or everyone." });
    }
    if (!recipients.length) return res.status(404).json({ error: "No one to send this to." });

    const { type, prefix } = MESSAGE_KINDS[kind];
    const fullTitle = prefix + title;
    let sent = 0;

    for (const r of recipients) {
      const muted = r.notifications_enabled === false && kind !== "warning";
      if (muted) continue;
      try {
        await insertNotification(r.id, fullTitle, body, type);
        await sendPush(r.fcm_token, fullTitle, body, { kind });
        sent++;
      } catch (e) {
        console.error("admin message to", r.id, "failed:", e.message);
      }
    }

    res.json({ sent, total: recipients.length });
  } catch (e) {
    console.error("POST /admin/messages crashed:", e);
    res.status(500).json({ error: "Could not send the message." });
  }
});

// --- Customers ---

router.get("/customers", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.full_name, u.phone, u.is_suspended,
        (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'confirmed') AS jobs_completed
      FROM users u WHERE u.role = 'customer' AND u.is_deleted IS NOT TRUE
      ORDER BY u.is_suspended DESC, u.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /admin/customers crashed:", e);
    res.status(500).json({ error: "Could not load customers." });
  }
});

// --- Commission settings ---

router.get("/settings/commission", async (req, res) => {
  const { rows } = await db.query("SELECT value FROM platform_settings WHERE key = 'commission_rate'");
  res.json({ commission_rate: parseFloat(rows[0]?.value || "0.1") });
});

router.patch("/settings/commission", async (req, res) => {
  const { rate } = req.body;
  if (rate === undefined || rate < 0 || rate > 0.5) {
    return res.status(400).json({ error: "rate must be between 0 and 0.5 (0–50%)" });
  }
  await db.query(
    `UPDATE platform_settings SET value = $1, updated_at = now(), updated_by = $2 WHERE key = 'commission_rate'`,
    [String(rate), req.user.id]
  );
  res.json({ commission_rate: rate });
});

// --- Inspection fees ---
//
// Charged upfront on variable-priced jobs (electrician, plumber and so on)
// to cover the worker's visit before a quote can be given. Set per category
// rather than globally, since a plumbing call-out and a construction survey
// aren't worth the same.

router.get("/settings/inspection-fees", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name_en, inspection_fee, pricing_type
       FROM categories
       WHERE parent_slug IS NULL
       ORDER BY sort_order, name_en`
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /admin/settings/inspection-fees crashed:", e);
    res.status(500).json({ error: "Could not load inspection fees." });
  }
});

router.patch("/settings/inspection-fees/:slug", async (req, res) => {
  try {
    const { fee, pricing_type } = req.body;

    const updates = [];
    const params = [];

    if (fee !== undefined) {
      const value = Number(fee);
      if (!Number.isFinite(value) || value < 0 || value > 10000) {
        return res.status(400).json({ error: "Fee must be between 0 and 10,000 ETB." });
      }
      params.push(value);
      updates.push(`inspection_fee = $${params.length}`);
    }

    if (pricing_type !== undefined) {
      if (!["fixed", "variable"].includes(pricing_type)) {
        return res.status(400).json({ error: "Pricing type must be fixed or variable." });
      }
      params.push(pricing_type);
      updates.push(`pricing_type = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: "Nothing to update." });

    params.push(req.params.slug);
    const { rows } = await db.query(
      `UPDATE categories SET ${updates.join(", ")}, updated_at = now()
       WHERE slug = $${params.length}
       RETURNING id, slug, name_en, inspection_fee, pricing_type`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Category not found" });

    // Bookings record their own pricing_type when created, so changing a
    // category here only affects future bookings — jobs already underway
    // keep the terms the customer agreed to.
    res.json(rows[0]);
  } catch (e) {
    console.error("PATCH /admin/settings/inspection-fees crashed:", e);
    res.status(500).json({ error: "Could not update the category." });
  }
});

// GET /api/admin/referrals — who has invited workers and what YSR owes them.
router.get("/referrals", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT wp.id AS worker_id, u.full_name, u.phone, wp.referral_code,
              (SELECT COUNT(*)::int FROM worker_profiles x WHERE x.referred_by = wp.id) AS invited,
              COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'owed'), 0) AS owed,
              COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'paid'), 0) AS paid
       FROM worker_profiles wp
       JOIN users u ON u.id = wp.user_id
       LEFT JOIN referral_rewards r ON r.referrer_id = wp.id
       WHERE u.is_deleted IS NOT TRUE
         AND (EXISTS (SELECT 1 FROM worker_profiles x WHERE x.referred_by = wp.id))
       GROUP BY wp.id, u.full_name, u.phone, wp.referral_code
       ORDER BY owed DESC, invited DESC`
    );
    res.json(rows.map((r) => ({ ...r, owed: Number(r.owed), paid: Number(r.paid) })));
  } catch (e) {
    console.error("GET /admin/referrals crashed:", e);
    res.status(500).json({ error: "Could not load referrals." });
  }
});

// POST /api/admin/referrals/:workerId/pay — after paying a referrer outside
// the app (Telebirr, bank, cash), mark everything owed to them as paid.
router.post("/referrals/:workerId/pay", async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE referral_rewards SET status = 'paid', paid_at = now()
       WHERE referrer_id = $1 AND status = 'owed' RETURNING amount`,
      [req.params.workerId]
    );
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    if (total > 0) {
      const { rows: u } = await db.query("SELECT user_id FROM worker_profiles WHERE id = $1", [req.params.workerId]);
      if (u.length) {
        const { notify } = require("../utils/notify");
        await notify(u[0].user_id, "Referral bonus paid", `We paid your referral bonus of ${total} ETB.`, null);
      }
    }
    res.json({ paid: total });
  } catch (e) {
    console.error("POST /admin/referrals/:id/pay crashed:", e);
    res.status(500).json({ error: "Could not mark this as paid." });
  }
});

module.exports = router;
