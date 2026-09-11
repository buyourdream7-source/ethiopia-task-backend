require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const categoryRoutes = require("./routes/categories");
const workerRoutes = require("./routes/workers");
const bookingRoutes = require("./routes/bookings");
const reviewRoutes = require("./routes/reviews");
const messageRoutes = require("./routes/messages");
const adminRoutes = require("./routes/admin");
const paymentRoutes = require("./routes/payments");
const notificationRoutes = require("./routes/notifications");
const publicPagesRoutes = require("./routes/publicPages");

const app = express();

// Railway (like most hosts) puts a proxy in front of the app, so the client's
// real IP arrives in X-Forwarded-For. Without this, rate limiting would either
// warn or bucket every user under the proxy's single IP.
app.set("trust proxy", 1);

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",") }));
app.use(express.json({ limit: "8mb" })); // raised from default 100kb to fit base64 document uploads

// Rate limiting: protects against abuse, credential-stuffing on login, and
// runaway request loops in the app itself. Deliberately generous — this is a
// safety net, not something a normal user should ever hit.
const rateLimit = require("express-rate-limit");

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 120,                     // 120 requests/minute per IP across the API
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
}));

// Auth endpoints get a tighter limit — these are the ones worth brute-forcing.
app.use(["/api/auth/login", "/api/auth/register"], rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                      // 20 attempts per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
}));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/", publicPagesRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/bookings", reviewRoutes);   // adds POST /api/bookings/:bookingId/review
app.use("/api/conversations", messageRoutes); // /api/conversations/:bookingId/messages
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/notifications", notificationRoutes);

// Fallback error handler — keeps stack traces out of API responses
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Ethiopia Task API listening on port ${PORT}`);
});
