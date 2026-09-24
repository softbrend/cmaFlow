# CMA-Flow — sign-in / sign-up & navigation shell

A Node.js + Express web app for the CMA-Flow SME Owner Portal: sign-up, sign-in,
and the left-hand navigation shell (Descriptive analytics, Diagnostic
insights, Predictive analytics, Prescriptive recommendations, Upload New
Dataset, Browse Dataset, and Monetization discovery — deliberately placed
last, after the upload/browse steps, since it reads the raw files those
steps produce), backed by a local PostgreSQL database named **cmadb**.

All six steps of the conceptual framework's Process panel are fully wired
up and verified end to end against a live PostgreSQL-backed instance:
**Upload New Dataset**, **Browse Dataset**, **Descriptive analytics**,
**Diagnostic insights**, **Predictive analytics**, and **Prescriptive
recommendations** (see each section below). **Monetization discovery** — the
supporting module that sits alongside that six-step pipeline — is fully
wired up as well. There is no remaining stubbed or placeholder section in
the navigation shell: a former "Decision & simulation" nav item was removed
rather than built out, once verification showed its intended purpose —
dataset-grounded what-if scenario analysis, one of the three Prescriptive
Evidence outputs in the conceptual-framework diagram — was already fully
implemented by the **What-if scenario** tab under Predictive Analytics (see
that section below).

**Set-up monetization configuration** (`/setup-configuration`) still exists
as a route — it reads/writes the `monetization_configs` table and is still
reachable from the "Active monetization configurations are missing" banner
on the home page — but per this study's scope (the four-entity canonical
schema and its monetization-config setup are reserved for a future
dissertation extension, not part of this study's reported descriptive /
diagnostic / predictive / prescriptive pathway), it was removed from the
main navigation shell so it no longer reads as one of this study's six
reported pipeline steps.
**Upload New Dataset** lets an SME owner register a dataset (one Dataset
ID, name, optional domain) and attach **any number of CSV files at
once, each with its own free-form label** — there is no fixed set of
"the" file types a dataset must have. The upload form is a dynamic
"+ Add file" list: each row is one file picker plus a label text box (the
label defaults to the file's own name if left blank), and the server
accepts however many rows were actually submitted. A label is sanitized
into a lowercase `file_type` slug ("Feature Usage" → `feature_usage`),
and files sharing the same label merge into one continuous set — this is
what makes it possible to attach, say, twelve monthly exports all labeled
"Transactions" under a single Dataset ID in one submission, just as
readily as it's possible to attach five differently-shaped files (e.g.
Accounts, Subscriptions, Feature Usage, Churn Events, Support Tickets)
that don't correspond to any fixed CMA-named list at all. Every file gets
its own row in the `dataset_files` table (original filename, on-disk
path, row count), and every ingested row in `dataset_records` carries a
`source_file_id` pointing back to the exact physical file it came from —
several files of the same label merge into one continuous, browsable set
(`row_index` keeps counting up across files, e.g. file A's rows then file
B's rows) without colliding or losing which file a row originated from.
Rows are stored as JSONB — one row of JSON per CSV row, tagged with its
dataset and file type. JSONB (not fixed columns) is what makes varied
structures work: one SME owner's file might have completely different
columns from another's, or from what a "typical" CMA dataset looks like,
and nothing here assumes a fixed schema — whatever columns a file has are
what get stored and later browsed. The raw CSVs are also kept on disk
under `uploads/datasets/<account id>/<dataset id>/<file type>/`
(gitignored) as a backup/audit copy, but the database is the source of
truth for browsing. The whole submission (every file, however many)
ingests inside one database transaction: either the entire dataset
commits together, or none of it does — a bad CSV in file 8 of 12 rolls
back all 12, and the raw files are discarded from temp staging rather
than left half-written. **Browse Dataset** reads the ingested rows back
from cmaDB and lets the owner filter and page through them: a dropdown
filter for low-cardinality columns, a min/max range for numeric columns,
and a "contains" search for free-text/high-cardinality columns — computed
per dataset+file-type from its own actual columns (across however many
physical files make it up), not a shared schema. **Every uploaded file
shows up here individually, regardless of how many there are or what
label it was given** — "does this file type exist" is answered purely by
whether any rows were ever ingested for it (a `SELECT 1 ... LIMIT 1`
presence check), never by checking against a fixed list of allowed names,
so a newly uploaded file with an unfamiliar label is never hidden.
Every dataset, every upload, and every browse request is scoped to the
logged-in account (account_id foreign keys plus a WHERE clause on every
query) — one SME owner can never see, filter, or overwrite another's
uploads, even by guessing a dataset ID or numeric ID.

## Data Mapping & Transformation — the CMA Canonical Schema pipeline

Raw ingestion (above) deliberately keeps every SME owner's file exactly as
uploaded, in whatever columns it happens to have. That raw layer
(`dataset_records`) is **not** what downstream CMA analytics run against —
it's the permanent, untouched source of truth. From the Upload New Dataset
page, **Map & Transform runs for every file uploaded under one Dataset
ID together, as a single batch** — not one CSV file at a time. A dataset
with five files (say, Accounts, Subscriptions, Feature Usage, Churn
Events, and Support Tickets, all under one Dataset ID) gets one Map &
Transform screen showing all five, one combined "Confirm & Run
Transform" action, and one combined reconciliation summary — mapping
and freezing every file in one database transaction, so either the
whole batch commits together or none of it does. Each file still keeps
its own column mapping and its own choice of canonical entity (see
below), and its own `mapping_version` history, but confirming the batch
is one action, not several. Every mapped file feeds into the CMA
Canonical Schema (Customers / Transactions / Entitlements / Monetization
Config), following the same named stages as the CMA architecture diagrams:

```
Clean → Normalize → Transform → Tag → Enrich → Validate → Freeze
```

1. **Clean** (`services/transform.js: cleanRow`) — trims whitespace and
   treats blank/placeholder cells ("", "N/A", "-", "null", …) as absent.
   Never touches the raw row itself, only a working copy.
2. **Normalize** — converts each mapped value to its canonical field's
   declared type (`number`, `date`, or `string`). Numeric strings have
   currency symbols/commas stripped before parsing. Dates get special
   care: a numeric date like `01-08-2024` is genuinely ambiguous
   (day-first vs month-first), so `detectDateFormat()` scans every value
   in that source column ONCE — if any value's first token is >12, the
   whole column can only be day-first (DD-MM-YYYY), which is exactly what
   the sample GCP billing export uses — and applies that one consistent
   interpretation to every row, instead of guessing per-row and risking
   a silent, inconsistent misread of the data.
3. **Transform** (`transformRow`) — applies the SME owner's confirmed
   column → canonical-field mapping. A few fields can also be
   **calculated** when no direct column matches — e.g. `Transaction.amount
   = quantity × unit_price`, which is exactly the AWS Bedrock pricing case
   (`PricePerUnit` × usage, no single "amount" column).
4. **Tag** (`tagRecord`) — attaches a `_lineage` block (dataset id, file
   type, entity, source row index, mapping version) directly onto the
   canonical record's own JSON, so lineage is visible right in Browse/API
   output, not just in a separate database column.
5. **Enrich** (`enrichRecord`) — fills a small number of safe, conservative
   defaults (currently: currency defaults to `USD` when an amount/price is
   present but no currency column existed anywhere in the file). Never
   invents business-meaningful values.
6. **Validate** (`validateRecord`) — checks required canonical fields are
   present and numeric fields actually parsed as numbers. Returns a list
   of human-readable reasons; an empty list means the row is valid.
7. **Freeze** (`freezeRecords`) — writes every row (valid AND invalid) into
   `canonical_records`, append-only. A row that fails validation is still
   frozen — with `status='invalid'` and its reasons recorded — never
   silently dropped, so `total processed === valid + invalid` always holds
   and the SME owner can see and act on exactly what didn't make it across.

**Choosing the canonical entity is a separate, explicit step from picking
a file — made per file, inside the one dataset-wide batch screen.** A
file's label (whatever the SME owner typed at upload time — "Accounts",
"Feature Usage", "Churn Events", or anything else) never determines which
of the four canonical entities it becomes; those are independent choices
by design, since real-world file names don't map 1:1 onto
Customer/Transaction/Entitlement/MonetizationConfig. Each file's block on
the Map & Transform screen has its own entity switcher (all four options,
always available) with `services/mapping.js: guessEntity()` pre-selecting
a non-authoritative default from keyword hints in the file's label (e.g.
"subscriptions" → Entitlement, "feature_usage" → Transaction, "accounts"
→ Customer) — purely a starting point the SME owner is free to override
before reviewing that file's column mapping. Switching one file's entity
reloads just that file's column-mapping suggestions (the page remembers
every other file's currently selected entity via the URL, so switching
one never resets the rest); each file's confirmed entity travels with
its own mapping and is what the transform pipeline and canonical
browsing key on for that file.

