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
  const params = { folder, timestamp };
  if (isPrivate) params.type = "authenticated";

  const signature = sign(params);

  const form = new URLSearchParams({
    file: dataUri,
    api_key: process.env.CLOUDINARY_API_KEY,
    timestamp: String(timestamp),
    folder,
    signature,
  });
  if (isPrivate) form.set("type", "authenticated");

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: form }
  );
  const data = await res.json();

  if (!data.secure_url) {
    throw new Error(data.error?.message || "Upload failed");
  }
  return { url: data.secure_url, publicId: data.public_id };
}

module.exports = { uploadImage };
