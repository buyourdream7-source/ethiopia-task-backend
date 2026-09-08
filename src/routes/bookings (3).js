const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notify } = require("../utils/notify");
const { getCommissionRate, splitPayment } = require("../utils/commission");

const router = express.Router();

// Which status transitions are legal, and who is allowed to make them.
// Note: 'started' -> 'completed' is only valid for FIXED-price bookings —
// variable-price bookings must go through POST /:id/quote and the customer's
// approval + final payment first (enforced below, not just by this map).
const TRANSITIONS = {
  requested:   { accepted: "worker", cancelled: "either" },
  accepted:    { on_the_way: "worker", cancelled: "either" },
  on_the_way:  { started: "worker", cancelled: "either" },
  started:     { completed: "worker", cancelled: "either" },
  in_progress: { completed: "worker", cancelled: "either" },
  completed:   { confirmed: "customer", disputed: "either" },
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

// POST /api/bookings — customer requests a worker.
// Creates the booking in 'pending_payment' — it does NOT become visible to
// the worker until the initial payment (inspection fee, or the full amount
// for fixed-price categories) actually clears via Chapa. The frontend must
// follow this up with POST /api/payments/bookings/:id/initiate.
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

    const { rows: cat } = await db.query(
      "SELECT id, pricing_type, inspection_fee FROM categories WHERE slug = $1",
      [category_slug]
    );
    if (!cat.length) return res.status(400).json({ error: "Unknown category" });
    const category = cat[0];

    const { rows: worker } = await db.query(
      "SELECT id, is_available FROM worker_profiles WHERE id = $1",
      [worker_id]
    );
    if (!worker.length) return res.status(404).json({ error: "Worker not found" });
    if (!worker[0].is_available) return res.status(409).json({ error: "This worker is not currently available" });

    const inspectionFeeAmount = category.pricing_type === "variable" ? category.inspection_fee : null;

    const { rows: booking } = await db.query(
      `INSERT INTO bookings
         (customer_id, worker_id, category_id, scheduled_at, address_text, latitude, longitude,
          price_quoted, status, pricing_type, inspection_fee_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_payment',$9,$10)
       RETURNING *`,
      [req.user.id, worker_id, category.id, scheduled_at || null, address_text, latitude || null, longitude || null,
       price_quoted, category.pricing_type, inspectionFeeAmount]
    );

    await db.query(
      `INSERT INTO booking_status_history (booking_id, status, changed_by) VALUES ($1,'pending_payment',$2)`,
      [booking[0].id, req.user.id]
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

// POST /api/bookings/:id/quote — worker submits a price after inspecting (variable-price only)
router.post("/:id/quote", requireAuth, requireRole("worker"), async (req, res) => {
  const { amount, labor_amount, materials_amount, note } = req.body;
  const ctx = await loadBookingForUser(req.params.id, req.user);
  if (!ctx || !ctx.isWorker) return res.status(404).json({ error: "Booking not found" });
  const { booking } = ctx;

  if (booking.pricing_type !== "variable") {
    return res.status(400).json({ error: "This category has fixed pricing — no quote is needed" });
  }
  if (booking.status !== "started") {
    return res.status(400).json({ error: `Cannot submit a quote while the booking is '${booking.status}'` });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "A valid amount is required" });
  }

  await db.query(
    `UPDATE bookings SET status = 'quote_sent', quote_amount = $1, quote_labor_amount = $2,
       quote_materials_amount = $3, quote_note = $4, quote_status = 'pending',
       quote_submitted_at = now(), updated_at = now()
     WHERE id = $5`,
    [amount, labor_amount || null, materials_amount || null, note || null, booking.id]
  );
  await db.query(
    "INSERT INTO booking_status_history (booking_id, status, changed_by, note) VALUES ($1,'quote_sent',$2,$3)",
    [booking.id, req.user.id, note || null]
  );

  const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1", [booking.id]);
  await notify(booking.customer_id, "New quote", `Your worker sent a quote of ${amount} ETB — review it in Bookings.`, booking.id);
  res.json(rows[0]);
});

// PATCH /api/bookings/:id/quote — customer approves or rejects the worker's quote
router.patch("/:id/quote", requireAuth, requireRole("customer"), async (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  const ctx = await loadBookingForUser(req.params.id, req.user);
  if (!ctx || !ctx.isCustomer) return res.status(404).json({ error: "Booking not found" });
  const { booking } = ctx;

  if (booking.status !== "quote_sent") {
    return res.status(400).json({ error: `No quote awaiting a decision (booking status: ${booking.status})` });
  }
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  if (decision === "approved") {
    // Approval alone does NOT charge anything or lock the price yet — that only
    // happens once the final payment actually clears (see payments.js). This
    // is what guarantees a worker can never move the price after this point.
    await db.query(
      `UPDATE bookings SET status = 'pending_final_payment', quote_status = 'approved',
         quote_approved_at = now(), updated_at = now()
       WHERE id = $1`,
      [booking.id]
    );
  } else {
    // Rejected — back to 'started' so the worker can submit a revised quote.
    await db.query(
      `UPDATE bookings SET status = 'started', quote_status = 'rejected', updated_at = now()
       WHERE id = $1`,
      [booking.id]
    );
  }

  await db.query(
    "INSERT INTO booking_status_history (booking_id, status, changed_by) VALUES ($1,$2,$3)",
    [booking.id, decision === "approved" ? "quote_approved" : "quote_rejected", req.user.id]
  );

  const { rows: w } = await db.query("SELECT user_id FROM worker_profiles WHERE id = $1", [booking.worker_id]);
  if (w.length) {
    if (decision === "approved") await notify(w[0].user_id, "Quote approved", "The customer approved your quote and is completing payment.", booking.id);
    else await notify(w[0].user_id, "Quote rejected", "The customer rejected your quote — you can submit a new one.", booking.id);
  }

  const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1", [booking.id]);
  res.json(rows[0]);
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
  const { rows: payments } = await db.query(
    "SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at ASC",
    [req.params.id]
  );

  res.json({ ...ctx.booking, history, payments });
});

