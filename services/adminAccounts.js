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
//
// Excludes role = 'Template Evaluator' (added 30 September 2026) AND
// role = 'Business Owner Evaluator' (added 2 October 2026): this is
// "Manage SME Accounts" — SME owners and Admins, same as before either
// role existed. Each of those two roles is managed from its own separate
// page (listExpertAccounts()/"Manage Template Evaluators",
// listBusinessOwnerAccounts()/"Manage Business Owner Evaluators" below),
// so none of the three populations are ever listed, searched, or counted
// together.
async function listAccounts(search) {
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, role, cohort, created_at
         FROM sme_accounts
        WHERE role NOT IN ('Template Evaluator', 'Business Owner Evaluator', 'SME Owner-TAM Evaluator')
          AND (username ILIKE $1 OR owner_name ILIKE $1 OR business_name ILIKE $1 OR email ILIKE $1)
        ORDER BY created_at DESC`,
      [like]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, role, cohort, created_at
       FROM sme_accounts
      WHERE role NOT IN ('Template Evaluator', 'Business Owner Evaluator', 'SME Owner-TAM Evaluator')
      ORDER BY created_at DESC`
  );
  return rows;
}

// Same shape and search behavior as listAccounts(), filtered to
// role = 'Template Evaluator' only — backs the separate "Manage Template
// Evaluators" admin page.
async function listExpertAccounts(search) {
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, business_sector, role, evaluation_flow, created_at
         FROM sme_accounts
        WHERE role = 'Template Evaluator'
          AND (username ILIKE $1 OR owner_name ILIKE $1 OR business_name ILIKE $1 OR email ILIKE $1)
        ORDER BY created_at DESC`,
      [like]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, business_sector, role, evaluation_flow, created_at
       FROM sme_accounts
      WHERE role = 'Template Evaluator'
      ORDER BY created_at DESC`
  );
  return rows;
}

// Same shape and search behavior again, filtered to
// role = 'Business Owner Evaluator' only (added 2 October 2026) — backs
// the separate "Manage Business Owner Evaluators" admin page.
// business_sector here holds the business_category this account declared
// at signup (routes/auth.js's /businessOwner-signup/register — same
// reuse of that column Template Evaluator already relies on, see
// services/smeCategories.js). No business_region or evaluation_flow
// column: this signup form no longer collects a region (revised 2
// October 2026 to match Template Evaluator's signup shape instead of the
// plain SME one), and this role has only ever had one flow (always
// walkthrough-gated), so there's nothing to show for either.
async function listBusinessOwnerAccounts(search) {
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, business_sector, role, created_at
         FROM sme_accounts
        WHERE role = 'Business Owner Evaluator'
          AND (username ILIKE $1 OR owner_name ILIKE $1 OR business_name ILIKE $1 OR email ILIKE $1)
        ORDER BY created_at DESC`,
      [like]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, business_sector, role, created_at
       FROM sme_accounts
      WHERE role = 'Business Owner Evaluator'
      ORDER BY created_at DESC`
  );
  return rows;
}

// Same shape and search behavior again, filtered to
// role = 'SME Owner-TAM Evaluator' only (added 4 October 2026) — backs the
// separate "Manage SME Owner-TAM Evaluators" admin page. business_sector
// holds the business category declared at signup (same reuse of that
// column as Template Evaluator/Business Owner Evaluator). Never listed
// alongside any other population.
async function listSmeTamAccounts(search) {
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, business_sector, business_type, business_size,
              respondent_position, respondent_position_other, decision_authority, role, created_at
         FROM sme_accounts
        WHERE role = 'SME Owner-TAM Evaluator'
          AND (username ILIKE $1 OR owner_name ILIKE $1 OR business_name ILIKE $1 OR email ILIKE $1)
        ORDER BY created_at DESC`,
      [like]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, business_sector, business_type, business_size,
              respondent_position, respondent_position_other, decision_authority, role, created_at
       FROM sme_accounts
      WHERE role = 'SME Owner-TAM Evaluator'
      ORDER BY created_at DESC`
  );
  return rows;
}

async function getAccountById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, owner_name, business_name, email, role, cohort, evaluation_flow,
            business_sector, business_type, business_size,
            respondent_position, respondent_position_other, decision_authority, created_at
       FROM sme_accounts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function resetPassword(accountId, newPassword) {
  const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query('UPDATE sme_accounts SET password_hash = $1 WHERE id = $2', [password_hash, accountId]);
}

// Labels shown in the admin UI for each stored cohort value (db/schema.sql's
// sme_accounts_cohort_check CHECK constraint is the actual source of truth
// for which values are valid — this is display-only). '' (empty string from
// the <select>) is treated as "clear the tag" and stored as NULL, never as
// the literal string 'other' silently standing in for "unset".
const COHORT_LABELS = {
  mit267_2026: 'MIT 267 course cohort (2026)',
  field_study: 'Field study — real SME owner',
  internal_test: 'Internal test account',
  other: 'Other',
};

// Sets (or clears, with cohort=null/'') which recruitment pool an SME
// Owner account's TAM responses belong to — see the sme_accounts.cohort
// column comment in db/schema.sql for why this exists (peer-review
// recommendation #4: keep the existing MIT 267 course-cohort TAM
// responses distinguishable from any future real-SME field-study
// respondent, so a later reliability recomputation can filter one
// population out rather than silently mixing both). Validated here against
// the same allowed-value set as the DB CHECK constraint, so a bad value is
// rejected with a clear error rather than falling through to a Postgres
// constraint-violation error page.
async function setCohort(accountId, cohort) {
  const value = (cohort || '').trim();
  if (value && !Object.prototype.hasOwnProperty.call(COHORT_LABELS, value)) {
    throw new Error(`Unknown cohort value: ${value}`);
  }
  const { rows } = await pool.query(
    `UPDATE sme_accounts SET cohort = $1 WHERE id = $2
     RETURNING id, username, owner_name, business_name, email, role, cohort`,
    [value || null, accountId]
  );
  return rows[0] || null;
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
  listAccounts, listExpertAccounts, listBusinessOwnerAccounts, listSmeTamAccounts, getAccountById, resetPassword, countAdmins,
  createAdminAccount, promoteToAdmin, demoteToOwner, setCohort, COHORT_LABELS,
};
