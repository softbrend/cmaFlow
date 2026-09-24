-- CMA-Flow schema for cmaDB (PostgreSQL)
-- Run once against your local "cmadb" database, e.g.:
--   psql -U postgres -d cmadb -f db/schema.sql
-- (or just `npm run db:init`, which runs this file for you)

-- ---------------------------------------------------------------------
-- Reference data: datasets an SME account can be assigned to
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS datasets (
    code        VARCHAR(50)  PRIMARY KEY,
    label       VARCHAR(150) NOT NULL,
    description VARCHAR(255)
);

INSERT INTO datasets (code, label, description) VALUES
    ('ONLINE_RETAIL',  'Online Retail',              'General online retail transaction dataset'),
    ('ECOMMERCE_50K',  'E-Commerce Transactions (50K)', 'Transaction volume: 50,000 records, 3,000 customers')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- SME accounts (sign-up / sign-in identity)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sme_accounts (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(50)  NOT NULL UNIQUE,   -- e.g. BUS-01
    owner_name       VARCHAR(150) NOT NULL,
    business_name    VARCHAR(150) NOT NULL,
    email            VARCHAR(150) NOT NULL UNIQUE,
    phone            VARCHAR(50),
    business_sector  VARCHAR(100),
    business_region  VARCHAR(100),
    assigned_dataset VARCHAR(50) REFERENCES datasets(code),
    password_hash    VARCHAR(255) NOT NULL,
    role             VARCHAR(50)  NOT NULL DEFAULT 'SME Owner',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Monetization configurations set up by an account
-- (what the "Set-up monetization configuration" screen writes to)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_configs (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    config_name  VARCHAR(150) NOT NULL,
    model_type   VARCHAR(30)  NOT NULL CHECK (model_type IN (
                     'subscription', 'freemium', 'pay_per_use', 'data_as_a_service'
                 )),
    details      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_active    BOOLEAN      NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monetization_configs_account
    ON monetization_configs(account_id);

-- ---------------------------------------------------------------------
-- Datasets uploaded by an SME account
-- (what the "Upload New Dataset" screen writes to)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uploaded_datasets (
    id                         SERIAL PRIMARY KEY,
    account_id                 INTEGER NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    dataset_id                 VARCHAR(50)  NOT NULL,   -- e.g. SME_Retail_07
    dataset_name               VARCHAR(150) NOT NULL,
    domain                     VARCHAR(100),
    -- Deprecated: these four columns held a single file's path per type,
    -- back when a dataset could only have exactly one file per canonical
    -- type. A dataset can now have any number of files per type (see
    -- dataset_files below), so new uploads leave these NULL; kept only so
    -- older rows already on disk still have their original path on hand.
    customer_file              VARCHAR(500),
    entitlements_file          VARCHAR(500),
    monetization_configs_file  VARCHAR(500),
    transactions_file          VARCHAR(500),
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (account_id, dataset_id)
);

CREATE INDEX IF NOT EXISTS idx_uploaded_datasets_account
    ON uploaded_datasets(account_id);

-- ---------------------------------------------------------------------
-- Per-account "default dataset" — which of an SME account's OWN uploaded
-- datasets (above) the SME Owner Portal home page treats as its working
-- dataset, distinct from the legacy `assigned_dataset` reference-data
-- pointer above (which points at the static `datasets` table of built-in
-- demo datasets, not anything an SME owner actually uploaded). Added here
-- rather than alongside sme_accounts because it references a table
-- (uploaded_datasets) defined only after it. ON DELETE SET NULL means
-- deleting the currently-default dataset just clears this back to "no
-- default yet" rather than failing the delete — services/
-- accountDatasets.js's ensureDefaultDataset() is what re-fills it, from
-- whichever of the account's remaining datasets was uploaded most
-- recently, the next time it's read (on login, or on the home / Upload
-- New Dataset pages).
ALTER TABLE sme_accounts
    ADD COLUMN IF NOT EXISTS default_dataset_id INTEGER
        REFERENCES uploaded_datasets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sme_accounts_default_dataset
    ON sme_accounts(default_dataset_id);

-- ---------------------------------------------------------------------
-- Individual physical CSV files uploaded under one dataset. A dataset can
-- have MANY files per canonical type (e.g. three monthly transactions.csv
-- exports) — this table is what makes that possible: uploaded_datasets no
-- longer stores one fixed path per type, it just owns any number of these.
-- ---------------------------------------------------------------------
-- file_type is a free-form, SME-chosen label (sanitized to a lowercase
-- slug — see sanitizeFileType() in middleware/upload.js), NOT one of a
-- fixed set of names. An SME owner's dataset can have any number of file
-- types with any names at all — "accounts", "subscriptions",
-- "feature_usage", "churn_events", "support_tickets", or anything else —
-- there is no CMA-wide list of "the" file types a dataset must have.
CREATE TABLE IF NOT EXISTS dataset_files (
    id            BIGSERIAL   PRIMARY KEY,
    dataset_id    INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id    INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    file_type     VARCHAR(60) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    stored_path   VARCHAR(500) NOT NULL,
    row_count     INTEGER     NOT NULL DEFAULT 0,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Widen + relax file_type on a database that predates free-form labels
-- (when it only accepted the old fixed 4-value list). ALTER, not just the
-- CREATE TABLE above, for the same reason as dataset_records.source_file_id
-- below: CREATE TABLE IF NOT EXISTS is a no-op once the table already
-- exists, so this is what actually reaches an existing installation.
ALTER TABLE dataset_files ALTER COLUMN file_type TYPE VARCHAR(60);
ALTER TABLE dataset_files DROP CONSTRAINT IF EXISTS dataset_files_file_type_check;
ALTER TABLE dataset_files DROP CONSTRAINT IF EXISTS dataset_files_file_type_format;
ALTER TABLE dataset_files ADD CONSTRAINT dataset_files_file_type_format CHECK (file_type ~ '^[a-z0-9_]{1,60}$');

CREATE INDEX IF NOT EXISTS idx_dataset_files_lookup
    ON dataset_files(dataset_id, file_type);

CREATE INDEX IF NOT EXISTS idx_dataset_files_account
    ON dataset_files(account_id);

-- ---------------------------------------------------------------------
-- Row-level data ingested from each uploaded dataset CSV.
--
-- Stored as JSONB rather than fixed columns because different SME
-- owners' datasets do not all share the same column structure — one
-- account's customer.csv might have different fields than another's.
-- Each row keeps its own field names/values exactly as uploaded, and
-- Browse Dataset derives the columns and filters dynamically per
-- dataset+file rather than assuming one fixed CMA-wide schema.
--
-- source_file_id traces a row back to the exact physical file (of
-- possibly several sharing the same file_type) it was parsed from;
-- row_index stays unique and ordered across ALL files of one file_type
-- in a dataset (file A's rows, then file B's rows, ...) so multiple
-- uploads of the same type merge into one continuous, browsable set
-- without colliding.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_records (
    id               BIGSERIAL PRIMARY KEY,
    dataset_id       INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id       INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    file_type        VARCHAR(60) NOT NULL,
    row_index        INTEGER     NOT NULL,
    data             JSONB       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added/relaxed via ALTER rather than only in the CREATE TABLE above,
-- because CREATE TABLE IF NOT EXISTS is a no-op on a database that
-- already had dataset_records — ALTER is what actually reaches an
-- existing installation (e.g. re-running `npm run db:init` on a database
-- that predates dataset_files/source_file_id, or predates free-form
-- file_type labels), not just a fresh one.
ALTER TABLE dataset_records
    ADD COLUMN IF NOT EXISTS source_file_id BIGINT REFERENCES dataset_files(id) ON DELETE CASCADE;
ALTER TABLE dataset_records ALTER COLUMN file_type TYPE VARCHAR(60);
ALTER TABLE dataset_records DROP CONSTRAINT IF EXISTS dataset_records_file_type_check;

CREATE INDEX IF NOT EXISTS idx_dataset_records_lookup
    ON dataset_records(dataset_id, file_type, row_index);

CREATE INDEX IF NOT EXISTS idx_dataset_records_account
    ON dataset_records(account_id);

CREATE INDEX IF NOT EXISTS idx_dataset_records_source_file
    ON dataset_records(source_file_id);

-- Lets future features filter/query directly on row contents in SQL
-- (e.g. WHERE data->>'region' = 'North') instead of only in Node.
CREATE INDEX IF NOT EXISTS idx_dataset_records_data_gin
    ON dataset_records USING GIN (data);

-- ---------------------------------------------------------------------
-- Confirmed column -> canonical CMA field mapping for one uploaded
-- dataset's file (customer / entitlements / monetization_configs /
-- transactions). One row per (uploaded dataset, file_type); re-mapping
-- and re-running the transform creates a new mapping_version rather than
-- silently rewriting history, so a previously frozen canonical_records
-- batch always stays attributable to the mapping that produced it.
-- ---------------------------------------------------------------------
-- file_type here is whatever free-form label the file was uploaded under
-- (see dataset_files above); entity is a SEPARATE, deliberate choice the
-- SME owner makes on the Map & Transform screen — nothing about a file's
-- name or label determines which canonical entity it becomes. The same
-- file_type could reasonably be mapped to different entities by different
-- SME owners (e.g. one owner's "events.csv" might be Transactions,
-- another's might be Entitlements) — this table is what keeps that
-- choice explicit and versioned rather than assumed.
CREATE TABLE IF NOT EXISTS dataset_mappings (
    id              SERIAL PRIMARY KEY,
    dataset_id      INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id      INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    file_type       VARCHAR(60) NOT NULL,
    entity          VARCHAR(30) NOT NULL CHECK (entity IN (
                        'Customer', 'Transaction', 'Entitlement', 'MonetizationConfig'
                    )),
    mapping_version INTEGER     NOT NULL DEFAULT 1,
    -- { canonicalField: { source: "<original column name>"|null, formula: "<computed field name>"|null, confidence: 0-1 } }
    field_map       JSONB       NOT NULL,
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, file_type, mapping_version)
);

ALTER TABLE dataset_mappings ALTER COLUMN file_type TYPE VARCHAR(60);
ALTER TABLE dataset_mappings DROP CONSTRAINT IF EXISTS dataset_mappings_file_type_check;
ALTER TABLE dataset_mappings DROP CONSTRAINT IF EXISTS dataset_mappings_entity_check;
ALTER TABLE dataset_mappings ADD CONSTRAINT dataset_mappings_entity_check
    CHECK (entity IN ('Customer', 'Transaction', 'Entitlement', 'MonetizationConfig'));

CREATE INDEX IF NOT EXISTS idx_dataset_mappings_lookup
    ON dataset_mappings(dataset_id, file_type);

-- ---------------------------------------------------------------------
-- Frozen, validated canonical records — the CMA Canonical Schema output
-- of the Clean -> Normalize -> Transform -> Tag -> Enrich -> Validate ->
-- Freeze pipeline. Never updated in place: source_record_id keeps full
-- lineage back to the exact raw dataset_records row (and therefore the
-- exact original CSV line) it was derived from, and mapping_version
-- pins down exactly which confirmed mapping produced it, so the frozen
-- output is always reproducible and auditable without ever touching or
-- overwriting the immutable raw layer.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_records (
    id                BIGSERIAL PRIMARY KEY,
    dataset_id        INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id        INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    entity            VARCHAR(30) NOT NULL CHECK (entity IN (
                          'Customer', 'Transaction', 'Entitlement', 'MonetizationConfig'
                      )),
    source_record_id  BIGINT      NOT NULL REFERENCES dataset_records(id) ON DELETE CASCADE,
    mapping_version    INTEGER    NOT NULL,
    data              JSONB       NOT NULL,   -- canonical fields for this entity
    status            VARCHAR(20) NOT NULL CHECK (status IN ('valid', 'invalid')),
    validation_errors JSONB       NOT NULL DEFAULT '[]'::jsonb,
    frozen_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- file_type records which of the dataset's (free-form, SME-labeled) files
-- produced this canonical row. Entity alone can no longer answer that
-- once several differently-labeled files can map to the same entity (e.g.
-- both "accounts.csv" and a later "new_signups.csv" mapped to Customer),
-- so this is what lets Map & Transform / canonical browsing key on the
-- exact file rather than reverse-guessing it from the entity. Added via
-- ALTER for the same reason as dataset_records.source_file_id above:
-- CREATE TABLE IF NOT EXISTS is a no-op on a database that already has
-- canonical_records.
ALTER TABLE canonical_records ADD COLUMN IF NOT EXISTS file_type VARCHAR(60);

CREATE INDEX IF NOT EXISTS idx_canonical_records_lookup
    ON canonical_records(dataset_id, entity, mapping_version);

CREATE INDEX IF NOT EXISTS idx_canonical_records_file_type
    ON canonical_records(dataset_id, file_type, mapping_version);

CREATE INDEX IF NOT EXISTS idx_canonical_records_account
    ON canonical_records(account_id);

CREATE INDEX IF NOT EXISTS idx_canonical_records_source
    ON canonical_records(source_record_id);

CREATE INDEX IF NOT EXISTS idx_canonical_records_data_gin
    ON canonical_records USING GIN (data);

-- ---------------------------------------------------------------------
-- Monetization Discovery Engine — SME-confirmed (or corrected) revenue
-- mechanism per dataset+product_service. The live inference itself
-- (services/monetizationDiscovery.js's discoverMechanisms()) is always
-- recomputed fresh from current canonical data and is NOT stored here;
-- only the SME owner's actual confirm/correct decision is persisted, so
-- it can be checked against whatever the engine infers on every later
-- visit rather than going stale. inferred_model_type/confidence/evidence
-- are snapshotted at confirm time purely for audit ("what did the engine
-- say when this was confirmed"), not read back as the live inference.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_classifications (
    id                    SERIAL PRIMARY KEY,
    dataset_id            INTEGER      NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id            INTEGER      NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    product_service       VARCHAR(255) NOT NULL,
    inferred_model_type   VARCHAR(30),
    confidence            NUMERIC,
    evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    confirmed_model_type  VARCHAR(30)  CHECK (confirmed_model_type IN (
                              'subscription', 'freemium', 'pay_per_use', 'data_as_a_service'
                          )),
    confirmed_at          TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, product_service)
);

CREATE INDEX IF NOT EXISTS idx_monetization_classifications_lookup
    ON monetization_classifications(dataset_id, account_id);

-- ---------------------------------------------------------------------
-- Full Descriptive Analytics — one cached statistical profile per
-- dataset + (free-form) file_type, computed by services/
-- datasetProfiler.js directly from a file's RAW rows (dataset_records),
-- with no dependency on Map & Transform or the CMA Canonical Schema. Lets
-- the Full Descriptive Analytics tab (services/fullDescriptiveAnalytics.js,
-- routes/dashboard.js) render instantly instead of re-scanning every raw
-- row on every page view. Computed once at upload time (see POST
-- /upload-dataset) and refreshed lazily if it's ever found older than the
-- file's own last upload — see getOrBuildFullProfile()'s staleness check.
-- `profile` holds one file's { columns, dateColumnName, measureColumns,
-- trendByMonth, correlations } — see profileFile()'s return shape.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_profiles (
    id           SERIAL PRIMARY KEY,
    dataset_id   INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id   INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    file_type    VARCHAR(60) NOT NULL,
    row_count    INTEGER     NOT NULL DEFAULT 0,
    profile      JSONB       NOT NULL,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, file_type)
);

