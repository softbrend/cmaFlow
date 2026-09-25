// Runs one dataset upload's ingest as a background job — extracted out of
// routes/dashboard.js's POST /upload-dataset handler (which now only does
// the fast, synchronous parts: multer receiving the files, field
// validation, and creating the job) so the request can return immediately
// with a job id instead of the browser waiting on one long response for
// however long parsing + loading + profiling take. See claude/
// upload-processing-performance.md for the full design writeup and why
// this stays a single-Node-process design (no Redis/BullMQ/Supabase) —
// services/uploadJobs.js's own header covers the same ground.
//
// The transactional shape here is IDENTICAL to the synchronous version it
// replaced: one BEGIN/COMMIT per dataset, every file's rows loaded inside
// it, files only moved from the temp folder to their permanent home after
// COMMIT succeeds, and the whole thing rolled back + temp files discarded
// on any failure. Only the parsing/loading mechanics changed (streaming +
// PostgreSQL COPY instead of a full in-memory parse + 500-row batched
// INSERT — see db/ingest.js's copyInsertDatasetRecords()) and progress is
// now reported to the job row as it goes.
const path = require('path');
const pool = require('../db/pool');
const { streamCsvFile, humanizeFileType } = require('../middleware/browse');
const { copyInsertDatasetRecords } = require('../db/ingest');
const { finalizeDatasetUpload, discardDatasetUpload, sanitizeDatasetId } = require('../middleware/upload');
const { upsertFileProfile } = require('./fullDescriptiveAnalytics');
const { updateUploadJob, completeUploadJob, failUploadJob } = require('./uploadJobs');

// Fire-and-forget progress write — called from inside db/ingest.js's hot
// per-row Transform, so it must never be awaited there (that would stall
// the COPY pipe on every update) and a failed status write must never
// break ingestion itself. Logged, not thrown.
function reportProgress(jobId, rowsDone) {
  updateUploadJob(jobId, { stage: 'loading', rowsDone }).catch((e) => {
    console.error(`[datasetIngestService] progress update failed for job ${jobId}:`, e.message);
  });
}

async function runDatasetIngestJob(jobId, {
  accountId, datasetId, datasetName, domain, byType, uploadTmpToken, pairedFiles,
}) {
  // finalizeDatasetUpload()/discardDatasetUpload() (middleware/upload.js)
  // only ever read `_uploadTmpToken` off whatever object they're given —
  // this job runs after the original request already responded, so it
  // gets a small stand-in object carrying just that token rather than a
  // live Express `req`.
  const fakeReq = { _uploadTmpToken: uploadTmpToken };

  const client = await pool.connect();
  let grandTotalRowsDone = 0;
  try {
    await client.query('BEGIN');

    const { rows: inserted } = await client.query(
      `INSERT INTO uploaded_datasets (account_id, dataset_id, dataset_name, domain)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, datasetId, datasetName, domain || null]
    );
    const datasetRowId = inserted[0].id;
    const rowSummary = {};

    for (const [fileType, group] of Object.entries(byType)) {
      let runningRowCount = 0;
      // Same reasoning as the synchronous version this replaced: built up
      // across every physical file sharing this label so profiling below
      // runs once over the full merged set.
      let allRowsForType = [];

      for (const { file, label } of group) {
        const storedPath = path.join(
          'uploads', 'datasets', String(accountId), sanitizeDatasetId(datasetId), fileType, file.filename
        );

        // row_count starts at 0 and is corrected below once the stream
        // finishes — the dataset_files row has to exist FIRST so its id
        // can be stamped onto every dataset_records row as source_file_id
        // while the COPY is still running.
        const { rows: fileRows } = await client.query(
          `INSERT INTO dataset_files (dataset_id, account_id, file_type, original_name, stored_path, row_count)
           VALUES ($1, $2, $3, $4, $5, 0) RETURNING id`,
          [datasetRowId, accountId, fileType, file.originalname, storedPath]
        );
        const sourceFileId = fileRows[0].id;

        const collected = [];
        let fileRowCount;
        try {
          const rowStream = streamCsvFile(file.path);
          fileRowCount = await copyInsertDatasetRecords(client, {
            datasetRowId, accountId, fileType, rowStream, sourceFileId,
            startRowIndex: runningRowCount, collectInto: collected,
            onProgress: (n) => reportProgress(jobId, grandTotalRowsDone + n),
          });
        } catch (streamErr) {
          throw Object.assign(
            new Error(`${file.originalname} (${label}) could not be read as a CSV file (${streamErr.message}).`),
            { isParseError: true }
          );
        }

        await client.query(`UPDATE dataset_files SET row_count = $1 WHERE id = $2`, [fileRowCount, sourceFileId]);
        allRowsForType = allRowsForType.concat(collected);
        runningRowCount += fileRowCount;
        grandTotalRowsDone += fileRowCount;
        reportProgress(jobId, grandTotalRowsDone);
      }

      rowSummary[fileType] = { files: group.length, rows: runningRowCount };

      // Same non-fatal-profiling contract as the synchronous version:
      // profiling is never allowed to fail the upload itself — the raw
      // ingest above (what the SME owner actually asked for) has already
      // succeeded by this point in the transaction, so a profiling bug is
      // logged and swallowed rather than rolling back a perfectly good
      // upload. getOrBuildFullProfile() computes it lazily later instead.
      if (allRowsForType.length > 0) {
        await updateUploadJob(jobId, { stage: 'profiling' });
        try {
          await upsertFileProfile(client, {
            datasetRowId, accountId, fileType, rows: allRowsForType,
          });
        } catch (profileErr) {
          console.error(`Full Descriptive Analytics profiling failed for dataset ${datasetId} / ${fileType}:`, profileErr);
        }
      }
    }

    await client.query('COMMIT');
    await updateUploadJob(jobId, { stage: 'finalizing' });
    // Only now — after the database write is confirmed durable — do the
    // raw files move out of the temp folder and into their permanent home.
    finalizeDatasetUpload(fakeReq, accountId, datasetId, pairedFiles);

    const summaryParts = Object.entries(rowSummary).map(([fileType, s]) => (
      `${humanizeFileType(fileType)} (${s.files} file${s.files === 1 ? '' : 's'}, ${s.rows.toLocaleString()} rows)`
    ));
    await completeUploadJob(jobId, {
      datasetRowId,
      summary: { message: `"${datasetName}" (${datasetId}) uploaded: ${summaryParts.join(', ')}.` },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    discardDatasetUpload(fakeReq); // temp files only — never touches another dataset's files

    let message = 'The upload could not be processed.';
    if (err.code === '23505') {
      message = `Dataset ID "${datasetId}" is already used for this account — choose another.`;
    } else if (err.isParseError) {
      message = err.message;
    } else {
      console.error(`[datasetIngestService] job ${jobId} failed:`, err);
    }
    await failUploadJob(jobId, message);
  } finally {
    client.release();
  }
}

module.exports = { runDatasetIngestJob };
