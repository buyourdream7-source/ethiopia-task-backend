const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { initializePayment, verifyPayment } = require("../utils/chapa");
const { notify } = require("../utils/notify");

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Applies the real, database-level side effects of a confirmed payment.
// Called from both the webhook and the polling endpoint — either one might
// be the first to see a "paid" result, so this must be safe to run twice.
async function applyConfirmedPayment(payment) {
  if (payment.status === "paid") return; // already applied

  await db.query("UPDATE payments SET status = 'paid', updated_at = now() WHERE id = $1", [payment.id]);

  const { rows: bookingRows } = await db.query("SELECT * FROM bookings WHERE id = $1", [payment.booking_id]);
  const booking = bookingRows[0];
  if (!booking) return;

  if (payment.payment_type === "inspection_fee" || payment.payment_type === "full_payment") {
    if (booking.status === "pending_payment") {
      // Fixed-price bookings are fully paid right here, so the price is locked immediately.
      const shouldLockPrice = payment.payment_type === "full_payment";
      await db.query(
        `UPDATE bookings SET status = 'requested',
           price_final = CASE WHEN $1 THEN price_quoted ELSE price_final END,
           price_locked = CASE WHEN $1 THEN true ELSE price_locked END,
           updated_at = now()
         WHERE id = $2`,
        [shouldLockPrice, booking.id]
      );
      const { rows: w } = await db.query("SELECT user_id FROM worker_profiles WHERE id = $1", [booking.worker_id]);
      if (w.length) await notify(w[0].user_id, "New job request", "A customer has booked you — payment received.", booking.id);
    }
  } else if (payment.payment_type === "final_payment") {
    if (booking.status === "pending_final_payment") {
      await db.query(
        `UPDATE bookings SET status = 'in_progress', price_final = quote_amount, price_locked = true, updated_at = now()
         WHERE id = $1`,
        [booking.id]
      );
      const { rows: w } = await db.query("SELECT user_id FROM worker_profiles WHERE id = $1", [booking.worker_id]);
      if (w.length) await notify(w[0].user_id, "Payment received", "The customer paid your quote — you can start the job.", booking.id);
    }
  }
}

async function applyFailedPayment(payment) {
  if (payment.status !== "pending") return;
  await db.query("UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1", [payment.id]);
}

/**
 * POST /api/payments/bookings/:id/initiate
 * body: { payment_type: 'inspection_fee' | 'final_payment' }
 * Customer-initiated. Creates a real Chapa checkout session for the correct
 * amount based on the booking's current state. Never marks anything paid —
 * that only happens once Chapa itself confirms it (webhook or verify poll).
 */
