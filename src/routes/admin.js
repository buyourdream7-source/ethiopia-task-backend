const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { signedUrlFor } = require("../storage");

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

// --- Customers ---

router.get("/customers", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.full_name, u.phone, u.is_suspended,
        (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'confirmed') AS jobs_completed
      FROM users u WHERE u.role = 'customer'
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

module.exports = router;