**How column mapping is suggested.** `services/mapping.js` auto-suggests
which of a file's own columns feeds each canonical field of the chosen
entity, using a synonym dictionary per field (`db/canonicalSchema.js`)
and a normalized (lowercased, alphanumeric-only) match: exact synonym
match scores 0.9+, a partial/substring match scores 0.6, and assignment
is greedy highest-confidence-first so one column is never claimed by two
canonical fields. **Nothing is applied automatically** — the SME owner
reviews and can change every suggested column on the Map screen before
anything is transformed.

**Canonical schema fields — optional additions for Diagnostic/Predictive/
Prescriptive analytics (Phase 1, see `claude/canonical-schema-analytics-
roadmap.md` in the project docs).** The four entities' required fields are
unchanged — every dataset that mapped and validated cleanly before still
does, identically. Ten new fields were added, all `required: false`, so a
file with none of these columns transforms exactly as it did before (the
field just resolves to `null`, never fabricated):

| Entity | New field | Type | Why |
| --- | --- | --- | --- |
| Customer | `acquisition_date` | date | Real tenure instead of inferring it from activity gaps. |
| Customer | `acquisition_channel` | string | Which channel/source acquired this customer. |
| Customer | `churn_date` | date | Real churn signal instead of inferring it from inactivity. |
| Transaction | `transaction_type` | string | Backbone of a future revenue bridge (new/expansion/contraction/churn revenue). |
| Transaction | `config_id` | string | Traces a transaction to the exact `MonetizationConfig` row that priced it. |
| Entitlement | `cancellation_reason` | string | Root-causing why entitlements end. |
| Entitlement | `auto_renew` | string | Standalone churn-risk signal. |
| Entitlement | `config_id` | string | Traces an entitlement to the exact price it was signed at. |
| MonetizationConfig | `effective_from` | date | Start of this price's effective window. |
| MonetizationConfig | `effective_to` | date | End of this price's effective window, if it has ended. |

