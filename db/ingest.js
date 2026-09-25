// Bulk-inserts parsed CSV rows into dataset_records as JSONB, in batches,
// using the given pg client (expected to be inside a transaction).
//
// startRowIndex lets several physical files of the same file_type merge
// into one continuous, ordered set of row_index values instead of each
// restarting at 1 and colliding/interleaving — the caller passes the
// running total of rows already ingested for this dataset+file_type
// (e.g. from earlier files in the same upload). sourceFileId traces every
// inserted row back to the exact dataset_files row it was parsed from.
//
// Superseded by copyInsertDatasetRecords() below as of the streaming/COPY
// upload-performance pass (services/datasetIngestService.js) — kept here,
// unused by that new path, as a known-good reference implementation and
// a rollback point, since nothing else in the app still calls it.
const BATCH_SIZE = 500;

async function insertDatasetRecords(client, {
  datasetRowId, accountId, fileType, rows, sourceFileId = null, startRowIndex = 0,
}) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, i) => {
      const base = i * 6;
      values.push(
        datasetRowId, accountId, fileType, sourceFileId, startRowIndex + offset + i + 1, JSON.stringify(row)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`;
    });

    await client.query(
      `INSERT INTO dataset_records (dataset_id, account_id, file_type, source_file_id, row_index, data)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------
// Streaming, PostgreSQL COPY-based bulk loader — the primary ingest path
// as of the upload-performance pass. COPY FROM STDIN is Postgres's own
// bulk-load mechanism: one continuous data stream to the server instead
// of one round trip per 500-row INSERT batch, which is where most of the
// real wall-clock time in insertDatasetRecords() above goes for a large
// file. Still runs inside the caller's transaction exactly like the old
// batched INSERT did (COPY is fully transactional), so the same
// all-or-nothing guarantee — the whole dataset commits together or none
// of it does — is unchanged.
//
// rowStream is a Node object-mode Readable emitting one parsed row per
// chunk (middleware/browse.js's streamCsvFile()) — rows are converted to
// Postgres COPY TEXT format and piped straight into the server as they
// arrive, so loading can be underway on the rows already parsed while
// the parser is still reading the tail of the file, rather than: parse
// the whole file first, THEN start loading.
//
// If collectInto is given (an array), every row is also pushed onto it
// as it passes through — this is what lets the caller still hand the
// exact same in-memory row array to services/datasetProfiler.js
// afterward without a second read of the file or a second DB round trip,
// since that profiling engine's own single-pass rewrite is a separate,
// later piece of work (not part of this pass).
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { from: copyFrom } = require('pg-copy-streams');

// Postgres COPY TEXT format reserves backslash, tab, newline, and
// carriage return as structural characters — each must be backslash-
// escaped in the data itself or COPY misreads column boundaries. Applied
// to the already-JSON.stringify()'d row (so any characters CSV or JSON
// itself uses — commas, quotes, unicode — are untouched; only the four
// bytes that COPY TEXT format itself treats specially need escaping).
function escapeCopyText(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

async function copyInsertDatasetRecords(client, {
  datasetRowId, accountId, fileType, rowStream, sourceFileId = null, startRowIndex = 0,
  collectInto = null, onProgress = null,
}) {
  let count = 0;
  const copyStream = client.query(copyFrom(
    `COPY dataset_records (dataset_id, account_id, file_type, source_file_id, row_index, data) FROM STDIN WITH (FORMAT text)`
  ));
  const toCopyLine = new Transform({
    objectMode: true,
    transform(row, _enc, cb) {
      if (collectInto) collectInto.push(row);
      count += 1;
      const rowIndex = startRowIndex + count;
      const srcId = sourceFileId === null || sourceFileId === undefined ? '\\N' : sourceFileId;
      const line = `${datasetRowId}\t${accountId}\t${fileType}\t${srcId}\t${rowIndex}\t${escapeCopyText(JSON.stringify(row))}\n`;
      cb(null, line);
      if (onProgress && count % 1000 === 0) onProgress(count);
    },
  });

  await pipeline(rowStream, toCopyLine, copyStream);
  if (onProgress) onProgress(count);
  return count;
}

module.exports = { insertDatasetRecords, copyInsertDatasetRecords };
