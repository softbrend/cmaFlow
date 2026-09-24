const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Where uploaded dataset CSVs live on disk, relative to the project root.
// Not committed to git — see .gitignore.
const DATASETS_ROOT = path.join(__dirname, '..', 'uploads', 'datasets');
const TMP_ROOT = path.join(__dirname, '..', 'uploads', '_tmp');

// One Dataset ID, but any number of CSV files, each given its own
// SME-chosen label — NOT limited to a fixed set of 4 file types. The
// upload form adds one row per file (a file picker + a label text box);
// each row is named on the wire as file_<n> / label_<n> with n a running
// index the client assigns as rows are added, so the server can accept
// however many rows actually got submitted rather than a fixed list.
const FILE_FIELD_RE = /^file_(\d+)$/;
const MAX_FILES = 200; // safety cap on one submission, not a business limit

function sanitizeDatasetId(raw) {
  return String(raw || 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 50) || 'unknown';
}

// Turns whatever label the SME owner typed for a file (or, if they left it
// blank, the file's own original name) into a safe, storable file_type
// slug — lowercase, [a-z0-9_] only, matching dataset_files/dataset_records'
// CHECK constraint. "Feature Usage" -> "feature_usage", "Churn Events.csv"
// -> "churn_events". This is the ONLY thing that decides a file's type —
// there is no fixed enum of allowed names.
function sanitizeFileType(rawLabel) {
  const slug = String(rawLabel || '')
    .trim()
    .toLowerCase()
    .replace(/\.csv$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || 'file';
}

function sanitizeFileName(raw) {
  return String(raw || 'file.csv')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 150) || 'file.csv';
}

// Files are written to a fresh, request-scoped temp folder first — never
// straight into the dataset's final folder. That final folder is named
// after the dataset_id, which two requests could collide on (e.g. a
// duplicate-ID resubmission); writing into it directly could otherwise
// clobber a different, already-committed dataset's files before the
// duplicate is even rejected. finalizeDatasetUpload()/discardDatasetUpload()
// below move or remove the temp folder once the outcome is known.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req._uploadTmpToken) {
      req._uploadTmpToken = crypto.randomBytes(12).toString('hex');
    }
    const dir = path.join(TMP_ROOT, req._uploadTmpToken);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const unique = crypto.randomBytes(6).toString('hex');
    cb(null, `${file.fieldname}--${unique}--${sanitizeFileName(file.originalname)}`);
  },
});

function fileFilter(req, file, cb) {
  const isCsv = /\.csv$/i.test(file.originalname) &&
    ['text/csv', 'application/vnd.ms-excel', 'application/octet-stream', 'text/plain'].includes(file.mimetype || 'text/csv');
  if (!isCsv) {
    return cb(new Error(`${file.originalname} is not a .csv file.`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024, files: MAX_FILES }, // 500MB per file
});

// .any() accepts every file_<n> field regardless of how many rows the
// dynamic upload form ends up having — the server never needs a fixed
// list of expected field names.
const uploadDatasetFiles = upload.any();

// Pairs each uploaded file (req.files, from .any()) with its row's label
// from req.body, and resolves that label to a sanitized file_type. Rows
// with no matching file (label typed but nothing selected) are ignored.
// Returns [{ file, fileType, label }, ...] in submission order.
function pairFilesWithLabels(req) {
  return (req.files || [])
    .map((file) => {
      const m = FILE_FIELD_RE.exec(file.fieldname);
      if (!m) return null;
      const rawLabel = (req.body[`label_${m[1]}`] || '').trim();
      const fileType = sanitizeFileType(rawLabel || file.originalname);
      return { file, fileType, label: rawLabel || fileType };
    })
    .filter(Boolean);
}

// Moves every temp-staged file for this request into its permanent home:
// uploads/datasets/<accountId>/<sanitized dataset id>/<file type>/<name>.
// Call only after the database transaction that references these paths
// has committed successfully.
function finalizeDatasetUpload(req, accountId, datasetId, pairedFiles) {
  pairedFiles.forEach(({ file, fileType }) => {
    const typeDir = path.join(DATASETS_ROOT, String(accountId), sanitizeDatasetId(datasetId), fileType);
    fs.mkdirSync(typeDir, { recursive: true });
    fs.renameSync(file.path, path.join(typeDir, file.filename));
  });
  discardDatasetUpload(req); // removes the now-empty temp folder
}

// Deletes this request's temp-staged files entirely — used when the
// upload is rejected (validation error, duplicate dataset ID, CSV parse
// failure) so nothing already on disk for other datasets is ever touched.
function discardDatasetUpload(req) {
  if (!req._uploadTmpToken) return;
  fs.rmSync(path.join(TMP_ROOT, req._uploadTmpToken), { recursive: true, force: true });
}

module.exports = {
  uploadDatasetFiles,
  DATASETS_ROOT,
  TMP_ROOT,
  sanitizeDatasetId,
  sanitizeFileType,
  pairFilesWithLabels,
  finalizeDatasetUpload,
  discardDatasetUpload,
};
