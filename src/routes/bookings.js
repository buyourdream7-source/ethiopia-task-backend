const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getCommissionRate, splitPayment } = require("../utils/commission");

const router = express.Router();

// Which status transitions are legal, and who is allowed to make them.
const TRANSITIONS = {
  requested:  { accepted: "worker", cancelled: "either" },
  accepted:   { on_the_way: "worker", cancelled: "either" },
  on_the_way: { started: "worker", cancelled: "either" },
  started:    { completed: "worker" },
  completed:  { confirmed: "customer", disputed: "either" },
};

async function loadBookingForUser(bookingId, user) {
  const { rows } = await db.query(
    `SELECT b.*, wp.user_id AS worker_user_id
     FROM bookings b JOIN worker_profiles wp ON wp.id = b.worker_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!rows.length) return null;
  const booking = rows[0];
  const isCustomer = booking.customer_id === user.id;
  const isWorker = booking.worker_user_id === user.id;
  if (!isCustomer && !isWorker && user.role !== "admin") return null;
  return { booking, isCustomer, isWorker };
}

// POST /api/bookings — customer requests a worker
router.post("/", requireAuth, requireRole("customer"), async (req, res) => {
  const { worker_id, category_slug, scheduled_at, address_text, latitude, longitude, price_quoted } = req.body;

  if (!worker_id || !category_slug || !address_text || !price_quoted) {
    return res.status(400).json({ error: "worker_id, category_slug, address_text and price_quoted are required" });
  }

  try {
    const { rows: userRows } = await db.query("SELECT subscription_active FROM users WHERE id = $1", [req.user.id]);
    if (!userRows[0].subscription_active) {
      const { rows: countRows } = await db.query(
        "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = $1 AND status = 'confirmed'",
        [req.user.id]
      );
      const freeJobsUsed = Number(countRows[0].n);
      const FREE_JOB_LIMIT = 3;
      if (freeJobsUsed >= FREE_JOB_LIMIT) {
        return res.status(402).json({
          error: "You've used your 3 free jobs. Subscribe to keep booking.",
          code: "TRIAL_EXPIRED",
          free_jobs_used: freeJobsUsed,
        });
      }
    }

    const { rows: cat } = await db.query("SELECT id FROM categories WHERE slug = $1", [category_slug]);
    if (!cat.length) return res.status(400).json({ error: "Unknown category" });

    const { rows: worker } = await db.query(
      "SELECT id, is_available FROM worker_profiles WHERE id = $1",
      [worker_id]
    );
    if (!worker.length) return res.status(404).json({ error: "Worker not found" });
    if (!worker[0].is_available) return res.status(409).json({ error: "This worker is not currently available" });

    const { rows: booking } = await db.query(
      `INSERT INTO bookings
         (customer_id, worker_id, category_id, scheduled_at, address_text, latitude, longitude, price_quoted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.user.id, worker_id, cat[0].id, scheduled_at || null, address_text, latitude || null, longitude || null, price_quoted]
    );

    await db.query(
      `INSERT INTO booking_status_history (booking_id, status, changed_by) VALUES ($1,'requested',$2)`,
      [booking[0].id, req.user.id]
    );
    await db.query(
      `INSERT INTO payments (booking_id, amount, status) VALUES ($1,$2,'pending')`,
      [booking[0].id, price_quoted]
    );

    // A conversation thread is opened automatically so chat is ready immediately
    const { rows: workerUser } = await db.query(
      "SELECT user_id FROM worker_profiles WHERE id = $1", [worker_id]
    );
    await db.query(
      `INSERT INTO conversations (booking_id, customer_id, worker_id) VALUES ($1,$2,$3)`,
      [booking[0].id, req.user.id, workerUser[0].user_id]
    );

    res.status(201).json(booking[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create booking" });
  }
});

