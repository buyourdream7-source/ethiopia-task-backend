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
async function initializePayment({ amount, email, firstName, lastName, txRef, returnUrl, subaccountId }) {
  requireConfigured();

  const body = {
    amount: String(amount),
    currency: "ETB",
    email,
    first_name: firstName,
    last_name: lastName,
    tx_ref: txRef,
    return_url: returnUrl,
  };
  // If the worker has a linked bank subaccount, Chapa automatically routes
  // their share straight to their bank at settlement — no manual payout needed.
  if (subaccountId) body.subaccount = { id: subaccountId };

  const res = await fetch(`${CHAPA_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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

/**
 * Returns Chapa's current list of supported banks: [{ id, name, ... }].
 * Fetched live rather than hardcoded, since bank codes can change.
 */
async function getBanks() {
  requireConfigured();
 const res = await fetch(`${CHAPA_BASE}/banks`, {
    headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
  });
  const data = await res.json();

  // Note: unlike Chapa's other endpoints, /banks returns no status field —
  // just { message, data }. Checking for status === "success" here made every
  // successful call throw, using Chapa's own "Banks retrieved" message as the
  // error text. Go by whether the list actually arrived instead.
  const list = Array.isArray(data.data) ? data.data : null;
  if (!list) throw new Error(flattenChapaError(data));


  // Only banks that can actually receive payouts are useful for a worker's
  // subaccount — offering one that can't just means a failure later.
  return list.filter((b) => b.can_process_payouts === 1 && b.is_active === 1);
}
/**
 * Creates (or the caller may choose to re-create) a Chapa subaccount for a
 * worker's bank details, used later to automatically route their share of a
 * payment straight to their bank via split payments. Returns the subaccount id.
 */
async function createSubaccount({ businessName, bankCode, accountNumber, accountName, splitValue }) {
  requireConfigured();
  const res = await fetch(`${CHAPA_BASE}/subaccount`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      business_name: businessName,
      account_name: accountName,
      bank_code: bankCode,
      account_number: accountNumber,
      split_type: "percentage",
      split_value: splitValue,
    }),
  });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.subaccount_id) {
    throw new Error(flattenChapaError(data));
  }
  return data.data.subaccount_id;
}

module.exports = { initializePayment, verifyPayment, getBanks, createSubaccount };
