// Bulk-inserts parsed CSV rows into dataset_records as JSONB, in batches,
// using the given pg client (expected to be inside a transaction).
//
// startRowIndex lets several physical files of the same file_type merge
// into one continuous, ordered set of row_index values instead of each
// restarting at 1 and colliding/interleaving — the caller passes the
// running total of rows already ingested for this dataset+file_type
// (e.g. from earlier files in the same upload). sourceFileId traces every
// inserted row back to the exact dataset_files row it was parsed from.
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

module.exports = { insertDatasetRecords };