// GET /api/bookings — list bookings for the logged-in user (customer or worker)
router.get("/", requireAuth, async (req, res) => {
  let sql, params;
  if (req.user.role === "worker") {
    sql = `SELECT b.*, u.full_name AS customer_name, c.name_en AS category_name
           FROM bookings b
           JOIN worker_profiles wp ON wp.id = b.worker_id
           JOIN users u ON u.id = b.customer_id
           JOIN categories c ON c.id = b.category_id
           WHERE wp.user_id = $1 ORDER BY b.created_at DESC`;
    params = [req.user.id];
  } else {
    sql = `SELECT b.*, wu.full_name AS worker_name, c.name_en AS category_name,
                  EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS has_review
           FROM bookings b
           JOIN worker_profiles wp ON wp.id = b.worker_id
           JOIN users wu ON wu.id = wp.user_id
           JOIN categories c ON c.id = b.category_id
           WHERE b.customer_id = $1 ORDER BY b.created_at DESC`;
    params = [req.user.id];
  }
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const ctx = await loadBookingForUser(req.params.id, req.user);
  if (!ctx) return res.status(404).json({ error: "Booking not found" });

  const { rows: history } = await db.query(
    "SELECT * FROM booking_status_history WHERE booking_id = $1 ORDER BY changed_at ASC",
    [req.params.id]
  );
  const { rows: payment } = await db.query("SELECT * FROM payments WHERE booking_id = $1", [req.params.id]);

  res.json({ ...ctx.booking, history, payment: payment[0] || null });
});

// PATCH /api/bookings/:id/status — move a booking through its lifecycle
router.patch("/:id/status", requireAuth, async (req, res) => {
  const { status: nextStatus, price_final, note } = req.body;
  const ctx = await loadBookingForUser(req.params.id, req.user);
  if (!ctx) return res.status(404).json({ error: "Booking not found" });

  const { booking, isCustomer, isWorker } = ctx;
  const rule = TRANSITIONS[booking.status] && TRANSITIONS[booking.status][nextStatus];

  if (!rule) {
    return res.status(400).json({
      error: `Cannot move a booking from '${booking.status}' to '${nextStatus}'`,
    });
  }
  const actorOk =
    rule === "either" ||
    (rule === "worker" && isWorker) ||
    (rule === "customer" && isCustomer);
  if (!actorOk && req.user.role !== "admin") {
    return res.status(403).json({ error: "You are not allowed to make this change" });
  }

  try {
    if (nextStatus === "completed") {
      // Worker marks the job physically done and reports the final price.
      const finalPrice = price_final || booking.price_quoted;
      await db.query(
        "UPDATE bookings SET status = $1, price_final = $2, updated_at = now() WHERE id = $3",
        [nextStatus, finalPrice, booking.id]
      );
    } else if (nextStatus === "confirmed") {
      // Customer confirms completion — this is what actually settles the payment split.
      const rate = await getCommissionRate();
      const finalPrice = booking.price_final || booking.price_quoted;
      const { commissionAmount, workerEarnings } = splitPayment(finalPrice, rate);

      await db.query(
        `UPDATE bookings SET status = 'confirmed', commission_rate = $1,
           commission_amount = $2, worker_earnings = $3, updated_at = now()
         WHERE id = $4`,
        [rate, commissionAmount, workerEarnings, booking.id]
      );
      await db.query("UPDATE payments SET status = 'paid', updated_at = now() WHERE booking_id = $1", [booking.id]);
      await db.query(
        `UPDATE worker_profiles SET total_jobs_completed = total_jobs_completed + 1
         WHERE id = $1`,
        [booking.worker_id]
      );
    } else {
      await db.query("UPDATE bookings SET status = $1, updated_at = now() WHERE id = $2", [nextStatus, booking.id]);
    }

    if (nextStatus === "cancelled" && note) {
      await db.query("UPDATE bookings SET cancellation_reason = $1 WHERE id = $2", [note, booking.id]);
    }

    await db.query(
      "INSERT INTO booking_status_history (booking_id, status, changed_by, note) VALUES ($1,$2,$3,$4)",
      [booking.id, nextStatus, req.user.id, note || null]
    );

    const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1", [booking.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update booking status" });
  }
});

module.exports = router;
