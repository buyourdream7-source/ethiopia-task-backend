// Real Chapa API integration (https://api.chapa.co). No fake/simulated
// payment states anywhere in this file — if CHAPA_SECRET_KEY isn't set,
// every function here throws a clear PAYMENT_NOT_CONFIGURED error instead
// of pretending a payment succeeded. Callers must handle that explicitly.

const CHAPA_BASE = "https://api.chapa.co/v1";

function requireConfigured() {
  if (!process.env.CHAPA_SECRET_KEY) {
    const err = new Error("Online payment is not configured yet. Please contact support.");
    err.code = "PAYMENT_NOT_CONFIGURED";
    throw err;
  }
}

/**
 * Starts a Chapa checkout session. Returns { checkout_url } on success.
 * Throws on any failure — never returns a fabricated success.
 */
async function initializePayment({ amount, email, firstName, lastName, txRef, returnUrl }) {
  requireConfigured();

  const res = await fetch(`${CHAPA_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(amount),
      currency: "ETB",
      email,
      first_name: firstName,
      last_name: lastName,
      tx_ref: txRef,
      return_url: returnUrl,
    }),
  });

  const data = await res.json();
  if (data.status !== "success" || !data.data?.checkout_url) {
    throw new Error(flattenChapaError(data));
  }
  return { checkoutUrl: data.data.checkout_url };
}

// Chapa sometimes returns validation errors as an object of field arrays
// (e.g. { email: ["The email field is required."] }) rather than a plain
// string — this always produces readable text either way.
function flattenChapaError(data) {
  const msg = data?.message;
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const parts = Object.entries(msg).map(([field, errs]) => `${field}: ${[].concat(errs).join(", ")}`);
    if (parts.length) return parts.join(" | ");
  }
  return "Chapa failed to start the payment session";
}

/**
 * Verifies a transaction DIRECTLY with Chapa's servers — this is the only
 * source of truth for whether money actually moved. Never trust a webhook
 * body or frontend claim on its own; always confirm here first.
 * Returns { success: boolean, amount, currency, raw }.
 */
async function verifyPayment(txRef) {
  requireConfigured();

  const res = await fetch(`${CHAPA_BASE}/transaction/verify/${encodeURIComponent(txRef)}`, {
    headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
  });
  const data = await res.json();

  const success = data.status === "success" && data.data?.status === "success";
  return {
    success,
    amount: data.data?.amount ? Number(data.data.amount) : null,
    currency: data.data?.currency || null,
    raw: data,
  };
}

module.exports = { initializePayment, verifyPayment };
