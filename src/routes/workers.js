const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

/**
 * GET /api/workers
 * Search & filter workers. Query params:
 *   category   - category slug
 *   lat, lng   - customer location, required for distance sort/filter
 *   radius_km  - max distance (default 15)
 *   min_rating - e.g. 4
 *   verified_only - "true"
 *   sort       - "distance" | "price" | "rating" (default distance if lat/lng given, else rating)
 */
router.get("/", async (req, res) => {
  const { category, lat, lng, radius_km, min_rating, verified_only, sort } = req.query;

  const hasLocation = lat !== undefined && lng !== undefined;
  const radius = radius_km ? parseFloat(radius_km) : 15;

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
    distanceExpr = `(
      6371 * acos(
        cos(radians($${latIdx})) * cos(radians(wp.base_latitude)) *
        cos(radians(wp.base_longitude) - radians($${lngIdx})) +
        sin(radians($${latIdx})) * sin(radians(wp.base_latitude))
      )
    )`;
    where.push(`wp.base_latitude IS NOT NULL AND wp.base_longitude IS NOT NULL`);
    params.push(radius);
    where.push(`${distanceExpr} <= $${params.length}`);
  }

  const sortCol =
    sort === "rating" ? "wp.average_rating DESC" :
    sort === "price" ? "min_price ASC" :
    hasLocation ? "distance_km ASC" : "wp.average_rating DESC";

  const sql = `
    SELECT
      wp.id AS worker_id, u.full_name, u.profile_photo_url,
      wp.verification_status, wp.average_rating, wp.total_reviews,
      wp.total_jobs_completed, wp.is_available,
      ${distanceExpr} AS distance_km,
      MIN(wc.price_min) AS min_price, MAX(wc.price_max) AS max_price,
      array_agg(DISTINCT c.slug) AS categories
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

router.get("/:id", async (req, res) => {
  const { rows } = await db.query(
    `SELECT wp.*, u.full_name, u.profile_photo_url, u.preferred_language
     FROM worker_profiles wp JOIN users u ON u.id = wp.user_id
     WHERE wp.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Worker not found" });

  const { rows: categories } = await db.query(
    `SELECT c.slug, c.name_en, c.name_am, wc.price_min, wc.price_max
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
  const { bio, years_experience, service_radius_km, base_latitude, base_longitude, is_available } = req.body;
  const { rows } = await db.query(
    `UPDATE worker_profiles SET
       bio = COALESCE($1, bio),
       years_experience = COALESCE($2, years_experience),
       service_radius_km = COALESCE($3, service_radius_km),
       base_latitude = COALESCE($4, base_latitude),
       base_longitude = COALESCE($5, base_longitude),
       is_available = COALESCE($6, is_available),
       updated_at = now()
     WHERE user_id = $7
     RETURNING *`,
    [bio, years_experience, service_radius_km, base_latitude, base_longitude, is_available, req.user.id]
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

// Document upload: in production this URL comes from your object storage (S3/GCS) after
// a signed upload from the client. This endpoint just records the private reference.
router.post("/me/documents", requireAuth, requireRole("worker"), async (req, res) => {
  const { doc_type, file_url } = req.body;
  if (!doc_type || !file_url) {
    return res.status(400).json({ error: "doc_type and file_url are required" });
  }

  const { rows: wp } = await db.query("SELECT id FROM worker_profiles WHERE user_id = $1", [req.user.id]);
  if (!wp.length) return res.status(404).json({ error: "Worker profile not found" });

  const { rows } = await db.query(
    `INSERT INTO verification_documents (worker_id, doc_type, file_url)
     VALUES ($1,$2,$3) RETURNING id, doc_type, status, uploaded_at`,
    [wp[0].id, doc_type, file_url]
  );

  // Move the worker into the verification queue once they've submitted something
  await db.query(
    `UPDATE worker_profiles SET verification_status = 'pending'
     WHERE id = $1 AND verification_status = 'unverified'`,
    [wp[0].id]
  );

  res.status(201).json(rows[0]);
});

module.exports = router;
