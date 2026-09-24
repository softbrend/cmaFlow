// Dynamic, content-aware Prescriptive Recommendations — the fourth
// analytics layer ported to the newer dataset-native engine generation
// already shipped for Descriptive (services/metricRegistry.js), Diagnostic
// (services/diagnosticEngine.js) and Predictive (services/
// predictiveAnalyticsDynamic.js). Requested directly by the user-supplied
// "Analytics Pipelines" reference document, which asks that every
// recommendation carry a structured
//   Evidence -> Recommendation -> Expected KPI -> Confidence
// shape — a schema nowhere else in this codebase until now.
//
// Design discipline (same as buildBusinessSummaryCard() in routes/
// dashboard.js, documented in claude/dynamic-diagnostic-analytics.md):
// this module ONLY READS outputs that already exist — the 12 findings from
// evaluateDiagnostics(ctx) (services/diagnosticEngine.js) and the dynamic
// predictive functions (services/predictiveAnalyticsDynamic.js +
// revenueForecast() from services/predictiveAnalytics.js) — and writes
// recommendation sentences and simple aggregations around them. It never
// fits a new statistic, never re-derives a number a sibling engine already
// computed, and never guesses. A decision area whose underlying finding or
// predictive function came back {applicable:false} produces no
// recommendation card at all — it surfaces instead in the "Data Readiness"
// list with that function's own plain-language reason, exactly like every
// other layer of this engine generation ("Not applicable," never a
// fabricated zero or an invented number).
//
// Numbers here follow the SAME raw-number convention services/
// diagnosticEngine.js's own `narrative` strings already use
// (`toLocaleString()` / `toFixed(1)`, no currency symbol) — currency-symbol
// formatting, if wanted, belongs at the route/view layer, consistent with
// every other engine in this codebase.
//
// Confidence bands reuse the app-wide convention (services/
// metricRegistry.js:769): >= 0.7 High, >= 0.4 Medium, else Low. A
// recommendation's confidence is read directly from the strength of the
// evidence the sourcing finding/function already produced (a contribution
// share, a correlation/eta magnitude, a coefficient of variation, a Cohen's
// d, a forecast's R², a sample size) — never assigned by feel.

const { revenueForecast } = require('./predictiveAnalytics');
const {
  buildDynamicRevenueTrend, inferPriceElasticityFromFactTable, buildDynamicCustomerFeatures,
} = require('./predictiveAnalyticsDynamic');

