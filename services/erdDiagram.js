// Entity-Relationship Diagram generation — a deterministic, dataset-
// agnostic algorithm that turns the profiling this app already computes
// (services/datasetProfiler.js's per-column stats, services/
// fullDescriptiveAnalytics.js's detectRelationships()) into a Mermaid
// `erDiagram` definition: one entity box per uploaded file, its columns
// as attributes with PK/FK markers, and one relationship line per
// confirmed cross-file match, labeled with real measured overlap.
//
// Deliberately NOT an LLM call or an external diagramming API: every box
// and every line traces to a stat already sitting in the cached profile
// (a duplicate count, an overlap percentage) — the same dataset uploaded
// twice always produces the identical diagram, same discipline as
// services/businessSemantics.js. See claude/erd-diagram.md for the
// design writeup.
//
// Pure functions only (no DB, no I/O) — the route in routes/dashboard.js
// is the DB-aware layer: it calls getOrBuildFullProfile() (already
// cached from the Full Descriptive Analytics / Business Metrics work)
// and hands the result straight to buildErdDefinition() below, so this
// module never re-profiles or re-queries anything of its own.

// A file's column list can run into the dozens (the real Airbnb
// `listings.csv` sample tested elsewhere in this app has 92 columns) —
// past a certain point an entity box stops being a diagram and becomes
// unreadable wallpaper, so each box is capped and the rest summarized.
const MAX_ERD_ATTRIBUTES = 14;

// Mermaid ER attribute "type" tokens must be bare words (no punctuation)
// — this maps datasetProfiler.js's richer kind vocabulary down to the
// handful of type words Mermaid expects, purely for display.
const KIND_TO_ERD_TYPE = {
  numeric: 'number',
  currency: 'currency',
  percentage: 'percent',
  rating: 'rating',
  date: 'date',
  boolean: 'boolean',
  geo_lat: 'number',
  geo_lng: 'number',
  url: 'string',
  id: 'string',
  category: 'string',
  text: 'string',
  empty: 'string',
};
function erdType(kind) {
  return KIND_TO_ERD_TYPE[kind] || 'string';
}

