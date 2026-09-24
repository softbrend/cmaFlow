// Dataset-level financial & business-domain classification — the answer
// to "before any revenue number is trusted, what KIND of dataset is
// this?" A GCP Cloud Billing export and an Olist e-commerce export can
// both hand CMA-FLOW a numeric column named "amount" sitting next to a
// date, but one records money this organization's OWN customers paid IN
// and the other records money this organization itself paid OUT to a
// cloud vendor. Treating both as "revenue" would be exactly the failure
// mode this module exists to prevent.
//
// By the time this runs, services/businessSemantics.js has already done
// the hard work: its 'revenue' rule excludes cost/expenditure/billing/
// spend-named columns outright, and its reclassifyAmbiguousRevenueAsCost()
// step catches the harder case of a GENERICALLY-named "amount"/"total"
// column sitting in what otherwise reads as a vendor billing export (no
// customer dimension, plus cloud vocabulary or a service/vendor
// dimension). This module just reads off that already-resolved verdict
// (which column, if any, is 'revenue' vs. 'cost' vs. a listed 'price')
// and turns it into the plain-language classification the user asked
// for: business domain, dataset type, primary financial measure, likely
// usage measure, and whether direct customer revenue is present.
//
// Pure function, no DB/IO — mirrors the split already used throughout
// services/businessSemantics.js and services/metricRegistry.js. See
// claude/monetization-discovery-engine.md for how this feeds the
// Monetization Discovery screen's mechanism-labeling guardrail, and
// claude/business-semantic-metric-engine.md for the engine this sits on
// top of.
const { findRoleColumn } = require('./metricRegistry');
const { CLOUD_BILLING_KEYWORDS } = require('./businessSemantics');

function textHits(haystack, keywords) {
  const hay = haystack.toLowerCase();
  return keywords.filter((kw) => hay.includes(kw));
}

