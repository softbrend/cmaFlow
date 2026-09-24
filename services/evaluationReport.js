// Evaluation Report — Browse Dataset's per-file data-quality and
// monetization-readiness pass, ported from the SME researcher's own
// pandas/Jupyter workflow (column normalization -> field detection ->
// profiling -> outliers -> monetization field evidence -> suitability
// score -> KPIs -> revenue breakdowns -> MRR/ARR/churn/growth ->
// correlation) so it runs the same way, over the same raw file, directly
// inside CMA-Flow — no notebook required.
//
// This runs on ONE raw file's rows (dataset_records — BEFORE Map &
// Transform touches anything), the same place Browse Dataset already
// reads from. It never assumes the file is Transaction-shaped: every
// downstream section degrades to an explicit "not detected" rather than
// guessing when a field this file needs isn't present, exactly like the
// source notebook's own `if column: ... else: print("not detected")`
// pattern.
//
// IMPORTANT — this is a DIFFERENT kind of "monetization discovery" than
// services/monetizationDiscovery.js's behavioral engine (which infers a
// mechanism from actual customer transaction/entitlement PATTERNS, per
// the CMA architecture's core "don't just ask/don't just read a label"
// principle). This report's monetization section only checks which
// monetization-SHAPED COLUMNS exist in the raw file at all (e.g. does an
// "mrr_amount" or "api_calls" column exist) — structural evidence a
// relevant field is present, not a classification of behavior. It is
// deliberately labeled "Monetization field evidence" everywhere in the
// UI (never "Monetization Discovery Engine") to keep that distinction
// clear, and every finding says so explicitly.

const {
  normalizeColumnName, parseNumericLoose, parseDateLoose, quantile, mean,
  sampleVarianceAndSkew, histogramBuckets, monthKeyFrom, monthLabelFrom,
} = require('./statsUtils');

// Renames every raw column to its normalized form, de-duplicating any
// collisions (two originals normalizing to the same name) with a
// numbered suffix rather than silently dropping one — pandas would let
// duplicate column names stand, which this app's plain-object row shape
// can't represent, so this is a deliberate, visible deviation.
function buildColumnRename(originalColumns) {
  const seen = {};
  const mapping = []; // [{ original, normalized }]
  const originalByNormalized = {};

  originalColumns.forEach((original) => {
    let normalized = normalizeColumnName(original) || 'column';
    if (seen[normalized]) {
      seen[normalized] += 1;
      normalized = `${normalized}_${seen[normalized]}`;
    } else {
      seen[normalized] = 1;
    }
    mapping.push({ original, normalized });
    originalByNormalized[normalized] = original;
  });

  return { mapping, originalByNormalized };
}

// Re-keys every row from its original raw headers to normalized names,
// so every downstream function only ever deals with normalized column
// names — matching the source notebook's `df.columns = [...]` rename.
function renameRows(rows, originalByNormalized) {
  const normalizedNames = Object.keys(originalByNormalized);
  return rows.map((row) => {
    const out = {};
    normalizedNames.forEach((norm) => {
      out[norm] = row[originalByNormalized[norm]];
    });
    return out;
  });
}

// ------------------------------------------------------------------
// Field dictionary — heuristic aliases that help this report discover
// the semantic role of each normalized column. Ported directly.
// ------------------------------------------------------------------
const FIELD_ALIASES = {
  customer: ['customer_id', 'customer', 'user_id', 'userid', 'account_id', 'subscriber_id', 'client_id', 'member_id', 'buyer_id'],
  transaction: ['transaction_id', 'order_id', 'purchase_id', 'payment_id', 'invoice_id', 'event_id'],
  product: ['product_id', 'product', 'product_name', 'item_id', 'item', 'sku'],
  service: ['service', 'service_name', 'service_id', 'feature_name', 'resource_type', 'product_family'],
  amount: ['amount', 'revenue', 'sales', 'total', 'payment_value', 'price', 'cost', 'in_app_purchase_amount', 'mrr_amount', 'arr_amount'],
  price: ['price', 'unit_price', 'price_per_unit', 'effective_price', 'rate'],
  quantity: ['quantity', 'qty', 'usage_amount', 'usage_count', 'units', 'seats'],
  date: ['date', 'transaction_date', 'purchase_date', 'order_date', 'timestamp', 'ts', 'usage_date', 'start_date', 'signup_date', 'last_purchase_date'],
  subscription: ['subscription_id', 'plan', 'plan_tier', 'billing_frequency', 'mrr_amount', 'arr_amount', 'auto_renew_flag'],
  usage: ['usage', 'usage_amount', 'usage_count', 'usage_duration', 'usage_duration_secs', 'requests', 'tokens', 'hours', 'storage', 'bandwidth'],
  trial: ['is_trial', 'trial', 'trial_flag', 'trial_status'],
  churn: ['churn', 'churn_flag', 'churn_date', 'cancelled', 'canceled', 'cancellation_date'],
  mechanism: ['mechanism', 'mechanism_type', 'monetization_type', 'pricing_model'],
  tier: ['tier', 'plan_tier', 'spending_segment', 'customer_segment'],
  status: ['status', 'transaction_status', 'order_status', 'subscription_status'],
};

