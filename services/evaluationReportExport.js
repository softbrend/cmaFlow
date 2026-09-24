// Evaluation Report -> multi-sheet .xlsx export. Mirrors the source
// notebook's own Cell 29 export (one sheet per section: profiling,
// monetization field evidence, KPIs, suitability, and each revenue
// breakdown) so a researcher gets the same artifact out of CMA-Flow that
// the notebook produced, without re-running any Python.
//
// Takes the SAME report object services/evaluationReport.js already
// built for the on-screen view (routes/dashboard.js computes it once per
// request and passes it in here) rather than recomputing anything.
const ExcelJS = require('exceljs');

function addTable(sheet, headers, rows) {
  sheet.addRow(headers).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));
  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value === null || cell.value === undefined ? 0 : String(cell.value).length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 60);
  });
}

function round(value, dp = 2) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(dp));
}

async function buildEvaluationReportWorkbook(report, { datasetName, fileType, label }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CMA-Flow';
  workbook.created = new Date();

  // --- Summary (added first so it's the sheet that opens by default) ---
  const summarySheet = workbook.addWorksheet('Summary');
  addTable(summarySheet, ['Field', 'Value'], [
    ['Dataset', datasetName],
    ['File', `${label} (${fileType})`],
    ['Rows evaluated', report.rowCount],
    ['Duplicate rows', report.duplicateCount],
    ['Duplicate %', round(report.duplicatePct, 2)],
    ['Generated', new Date().toISOString()],
  ]);

  // --- Data_Profile ---
  const profileSheet = workbook.addWorksheet('Data_Profile');
  addTable(
    profileSheet,
    ['Column', 'Data type', 'Non-null', 'Missing', 'Missing %', 'Unique values'],
    report.profile.map((p) => [p.column, p.dataType, p.nonNull, p.missing, round(p.missingPct), p.unique])
  );

  // --- Numeric_Stats (descriptive stats + outliers) ---
  const statsSheet = workbook.addWorksheet('Numeric_Stats');
  const outlierByCol = new Map(report.outliers.map((o) => [o.column, o.count]));
  addTable(
    statsSheet,
    ['Column', 'Count', 'Missing', 'Mean', 'Std', 'Min', 'P25', 'Median', 'P75', 'Max', 'Variance', 'Skewness', 'IQR outliers'],
    report.describe.map((d) => [
      d.column, d.count, d.missing, round(d.mean), round(d.std), round(d.min), round(d.p25),
      round(d.median), round(d.p75), round(d.max), round(d.variance), round(d.skewness, 3),
      outlierByCol.get(d.column) || 0,
    ])
  );

  // --- Monetization_Discovery (field-evidence findings — see the
  // module comment in services/evaluationReport.js for why this is
  // named "field evidence," not the app's behavioral discovery engine) ---
  const monetizationSheet = workbook.addWorksheet('Monetization_Discovery');
  addTable(
    monetizationSheet,
    ['Mechanism', 'Classification', 'Evidence (columns/signals)'],
    report.monetizationFindings.map((f) => [f.mechanism, f.classification, f.evidence.join(', ')])
  );

  // --- Suitability ---
  const suitabilitySheet = workbook.addWorksheet('Suitability');
  addTable(
    suitabilitySheet,
    ['Check', 'Passed'],
    report.suitability.checks.map((c) => [c.label, c.pass ? 'Yes' : 'No'])
  );
  suitabilitySheet.addRow([]);
  suitabilitySheet.addRow(['Overall readiness score (%)', round(report.suitability.score, 1)]);

  // --- KPIs ---
  const kpiSheet = workbook.addWorksheet('KPIs');
  const k = report.kpis;
  addTable(kpiSheet, ['Metric', 'Value'], [
    ['Records', k.records],
    ['Unique customers', k.uniqueCustomers ?? 'Not detected'],
    ['Total revenue', k.totalRevenue !== undefined ? round(k.totalRevenue) : 'Not detected'],
    ['Average revenue / record', k.averageRevenue !== undefined ? round(k.averageRevenue) : 'Not detected'],
    ['Median revenue / record', k.medianRevenue !== undefined ? round(k.medianRevenue) : 'Not detected'],
    ['ARPU', k.arpu !== undefined ? round(k.arpu) : 'Not detected'],
    ['MRR', report.mrrArr && report.mrrArr.mrr !== null ? round(report.mrrArr.mrr) : 'Not detected'],
    ['ARR', report.mrrArr ? round(report.mrrArr.arr) : 'Not detected'],
    ['Churn rate (%)', report.churn ? round(report.churn.rate, 1) : 'Not detected'],
  ]);

  // --- Revenue_by_Customer / _Product / _Mechanism / _Period ---
  if (report.revenueByCustomer) {
    const s = workbook.addWorksheet('Revenue_by_Customer');
    addTable(s, ['Customer', 'Revenue'], report.revenueByCustomer.map((r) => [r.label, round(r.value)]));
  }
  if (report.revenueByProduct) {
    const s = workbook.addWorksheet('Revenue_by_Product');
    addTable(s, ['Product / service', 'Revenue'], report.revenueByProduct.map((r) => [r.label, round(r.value)]));
  }
  if (report.revenueByMechanism) {
    const s = workbook.addWorksheet('Revenue_by_Mechanism');
    addTable(s, ['Mechanism', 'Revenue'], report.revenueByMechanism.map((r) => [r.label, round(r.value)]));
  }
  if (report.byPeriod) {
    const s = workbook.addWorksheet('Revenue_by_Period');
    addTable(s, ['Month', 'Revenue'], report.byPeriod.map((r) => [r.label, round(r.value)]));
  }
  if (report.growth) {
    const s = workbook.addWorksheet('Customer_Growth');
    addTable(s, ['Month', 'New customers'], report.growth.trend.map((r) => [r.label, r.value]));
  }
  if (report.correlation) {
    const s = workbook.addWorksheet('Correlation');
    addTable(
      s,
      ['', ...report.correlation.columns],
      report.correlation.matrix.map((row, i) => [report.correlation.columns[i], ...row.map((v) => round(v, 3))])
    );
  }

  workbook.worksheets.forEach((ws) => { ws.views = [{ state: 'frozen', ySplit: 1 }]; });

  return workbook;
}

module.exports = { buildEvaluationReportWorkbook };