// GET /api/bookings/:id/receipt — a clean digital receipt for a confirmed job
router.get("/:id/receipt", requireAuth, async (req, res) => {
  const ctx = await loadBookingForUser(req.params.id, req.user);
  if (!ctx) return res.status(404).json({ error: "Booking not found" });
  const { booking } = ctx;

  if (booking.status !== "confirmed") {
    return res.status(400).json({ error: "A receipt is only available once a job is confirmed" });
  }

  const { rows: payments } = await db.query(
    "SELECT payment_type, amount, status, created_at AS paid_at, provider FROM payments WHERE booking_id = $1 AND status = 'paid' ORDER BY created_at ASC",
    [booking.id]
  );

  const { rows: details } = await db.query(
    `SELECT b.*, c.name_en AS category_name, cu.full_name AS customer_name, wu.full_name AS worker_name
     FROM bookings b
     JOIN categories c ON c.id = b.category_id
     JOIN users cu ON cu.id = b.customer_id
     JOIN worker_profiles wp ON wp.id = b.worker_id
     JOIN users wu ON wu.id = wp.user_id
     WHERE b.id = $1`,
    [booking.id]
  );

  res.json({
    booking_id: booking.id,
    category: details[0].category_name,
    customer_name: details[0].customer_name,
    worker_name: details[0].worker_name,
    pricing_type: booking.pricing_type,
    payments,
    total_paid: payments.reduce((sum, p) => sum + Number(p.amount), 0),
    commission_rate: booking.commission_rate,
    commission_amount: booking.commission_amount,
    worker_earnings: booking.worker_earnings,
    confirmed_at: booking.updated_at,
  });
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
      // Price was already locked in at payment time (fixed) or final-payment
      // confirmation (variable) — it is NEVER taken from this request. A
      // worker cannot change the approved price at this or any later step.
      if (!booking.price_locked || booking.price_final == null) {
        return res.status(409).json({ error: "This booking's price isn't locked in yet — payment must clear first." });
      }
      if (booking.pricing_type === "variable" && booking.status === "started") {
        return res.status(400).json({ error: "Submit a quote first (POST /:id/quote) before marking a variable-price job complete." });
      }
      // This starts a 12-hour window for the customer to confirm & pay —
      // if it passes without a confirmation, they get auto-suspended until
      // an admin unbans them (see /admin/users/:id/suspend).
      await db.query("UPDATE bookings SET status = 'completed', updated_at = now() WHERE id = $1", [booking.id]);
      await db.query(
        "UPDATE users SET payment_deadline = now() + interval '12 hours' WHERE id = $1",
        [booking.customer_id]
      );
      await notify(booking.customer_id, "Job marked complete", "Please confirm the job so the worker gets paid.", booking.id);
    } else if (nextStatus === "confirmed") {
      // Customer confirms completion — this is what actually settles the payment split.
      // Note: this does NOT touch the payments table — every payment here was
      // already verified and marked 'paid' by Chapa at the time it happened
      // (see payments.js). Nothing gets marked paid based on this request alone.
      const rate = await getCommissionRate();
      const finalPrice = booking.price_final || booking.price_quoted;
      const { commissionAmount, workerEarnings } = splitPayment(finalPrice, rate);

      await db.query(
        `UPDATE bookings SET status = 'confirmed', commission_rate = $1,
           commission_amount = $2, worker_earnings = $3, updated_at = now()
         WHERE id = $4`,
        [rate, commissionAmount, workerEarnings, booking.id]
      );
      await db.query(
        `UPDATE worker_profiles SET total_jobs_completed = total_jobs_completed + 1
         WHERE id = $1`,
        [booking.worker_id]
      );
      // Paid on time — clear their payment deadline. Does not lift an existing
      // suspension automatically; that's an admin-only action (see /admin/users/:id/suspend).
      await db.query("UPDATE users SET payment_deadline = NULL WHERE id = $1", [booking.customer_id]);

      const { rows: w } = await db.query("SELECT user_id FROM worker_profiles WHERE id = $1", [booking.worker_id]);
      if (w.length) await notify(w[0].user_id, "Job confirmed", `The customer confirmed the job — ${workerEarnings} ETB is yours.`, booking.id);
    } else {
      await db.query("UPDATE bookings SET status = $1, updated_at = now() WHERE id = $2", [nextStatus, booking.id]);

      const notifyMap = {
        accepted: [booking.customer_id, "Worker accepted", "Your worker accepted the job and is getting ready."],
        on_the_way: [booking.customer_id, "Worker on the way", "Your worker is heading to your location."],
        started: [booking.customer_id, "Job started", "Your worker has started the job."],
        cancelled: [isWorker ? booking.customer_id : null, "Booking cancelled", note || "The booking was cancelled."],
      };
      const n = notifyMap[nextStatus];
      if (n && n[0]) await notify(n[0], n[1], n[2], booking.id);
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