// Exact / prefix / suffix alias matching against already-normalized
// column names — deliberately simpler than services/mapping.js's scored
// synonym matching (this report's own alias list is more general-purpose
// than the four canonical entities), ported as specified.
function findColumns(normalizedColumns, aliases) {
  const matches = [];
  normalizedColumns.forEach((col) => {
    for (let i = 0; i < aliases.length; i += 1) {
      const a = aliases[i];
      if (col === a || col.startsWith(`${a}_`) || col.endsWith(`_${a}`)) {
        matches.push(col);
        break;
      }
    }
  });
  return [...new Set(matches)];
}

function detectFields(normalizedColumns) {
  const detected = {};
  Object.entries(FIELD_ALIASES).forEach(([fieldType, aliases]) => {
    detected[fieldType] = findColumns(normalizedColumns, aliases);
  });
  return detected;
}

// Column-type inference (no pandas dtype system to lean on): a column is
// "date" when its name looks date-ish AND at least 60% of its non-empty
// values parse as real dates (same threshold as the source notebook's
// Cell 6); "number" when every non-empty value parses as numeric;
// otherwise "string" — mirroring pandas' object/int64/float64/datetime64
// distinction closely enough for a profiling report, not byte-for-byte.
const DATE_NAME_HINTS = ['date', 'time', 'timestamp', 'created', 'start', 'end'];

function inferColumnType(normalizedName, values) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (nonEmpty.length === 0) return 'string';

  const looksDateNamed = DATE_NAME_HINTS.some((hint) => normalizedName.includes(hint));
  if (looksDateNamed) {
    const validDates = nonEmpty.filter((v) => parseDateLoose(v) !== null).length;
    if (validDates / nonEmpty.length >= 0.6) return 'date';
  }

  const allNumeric = nonEmpty.every((v) => parseNumericLoose(v) !== null);
  if (allNumeric) return 'number';

  return 'string';
}

