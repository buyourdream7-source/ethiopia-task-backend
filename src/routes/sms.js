// SMS sending, via SMSEthiopia.
//
// Requires SMS_API_KEY on Railway. If it isn't set, sendSms throws and the
// caller falls back to showing the code on screen — see the OTP routes in
// routes/auth.js.
//
// Named sms.js rather than after the provider: swapping providers later means
// changing the endpoint and field names below, and nothing else in the app.

const SMS_ENDPOINT = "https://smsethiopia.com/api/sms/send";

/**
 * SMSEthiopia expects msisdn as country code + number with no plus or spaces,
 * e.g. 251911639555. People type their number every which way, so normalise
 * rather than rejecting input that's perfectly understandable.
 */
function toMsisdn(phone) {
  const digits = String(phone).replace(/\D/g, "");

  if (digits.startsWith("251")) return digits;        // already 251...
  if (digits.startsWith("0")) return `251${digits.slice(1)}`; // 0911... → 251911...
  if (digits.length === 9) return `251${digits}`;     // 911639555
  return digits;                                       // hand over as-is
}

async function sendSms(to, message) {
  const key = process.env.SMS_API_KEY;
  if (!key) {
    const err = new Error("SMS_API_KEY is not set");
    err.code = "SMS_NOT_CONFIGURED";
    throw err;
  }

  const res = await fetch(SMS_ENDPOINT, {
    method: "POST",
    headers: {
      KEY: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ msisdn: toMsisdn(to), text: message }),
  });

  // Read as text first: a failing gateway often returns an HTML error page,
  // and parsing that as JSON hides the real reason behind a syntax error.
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `SMS send failed (${res.status})`);
  }

  return data ?? { ok: true };
}

module.exports = { sendSms, toMsisdn };
