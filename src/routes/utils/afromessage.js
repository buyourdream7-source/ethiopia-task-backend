// Thin wrapper around AfroMessage's SMS API (https://api.afromessage.com).
// Requires two environment variables set on your backend (Railway → Variables):
//   AFROMESSAGE_TOKEN        - your API token from the AfroMessage dashboard
//   AFROMESSAGE_SENDER_NAME  - your registered sender name / identifier
//
// If AFROMESSAGE_TOKEN isn't set, sendSms() throws — callers (see auth.js)
// catch this and fall back to showing the code on-screen instead, so the
// app keeps working even before this is configured.

async function sendSms(to, message) {
  const token = process.env.AFROMESSAGE_TOKEN;
  const sender = process.env.AFROMESSAGE_SENDER_NAME;

  if (!token) {
    throw new Error("AFROMESSAGE_TOKEN is not set");
  }

  const url = new URL("https://api.afromessage.com/api/send");
  url.searchParams.set("to", to);
  url.searchParams.set("message", message);
  if (sender) url.searchParams.set("sender", sender);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();

  if (data.acknowledge !== "success") {
    const reason = data?.response?.errors?.[0] || data?.response || "unknown error";
    throw new Error(`AfroMessage send failed: ${reason}`);
  }

  return data;
}

module.exports = { sendSms };
