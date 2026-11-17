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
const ExcelJS = require('exceljs');
const { parse: parseCsvSync } = require('csv-parse/sync');

// Grouped for Manage Datasets: owners sorted alphabetically (a.business_name),
// and within each owner's group the most recently uploaded dataset first
// (ud.created_at DESC) — the view relies on this exact order to render each
// owner's block as a group with no separate client-side sort/group step.
// `search` (optional) narrows to owners matching a substring of their
// business name, owner name, or username — same case-insensitive-substring
// idiom as services/adminAccounts.js's listAccounts(search), since an
// installation can accumulate many SME owner accounts.
//
// `roleMode` ('sme' | 'expert' | 'businessOwner' | 'all', default 'sme')
// picks which population's datasets this returns: uploaded_datasets
// itself stays one shared table (see db/schema.sql's note on the
// Template Evaluator role — only each population's own evaluation
// results get their own tables), but the three owner-facing admin pages
// that browse it ("Manage Datasets" vs the Template Evaluator equivalent
// vs the Business Owner Evaluator equivalent, added 2 October 2026) must
// still never show one population's uploads next to another's, so the
// role filter lives here instead of in the view. Default 'sme' explicitly
// excludes BOTH other roles (not just "!= 'Template Evaluator'" — that
// alone would silently let Business Owner Evaluator uploads leak into
// "Manage Datasets", the same class of bug adminAccounts.js's
// listAccounts() had before this role existed). 'all' is for the Gating
// Comparison tool only (routes/admin.js's /admin/gating-comparison) — a
// purely internal engineering diagnostic with no owner-facing framing,
// where picking from ANY population (including the Template Evaluator
// templates already built for exactly this kind of controlled
// comparison) is exactly what's wanted.
async function listAllDatasets(search, roleMode) {
  const trimmed = (search || '').trim();
  const roleClause = roleMode === 'all' ? 'TRUE'
    : roleMode === 'expert' ? `a.role = 'Template Evaluator'`
    : roleMode === 'businessOwner' ? `a.role = 'Business Owner Evaluator'`
    : roleMode === 'smeTam' ? `a.role = 'SME Owner-TAM Evaluator'`
    : `a.role NOT IN ('Template Evaluator', 'Business Owner Evaluator', 'SME Owner-TAM Evaluator')`;
  const params = [];
  let searchClause = '';
  if (trimmed) {
    params.push(`%${trimmed}%`);
    searchClause = `AND (a.business_name ILIKE $1 OR a.owner_name ILIKE $1 OR a.username ILIKE $1)`;
  }
  const { rows } = await pool.query(
    `SELECT ud.id, ud.dataset_id, ud.dataset_name, ud.domain, ud.created_at,
            a.id AS account_id, a.username, a.owner_name, a.business_name, a.role AS owner_role,
            COUNT(df.id)::int AS file_count,
            COALESCE(SUM(df.row_count), 0)::int AS total_rows,
            MAX(df.uploaded_at) AS latest_upload
       FROM uploaded_datasets ud
       JOIN sme_accounts a ON a.id = ud.account_id
       LEFT JOIN dataset_files df ON df.dataset_id = ud.id
      WHERE ${roleClause} ${searchClause}
      GROUP BY ud.id, a.id
      ORDER BY a.business_name ASC, ud.created_at DESC`,
    params
  );
  return rows;
}