Each carries its own synonym list (`db/canonicalSchema.js`), so
`suggestMapping()` picks them up automatically from realistic SME column
headers (e.g. "Signup Date", "Cancellation Reason", "Effective Date") with
no other pipeline change — Clean/Normalize/Transform/Tag/Enrich/Validate/
Freeze treat them like any other optional field. `effective_from` /
`effective_to` are the highest-leverage of the ten: without a real
effective-date range, a configured price is only ever a single current
snapshot, never a history, which is what will eventually let Diagnostic
reconciliation and Prescriptive elasticity modeling reconstruct "what was
this product's price when THIS transaction happened" instead of assuming
one flat price throughout. These fields are schema-only in this phase —
no new analytics tab reads them yet; that's Phases 2–4 of the roadmap doc.

**Integrity & reproducibility guarantees:**
- The raw layer (`dataset_records`) is only ever *read* by the pipeline,
  never written to or mutated.
- Every canonical record carries `source_record_id` — a hard foreign key
  back to the exact raw row it was derived from — plus `mapping_version`
  and its own `file_type` column, so any canonical value can always be
  traced back to the original CSV cell and file, and reproduced from the
  same confirmed mapping. `file_type` (rather than `entity`) is what
  Map & Transform and canonical browsing key on, since — now that entity
  is a free choice, not derived from the file — two differently-labeled
  files in the same dataset could otherwise both map to the same entity
  and become ambiguous to tell apart.
- Mappings are versioned (`dataset_mappings.mapping_version`, unique per
  `dataset_id, file_type`): re-mapping and re-running the transform (e.g.
  after fixing a column choice, or after picking a different canonical
  entity) creates a new version rather than overwriting the old one —
  every prior frozen batch stays intact for audit, and the UI always
  shows the *latest* version's results for that file.
- Reconciliation is enforced by construction, not just checked after the
  fact: Freeze always writes one row per input row, so a mismatch between
  "raw rows processed" and "valid + invalid" can never happen — and the
  transform-results screen shows this both per file and totaled across
  the whole batch.

**Where this lives in the app:** from **Upload New Dataset**, a dataset
with any unmapped files shows one **Map & Transform entire dataset**
button (or, once every file is mapped, its combined valid/invalid totals
plus an **Adjust mapping & re-run** button) leading to
`/upload-dataset/:id/map` — one page, one form, listing every file in
that Dataset ID as its own block (entity switcher + column-mapping
table) with a single "Confirm Mapping & Run Transform" action at the
bottom that runs the whole batch in one transaction. That posts to the
same `/upload-dataset/:id/map` route and renders a combined
transform-results screen (batch-wide reconciliation totals, then a
per-file breakdown table) linking each file to
`/canonical-dataset/:id/:fileType` (browse that file's frozen canonical
records, filterable by valid/invalid, with each invalid row's reasons
shown inline).

