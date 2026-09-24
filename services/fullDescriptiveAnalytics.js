// DB-aware layer for the Full Descriptive Analytics tab — persists and
// retrieves the per-file profiles services/datasetProfiler.js computes,
// detects cross-file relationships (e.g. menu.csv's r_id -> restaurant.
// csv's id) with a real query rather than a guess, and assembles the
// executive KPI row that summarizes the whole dataset at a glance. See
// claude/full-descriptive-analytics.md for the design writeup.
const pool = require('../db/pool');
const { profileFile, tryParseNumber } = require('./datasetProfiler');
const { buildSemanticModel } = require('./businessSemantics');
// Round 22 — buildSemanticModelHybrid() wraps buildSemanticModel() above,
// enhancing only the columns the pure rule engine left unresolved or
// weakly resolved with the new embedding+classifier signal (services/
// semanticFieldEngine.js), then falls back to businessSemantics.js's own
// pure-rule buildSemanticModel() if the hybrid layer throws for any
// reason (missing/corrupt model file, embedding package unavailable,
// ...) — see that module's own header for the full design writeup. This
// is the ONE call site both getOrBuildBusinessIntelligence() (cached) and
// buildBusinessContext()/predictiveAnalyticsDynamic.js's live ctx builder
// route through, so swapping it in here upgrades every dynamic/content-
// aware page in the app at once.
const { buildSemanticModelHybrid } = require('./semanticFieldEngine');
const {
  findRoleColumn, buildDimensionLookup, buildNumericDimensionLookup, evaluateMetrics, GENERIC_CATEGORY_NAME_RE,
  STATUS_NAME_RE, ESTIMATED_DATE_NAME_RE, ACTUAL_DATE_NAME_RE,
} = require('./metricRegistry');
const { classifyDatasetFinancialProfile } = require('./datasetClassifier');
const { evaluateDiagnostics } = require('./diagnosticEngine');
const { clamp01, bandFor } = require('./priorityEngine');

// ---------------------------------------------------------------------
// Persisting one file's profile — called both at upload time (with the
// rows already in memory from parseCsvFile, inside the same transaction
// as the raw ingest) and lazily, for a dataset that predates this
// feature or whose cached profile is older than its latest file.
// ---------------------------------------------------------------------
async function upsertFileProfile(queryable, {
  datasetRowId, accountId, fileType, rows,
}) {
  const profile = profileFile(fileType, rows);
  await queryable.query(
    `INSERT INTO dataset_profiles (dataset_id, account_id, file_type, row_count, profile)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (dataset_id, file_type)
     DO UPDATE SET row_count = $4, profile = $5::jsonb, computed_at = now()`,
    [datasetRowId, accountId, fileType, rows.length, JSON.stringify(profile)]
  );
  return profile;
}

