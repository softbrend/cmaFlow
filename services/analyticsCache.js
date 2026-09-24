// Analytics result cache — the same two-phase caching pattern
// getOrBuildBusinessIntelligence() (services/fullDescriptiveAnalytics.js)
// already uses for the 'dynamic' fact-table pathway, generalized so the
// 'raw' pathway (Diagnostic Insights' revenue-bridge/cancellation-
// reasons/price-change-impact/coverage views, Predictive/Prescriptive's
// raw source) can use it too. That pathway had no caching at all: every
// page load re-fetched every row of dataset_records for the dataset and
// re-ran the full computation, regardless of which tab was open — real
// cost on a large upload (hundreds of thousands of rows), paid again on
// every click between tabs.
//
// The freshness check is deliberately cheap and separate from the
// expensive compute: MAX(uploaded_at) on dataset_files is a small,
// indexed aggregate, nothing like re-fetching every dataset_records row.
// A cache hit costs exactly two small queries; a miss costs those two
// plus whatever the caller's computeFn does (same as before caching
// existed) plus one upsert.
const pool = require('../db/pool');

async function getLatestUpload(datasetRowId) {
  const { rows } = await pool.query(
    'SELECT MAX(uploaded_at) AS latest FROM dataset_files WHERE dataset_id = $1',
    [datasetRowId]
  );
  return rows[0] && rows[0].latest ? rows[0].latest : null;
}

// Returns computeFn()'s result, from cache when a fresh one exists for
// this (datasetRowId, cacheKey). computeFn is only called on a miss —
// never speculatively. If the dataset has no uploaded files yet (no
// latest_upload to pin the cache to), caching is skipped entirely and
// computeFn's result is returned uncached — that case is cheap anyway
// (nothing to compute over) and never worth a cache row.
async function getOrCompute(datasetRowId, accountId, cacheKey, computeFn) {
  const latestUpload = await getLatestUpload(datasetRowId);
  if (latestUpload) {
    const { rows } = await pool.query(
      `SELECT payload, latest_upload FROM analytics_result_cache
        WHERE dataset_id = $1 AND cache_key = $2`,
      [datasetRowId, cacheKey]
    );
    const cached = rows[0];
    if (cached && new Date(cached.latest_upload).getTime() === new Date(latestUpload).getTime()) {
      return cached.payload;
    }
  }

  const result = await computeFn();

  if (latestUpload) {
    await pool.query(
      `INSERT INTO analytics_result_cache (dataset_id, account_id, cache_key, latest_upload, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (dataset_id, cache_key)
       DO UPDATE SET account_id = excluded.account_id, latest_upload = excluded.latest_upload,
                      payload = excluded.payload, computed_at = now()`,
      [datasetRowId, accountId, cacheKey, latestUpload, JSON.stringify(result)]
    );
  }

  return result;
}

// In-process variant — same staleness check (compare against
// dataset_files' latest upload), but held in a module-level Map instead
// of Postgres, so a hit costs nothing to (de)serialize. Use this instead
// of getOrCompute() when the computed bundle itself is large enough that
// round-tripping it through JSONB on every request is itself a real
// cost — a per-customer feature array over a large customer base, for
// instance, can run into several MB, and moving that through Postgres on
// every "cache hit" undercuts the point of caching. Same convention as
// services/fullDescriptiveAnalytics.js's businessContextCache: bounded
// size (oldest entry evicted first), doesn't survive a server restart
// (an acceptable trade — the first request after a restart just
// recomputes, same as any cold cache), never shared across instances.
const IN_PROCESS_CACHES = new Map(); // cacheKey -> Map(datasetRowId -> { result, latestUpload })
const MAX_IN_PROCESS_ENTRIES_PER_KEY = 20;

async function getOrComputeInProcess(datasetRowId, accountId, cacheKey, computeFn) {
  if (!IN_PROCESS_CACHES.has(cacheKey)) IN_PROCESS_CACHES.set(cacheKey, new Map());
  const store = IN_PROCESS_CACHES.get(cacheKey);

  const cached = store.get(datasetRowId);
  const latestUpload = await getLatestUpload(datasetRowId);
  if (cached && latestUpload && new Date(cached.latestUpload).getTime() === new Date(latestUpload).getTime()) {
    return cached.result;
  }
  if (cached && !latestUpload) {
    // No dataset_files row at all (shouldn't normally happen once data
    // exists) — fall through and recompute rather than trust a cache
    // entry we can no longer validate.
    store.delete(datasetRowId);
  }

  const result = await computeFn();

  if (latestUpload) {
    if (store.size >= MAX_IN_PROCESS_ENTRIES_PER_KEY && !store.has(datasetRowId)) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
    store.set(datasetRowId, { result, latestUpload });
  }

  return result;
}

module.exports = { getOrCompute, getOrComputeInProcess };
