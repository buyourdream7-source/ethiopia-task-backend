// Uploads files to Cloudinary instead of storing base64 blobs in Postgres.
//
// Requires these env vars on Railway:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// If they aren't set, uploadImage() throws a clear error rather than silently
// falling back to base64 — we don't want to quietly reintroduce the problem
// this module exists to solve.

const crypto = require("crypto");

function requireConfigured() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    const err = new Error("File storage isn't configured. Please contact support.");
    err.code = "STORAGE_NOT_CONFIGURED";
    throw err;
  }
}

/**
 * Cloudinary signs requests with a SHA-1 of the sorted params plus your API
 * secret. Doing it manually avoids pulling in their whole SDK for one call.
 */
function sign(params) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + process.env.CLOUDINARY_API_SECRET).digest("hex");
}

/**
 * Uploads a base64 data URI (what the app already sends) to Cloudinary and
 * returns the hosted URL.
 *
 * `folder` keeps things organised: "ysr/avatars" or "ysr/documents".
 * `isPrivate` should be true for license documents — it uploads them as
 * "authenticated" so they can't be fetched by guessing the URL, unlike
 * profile photos which are fine to serve publicly.
 */
async function uploadImage(dataUri, { folder = "ysr", isPrivate = false } = {}) {
  requireConfigured();

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign({ folder, timestamp });

  const form = new URLSearchParams({
    file: dataUri,
    api_key: process.env.CLOUDINARY_API_KEY,
    timestamp: String(timestamp),
    folder,
    signature,
  });

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: form }
  );

  // Cloudinary returns HTML (not JSON) for some failures — parsing blindly
  // produces a confusing "Unexpected token '<'" error instead of the real cause.
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Upload failed (${res.status}). Check your Cloudinary credentials.`);
  }

  if (!data.secure_url) {
    throw new Error(data.error?.message || "Upload failed");
  }

  // Passing `type` at upload time does not reliably produce a private asset,
  // so for documents we follow up with an explicit conversion to
  // "authenticated" delivery. Verified below — if this step fails we throw
  // rather than silently leaving an ID document publicly readable.
  if (isPrivate) {
    const converted = await makePrivate(data.public_id);
    return { url: converted.secure_url, publicId: converted.public_id };
  }

  return { url: data.secure_url, publicId: data.public_id };
}

/**
 * Converts an already-uploaded asset to "authenticated" delivery, which means
 * it can no longer be fetched without a signed URL.
 */
async function makePrivate(publicId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    from_public_id: publicId,
    timestamp,
    to_type: "authenticated",
    type: "upload",
  };
  const signature = sign(params);

  const form = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_key: process.env.CLOUDINARY_API_KEY,
    signature,
  });

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/rename`,
    { method: "POST", body: form }
  );

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Could not secure the uploaded document (${res.status}).`);
  }

  if (!data.secure_url) {
    throw new Error(data.error?.message || "Could not secure the uploaded document.");
  }
  return data;
}

/**
 * Builds a short-lived signed URL for an "authenticated" upload, so an admin
 * can actually view a worker's document during verification. Without this, a
 * private file can't be displayed anywhere.
 *
 * Pass the public_id Cloudinary returned at upload time.
 */
function signedUrlFor(publicId, { expiresInSeconds = 600 } = {}) {
  requireConfigured();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const toSign = `${expiresAt}/${publicId}`;
  const signature = crypto
    .createHash("sha256")
    .update(toSign + process.env.CLOUDINARY_API_SECRET)
    .digest("base64url")
    .slice(0, 32);

  return `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/authenticated/s--${signature}--/${publicId}`;
}

module.exports = { uploadImage, signedUrlFor };