CREATE INDEX IF NOT EXISTS idx_dataset_profiles_lookup
    ON dataset_profiles(dataset_id);

-- Cross-file relationships this dataset's id-like columns were detected
-- to share (e.g. menu.csv's r_id -> restaurant.csv's id, matched AND
-- measured with a real distinct-value-overlap query, not just guessed
-- from column names — see detectRelationships() in services/
-- fullDescriptiveAnalytics.js). One JSONB array per dataset rather than
-- its own table: it's small, always read alongside the dataset row it
-- describes, and never queried independently.
ALTER TABLE uploaded_datasets ADD COLUMN IF NOT EXISTS profile_relationships JSONB;

-- Automatic Dataset Intelligence & Analytics Engine — the cached output
-- of reasoning ACROSS a dataset's files, not just within one. Full
-- Descriptive Analytics profiles every file on its own; this layer
-- additionally classifies each file's business role (transaction fact
-- table vs. customer/product/merchant dimension, etc. — see services/
-- businessSemantics.js), identifies the dataset's fact table (if any),
-- and computes cross-file, join-based business metrics (total revenue,
-- ARPU, revenue by customer/product, ...) from services/metricRegistry.js
-- — see claude/business-semantic-metric-engine.md for the design
-- writeup. Every metric carries its own applicability flag, provenance
-- (source file/column, join path used, confidence band) rather than a
-- bare number, so an inapplicable metric (e.g. MRR with no subscription
-- evidence) reads as "not applicable", never a fabricated zero. One
-- JSONB blob per dataset, same caching shape as profile_relationships
-- above: computed once full profiling has run, refreshed whenever the
-- underlying file profiles were recomputed.
ALTER TABLE uploaded_datasets ADD COLUMN IF NOT EXISTS business_intelligence JSONB;

