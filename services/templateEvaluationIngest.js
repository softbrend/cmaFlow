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
const { parse } = require('csv-parse/sync');
const pool = require('../db/pool');
const { insertDatasetRecords } = require('../db/ingest');
const { upsertFileProfile } = require('./fullDescriptiveAnalytics');
const { DATASETS_ROOT, sanitizeDatasetId, sanitizeFileType } = require('../middleware/upload');
const { setDefaultDataset } = require('./accountDatasets');

const TEMPLATES_ROOT = path.join(__dirname, '..', 'data', 'sme-templates');
const MANIFEST_PATH = path.join(TEMPLATES_ROOT, '00_CMAFlow_SME_Template_Manifest.csv');

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

// ------------------------------------------------------------------
// Auto-default at signup (added 2 October 2026, per Brenda's explicit
// request): the business category a Template Evaluator declares at
// signup (routes/auth.js's business_category field — validated there
// against services/smeCategories.js's isValidCategory(), which reads
// this exact manifest, so the lookup below can never miss) becomes their
// default CSV for evaluation automatically, with no separate "Use for
// evaluation" click required. They can still pick a DIFFERENT category's
// template at any time from /sme-templates — this only sets the
// starting point, through the exact same ingestTemplateForEvaluation()
// above a manual "Use for evaluation" click already runs, so the two
// paths can never drift out of sync with each other.
// ------------------------------------------------------------------

// Re-reads the manifest fresh each call, same reasoning as services/
// smeCategories.js's own loadCategories() (a 20-row CSV, never a hot
// path) — kept as its own small read here rather than importing that
// module's, since the two serve different shapes (name/examples for the
// signup dropdown vs. the full row + file path needed to actually ingest
// a template) and duplicating one tiny parse is simpler than threading a
// shared internal helper across modules for this.
function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true });
}

// Resolves a manifest row by its EXACT sme_business_category string
// (never by filename — that's routes/templates.js's own
// resolveTemplateFile(), a separate lookup this deliberately doesn't
// duplicate) to the same { row, fullPath } shape ingestTemplateForEvaluation()
// expects. Returns null if nothing matches, which should never happen
// for a category that passed signup validation — checked anyway rather
// than assumed, since a mismatch here must never fail account creation.
function resolveTemplateForCategory(categoryName) {
  const manifest = loadManifest();
  const row = manifest.find((r) => r.sme_business_category === categoryName);
  if (!row) return null;
  return { row, fullPath: path.join(TEMPLATES_ROOT, row.template_file) };
}

// Called once, right after a Template Evaluator account is created.
// Returns { templateFile, datasetRowId } on success (for the caller to
// persist sme_accounts.evaluation_template_file and refresh
// req.session.user, matching exactly what routes/templates.js's POST
// /sme-templates/set-evaluation-default already does for a manual pick),
// or null if the category didn't resolve to a manifest row.
async function ingestDefaultTemplateForCategory(accountId, categoryName) {
  const resolved = resolveTemplateForCategory(categoryName);
  if (!resolved) return null;
  const raw = fs.readFileSync(resolved.fullPath, 'utf-8');
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  const { datasetRowId } = await ingestTemplateForEvaluation(accountId, resolved, records);
  return { templateFile: resolved.row.template_file, datasetRowId };
}

module.exports = {
  ingestTemplateForEvaluation, EVAL_DATASET_ID, EVAL_FILE_TYPE, resolveTemplateForCategory, ingestDefaultTemplateForCategory,
};