**Set-up monetization configuration** has two ways to get a configuration
onto the account: an **Import from Canonical Schema** section (the
default, data-driven path when the account has transformed pricing
data) and the original manual-entry form (kept unchanged as the
fallback for accounts with no Monetization Config data at all). Import
candidates are computed from the *latest* valid, frozen
`MonetizationConfig` canonical records — one candidate per distinct
`product_service` — never from raw rows one at a time, and never from a
stale `mapping_version` if the underlying file has since been re-mapped
and re-transformed. Each candidate aggregates its group's price range
(min/max/avg), distinct tier count, row count, source dataset/file, and
every distinct raw `model_type` value found in the data; when a group's
`model_type` values are unambiguous (exactly one distinct value), a
non-authoritative suggestion pre-selects a CMA revenue model in the
dropdown (`guessConfigModelType()` in `services/mapping.js`, the same
non-authoritative-suggestion pattern as `guessEntity()`), but the SME
owner always confirms or changes it — nothing is ever auto-applied.
Ticking a candidate's checkbox, adjusting its name/model if needed, and
submitting **Import selected as configurations** is the only thing that
writes anything: `POST /setup-configuration/import` recomputes the
candidates server-side (never trusting the submitted form's numbers),
validates every selected row atomically — the whole import is rejected
if any selected candidate is missing a valid revenue model, so nothing
is created half-configured — and inserts one `monetization_configs` row
per selection with `is_active = true`, identical to a manually-created
configuration. Imported rows are distinguished only by
`details.source = 'canonical_import'` (plus the aggregated stats and
lineage — product/service, price stats, currency, tier/row counts,
source dataset IDs and file types, import timestamp) stored in the
existing `details` JSONB column — no schema changes were needed for this
feature. Both the Set-up screen's "Existing configurations" table and
the Monetization Intelligence home page show a **Derived from data**
badge on imported configurations so it's always clear which
configurations came from data versus manual entry; every active
configuration, imported or manual, is picked up identically by the
Monetization Intelligence home page (it just reads
`WHERE is_active = true`, unchanged).

**Descriptive analytics** is "historical and current-state views of how
this SME account is earning revenue today," computed entirely from the CMA
Canonical Schema — the frozen `canonical_records` Map & Transform produces
— for **one Dataset ID at a time**, picked via a dropdown at the top of
the page (an account with several uploaded datasets gets a full,
independent analytics view per dataset, defaulting to the most recently
uploaded one). Like every other screen that reads canonical data, it only
ever looks at the *latest* `mapping_version` per file and only
`status='valid'` rows, so a re-mapped/re-run file never double-counts.

The page is split into **eight selectable views** (`?view=`, a tab pill
per view, alongside the `?dataset=` picker), matching the CMA
descriptive-analytics matrix — one CMA area, one tab:

| Tab | CMA area | What it shows |
| --- | --- | --- |
| Customers | Customer profiling & segmentation | Customers by segment, by region, and by monetization mechanism |
| Transactions | Revenue analysis | Total revenue (w/ month-over-month delta), transaction count, avg. transaction value, revenue trend, revenue by product/service, top customers |
| Mechanisms | Mechanism performance | Revenue by CMA model (Subscription/Freemium/Pay-per-use/DaaS) + a detail table (revenue, transaction count, avg. value, % of total per model) |
| Entitlements | Access/entitlement analysis | Active/Expired/Other counts (normalized), an "Upgraded" count, and the raw as-recorded status breakdown |
| Configuration | Configuration utilization | This account's active configuration(s), total versions created, switching frequency, full configuration history — plus the Pricing Catalog Overview |
| Switching | Monetization-switch history | Account-level model switches (e.g. Subscription → Pay-per-use) and dataset-level entitlement plan switches (e.g. Basic → Pro) |
| Reconciliation | Financial summaries | Expected vs. actual revenue and variance, computed from this dataset's own configured pricing |
| Dataset analysis | Dataset/domain summaries | This dataset's domain, plus revenue/usage rolled up by domain (Olist, AWS, GCP, ...) across every dataset this account has uploaded |

All eight views' chart cards are built in one pass per request (the
underlying aggregation is cheap, in-memory work over an already-fetched
dataset), so switching tabs is an ordinary server-rendered navigation, not
a second round of database queries. Two of the eight intentionally read
past the selected dataset: **Configuration** and **Switching**'s
account-level halves read `monetization_configs` — the SME's actual
Set-up Monetization Configuration history, a business-level decision that
isn't tied to any one upload — and **Dataset analysis** reads every
dataset this account owns, rolled up by `uploaded_datasets.domain`, so
domains can be compared rather than browsed one at a time. Every other
view stays strictly scoped to the one selected dataset ID.

A few of the views' algorithms are worth calling out:

- **Mechanisms' revenue-by-model join.** Since Map & Transform already
  produced this same dataset's `MonetizationConfig` canonical records,
  `services/analytics.js` joins each `Transaction.product_service` to its
  `MonetizationConfig` record (in memory — both sides are already-frozen
  JSONB for the same dataset) and normalizes the SME's own free-form
  `model_type` text into one of the four CMA revenue models with the same
  non-authoritative `guessConfigModelType()` heuristic the Import from
  Canonical Schema screen uses; a product with no matching Monetization
  Config data (or an unrecognized model_type) falls into an
  "Unclassified" bucket rather than being silently dropped or guessed
  into the wrong bucket. **Customers'** "by monetization mechanism" chart
  reuses this same join, one level up: each customer is counted under
  whichever model their own transactions land on most often (falling
  back to their Entitlement rows' product when they have no transactions
  yet), so "Unclassified" there means "not yet billed under any
  mechanism" — a real, honest count, not an error state.
- **Entitlements' Active/Expired/Other normalization.** A row's raw
  `status` text is pattern-matched first ("active", "expire", "suspend"/
  "cancel"); a row with no status text at all falls back to comparing
  `start_date`/`end_date` against today. "Upgraded" isn't a status value
  in the canonical schema — it's detected separately, by
  `detectPlanChanges()`, which groups this dataset's Entitlement rows by
  `(customer_id, product_service)`, orders each group by `start_date`,
  and records every point where `plan` actually changed between one
  record and the next for that same customer+product (e.g. "Basic" →
  "Pro"). The same detection feeds the Switching tab's entitlement-side
  history.
- **Switching's configuration-side history.** `monetization_configs` has
  no explicit "superseded_at" column — several configs can coexist with
  `is_active = true` at once (e.g. one per product). `configSwitchHistory()`
  treats the account's configs in **creation order** as a proxy timeline
  and records a transition wherever `model_type` changes from one config
  to the next. This is a documented simplifying assumption, not a hidden
  one: it's the best signal this schema has for "the account moved from
  running model A to model B," and it degrades safely — zero or one
  config always yields zero transitions rather than a fabricated switch.
