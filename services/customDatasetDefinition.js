// "Define New Dataset" (added 6 October 2026, per Brenda's request).
//
// A Business Owner Evaluator / SME Owner-TAM Evaluator can define their own
// dataset structure — like opening a new sheet in Excel — instead of
// starting from one of the 20 industry templates. This module is the PURE
// part (no database): the locked core columns, the role vocabulary, and the
// validation/normalisation of what the owner submits.
//
// Why 6 locked core columns: the analytics modules infer what a file is
// from its column names (see services/mapping.js). A dataset with no
// identifier, date, customer and amount shows empty analytics pages — the
// same failure the Beauty template hit when its ID column was called
// record_id. The core columns use names the app is known to recognise as
// Transaction data, so a custom dataset always has what the analytics need.
//
// Why a REQUIRED role per column: the owner's own statement of what a
// column means (stored in eval_custom_dataset_columns) is ground truth for
// the semantic-role evaluation — better than two raters guessing from a
// name. The role vocabulary below is deliberately the SAME nine coarse
// roles (+ other) the semantic-role evaluation reports (see
// scripts/exportSemanticRoleEvaluation.js), so declared roles compare
// directly with CAAGA's predictions.

const CORE_COLUMNS = [
  { name: 'record_id', label: 'Record ID', role: 'Identifier', hint: 'A unique number or code for each row' },
  { name: 'transaction_date', label: 'Transaction date', role: 'Date/time', hint: 'When the sale or service happened (YYYY-MM-DD)' },
  { name: 'customer_id', label: 'Customer ID', role: 'Identifier', hint: 'Who bought — a name or code, the same for repeat customers' },
  { name: 'product_service_name', label: 'Product / service', role: 'Category', hint: 'What was sold' },
  { name: 'quantity', label: 'Quantity', role: 'Quantity', hint: 'How many units' },
  { name: 'revenue', label: 'Revenue (amount)', role: 'Monetary amount', hint: 'The money received for this row' },
];

// value is what is stored; label is what the owner sees. `help` is shown
// next to the dropdown so the choice is easy without technical knowledge.
const ROLE_OPTIONS = [
  { value: 'Identifier', label: 'Identifier (a code or ID)', input: 'text' },
  { value: 'Date/time', label: 'Date or time', input: 'date' },
  { value: 'Monetary amount', label: 'Money amount', input: 'number' },
  { value: 'Quantity', label: 'Quantity / count', input: 'number' },
  { value: 'Category', label: 'Category / type (repeated choices)', input: 'text' },
  { value: 'Rating', label: 'Rating / score', input: 'number' },
  { value: 'Geography', label: 'Place / location', input: 'text' },
  { value: 'Status', label: 'Status (e.g. paid, pending)', input: 'text' },
  { value: 'Free text', label: 'Free text / notes / names', input: 'text' },
  { value: 'other', label: 'Something else', input: 'text' },
];
const ROLE_VALUES = ROLE_OPTIONS.map((r) => r.value);

const MAX_EXTRA_COLUMNS = 24;
const MAX_NAME_LENGTH = 40;
const MAX_DATASET_NAME = 80;

// "Stylist Name" / "stylist-name" / " Stylist  name " → "stylist_name".
// The editor shows column keys with underscores turned back into spaces,
// so snake_case keys read naturally there.
function toColumnKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toDisplayLabel(key) {
  return String(key).replace(/_/g, ' ');
}

function inputTypeForRole(role) {
  const found = ROLE_OPTIONS.find((r) => r.value === role);
  return found ? found.input : 'text';
}

// input: { datasetName, extraColumns: [{ name, role }] } — whatever the
// form posted (already parsed). Returns { errors: [..], datasetName,
// columns: [{ name, role, isCore, position }] }; `columns` is only
// trustworthy when errors is empty.
function validateDefinition(input) {
  const errors = [];
  const datasetName = String((input && input.datasetName) || '').replace(/\s+/g, ' ').trim();
  if (!datasetName) errors.push('Give your dataset a name, for example "Salon sales 2026".');
  if (datasetName.length > MAX_DATASET_NAME) errors.push(`Dataset name must be ${MAX_DATASET_NAME} characters or fewer.`);

  const rawExtras = Array.isArray(input && input.extraColumns) ? input.extraColumns : [];
  // Blank rows (the owner added a row and never filled it) are ignored
  // rather than rejected.
  const extras = rawExtras
    .map((c) => ({ name: String((c && c.name) || '').trim(), role: String((c && c.role) || '').trim() }))
    .filter((c) => c.name !== '' || c.role !== '');

  if (extras.length > MAX_EXTRA_COLUMNS) {
    errors.push(`You can add up to ${MAX_EXTRA_COLUMNS} extra columns.`);
  }

  const taken = new Set(CORE_COLUMNS.map((c) => c.name));
  const columns = CORE_COLUMNS.map((c, i) => ({ name: c.name, role: c.role, isCore: true, position: i }));

  extras.slice(0, MAX_EXTRA_COLUMNS).forEach((c, idx) => {
    const rowNo = idx + 1;
    if (c.name === '') { errors.push(`Extra column ${rowNo}: type a column name.`); return; }
    if (c.name.length > MAX_NAME_LENGTH) { errors.push(`Extra column ${rowNo}: the name must be ${MAX_NAME_LENGTH} characters or fewer.`); return; }
    const key = toColumnKey(c.name);
    if (!key) { errors.push(`Extra column ${rowNo}: use letters or numbers in the name.`); return; }
    if (taken.has(key)) {
      errors.push(`Extra column ${rowNo}: "${c.name}" is already used (the six core columns count too).`);
      return;
    }
    if (!ROLE_VALUES.includes(c.role)) {
      errors.push(`Extra column ${rowNo} ("${c.name}"): choose what kind of information it holds.`);
      return;
    }
    taken.add(key);
    columns.push({ name: key, role: c.role, isCore: false, position: columns.length });
  });

  return { errors, datasetName, columns };
}

// One extra column added AFTER the dataset exists ("+ Add column" in the
// editor). existingNames: the dataset's current column keys. Same rules as
// validateDefinition(): safe snake_case key, no clash with any existing
// column (core or extra), a declared role, and the overall cap of six core
// + MAX_EXTRA_COLUMNS extra columns.
function validateNewColumn(rawName, rawRole, existingNames) {
  const name = String(rawName || '').trim();
  const role = String(rawRole || '').trim();
  const existing = new Set((existingNames || []).map((n) => String(n).toLowerCase()));
  if (name === '') return { error: 'Type a column name.' };
  if (name.length > MAX_NAME_LENGTH) return { error: `The name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  const key = toColumnKey(name);
  if (!key) return { error: 'Use letters or numbers in the name.' };
  if (existing.has(key)) return { error: `"${name}" is already a column in this dataset.` };
  if (!ROLE_VALUES.includes(role)) return { error: 'Choose what kind of information this column holds.' };
  if ((existingNames || []).length >= CORE_COLUMNS.length + MAX_EXTRA_COLUMNS) {
    return { error: `A dataset can have up to ${CORE_COLUMNS.length + MAX_EXTRA_COLUMNS} columns.` };
  }
  return { key, role };
}

module.exports = {
  validateNewColumn,
  CORE_COLUMNS, ROLE_OPTIONS, ROLE_VALUES, MAX_EXTRA_COLUMNS, MAX_NAME_LENGTH, MAX_DATASET_NAME,
  toColumnKey, toDisplayLabel, inputTypeForRole, validateDefinition,
};