// Includes the owning account's role (as owner_role) so callers — the
// shared /admin/datasets/:id/view|erd|delete routes, reachable from either
// "Manage Datasets" or "Template Evaluator Datasets" — can send the admin
// back to whichever list they came from, and label the page correctly,
// without a second query.
async function getDatasetForAdmin(datasetRowId) {
  const { rows } = await pool.query(
    `SELECT ud.id, ud.dataset_id, ud.dataset_name, ud.domain, ud.created_at,
            a.id AS account_id, a.username, a.owner_name, a.business_name, a.role AS owner_role
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

// ------------------------------------------------------------------
// Download (added 17 November 2026) — lets an Admin download any owner's
// dataset from the dataset-list pages (SME Owner-TAM Evaluator Datasets
// and the other three lists, which share views/dashboard/
// admin-datasets.ejs). The export is rebuilt from dataset_records — the
// exact rows the analytics pages were computed from — rather than served
// from uploads/datasets/ on disk, because Render's filesystem is not
// persistent across deploys, so the original CSV may no longer exist
// even though its rows are still in the database. When the original file
// IS still on disk, its header line is used only to restore the owner's
// original column order (JSONB does not preserve key order); any column
// not found in that header is appended after it.
//
// One physical file -> one CSV. Several files -> one .xlsx workbook with
// one sheet per file. Rows are read in keyset-paginated batches; the CSV
// path streams them straight to the response, so a large single-file
// dataset is never held in memory all at once.
// ------------------------------------------------------------------
const DOWNLOAD_BATCH = 5000;

// Each downloadable "part" of a dataset: one per dataset_files row, plus
// one per file_type for any legacy rows that predate source_file_id.
async function listDownloadParts(datasetRowId) {
  const { rows: files } = await pool.query(
    `SELECT id, file_type, original_name, stored_path, row_count
       FROM dataset_files
      WHERE dataset_id = $1
      ORDER BY uploaded_at ASC, id ASC`,
    [datasetRowId]
  );
  const parts = files.map((f) => ({
    sourceFileId: f.id,
    fileType: f.file_type,
    originalName: f.original_name,
    storedPath: f.stored_path,
  }));
  const { rows: legacy } = await pool.query(
    `SELECT DISTINCT file_type
       FROM dataset_records
      WHERE dataset_id = $1 AND source_file_id IS NULL
      ORDER BY file_type`,
    [datasetRowId]
  );
  legacy.forEach((l) => parts.push({ sourceFileId: null, fileType: l.file_type, originalName: `${l.file_type}.csv`, storedPath: null }));
  return parts;
}

function partWhere(datasetRowId, part, startParam) {
  const params = [datasetRowId, part.fileType];
  let clause = `dataset_id = $1 AND file_type = $2`;
  if (part.sourceFileId != null) {
    params.push(part.sourceFileId);
    clause += ` AND source_file_id = $${params.length}`;
  } else {
    clause += ` AND source_file_id IS NULL`;
  }
  if (startParam !== undefined) {
    params.push(startParam);
    clause += ` AND row_index > $${params.length}`;
  }
  return { clause, params };
}

// Reads just the header line of the original CSV, if it is still on disk.
function readOriginalHeader(storedPath) {
  if (!storedPath) return null;
  const candidates = path.isAbsolute(storedPath)
    ? [storedPath]
    : [path.join(__dirname, '..', storedPath), path.join(DATASETS_ROOT, storedPath)];
  for (const abs of candidates) {
    try {
      if (!fs.existsSync(abs)) continue;
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let text = buf.slice(0, n).toString('utf8').replace(/^﻿/, '');
      const nl = text.search(/\r?\n/);
      if (nl >= 0) text = text.slice(0, nl);
      const header = parseCsvSync(text, { relax_column_count: true, trim: true })[0];
      if (header && header.length) return header;
    } catch (e) { /* fall through to DB-derived order */ }
  }
  return null;
}

async function columnsForPart(datasetRowId, part) {
  const { clause, params } = partWhere(datasetRowId, part);
  // Union of keys across the part, in first-seen order (sampled, then
  // topped up with any key that only appears later in the file).
  const { rows: sample } = await pool.query(
    `SELECT data FROM dataset_records WHERE ${clause} ORDER BY row_index ASC LIMIT 2000`, params
  );
  const seen = [];
  const set = new Set();
  sample.forEach((r) => Object.keys(r.data || {}).forEach((k) => { if (!set.has(k)) { set.add(k); seen.push(k); } }));
  const { rows: allKeys } = await pool.query(
    `SELECT DISTINCT jsonb_object_keys(data) AS k FROM dataset_records WHERE ${clause}`, params
  );
  allKeys.forEach((r) => { if (!set.has(r.k)) { set.add(r.k); seen.push(r.k); } });

  const header = readOriginalHeader(part.storedPath);
  if (!header) return seen;
  const ordered = header.filter((h) => set.has(h));
  const inHeader = new Set(ordered);
  return ordered.concat(seen.filter((k) => !inHeader.has(k)));
}

// Calls onBatch(rowsOfDataObjects) for every batch, in row order.
async function forEachRowBatch(datasetRowId, part, onBatch) {
  let last = -2147483648;
  for (;;) {
    const { clause, params } = partWhere(datasetRowId, part, last);
    const { rows } = await pool.query(
      `SELECT row_index, data FROM dataset_records WHERE ${clause} ORDER BY row_index ASC LIMIT ${DOWNLOAD_BATCH}`,
      params
    );
    if (!rows.length) break;
    await onBatch(rows.map((r) => r.data || {}));
    last = rows[rows.length - 1].row_index;
    if (rows.length < DOWNLOAD_BATCH) break;
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeFilePart(s) {
  return String(s || 'dataset').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'dataset';
}

function sheetNameFor(part, used) {
  let base = String(part.originalName || part.fileType || 'Sheet')
    .replace(/\.csv$/i, '')
    .replace(/[\[\]:*?\/\\]/g, '_')
    .slice(0, 31) || 'Sheet';
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

// Streams the dataset to an Express response. Returns false (and writes
// nothing) if the dataset has no rows at all.
async function streamDatasetDownload(dataset, res) {
  const parts = await listDownloadParts(dataset.id);
  if (!parts.length) return false;
  const baseName = safeFilePart(dataset.dataset_id || dataset.dataset_name);

  if (parts.length === 1) {
    const part = parts[0];
    const columns = await columnsForPart(dataset.id, part);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    res.write('﻿'); // so Excel opens UTF-8 (e.g. ñ, ₱) correctly
    res.write(columns.map(csvCell).join(',') + '\r\n');
    await forEachRowBatch(dataset.id, part, async (batch) => {
      const chunk = batch.map((d) => columns.map((c) => csvCell(d[c])).join(',')).join('\r\n') + '\r\n';
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    });
    res.end();
    return true;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
  // Regular (in-memory) Workbook, not ExcelJS.stream.xlsx.WorkbookWriter:
  // the streaming writer in the exceljs 3.x pinned in package.json writes
  // zip entries Excel/openpyxl reject as corrupt. Multi-file datasets in
  // CMA-Flow are small enough (evaluation templates, owner uploads) that
  // building the workbook in memory first is fine.
  const workbook = new ExcelJS.Workbook();
  const used = new Set();
  for (const part of parts) {
    const columns = await columnsForPart(dataset.id, part);
    const sheet = workbook.addWorksheet(sheetNameFor(part, used));
    sheet.addRow(columns);
    await forEachRowBatch(dataset.id, part, async (batch) => {
      batch.forEach((d) => sheet.addRow(columns.map((c) => {
        const v = d[c];
        if (v === null || v === undefined) return null;
        return typeof v === 'object' ? JSON.stringify(v) : v;
      })));
    });
  }
  await workbook.xlsx.write(res);
  res.end();
  return true;
}

module.exports = { listAllDatasets, getDatasetForAdmin, deleteDataset, streamDatasetDownload };
