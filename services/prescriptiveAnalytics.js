// Prescriptive Recommendations — Phase 4 of claude/canonical-schema-
// analytics-roadmap.md ("what should we do next"). Deliberately reuses
// the SAME performance baseline Descriptive Analytics already computes
// (Mechanisms table, Financial reconciliation, Catalog overview) plus
// Diagnostic's price-change read, rather than re-deriving any of it
// differently — and turns them into a ranked, reasoned recommendation of
// which CMA revenue model (Subscription / Freemium / Pay-per-use /
// Data-as-a-Service) to lean into next. Rules-based and fully explained
// per candidate: there is no bare numeric score shown without its
// reasoning, by design (see the roadmap doc's Phase 4 section).
const { MODEL_TYPE_LABELS } = require('./analytics');
const { combinedPriceChangeImpact } = require('./diagnosticAnalytics');

// Summarizes this dataset's own price-change history (the same read
// diagnosticAnalytics.combinedPriceChangeImpact computes — config-confirmed
// price points where a dataset has them, PLUS a price shift inferred
// directly from transaction history for any product that doesn't) into a
// single dataset-wide elasticity read: the average of (%volume change /
// %price change) across every detected, comparable price change.
// `available` is false only when the dataset has no comparable price
// change at all, confirmed or inferred.
function elasticitySummary(transactionRows, monetizationRows) {
  const impacts = combinedPriceChangeImpact(transactionRows, monetizationRows);
  const withElasticity = impacts.filter((i) => i.elasticity !== null);
  if (withElasticity.length === 0) return { available: false, impacts };
  const avgElasticity = withElasticity.reduce((s, i) => s + i.elasticity, 0) / withElasticity.length;
  return {
    available: true,
    avgElasticity,
    isElastic: Math.abs(avgElasticity) > 1,
    impacts,
  };
}

// Ranks the four CMA revenue models as candidates for "what to lean into
// next," from signals already computed elsewhere in the app: mechanism
// performance (revenue share, transaction count) from Descriptive
// Analytics, the elasticity read above, and this dataset's own catalog
// shape. Every candidate always carries its reasoning as plain sentences
// — nothing here is a bare score. Financial reconciliation's expected-
// vs-actual variance is reported as a separate, dataset-wide note
// (`reconciliationNote`) rather than folded into any one model's score,
// since a reconciliation gap is a pricing-accuracy signal across the
// WHOLE dataset, not evidence for one mechanism over another.
function rankConfigurationRecommendations({
  mechanismTable, reconciliation, elasticity, catalog,
}) {
  const allModels = Object.keys(MODEL_TYPE_LABELS);
  const performanceByModel = {};
  (mechanismTable || []).forEach((m) => { performanceByModel[m.label] = m; });
  const totalRevenue = (mechanismTable || []).reduce((s, m) => s + m.revenue, 0);

  const candidates = allModels.map((modelKey) => {
    const label = MODEL_TYPE_LABELS[modelKey];
    const perf = performanceByModel[label];
    const reasoning = [];
    let score = 0;

    if (perf) {
      const share = totalRevenue ? (perf.revenue / totalRevenue) * 100 : 0;
      score += share / 20; // up to +5 for a mechanism carrying all the revenue
      reasoning.push(`Currently ${share.toFixed(1)}% of this dataset's transaction revenue, across ${perf.count.toLocaleString()} transactions.`);
    } else {
      reasoning.push('No transaction revenue currently attributed to this mechanism in this dataset.');
    }

    if (elasticity && elasticity.available) {
      if (modelKey === 'pay_per_use' && elasticity.isElastic) {
        score += 2;
        reasoning.push(`Demand looked price-elastic in this dataset's own price-change history (avg elasticity ${elasticity.avgElasticity.toFixed(2)}) — usage-based pricing tends to capture volume upside better than a flat fee when demand responds this much to price.`);
      }
      if (modelKey === 'subscription' && !elasticity.isElastic) {
        score += 2;
        reasoning.push(`Demand looked price-inelastic in this dataset's own price-change history (avg elasticity ${elasticity.avgElasticity.toFixed(2)}) — volume held up through past price changes, which favors predictable subscription pricing over usage-based.`);
      }
    }

    if (modelKey === 'freemium' && catalog && catalog.distinctProducts > 1) {
      score += 0.5;
      reasoning.push(`${catalog.distinctProducts} distinct priced products/tiers exist in this dataset's catalog — enough tiering room for a freemium entry point.`);
    }

    if (modelKey === 'data_as_a_service' && catalog
      && catalog.products.some((p) => /data|api|feed|export|dataset/i.test(p.product))) {
      score += 0.5;
      reasoning.push('This dataset\'s catalog includes at least one product named like a data/API offering.');
    }

    if (reasoning.length === 1 && !perf) {
      reasoning.push('Not enough dataset history yet to score this mechanism with confidence.');
    }

    return {
      modelKey, label, score, reasoning,
    };
  }).sort((a, b) => b.score - a.score);

  let reconciliationNote = null;
  if (reconciliation) {
    const pct = reconciliation.variancePct;
    if (reconciliation.variance > 0) {
      reconciliationNote = `Actual revenue is running ${pct !== null ? `${pct.toFixed(1)}% ` : ''}above what this dataset's configured prices would predict — there may be room to formalize that upside into the configuration rather than leave it as informal upsell.`;
    } else if (reconciliation.variance < 0) {
      reconciliationNote = `Actual revenue is running ${pct !== null ? `${Math.abs(pct).toFixed(1)}% ` : ''}below what this dataset's configured prices would predict — worth checking whether customers are landing on lower tiers than configured, or whether configured prices need to come down to match what's actually being paid.`;
    } else {
      reconciliationNote = 'Actual revenue matches what this dataset\'s configured prices would predict — no reconciliation gap to act on.';
    }
  }

  return { candidates, reconciliationNote };
}

module.exports = { elasticitySummary, rankConfigurationRecommendations };
