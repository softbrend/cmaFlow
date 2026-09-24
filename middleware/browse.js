const fs = require('fs');
const { parse } = require('csv-parse/sync');

// A dataset's file types are whatever free-form labels the SME owner gave
// its files at upload time (see sanitizeFileType() in middleware/upload.js)
// — there is no fixed list. humanizeFileType() turns the stored slug back
// into a readable label for display: "feature_usage" -> "Feature Usage".
function humanizeFileType(slug) {
  return String(slug || '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || slug;
}

// Safety cap so one huge CSV can't hang the process. parseCsvFile() below
// still reads the WHOLE file into memory as one string before parsing
// (fs.readFileSync, not a stream) and csv-parse's own `to` option only
// stops materializing row OBJECTS once this many are built — it doesn't
// reduce how much of the file gets read first. So this cap bounds row-
// object memory, not the read itself: raising the upload size limit
// (middleware/upload.js) to 500MB already means a single upload can hold
// up to ~500MB as a string in memory regardless of this constant. Raised
// from 200,000 to 2,000,000 alongside that 500MB limit (10x row cap for
// 5x file size, since real-world CSVs vary widely in row width) — a
// deliberate middle ground, not a switch to streaming: a single request
// parsing a full-width multi-million-row file is still a real memory/CPU
// spike on this server, worth watching if 500MB uploads become common.
const MAX_ROWS_PARSED = 2000000;
const SELECT_DISTINCT_LIMIT = 25; // columns with more distinct values than this get a text filter instead of a dropdown

// Parses a CSV file on disk into an array of plain objects (one per row,
// keyed by header). Used once at upload time to ingest rows into
// dataset_records — browsing reads back from the database, not the file.
function parseCsvFile(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    to: MAX_ROWS_PARSED,
  });
  return rows;
}

function isNumeric(value) {
  if (value === '' || value === null || value === undefined) return true; // blanks don't disqualify
  return value !== '' && !Number.isNaN(Number(value));
}

// Builds per-column filter metadata (type + options) from the FULL row set,
// so dropdown choices stay stable regardless of which filters are currently applied.
// Columns are derived from the data itself (not a fixed schema), since
// different SME datasets can have entirely different fields.
function buildColumnMeta(rows, columns) {
  return columns.map((col) => {
    const values = rows.map((r) => (r[col] === undefined ? '' : String(r[col]).trim()));
    const nonEmpty = values.filter((v) => v !== '');
    const distinct = Array.from(new Set(nonEmpty)).sort();
    const numeric = nonEmpty.length > 0 && nonEmpty.every(isNumeric);

    if (numeric) {
      const nums = nonEmpty.map(Number);
      return {
        name: col,
        type: 'number',
        min: Math.min(...nums),
        max: Math.max(...nums),
      };
    }
    if (distinct.length > 0 && distinct.length <= SELECT_DISTINCT_LIMIT) {
      return { name: col, type: 'select', options: distinct };
    }
    return { name: col, type: 'text' };
  });
}

// Applies ?f_<column>=value / ?fmin_<column>= / ?fmax_<column>= query params to the row set.
function applyFilters(rows, columnMeta, query) {
  let filtered = rows;

  columnMeta.forEach((meta) => {
    if (meta.type === 'number') {
      const min = query[`fmin_${meta.name}`];
      const max = query[`fmax_${meta.name}`];
      if (min !== undefined && min !== '') {
        const minNum = Number(min);
        filtered = filtered.filter((r) => r[meta.name] !== '' && Number(r[meta.name]) >= minNum);
      }
      if (max !== undefined && max !== '') {
        const maxNum = Number(max);
        filtered = filtered.filter((r) => r[meta.name] !== '' && Number(r[meta.name]) <= maxNum);
      }
    } else {
      const val = query[`f_${meta.name}`];
      if (val !== undefined && val !== '') {
        if (meta.type === 'select') {
          filtered = filtered.filter((r) => String(r[meta.name] || '').trim() === val);
        } else {
          const needle = val.toLowerCase();
          filtered = filtered.filter((r) => String(r[meta.name] || '').toLowerCase().includes(needle));
        }
      }
    }
  });

  return filtered;
}

module.exports = {
  humanizeFileType,
  parseCsvFile,
  buildColumnMeta,
  applyFilters,
};