-- Round 22 — Semantic Field Detection Engine, SME confirmation feedback.
-- Every column the hybrid engine (services/semanticFieldEngine.js) left
-- in the Medium ("flag-for-confirmation") or Low ("ask-sme") confidence
-- band gets surfaced on GET /dataset/:id/review-fields; whatever the SME
-- owner confirms or corrects there is written here as ONE ROW PER
-- (dataset, file, column) — the corrected_role the owner picked, plus
-- what the engine had originally guessed and at what confidence, for
-- later audit. This is the human-in-the-loop learning mechanism the
-- integration request asked for (its own section 6): scripts/
-- retrainSemanticClassifier.js reads every row here, turns it back into
-- a labeled training example via the SAME feature extraction the live
-- engine used, and folds it into the classifier's next training run —
-- never automatically on every single confirmation (see that script's
-- own header for why only a periodic/batch retrain is safe).
-- UNIQUE per (dataset, file_type, column_name): a later confirmation for
-- the same column replaces the earlier one (upserted, not appended) —
-- there is exactly one "current truth" per column, not a growing log of
-- every time an SME revisited the same field.
CREATE TABLE IF NOT EXISTS field_role_feedback (
    id               SERIAL PRIMARY KEY,
    dataset_id       INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id       INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    file_type        VARCHAR(60) NOT NULL,
    column_name      VARCHAR(255) NOT NULL,
    suggested_role   VARCHAR(60),           -- what the hybrid engine predicted (null if it found nothing at all)
    suggested_confidence NUMERIC(5,4),
    confirmed_role   VARCHAR(60) NOT NULL,  -- what the SME owner actually confirmed — 'none' is a valid, meaningful answer ("this column has no business role")
    was_correction   BOOLEAN     NOT NULL DEFAULT false, -- true when confirmed_role differs from suggested_role
    confirmed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, file_type, column_name)
);

CREATE INDEX IF NOT EXISTS idx_field_role_feedback_account
    ON field_role_feedback(account_id);

-- Note: the "session" table used for login sessions is created
-- automatically by connect-pg-simple the first time the server starts.
