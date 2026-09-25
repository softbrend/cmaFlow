// Admin-only dataset oversight: list every dataset uploaded by every SME
// owner account, and delete one (e.g. to clean up a test/duplicate
// upload). Deliberately does NOT touch dataset_records/dataset_files/
// canonical_records/analytics_result_cache/dataset_profiles directly —
// those all reference uploaded_datasets(id) ON DELETE CASCADE
// (db/schema.sql), so deleting the one uploaded_datasets row is
// sufficient and matches exactly what routes/dashboard.js's own
// POST /upload-dataset/:id/delete already does for an SME owner deleting
// their own dataset; this is the same operation, just not restricted to
// account_id = the caller's own account.
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { DATASETS_ROOT, sanitizeDatasetId } = require('../middleware/upload');

// Grouped for Manage Datasets: owners sorted alphabetically (a.business_name),
// and within each owner's group the most recently uploaded dataset first
// (ud.created_at DESC) — the view relies on this exact order to render each
// owner's block as a group with no separate client-side sort/group step.
// `search` (optional) narrows to owners matching a substring of their
// business name, owner name, or username — same case-insensitive-substring
// idiom as services/adminAccounts.js's listAccounts(search), since an
// installation can accumulate many SME owner accounts.
async function listAllDatasets(search) {
  const trimmed = (search || '').trim();
  const params = [];
  let ownerFilter = '';
  if (trimmed) {
    params.push(`%${trimmed}%`);
    ownerFilter = `WHERE a.business_name ILIKE $1 OR a.owner_name ILIKE $1 OR a.username ILIKE $1`;
  }
  const { rows } = await pool.query(
    `SELECT ud.id, ud.dataset_id, ud.dataset_name, ud.domain, ud.created_at,
            a.id AS account_id, a.username, a.owner_name, a.business_name,
            COUNT(df.id)::int AS file_count,
            COALESCE(SUM(df.row_count), 0)::int AS total_rows,
            MAX(df.uploaded_at) AS latest_upload
       FROM uploaded_datasets ud
       JOIN sme_accounts a ON a.id = ud.account_id
       LEFT JOIN dataset_files df ON df.dataset_id = ud.id
       ${ownerFilter}
      GROUP BY ud.id, a.id
      ORDER BY a.business_name ASC, ud.created_at DESC`,
    params
  );
  return rows;
}

async function getDatasetForAdmin(datasetRowId) {
  const { rows } = await pool.query(
    `SELECT ud.id, ud.dataset_id, ud.dataset_name, ud.domain, ud.created_at,
            a.id AS account_id, a.username, a.owner_name, a.business_name
       FROM uploaded_datasets ud
       JOIN sme_accounts a ON a.id = ud.account_id
      WHERE ud.id = $1`,
    [datasetRowId]
  );
  return rows[0] || null;
}

async function deleteDataset(datasetRowId) {
  const dataset = await getDatasetForAdmin(datasetRowId);
  if (!dataset) return null;

  await pool.query('DELETE FROM uploaded_datasets WHERE id = $1', [dataset.id]);

  const datasetDir = path.join(DATASETS_ROOT, String(dataset.account_id), sanitizeDatasetId(dataset.dataset_id));
  fs.rm(datasetDir, { recursive: true, force: true }, () => {});

  return dataset;
}

module.exports = { listAllDatasets, getDatasetForAdmin, deleteDataset };
