const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// POST /api/bookings/:bookingId/review — customer rates a confirmed booking
router.post("/:bookingId/review", requireAuth, requireRole("customer"), async (req, res) => {
  const { rating, comment } = req.body;
  const { bookingId } = req.params;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be between 1 and 5" });
  }

  const { rows: bookingRows } = await db.query(
    "SELECT * FROM bookings WHERE id = $1 AND customer_id = $2",
    [bookingId, req.user.id]
  );
  if (!bookingRows.length) return res.status(404).json({ error: "Booking not found" });
  const booking = bookingRows[0];

  if (booking.status !== "confirmed") {
    return res.status(400).json({ error: "You can only review a booking after confirming completion" });
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: review } = await client.query(
      `INSERT INTO reviews (booking_id, customer_id, worker_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [bookingId, req.user.id, booking.worker_id, rating, comment || null]
    );

    // Recompute the worker's running average rating.
    const { rows: agg } = await client.query(
      "SELECT AVG(rating)::numeric(3,2) AS avg, COUNT(*) AS cnt FROM reviews WHERE worker_id = $1",
      [booking.worker_id]
    );
    await client.query(
      "UPDATE worker_profiles SET average_rating = $1, total_reviews = $2 WHERE id = $3",
      [agg[0].avg, agg[0].cnt, booking.worker_id]
    );

    await client.query("COMMIT");
    res.status(201).json(review[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ error: "This booking has already been reviewed" });
    }
    console.error(err);
    res.status(500).json({ error: "Could not submit review" });
  } finally {
    client.release();
  }
});

module.exports = router;
