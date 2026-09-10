const db = require("./db");
const crypto = require("crypto");

/**
 * Deletes a user's account in the sense Play Store / GDPR-style policies
 * require: personal identifying data is scrubbed and the account can no
 * longer be logged into. Booking, payment, and commission records are kept
 * (with the person's name replaced) rather than hard-deleted — this is a
 * standard, generally-accepted pattern since removing financial/transaction
 * history entirely could violate bookkeeping/tax obligations and would
 * break the other party's (customer's or worker's) own booking history.
 */
async function deleteAccount(userId) {
  const placeholderPhone = `deleted_${crypto.randomBytes(6).toString("hex")}`;

  await db.query(
    `UPDATE users SET
       full_name = 'Deleted User',
       email = NULL,
       phone = $1,
       password_hash = $2,
       profile_photo_url = NULL,
       is_deleted = true,
       deleted_at = now(),
       updated_at = now()
     WHERE id = $3`,
    [placeholderPhone, crypto.randomBytes(32).toString("hex"), userId]
  );

  // If this is a worker, also scrub bank/payout details and bio content.
  await db.query(
    `UPDATE worker_profiles SET
       bio = NULL, motivation = NULL,
       bank_code = NULL, bank_name = NULL, account_number = NULL,
       account_name = NULL, chapa_subaccount_id = NULL,
       updated_at = now()
     WHERE user_id = $1`,
    [userId]
  );
}

module.exports = { deleteAccount };
