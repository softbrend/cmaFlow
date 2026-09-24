// The CMA data-mapping & transformation pipeline: turns the raw, JSONB
// rows an SME owner already uploaded (dataset_records — one CMA-neutral
// row per original CSV line, columns untouched) into the CMA Canonical
// Schema (canonical_records), following the same named stages as the CMA
// architecture diagrams:
//
//   Clean -> Normalize -> Transform -> Tag -> Enrich -> Validate -> Freeze
//
// Integrity guarantees this module is responsible for:
//   1. The raw layer (dataset_records) is only ever READ here, never
//      written or mutated — the original upload stays the permanent,
//      untouched source of truth.
//   2. Every canonical record keeps source_record_id (a hard FK to the
//      exact raw row it came from) plus the mapping_version that produced
//      it, so any canonical value can be traced back to the original CSV
//      cell and reproduced from the same confirmed mapping.
//   3. Nothing is silently dropped: a row that fails validation is still
//      frozen, just with status='invalid' and its reasons recorded, so
//      raw-row-count === valid-count + invalid-count always holds and the
//      SME owner can see and act on exactly what didn't make it across.
const { CANONICAL_ENTITIES } = require('../db/canonicalSchema');

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------
// Stage 1: Clean
// ---------------------------------------------------------------------
// Trims whitespace, treats blank/placeholder strings as absent, and
// strips common currency/thousands formatting so "$1,234.50" and 1234.5
// clean to the same thing later at the Normalize stage. Operates on a
// shallow copy of the raw row — the original `data` object (and the row
// in dataset_records it came from) is never touched.
const BLANK_VALUES = new Set(['', 'n/a', 'na', 'null', 'none', '-', '--']);

function cleanRow(rawData) {
  const cleaned = {};
  Object.entries(rawData || {}).forEach(([key, value]) => {
    if (value === null || value === undefined) {
      cleaned[key] = null;
      return;
    }
    const str = String(value).trim();
    cleaned[key] = BLANK_VALUES.has(str.toLowerCase()) ? null : str;
  });
  return cleaned;
}

