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

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",") }));
app.use(express.json({limit: "10mb"}));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/bookings", reviewRoutes);   // adds POST /api/bookings/:bookingId/review
app.use("/api/conversations", messageRoutes); // /api/conversations/:bookingId/messages
app.use("/api/admin", adminRoutes);

// Fallback error handler — keeps stack traces out of API responses
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Ethiopia Task API listening on port ${PORT}`);
});
