const db = require("../db");

/**
 * Reads the current platform commission rate (e.g. 0.10 = 10%).
 * Stored in platform_settings so admins can change it without a deploy.
 */
async function getCommissionRate() {
  const { rows } = await db.query(
    "SELECT value FROM platform_settings WHERE key = 'commission_rate'"
  );
  if (!rows.length) return 0.1; // sane default if the row is ever missing
  return parseFloat(rows[0].value);
}

/**
 * Splits a final job price into platform commission and worker earnings.
 * Always rounds to 2 decimal places (ETB uses cents, "santim").
 */
function splitPayment(priceFinal, commissionRate) {
  const commissionAmount = Math.round(priceFinal * commissionRate * 100) / 100;
  const workerEarnings = Math.round((priceFinal - commissionAmount) * 100) / 100;
  return { commissionAmount, workerEarnings };
}

module.exports = { getCommissionRate, splitPayment };