// ---------------------------------------------------------------------
// Stage 2: Normalize
// ---------------------------------------------------------------------
// Converts a cleaned string value to the target canonical field's declared
// type (number | date | string). Returns null if the value is absent or
// cannot be normalized to that type — Validate (stage 6) is what turns an
// unparseable *required* field into a recorded error; this stage never
// throws, so one bad cell never aborts the whole pipeline run.
//
// dateFormat (optional) resolves the DD/MM vs MM/DD ambiguity for
// slash/dash numeric dates — see detectDateFormat() below. Without it,
// "01-08-2024" would silently parse as 8 Jan instead of 1 Aug for a
// day-first SME export, which is exactly the kind of silent corruption
// this pipeline exists to prevent.
const NUMERIC_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function normalizeToType(value, type, dateFormat) {
  if (value === null || value === undefined) return null;

  if (type === 'number') {
    const stripped = String(value).replace(/[^0-9.\-]/g, '');
    if (stripped === '' || stripped === '-') return null;
    const num = Number(stripped);
    return Number.isFinite(num) ? num : null;
  }

  if (type === 'date') {
    const str = String(value);
    const m = str.match(NUMERIC_DATE_RE);
    if (m && dateFormat === 'DMY') {
      const [, first, second, year, hh = '0', mm = '0', ss = '0'] = m;
      const parsed = new Date(Date.UTC(+year, +second - 1, +first, +hh, +mm, +ss));
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (m && dateFormat === 'MDY') {
      const [, first, second, year, hh = '0', mm = '0', ss = '0'] = m;
      const parsed = new Date(Date.UTC(+year, +first - 1, +second, +hh, +mm, +ss));
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // type === 'string' (default)
  return String(value);
}

// ---------------------------------------------------------------------
// Stage 2b: date-format detection (part of Normalize)
// ---------------------------------------------------------------------
// Numeric dates like "01-08-2024" are genuinely ambiguous per-value, but
// one SME dataset's own column is internally consistent — so this scans
// every sample value for that source column ONCE and looks for any value
// whose first or second token can only be a month (>12) to resolve the
// whole column's convention before any row is converted, rather than
// guessing per-row and risking a mix of interpretations in one dataset.
function detectDateFormat(sampleValues) {
  let sawFirstOver12 = false;
  let sawSecondOver12 = false;
  let sawNumericPattern = false;

  for (const raw of sampleValues) {
    if (raw === null || raw === undefined) continue;
    const m = String(raw).match(NUMERIC_DATE_RE);
    if (!m) continue;
    sawNumericPattern = true;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12) sawFirstOver12 = true;
    if (second > 12) sawSecondOver12 = true;
    // Found unambiguous evidence in both directions is a contradiction —
    // keep scanning, but DMY evidence (first > 12) is treated as
    // authoritative below since it's the format this dataset actually uses.
  }

  if (!sawNumericPattern) return null;       // ISO or textual dates — no ambiguity to resolve
  if (sawFirstOver12) return 'DMY';          // day-first confirmed
  if (sawSecondOver12) return 'MDY';         // month-first confirmed
  return 'MDY';                              // ambiguous (all values <=12) — falls back to the JS-native assumption
}

// ---------------------------------------------------------------------
// Stage 3: Transform
// ---------------------------------------------------------------------
// Applies the SME owner's confirmed field_map (source column -> canonical
// field) to a cleaned raw row, normalizing each value to its canonical
// field's type. Falls back to a declared derivation formula (currently
// only Transaction.amount = quantity * unit_price) when no source column
// was mapped directly and the pipeline was fed a mappable set of
// synonyms — this is exactly the "amount (calculated from usage x price)"
// case from the AWS pricing datasets.
function transformRow(cleanedRow, entitySpec, fieldMap, dateFormats = {}) {
  const canonical = {};

  Object.entries(entitySpec.fields).forEach(([fieldKey, fieldSpec]) => {
    const mapping = fieldMap[fieldKey] || {};
    const rawValue = mapping.source ? cleanedRow[mapping.source] : null;
    canonical[fieldKey] = normalizeToType(rawValue, fieldSpec.type, dateFormats[fieldKey]);
  });

  // Derived fields: only fill in what direct mapping left null.
  Object.entries(entitySpec.fields).forEach(([fieldKey, fieldSpec]) => {
    if (canonical[fieldKey] !== null) return;
    if (!fieldSpec.derivable) return;
    const { from, op } = fieldSpec.derivable;
    const operands = from.map((f) => canonical[f]);
    if (operands.some((v) => v === null || v === undefined)) return;
    if (op === 'multiply') canonical[fieldKey] = operands.reduce((a, b) => a * b, 1);
  });

  return canonical;
}

// ---------------------------------------------------------------------
// Stage 4: Tag
// ---------------------------------------------------------------------
// Attaches lineage/context metadata alongside the canonical fields so it
// travels with the record wherever it's viewed (Browse Dataset, exports,
// etc), not just in separate database columns. This is what lets an SME
// owner (or Brenda's downstream analytics) see at a glance which raw row,
// dataset, and confirmed mapping version a canonical value came from.
function tagRecord(canonicalFields, { datasetRowId, rowIndex, fileType, entity, mappingVersion }) {
  return {
    ...canonicalFields,
    _lineage: {
      dataset_id: datasetRowId,
      file_type: fileType,
      entity,
      source_row_index: rowIndex,
      mapping_version: mappingVersion,
    },
  };
}

// ---------------------------------------------------------------------
// Stage 5: Enrich
// ---------------------------------------------------------------------
// Fills in canonical fields that are reasonably defaultable rather than
// truly missing — kept intentionally small and conservative so Enrich
// never invents business-meaningful data, only fills gaps a reasonable
// analyst would also fill (e.g. assuming USD when a monetary amount is
// present but no currency column existed anywhere in the source file).
function enrichRecord(canonicalFields, entitySpec) {
  const enriched = { ...canonicalFields };
  const hasCurrencyField = 'currency' in entitySpec.fields;
  const monetaryValue = enriched.amount ?? enriched.price ?? null;
  if (hasCurrencyField && enriched.currency === null && monetaryValue !== null) {
    enriched.currency = 'USD';
  }
  return enriched;
}

// ---------------------------------------------------------------------
// Stage 6: Validate
// ---------------------------------------------------------------------
// Required-field presence + basic type sanity. Returns a list of
// human-readable error strings; an empty list means the record is valid.
// Rows that fail are still frozen (see runTransformPipeline) with
// status='invalid' and these reasons attached — never silently discarded.
function validateRecord(canonicalFields, entitySpec) {
  const errors = [];
  Object.entries(entitySpec.fields).forEach(([fieldKey, fieldSpec]) => {
    const value = canonicalFields[fieldKey];
    if (fieldSpec.required && (value === null || value === undefined || value === '')) {
      errors.push(`Missing required field "${fieldKey}" (expected from a mapped column${
        fieldSpec.derivable ? ' or a derivable formula' : ''}).`);
      return;
    }
    if (value !== null && fieldSpec.type === 'number' && typeof value !== 'number') {
      errors.push(`Field "${fieldKey}" could not be read as a number.`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------
// Stage 7: Freeze
// ---------------------------------------------------------------------
// Batched insert into canonical_records — an append-only table; re-running
// the pipeline (e.g. after editing the mapping) creates a new
// mapping_version and a new batch of rows rather than overwriting the old
// ones, so every prior frozen batch stays intact and auditable.
async function freezeRecords(client, rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((r, i) => {
      const base = i * 9;
      values.push(
        r.datasetRowId, r.accountId, r.entity, r.fileType, r.sourceRecordId,
        r.mappingVersion, JSON.stringify(r.data), r.status, JSON.stringify(r.validationErrors || [])
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}::jsonb)`;
    });

    await client.query(
      `INSERT INTO canonical_records
         (dataset_id, account_id, entity, file_type, source_record_id, mapping_version, data, status, validation_errors)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }
}

// ---------------------------------------------------------------------
// Orchestrator: runs all seven stages over every raw row of one uploaded
// file (one dataset_id + file_type), then freezes the results. This is
// the single entry point routes/dashboard.js calls once the SME owner has
// reviewed and confirmed a mapping.
//
// Reconciliation is the caller's integrity check: total === valid +
// invalid must always hold, since Freeze writes every row it was given,
// never a subset — the return value makes that easy for the calling route
// to assert and display.
//
// entity is now an explicit, required parameter rather than something
// derived from fileType — the caller (routes/dashboard.js) is responsible
// for obtaining it from the SME owner's own choice on the Map & Transform
// screen, since a file's free-form label never determines its canonical
// entity on its own.
async function runTransformPipeline(client, { datasetRowId, accountId, fileType, entity, fieldMap, mappingVersion }) {
  const entitySpec = CANONICAL_ENTITIES[entity];
  if (!entity || !entitySpec) throw new Error(`Unknown canonical entity "${entity}".`);

  const { rows: rawRows } = await client.query(
    `SELECT id, row_index, data FROM dataset_records
      WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
      ORDER BY row_index`,
    [datasetRowId, accountId, fileType]
  );

  // Resolve each mapped date field's DD/MM vs MM/DD convention ONCE up
  // front, from every raw value in that source column across the whole
  // file, so every row is interpreted the same consistent way (part of
  // Normalize — see detectDateFormat()).
  const dateFormats = {};
  Object.entries(entitySpec.fields).forEach(([fieldKey, fieldSpec]) => {
    if (fieldSpec.type !== 'date') return;
    const source = fieldMap[fieldKey] && fieldMap[fieldKey].source;
    if (!source) return;
    const samples = rawRows.map((r) => r.data[source]);
    const detected = detectDateFormat(samples);
    if (detected) dateFormats[fieldKey] = detected;
  });

  const frozenRows = rawRows.map((raw) => {
    const cleaned = cleanRow(raw.data);                                            // 1. Clean
    const transformed = transformRow(cleaned, entitySpec, fieldMap, dateFormats);   // 2 (Normalize is inside) + 3. Transform
    const tagged = tagRecord(transformed, {                          // 4. Tag
      datasetRowId, rowIndex: raw.row_index, fileType, entity, mappingVersion,
    });
    const enriched = enrichRecord(tagged, entitySpec);                // 5. Enrich
    const errors = validateRecord(enriched, entitySpec);              // 6. Validate

    return {
      datasetRowId, accountId, entity, fileType, sourceRecordId: raw.id, mappingVersion,
      data: enriched,
      status: errors.length ? 'invalid' : 'valid',
      validationErrors: errors,
    };
  });

  await freezeRecords(client, frozenRows);                            // 7. Freeze

  const invalid = frozenRows.filter((r) => r.status === 'invalid').length;
  return { total: frozenRows.length, valid: frozenRows.length - invalid, invalid };
}

module.exports = {
  cleanRow,
  normalizeToType,
  detectDateFormat,
  transformRow,
  tagRecord,
  enrichRecord,
  validateRecord,
  freezeRecords,
  runTransformPipeline,
  CANONICAL_ENTITIES,
};