// ---------------------------------------------------------------------
// Relationship detection — candidate key pairs from name matching over
// already-computed column profiles, then an EXACT overlap measurement by
// intersecting the two columns' full distinct-value sets (profileId() in
// datasetProfiler.js keeps the complete set, not a display-sized sample,
// for exactly this reason). Entirely in-memory: an earlier version ran a
// live SQL DISTINCT+JOIN per candidate instead, which meant a second full
// scan of dataset_records per candidate pair and became the single
// slowest part of profiling once files ran into the hundreds of
// thousands of rows (multiple candidate pairs x 200k-row unindexed JSONB
// scans). Comparing two already-in-memory Sets is orders of magnitude
// cheaper and gives an EXACT answer, not a sampled estimate.
// ---------------------------------------------------------------------
function normalizeAlnum(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function stripIdSuffix(s) { return String(s).replace(/_?id$/i, ''); }

// Is `colA` (in fileA) a plausible foreign key into `colB` (in fileB)?
// Only ever tested for columns datasetProfiler.js already classified as
// kind 'id'. Two ways to match:
//   1. The exact same column name in both files (order_id in orders.csv
//      AND in a payments.csv) — always a candidate.
//   2. colB is fileB's own bare "id" column, and colA's name (with any
//      "_id"/"id" suffix stripped) identifies fileB — either as a
//      substring ("r_id" -> "r", "restaurant" contains no "r" as a
//      whole-word match, so single-letter prefixes are matched against
//      fileB's own first letter instead) or a longer recognizable
//      fragment ("listing_id" -> "listing", "listings" contains it).
function looksRelated(colA, colB, fileA, fileB) {
  if (fileA === fileB) return false;
  if (colA.toLowerCase() === colB.toLowerCase()) return true;
  if (colB.toLowerCase() !== 'id') return false;
  const prefix = normalizeAlnum(stripIdSuffix(colA));
  if (!prefix) return false;
  const fb = normalizeAlnum(fileB);
  const fbSingular = fb.replace(/s$/, '');
  if (prefix.length === 1) return fb.startsWith(prefix) || fbSingular.startsWith(prefix);
  return fb.includes(prefix) || fbSingular.includes(prefix) || prefix.includes(fbSingular) || prefix.includes(fb);
}

function candidateKeyPairs(fileProfiles) {
  const byFile = fileProfiles.map((fp) => ({
    fileType: fp.fileType,
    idCols: fp.columns.filter((c) => c.kind === 'id').map((c) => c.name),
  }));
  const seen = new Set();
  const pairs = [];
  byFile.forEach((A) => {
    byFile.forEach((B) => {
      if (A.fileType === B.fileType) return;
      A.idCols.forEach((colA) => {
        B.idCols.forEach((colB) => {
          if (!looksRelated(colA, colB, A.fileType, B.fileType)) return;
          const key = `${A.fileType}.${colA}->${B.fileType}.${colB}`;
          const reciprocal = `${B.fileType}.${colB}->${A.fileType}.${colA}`;
          if (seen.has(key) || seen.has(reciprocal)) return;
          seen.add(key);
          pairs.push({
            fromFile: A.fileType, fromColumn: colA, toFile: B.fileType, toColumn: colB,
          });
        });
      });
    });
  });
  return pairs;
}

const MIN_REPORTABLE_OVERLAP_PCT = 10; // below this, a name-based candidate is almost certainly a coincidence, not a real join

function findColumn(fileProfiles, fileType, columnName) {
  const fp = fileProfiles.find((f) => f.fileType === fileType);
  return fp && fp.columns.find((c) => c.name === columnName);
}

function measureOverlap(pair, fileProfiles) {
  const fromCol = findColumn(fileProfiles, pair.fromFile, pair.fromColumn);
  const toCol = findColumn(fileProfiles, pair.toFile, pair.toColumn);
  if (!fromCol || !toCol || !fromCol.distinctValues || !toCol.distinctValues) {
    return { ...pair, fromDistinct: 0, matched: 0, overlapPct: 0 };
  }
  const toSet = new Set(toCol.distinctValues);
  let matched = 0;
  fromCol.distinctValues.forEach((v) => { if (toSet.has(v)) matched += 1; });
  const fromN = fromCol.distinctValues.length;
  const overlapPct = fromN > 0 ? (matched / fromN) * 100 : 0;
  return {
    ...pair, fromDistinct: fromN, matched, overlapPct,
  };
}

// ---------------------------------------------------------------------
// CAAGA Stage 3 (Relationship Graph Builder) — a genuine, combined
// relationship-CONFIDENCE score, additive alongside the existing
// overlapPct. Before this, a candidate edge's only numeric signal was
// join coverage (overlapPct); PK/FK plausibility itself was boolean
// (looksRelated()'s name match) and nothing scored whether the
// REFERENCED side actually looks like a real key (near-unique) or
// whether the naming match was a strong or coincidental one. This blends
// three signals the CAAGA document names explicitly — containment,
// uniqueness, and naming similarity — into one [0,1] score:
//   containment: overlapPct/100 (already exact — see measureOverlap()'s
//     own comment on why this is a real Set intersection, not a sample)
//   uniqueness:  how PK-like the REFERENCED (toColumn) side is — a real
//     foreign key should point at something close to a true primary key
//     (uniquenessRatio near 1), not a column that's itself full of
//     duplicates
//   nameSimilarity: a continuous Dice/bigram score between the FK
//     column's name (with any _id/id suffix stripped) and the target
//     file's own name — a graded version of the boolean substring test
//     looksRelated() already uses to GENERATE the candidate in the first
//     place; this doesn't change which candidates are generated, only how
//     confidently each one is reported once found.
// Deliberately does NOT change candidate generation, filtering, or sort
// order (still overlapPct-based, exactly as before this round) — every
// piece of code downstream that reads `relationships` (findTwoHopBridge,
// findFulfillmentBridge, the dimension-resolution block in
// buildBusinessContext, services/erdDiagram.js) keeps working unchanged;
// `confidence`/`confidenceBand`/`confidenceEvidence` are new fields
// available to any caller that wants them (e.g. a future ERD edge-styling
// pass) without altering anything that already consumes overlapPct.
const RELATIONSHIP_WEIGHTS = { containment: 0.5, uniqueness: 0.3, nameSimilarity: 0.2 };

function bigrams(s) {
  const clean = String(s).toLowerCase();
  const out = [];
  for (let i = 0; i < clean.length - 1; i += 1) out.push(clean.slice(i, i + 2));
  return out;
}

// Sørensen–Dice coefficient over character bigrams — a standard, cheap
// string-similarity measure (no external library needed) naturally
// bounded to [0,1]: identical strings score 1, strings sharing no
// 2-character sequence score 0.
function diceBigramSimilarity(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return a === b ? 1 : 0;
  const counts = new Map();
  ba.forEach((g) => counts.set(g, (counts.get(g) || 0) + 1));
  let overlap = 0;
  bb.forEach((g) => {
    const c = counts.get(g) || 0;
    if (c > 0) { overlap += 1; counts.set(g, c - 1); }
  });
  return (2 * overlap) / (ba.length + bb.length);
}

function scoreRelationshipConfidence(pair, toCol) {
  const containment = clamp01((pair.overlapPct || 0) / 100);
  // A bare "id" column being profiled with distinctValues at all implies
  // it's non-empty; uniquenessRatio is null only when there are zero
  // non-blank values, in which case it can't be a real key.
  const uniqueness = clamp01(toCol && Number.isFinite(toCol.uniquenessRatio) ? toCol.uniquenessRatio : 0);
  const nameSimilarity = diceBigramSimilarity(
    normalizeAlnum(stripIdSuffix(pair.fromColumn)),
    normalizeAlnum(stripIdSuffix(pair.toFile))
  );
  const score = clamp01(
    (RELATIONSHIP_WEIGHTS.containment * containment)
    + (RELATIONSHIP_WEIGHTS.uniqueness * uniqueness)
    + (RELATIONSHIP_WEIGHTS.nameSimilarity * nameSimilarity)
  );
  return {
    confidence: Math.round(score * 1000) / 1000,
    confidenceBand: bandFor(score),
    confidenceEvidence: {
      containment: Math.round(containment * 1000) / 1000,
      uniqueness: Math.round(uniqueness * 1000) / 1000,
      nameSimilarity: Math.round(nameSimilarity * 1000) / 1000,
    },
  };
}

function detectRelationships(fileProfiles) {
  if (fileProfiles.length < 2) return [];
  const candidates = candidateKeyPairs(fileProfiles);
  const measured = candidates.map((c) => measureOverlap(c, fileProfiles));
  return measured
    .filter((r) => r.overlapPct >= MIN_REPORTABLE_OVERLAP_PCT)
    .map((r) => {
      const toCol = findColumn(fileProfiles, r.toFile, r.toColumn);
      return { ...r, ...scoreRelationshipConfidence(r, toCol) };
    })
    .sort((a, b) => b.overlapPct - a.overlapPct);
}

// ---------------------------------------------------------------------
// Fetch + cache orchestration — the route's one entry point. Backfills
// (or refreshes a stale) profile for any file this dataset actually has,
// then re-detects relationships whenever anything changed.
// ---------------------------------------------------------------------
async function getOrBuildFullProfile(accountId, datasetRowId) {
  const [{ rows: files }, { rows: cached }, { rows: datasetRows }] = await Promise.all([
    pool.query(
      `SELECT file_type, MAX(uploaded_at) AS last_uploaded_at, SUM(row_count) AS row_count
         FROM dataset_files WHERE dataset_id = $1 GROUP BY file_type`,
      [datasetRowId]
    ),
    pool.query(`SELECT file_type, row_count, profile, computed_at FROM dataset_profiles WHERE dataset_id = $1`, [datasetRowId]),
    pool.query(`SELECT profile_relationships FROM uploaded_datasets WHERE id = $1`, [datasetRowId]),
  ]);

  if (files.length === 0) return { files: [], relationships: [] };

  const cachedByType = {};
  cached.forEach((c) => { cachedByType[c.file_type] = c; });

  let anyRecomputed = false;
  const profiles = await Promise.all(files.map(async (f) => {
    const existing = cachedByType[f.file_type];
    const isStale = !existing || new Date(existing.computed_at) < new Date(f.last_uploaded_at);
    if (!isStale) return existing.profile;

    anyRecomputed = true;
    const { rows: recordRows } = await pool.query(
      `SELECT data FROM dataset_records WHERE dataset_id = $1 AND file_type = $2 ORDER BY row_index`,
      [datasetRowId, f.file_type]
    );
    const rawRows = recordRows.map((r) => r.data);
    return upsertFileProfile(pool, {
      datasetRowId, accountId, fileType: f.file_type, rows: rawRows,
    });
  }));

  let relationships = (datasetRows[0] || {}).profile_relationships;
  if (anyRecomputed || relationships === null || relationships === undefined) {
    relationships = detectRelationships(profiles);
    await pool.query(
      `UPDATE uploaded_datasets SET profile_relationships = $2::jsonb WHERE id = $1`,
      [datasetRowId, JSON.stringify(relationships)]
    );
  }

  // The full distinctValues array on every id column only exists to make
  // detectRelationships()'s Set intersection above possible — it's dead
  // weight past this point (up to ~200,000 strings per column) and was
  // never meant to reach the view layer, so it's swapped for a small
  // display sample before the bundle leaves this function.
  const displayProfiles = profiles.map((fp) => ({
    ...fp,
    columns: fp.columns.map((c) => {
      if (c.kind !== 'id' || !c.distinctValues) return c;
      const { distinctValues, ...rest } = c;
      return { ...rest, sampleValues: distinctValues.slice(0, 8) };
    }),
  }));

  // `filesMeta` (the raw file_type + last_uploaded_at rows already
  // fetched above) is handed back alongside the display profiles purely
  // so getOrBuildBusinessIntelligence() below can reuse it for its own
  // staleness check without a second identical query.
  return { files: displayProfiles, relationships, filesMeta: files };
}

// ---------------------------------------------------------------------
// Automatic Dataset Intelligence & Analytics Engine — the orchestration
// layer for services/businessSemantics.js (Column Intelligence +
// Business Semantic Mapping) and services/metricRegistry.js (Analytics
// Generation). Builds on the SAME per-file profiles and cross-file
// relationships getOrBuildFullProfile() already computes and caches —
// this function reuses that call rather than re-profiling anything — and
// adds the piece Full Descriptive Analytics alone can't provide: which
// file is this dataset's transaction fact table, which columns on it
// carry which business meaning, and which joined-in dimension files
// (customers/merchants/products) let CMA-FLOW compute real, cross-file
// business metrics instead of reading one file at a time. See
// claude/business-semantic-metric-engine.md for the full design writeup.
// ---------------------------------------------------------------------

// Two-hop dimension resolution (Round 15) — when the fact table's own
// columns don't carry a customer_id/merchant_id/product_id role directly,
// look for a "bridge" file: one hop away from the fact table via an
// already-measured relationship edge (any of the fact table's own
// columns, typically its order_id), that ITSELF carries a column of the
// target role. This is exactly Olist's real shape: order_items.csv has
// order_id/product_id/seller_id but NO customer_id at all — only
// orders.csv does, one hop away via order_id, and orders.csv's own
// customer_id in turn has its OWN confirmed relationship edge to
// customers.csv (resolved by the existing single-hop block right after
// this is used). Picks the bridge with the strongest first-hop overlap
// when more than one candidate exists. Returns null when no such two-hop
// path is present in this dataset at all.
function findTwoHopBridge(factEntry, targetRole, relationships, semanticModel) {
  let best = null;
  Object.keys(factEntry.columnRoles).forEach((factColName) => {
    relationships.forEach((edge) => {
      let bridgeFileType; let bridgeKeyCol; let factKeyCol;
      if (edge.fromFile === factEntry.fileType && edge.fromColumn === factColName) {
        bridgeFileType = edge.toFile; bridgeKeyCol = edge.toColumn; factKeyCol = edge.fromColumn;
      } else if (edge.toFile === factEntry.fileType && edge.toColumn === factColName) {
        bridgeFileType = edge.fromFile; bridgeKeyCol = edge.fromColumn; factKeyCol = edge.toColumn;
      } else {
        return;
      }
      if (bridgeFileType === factEntry.fileType) return;
      const bridgeFileEntry = semanticModel.files.find((f) => f.fileType === bridgeFileType);
      if (!bridgeFileEntry) return;
      const roleColEntry = Object.entries(bridgeFileEntry.columnRoles).find(([, r]) => r.role === targetRole);
      if (!roleColEntry) return;
      const candidate = {
        bridgeFileType, factKeyCol, bridgeKeyCol, bridgeRoleCol: roleColEntry[0], bridgeRoleColInfo: roleColEntry[1], overlapPct: edge.overlapPct,
      };
      if (!best || candidate.overlapPct > best.overlapPct) best = candidate;
    });
  });
  return best;
}

// Same one-hop-away shape as findTwoHopBridge above, but the target isn't
// a specific business ROLE — it's an order-status / fulfillment-date
// SHAPE (see services/metricRegistry.js's STATUS_NAME_RE /
// ESTIMATED_DATE_NAME_RE / ACTUAL_DATE_NAME_RE). Lets Descriptive
// Analytics compute Delivered/Cancelled order counts and delivery-time
// KPIs from a joined "orders"-shaped file even when the auto-detected
// transaction fact table itself is a line-item file (Olist's
// order_items.csv) with no status or delivery-date columns of its own.
function findFulfillmentBridge(factEntry, relationships, semanticModel, profiles) {
  let best = null;
  Object.keys(factEntry.columnRoles).forEach((factColName) => {
    relationships.forEach((edge) => {
      let bridgeFileType; let bridgeKeyCol; let factKeyCol;
      if (edge.fromFile === factEntry.fileType && edge.fromColumn === factColName) {
        bridgeFileType = edge.toFile; bridgeKeyCol = edge.toColumn; factKeyCol = edge.fromColumn;
      } else if (edge.toFile === factEntry.fileType && edge.toColumn === factColName) {
        bridgeFileType = edge.fromFile; bridgeKeyCol = edge.fromColumn; factKeyCol = edge.toColumn;
      } else {
        return;
      }
      if (bridgeFileType === factEntry.fileType) return;
      const bridgeProfile = profiles.find((p) => p.fileType === bridgeFileType);
      if (!bridgeProfile) return;
      const hasStatus = bridgeProfile.columns.some((c) => c.kind === 'category' && STATUS_NAME_RE.test(c.name));
      const hasDatePair = bridgeProfile.columns.some((c) => c.kind === 'date' && ESTIMATED_DATE_NAME_RE.test(c.name))
        && bridgeProfile.columns.some((c) => c.kind === 'date' && ACTUAL_DATE_NAME_RE.test(c.name));
      if (!hasStatus && !hasDatePair) return;
      const candidate = {
        bridgeFileType, factKeyCol, bridgeKeyCol, overlapPct: edge.overlapPct,
      };
      if (!best || candidate.overlapPct > best.overlapPct) best = candidate;
    });
  });
  return best;
}
// Builds the raw cross-file business context (the fact table's rows plus
// its resolved customer/merchant/product dimension joins) that both
// getOrBuildBusinessIntelligence() below and services/predictiveAnalytics
// Dynamic.js need — extracted into its own function so a caller that needs
// the actual ROWS (not just the cached metrics/diagnostics summary
// getOrBuildBusinessIntelligence() persists) doesn't have to re-implement
// fact-table/dimension resolution a second time. Deliberately UNCACHED —
// the ctx it returns carries full row arrays, too large to persist in the
// business_intelligence JSONB column, and re-running it is a handful of
// indexed queries, not a heavy computation. Returns
// { applicable: false, reason, semanticModel, financialProfile } when
// there's nothing to compute from, otherwise { applicable: true, ctx,
// semanticModel, financialProfile, factFileType, dimensionsUsed,
// latestUpload }.
async function buildBusinessContext(accountId, datasetRowId) {
  const { files: profiles, relationships, filesMeta } = await getOrBuildFullProfile(accountId, datasetRowId);
  if (profiles.length === 0) {
    return {
      applicable: false,
      reason: 'No uploaded files yet.',
      semanticModel: null,
      financialProfile: { applicable: false, reason: 'No uploaded files yet.' },
    };
  }

  let semanticModel;
  try {
    semanticModel = buildSemanticModelHybrid(profiles, relationships);
  } catch (err) {
    // Defensive fallback — the hybrid layer already catches its own
    // internal errors and degrades to rule-only internally (see
    // semanticFieldEngine.js), but if buildSemanticModelHybrid itself
    // ever throws before reaching that internal try/catch (e.g. a
    // required ML package fails to load at require-time), every dynamic
    // analytics page in this app must still work exactly as it did
    // before this round — never a hard failure over an optional
    // enhancement layer.
    console.error('[fullDescriptiveAnalytics] buildSemanticModelHybrid failed, falling back to rule-only buildSemanticModel:', err.message);
    semanticModel = buildSemanticModel(profiles, relationships);
  }
  // Dataset-level business-domain / financial-measure classification
  // (business domain, dataset type, primary financial measure, likely
  // usage measure, whether direct customer revenue is present) — computed
  // fresh alongside the semantic model every time, off the SAME resolved
  // column roles the metrics below read from, so it's never allowed to
  // drift out of sync with what the metrics actually compute.
  const financialProfile = classifyDatasetFinancialProfile(semanticModel, profiles);

  const latestUpload = filesMeta.reduce(
    (max, f) => (new Date(f.last_uploaded_at) > max ? new Date(f.last_uploaded_at) : max),
    new Date(0)
  );

  if (!semanticModel.factFileType) {
    // No file in the dataset looks like a transaction/event row carrying
    // a real monetary measure — e.g. a dataset of purely descriptive
    // dimension files (a menu, a restaurant list) with no orders file at
    // all. Reported honestly as not applicable, never as a revenue of 0.
    return {
      applicable: false,
      reason: 'No uploaded file in this dataset contains a revenue-like measure paired with a transaction/date structure — nothing here looks like a sales or billing record yet.',
      semanticModel,
      financialProfile,
      latestUpload,
    };
  }

  const factEntry = semanticModel.files.find((f) => f.fileType === semanticModel.factFileType);
  const factFileProfile = profiles.find((p) => p.fileType === semanticModel.factFileType) || null;
  const { rows: factRecordRows } = await pool.query(
    `SELECT data FROM dataset_records WHERE dataset_id = $1 AND file_type = $2 ORDER BY row_index`,
    [datasetRowId, semanticModel.factFileType]
  );
  const factRows = factRecordRows.map((r) => r.data);

  // Row-fetch cache shared by the two-hop bridge resolution, the dimension
  // resolution block, and the fulfillment-bridge lookup below — an
  // Olist-shaped dataset commonly resolves customer_id AND the fulfillment
  // metrics through the SAME "orders" file, and this avoids fetching it
  // more than once.
  const fileRowsCache = {};
  async function fetchFileRows(fileType) {
    if (!fileRowsCache[fileType]) {
      const { rows: recordRows } = await pool.query(
        `SELECT data FROM dataset_records WHERE dataset_id = $1 AND file_type = $2 ORDER BY row_index`,
        [datasetRowId, fileType]
      );
      fileRowsCache[fileType] = recordRows.map((r) => r.data);
    }
    return fileRowsCache[fileType];
  }

  // Two-hop dimension bridging — materializes a virtual column directly
  // onto the fact table's own rows/columnRoles for any of customer_id/
  // merchant_id/product_id that has no NATIVE column on the fact table but
  // IS reachable one file away (see findTwoHopBridge above) — e.g. Olist's
  // order_items.csv has no customer_id at all; only orders.csv does, one
  // hop away via order_id. Once materialized, the existing single-hop
  // resolution block right below finds and joins it exactly like a native
  // column — no other code (here or in services/metricRegistry.js/
  // diagnosticEngine.js/predictiveAnalyticsDynamic.js) needs to know the
  // difference.
  await Promise.all(['customer_id', 'merchant_id', 'product_id'].map(async (role) => {
    if (findRoleColumn(factEntry, role)) return; // already resolvable directly
    const bridge = findTwoHopBridge(factEntry, role, relationships, semanticModel);
    if (!bridge) return;
    const bridgeRows = await fetchFileRows(bridge.bridgeFileType);
    const bridgeMap = new Map();
    bridgeRows.forEach((row) => {
      const k = row[bridge.bridgeKeyCol];
      const v = row[bridge.bridgeRoleCol];
      if (k === undefined || k === null || String(k).trim() === '') return;
      if (v === undefined || v === null || String(v).trim() === '') return;
      bridgeMap.set(String(k).trim(), String(v).trim());
    });
    // Prefer the role's own natural name ("customer_id") as the
    // materialized column's key — every generator's provenance text
    // (PAYING_CUSTOMERS, REVENUE_BY_CUSTOMER, ...) interpolates this name
    // straight into an SME-facing sentence ('Distinct "customer_id"
    // values...'), so it needs to read like a real column, not an
    // internal implementation detail. Only falls back to a prefixed name
    // on the rare chance the fact table already has an UNCLAIMED column
    // literally named "customer_id" for some other purpose.
    const nameTaken = factFileProfile && factFileProfile.columns.some((c) => c.name === role);
    const virtualCol = nameTaken ? `__bridged_${role}` : role;
    let resolvedCount = 0;
    factRows.forEach((row) => {
      const k = row[bridge.factKeyCol];
      const resolved = (k !== undefined && k !== null) ? bridgeMap.get(String(k).trim()) : undefined;
      if (resolved !== undefined) { row[virtualCol] = resolved; resolvedCount += 1; }
    });
    if (resolvedCount === 0) return; // the bridge produced nothing usable — leave the role unresolved rather than adding a dead column
    factEntry.columnRoles[virtualCol] = {
      role,
      confidence: 0.75,
      band: 'High',
      evidence: [`Resolved via a two-file join: ${factEntry.fileType}.${bridge.factKeyCol} → ${bridge.bridgeFileType}.${bridge.bridgeKeyCol} → ${bridge.bridgeFileType}.${bridge.bridgeRoleCol} (${bridge.overlapPct.toFixed(1)}% coverage on the first hop, ${((resolvedCount / factRows.length) * 100).toFixed(1)}% of rows resolved).`],
      relationshipEdge: bridge.bridgeRoleColInfo.relationshipEdge || null,
      bridged: true,
      bridgeInfo: {
        viaFile: bridge.bridgeFileType, viaFactColumn: bridge.factKeyCol, viaBridgeColumn: bridge.bridgeKeyCol, firstHopOverlapPct: bridge.overlapPct,
      },
    };
  }));

  // For every foreign-key role the fact table carries (native OR
  // just-materialized via the two-hop bridge above), resolve the ACTUAL
  // joined dimension file — only when businessSemantics.js already
  // attached a confirmed, value-overlap-measured relationship edge to
  // that column (see relationshipEvidence() there). A role with no
  // confirmed edge still computes correctly below (grouped by the raw
  // id), it just can't show a human-readable name for it.
  const dimensions = {};
  await Promise.all(['customer_id', 'merchant_id', 'product_id'].map(async (role) => {
    const col = findRoleColumn(factEntry, role);
    if (!col || !col.relationshipEdge) { dimensions[role] = null; return; }
    const edge = col.relationshipEdge;
    // The edge touches exactly one file on each side. For a NATIVE column
    // that's always the fact table itself; for a BRIDGED column (see
    // above) it's the bridge file the role column actually lives on —
    // ownerFileType names whichever one is correct here, so "the other
    // side" always resolves to the true dimension file regardless of
    // which side of the edge happens to be fromFile/toFile.
    const ownerFileType = col.bridged ? col.bridgeInfo.viaFile : semanticModel.factFileType;
    const dimFileType = edge.fromFile === ownerFileType ? edge.toFile : edge.fromFile;
    const dimIdColumn = edge.fromFile === ownerFileType ? edge.toColumn : edge.fromColumn;
    const dimFileEntry = semanticModel.files.find((f) => f.fileType === dimFileType);
    const labelEntry = dimFileEntry
      ? Object.entries(dimFileEntry.columnRoles).find(([, r]) => r.role === 'name_label') : null;
    const labelColumn = labelEntry ? labelEntry[0] : null;

    // Geography is resolved the SAME way as a display label — a column
    // on the joined dimension file, not the fact table itself — for the
    // "indirect" shape (Olist: order rows carry customer_id, and it's
    // customers.csv that carries customer_state, not orders.csv). The
    // "direct" shape (a GCP billing export's own Region_Zone column
    // sitting right on the fact table) needs no lookup at all — see
    // services/metricRegistry.js's resolveGeo(), which checks the fact
    // table's own columns first and only falls back to this lookup.
    const geoEntry = dimFileEntry
      ? Object.entries(dimFileEntry.columnRoles).find(([, r]) => r.role === 'geo_dimension') : null;
    const geoColumn = geoEntry ? geoEntry[0] : null;

    // Category is resolved the same indirect way, for a dataset whose
    // category label lives on the joined product/merchant dimension file
    // rather than the fact table itself (Olist: product_category_name on
    // products.csv, not order_items.csv) — see services/metricRegistry.js's
    // resolveCategoryColumn(), which checks the fact table's own columns
    // first and only falls back to this lookup. A formal 'cost_category'
    // role wins first; otherwise any unclaimed, category-kind column whose
    // name reads as a classification (the same GENERIC_CATEGORY_NAME_RE
    // resolveCategoryColumn() itself uses for the direct case).
    let categoryColumn = null;
    if (dimFileEntry) {
      const categoryRoleEntry = Object.entries(dimFileEntry.columnRoles).find(([, r]) => r.role === 'cost_category');
      if (categoryRoleEntry) {
        categoryColumn = categoryRoleEntry[0];
      } else {
        const dimProfile = profiles.find((p) => p.fileType === dimFileType);
        if (dimProfile) {
          const claimed = new Set(Object.keys(dimFileEntry.columnRoles || {}));
          const generic = dimProfile.columns.find((c) => c.kind === 'category' && !claimed.has(c.name) && GENERIC_CATEGORY_NAME_RE.test(c.name));
          if (generic) categoryColumn = generic.name;
        }
      }
    }

    // Round 21 — a joined product/merchant dimension's own 'price' role
    // column (a catalog/listed price, e.g. products.csv's own "price") is
    // a genuinely different figure from the fact table's own
    // transactional price/revenue (order_items.item_price) — the decision
    // variable a price what-if scenario should adjust. Resolved the same
    // indirect way as categoryColumn/geoColumn above; see
    // services/metricRegistry.js's resolveCatalogPrice() for how a
    // consumer reads this.
    const priceRoleEntry = dimFileEntry
      ? Object.entries(dimFileEntry.columnRoles).find(([, r]) => r.role === 'price') : null;
    const priceColumn = priceRoleEntry ? priceRoleEntry[0] : null;

    const dimRows = await fetchFileRows(dimFileType);
    dimensions[role] = {
      fileType: dimFileType,
      idColumn: dimIdColumn,
      labelColumn,
      geoColumn,
      categoryColumn,
      priceColumn,
      lookup: buildDimensionLookup(dimRows, dimIdColumn, labelColumn),
      geoLookup: geoColumn ? buildDimensionLookup(dimRows, dimIdColumn, geoColumn) : null,
      categoryLookup: categoryColumn ? buildDimensionLookup(dimRows, dimIdColumn, categoryColumn) : null,
      priceLookup: priceColumn ? buildNumericDimensionLookup(dimRows, dimIdColumn, priceColumn) : null,
      overlapPct: edge.overlapPct,
      joinPath: [
        ...(col.bridged ? [{
          fromFile: semanticModel.factFileType, fromColumn: col.bridgeInfo.viaFactColumn, toFile: col.bridgeInfo.viaFile, toColumn: col.bridgeInfo.viaBridgeColumn, overlapPct: col.bridgeInfo.firstHopOverlapPct,
        }] : []),
        {
          fromFile: edge.fromFile, fromColumn: edge.fromColumn, toFile: edge.toFile, toColumn: edge.toColumn, overlapPct: edge.overlapPct,
        },
      ],
    };
  }));

  // Fulfillment/order-status bridge — a small, separate lookup (not one of
  // the three dimension roles above) for Descriptive Analytics' Delivered/
  // Cancelled order counts and delivery-time KPIs when the fact table
  // itself carries no order-status or delivery-date columns (Olist: those
  // live on orders.csv, not order_items.csv). Only attached when the fact
  // table's OWN profile doesn't already have what's needed directly —
  // services/metricRegistry.js's buildLinkedOrderFileMetrics() checks the
  // fact table first and only reads this as a fallback.
  let linkedOrderFile = null;
  const factHasStatus = factFileProfile && factFileProfile.columns.some((c) => c.kind === 'category' && STATUS_NAME_RE.test(c.name));
  const factHasDatePair = factFileProfile
    && factFileProfile.columns.some((c) => c.kind === 'date' && ESTIMATED_DATE_NAME_RE.test(c.name))
    && factFileProfile.columns.some((c) => c.kind === 'date' && ACTUAL_DATE_NAME_RE.test(c.name));
  if (!factHasStatus && !factHasDatePair) {
    const fBridge = findFulfillmentBridge(factEntry, relationships, semanticModel, profiles);
    if (fBridge) {
      const linkedRows = await fetchFileRows(fBridge.bridgeFileType);
      const linkedProfile = profiles.find((p) => p.fileType === fBridge.bridgeFileType);
      linkedOrderFile = {
        fileType: fBridge.bridgeFileType,
        rows: linkedRows,
        profile: linkedProfile,
        joinNote: `joined via ${factEntry.fileType}.${fBridge.factKeyCol} → ${fBridge.bridgeFileType}.${fBridge.bridgeKeyCol} (${fBridge.overlapPct.toFixed(1)}% coverage)`,
      };
    }
  }

  const ctx = {
    factFile: { fileType: semanticModel.factFileType, rows: factRows, columnRoles: factEntry.columnRoles },
    factFileProfile,
    dimensions,
    relationships,
    linkedOrderFile,
  };

  return {
    applicable: true,
    ctx,
    semanticModel,
    financialProfile,
    factFileType: semanticModel.factFileType,
    dimensionsUsed: Object.entries(dimensions)
      .filter(([, d]) => d)
      .map(([role, d]) => ({ role, fileType: d.fileType, overlapPct: d.overlapPct })),
    latestUpload,
  };
}

// ---------------------------------------------------------------------
// In-process cache for buildBusinessContext()'s result — the content-aware
// engine's one genuinely expensive step (a full fetch of every row of the
// dataset's fact table plus every two-hop bridge/dimension file, then the
// whole semantic-model/relationship-bridge resolution on top). It cannot
// be persisted to the business_intelligence JSONB column the way the
// smaller metrics/diagnostics summary is (see buildBusinessContext's own
// header comment — ctx carries full row arrays, too large for that
// column), so before this cache existed, EVERY caller that needed the raw
// ctx paid the full cost on every single call: getOrBuildBusinessIntelligence()
// itself on a cache miss, Predictive Analytics' Dynamic mode on every page
// load with no caching at all, and Prescriptive Recommendations' Dynamic
// tab TWICE per load (once via getOrBuildBusinessIntelligence(), then a
// second, fully redundant call right after). Since all four analytics
// pages (Descriptive, Diagnostic, Predictive, Prescriptive) read from this
// same fact-table business context, caching it once here — keyed by
// dataset, invalidated the same way getOrBuildBusinessIntelligence()
// already invalidates its own cache (a fresh upload's timestamp moving
// past the cached computedAt) — means navigating between them on the same
// dataset only pays the real cost once, not once per page.
//
// Process-memory only, not shared across server instances or restarts —
// acceptable here because this app already has no multi-instance/
// clustered deployment story (see server.js), and a restart is already
// required after every code change in this project (view caching, same
// reasoning). Capped at MAX_CACHED_CONTEXTS datasets, evicting the oldest
// entry first (Map preserves insertion order in JS), so a long-running
// process working through many different datasets over time can't grow
// this cache without bound.
const businessContextCache = new Map(); // datasetRowId -> { result, latestUpload }
const MAX_CACHED_CONTEXTS = 25;

async function getOrBuildBusinessContext(accountId, datasetRowId) {
  const cached = businessContextCache.get(datasetRowId);
  if (cached) {
    const { rows: uploadRows } = await pool.query(
      'SELECT MAX(uploaded_at) AS latest FROM dataset_files WHERE dataset_id = $1', [datasetRowId]
    );
    const latestUploadNow = (uploadRows[0] || {}).latest;
    if (latestUploadNow && new Date(cached.latestUpload) >= new Date(latestUploadNow)) {
      return cached.result;
    }
    businessContextCache.delete(datasetRowId); // stale — a newer file landed since this was cached
  }

  const result = await buildBusinessContext(accountId, datasetRowId);
  // Only a genuinely applicable result is worth caching — the inapplicable
  // case (no fact table found) never reaches the expensive row-fetch step
  // inside buildBusinessContext() anyway, so there's nothing costly to save.
  if (result.applicable) {
    if (businessContextCache.size >= MAX_CACHED_CONTEXTS && !businessContextCache.has(datasetRowId)) {
      const oldestKey = businessContextCache.keys().next().value;
      businessContextCache.delete(oldestKey);
    }
    businessContextCache.set(datasetRowId, { result, latestUpload: result.latestUpload });
  }
  return result;
}

async function getOrBuildBusinessIntelligence(accountId, datasetRowId) {
  // Cheap freshness check FIRST, before paying for buildBusinessContext()
  // below. buildBusinessContext() fetches every row of the dataset's fact
  // table PLUS every row of every two-hop bridge file it needs (Olist:
  // order_items, then orders, then customers/products/sellers — each
  // potentially 100K+ rows) straight out of Postgres, then re-runs the
  // whole semantic-model/relationship-bridge resolution — real, heavy
  // work a cache hit should never have to pay for. The original version of
  // this function called buildBusinessContext() unconditionally, BEFORE
  // ever checking whether a valid cached bundle already existed, so the
  // business_intelligence cache built in round 14 never actually saved the
  // expensive part — every page load of Descriptive/Diagnostic/Predictive/
  // Prescriptive re-did the full row fetch and join regardless of whether
  // anything had changed. This two-phase version checks the cache with two
  // small, indexed queries first, and only falls through to the full
  // rebuild when the cache is actually missing or stale.
  const [{ rows: cachedRows }, { rows: uploadRows }] = await Promise.all([
    pool.query('SELECT business_intelligence FROM uploaded_datasets WHERE id = $1', [datasetRowId]),
    pool.query('SELECT MAX(uploaded_at) AS latest FROM dataset_files WHERE dataset_id = $1', [datasetRowId]),
  ]);
  const cachedFast = (cachedRows[0] || {}).business_intelligence;
  const latestUploadFast = (uploadRows[0] || {}).latest;
  // Same required-shape checks as the full comparison below (`diagnostics`
  // required so a bundle cached by an older server build — before the
  // diagnostic-analytics engine existed — is recomputed once rather than
  // served forever without it) minus the `factFileType` equality check,
  // which needs a freshly recomputed semantic model to compare against and
  // so isn't available on this fast path — the timestamp guard alone is
  // sufficient for the common case (repeat views, no new upload); the one
  // scenario it can't catch is a server code change that alters fact-table
  // detection with no new upload, which the slow path below still checks
  // for the same account+dataset on this call if the fast path is skipped.
  if (cachedFast && cachedFast.computedAt && latestUploadFast
    && new Date(cachedFast.computedAt) >= new Date(latestUploadFast)
    && cachedFast.financialProfile && cachedFast.diagnostics) {
    return cachedFast;
  }

  // Routed through the in-process ctx cache (see getOrBuildBusinessContext
  // above) rather than calling buildBusinessContext() directly — so when
  // THIS function is the one that ends up doing the full rebuild (cache
  // miss or stale), the resulting ctx is also immediately available to
  // Predictive Analytics' Dynamic mode and Prescriptive Recommendations'
  // Dynamic tab without either of them paying the row-fetch cost again.
  const built = await getOrBuildBusinessContext(accountId, datasetRowId);
  if (!built.applicable) {
    return {
      applicable: false,
      reason: built.reason,
      semanticModel: built.semanticModel,
      financialProfile: built.financialProfile,
      metrics: [],
      diagnostics: [],
      dimensionsUsed: [],
      factFileType: null,
      computedAt: new Date().toISOString(),
    };
  }

  // Re-check against the now-fully-computed `built.factFileType` in case
  // the fast path above was skipped (cache stale/missing) but a fresh
  // write landed between the two queries above and this point — the same
  // full comparison the original single-phase version always ran.
  const cached = cachedFast;
  if (cached && cached.computedAt && new Date(cached.computedAt) >= built.latestUpload
    && cached.factFileType === built.factFileType && cached.financialProfile
    && cached.diagnostics) {
    return cached;
  }

  const metrics = evaluateMetrics(built.ctx);
  // Diagnostic Analytics engine (services/diagnosticEngine.js) — reuses
  // the EXACT SAME ctx metrics just used, so it never re-fetches the
  // fact/dimension rows already in hand here, and its 12 findings can
  // never disagree with the descriptive metrics/business intelligence
  // above about what the fact table's roles or joined dimensions are.
  const diagnostics = evaluateDiagnostics(built.ctx);

  const bundle = {
    applicable: true,
    semanticModel: built.semanticModel,
    financialProfile: built.financialProfile,
    factFileType: built.factFileType,
    dimensionsUsed: built.dimensionsUsed,
    metrics,
    diagnostics,
    computedAt: new Date().toISOString(),
  };

  await pool.query(
    'UPDATE uploaded_datasets SET business_intelligence = $2::jsonb WHERE id = $1',
    [datasetRowId, JSON.stringify(bundle)]
  );
  return bundle;
}

// ---------------------------------------------------------------------
// Scatter-plot sample points for one pair of measure columns in one file.
// services/datasetProfiler.js's computeCorrelations() only ever persists
// the Pearson r COEFFICIENT for a pair (see profileFile()) — never the
// raw (x, y) points themselves, to keep the cached per-file profile small
// on a wide dataset with many measure columns. So a scatter chart (unlike
// every other Full Descriptive Analytics chart, which reads straight off
// the cached profile) needs its own small, targeted, on-demand query —
// only ever run for the 1-2 strongest correlations actually being
// rendered, never for every pair up front. Deliberately capped at
// `limit` points: a scatter chart's job is to show the SHAPE of a
// relationship, not plot every row, and an uncapped SVG on a
// hundred-thousand-row file would bloat the page for no visual benefit.
async function getCorrelationSample(datasetRowId, fileType, colA, colB, limit = 300) {
  // Pre-fetch a bound well above `limit` (rather than every row of a
  // huge file) so a scatter chart on a 500k-row file doesn't pull the
  // whole file into memory just to plot 300 points of it.
  const { rows: recordRows } = await pool.query(
    `SELECT data FROM dataset_records WHERE dataset_id = $1 AND file_type = $2 ORDER BY row_index LIMIT $3`,
    [datasetRowId, fileType, Math.max(limit * 20, 5000)]
  );
  const points = [];
  for (let i = 0; i < recordRows.length && points.length < limit; i += 1) {
    const row = recordRows[i].data;
    const x = tryParseNumber(row[colA]);
    const y = tryParseNumber(row[colB]);
    if (x !== null && y !== null) points.push({ x, y });
  }
  return points;
}

module.exports = {
  upsertFileProfile,
  detectRelationships,
  getOrBuildFullProfile,
  getOrBuildBusinessIntelligence,
  // getOrBuildBusinessContext is what routes/services needing the raw ctx
  // (fact rows + resolved dimensions) directly — Predictive Analytics'
  // Dynamic mode, Prescriptive Recommendations' Dynamic tab, services/
  // predictiveAnalyticsDynamic.js's callers — should call. getOrBuild
  // BusinessIntelligence() only returns/caches the smaller evaluated
  // metrics/diagnostics summary, not the rows themselves; getOrBuild
  // BusinessContext() is the in-process cache in front of the full ctx (see
  // its own header comment above). buildBusinessContext is still exported
  // too, as the uncached raw builder getOrBuildBusinessContext wraps —
  // prefer the cached wrapper in new code.
  getOrBuildBusinessContext,
  buildBusinessContext,
  getCorrelationSample,
  candidateKeyPairs,
  looksRelated,
};