function classifyDatasetFinancialProfile(semanticModel, fileProfiles) {
  if (!semanticModel || !semanticModel.factFileType) {
    return {
      applicable: false,
      reason: 'No file in this dataset looks like a transaction/event fact table yet (no revenue, cost, or usage measure was identified across its uploaded files), so a business-domain / financial-measure classification can\'t be made yet.',
    };
  }

  const factEntry = semanticModel.files.find((f) => f.fileType === semanticModel.factFileType);
  const revenueCol = findRoleColumn(factEntry, 'revenue');
  const costCol = findRoleColumn(factEntry, 'cost');
  const priceCol = findRoleColumn(factEntry, 'price');
  const quantityCol = findRoleColumn(factEntry, 'quantity');
  const customerCol = findRoleColumn(factEntry, 'customer_id');
  const merchantDim = semanticModel.files.some((f) => f.role === 'merchant_dimension');

  const allColumnNames = fileProfiles.flatMap((fp) => fp.columns.map((c) => c.name)).join(' ');
  const allFileNames = fileProfiles.map((fp) => fp.fileType).join(' ');
  const cloudHits = textHits(`${allColumnNames} ${allFileNames}`, CLOUD_BILLING_KEYWORDS);

  const evidence = [];
  let primaryType;
  let primaryLabel;
  let primaryColumns = [];

  if (costCol && revenueCol) {
    primaryType = 'both';
    primaryLabel = 'Both cost/expenditure and customer revenue present';
    primaryColumns = [costCol.name, revenueCol.name];
    evidence.push(`Both a cost/expenditure column ("${costCol.name}") and a revenue column ("${revenueCol.name}") were identified in ${factEntry.fileType}.`);
  } else if (costCol) {
    primaryType = 'cost';
    primaryLabel = 'Cloud expenditure / cost';
    primaryColumns = [costCol.name];
    evidence.push(`"${costCol.name}" in ${factEntry.fileType} reads as a cost/expenditure measure${customerCol ? ', even though a customer identifier is also present on this row' : ' — no customer identifier was found on this row'}.`);
  } else if (revenueCol) {
    primaryType = 'revenue';
    primaryLabel = 'Customer sales / revenue';
    primaryColumns = [revenueCol.name];
    evidence.push(`"${revenueCol.name}" in ${factEntry.fileType} reads as a revenue/sales measure${customerCol ? `, tied to a customer identifier ("${customerCol.name}")` : ''}.`);
  } else if (priceCol) {
    primaryType = 'price_list';
    primaryLabel = 'Listed price / rate card (no realized transactions confirmed)';
    primaryColumns = [priceCol.name];
    evidence.push(`Only a listed "${priceCol.name}" was found in ${factEntry.fileType} — no column reads as realized revenue or cost on an actual transaction row.`);
  } else {
    primaryType = 'none';
    primaryLabel = 'No financial measure identified';
    evidence.push(`No column in ${factEntry.fileType} reads as revenue, cost, or a listed price.`);
  }

  let businessDomain;
  let datasetType;
  if (cloudHits.length > 0 && (primaryType === 'cost' || primaryType === 'both' || primaryType === 'price_list')) {
    businessDomain = 'Cloud Computing / IT Services';
    datasetType = 'Cloud Billing / Resource Consumption';
    evidence.push(`Column/file names reference cloud-provider billing concepts (${cloudHits.slice(0, 4).join(', ')}), consistent with a cloud cost export rather than a customer sales dataset.`);
  } else if (primaryType === 'cost') {
    businessDomain = 'Not enough evidence to name a specific business domain — only that this is expense/cost data, not customer sales';
    datasetType = 'Expense / Cost Tracking';
  } else if (primaryType === 'both') {
    businessDomain = merchantDim ? 'Marketplace / Multi-vendor Commerce (with vendor cost data)' : 'Customer Sales / Commerce (with cost data)';
    datasetType = 'Mixed revenue and cost/expenditure data';
  } else if (primaryType === 'revenue') {
    businessDomain = merchantDim ? 'Marketplace / Multi-vendor Commerce' : 'Customer Sales / Commerce';
    datasetType = merchantDim ? 'Customer Sales / Transactional Revenue (multi-vendor)' : 'Customer Sales / Transactional Revenue';
    if (merchantDim) evidence.push('A merchant/vendor dimension file was identified alongside customer sales, consistent with a marketplace dataset.');
  } else if (primaryType === 'price_list') {
    businessDomain = 'Not enough evidence yet — a price list alone doesn\'t show what the business does';
    datasetType = 'Pricing / Rate Card';
  } else {
    businessDomain = 'Not enough evidence to classify the business domain';
    datasetType = 'Descriptive / Reference Data (no financial measure detected)';
  }

  const likelyUsageMeasure = quantityCol
    ? { column: quantityCol.name, evidence: [`"${quantityCol.name}" in ${factEntry.fileType} reads as a usage/quantity measure.`] }
    : { column: null, evidence: ['No usage-quantity column was identified in the fact table.'] };

  const directRevenuePresent = revenueCol
    ? {
      value: true,
      evidence: [`A revenue-shaped column ("${revenueCol.name}") was identified${customerCol ? ' alongside a customer identifier' : ''} — consistent with amounts this organization bills its own customers.`],
    }
    : {
      value: false,
      evidence: costCol
        ? [`The identified monetary column ("${costCol.name}") reads as cost/expenditure this organization pays out, not revenue it earns — unless a separate column explicitly bills this organization's own customers, no direct customer revenue was found.`]
        : ['No column reads as realized revenue billed to this organization\'s own customers.'],
    };

  return {
    applicable: true,
    businessDomain,
    datasetType,
    primaryFinancialMeasure: { type: primaryType, label: primaryLabel, columns: primaryColumns },
    likelyUsageMeasure,
    directRevenuePresent,
    evidence,
    factFileType: semanticModel.factFileType,
  };
}

module.exports = { classifyDatasetFinancialProfile };