- **Reconciliation's expected-vs-actual.** Only computed when a dataset
  has *both* Transaction and MonetizationConfig data — like revenue
  itself, "expected vs. actual" means nothing without an actual
  transaction to compare against, so this returns `null` (rendered as an
  explanatory empty state, not a zero) rather than fabricate a number
  from one side alone. Where both exist: expected amount per transaction
  = its quantity (defaulting to 1 unit when the dataset carries none)
  times the *average* configured price for that product — averaged
  because a product can have several tiers and a transaction's canonical
  data doesn't say which tier it billed under, so this is a deliberately
  simple baseline, not a tier-exact recomputation. A transaction whose
  product has no configured price at all can't be reconciled either way,
  so it's counted separately as "unmatched" (shown as a caveat line) and
  excluded from both totals rather than silently treated as zero
  variance.
- **Dataset analysis' domain rollup.** A single SQL query (the same
  "latest `mapping_version` per file_type, valid only" pattern as
  everywhere else) `LEFT JOIN`s every one of the account's datasets
  against their latest valid Transaction data, so a dataset with zero
  transactions still appears in the domain comparison at USD 0 rather
  than being silently dropped — exactly the shape of the real
  `SME_Pricing_01`/AWS scenario this feature was built to handle
  honestly (see below).

Every chart is a single-accent-hue horizontal bar list or line (never a
multi-color/categorical palette — these all answer "compare magnitude" or
"trend over time" for one measure, not "tell distinct series apart"), is
always direct-labeled with its exact value (nothing is hover-only), folds
long tails past the top 6 categories into a muted "Other" bucket instead
of listing 20 tiny bars, and carries a "View as table" `<details>` twin
for every chart — the accessible, exact-numbers equivalent, native HTML,
no JavaScript required. All chart HTML is generated server-side in
`services/charts.js` from plain data objects `services/analytics.js`
computes — the view (`views/dashboard/descriptive-analytics.ejs`) just
injects the ready-made markup — and every piece of row-derived text
(product names, customer names, segment/region/status values — original
SME CSV cell contents) is HTML-escaped before it's built into a chart, since
that HTML is assembled as plain JS strings rather than through EJS's
auto-escaping `<%= %>`.

**Data prerequisites, per view — the algorithm is explicit about what each
chart needs and never fabricates what it doesn't have.** Revenue trend,
revenue by monetization model, revenue by product/service, and top
customers by revenue all require **Transaction** canonical data — revenue,
by definition, is an actual transacted amount, so these are always `0`/empty
for a dataset that hasn't had a file mapped to Transaction yet, no matter
how much other data exists. Customers by segment/region requires
**Customer** data; entitlements by status requires **Entitlement** data.
This matters concretely for a common real case: a cloud provider's raw
SKU/price-list export (e.g. an AWS Price List bulk API dump — columns like
`SKU`, `PricePerUnit`, `TermType`, `ProductFamily`, no customer field
anywhere) is **entirely** `MonetizationConfig`-shaped — it's a rate card,
not a record of anything a customer did — so a dataset built only from
files like that will correctly show `0` transactions/customers/entitlements
forever, however many pricing rows it has. Mapping such a file to
Transaction instead won't produce revenue either: `customer_id` is
required for a valid Transaction record and a price list has no such
column to map, so every resulting row fails Validate and freezes as
`status='invalid'` — a larger dataset, not a fix.

Because a pricing-only dataset is a completely normal, expected shape (not
missing data to explain away), the page has a second, independent
computation for it: **Pricing Catalog Overview**, in
`buildCatalogOverview()` (`services/analytics.js`), reads *only*
`MonetizationConfig` records — number of distinct products priced, how
many CMA revenue models are represented among them, total configured SKUs,
a count-based "SKUs by monetization model" bar (counts, not revenue, so it
needs no Transaction join at all), and a per-product price-range table.
That table is deliberately a table, not a bar chart: different products
are routinely priced in incomparable units (`$/API-call` vs. `$/GB-month`
vs. `$/hour`), so ranking raw price magnitudes against each other across
units would misstate the data the same way a dual-axis chart does. It
lives on the **Configuration** tab (pricing is a configuration question),
appended below the account's configuration history, and only renders when
this dataset actually has Monetization Config data.

Each of the eight tabs decides its own empty state from what's actually
present, rather than one page-wide banner hiding everything: a dataset
that's entirely a pricing catalog (like the real `SME_Pricing_01`/AWS
case that motivated this) shows real charts on Configuration (the Pricing
Catalog Overview) and Dataset analysis (it still appears in the domain
rollup, at USD 0), while Transactions, Mechanisms, Customers, and
Reconciliation each show a short, specific explanation of what's missing
and where to map it — never a fabricated number and never a wall of
identical "no data yet" cards.

