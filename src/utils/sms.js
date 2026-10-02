// SMSEthiopia (https://smsethiopia.com) — sends the signup OTP.
//
// Set ONE environment variable on Railway → your backend service → Variables:
//   SMSETHIOPIA_KEY = <your API key>
// Never commit the key or paste it into a file. If it leaks, generate a new
// one in the SMSEthiopia dashboard; the old one keeps working until you do.
//
// This THROWS on every failure rather than failing quietly. That is deliberate:
// auth.js catches it and falls back to returning the code in the response so
// signup still works while your sender ID is pending Ethio Telecom approval.
// A silent failure here would leave users staring at a code box forever.

const SMS_URL = "https://smsethiopia.com/api/sms/send";

/**
 * Ethiopian numbers reach the API as 2519******** / 2517********.
 * Accepts 0911…, +251911…, 251911… and 911… and normalises all of them.
 * Throws if what's left isn't a plausible Ethiopian mobile number.
 */
function toEthiopianMsisdn(raw) {
  let d = String(raw || "").replace(/\D/g, "");

  if (d.startsWith("251")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);

  // Mobile numbers are 9 digits after the country code and start 9 or 7.
  if (!/^[97]\d{8}$/.test(d)) {
    throw new Error(`Not a valid Ethiopian mobile number: ${raw}`);
  }
  return `251${d}`;
}

/**
 * Sends one SMS. Resolves on success, throws with a readable reason otherwise.
 */
async function sendSms(to, message) {
  const key = process.env.SMSETHIOPIA_KEY;
  if (!key) throw new Error("SMSETHIOPIA_KEY is not set");

  const msisdn = toEthiopianMsisdn(to);

  // Don't let a provider outage hang the signup request.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let res;
  let bodyText;
  try {
    res = await fetch(SMS_URL, {
      method: "POST",
      headers: { KEY: key, "Content-Type": "application/json" },
      body: JSON.stringify({ msisdn, text: message }),
      signal: controller.signal,
    });
    bodyText = await res.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("SMS provider timed out after 15s");
    throw new Error(`Could not reach SMS provider: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }

  let data = null;
  try { data = JSON.parse(bodyText); } catch { /* provider returned plain text */ }

  if (!res.ok) {
    throw new Error(`SMS send failed (HTTP ${res.status}): ${(bodyText || "").slice(0, 300)}`);
  }

  // Providers often return HTTP 200 with a failure in the body — treat any
  // explicit error/failed marker as a failure so the caller can fall back.
  const marker = String(data?.status ?? data?.result ?? "").toLowerCase();
  if (data && (data.error || marker === "failed" || marker === "error")) {
    throw new Error(`SMS rejected: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data ?? { raw: bodyText };
}

module.exports = { sendSms, toEthiopianMsisdn };
