// Account-level "default dataset" — the uploaded dataset the SME Owner
// Portal home page (and, per the feature request, every login) treats as
// this account's working dataset when nothing more specific is chosen.
// This is deliberately separate from the per-page `?dataset=` selector
// already used throughout routes/dashboard.js (monetization-discovery,
// descriptive-analytics, etc.) — those stay exactly as they are, each
// still defaulting to that account's own most-recently-uploaded dataset
// when no `?dataset=` is given. What's new here is a single, sticky,
// SME-owner-chosen "this is the one" flag stored on sme_accounts itself
// (see the `default_dataset_id` column added in db/schema.sql), so the
// home page never has to show "No dataset is currently assigned to this
// account" once the SME owner has actually uploaded one.
const pool = require('../db/pool');

// Every uploaded_datasets row for this account, most recently uploaded
// first — the same ordering convention every other per-page dataset
// selector in dashboard.js already uses, so "the default" and "whichever
// dataset a page falls back to with no ?dataset=" agree with each other
// whenever a default hasn't been explicitly chosen yet.
async function listAccountDatasets(accountId) {
  const { rows } = await pool.query(
    `SELECT id, dataset_id, dataset_name, domain, created_at
       FROM uploaded_datasets
      WHERE account_id = $1
      ORDER BY created_at DESC`,
    [accountId]
  );
  return rows;
}

// Guarantees this account has a usable default dataset the moment it has
// ANY uploaded dataset at all. Called on every successful login (the
// explicit ask: "always have a dataset assigned to the SME owner upon
// successful log-in if there were already uploaded datasets") and again
// as a self-healing check anywhere the default is read (the SME Owner
// Portal home page, the Upload New Dataset page) — that second call site
// matters because a session can outlive a change: a dataset uploaded
// after login, or the previously-default dataset being deleted since
// (uploaded_datasets(id) ON DELETE SET NULL already clears the column at
// the database level in that case; this is what re-fills it).
//
// Never overwrites a default the SME owner already has and that's still
// valid. Only fills the gap when there is one — no default ever chosen,
// or the chosen one no longer exists — by falling back to the most
// recently uploaded dataset (datasets[0], per the ORDER BY above).
//
// Returns { datasets, defaultDatasetId }. defaultDatasetId is null only
// when the account genuinely has no uploaded datasets yet — nothing to
// default to.
async function ensureDefaultDataset(accountId) {
  const [{ rows: acctRows }, datasets] = await Promise.all([
    pool.query(`SELECT default_dataset_id FROM sme_accounts WHERE id = $1`, [accountId]),
    listAccountDatasets(accountId),
  ]);
  const currentDefaultId = acctRows[0] ? acctRows[0].default_dataset_id : null;

  if (datasets.length === 0) {
    return { datasets, defaultDatasetId: null };
  }

  const stillValid = currentDefaultId != null && datasets.some((d) => d.id === currentDefaultId);
  if (stillValid) {
    return { datasets, defaultDatasetId: currentDefaultId };
  }

  const fallbackId = datasets[0].id;
  await pool.query(`UPDATE sme_accounts SET default_dataset_id = $1 WHERE id = $2`, [fallbackId, accountId]);
  return { datasets, defaultDatasetId: fallbackId };
}

// The SME owner's own explicit choice — "the SME owner can select and set
// this default dataset" half of the request. Scoped to accountId via the
// EXISTS check so one account can never set another's default by posting
// a guessed uploaded_datasets id; returns null (a silent no-op) rather
// than throwing when the id doesn't belong to this account, since that
// can only happen from a stale or hand-crafted form submission.
async function setDefaultDataset(accountId, datasetRowId) {
  const { rows } = await pool.query(
    `UPDATE sme_accounts SET default_dataset_id = $1
      WHERE id = $2 AND EXISTS (
        SELECT 1 FROM uploaded_datasets WHERE id = $1 AND account_id = $2
      )
      RETURNING default_dataset_id`,
    [datasetRowId, accountId]
  );
  return rows[0] ? rows[0].default_dataset_id : null;
}

module.exports = { listAccountDatasets, ensureDefaultDataset, setDefaultDataset };