**Mapping & transform status — the always-visible answer to "why is this
tab empty."** A dataset can look "done" from the SME owner's side (every
file uploaded, every file run through Map & Transform) and still produce
zero rows in a given canonical entity — because the SME owner mapped a
file to an entity its columns can't actually satisfy (e.g. a price-list
file mapped to Transaction, but with no column to map to the required
`customer_id`, so every row fails Validate), or because a file was
uploaded but never mapped at all. Both are real, common outcomes, not
bugs — but from a chart showing "0" alone there's no way to tell which
one happened, or that transformation even ran. `getDatasetMappingStatus()`
(`services/analytics.js`) answers this directly: for every physical file
in the selected dataset, it reports the file's row count, which canonical
entity it was last mapped to (or "Not yet mapped," when no
`dataset_mappings` row exists for it at all), and — from that latest
`mapping_version`'s frozen `canonical_records` — how many rows froze
valid vs. invalid, plus up to three of the actual Validate-stage error
strings for the invalid ones (e.g. `Missing required field "customer_id"
...`), read straight out of `canonical_records.validation_errors`, never
re-derived or guessed. This renders as a `<details>` panel right below
the dataset picker — above the tab nav, so it's visible regardless of
which tab is open — auto-expanded whenever there's something to explain
(an unmapped file, or any invalid rows) and collapsed when every file
transformed cleanly. This is the fix for a real support case: an account
whose five AWS files were genuinely all pricing data (see above) looked,
from the Customers tab alone, indistinguishable from an account whose
mapping had silently failed to save — this panel makes that distinction
visible on the page itself, file by file, without making the SME owner
cross-reference Browse Dataset and Map & Transform by hand.

## Monetization discovery — infers mechanisms from behavior, not labels

`/monetization-discovery` sits in the nav after Upload New Dataset and
Browse Dataset, reading directly off whichever raw files those steps
produced — content-aware, not canonical-schema-gated: CMA-Flow does not
ask the SME owner which revenue mechanism they use, and it does not just
read whatever text happens to be in a pricing file's `model_type`-shaped
column either — that second shortcut is what the app did before this
screen existed, and it's why "revenue by mechanism" used to go straight
to Unclassified for any dataset whose pricing file didn't happen to spell
out a model_type string.

`services/monetizationDiscovery.js`'s `discoverMechanisms()` infers each
product's mechanism from how customers actually behave in the dataset's
own raw, auto-detected Transaction/Entitlement-shaped data —
`pickRawEntityRows()` (`services/analytics.js`) finds whichever uploaded
file looks like transaction or entitlement data by scoring its actual
columns (the same heuristic Map & Transform itself starts from), so
discovery works the moment a file is uploaded, with no Map & Transform
step required (the CMA Canonical Schema is reserved for a future
dissertation extension — see `claude/cma-flow-app-conceptual-framework-
audit.md` in the project docs):

- **Subscription** — a customer is charged a consistent amount on a
  regular (weekly/monthly/quarterly/annual) cadence; the product's score
  is the share of repeat customers that show this pattern.
- **Pay-per-use** — billed amount scales with a recorded usage quantity
  at a roughly constant per-unit rate (the strong case), or, lacking a
  quantity column, irregular timing and irregular amounts together (a
  weaker, explicitly-labeled-as-weaker fallback).
- **Freemium** — among customers holding an entitlement to a product,
  some pay nothing (no transactions, or $0 total) while others pay real
  money for the same product — a behavioral free/paid split, not a
  "free" word in a plan name (though that's folded in as a small
  corroborating hint).
