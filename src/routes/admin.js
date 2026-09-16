const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { signedUrlFor } = require("../storage");
const { notify } = require("../utils/notify");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// GET /api/admin/stats — the numbers shown on the admin dashboard home
router.get("/stats", async (req, res) => {
  const queries = {
    total_users: "SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'",
    total_workers: "SELECT COUNT(*)::int AS n FROM worker_profiles",
    verified_workers: "SELECT COUNT(*)::int AS n FROM worker_profiles WHERE verification_status = 'verified'",
    active_bookings: "SELECT COUNT(*)::int AS n FROM bookings WHERE status NOT IN ('confirmed','cancelled','disputed')",
    completed_jobs: "SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'confirmed'",
    pending_verifications: "SELECT COUNT(*)::int AS n FROM worker_profiles WHERE verification_status = 'pending'",
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
     WHERE wp.verification_status = 'pending'
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

// --- Customer subscriptions (manual for now — no online payment collection wired up yet) ---

router.get("/customers", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.full_name, u.phone, u.subscription_active, u.is_suspended, u.payment_deadline,
        (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'confirmed') AS free_jobs_used
      FROM users u WHERE u.role = 'customer'
      ORDER BY u.is_suspended DESC, u.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /admin/customers crashed:", e);
    res.status(500).json({ error: "Could not load customers." });
  }
});

router.patch("/customers/:id/subscription", async (req, res) => {
  const { active } = req.body;
  const { rows } = await db.query(
    "UPDATE users SET subscription_active = $1, updated_at = now() WHERE id = $2 AND role = 'customer' RETURNING id, full_name, subscription_active",
    [!!active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Customer not found" });
  res.json(rows[0]);
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

router.get("/settings/subscription-price", async (req, res) => {
  const { rows } = await db.query("SELECT value FROM platform_settings WHERE key = 'subscription_price_etb'");
  res.json({ subscription_price_etb: parseFloat(rows[0]?.value || "811.75") });
});

router.patch("/settings/subscription-price", async (req, res) => {
  const { price } = req.body;
  if (price === undefined || price < 0) {
    return res.status(400).json({ error: "price must be a positive number" });
  }
  await db.query(
    `UPDATE platform_settings SET value = $1, updated_at = now(), updated_by = $2 WHERE key = 'subscription_price_etb'`,
    [String(price), req.user.id]
  );
  res.json({ subscription_price_etb: price });
});

// --- Categories ---

router.post("/categories", async (req, res) => {
  const { slug, name_en, name_am, icon_key, sort_order } = req.body;
  if (!slug || !name_en) return res.status(400).json({ error: "slug and name_en are required" });
  const { rows } = await db.query(
    `INSERT INTO categories (slug, name_en, name_am, icon_key, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [slug, name_en, name_am || null, icon_key || null, sort_order || 0]
  );
  res.status(201).json(rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────
// Worker payouts
//
// Automatic splitting via Chapa subaccounts isn't available yet, so payouts
// happen outside the app. These endpoints track who is owed what, and record
// payments as they're made, so nothing depends on anyone's memory.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/admin/payouts — every worker with their earned / paid / owed figures
router.get("/payouts", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT wp.id AS worker_id, u.full_name, u.phone,
             wp.bank_name, wp.account_number, wp.account_name,
             COALESCE(earned.total, 0) AS total_earned,
             COALESCE(paid.total, 0)   AS total_paid_out,
             GREATEST(COALESCE(earned.total, 0) - COALESCE(paid.total, 0), 0) AS balance_owed
      FROM worker_profiles wp
      JOIN users u ON u.id = wp.user_id
      LEFT JOIN (
        SELECT worker_id, SUM(worker_earnings) AS total
        FROM bookings WHERE status = 'confirmed' GROUP BY worker_id
      ) earned ON earned.worker_id = wp.id
      LEFT JOIN (
        SELECT worker_id, SUM(amount) AS total
        FROM worker_payouts GROUP BY worker_id
      ) paid ON paid.worker_id = wp.id
      WHERE u.is_deleted IS NOT TRUE
      ORDER BY balance_owed DESC, u.full_name
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /admin/payouts crashed:", e);
    res.status(500).json({ error: "Could not load payouts." });
  }
});

// POST /api/admin/payouts — record a payment made to a worker
router.post("/payouts", async (req, res) => {
  try {
    const { worker_id, amount, method, reference, note } = req.body;
    const value = Number(amount);
    if (!worker_id || !value || value <= 0) {
      return res.status(400).json({ error: "A worker and a positive amount are required." });
    }

    const { rows } = await db.query(
      `INSERT INTO worker_payouts (worker_id, amount, method, reference, note, paid_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, amount, method, reference, paid_at`,
      [worker_id, value, method || null, reference || null, note || null, req.user.id]
    );

    // Let the worker know, so they aren't left wondering whether it happened.
    const { rows: wp } = await db.query(
      "SELECT user_id FROM worker_profiles WHERE id = $1",
      [worker_id]
    );
    if (wp.length) {
      await notify(wp[0].user_id, "Payment sent", `A payout of ${value.toFixed(2)} ETB has been recorded for you.`);
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("POST /admin/payouts crashed:", e);
    res.status(500).json({ error: "Could not record the payout." });
  }
});

module.exports = router;