router.post("/bookings/:id/initiate", requireAuth, requireRole("customer"), async (req, res) => {
  const { payment_type } = req.body;
  const { rows } = await db.query(
    `SELECT b.*, u.full_name, u.email, u.phone FROM bookings b
     JOIN users u ON u.id = b.customer_id
     WHERE b.id = $1 AND b.customer_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Booking not found" });
  const booking = rows[0];

  let amount, expectedType;
  if (booking.status === "pending_payment") {
    expectedType = booking.pricing_type === "fixed" ? "full_payment" : "inspection_fee";
    amount = booking.pricing_type === "fixed" ? booking.price_quoted : booking.inspection_fee_amount;
  } else if (booking.status === "pending_final_payment") {
    expectedType = "final_payment";
    amount = booking.quote_amount;
  } else {
    return res.status(400).json({ error: `No payment is due right now (booking status: ${booking.status})` });
  }

  if (payment_type && payment_type !== expectedType) {
    return res.status(400).json({ error: `Expected payment_type '${expectedType}' for this booking's current state` });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Could not determine a valid amount to charge" });
  }
  if (!booking.email) {
    return res.status(400).json({ error: "An email address is required for online payment.", code: "EMAIL_REQUIRED" });
  }

  // If there's already a pending payment attempt for this booking/type, check
  // with Chapa FIRST rather than blindly reusing its reference — Chapa
  // rejects re-initializing a tx_ref that was already used, and if the
  // customer actually completed that earlier checkout but our webhook/return
  // polling missed it, this recovers that instead of erroring out.
  const { rows: existing } = await db.query(
    `SELECT * FROM payments WHERE booking_id = $1 AND payment_type = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [booking.id, expectedType]
  );
  let payment = null;

  if (existing[0]) {
    try {
      const result = await verifyPayment(existing[0].tx_ref);
      if (result.success) {
        await applyConfirmedPayment(existing[0]);
        return res.json({ already_paid: true });
      }
      // Not successful — this reference can't be reused with Chapa, so retire
      // it and fall through to create a fresh one below.
      await db.query("UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1", [existing[0].id]);
    } catch (e) {
      if (e.code === "PAYMENT_NOT_CONFIGURED") return res.status(503).json({ error: e.message, code: e.code });
      // Verification itself failed (network hiccup, etc.) — safest is to
      // retire this attempt and start a clean one rather than risk reusing it.
      await db.query("UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1", [existing[0].id]);
    }
  }

  const txRef = `ysr_${booking.id.slice(0, 8)}_${crypto.randomBytes(4).toString("hex")}`;
  const { rows: inserted } = await db.query(
    `INSERT INTO payments (booking_id, payment_type, amount, status, provider, tx_ref)
     VALUES ($1, $2, $3, 'pending', 'chapa', $4) RETURNING *`,
    [booking.id, expectedType, amount, txRef]
  );
  payment = inserted[0];

  const email = booking.email;
  const [firstName, ...rest] = (booking.full_name || "Customer").split(" ");

  // TEST MODE — only active if PAYMENT_TEST_MODE=true is explicitly set on the
  // server (never on by default, and useless once CHAPA_SECRET_KEY is real,
  // since that path is checked first). No money moves; nothing is silently
  // trusted from the frontend — advancing a test payment still requires a
  // separate authenticated server call (see /test/:tx_ref/simulate below).
  if (!process.env.CHAPA_SECRET_KEY && process.env.PAYMENT_TEST_MODE === "true") {
    return res.json({ test_mode: true, tx_ref: txRef, amount });
  }

  // Only the job payment (not the inspection fee, which stays 100% platform)
  // gets split with the worker — and only if they've linked a bank account.
  let subaccountId = null;
  if (expectedType === "full_payment" || expectedType === "final_payment") {
    const { rows: w } = await db.query("SELECT chapa_subaccount_id FROM worker_profiles WHERE id = $1", [booking.worker_id]);
    subaccountId = w[0]?.chapa_subaccount_id || null;
  }

  try {
    const { checkoutUrl } = await initializePayment({
      amount,
      email,
      firstName,
      lastName: rest.join(" ") || "-",
      txRef,
      returnUrl: `${FRONTEND_URL}?payment_booking=${booking.id}&tx_ref=${txRef}`,
      subaccountId,
    });
    res.json({ checkout_url: checkoutUrl, tx_ref: txRef, amount });
  } catch (e) {
    if (e.code === "PAYMENT_NOT_CONFIGURED") {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /api/payments/test/:tx_ref/simulate
 * TEST MODE ONLY (PAYMENT_TEST_MODE=true, no real Chapa key set). Lets the
 * logged-in owner of a pending test payment mark it paid, using the exact
 * same server-side side-effect logic as a real confirmed payment. This
 * endpoint does nothing at all unless test mode is explicitly enabled.
 */
router.post("/test/:tx_ref/simulate", requireAuth, async (req, res) => {
  if (process.env.CHAPA_SECRET_KEY || process.env.PAYMENT_TEST_MODE !== "true") {
    return res.status(403).json({ error: "Test mode is not enabled" });
  }

  const { rows } = await db.query(
    `SELECT p.* FROM payments p JOIN bookings b ON b.id = p.booking_id
     WHERE p.tx_ref = $1 AND b.customer_id = $2`,
    [req.params.tx_ref, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Payment not found" });

  await applyConfirmedPayment(rows[0]);
  res.json({ status: "paid", test_mode: true });
});

/**
 * GET /api/payments/bookings/:id/status?tx_ref=...
 * The customer's app polls this after returning from Chapa's checkout page.
 * ALWAYS re-verifies with Chapa directly — never trusts the return URL params
 * or any frontend-supplied "it worked" signal on their own.
 */
router.get("/bookings/:id/status", requireAuth, async (req, res) => {
  const { tx_ref } = req.query;
  if (!tx_ref) return res.status(400).json({ error: "tx_ref is required" });

  const { rows } = await db.query(
    "SELECT * FROM payments WHERE tx_ref = $1 AND booking_id = $2",
    [tx_ref, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Payment not found" });
  const payment = rows[0];

  if (payment.status === "paid") {
    return res.json({ status: "paid" });
  }

  try {
    const result = await verifyPayment(tx_ref);
    if (result.success) {
      await applyConfirmedPayment(payment);
      return res.json({ status: "paid" });
    }
    return res.json({ status: "pending" });
  } catch (e) {
    if (e.code === "PAYMENT_NOT_CONFIGURED") {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /api/payments/chapa/webhook
 * Public endpoint — Chapa calls this directly, no user is logged in here.
 * Per Chapa's own docs, the webhook body is a signal to go check, not proof
 * of payment by itself — this always re-verifies server-to-server before
 * marking anything paid.
 */
router.post("/chapa/webhook", async (req, res) => {
  const txRef = req.body?.tx_ref;
  if (!txRef) return res.status(400).json({ error: "tx_ref missing" });

  try {
    const { rows } = await db.query("SELECT * FROM payments WHERE tx_ref = $1", [txRef]);
    if (!rows.length) return res.status(404).json({ error: "Unknown tx_ref" });
    const payment = rows[0];

    const result = await verifyPayment(txRef);
    if (result.success) {
      await applyConfirmedPayment(payment);
    } else {
      await applyFailedPayment(payment);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Chapa webhook error:", e.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

module.exports = router;
