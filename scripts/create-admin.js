/**
 * Creates an admin user. Admins are never created through the public API.
 * Usage: node scripts/create-admin.js +251911111111 "Admin Name" a-strong-password
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../src/db");

async function main() {
  const [phone, fullName, password] = process.argv.slice(2);
  if (!phone || !fullName || !password) {
    console.error("Usage: node scripts/create-admin.js <phone> <full_name> <password>");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    `INSERT INTO users (phone, full_name, password_hash, role, is_phone_verified)
     VALUES ($1,$2,$3,'admin', true)
     RETURNING id, phone, full_name, role`,
    [phone, fullName, passwordHash]
  );
  console.log("Admin created:", rows[0]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
