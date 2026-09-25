// Tracks one background dataset-ingest job per POST /upload-dataset
// submission, backed by the dataset_upload_jobs table (db/schema.sql) —
// see that table's own comment for why a DB row is enough here (single
// Node instance, no separate queue/worker service) and what "not
// resumable" means for a job interrupted by a restart.
//
// services/datasetIngestService.js is the only other module that should
// import this — routes/dashboard.js only ever reads job status (to
// render the processing page / poll endpoint) or calls
// reconcileStuckUploadJobs() once at boot (server.js).
const pool = require('../db/pool');

// Valid `stage` values, in the order the UI shows them. Kept here (not
// just inline strings scattered through datasetIngestService.js) so the
// processing page's step list and this list can never drift apart.
// 'loading' covers parsing AND the PostgreSQL COPY bulk-load together —
// datasetIngestService.js streams a file straight from disk through the
// CSV parser into COPY in one pipe, so there is no separate moment where
// "parsing" has finished but "loading" hasn't started yet to report.
const STAGES = ['validating', 'loading', 'profiling', 'finalizing', 'completed', 'failed'];

async function createUploadJob({ accountId, datasetId }) {
  const { rows } = await pool.query(
    `INSERT INTO dataset_upload_jobs (account_id, dataset_id, status, stage)
     VALUES ($1, $2, 'processing', 'validating') RETURNING id`,
    [accountId, datasetId]
  );
  return rows[0].id;
}

// stage/rowsDone updates happen often (every ~1000 rows during Loading),
// so this is a small, single-row UPDATE — cheap enough to call from
// inside the ingest loop without noticeably slowing it down.
async function updateUploadJob(jobId, { stage, rowsDone } = {}) {
  const sets = ['updated_at = now()'];
  const values = [];
  if (stage !== undefined) { values.push(stage); sets.push(`stage = $${values.length}`); }
  if (rowsDone !== undefined) { values.push(rowsDone); sets.push(`rows_done = $${values.length}`); }
  if (values.length === 0) return;
  values.push(jobId);
  await pool.query(`UPDATE dataset_upload_jobs SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

async function completeUploadJob(jobId, { datasetRowId, summary }) {
  await pool.query(
    `UPDATE dataset_upload_jobs
        SET status = 'completed', stage = 'completed', dataset_row_id = $2,
            summary = $3::jsonb, updated_at = now()
      WHERE id = $1`,
    [jobId, datasetRowId, JSON.stringify(summary)]
  );
}

async function failUploadJob(jobId, errorMessage) {
  await pool.query(
    `UPDATE dataset_upload_jobs
        SET status = 'failed', stage = 'failed', error_message = $2, updated_at = now()
      WHERE id = $1`,
    [jobId, String(errorMessage || 'The upload could not be processed.').slice(0, 2000)]
  );
}

// Ownership-checked read — every route that looks up a job by id from a
// URL param must pass the signed-in account's id here, never trust the
// id alone, so one SME owner can never poll another's job status.
async function getUploadJobForAccount(jobId, accountId) {
  const { rows } = await pool.query(
    `SELECT id, account_id, dataset_id, dataset_row_id, status, stage, rows_done, error_message, summary, created_at
       FROM dataset_upload_jobs
      WHERE id = $1 AND account_id = $2`,
    [jobId, accountId]
  );
  return rows[0] || null;
}

// Called once at server boot (server.js), right alongside the existing
// TMP_ROOT wipe — a job still 'processing' at that point belongs to a
// request that never finished (the process was killed or redeployed
// mid-ingest), and its temp files were just deleted by that same wipe,
// so there is nothing left to resume. Marking it 'failed' here is what
// stops the processing page from polling forever against a job that can
// never move again.
async function reconcileStuckUploadJobs() {
  const { rowCount } = await pool.query(
    `UPDATE dataset_upload_jobs
        SET status = 'failed', stage = 'failed',
            error_message = 'Interrupted by a server restart — please try the upload again.',
            updated_at = now()
      WHERE status = 'processing'`
  );
  if (rowCount > 0) {
    console.log(`[uploadJobs] Marked ${rowCount} stuck upload job(s) as failed after restart.`);
  }
}

module.exports = {
  STAGES,
  createUploadJob,
  updateUploadJob,
  completeUploadJob,
  failUploadJob,
  getUploadJobForAccount,
  reconcileStuckUploadJobs,
};
