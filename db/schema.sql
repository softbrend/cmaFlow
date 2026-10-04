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

-- Restricts role to the values the app actually understands (routes/
-- admin.js's requireAdmin checks for the literal string 'Admin'; every
-- other SME-owner-flow account is implicitly an SME owner). Added after
-- the column already existed in production, so it's a separate ALTER
-- wrapped in a DO block rather than an inline CHECK on the column above —
-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so this is the
-- idempotent-safe way to let db:init re-run this file on every deploy
-- without erroring on a constraint that's already there.
--
-- 'Template Evaluator' (named 'Expert Evaluator' until 2 October 2026 —
-- see the rename note below) added alongside the original two for the
-- field-generalization evaluation round: a purposively-recruited domain
-- expert who signs up through the separate, access-code-gated
-- /expert-signup flow (routes/auth.js), uploads their own dataset in an
-- SME business category of their choosing (views/dashboard/sme-templates
-- supplies the CSV template), runs it through the same four analytics
-- modules an SME owner uses, and then completes the same TAM instrument —
-- but every byte of that evaluation is written to its own
-- expert_evaluation_sessions/_task_logs/_responses tables below, never
-- evaluation_sessions/_task_logs/_responses, so the SME-owner respondent
-- counts and TAM summary statistics already reported in the manuscript
-- can never silently pick up a template evaluator's rows. The role CHECK
-- is dropped and recreated (not just ADD CONSTRAINT) because a constraint
-- can't be altered in place — this runs every db:init, so it's a no-op
-- once the live constraint already allows all three values.
--
-- Renamed from 'Expert Evaluator' (2 October 2026, see
-- claude/template-evaluator-rename-and-cohort-tagging.md): this role
-- validates the app's computations against synthetic template data with
-- known-correct values — it was being read by name alone as satisfying a
-- peer-review recommendation it does not satisfy, namely blind rating of
-- REAL SME owners' decisions by human domain experts (a completely
-- different thing).
--
-- The three statements below have to run in exactly this order on a
-- database that still has the OLD constraint and existing 'Expert
-- Evaluator' rows (every environment except a brand-new one), or they
-- deadlock each other: widening the constraint first would reject the
-- pre-existing 'Expert Evaluator' rows it hasn't fixed yet; updating the
-- rows first would be rejected by the OLD constraint, which doesn't know
-- 'Template Evaluator' yet. NOT VALID adds the new constraint without
-- scanning existing rows (so the not-yet-updated 'Expert Evaluator' rows
-- don't block it), the UPDATE then rewrites exactly those rows — and is
-- itself checked against the new constraint, which is fine since it only
-- ever writes the now-allowed 'Template Evaluator' — and VALIDATE
-- CONSTRAINT confirms every row satisfies it. All three are safe to rerun
-- on every db:init: the DROP/ADD is already idempotent by construction,
-- the UPDATE matches zero rows once none are left holding the old value,
-- and validating an already-valid constraint is a fast no-op.
-- 'Business Owner Evaluator' (added 2 October 2026): a THIRD population,
-- alongside SME Owner and Template Evaluator — a purposively-recruited
-- respondent who signs up through its own access-code-gated
-- /businessOwner-signup flow (routes/auth.js), takes the same six-task
-- walkthrough as an SME Owner (uploading their own real dataset, same as
-- the original/non-template flow), but then answers the NEW 15-item
-- ISO/IEC 25010 Quality-in-Use questionnaire instead of TAM — persisted
-- to its own business_owner_evaluation_sessions/_task_logs/_responses
-- tables below, never evaluation_*/expert_evaluation_*, so neither the
-- SME Owner nor the Template Evaluator TAM datasets are ever touched by
-- this new instrument. See services/tamEvaluation.js's header comment.
DO $$
BEGIN
  ALTER TABLE sme_accounts DROP CONSTRAINT IF EXISTS sme_accounts_role_check;
  ALTER TABLE sme_accounts
      ADD CONSTRAINT sme_accounts_role_check CHECK (role IN ('SME Owner', 'Admin', 'Template Evaluator', 'Business Owner Evaluator', 'SME Owner-TAM Evaluator')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE sme_accounts SET role = 'Template Evaluator' WHERE role = 'Expert Evaluator';

ALTER TABLE sme_accounts VALIDATE CONSTRAINT sme_accounts_role_check;

-- Participant cohort (added 2 October 2026, same rename round) — purely
-- descriptive, never enforced by any gate: which recruitment pool an SME
-- Owner account's TAM responses belong to, so a future reliability
-- recomputation (peer-review recommendation #4: rebuild the TAM survey
-- with real SME participants, not students) can filter the existing
-- MIT 267 course-cohort responses OUT of a real-SME-only analysis instead
-- of silently mixing the two populations. NULL means "not yet tagged" —
-- an Admin sets this from Manage SME Accounts (services/adminAccounts.js
-- setCohort()); nothing in the app currently reads this column to gate or
-- filter anything, only to display and allow future, manual
-- recomputation. Not applicable to Template Evaluator accounts (their
-- responses already live in a fully separate table set, see above) or
-- Admin accounts (no TAM responses of their own).
ALTER TABLE sme_accounts ADD COLUMN IF NOT EXISTS cohort VARCHAR(30);

-- Business profile captured at the SME Owner-TAM Evaluator signup
-- (added 4 October 2026): what kind of business/affiliation the respondent
-- runs (free text, e.g. 'Cafe') and its size (Micro / Small / Medium
-- Enterprise). Both nullable — every other role's accounts, and any
-- pre-existing account, simply leave them empty.
ALTER TABLE sme_accounts ADD COLUMN IF NOT EXISTS business_type VARCHAR(100);
ALTER TABLE sme_accounts ADD COLUMN IF NOT EXISTS business_size VARCHAR(50);

DO $$
BEGIN
  ALTER TABLE sme_accounts
      ADD CONSTRAINT sme_accounts_cohort_check
      CHECK (cohort IS NULL OR cohort IN ('mit267_2026', 'field_study', 'internal_test', 'other'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
-- The one-time backfill that tags existing MIT 267 respondents with this
-- cohort lives further down this file, right after evaluation_sessions is
-- created (it reads that table, which doesn't exist yet at this point on
-- a fresh database) — search for "One-time backfill" below.

-- Evaluation flow (added 2 October 2026, per Brenda's direction): which of
-- two ways a Template Evaluator account takes the TAM evaluation.
-- 'walkthrough' is the original design — upload-your-own-dataset only,
-- sequentially gated through the six WALKTHROUGH_TASKS modules one at a
-- time (middleware/evaluationGate.js) before reaching the questionnaire.
-- 'direct' is the new design: the account can upload its own dataset OR
-- pick one of the 20 static templates (routes/templates.js) at any time,
-- every one of the four analytics modules is reachable immediately with
-- no sequential gate, and time-on-module is logged automatically from
-- page visits (expert_evaluation_module_visits below, services/
-- tamEvaluation.js's recordModuleVisit()) instead of explicit "start
-- task"/"mark task complete" steps.
--
-- DEFAULT 'walkthrough' is what grandfathers the 15 Template Evaluator
-- accounts that already exist as of this migration (and every SME Owner
-- account, for whom this column is simply unused) — adding a column with
-- a DEFAULT fills every pre-existing row with that default, so nothing
-- further needs to be backfilled here, unlike the cohort column above.
-- Those 15 accounts keep the exact six-task gated flow they always had,
-- however far they've gotten, even if they log in again before
-- finishing it — per Brenda's explicit choice, the new flow only ever
-- applies to a Template Evaluator account created from here on (routes/
-- auth.js's POST /expert-signup/register sets evaluation_flow = 'direct'
-- explicitly at signup; nothing else ever writes this column, so it is
-- not Admin-editable the way cohort is).
ALTER TABLE sme_accounts ADD COLUMN IF NOT EXISTS evaluation_flow VARCHAR(20) NOT NULL DEFAULT 'walkthrough';

DO $$
BEGIN
  ALTER TABLE sme_accounts
      ADD CONSTRAINT sme_accounts_evaluation_flow_check
      CHECK (evaluation_flow IN ('walkthrough', 'direct'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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

-- ---------------------------------------------------------------------
-- TAM End-User Evaluation — the six-task walkthrough + 17-item Technology
-- Acceptance Model questionnaire described in
-- claude/tam-instrument-end-user-evaluation.md (Table 1's six tasks,
-- Tables 2-4's PU/PEOU/BI items), embedded directly in the running app
-- rather than administered on paper. services/tamEvaluation.js is the
-- single source of truth for the task list and item list; these tables
-- just persist an SME owner's progress and answers against them.
--
-- One evaluation_sessions row per account: UNIQUE(account_id) means
-- there is always exactly one "the" evaluation to resume or view, which
-- is what makes "resume if not yet completed" unambiguous — GET
-- /evaluation always finds this one row (creating it on first visit) and
-- routes to wherever status/current_task says the account left off.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evaluation_sessions (
    id                        SERIAL PRIMARY KEY,
    account_id                INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    status                    VARCHAR(20) NOT NULL DEFAULT 'walkthrough' CHECK (status IN (
                                  'walkthrough', 'questionnaire', 'completed'
                              )),
    current_task              SMALLINT    NOT NULL DEFAULT 1 CHECK (current_task BETWEEN 1 AND 6),
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    walkthrough_completed_at  TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,
    UNIQUE (account_id)
);

-- Consent gate (Republic Act No. 10173 — Data Privacy Act of 2012): a
-- respondent must explicitly and voluntarily choose to participate before
-- any walkthrough/questionnaire screen is shown. 'pending' is the default
-- for every session — including ones created before this column existed,
-- via the ALTER below — so nobody already in progress is silently treated
-- as having consented. GET /evaluation checks this column first and only
-- falls through to the status-based routing above once it is 'given'.
-- consent_decided_at is cleared back to NULL whenever consent_status
-- returns to 'pending' (see recordConsent() in services/tamEvaluation.js),
-- so it always reflects the most recent agree/decline decision rather than
-- the first one, and 'declined' never deletes anything already logged —
-- it only stops new walkthrough/questionnaire screens from being served.
ALTER TABLE evaluation_sessions
    ADD COLUMN IF NOT EXISTS consent_status VARCHAR(20) NOT NULL DEFAULT 'pending';

ALTER TABLE evaluation_sessions
    ADD COLUMN IF NOT EXISTS consent_decided_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE evaluation_sessions
      ADD CONSTRAINT evaluation_sessions_consent_status_check
      CHECK (consent_status IN ('pending', 'given', 'declined'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One row per (session, task 1-6). started_at is stamped the first time
-- the account lands on that task's walkthrough screen (see
-- startTaskIfNeeded() in services/tamEvaluation.js) and never overwritten
-- on a later revisit/refresh of the same task, so time_on_task_seconds —
-- filled in when the task is marked complete — reflects actual elapsed
-- time on the task, the same "completion, time, assistance/errors"
-- triad Table 1 specifies, just captured live instead of by a human
-- administrator with a stopwatch.
CREATE TABLE IF NOT EXISTS evaluation_task_logs (
    id                    SERIAL PRIMARY KEY,
    session_id            INTEGER     NOT NULL REFERENCES evaluation_sessions(id) ON DELETE CASCADE,
    account_id            INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    task_number           SMALLINT    NOT NULL CHECK (task_number BETWEEN 1 AND 6),
    module_slug           VARCHAR(60) NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    time_on_task_seconds  INTEGER,
    needed_assistance     BOOLEAN     NOT NULL DEFAULT false,
    had_error             BOOLEAN     NOT NULL DEFAULT false,
    notes                 TEXT,
    UNIQUE (session_id, task_number)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_task_logs_session
    ON evaluation_task_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_task_logs_account
    ON evaluation_task_logs(account_id);

-- One row per (session, TAM item code — e.g. 'PU-01', 'PEOU-07', 'BI-03').
-- Upserted on every "Save progress" and every final submit (see
-- saveResponses() in services/tamEvaluation.js), so a partially-answered
-- questionnaire always has exactly its answered-so-far items here for
-- GET /evaluation to pre-fill on resume — rating stays NULL for an item
-- the account hasn't reached yet. The instrument's own "rating <=3
-- requires a remark" rule (Section 4.1) is enforced in the app only at
-- final-submit time, not here, so an in-progress save is never blocked
-- on a remark the account hasn't finished typing yet.
CREATE TABLE IF NOT EXISTS evaluation_responses (
    id            SERIAL PRIMARY KEY,
    session_id    INTEGER     NOT NULL REFERENCES evaluation_sessions(id) ON DELETE CASCADE,
    account_id    INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    item_code     VARCHAR(10) NOT NULL,
    domain        VARCHAR(10) NOT NULL CHECK (domain IN ('PU', 'PEOU', 'BI')),
    rating        SMALLINT    CHECK (rating BETWEEN 1 AND 5),
    remark        TEXT,
    answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, item_code)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_responses_session
    ON evaluation_responses(session_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_responses_account
    ON evaluation_responses(account_id);

-- evaluation_responses.domain stays PU/PEOU/BI-only — SME Owner accounts
-- keep taking the original TAM instrument, unchanged (an earlier revision
-- of this file briefly widened this constraint to also allow the new
-- ISO/IEC 25010 domain codes here; that instrument was moved onto the new
-- Business Owner Evaluator role and its own business_owner_evaluation_*
-- tables below instead — see services/tamEvaluation.js's header comment —
-- so this is reverted back to its original, strict definition). DROP+
-- re-ADD (not the usual bare "ADD CONSTRAINT ... EXCEPTION WHEN
-- duplicate_object" pattern) so this also actively reverts a database
-- that already picked up the briefly-widened version, not just a
-- brand-new one.
ALTER TABLE evaluation_responses DROP CONSTRAINT IF EXISTS evaluation_responses_domain_check;
DO $$ BEGIN
  ALTER TABLE evaluation_responses
      ADD CONSTRAINT evaluation_responses_domain_check
      CHECK (domain IN ('PU', 'PEOU', 'BI'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One-time backfill for sme_accounts.cohort (added 2 October 2026, see the
-- column's own comment up near sme_accounts_role_check): every SME Owner
-- account that already has an evaluation_sessions row — i.e. it actually
-- started or completed the TAM walkthrough — predates this column and is,
-- per claude/tam-instrument-end-user-evaluation.md, exclusively the
-- MIT 267 course-cohort roster, the same population the IMRAD
-- manuscript's Section 4.4 Limitations already names as a single-cohort
-- caveat. Placed here, after evaluation_sessions exists, rather than next
-- to the column/constraint above. Only fills rows still NULL, so it never
-- overwrites a cohort an Admin has since set by hand, and a second run is
-- a no-op.
UPDATE sme_accounts
   SET cohort = 'mit267_2026'
 WHERE role = 'SME Owner'
   AND cohort IS NULL
   AND id IN (SELECT account_id FROM evaluation_sessions);

-- ---------------------------------------------------------------------
-- Analytics result cache — extends the SAME two-phase caching pattern
-- uploaded_datasets.business_intelligence already uses for the 'dynamic'
-- (fact-table) analytics pathway (see getOrBuildBusinessIntelligence() in
-- services/fullDescriptiveAnalytics.js) to the 'raw' pathway used by
-- Diagnostic Insights' revenue-bridge/cancellation-reasons/price-change-
-- impact/coverage views and Predictive/Prescriptive's raw source — which
-- had NO caching at all: every page load re-fetched every row of a
-- dataset's uploaded files (SELECT ... FROM dataset_records, no LIMIT)
-- and re-ran the full analysis, on EVERY visit, regardless of tab. For an
-- SME owner's larger uploads (hundreds of thousands of rows), that cost
-- was paid again on every single click between tabs.
--
-- One row per (dataset, cache_key) — cache_key names which bundle of
-- computed results this is (e.g. 'diagnostic-raw', 'predictive-raw',
-- 'prescriptive-raw'), not which SME account, since the computed result
-- only depends on the dataset's own data. latest_upload pins down exactly
-- which state of the dataset this was computed against: services/
-- analyticsCache.js's getOrCompute() compares it against a cheap
-- MAX(uploaded_at) lookup on dataset_files (the same freshness check
-- getOrBuildBusinessIntelligence already uses) before ever falling
-- through to the expensive recompute, so a cache hit costs one small
-- indexed query, never a full row re-fetch.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_result_cache (
    id             BIGSERIAL   PRIMARY KEY,
    dataset_id     INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    account_id     INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    cache_key      VARCHAR(60) NOT NULL,
    latest_upload  TIMESTAMPTZ NOT NULL,
    payload        JSONB       NOT NULL,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_analytics_result_cache_account
    ON analytics_result_cache(account_id);

-- ---------------------------------------------------------------------
-- Dataset upload jobs — tracks one background ingest job per POST
-- /upload-dataset submission, so the browser can show real progress
-- (Uploaded -> Validating -> Parsing -> Loading -> Profiling ->
-- Completed) instead of hanging on one long request, and so the request
-- itself returns immediately rather than risking Render's proxy timeout
-- on a very large CSV. See services/uploadJobs.js and services/
-- datasetIngestService.js, and claude/upload-processing-performance.md
-- for the full design writeup.
--
-- Deliberately NOT a durable job queue: this app runs as a single Node
-- instance (render.yaml pins it there via a mounted persistent disk), so
-- an in-database status row is enough for the browser to poll against —
-- there's no second instance that could ever pick up someone else's job.
-- A job is NOT resumable if the server process restarts mid-ingest (its
-- transaction was never committed, so nothing was actually written) —
-- reconcileStuckUploadJobs() in services/uploadJobs.js marks any row
-- still 'processing' as failed at server boot, pairing with server.js's
-- existing TMP_ROOT wipe on startup, so the browser sees a clear failure
-- rather than a progress bar that never moves again.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_upload_jobs (
    id             BIGSERIAL   PRIMARY KEY,
    account_id     INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    dataset_id     VARCHAR(50) NOT NULL,
    dataset_row_id INTEGER     REFERENCES uploaded_datasets(id) ON DELETE SET NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing', 'completed', 'failed')),
    stage          VARCHAR(20) NOT NULL DEFAULT 'validating',
    rows_done      INTEGER     NOT NULL DEFAULT 0,
    error_message  TEXT,
    summary        JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dataset_upload_jobs_account
    ON dataset_upload_jobs(account_id);

-- The "session" table used for login sessions — previously created
-- on the fly by connect-pg-simple's own createTableIfMissing:true option
-- (server.js), on the FIRST request that ever touched the session store
-- after each process start. That turned out to be a real problem: if that
-- first touch happened while Postgres was still restarting/unreachable
-- (a normal, brief window after any database restart), connect-pg-simple
-- caches the FAILED table-check as a promise internal to its store object
-- and never retries it — every session-touching request for the rest of
-- that process's life (effectively every real page load) then failed the
-- same way, even seconds later once Postgres was fully back up, until the
-- whole Node process was manually restarted. Defining the table here
-- instead — applied idempotently by `npm run db:init` on every deploy,
-- see render.yaml's preDeployCommand — means connect-pg-simple never runs
-- that check at all (server.js now passes createTableIfMissing: false),
-- so there is nothing left for a brief database restart to poison. Column
-- shapes and the index match connect-pg-simple's own table.sql exactly.
CREATE TABLE IF NOT EXISTS "session" (
    "sid"    varchar NOT NULL COLLATE "default",
    "sess"   json NOT NULL,
    "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
    ) THEN
        ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ---------------------------------------------------------------------
-- Template Evaluator TAM evaluation (table names keep their original
-- "expert_evaluation_*" prefix — renaming a table name is a much larger,
-- riskier blast radius than renaming the role string everywhere it reads
-- as user-facing text; see claude/template-evaluator-rename-and-cohort-
-- tagging.md) — same six-task walkthrough + 17-item questionnaire as
-- evaluation_sessions/_task_logs/_responses above (same
-- services/tamEvaluation.js task list and item list, same
-- consent/validation rules), but a COMPLETELY SEPARATE set of tables so a
-- Template Evaluator's responses can never be queried, counted, or
-- summarized together with an SME owner's, even by accident. See the
-- 'Template Evaluator' note on sme_accounts_role_check above for why this
-- round exists. Column shapes are identical to their SME-owner
-- counterparts on purpose — services/tamEvaluation.js picks which table
-- set to read/write per-call based on the account's role, not by
-- duplicating its logic.
--
-- These same tables now serve BOTH Template Evaluator populations —
-- the 15 original 'walkthrough'-flow accounts and every 'direct'-flow
-- account signed up from 2 October 2026 onward (sme_accounts
-- .evaluation_flow, see its comment above) — status/current_task simply
-- go unused by a direct-flow session (it never progresses through six
-- tasks, so current_task stays at its default and status moves straight
-- from 'walkthrough' to 'questionnaire' the first time services/
-- tamEvaluation.js's getOrCreateSession()/markDirectFlowReady() sees it —
-- see that file). What must never happen is computing a cross-respondent
-- summary (getCompletedExpertResponseSummary()) or a reliability figure
-- from BOTH flows at once — every such query joins back to sme_accounts
-- and filters on evaluation_flow, the same discipline that already keeps
-- Template Evaluators separate from SME owners here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expert_evaluation_sessions (
    id                        SERIAL PRIMARY KEY,
    account_id                INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    status                    VARCHAR(20) NOT NULL DEFAULT 'walkthrough' CHECK (status IN (
                                  'walkthrough', 'questionnaire', 'completed'
                              )),
    current_task              SMALLINT    NOT NULL DEFAULT 1 CHECK (current_task BETWEEN 1 AND 6),
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    walkthrough_completed_at  TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,
    consent_status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    consent_decided_at        TIMESTAMPTZ,
    UNIQUE (account_id)
);

DO $$
BEGIN
  ALTER TABLE expert_evaluation_sessions
      ADD CONSTRAINT expert_evaluation_sessions_consent_status_check
      CHECK (consent_status IN ('pending', 'given', 'declined'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS expert_evaluation_task_logs (
    id                    SERIAL PRIMARY KEY,
    session_id            INTEGER     NOT NULL REFERENCES expert_evaluation_sessions(id) ON DELETE CASCADE,
    account_id            INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    task_number           SMALLINT    NOT NULL CHECK (task_number BETWEEN 1 AND 6),
    module_slug           VARCHAR(60) NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    time_on_task_seconds  INTEGER,
    needed_assistance     BOOLEAN     NOT NULL DEFAULT false,
    had_error             BOOLEAN     NOT NULL DEFAULT false,
    notes                 TEXT,
    UNIQUE (session_id, task_number)
);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_task_logs_session
    ON expert_evaluation_task_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_task_logs_account
    ON expert_evaluation_task_logs(account_id);

CREATE TABLE IF NOT EXISTS expert_evaluation_responses (
    id            SERIAL PRIMARY KEY,
    session_id    INTEGER     NOT NULL REFERENCES expert_evaluation_sessions(id) ON DELETE CASCADE,
    account_id    INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    item_code     VARCHAR(10) NOT NULL,
    domain        VARCHAR(10) NOT NULL CHECK (domain IN ('PU', 'PEOU', 'BI')),
    rating        SMALLINT    CHECK (rating BETWEEN 1 AND 5),
    remark        TEXT,
    answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, item_code)
);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_responses_session
    ON expert_evaluation_responses(session_id);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_responses_account
    ON expert_evaluation_responses(account_id);

-- ---------------------------------------------------------------------
-- Business Owner Evaluator accounts (added 2 October 2026) — a third
-- population, signed up through its own access-code-gated
-- /businessOwner-signup flow (routes/auth.js), that takes the same
-- six-task walkthrough as an SME Owner (uploading its own real dataset as
-- Task 1, always walkthrough-gated — no 'direct'-flow variant exists for
-- this role, unlike Template Evaluator, so there's no
-- business_owner_evaluation_module_visits table), but then answers the
-- NEW 15-item ISO/IEC 25010 Quality-in-Use questionnaire
-- (services/tamEvaluation.js's ISO25010_ITEMS) instead of TAM. Column
-- shapes mirror evaluation_sessions/_task_logs/_responses and
-- expert_evaluation_sessions/_task_logs/_responses above exactly, for the
-- same reason: services/tamEvaluation.js picks which table set to
-- read/write per-call from the account's role, not by duplicating its
-- logic. domain is constrained to the ISO/IEC 25010 codes only — this
-- population never takes TAM, so there's no PU/PEOU/BI to allow for.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_owner_evaluation_sessions (
    id                        SERIAL PRIMARY KEY,
    account_id                INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    status                    VARCHAR(20) NOT NULL DEFAULT 'walkthrough' CHECK (status IN (
                                  'walkthrough', 'questionnaire', 'completed'
                              )),
    current_task              SMALLINT    NOT NULL DEFAULT 1 CHECK (current_task BETWEEN 1 AND 6),
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    walkthrough_completed_at  TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,
    consent_status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    consent_decided_at        TIMESTAMPTZ,
    UNIQUE (account_id)
);

DO $$
BEGIN
  ALTER TABLE business_owner_evaluation_sessions
      ADD CONSTRAINT business_owner_evaluation_sessions_consent_status_check
      CHECK (consent_status IN ('pending', 'given', 'declined'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS business_owner_evaluation_task_logs (
    id                    SERIAL PRIMARY KEY,
    session_id            INTEGER     NOT NULL REFERENCES business_owner_evaluation_sessions(id) ON DELETE CASCADE,
    account_id            INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    task_number           SMALLINT    NOT NULL CHECK (task_number BETWEEN 1 AND 6),
    module_slug           VARCHAR(60) NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    time_on_task_seconds  INTEGER,
    needed_assistance     BOOLEAN     NOT NULL DEFAULT false,
    had_error             BOOLEAN     NOT NULL DEFAULT false,
    notes                 TEXT,
    UNIQUE (session_id, task_number)
);

CREATE INDEX IF NOT EXISTS idx_business_owner_evaluation_task_logs_session
    ON business_owner_evaluation_task_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_business_owner_evaluation_task_logs_account
    ON business_owner_evaluation_task_logs(account_id);

CREATE TABLE IF NOT EXISTS business_owner_evaluation_responses (
    id            SERIAL PRIMARY KEY,
    session_id    INTEGER     NOT NULL REFERENCES business_owner_evaluation_sessions(id) ON DELETE CASCADE,
    account_id    INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    item_code     VARCHAR(10) NOT NULL,
    domain        VARCHAR(10) NOT NULL CHECK (domain IN ('EFF', 'RISK', 'SAT', 'EFFIC')),
    rating        SMALLINT    CHECK (rating BETWEEN 1 AND 5),
    remark        TEXT,
    answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, item_code)
);

CREATE INDEX IF NOT EXISTS idx_business_owner_evaluation_responses_session
    ON business_owner_evaluation_responses(session_id);

CREATE INDEX IF NOT EXISTS idx_business_owner_evaluation_responses_account
    ON business_owner_evaluation_responses(account_id);

-- ---------------------------------------------------------------------
-- Automatic time-on-module logging for 'direct'-flow Template Evaluators
-- (sme_accounts.evaluation_flow, see its own comment near
-- sme_accounts_evaluation_flow_check) — the replacement for
-- expert_evaluation_task_logs' explicit "start task"/"mark task complete"
-- steps, which a direct-flow account never performs (it isn't walked
-- through the six tasks at all). One row per (session, module), where
-- module_slug is one of the four analytics modules' own slug
-- (descriptive-analytics/diagnostic-insights/predictive-analytics/
-- prescriptive-recommendations — the same slugs routes/dashboard.js's
-- STUB_SECTIONS and WALKTHROUGH_TASKS already use). services/
-- tamEvaluation.js's recordModuleVisit() is the only writer: every GET to
-- one of those four pages credits the elapsed time since this account's
-- own last page open to whichever module it had last opened (capped at
-- 30 minutes so an idle browser tab left open overnight doesn't inflate
-- the total), then stamps this module as the new "last opened" — so
-- total_seconds is a genuinely passive, page-visit-driven approximation
-- of time-on-task, never a stopwatch the evaluator starts or stops
-- themselves. Only ever written for an account whose evaluation_flow is
-- 'direct' and whose consent_status is 'given' — recordModuleVisit()
-- checks consent itself before writing anything, the same "no data
-- collection before affirmative consent" discipline as the rest of this
-- instrument (RA 10173).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expert_evaluation_module_visits (
    id              SERIAL      PRIMARY KEY,
    session_id      INTEGER     NOT NULL REFERENCES expert_evaluation_sessions(id) ON DELETE CASCADE,
    account_id      INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    module_slug     VARCHAR(60) NOT NULL,
    first_opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    open_count      INTEGER     NOT NULL DEFAULT 1,
    total_seconds   INTEGER     NOT NULL DEFAULT 0,
    UNIQUE (session_id, module_slug)
);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_module_visits_session
    ON expert_evaluation_module_visits(session_id);

CREATE INDEX IF NOT EXISTS idx_expert_evaluation_module_visits_account
    ON expert_evaluation_module_visits(account_id);

-- ---------------------------------------------------------------------
-- SME Owner-TAM Evaluator accounts (added 4 October 2026) — a FOURTH,
-- fully separate population: real SME owners recruited through their own
-- access-code-gated /smeOwnerTam-signup flow (routes/auth.js). They use
-- the same portal the Business Owner Evaluator does (business-category
-- template or blank dataset, Excel-style CRUD, User Manual, the four
-- analytics modules) and the same DIRECT flow the post-2-October-2026
-- Template Evaluator accounts use (no six-task walkthrough — all four
-- modules open immediately, time-on-module logged automatically), but
-- then answer a REWORDED 17-item TAM questionnaire (PU 7 / PEOU 7 / BI 3,
-- services/tamEvaluation.js's SME_TAM_ITEMS, wording adapted for real
-- owners using their own data) rather than ISO/IEC 25010.
--
-- Persisted to these four tables ONLY — never evaluation_*,
-- expert_evaluation_* or business_owner_evaluation_* — per Brenda's
-- explicit instruction that this new direction "will not touch the
-- previous results": the SME Owner TAM data already reported in the
-- manuscript, the Template Evaluator round, and the Business Owner
-- Evaluator ISO/IEC 25010 round are all left exactly as collected. Because
-- the wording differs from the original TAM items, these responses must
-- also never be pooled with the SME Owner / Template Evaluator TAM
-- responses in any analysis without an explicit equivalence argument.
-- Column shapes mirror expert_evaluation_* exactly so
-- services/tamEvaluation.js can pick the table set per call from the
-- account's role (tablesFor()) instead of forking its logic. This role is
-- always direct-flow, so sessions are created at status = 'questionnaire'
-- and sme_tam_evaluation_task_logs stays permanently empty — it exists
-- only so the shared getTaskLogs()/getEvaluationState() code path needs no
-- special case.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sme_tam_evaluation_sessions (
    id                        SERIAL PRIMARY KEY,
    account_id                INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    status                    VARCHAR(20) NOT NULL DEFAULT 'questionnaire' CHECK (status IN (
                                  'walkthrough', 'questionnaire', 'completed'
                              )),
    current_task              SMALLINT    NOT NULL DEFAULT 1 CHECK (current_task BETWEEN 1 AND 6),
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    walkthrough_completed_at  TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,
    consent_status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    consent_decided_at        TIMESTAMPTZ,
    UNIQUE (account_id)
);

DO $$
BEGIN
  ALTER TABLE sme_tam_evaluation_sessions
      ADD CONSTRAINT sme_tam_evaluation_sessions_consent_status_check
      CHECK (consent_status IN ('pending', 'given', 'declined'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sme_tam_evaluation_task_logs (
    id                    SERIAL PRIMARY KEY,
    session_id            INTEGER     NOT NULL REFERENCES sme_tam_evaluation_sessions(id) ON DELETE CASCADE,
    account_id            INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    task_number           SMALLINT    NOT NULL CHECK (task_number BETWEEN 1 AND 6),
    module_slug           VARCHAR(60) NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    time_on_task_seconds  INTEGER,
    needed_assistance     BOOLEAN     NOT NULL DEFAULT false,
    had_error             BOOLEAN     NOT NULL DEFAULT false,
    notes                 TEXT,
    UNIQUE (session_id, task_number)
);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_task_logs_session
    ON sme_tam_evaluation_task_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_task_logs_account
    ON sme_tam_evaluation_task_logs(account_id);

CREATE TABLE IF NOT EXISTS sme_tam_evaluation_responses (
    id            SERIAL PRIMARY KEY,
    session_id    INTEGER     NOT NULL REFERENCES sme_tam_evaluation_sessions(id) ON DELETE CASCADE,
    account_id    INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    item_code     VARCHAR(10) NOT NULL,
    domain        VARCHAR(10) NOT NULL CHECK (domain IN ('PU', 'PEOU', 'BI')),
    rating        SMALLINT    CHECK (rating BETWEEN 1 AND 5),
    remark        TEXT,
    answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, item_code)
);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_responses_session
    ON sme_tam_evaluation_responses(session_id);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_responses_account
    ON sme_tam_evaluation_responses(account_id);

-- Automatic time-on-module logging for this role's direct flow — same
-- shape and same single writer (services/tamEvaluation.js's
-- recordModuleVisit(), now role-aware) as expert_evaluation_module_visits
-- above, including the consent-first rule (nothing is logged until
-- consent_status = 'given', RA 10173) and the 30-minute idle cap.
CREATE TABLE IF NOT EXISTS sme_tam_evaluation_module_visits (
    id              SERIAL      PRIMARY KEY,
    session_id      INTEGER     NOT NULL REFERENCES sme_tam_evaluation_sessions(id) ON DELETE CASCADE,
    account_id      INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    module_slug     VARCHAR(60) NOT NULL,
    first_opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    open_count      INTEGER     NOT NULL DEFAULT 1,
    total_seconds   INTEGER     NOT NULL DEFAULT 0,
    UNIQUE (session_id, module_slug)
);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_module_visits_session
    ON sme_tam_evaluation_module_visits(session_id);

CREATE INDEX IF NOT EXISTS idx_sme_tam_evaluation_module_visits_account
    ON sme_tam_evaluation_module_visits(account_id);

-- ---------------------------------------------------------------------
-- Per-Template-Evaluator "default CSV for evaluation" — which of the 20
-- static SME template files (data/sme-templates/*_template.csv, each now
-- pre-populated with 50 synthetic, analytics-ready rows) a Template
-- Evaluator has chosen as their reference dataset. Once set, routes/
-- templates.js's GET /sme-templates/evaluation-data lets them browse and
-- filter those exact rows in a table, so they can cross-check the four
-- analytics reports' numbers against known source values during the TAM
-- walkthrough.
--
-- Template-Evaluator-only concept — an SME owner has nothing analogous,
-- since their reports are built from their own uploaded data, not a
-- shared static template — so this is stored the same way
-- business_sector already is for that role: a plain column on
-- sme_accounts, read/written only for Template Evaluator rows. It holds a
-- filename validated against the manifest (resolveTemplateFile() in
-- routes/templates.js), not a foreign key, because the templates are
-- static files checked into the repo rather than rows in any table.
-- ---------------------------------------------------------------------
ALTER TABLE sme_accounts
    ADD COLUMN IF NOT EXISTS evaluation_template_file VARCHAR(150);

-- ---------------------------------------------------------------------
-- Gating comparison — Admin-only instrumentation answering a peer-review
-- recommendation: does CAAGA's eligibility/suppression gate (the
-- "applicable: false rather than a fabricated number" discipline already
-- documented in claude/caaga-algorithm-revised.md) actually add value?
-- An Admin picks one already-uploaded dataset and runs Predictive/
-- Prescriptive Analytics against it twice — once with the gate's
-- evidence-strength thresholds enforced as normal ("on"), once with them
-- deliberately relaxed ("off", simulating a naively permissive tool that
-- shows a best-guess number regardless of how weak the evidence is) —
-- while every gate decision is logged, so the two runs can be counted
-- and compared afterward: how many outputs did the "off" run show that
-- "on" correctly suppressed, and did a rater's stated trust in an output
-- track how strong its underlying evidence actually was.
--
-- Deliberately NOT a change to the gate itself, and NOT unifying the
-- three independently-implemented gating systems flagged as a separate,
-- larger refactor in claude/caaga-algorithm-revised.md — this only toggles
-- the evidence-STRENGTH thresholds inside services/predictiveAnalyticsDynamic.js
-- and services/prescriptiveEngine.js for the lifetime of one comparison
-- run. A HARD gate (a column genuinely absent from the dataset, so there
-- is literally nothing to compute from) is never relaxed by either mode —
-- "off" only ever shows evidence that's weak, never evidence that's
-- fabricated from data that isn't there.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gating_comparison_runs (
    id                SERIAL PRIMARY KEY,
    dataset_row_id    INTEGER     NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
    admin_account_id  INTEGER     NOT NULL REFERENCES sme_accounts(id) ON DELETE CASCADE,
    gate_mode         VARCHAR(10) NOT NULL CHECK (gate_mode IN ('on', 'off')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_gating_comparison_runs_dataset
    ON gating_comparison_runs(dataset_row_id);

-- One row per gate decision actually evaluated while a run's pages were
-- viewed. `would_suppress` is the TRUE strict-gate verdict, computed the
-- same way regardless of which mode the run is in — it is what makes an
-- "off" run's rows directly comparable to an "on" run's: `shown` is the
-- actual rendering decision given the run's own gate_mode, so
-- `would_suppress = true AND shown = true` rows (only possible in an
-- "off" run) are exactly "an unsupported output the naive version
-- produced that the gate would have correctly suppressed."
CREATE TABLE IF NOT EXISTS gating_comparison_events (
    id                      SERIAL PRIMARY KEY,
    run_id                  INTEGER      NOT NULL REFERENCES gating_comparison_runs(id) ON DELETE CASCADE,
    module                  VARCHAR(30)  NOT NULL CHECK (module IN ('predictive', 'prescriptive')),
    output_key              VARCHAR(150) NOT NULL,  -- e.g. 'revenue_forecast', 'price_elasticity:Electronics', 'recommendation:REVENUE_DRIVERS'
    would_suppress          BOOLEAN      NOT NULL,
    shown                   BOOLEAN      NOT NULL,
    evidence_strength       NUMERIC,
    evidence_strength_kind  VARCHAR(30),            -- 'confidence' | 'sample_size' | 'months' | 'price_cv' — so a 0..1 confidence is never averaged together with a raw sample count
    reason                  TEXT,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gating_comparison_events_run
    ON gating_comparison_events(run_id);

-- A rater's stated trust in one specific output (1-5, same Likert scale
-- as the TAM instrument, for a familiar convention), tied to the run (and
-- therefore to its gate_mode) and the same output_key gating_comparison_events
-- uses — lets the report compare stated trust against the output's own
-- logged evidence_strength, which is the "did trust track the strength
-- of the evidence" measure the recommendation specifically asks for.
CREATE TABLE IF NOT EXISTS gating_comparison_trust_ratings (
    id            SERIAL PRIMARY KEY,
    run_id        INTEGER     NOT NULL REFERENCES gating_comparison_runs(id) ON DELETE CASCADE,
    output_key    VARCHAR(150) NOT NULL,
    trust_rating  SMALLINT    NOT NULL CHECK (trust_rating BETWEEN 1 AND 5),
    rater_label   VARCHAR(100),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gating_comparison_trust_ratings_run
    ON gating_comparison_trust_ratings(run_id);