- **Data-as-a-Service** — the product's own name/usage-type/pricing-unit
  references a dataset, API, report, or feed, AND paid access to it is
  recorded. This is a content classification ("what is being sold"), not
  a billing-pattern one, so it can override a billing read (a metered
  API is still Data-as-a-Service, per the definition that paid API/
  dataset/report access suggests it regardless of how it's billed).

A stated `MonetizationConfig.model_type` label, when present, is folded
in as a small corroborating bonus on top of whichever behavioral score it
agrees with — and, critically, **only when that behavioral signal already
has real sample evidence behind it**. A pure rate-card dataset with zero
Transaction/Entitlement rows at all gets an honest "none of the four
mechanisms have a clear signal yet," never a confident-looking guess
manufactured from the label alone — that would just be the same shortcut
this engine exists to replace, one level removed.

Every inference carries its evidence as plain sentences and a
Low/Medium/High confidence band (capped when the sample is thin), and two
signals landing close together flags the product as a possible hybrid.
None of this is authoritative by itself: the SME owner reviews it on
`/monetization-discovery`, per product, and can confirm it as-is or
correct it to a different mechanism entirely. A confirmed choice is
persisted (`monetization_classifications`, one row per dataset+product,
keyed by product name so it applies equally whether the underlying data
is raw or canonical) and takes precedence everywhere downstream forever
after — Revenue & Growth's revenue-by-mechanism chart, and Prescriptive's
recommendation ranking, all read from this ONE merged (confirmed >
inferred) map, which replaces the old `buildProductModelMap()` that read
the raw label directly. An unconfirmed product keeps using the live
inference in the meantime — recomputed fresh on every visit against
whatever this dataset's raw files currently contain — so nothing is
blocked waiting on a manual step.

**Requires a database migration** (unlike the Phase 1–4 work, which only
added optional JSONB fields): `monetization_classifications` is a new
table, added to `db/schema.sql`. Run `npm run db:init` against the
production database after deploying this change — it's idempotent
(`CREATE TABLE IF NOT EXISTS`), so it's safe to run even if some other
schema change already applied.

## Diagnostic insights — Phase 2 of the analytics roadmap

`/diagnostic-insights` answers "why did monetization performance move,"
not just "what happened" — the next layer up from Descriptive Analytics,
computed the same way: a derived-computation module
(`services/diagnosticAnalytics.js`) reading the same four canonical
entities, no new schema, one Dataset ID at a time. Three tabs:

- **Revenue bridge** (`revenueBridge()`) — the classic SaaS decomposition
  of month-over-month revenue change into New / Expansion / Contraction /
  Churned, computed per customer from ordinary `amount`/`customer_id`/
  `timestamp` fields (no Phase 1 field required). Compares the two most
  recent months with transaction data; returns `null` — rendered as an
  explicit "needs at least two months" notice — when there's only one.
  Alongside it, **revenue by transaction type** (`revenueByTransactionType()`)
  breaks the same revenue down by the optional `transaction_type` field
  when a dataset has it populated.
- **Price-change impact** (`priceChangeImpact()`) — for every product with
  two or more `MonetizationConfig` price points carrying different prices
  AND an `effective_from` date, compares Transaction revenue and volume in
  the window immediately before vs. after each detected change. A
  product/transition is only reported when there's real transaction data
  on *both* sides of the boundary to compare — never a fabricated
  half-comparison. This same function is reused as-is by Prescriptive's
  elasticity read below.
- **Cancellation reasons** (`cancellationReasonsRanked()`) — entitlements
  ranked by the optional `cancellation_reason` field.

A small always-visible coverage readout (`diagnosticCoverage()`) shows
what fraction of this dataset's transactions/configs/entitlements
actually carry each Phase 1 field — the same "why is this thin" discipline
as the Mapping & transform status panel above, so a sparse diagnostic view
is never mistaken for a broken one.

## Predictive analytics — Phase 3 of the analytics roadmap

`/predictive-analytics` (`services/predictiveAnalytics.js`) is a
per-customer feature layer feeding a deliberately RULES-BASED churn-risk
score — not a trained model, so every number traces back to a named rule
a non-technical SME owner (and a DIT committee) can audit. Three tabs:

- **Customer risk** — `buildCustomerFeatures()` computes, per customer:
  tenure (from `acquisition_date` when present, else the customer's
  earliest transaction), recency (days since last transaction), frequency
  (transaction count), monetary (total revenue), and a 0-and-up
  churn-risk score built from recency thresholds, the optional
  `auto_renew` field, entitlement status, and transaction frequency,
  banded into Low / Medium / High. A customer with a populated
  `churn_date` is reported as "Churned" outright, never scored; a
  customer with neither transactions nor entitlements gets "Insufficient
  data" rather than a fabricated band.
- **Lifecycle stages** — the same features bucketed into New / Active /
  At risk / Churned / Unclassified.
- **Revenue forecast** — `revenueForecast()` fits an ordinary
  least-squares trend line over this dataset's own monthly revenue
  history and projects 3 months forward. Deliberately the simplest
  defensible method, not a time-series model; returns `null` (rendered as
  an explicit notice) with fewer than 3 months of history rather than
  projecting from too little data.

## Prescriptive recommendations — Phase 4 of the analytics roadmap

`/prescriptive-recommendations` (`services/prescriptiveAnalytics.js`)
deliberately REUSES the same performance baseline Descriptive Analytics
already computes — `mechanismPerformanceTable()`, `financialReconciliation()`,
`buildCatalogOverview()` — plus Diagnostic's `priceChangeImpact()`, rather
than re-deriving any of it differently, and turns them into a ranked,
reasoned recommendation of which CMA revenue model (Subscription /
Freemium / Pay-per-use / Data-as-a-Service) to lean into next. Three tabs:

- **Current performance** — this dataset's mechanism performance table and
  financial reconciliation, presented as the "how is the current
  configuration doing" baseline every recommendation is measured against.
- **Price elasticity** — `elasticitySummary()` averages
  (%volume change ÷ %price change) across every comparable price change
  `priceChangeImpact()` detects; `available: false` when the dataset has
  no comparable price change yet (the common case today, since
  `effective_from` is a brand-new optional field).
- **Recommendation** — `rankConfigurationRecommendations()` scores each of
  the four CMA models from its current revenue share, the elasticity read
  (inelastic demand favors Subscription, elastic demand favors
  Pay-per-use), and catalog shape (multiple tiers favor Freemium; a
  data/API-named product favors Data-as-a-Service). Every candidate always
  carries its reasoning as plain sentences — there is no bare numeric
  score shown without it, by design. Financial reconciliation's
  expected-vs-actual variance is reported as a separate, dataset-wide note
  rather than folded into any one model's score, since a reconciliation
  gap is a pricing-accuracy signal across the whole dataset, not evidence
  for one mechanism over another.

See `claude/canonical-schema-analytics-roadmap.md` in the project docs for
the full design rationale behind all three phases.

## Requirements

- Node.js 18+
- A local PostgreSQL server with a database named `cmadb` (create it first:
  `createdb cmadb`, or `CREATE DATABASE cmadb;` in `psql`)

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your local Postgres user/password
npm run db:init      # creates/updates the tables in cmadb — safe to re-run any time
npm start             # http://localhost:3000
```

If you already had this app set up before, just run `npm install` again to
pick up new dependencies (`multer`, `csv-parse`) and re-run `npm run db:init`
— it only adds new tables and won't touch your existing data.

Then open http://localhost:3000/signup to create the first SME account.

## Project layout

```
server.js              Express app entry point
db/schema.sql           Table definitions (…, uploaded_datasets, dataset_files, dataset_records,
                          dataset_mappings, canonical_records — file_type columns are free-form
                          slugs, not a fixed enum; canonical_records.file_type disambiguates
                          which file produced a frozen row)
db/pool.js               PostgreSQL connection pool (reads .env)
db/init.js                Applies schema.sql — `npm run db:init`
db/ingest.js               Batched JSONB insert of parsed CSV rows into dataset_records
                             (source_file_id + startRowIndex merge multiple files of one label)
db/canonicalSchema.js       The CMA Canonical Schema: Customer/Transaction/Entitlement/
                              MonetizationConfig field definitions + synonym dictionary
                              (no file-name → entity mapping lives here — that's a runtime choice)
services/mapping.js          Mapping-suggestion engine (column → canonical field, with confidence)
                               + guessEntity() (non-authoritative default entity suggestion
                               from a file's label, for the Map & Transform entity switcher)
services/transform.js         The Clean→Normalize→Transform→Tag→Enrich→Validate→Freeze pipeline
middleware/auth.js       Session-based auth guards
middleware/upload.js      Multer config for a dynamic list of file_<n>/label_<n> rows (any
                           number of files, each with its own SME-chosen label); stages
                           uploads in a temp folder, then finalizeDatasetUpload()/
                           discardDatasetUpload() move or discard them once the database
                           outcome is known
middleware/browse.js      CSV parsing (for ingestion) + humanizeFileType() (slug → display
                           label) + filter-metadata + filtering
routes/auth.js             Sign-up / sign-in / sign-out
routes/dashboard.js        Portal home + nav stubs + config setup + dataset upload/ingest +
                             dataset browsing + canonical-schema mapping/transform/browsing
views/                       EJS templates (layout, sidebar, forms, pages)
public/css/style.css        All styling (dark green / gold theme)
uploads/datasets/            Raw uploaded CSVs, kept as a backup copy (created at runtime, gitignored)
uploads/_tmp/                 Transient staging area during an upload request (gitignored, self-cleaning)
```

## Notes

- Passwords are hashed with bcryptjs (12 rounds); never stored in plain
  text. This is the pure-JS `bcryptjs` package rather than the native
  `bcrypt` package on purpose — `bcrypt` needs a C++ compiler toolchain
  (node-gyp/Visual Studio Build Tools on Windows) to install, which is a
  common source of install failures; `bcryptjs` needs nothing extra and
  produces the same `$2a$`/`$2b$` hash format.
- Sessions are stored in cmaDB itself via `connect-pg-simple` (a `session`
  table is created automatically on first run).
- `.env` is gitignored — real credentials never get committed.
- To add real analytics/prediction logic to one of the stub sections, edit
  the matching route in `routes/dashboard.js` (`STUB_SECTIONS` array) and its
  `views/dashboard/placeholder.ejs`-based render.
- Upload ingestion (CSV → `dataset_records`) runs inside one database
  transaction alongside the `uploaded_datasets` insert, covering every file
  attached to that submission: if any one file fails to
  parse, or the Dataset ID is already taken, everything rolls back together
  and all the raw files are discarded from their temp staging folder — no
  half-ingested dataset is ever left behind, and no other dataset's files
  are ever touched (see `middleware/upload.js`).
- A dataset isn't limited to a fixed set of file types or one file each —
  the upload form is a dynamic "+ Add file" list (`file_<n>`/`label_<n>`
  field pairs), so an SME owner can attach any number of files with any
  labels, e.g. several months of exports all labeled "Transactions" under
  one Dataset ID at once, or five differently-named files that don't
  correspond to any fixed list at all. Every physical file gets its own
  `dataset_files` row (name, path, row count), and
  `dataset_records.source_file_id` traces each ingested row back to
  the exact file it came from, with `row_index` counting continuously
  across files sharing the same label so they merge into one ordered,
  browsable set rather than colliding or interleaving.
- Which of the four CMA canonical entities a file maps into is chosen
  explicitly by the SME owner on the Map & Transform screen — never
  inferred from the file's label — since one owner's "events.csv" might
  be Transactions and another's might be Entitlements.
  `services/mapping.js: guessEntity()` only pre-selects a starting
  suggestion from keyword hints in the label.
- Columns with ≤25 distinct values get a dropdown filter, all-numeric
  columns get a min/max range filter, everything else gets a "contains"
  text filter — see `SELECT_DISTINCT_LIMIT` in `middleware/browse.js` to
  change that threshold. Ingestion is capped at 200,000 rows per file
  (`MAX_ROWS_PARSED`) as a safety limit.
- Browse Dataset currently loads all of a file's ingested rows from
  `dataset_records` and filters/paginates them in Node. That's simple and
  fast enough at the scale this app targets; the `data` column also has a
  GIN index already in place, so pushing filters down into SQL
  (`WHERE data->>'region' = $1`) is a straightforward follow-up if a
  dataset grows large enough to need it.