// ------------------------------------------------------------------
// Data profiling — one row per column: inferred type, non-null/missing
// counts, missing %, and distinct-value count.
// ------------------------------------------------------------------
function profileColumns(rows, normalizedColumns, columnTypes) {
  return normalizedColumns.map((col) => {
    const values = rows.map((r) => r[col]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    const missing = rows.length - nonNull.length;
    const distinct = new Set(nonNull.map((v) => String(v).trim())).size;
    return {
      column: col,
      dataType: columnTypes[col],
      nonNull: nonNull.length,
      missing,
      missingPct: rows.length ? (missing / rows.length) * 100 : 0,
      unique: distinct,
    };
  });
}

function countDuplicateRows(rows, normalizedColumns) {
  const seen = new Set();
  let duplicates = 0;
  rows.forEach((row) => {
    const key = normalizedColumns.map((c) => String(row[c] === undefined ? '' : row[c])).join('');
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  });
  return duplicates;
}

// ------------------------------------------------------------------
// Numeric descriptive statistics + IQR outlier counts.
// ------------------------------------------------------------------
function numericDescribe(rows, numericColumns) {
  return numericColumns.map((col) => {
    const values = rows
      .map((r) => parseNumericLoose(r[col]))
      .filter((v) => v !== null);
    const sorted = [...values].sort((a, b) => a - b);
    const { variance, std, skewness } = sampleVarianceAndSkew(values);
    const missing = rows.length - values.length;
    return {
      column: col,
      count: values.length,
      missing,
      mean: mean(values),
      std,
      min: sorted.length ? sorted[0] : null,
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      max: sorted.length ? sorted[sorted.length - 1] : null,
      variance,
      skewness,
    };
  });
}

function detectOutliersIQR(values) {
  const clean = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (clean.length < 4) return 0;
  const q1 = quantile(clean, 0.25);
  const q3 = quantile(clean, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return 0;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return clean.filter((v) => v < lower || v > upper).length;
}

// ------------------------------------------------------------------
// Monetization FIELD EVIDENCE — structural (column-name) evidence only.
// See the module comment above for why this is deliberately distinct
// from services/monetizationDiscovery.js's behavioral engine.
// ------------------------------------------------------------------
function monetizationFieldEvidence(rows, normalizedColumnsSet) {
  const findings = [];
  const has = (name) => normalizedColumnsSet.has(name);

  const subscriptionKeywords = ['subscription_id', 'billing_frequency', 'mrr_amount', 'arr_amount', 'auto_renew_flag', 'plan_tier'];
  const subscriptionEvidence = subscriptionKeywords.filter(has);
  if (subscriptionEvidence.length > 0) {
    findings.push({
      mechanism: 'Subscription',
      evidence: subscriptionEvidence,
      classification: subscriptionEvidence.length >= 2 ? 'Strong evidence' : 'Possible evidence',
    });
  }

  const usageKeywords = ['usage_amount', 'usage_count', 'usage_duration_secs', 'price_per_unit', 'unit_price', 'usage_type', 'unit'];
  const usageEvidence = usageKeywords.filter(has);
  if (has('in_app_purchase_amount')) usageEvidence.push('in_app_purchase_amount');
  if (usageEvidence.length > 0) {
    findings.push({
      mechanism: 'Pay-per-Use',
      evidence: usageEvidence,
      classification: usageEvidence.length >= 2 ? 'Strong evidence' : 'Possible evidence',
    });
  }

  const freemiumEvidence = [];
  if (has('is_trial')) freemiumEvidence.push('is_trial');
  if (has('trial_flag')) freemiumEvidence.push('trial_flag');
  if (has('price')) {
    const anyZeroPriced = rows.some((r) => parseNumericLoose(r.price) === 0);
    if (anyZeroPriced) freemiumEvidence.push('zero-priced records (free offering evidence only)');
  }
  if (freemiumEvidence.length > 0) {
    findings.push({ mechanism: 'Freemium', evidence: freemiumEvidence, classification: 'Candidate — requires validation' });
  }

  const daasKeywords = ['api_calls', 'api_requests', 'data_downloads', 'data_volume', 'dataset_access', 'data_access', 'query_count'];
  const daasEvidence = daasKeywords.filter(has);
  if (daasEvidence.length > 0) {
    findings.push({ mechanism: 'Data-as-a-Service', evidence: daasEvidence, classification: 'Possible evidence' });
  }

  if (findings.length === 0) {
    findings.push({
      mechanism: 'No mechanism confidently detected',
      evidence: ['Dataset does not contain sufficient explicit monetization fields.'],
      classification: 'Requires SME/researcher validation',
    });
  }

  return findings;
}

// ------------------------------------------------------------------
// Primary field selection, suitability score, KPIs, revenue breakdowns,
// MRR/ARR, churn, and customer growth — ported section by section.
// ------------------------------------------------------------------
const REVENUE_PRIORITY = ['revenue', 'amount', 'payment_value', 'in_app_purchase_amount', 'sales', 'total_amount', 'mrr_amount', 'cost', 'price'];

function selectPrimaryFields(detected, normalizedColumnsSet) {
  const first = (list) => (list && list.length ? list[0] : null);
  const customerCol = first(detected.customer);
  const productCol = first(detected.product) || first(detected.service);
  const mechanismCol = first(detected.mechanism);
  const dateCol = first(detected.date);
  const revenueCol = REVENUE_PRIORITY.find((c) => normalizedColumnsSet.has(c)) || null;
  return {
    customerCol, productCol, mechanismCol, dateCol, revenueCol,
  };
}

function groupSumTop(rows, groupCol, revenueCol) {
  const totals = {};
  rows.forEach((r) => {
    const label = String(r[groupCol] === undefined || r[groupCol] === null || r[groupCol] === '' ? 'Unspecified' : r[groupCol]).trim() || 'Unspecified';
    const amount = parseNumericLoose(r[revenueCol]) || 0;
    totals[label] = (totals[label] || 0) + amount;
  });
  return Object.entries(totals)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function revenueByPeriod(rows, dateCol, revenueCol) {
  const totals = {};
  rows.forEach((r) => {
    const d = parseDateLoose(r[dateCol]);
    const amount = parseNumericLoose(r[revenueCol]);
    if (!d || amount === null) return;
    const key = monthKeyFrom(d);
    totals[key] = (totals[key] || 0) + amount;
  });
  return Object.keys(totals).sort().map((key) => ({ key, label: monthLabelFrom(key), value: totals[key] }));
}

function mrrArr(rows, normalizedColumnsSet) {
  if (normalizedColumnsSet.has('mrr_amount')) {
    const mrr = rows.reduce((s, r) => s + (parseNumericLoose(r.mrr_amount) || 0), 0);
    return { mrr, arr: mrr * 12, source: 'mrr_amount × 12' };
  }
  if (normalizedColumnsSet.has('arr_amount')) {
    const arr = rows.reduce((s, r) => s + (parseNumericLoose(r.arr_amount) || 0), 0);
    return { mrr: null, arr, source: 'arr_amount (direct)' };
  }
  return null;
}

const CHURN_VALUES = new Set(['true', '1', 'yes', 'churned', 'cancelled', 'canceled']);
function churnRate(rows, churnCol) {
  if (!churnCol) return null;
  const values = rows.map((r) => String(r[churnCol] === undefined || r[churnCol] === null ? '' : r[churnCol]).trim().toLowerCase());
  const churned = values.filter((v) => CHURN_VALUES.has(v)).length;
  return { column: churnCol, rate: rows.length ? (churned / rows.length) * 100 : 0 };
}

function customerGrowth(rows, customerCol, normalizedColumns) {
  if (!customerCol) return null;
  const signupCol = normalizedColumns.find((c) => c.includes('signup') || c.includes('registration') || c.includes('created'));
  if (!signupCol) return null;

  const byMonth = {};
  rows.forEach((r) => {
    const d = parseDateLoose(r[signupCol]);
    const cust = r[customerCol];
    if (!d || !cust) return;
    const key = monthKeyFrom(d);
    byMonth[key] = byMonth[key] || new Set();
    byMonth[key].add(String(cust));
  });
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) return null;
  return {
    column: signupCol,
    trend: months.map((key) => ({ key, label: monthLabelFrom(key), value: byMonth[key].size })),
  };
}

// Pearson correlation matrix across numeric columns, computed pairwise
// over rows where BOTH columns have a value (not just rows complete
// across every numeric column at once).
function correlationMatrix(rows, numericColumns) {
  if (numericColumns.length < 2) return null;
  const series = {};
  numericColumns.forEach((col) => {
    series[col] = rows.map((r) => parseNumericLoose(r[col]));
  });

  const matrix = numericColumns.map((colA) => numericColumns.map((colB) => {
    const pairs = [];
    for (let i = 0; i < rows.length; i += 1) {
      const a = series[colA][i];
      const b = series[colB][i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    if (pairs.length < 2) return null;
    const meanA = mean(pairs.map((p) => p[0]));
    const meanB = mean(pairs.map((p) => p[1]));
    let num = 0;
    let denomA = 0;
    let denomB = 0;
    pairs.forEach(([a, b]) => {
      num += (a - meanA) * (b - meanB);
      denomA += (a - meanA) ** 2;
      denomB += (b - meanB) ** 2;
    });
    if (denomA === 0 || denomB === 0) return null;
    return num / Math.sqrt(denomA * denomB);
  }));

  return { columns: numericColumns, matrix };
}

// ------------------------------------------------------------------
// Suitability / readiness score — a transparent field-availability
// checklist, explicitly NOT a claim of statistical/scientific validity
// (same caveat the source notebook prints).
// ------------------------------------------------------------------
function suitabilityChecks(primary, monetizationFindings, rowCount) {
  const checks = [
    { label: 'Customer identifier detected', pass: !!primary.customerCol },
    { label: 'Revenue/amount field detected', pass: !!primary.revenueCol },
    { label: 'Date field detected', pass: !!primary.dateCol },
    { label: 'Product/service field detected', pass: !!primary.productCol },
    {
      label: 'Monetization field evidence detected',
      pass: !(monetizationFindings.length === 1 && monetizationFindings[0].mechanism === 'No mechanism confidently detected'),
    },
    { label: 'Dataset contains records', pass: rowCount > 0 },
  ];
  const score = (checks.filter((c) => c.pass).length / checks.length) * 100;
  return { checks, score };
}

// ------------------------------------------------------------------
// Main entry point.
// ------------------------------------------------------------------
function buildEvaluationReport(originalColumns, rawRows) {
  const { mapping, originalByNormalized } = buildColumnRename(originalColumns);
  const normalizedColumns = Object.keys(originalByNormalized);
  const normalizedColumnsSet = new Set(normalizedColumns);
  const rows = renameRows(rawRows, originalByNormalized);

  const columnTypes = {};
  normalizedColumns.forEach((col) => {
    columnTypes[col] = inferColumnType(col, rows.map((r) => r[col]));
  });

  const detected = detectFields(normalizedColumns);
  // Fold in name+parse-rate date detection (Cell 6) for any date-shaped
  // column the alias list alone didn't catch.
  const dateColumns = new Set(detected.date);
  normalizedColumns.forEach((col) => {
    if (columnTypes[col] === 'date') dateColumns.add(col);
  });
  detected.date = [...dateColumns];

  const profile = profileColumns(rows, normalizedColumns, columnTypes);
  const duplicateCount = countDuplicateRows(rows, normalizedColumns);

  const numericColumns = normalizedColumns.filter((c) => columnTypes[c] === 'number');
  const describe = numericDescribe(rows, numericColumns);
  const outliers = numericColumns.map((col) => ({
    column: col,
    count: detectOutliersIQR(rows.map((r) => parseNumericLoose(r[col]))),
  })).filter((o) => o.count > 0);

  const monetizationFindings = monetizationFieldEvidence(rows, normalizedColumnsSet);
  const primary = selectPrimaryFields(detected, normalizedColumnsSet);
  const suitability = suitabilityChecks(primary, monetizationFindings, rows.length);

  const kpis = { records: rows.length };
  if (primary.customerCol) {
    kpis.uniqueCustomers = new Set(rows.map((r) => r[primary.customerCol]).filter((v) => v !== null && v !== undefined && v !== '')).size;
  }
  let revenueByCustomer = null;
  let revenueByProduct = null;
  let revenueByMechanism = null;
  let byPeriod = null;
  let histogram = null;
  if (primary.revenueCol) {
    const revenueValues = rows.map((r) => parseNumericLoose(r[primary.revenueCol])).filter((v) => v !== null);
    kpis.totalRevenue = revenueValues.reduce((s, v) => s + v, 0);
    kpis.averageRevenue = mean(revenueValues);
    const sortedRev = [...revenueValues].sort((a, b) => a - b);
    kpis.medianRevenue = quantile(sortedRev, 0.5);
    if (primary.customerCol && kpis.uniqueCustomers > 0) {
      kpis.arpu = kpis.totalRevenue / kpis.uniqueCustomers;
    }
    if (primary.customerCol) revenueByCustomer = groupSumTop(rows, primary.customerCol, primary.revenueCol);
    if (primary.productCol) revenueByProduct = groupSumTop(rows, primary.productCol, primary.revenueCol);
    if (primary.mechanismCol) revenueByMechanism = groupSumTop(rows, primary.mechanismCol, primary.revenueCol);
    if (primary.dateCol) byPeriod = revenueByPeriod(rows, primary.dateCol, primary.revenueCol);
    histogram = histogramBuckets(revenueValues);
  }

  const mrrArrResult = mrrArr(rows, normalizedColumnsSet);
  const churnResult = churnRate(rows, detected.churn[0] || null);
  const growthResult = customerGrowth(rows, primary.customerCol, normalizedColumns);
  const correlation = correlationMatrix(rows, numericColumns);

  return {
    columnMapping: mapping,
    normalizedColumns,
    rowCount: rows.length,
    profile,
    duplicateCount,
    duplicatePct: rows.length ? (duplicateCount / rows.length) * 100 : 0,
    numericColumns,
    describe,
    outliers,
    detectedFields: detected,
    monetizationFindings,
    primary,
    suitability,
    kpis,
    revenueByCustomer,
    revenueByProduct,
    revenueByMechanism,
    byPeriod,
    histogram,
    mrrArr: mrrArrResult,
    churn: churnResult,
    growth: growthResult,
    correlation,
  };
}

module.exports = {
  buildEvaluationReport,
  normalizeColumnName,
};