// Mermaid entity names and attribute names both need to be bare
// identifier-shaped tokens — real CSV headers are usually already
// snake_case and pass through untouched, but this defends against
// spaces, punctuation, or a leading digit without silently dropping the
// original name (kept as a quoted comment on the attribute line instead).
function sanitizeToken(raw, fallback) {
  let s = String(raw || '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (/^[0-9]/.test(s)) s = `f_${s}`;
  return s;
}

function sanitizeEntityId(fileType) {
  return sanitizeToken(fileType, 'ENTITY').toUpperCase();
}

// Mermaid relationship / comment labels are quoted strings — strip the
// one character (") that would prematurely close the quote; everything
// else (spaces, %, parens) is fine inside a quoted label.
function safeLabel(text) {
  return String(text).replace(/"/g, "'");
}

// Assigns every uploaded file a unique, Mermaid-safe entity id, so two
// file types that sanitize to the same token (e.g. "Orders 2026" and
// "orders-2026") don't collide into one box.
function buildEntityIdMap(fileProfiles) {
  const idMap = {};
  const used = new Set();
  fileProfiles.forEach((fp) => {
    let id = sanitizeEntityId(fp.fileType);
    let n = 2;
    while (used.has(id)) {
      id = `${sanitizeEntityId(fp.fileType)}_${n}`;
      n += 1;
    }
    used.add(id);
    idMap[fp.fileType] = id;
  });
  return idMap;
}

// A file's own primary key candidate(s): columns datasetProfiler.js
// already classified kind 'id' whose values never repeat
// (duplicateCount === 0, from profileId() — see services/
// datasetProfiler.js). This is the same "keys don't repeat, foreign keys
// do" distinction services/fullDescriptiveAnalytics.js already leans on
// for relationship overlap, just read straight off the cached stats
// rather than recomputed.
//
// A short, fully-unique text column (e.g. a "name" field in a small
// dimension file) can also land in kind 'id' — datasetProfiler.js's own
// short-code fallback heuristic, not a bug specific to this module (see
// claude/business-semantic-metric-engine.md's "known limitations" for
// the same quirk surfacing elsewhere). When an actual id-NAMED column
// (id / *_id / *_uuid / *_guid) is present among the candidates, it's
// preferred as the sole PK so a diagram doesn't show two "primary keys"
// on one box; only when nothing matches that naming convention do all
// unique id-kind columns get marked, which is still better than marking
// none.
const ID_NAME_RE = /(?:^|_)(?:id|uuid|guid)$/i;
function primaryKeyNames(columns) {
  const candidates = columns.filter((c) => c.kind === 'id' && c.duplicateCount === 0);
  const named = candidates.filter((c) => ID_NAME_RE.test(c.name));
  const chosen = named.length > 0 ? named : candidates;
  return new Set(chosen.map((c) => c.name));
}

// One pass over every confirmed relationship to (a) decide which side is
// the "one" and which is the "many" — from the same duplicateCount stat,
// not from the arbitrary from/to order detectRelationships() happened to
// emit — and (b) collect the resulting foreign-key column names per
// file, so the entity-box pass below can mark them without a second
// lookup into the relationship list.
function classifyRelationships(fileProfiles, relationships) {
  const fkColumnsByFile = {};
  const edges = [];

  (relationships || []).forEach((r) => {
    const fpFrom = fileProfiles.find((fp) => fp.fileType === r.fromFile);
    const fpTo = fileProfiles.find((fp) => fp.fileType === r.toFile);
    if (!fpFrom || !fpTo) return;
    const colFrom = fpFrom.columns.find((c) => c.name === r.fromColumn);
    const colTo = fpTo.columns.find((c) => c.name === r.toColumn);
    if (!colFrom || !colTo) return;

    const fromIsOne = colFrom.duplicateCount === 0;
    const toIsOne = colTo.duplicateCount === 0;

    if (!fromIsOne) {
      fkColumnsByFile[r.fromFile] = fkColumnsByFile[r.fromFile] || new Set();
      fkColumnsByFile[r.fromFile].add(r.fromColumn);
    }
    if (!toIsOne) {
      fkColumnsByFile[r.toFile] = fkColumnsByFile[r.toFile] || new Set();
      fkColumnsByFile[r.toFile].add(r.toColumn);
    }

    let symbol;
    let cardinality;
    if (fromIsOne && toIsOne) {
      symbol = '||--||';
      cardinality = '1:1';
    } else if (fromIsOne && !toIsOne) {
      symbol = '||--o{';
      cardinality = '1:many';
    } else if (!fromIsOne && toIsOne) {
      symbol = '}o--||';
      cardinality = 'many:1';
    } else {
      symbol = '}o--o{';
      cardinality = 'many:many';
    }

    edges.push({
      fromFile: r.fromFile,
      fromColumn: r.fromColumn,
      toFile: r.toFile,
      toColumn: r.toColumn,
      overlapPct: r.overlapPct,
      symbol,
      cardinality,
    });
  });

  return { fkColumnsByFile, edges };
}

// Which columns actually make it into an entity's box, and how many were
// left out — PK and FK columns always win a slot (they're the reason the
// box connects to anything), then measure-shaped columns (the ones an
// SME owner is most likely to recognize the file by), then everything
// else in its original column order.
function pickDisplayColumns(columns, pkNames, fkNames, cap) {
  const MEASURE_KINDS = new Set(['currency', 'numeric', 'rating', 'percentage', 'date']);
  const priority = (c) => {
    if (pkNames.has(c.name)) return 0;
    if (fkNames.has(c.name)) return 1;
    if (MEASURE_KINDS.has(c.kind)) return 2;
    return 3;
  };
  const indexed = columns.map((c, i) => ({ c, i, p: priority(c) }));
  indexed.sort((a, b) => (a.p - b.p) || (a.i - b.i));
  const shown = indexed.slice(0, cap).map((x) => x.c);
  const truncated = Math.max(0, columns.length - shown.length);
  return { columns: shown, truncated };
}

// The one entry point: fileProfiles is getOrBuildFullProfile()'s
// `files` array (each { fileType, rowCount, columns: [{name, kind,
// duplicateCount, ...}] } — see services/fullDescriptiveAnalytics.js),
// relationships is that same call's `relationships` array. Returns
// { mermaid, entityCount, relationshipCount } — mermaid is null when
// there are no files yet (nothing to diagram).
function buildErdDefinition(fileProfiles, relationships) {
  if (!fileProfiles || fileProfiles.length === 0) {
    return { mermaid: null, entityCount: 0, relationshipCount: 0 };
  }

  const idMap = buildEntityIdMap(fileProfiles);
  const { fkColumnsByFile, edges } = classifyRelationships(fileProfiles, relationships);

  const lines = ['erDiagram'];

  fileProfiles.forEach((fp) => {
    const entityId = idMap[fp.fileType];
    const pkNames = primaryKeyNames(fp.columns);
    const fkNames = fkColumnsByFile[fp.fileType] || new Set();

    lines.push(`    ${entityId} {`);
    const { columns: shown, truncated } = pickDisplayColumns(fp.columns, pkNames, fkNames, MAX_ERD_ATTRIBUTES);
    shown.forEach((c) => {
      const type = erdType(c.kind);
      const attrName = sanitizeToken(c.name, 'field');
      const keyMarkers = [];
      if (pkNames.has(c.name)) keyMarkers.push('PK');
      if (fkNames.has(c.name)) keyMarkers.push('FK');
      const keyStr = keyMarkers.length > 0 ? ` ${keyMarkers.join(',')}` : '';
      const comment = attrName !== c.name ? ` "${safeLabel(c.name)}"` : '';
      lines.push(`        ${type} ${attrName}${keyStr}${comment}`);
    });
    if (truncated > 0) {
      lines.push(`        string more_fields "+${truncated} more field${truncated === 1 ? '' : 's'} not shown"`);
    }
    lines.push('    }');
  });

  edges.forEach((e) => {
    const entityFrom = idMap[e.fromFile];
    const entityTo = idMap[e.toFile];
    const label = safeLabel(`${e.fromColumn} ~ ${e.toColumn} (${e.overlapPct.toFixed(1)}%)`);
    lines.push(`    ${entityFrom} ${e.symbol} ${entityTo} : "${label}"`);
  });

  return {
    mermaid: lines.join('\n'),
    entityCount: fileProfiles.length,
    relationshipCount: edges.length,
  };
}

module.exports = {
  buildErdDefinition,
  // exported for direct unit testing
  sanitizeToken,
  sanitizeEntityId,
  primaryKeyNames,
  classifyRelationships,
  pickDisplayColumns,
};
