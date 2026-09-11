const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getBanks, createSubaccount } = require("../utils/chapa");
const { getCommissionRate } = require("../utils/commission");
const { uploadImage } = require("../storage");

const router = express.Router();

/**
 * GET /api/workers
 * Search & filter workers. Query params:
 *   category   - category slug
 *   lat, lng   - customer location, used ONLY to show "X km away" on each result — never
 *                filters or excludes a worker, and workers without a saved location still
 *                show up (just without a distance figure)
 *   min_rating - e.g. 4
 *   verified_only - "true"
 *   sort       - "distance" | "price" | "rating" (default rating; distance requires lat/lng)
 */
router.get("/", async (req, res) => {
  const { category, lat, lng, min_rating, verified_only, sort } = req.query;

  const hasLocation = lat !== undefined && lng !== undefined;

  const params = [];
  const where = ["wp.is_available = true"];

  if (verified_only === "true") {
    where.push("wp.verification_status = 'verified'");
  }
  if (min_rating) {
    params.push(parseFloat(min_rating));
    where.push(`wp.average_rating >= $${params.length}`);
  }
  if (category) {
    params.push(category);
    where.push(`EXISTS (
      SELECT 1 FROM worker_categories wc2
      JOIN categories c2 ON c2.id = wc2.category_id
      WHERE wc2.worker_id = wp.id AND c2.slug = $${params.length}
    )`);
  }

  // Haversine distance in km, computed in SQL — good enough at city scale without PostGIS.
  let distanceExpr = "NULL";
  if (hasLocation) {
    params.push(parseFloat(lat), parseFloat(lng));
    const latIdx = params.length - 1;
    const lngIdx = params.length;
    // Distance is computed only for display — it never filters or excludes a worker
    // from results, and workers without a saved location just show no distance.
    distanceExpr = `(
      CASE WHEN wp.base_latitude IS NOT NULL AND wp.base_longitude IS NOT NULL THEN
        6371 * acos(
          LEAST(1, GREATEST(-1,
            cos(radians($${latIdx})) * cos(radians(wp.base_latitude)) *
            cos(radians(wp.base_longitude) - radians($${lngIdx})) +
            sin(radians($${latIdx})) * sin(radians(wp.base_latitude))
          ))
        )
      ELSE NULL END
    )`;
  }

  const sortCol =
    sort === "rating" ? "wp.average_rating DESC" :
    sort === "price" ? "min_price ASC" :
    sort === "distance" && hasLocation ? "distance_km ASC NULLS LAST" :
    "wp.average_rating DESC";

  const sql = `
    SELECT
      wp.id AS worker_id, u.full_name, u.profile_photo_url,
      wp.verification_status, wp.average_rating, wp.total_reviews,
      wp.total_jobs_completed, wp.is_available,
      ${distanceExpr} AS distance_km,
      MIN(wc.price_min) AS min_price, MAX(wc.price_max) AS max_price,
      array_agg(DISTINCT c.slug) AS categories,
      bool_or(c.requires_license) AS category_requires_license,
      EXISTS (
        SELECT 1 FROM verification_documents vd
        WHERE vd.worker_id = wp.id AND vd.doc_type IN ('license', 'certificate') AND vd.status = 'approved'
      ) AS has_license
    FROM worker_profiles wp
    JOIN users u ON u.id = wp.user_id
    LEFT JOIN worker_categories wc ON wc.worker_id = wp.id
    LEFT JOIN categories c ON c.id = wc.category_id
    WHERE ${where.join(" AND ")}
    GROUP BY wp.id, u.full_name, u.profile_photo_url
    ORDER BY ${sortCol}
    LIMIT 50
  `;

  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

router.get("/me", requireAuth, requireRole("worker"), async (req, res) => {
  const { rows } = await db.query(
    `SELECT wp.* FROM worker_profiles wp WHERE wp.user_id = $1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Worker profile not found" });
  const workerId = rows[0].id;

  const { rows: categories } = await db.query(
    `SELECT c.slug, c.name_en, c.requires_license, wc.price_min, wc.price_max
     FROM worker_categories wc JOIN categories c ON c.id = wc.category_id
     WHERE wc.worker_id = $1`,
    [workerId]
  );

  const { rows: documents } = await db.query(
    `SELECT id, doc_type, status, uploaded_at FROM verification_documents
     WHERE worker_id = $1 ORDER BY uploaded_at DESC`,
    [workerId]
  );

  res.json({ ...rows[0], categories, documents });
});

router.get("/:id", async (req, res) => {
  const { rows } = await db.query(
    `SELECT wp.*, u.full_name, u.profile_photo_url, u.preferred_language,
       EXISTS (
         SELECT 1 FROM verification_documents vd
         WHERE vd.worker_id = wp.id AND vd.doc_type IN ('license', 'certificate') AND vd.status = 'approved'
       ) AS has_license
     FROM worker_profiles wp JOIN users u ON u.id = wp.user_id
     WHERE wp.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Worker not found" });

  const { rows: categories } = await db.query(
    `SELECT c.slug, c.name_en, c.name_am, c.requires_license, wc.price_min, wc.price_max
     FROM worker_categories wc JOIN categories c ON c.id = wc.category_id
     WHERE wc.worker_id = $1`,
    [req.params.id]
  );

  const { rows: reviews } = await db.query(
    `SELECT r.rating, r.comment, r.created_at, u.full_name AS customer_name
     FROM reviews r JOIN users u ON u.id = r.customer_id
     WHERE r.worker_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [req.params.id]
  );

  res.json({ ...rows[0], categories, reviews });
});

// --- Worker self-management (role: worker) ---

router.patch("/me/profile", requireAuth, requireRole("worker"), async (req, res) => {
  const { bio, years_experience, motivation, has_own_tools, service_radius_km, base_latitude, base_longitude, is_available } = req.body;
  const { rows } = await db.query(
    `UPDATE worker_profiles SET
       bio = COALESCE($1, bio),
       years_experience = COALESCE($2, years_experience),
       motivation = COALESCE($3, motivation),
       has_own_tools = COALESCE($4, has_own_tools),
       service_radius_km = COALESCE($5, service_radius_km),
       base_latitude = COALESCE($6, base_latitude),
       base_longitude = COALESCE($7, base_longitude),
       is_available = COALESCE($8, is_available),
       updated_at = now()
     WHERE user_id = $9
     RETURNING *`,
    [bio, years_experience, motivation, has_own_tools, service_radius_km, base_latitude, base_longitude, is_available, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Worker profile not found" });
  res.json(rows[0]);
});

router.put("/me/categories", requireAuth, requireRole("worker"), async (req, res) => {
  // body: { categories: [{ category_slug, price_min, price_max }, ...] }
  const { categories } = req.body;
  if (!Array.isArray(categories) || !categories.length) {
    return res.status(400).json({ error: "categories must be a non-empty array" });
  }

  const { rows: wp } = await db.query("SELECT id FROM worker_profiles WHERE user_id = $1", [req.user.id]);
  if (!wp.length) return res.status(404).json({ error: "Worker profile not found" });
  const workerId = wp[0].id;

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM worker_categories WHERE worker_id = $1", [workerId]);
    for (const c of categories) {
      const { rows: cat } = await client.query("SELECT id FROM categories WHERE slug = $1", [c.category_slug]);
      if (!cat.length) continue;
      await client.query(
        `INSERT INTO worker_categories (worker_id, category_id, price_min, price_max)
         VALUES ($1,$2,$3,$4)`,
        [workerId, cat[0].id, c.price_min, c.price_max]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not update services" });
  } finally {
    client.release();
  }
});

// Document upload. Files go to Cloudinary as "authenticated" (private) uploads
// — license and ID documents shouldn't be fetchable by anyone who guesses the
// URL, unlike profile photos. Only the resulting reference is stored here.
router.post("/me/documents", requireAuth, requireRole("worker"), async (req, res) => {
  try {
    const { doc_type, file_url } = req.body;
    if (!doc_type || !file_url) {
      return res.status(400).json({ error: "doc_type and file_url are required" });
    }

    const { rows: wp } = await db.query("SELECT id FROM worker_profiles WHERE user_id = $1", [req.user.id]);
    if (!wp.length) return res.status(404).json({ error: "Worker profile not found" });

    // The app sends a base64 data URI; upload it and keep only the reference.
    let storedUrl = file_url;
    let publicId = null;
    if (storedUrl.startsWith("data:")) {
      const uploaded = await uploadImage(storedUrl, { folder: "ysr/documents", isPrivate: true });
      storedUrl = uploaded.url;
      publicId = uploaded.publicId;
    }

    const { rows } = await db.query(
      `INSERT INTO verification_documents (worker_id, doc_type, file_url, storage_public_id)
       VALUES ($1,$2,$3,$4) RETURNING id, doc_type, status, uploaded_at`,
      [wp[0].id, doc_type, storedUrl, publicId]
    );

    // Move the worker into the verification queue once they've submitted something
    await db.query(
      `UPDATE worker_profiles SET verification_status = 'pending'
       WHERE id = $1 AND verification_status = 'unverified'`,
      [wp[0].id]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "STORAGE_NOT_CONFIGURED") return res.status(503).json({ error: e.message, code: e.code });
    console.error("POST /workers/me/documents crashed:", e);
    res.status(500).json({ error: "Could not upload your document. Please try again." });
  }
});

// GET /api/workers/me/banks — list of banks Chapa supports, for the picker in Settings
router.get("/me/banks", requireAuth, requireRole("worker"), async (req, res) => {
  try {
    const banks = await getBanks();
    res.json(banks);
  } catch (e) {
    if (e.code === "PAYMENT_NOT_CONFIGURED") return res.status(503).json({ error: e.message, code: e.code });
    res.status(502).json({ error: e.message });
  }
});

// PATCH /api/workers/me/bank-details — save bank info and create/refresh the
// Chapa subaccount used to automatically route this worker's share of a
// payment straight to their bank (see split payments in payments.js).
router.patch("/me/bank-details", requireAuth, requireRole("worker"), async (req, res) => {
  const { bank_code, bank_name, account_number, account_name } = req.body;
  if (!bank_code || !account_number || !account_name) {
    return res.status(400).json({ error: "bank_code, account_number, and account_name are required" });
  }

  const { rows } = await db.query("SELECT id FROM worker_profiles WHERE user_id = $1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "Worker profile not found" });
  const workerId = rows[0].id;

  try {
    const rate = await getCommissionRate();
    const subaccountId = await createSubaccount({
      businessName: account_name,
      bankCode: bank_code,
      accountNumber: account_number,
      accountName: account_name,
      splitValue: 1 - rate, // the worker's share; the rest stays with the platform automatically
    });

    const { rows: updated } = await db.query(
      `UPDATE worker_profiles SET bank_code = $1, bank_name = $2, account_number = $3,
         account_name = $4, chapa_subaccount_id = $5, updated_at = now()
       WHERE id = $6
       RETURNING bank_name, account_number, account_name, chapa_subaccount_id`,
      [bank_code, bank_name, account_number, account_name, subaccountId, workerId]
    );
    res.json(updated[0]);
  } catch (e) {
    if (e.code === "PAYMENT_NOT_CONFIGURED") return res.status(503).json({ error: e.message, code: e.code });
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
