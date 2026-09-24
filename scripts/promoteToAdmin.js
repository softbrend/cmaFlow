// One-off CLI to grant an existing account the Admin role. There's no
// self-serve "create an admin" screen in the app by design — an admin
// account is created the same way any account is (sign up normally at
// /signup), then promoted with this script, run once, on the machine
// that has direct database access. See routes/admin.js for what the
// Admin role unlocks (manage accounts / browse evaluations) and
// middleware/auth.js's requireAdmin for how it's enforced.
//
// Usage:
//   npm run make-admin -- <username>
require('dotenv').config();
const pool = require('../db/pool');

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run make-admin -- <username>');
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query(
    `UPDATE sme_accounts SET role = 'Admin' WHERE username = $1
     RETURNING id, username, owner_name, role`,
    [username.trim()]
  );

  if (rows.length === 0) {
    console.error(`No account found with username "${username}". Sign up that account first, then re-run this.`);
    process.exitCode = 1;
    return;
  }

  const account = rows[0];
  console.log(`${account.username} (${account.owner_name}) is now role="${account.role}" — can sign in and reach /admin.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
