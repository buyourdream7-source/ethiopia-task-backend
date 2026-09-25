const express = require("express");
const db = require("../db");

const { makeSafe } = require("../utils/safeRouter");

const router = express.Router();
// A thrown error here returns 500 instead of killing the whole process.
makeSafe(router);

router.get("/", async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM categories WHERE is_active = true ORDER BY sort_order ASC"
  );
  res.json(rows);
});

module.exports = router;
