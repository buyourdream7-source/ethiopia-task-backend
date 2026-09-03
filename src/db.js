const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("[db] DATABASE_URL is not set — the API will fail on first query.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Render, Railway, RDS) require SSL in production.
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
