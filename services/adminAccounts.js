// Admin-only account management: listing SME accounts (with a simple
// username/owner/business/email search) and resetting a password on an
// account's behalf. Kept separate from routes/auth.js's own signup/login
// hashing only because this is a DIFFERENT authorization model — an Admin
// acting on someone else's account, not the account holder authenticating
// themselves — not a different security bar: same bcrypt cost factor
// (SALT_ROUNDS = 12), so a password an Admin sets here is exactly as
// strong as one an SME owner sets at signup.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const SALT_ROUNDS = 12;

// search matches username, owner name, business name, or email
// (case-insensitive substring) — enough to find one account among a
// modest evaluator/pilot-respondent list without a full filter UI.
async function listAccounts(search) {
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, role, created_at
         FROM sme_accounts
        WHERE username ILIKE $1 OR owner_name ILIKE $1 OR business_name ILIKE $1 OR email ILIKE $1
        ORDER BY created_at DESC`,
      [like]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, role, created_at
       FROM sme_accounts
      ORDER BY created_at DESC`
  );
  return rows;
}

async function getAccountById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, role, created_at
       FROM sme_accounts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function resetPassword(accountId, newPassword) {
  const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query('UPDATE sme_accounts SET password_hash = $1 WHERE id = $2', [password_hash, accountId]);
}

// How many accounts currently hold role='Admin' — used to block demoting
// the very last one (routes/admin.js), so the app can never be left with
// no way back into /admin short of a direct database edit.
async function countAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sme_accounts WHERE role = 'Admin'`);
  return rows[0].n;
}

// Creates a brand-new account with role='Admin' directly — the in-app
// counterpart to routes/auth.js's SME owner /signup, deliberately kept
// off any public URL: it only exists under routes/admin.js, which
// requireAdmin gates, so only an existing Admin can ever reach it. That's
// the difference from /signup being public — an SME owner account is
// harmless for a stranger to self-create; an Admin account is not.
// business_name/business_sector/business_region don't mean anything for
// an Admin account (no datasets, no monetization config), so callers pass
// a fixed placeholder for business_name (sme_accounts.business_name is
// NOT NULL) and leave sector/region null.
async function createAdminAccount({
  username, owner_name, email, password,
}) {
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO sme_accounts (username, owner_name, business_name, email, password_hash, role)
     VALUES ($1, $2, 'CMA-Flow Administration', $3, $4, 'Admin')
     RETURNING id, username, owner_name, business_name, email, role, created_at`,
    [username, owner_name, email, password_hash]
  );
  return rows[0];
}

async function promoteToAdmin(accountId) {
  const { rows } = await pool.query(
    `UPDATE sme_accounts SET role = 'Admin' WHERE id = $1
     RETURNING id, username, owner_name, business_name, email, role`,
    [accountId]
  );
  return rows[0] || null;
}

async function demoteToOwner(accountId) {
  const { rows } = await pool.query(
    `UPDATE sme_accounts SET role = 'SME Owner' WHERE id = $1
     RETURNING id, username, owner_name, business_name, email, role`,
    [accountId]
  );
  return rows[0] || null;
}

module.exports = {
  listAccounts, getAccountById, resetPassword, countAdmins,
  createAdminAccount, promoteToAdmin, demoteToOwner,
};