function clamp01(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function band(score) {
  if (score >= 0.7) return 'High';
  if (score >= 0.4) return 'Medium';
  return 'Low';
}

function pct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function num(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// Sample-size adequacy read as a 0-1 strength score against two thresholds
// — the same "not enough history/rows yet" honesty already used elsewhere
// in this codebase (e.g. the adaptive-vs-default recency cutoffs in
// services/predictiveAnalytics.js) rather than treating a 3-row segment and
// a 3,000-row one as equally trustworthy.
function sampleStrength(n, { low = 5, high = 30 } = {}) {
  if (!n || n <= low) return clamp01((n || 0) / low) * 0.3;
  if (n >= high) return 1;
  return 0.3 + 0.7 * ((n - low) / (high - low));
}

// ---------------------------------------------------------------------
// Diagnostic-finding-sourced recommendations — one generator per finding
// id, mirroring the exact per-id data shapes routes/dashboard.js's own
// buildDiagnosticEngineCards()/factorTables()/segmentationTables()/
// binaryFactorTables() already consume, so nothing here is a guess at the
// finding's shape.
// ---------------------------------------------------------------------

function topContributionRow(contributions) {
  let best = null;
  let bestDim = null;
  (contributions || []).forEach((c) => {
    (c.rows || []).forEach((r) => {
      if (r.pctOfChange === null) return;
      if (!best || Math.abs(r.pctOfChange) > Math.abs(best.pctOfChange)) {
        best = r;
        bestDim = c.dimensionLabel;
      }
    });
  });
  return best ? { row: best, dimensionLabel: bestDim } : null;
}

function strongestFactor(numericResults, categoricalResults) {
  let best = null;
  (numericResults || []).forEach((r) => {
    if (r.correlation === null) return;
    const strength = Math.abs(r.correlation);
    if (!best || strength > best.strength) best = { kind: 'numeric', result: r, strength };
  });
  (categoricalResults || []).forEach((r) => {
    if (r.eta === null || r.eta === undefined) return;
    const strength = Math.abs(r.eta);
    if (!best || strength > best.strength) best = { kind: 'categorical', result: r, strength };
  });
  return best;
}

const DIAGNOSTIC_RECOMMENDERS = {
  REVENUE_DRIVERS(f) {
    const top = topContributionRow(f.contributions);
    const decisionArea = 'Revenue growth allocation';
    if (!top) {
      return {
        decisionArea,
        evidence: f.narrative,
        recommendation: 'This dataset does not yet break the revenue change down by a dimension with a clear leading contributor — review the overall move directly rather than targeting one slice.',
        expectedKpi: 'Overall revenue',
        strength: f.overall.pct !== null ? clamp01(Math.abs(f.overall.pct) / 20) : 0.2,
      };
    }
    const { row, dimensionLabel } = top;
    // Branch on THIS row's own direction, not the aggregate's — a single
    // large decliner can be the largest |pctOfChange| contributor even
    // while overall revenue rose (offset by other rows), so the aggregate
    // direction is the wrong signal for which message applies to it.
    const rowRising = row.delta !== null && row.delta > 0;
    const recommendation = rowRising
      ? `Prioritize supply, marketing spend, or fulfillment capacity for "${row.label}" (${dimensionLabel}) before spreading effort across the rest of the catalog — it grew ${num(row.prevValue)} → ${num(row.currValue)}, the single largest revenue swing in this dataset's last observed period.`
      : `Investigate "${row.label}" (${dimensionLabel}) first — stockouts, a price change, or a competitor move there — it fell ${num(row.prevValue)} → ${num(row.currValue)}, the single largest revenue swing in this dataset's last observed period.`;
    return {
      decisionArea,
      evidence: `${f.narrative} Within that, "${row.label}" moved from ${num(row.prevValue)} to ${num(row.currValue)} (Δ ${num(row.delta)}), ${pct(row.pctOfChange)} of the total change.`,
      recommendation,
      expectedKpi: `Revenue — this slice already represents ${pct(Math.abs(row.pctOfChange))} of the last observed month-over-month change (based on history, not a guaranteed future outcome).`,
      strength: clamp01(Math.abs(row.pctOfChange) / 100),
    };
  },

  ORDERS_DRIVERS(f) {
    const top = topContributionRow(f.contributions);
    const decisionArea = 'Order volume allocation';
    if (!top) {
      return {
        decisionArea,
        evidence: f.narrative,
        recommendation: 'No single dimension stands out as the leading driver of the order-count change yet — treat this as an overall volume trend rather than a targeted one.',
        expectedKpi: 'Order count',
        strength: f.overall.pct !== null ? clamp01(Math.abs(f.overall.pct) / 20) : 0.2,
      };
    }
    const { row, dimensionLabel } = top;
    // Same reasoning as REVENUE_DRIVERS above — branch on this row's own
    // direction, not the aggregate order-count trend's.
    const rowRising = row.delta !== null && row.delta > 0;
    const recommendation = rowRising
      ? `Lean further into "${row.label}" (${dimensionLabel}) — its order count grew ${num(row.prevValue, 0)} → ${num(row.currValue, 0)}, the single largest order-count swing in this dataset's last observed period, so capacity/inventory planning should assume it keeps leading.`
      : `Focus retention/reactivation effort on "${row.label}" (${dimensionLabel}) — its order count fell ${num(row.prevValue, 0)} → ${num(row.currValue, 0)}, the single largest order-count swing in this dataset's last observed period.`;
    return {
      decisionArea,
      evidence: `${f.narrative} "${row.label}" moved from ${num(row.prevValue)} to ${num(row.currValue)} orders (Δ ${num(row.delta)}), ${pct(row.pctOfChange)} of the total change.`,
      recommendation,
      expectedKpi: `Order count — this slice already represents ${pct(Math.abs(row.pctOfChange))} of the last observed change.`,
      strength: clamp01(Math.abs(row.pctOfChange) / 100),
    };
  },

  AOV_DRIVERS(f) {
    const decisionArea = 'Average order value tactics';
    const { mixEffect, rateEffect, totalDelta } = f.decomposition;
    const mixDominant = Math.abs(mixEffect) >= Math.abs(rateEffect);
    const recommendation = mixDominant
      ? 'AOV moved mostly because of a shift in which categories customers are buying, not a price change — merchandise/promote the higher-AOV categories already gaining share rather than adjusting prices.'
      : 'AOV moved mostly because prices shifted within categories, not because of a mix change — review recent pricing/discounting decisions in the categories with the largest AOV change before touching merchandising.';
    return {
      decisionArea,
      evidence: `${f.narrative} Mix effect ${num(mixEffect)}, rate effect ${num(rateEffect)} (total AOV Δ ${num(totalDelta)}).`,
      recommendation,
      expectedKpi: `Average order value — moved from ${num(f.prevAOV, 2)} to ${num(f.currAOV, 2)} last period.`,
      strength: totalDelta ? clamp01(Math.max(Math.abs(mixEffect), Math.abs(rateEffect)) / Math.abs(totalDelta)) : 0.3,
    };
  },

  FREIGHT_DRIVERS(f) {
    return factorBasedRecommendation(f, {
      decisionArea: 'Shipping cost control',
      metricLabel: 'Freight cost',
      verb: 'freight cost',
    });
  },

  DELIVERY_DELAY_DRIVERS(f) {
    return factorBasedRecommendation(f, {
      decisionArea: 'Delivery reliability',
      metricLabel: 'Delivery delay',
      verb: 'delivery delay',
    });
  },

  REVIEW_SCORE_DRIVERS(f) {
    return factorBasedRecommendation(f, {
      decisionArea: 'Customer satisfaction (reviews)',
      metricLabel: 'Review score',
      verb: 'review score',
    });
  },

  CATEGORY_REVENUE_PARETO(f) {
    const top = f.pareto[0];
    const decisionArea = 'Category-level revenue recovery';
    if (!top) {
      return {
        decisionArea, evidence: f.narrative, recommendation: 'No single declining category stands out yet.', expectedKpi: 'Revenue', strength: 0.2,
      };
    }
    return {
      decisionArea,
      evidence: `${f.narrative} "${top.label}" alone moved from ${num(top.prevValue)} to ${num(top.currValue)} (Δ ${num(top.delta)}), ${pct(top.cumulativePct)} cumulative share of the decline.`,
      recommendation: `Prioritize "${top.label}" for root-cause investigation and recovery action (pricing, assortment, stock, marketing) — reversing it alone would close roughly ${pct(top.cumulativePct)} of the total category-level revenue decline.`,
      expectedKpi: `Revenue recovered if "${top.label}" is brought back to its prior level: up to ${num(Math.abs(top.delta))} (${pct(top.cumulativePct)} of the total decline).`,
      strength: clamp01(top.cumulativePct / 100),
    };
  },

  SELLER_PERFORMANCE_SEGMENTATION(f) {
    return segmentationRecommendation(f, { decisionArea: 'Seller performance management' });
  },

  GEO_SALES_SEGMENTATION(f) {
    return segmentationRecommendation(f, { decisionArea: 'Geographic sales prioritization' });
  },

  CANCELLATION_DRIVERS(f) {
    const decisionArea = 'Cancellation reduction';
    const factor = strongestFactor(f.numericResults, f.categoricalResults);
    if (!factor) {
      return {
        decisionArea, evidence: f.narrative, recommendation: 'No factor tested shows a clear association with cancellation yet.', expectedKpi: 'Cancellation rate', strength: 0.2,
      };
    }
    const label = factor.result.label;
    const recommendation = `Address "${label}" first — it shows the strongest association with cancellation of everything tested — before broader retention spend.`;
    const trendNote = f.trend
      ? ` Cancellation rate is currently ${pct(f.trend.currRatePct)} (was ${pct(f.trend.prevRatePct)}).`
      : '';
    let strength;
    if (factor.kind === 'numeric') {
      strength = clamp01(Math.abs(factor.result.cohensD) / 0.8); // 0.8 = conventional "large effect" threshold
    } else {
      strength = factor.result.test.significant ? 0.75 : 0.3;
    }
    return {
      decisionArea,
      evidence: `${f.narrative}${trendNote}`,
      recommendation,
      expectedKpi: `Cancellation rate${f.trend ? ` — currently ${pct(f.trend.currRatePct)}` : ''}.`,
      strength,
    };
  },

  PAYMENT_BEHAVIOR_CROSSTAB(f) {
    const decisionArea = 'Payment experience optimization';
    const sig = f.crosstab && f.crosstab.test ? f.crosstab.test.significant : false;
    let strength = sig ? 0.7 : 0.25;
    let recommendation = 'No significant payment-behavior pattern was found yet to act on.';
    if (sig) {
      recommendation = 'Payment type and this behavior are significantly associated — review whether the payment options offered at checkout should be re-ordered or promoted differently by customer segment.';
    }
    if (f.installmentsByPayment && f.installmentsByPayment.groups.length > 1) {
      const groups = f.installmentsByPayment.groups;
      const highest = groups[0];
      const lowest = groups[groups.length - 1];
      recommendation += ` Installment usage ranges from ${num(lowest.avgInstallments, 1)} (${lowest.label}) to ${num(highest.avgInstallments, 1)} (${highest.label}) — consider surfacing installment plans more prominently for payment types that already lean toward them.`;
      strength = Math.max(strength, clamp01(f.installmentsByPayment.eta || 0));
    }
    if (!sig && (!f.installmentsByPayment || f.installmentsByPayment.groups.length <= 1)) {
      return null;
    }
    return {
      decisionArea, evidence: f.narrative, recommendation, expectedKpi: 'Payment-method mix / installment usage.', strength,
    };
  },

  REPEAT_PURCHASE_DRIVERS(f) {
    const decisionArea = 'Repeat purchase / retention growth';
    const factor = strongestFactor(f.numericResults, f.categoricalResults);
    const total = f.repeatCount + f.oneTimeCount;
    const repeatRatePct = total ? (f.repeatCount / total) * 100 : null;
    if (!factor) {
      return {
        decisionArea, evidence: f.narrative, recommendation: 'No factor tested clearly separates repeat from one-time customers yet.', expectedKpi: 'Repeat purchase rate', strength: 0.2,
      };
    }
    let strength;
    if (factor.kind === 'numeric') {
      strength = clamp01(Math.abs(factor.result.cohensD) / 0.8);
    } else {
      strength = factor.result.test.significant ? 0.75 : 0.3;
    }
    return {
      decisionArea,
      evidence: `${f.narrative} Repeat purchase rate is ${pct(repeatRatePct)} (${num(f.repeatCount, 0)} of ${num(total, 0)} customers).`,
      recommendation: `Build a retention play around "${factor.result.label}" — it separates repeat from one-time customers more clearly than anything else tested — rather than a generic win-back campaign.`,
      expectedKpi: `Repeat purchase rate — currently ${pct(repeatRatePct)}.`,
      strength,
    };
  },
};

function factorBasedRecommendation(f, { decisionArea, metricLabel, verb }) {
  const factor = strongestFactor(f.numericResults, f.categoricalResults);
  if (!factor) {
    return {
      decisionArea, evidence: f.narrative, recommendation: `No factor tested shows a clear association with ${verb} yet.`, expectedKpi: metricLabel, strength: 0.2,
    };
  }
  const label = factor.result.label;
  let detail = '';
  let recommendation;
  if (factor.kind === 'numeric') {
    const { split } = factor.result;
    detail = split
      ? ` Below ${num(split.threshold, 1)}, the average is ${num(split.leftMean, 1)}; above it, ${num(split.rightMean, 1)} (explains ${pct(split.reductionPct, 0)} of the variance).`
      : '';
    recommendation = `"${label}" shows the strongest association with ${verb} (correlation ${num(factor.result.correlation, 2)}) — use its best-separating threshold${split ? ` (${num(split.threshold, 1)})` : ''} as an operational cutoff to flag cases early.`;
  } else {
    const { bestGroup, overallMean } = factor.result;
    detail = bestGroup ? ` "${bestGroup.label}" averages ${num(bestGroup.mean, 2)} vs. an overall ${num(overallMean, 2)}.` : '';
    recommendation = `"${label}" shows the strongest association with ${verb} (effect size η ${num(factor.result.eta, 2)}) — start there${bestGroup ? `, specifically the "${bestGroup.label}" group` : ''} before a broader rollout.`;
  }
  return {
    decisionArea,
    evidence: `${f.narrative}${detail}`,
    recommendation,
    expectedKpi: `${metricLabel} — the observed gap above is a correlational read, not a guaranteed causal effect.`,
    strength: factor.strength,
  };
}

function segmentationRecommendation(f, { decisionArea }) {
  if (!f.top.length || !f.bottom.length) {
    return {
      decisionArea, evidence: f.narrative, recommendation: `Not enough distinct ${f.entityLabel.toLowerCase()}s with sufficient volume yet to segment confidently.`, expectedKpi: 'Revenue', strength: 0.2,
    };
  }
  const revenueMeasure = f.measures.find((m) => m.key === 'revenue') || f.measures[0];
  const topVal = f.top[0][revenueMeasure.key];
  const bottomVal = f.bottom[0][revenueMeasure.key];
  const gap = topVal !== undefined && bottomVal !== undefined ? topVal - bottomVal : null;
  return {
    decisionArea,
    evidence: `${f.narrative} Top: "${f.top[0].label}" (${revenueMeasure.label} ${num(topVal)}). Bottom: "${f.bottom[0].label}" (${revenueMeasure.label} ${num(bottomVal)}).`,
    recommendation: `Study what "${f.top[0].label}" does differently and apply it to the bottom-performing group (starting with "${f.bottom[0].label}") — the ${f.entityLabel.toLowerCase()}-to-${f.entityLabel.toLowerCase()} spread on ${revenueMeasure.label.toLowerCase()} is wide enough (coefficient of variation ${f.coefficientOfVariation !== null ? `${f.coefficientOfVariation.toFixed(0)}%` : '—'}) that closing even part of it is worth targeted effort over an across-the-board push.`,
    expectedKpi: `${revenueMeasure.label} — gap between top and bottom performer: ${gap !== null ? num(Math.abs(gap)) : '—'}.`,
    strength: f.coefficientOfVariation !== null ? clamp01(f.coefficientOfVariation / 100) : 0.3,
  };
}

// ---------------------------------------------------------------------
// Predictive-sourced recommendations — reuse services/
// predictiveAnalyticsDynamic.js + revenueForecast() exactly as computed for
// the Predictive Analytics (Dynamic) tab; nothing here re-fits a trend, a
// price-elasticity read, or a churn-risk score.
// ---------------------------------------------------------------------

function buildRevenueOutlookRecommendation(forecast, ctx) {
  if (!forecast) return null;
  const decisionArea = 'Revenue planning / outlook';
  const growing = forecast.growthRatePct !== null && forecast.growthRatePct > 0;
  const nextProjection = forecast.projections[0];
  const r2 = forecast.r2 === null ? 0 : Math.max(0, forecast.r2);
  const recommendation = growing
    ? `Plan capacity, inventory, and staffing for continued growth — this fact table's own revenue trend (${forecast.historyMonths} months of history) projects ${nextProjection.label} at ${num(nextProjection.value)}.`
    : `Prioritize cost control and demand-generation review — this fact table's own revenue trend is flat or declining, projecting ${nextProjection.label} at ${num(nextProjection.value)}.`;
  return {
    decisionArea,
    evidence: `${forecast.historyMonths} months of history, average monthly growth ${pct(forecast.growthRatePct)}, trend fit R² ${forecast.r2 === null ? '—' : forecast.r2.toFixed(2)}. ${forecast.reliabilityNote || ''}`.trim(),
    recommendation,
    expectedKpi: `Revenue — projected ${nextProjection.label}: ${num(nextProjection.value)}${forecast.crossCheck ? ` (cross-checked against ${num(forecast.crossCheck.projections[0].value)} via Holt's smoothing)` : ''}.`,
    confidence: clamp01(r2),
    confidenceBand: band(clamp01(r2)),
    sourceFindingId: 'DYNAMIC_REVENUE_FORECAST',
    sourceLabel: 'Revenue forecast (dynamic)',
  };
}

function buildPricingRecommendation(elasticityResult) {
  const { results } = elasticityResult;
  if (!results || !results.length) return null;
  // Same "most recent, most comparable" pick the dynamic What-if scenario
  // already uses — not a re-fit, just picking which already-computed row
  // to lead with.
  const withElasticity = results.filter((r) => r.elasticity !== null && r.elasticity !== undefined);
  if (!withElasticity.length) return null;
  const avgElasticity = withElasticity.reduce((s, r) => s + r.elasticity, 0) / withElasticity.length;
  const isElastic = Math.abs(avgElasticity) > 1;
  const lead = withElasticity[0];
  const decisionArea = 'Pricing strategy';
  const recommendation = isElastic
    ? `Demand looks price-elastic (avg elasticity ${avgElasticity.toFixed(2)} across ${withElasticity.length} comparable price change${withElasticity.length === 1 ? '' : 's'}) — favor volume-preserving moves (promotions, usage-based pricing) over outright price increases.`
    : `Demand looks price-inelastic (avg elasticity ${avgElasticity.toFixed(2)} across ${withElasticity.length} comparable price change${withElasticity.length === 1 ? '' : 's'}) — there may be room to raise price on this group with limited volume loss, based on this dataset's own history.`;
  // Round 21 — a booking-calendar-shaped fact table (no dedicated
  // revenue column) only has this "revenue" because listDynamicWhatIfGroups/
  // inferPriceElasticityFromFactTable estimate it from booked rows priced
  // at the listed rate. That must stay disclosed here too, not just on the
  // What-if tab, since this evidence line quotes the same before/after
  // revenue figures.
  const estimatedNote = elasticityResult.revenueIsEstimatedOccupancy
    ? ` (Estimated Revenue — this dataset has no dedicated revenue field; figures reflect booked${elasticityResult.availabilityColumnName ? ` rows per "${elasticityResult.availabilityColumnName}"` : ' rows only'} priced at the listed rate, not observed transaction amounts.)`
    : '';
  return {
    decisionArea,
    evidence: `Most recent comparable change — "${lead.group}" on ${new Date(lead.effectiveDate).toLocaleDateString()}: price ${num(lead.oldPrice, 2)} → ${num(lead.newPrice, 2)} (${pct(lead.pricePctChange)}), revenue ${num(lead.beforeRevenue)} → ${num(lead.afterRevenue)} (${pct(lead.revenuePctChange)}).${estimatedNote}`,
    recommendation,
    expectedKpi: `Revenue — the last comparable price change moved revenue ${pct(lead.revenuePctChange)}; a similarly-sized move could be expected to have a similarly-sized effect, based on ${withElasticity.length} historical instance${withElasticity.length === 1 ? '' : 's'}, not a guarantee.`,
    confidence: clamp01(sampleStrength(withElasticity.length, { low: 1, high: 5 })),
    confidenceBand: band(clamp01(sampleStrength(withElasticity.length, { low: 1, high: 5 }))),
    sourceFindingId: 'DYNAMIC_PRICE_ELASTICITY',
    sourceLabel: 'Price elasticity (dynamic)',
  };
}

function buildRetentionRecommendation(riskResult) {
  const { features } = riskResult;
  if (!features || !features.length) return null;
  const targets = features.filter((f) => f.churnRiskBand === 'High' && f.highValue);
  if (!targets.length) return null;
  const totalMonetary = targets.reduce((s, f) => s + (f.monetary || 0), 0);
  const decisionArea = 'Customer retention targeting';
  return {
    decisionArea,
    evidence: `${targets.length} of ${features.length} customers in this fact table are both high churn-risk and high-value, together representing ${num(totalMonetary)} in historical value.`,
    recommendation: `Route these ${targets.length} customer${targets.length === 1 ? '' : 's'} to retention outreach first — they carry the most revenue at risk of any segment this fact table can currently identify.`,
    expectedKpi: `Revenue at risk retained — up to ${num(totalMonetary)} in historical customer value currently flagged high-risk.`,
    confidence: clamp01(sampleStrength(features.length, { low: 15, high: 100 })),
    confidenceBand: band(clamp01(sampleStrength(features.length, { low: 15, high: 100 }))),
    sourceFindingId: 'DYNAMIC_CUSTOMER_RETENTION',
    sourceLabel: 'Customer risk (dynamic)',
  };
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

// A recommendation whose own evidence strength rounds to essentially
// nothing (e.g. a contribution of 0.0% of a 1-order change) is not a wrong
// recommendation, but showing it as a "Low confidence" card next to real
// findings is noise, not honesty — the honest-degradation move is to treat
// it the same as "not enough signal yet" and list it under Data readiness
// instead, with its own plain-language reason, rather than let a near-zero
// number crowd a real recommendation off the page.
const MIN_STRENGTH = 0.05;

function buildDynamicPrescriptiveRecommendations({ bi, ctx }) {
  if (!bi || !bi.applicable) {
    return {
      applicable: false,
      reason: bi ? bi.reason : 'No business-intelligence context could be built for this dataset yet.',
      recommendations: [],
      dataReadiness: [],
    };
  }

  const recommendations = [];
  const dataReadiness = [];

  (bi.diagnostics || []).forEach((f) => {
    const gen = DIAGNOSTIC_RECOMMENDERS[f.id];
    if (!gen) return;
    if (!f.applicable) {
      dataReadiness.push({ source: f.label, reason: f.reason });
      return;
    }
    const rec = gen(f);
    if (!rec) {
      dataReadiness.push({ source: f.label, reason: 'No factor cleared the bar for a confident recommendation on this finding.' });
      return;
    }
    const strength = clamp01(rec.strength);
    if (strength < MIN_STRENGTH) {
      dataReadiness.push({ source: f.label, reason: 'The signal behind this finding is too small to support a confident recommendation yet (not enough of a change, or too little history, to act on).' });
      return;
    }
    recommendations.push({
      decisionArea: rec.decisionArea,
      evidence: rec.evidence,
      recommendation: rec.recommendation,
      expectedKpi: rec.expectedKpi,
      confidence: strength,
      confidenceBand: band(strength),
      sourceFindingId: f.id,
      sourceLabel: f.label,
    });
  });

  const addPredictiveRec = (rec, sourceLabel) => {
    if (!rec) return false;
    if (clamp01(rec.confidence) < MIN_STRENGTH) {
      dataReadiness.push({ source: sourceLabel, reason: 'The signal here is too small to support a confident recommendation yet (not enough of a trend, or too little history, to act on).' });
      return false;
    }
    recommendations.push(rec);
    return true;
  };

  if (ctx) {
    const trendResult = buildDynamicRevenueTrend(ctx);
    if (trendResult.applicable) {
      const forecast = revenueForecast(trendResult.trend);
      const rec = buildRevenueOutlookRecommendation(forecast);
      addPredictiveRec(rec, 'Revenue outlook (forecast)');
    } else {
      dataReadiness.push({ source: 'Revenue outlook (forecast)', reason: trendResult.reason });
    }

    const elasticityResult = inferPriceElasticityFromFactTable(ctx);
    if (elasticityResult.applicable && elasticityResult.results.length) {
      const rec = buildPricingRecommendation(elasticityResult);
      if (rec) addPredictiveRec(rec, 'Pricing scenario (elasticity)');
      else dataReadiness.push({ source: 'Pricing scenario (elasticity)', reason: 'No group had a usable elasticity read yet.' });
    } else {
      dataReadiness.push({ source: 'Pricing scenario (elasticity)', reason: elasticityResult.reason || 'No comparable price change was found in this fact table yet.' });
    }

    const riskResult = buildDynamicCustomerFeatures(ctx);
    if (riskResult.applicable) {
      const rec = buildRetentionRecommendation(riskResult);
      if (rec) addPredictiveRec(rec, 'Customer retention targeting');
      else dataReadiness.push({ source: 'Customer retention targeting', reason: 'No customers in this fact table currently score as both high-risk and high-value.' });
    } else {
      dataReadiness.push({ source: 'Customer retention targeting', reason: riskResult.reason });
    }
  }

  recommendations.sort((a, b) => b.confidence - a.confidence);

  return { applicable: true, recommendations, dataReadiness };
}

module.exports = {
  buildDynamicPrescriptiveRecommendations,
};
