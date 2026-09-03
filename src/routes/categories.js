const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM categories WHERE is_active = true ORDER BY sort_order ASC"
  );
  res.json(rows);
});

module.exports = router;
