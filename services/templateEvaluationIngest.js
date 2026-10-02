// Ingests a Template Evaluator's chosen SME template CSV (data/sme-
// templates/*_template.csv, each pre-populated with 50 synthetic rows —
// see claude/expert-evaluator-template-synthetic-data-and-browser.md) as
// that account's own working dataset, so picking a template doesn't just
// give them something to browse (routes/templates.js's GET
// /sme-templates/evaluation-data) — it's what the four analytics modules
// (Descriptive, Diagnostic, Predictive, Prescriptive) actually compute
// from, exactly as if the evaluator had uploaded it themselves.
//
// Deliberately mirrors the REAL upload path's database writes — the same
// uploaded_datasets / dataset_files / dataset_records / dataset_profiles
// shape services/datasetIngestService.js produces for a real POST
// /upload-dataset submission — rather than inventing a second, parallel
// way for analytics to find data. The only things this skips are the
// parts of that path that exist purely to handle a large, streamed,
// user-supplied file under a background job with a polling UI
// (middleware/upload.js's temp-folder dance, the PostgreSQL COPY
// pipeline, dataset_upload_jobs progress rows): 50 rows already sitting
// in memory from a local CSV don't need any of that, so this uses
// db/ingest.js's simpler batched-INSERT insertDatasetRecords() instead
// of its COPY-streaming sibling, and writes/commits synchronously within
// one request.
//
// Every Template Evaluator gets exactly ONE such dataset, always under the
// fixed dataset_id below — picking a different template replaces it
// (delete-then-recreate under the same slug) rather than accumulating a
// new uploaded_datasets row per switch. ON DELETE CASCADE from
// uploaded_datasets down through dataset_files, dataset_records, and
// dataset_profiles (see db/schema.sql) means the delete alone is enough;
// nothing has to be cleaned up by hand.
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { insertDatasetRecords } = require('../db/ingest');
const { upsertFileProfile } = require('./fullDescriptiveAnalytics');
const { DATASETS_ROOT, sanitizeDatasetId, sanitizeFileType } = require('../middleware/upload');
const { setDefaultDataset } = require('./accountDatasets');

const EVAL_DATASET_ID = 'EVALUATION_DEFAULT';
const EVAL_FILE_TYPE = sanitizeFileType('transactions');

// resolvedTemplate: { row, fullPath } from routes/templates.js's own
// resolveTemplateFile() — row.sme_business_category / row.template_file
// are what resolves to, so this never re-reads or re-validates the
// manifest itself. records: the already-parsed CSV rows (plain objects,
// string values — exactly what csv-parse/sync produces, the same shape
// profileFile()/insertDatasetRecords() already expect from a real
// upload's parsed rows).
async function ingestTemplateForEvaluation(accountId, resolvedTemplate, records) {
  const datasetId = EVAL_DATASET_ID;
  const datasetName = `${resolvedTemplate.row.sme_business_category} (Evaluation Template)`;
  const sanitizedId = sanitizeDatasetId(datasetId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Replaces any dataset this account previously ingested this way —
    // see module header. Scoped to (account_id, dataset_id) so this can
    // never touch a different account's data or any dataset the
    // evaluator uploaded manually under a different dataset_id.
    await client.query(
      `DELETE FROM uploaded_datasets WHERE account_id = $1 AND dataset_id = $2`,
      [accountId, datasetId]
    );

    const { rows: inserted } = await client.query(
      `INSERT INTO uploaded_datasets (account_id, dataset_id, dataset_name, domain)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, datasetId, datasetName, resolvedTemplate.row.sme_business_category]
    );
    const datasetRowId = inserted[0].id;

    // Physical copy into this account's own permanent dataset storage —
    // uploads/datasets/<accountId>/<sanitized dataset id>/<file type>/
    // <name>.csv — the exact layout finalizeDatasetUpload() uses for a
    // real upload, so dataset_files.stored_path points at a real file on
    // disk like every other dataset's does, not at the shared, read-only
    // data/sme-templates/ copy (which the next template-generation round
    // could overwrite).
    const originalName = resolvedTemplate.row.template_file;
    const destDir = path.join(DATASETS_ROOT, String(accountId), sanitizedId, EVAL_FILE_TYPE);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, originalName);
    fs.copyFileSync(resolvedTemplate.fullPath, destPath);
    const storedPath = path.join('uploads', 'datasets', String(accountId), sanitizedId, EVAL_FILE_TYPE, originalName);

    const { rows: fileRows } = await client.query(
      `INSERT INTO dataset_files (dataset_id, account_id, file_type, original_name, stored_path, row_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [datasetRowId, accountId, EVAL_FILE_TYPE, originalName, storedPath, records.length]
    );
    const sourceFileId = fileRows[0].id;

    await insertDatasetRecords(client, {
      datasetRowId, accountId, fileType: EVAL_FILE_TYPE, rows: records, sourceFileId, startRowIndex: 0,
    });

    // Same non-fatal-profiling contract as the real ingest path
    // (services/datasetIngestService.js): a profiling bug must never
    // roll back an otherwise-good ingest, since the raw rows above are
    // what the evaluator actually needs. getOrBuildFullProfile() will
    // compute it lazily later if this fails.
    try {
      await upsertFileProfile(client, {
        datasetRowId, accountId, fileType: EVAL_FILE_TYPE, rows: records,
      });
    } catch (profileErr) {
      console.error(`[templateEvaluationIngest] profiling failed for account ${accountId}:`, profileErr);
    }

    await client.query('COMMIT');

    // Makes this the account's working dataset everywhere a page falls
    // back to "the default" with no explicit ?dataset= — the SME Owner
    // Portal home page and, per the account-scoped EXISTS check inside
    // setDefaultDataset(), only ever this account's own row.
    await setDefaultDataset(accountId, datasetRowId);

    return { datasetRowId, rowCount: records.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ingestTemplateForEvaluation, EVAL_DATASET_ID };
