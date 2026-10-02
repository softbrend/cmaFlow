# Revision Plan: Real-SME Field Study + Semantic-Role Held-Out Retest

Written 2 October 2026, in response to the editorial team's first-revision
letter (reproduced in full below). Scopes the two load-bearing gaps in
that letter — everything else the letter raises either traces back to
these two or is already addressed by `claude/gating-comparison.md`
(recommendation #2, built) and `claude/template-evaluator-rename-and-cohort-tagging.md`
(the `cohort` column, which this plan now actually uses).

## The editorial feedback

> While the proposed CMA-Flow artefact addresses a relevant
> information-systems problem and is supported by extensive functional
> verification, the current evaluation remains primarily focused on
> technical correctness rather than on demonstrating the effectiveness
> of the proposed design in its intended organizational context. In
> particular, the semantic-role inference component shows limited
> generalization on unfamiliar datasets, while the user evaluation is
> restricted to a small cohort of technically literate graduate students
> acting as SME owners and therefore provides only preliminary usability
> evidence rather than validation of decision-support effectiveness in
> SMEs. Given that the principal contribution lies in the integration
> and orchestration of existing analytical techniques, we consider
> stronger empirical validation of the resulting design and its
> decision-support value necessary before proceeding to external
> review.

Four complaints, two of which can be answered by minor reframing of
work already in progress (the gate-comparison feature answers the
"integration of existing techniques" point) and two of which are
genuine gaps with nothing in the app or the manuscript currently
addressing them:

1. **Semantic-role generalization on unfamiliar datasets** — tooling
   exists (`claude/semantic-role-inference-evaluation.md`), the actual
   run against real, held-out data does not.
2. **Decision-support effectiveness in SMEs, validated with a real
   cohort** — nothing in the app today captures a decision at all, let
   alone rates its quality, and no respondent so far is an independent
   real SME owner.

This doc scopes a minimal, fundable, dissertation-timeline-realistic
version of each.

---

## Part 1 — Semantic-role held-out retest

### Why this one goes first

Zero new engineering. `scripts/exportSemanticRoleEvaluation.js` and
`scripts/evaluate_semantic_role_inference.py` are written, smoke-tested,
and already sitting in `D:\CMAFlow-Balala\scripts\`. The classifier
was trained on a 519-row *synthetic* seed set — the 17 real MIT 267
datasets were never part of training, so they are already legitimately
held-out data; nothing needs to be collected. What remains is logistics,
not code.

### Checklist

1. **Identify the 17 real dataset IDs.** Query `uploaded_datasets` (or
   use the admin "Manage Datasets" list) for the genuine MIT 267
   course-cohort uploads, excluding every `auditbot`/`verifybot`/
   `icontest`/QA-style test account. Paste the resulting `dataset_id`
   values into `INCLUDE_DATASET_IDS` at the top of
   `scripts/exportSemanticRoleEvaluation.js` — it is empty on purpose
   and will warn loudly if left that way, specifically so this step
   can't be skipped by accident.
2. **Run the export.** `node scripts/exportSemanticRoleEvaluation.js`
   against the production database produces `caaga_role_predictions.csv`
   (CAAGA's actual predictions, pulled through the same code path
   production uses) and `rater_labeling_template.csv` (blank
   `rater1_label` / `rater2_label` / `resolved_label` columns, ready to
   hand out).
3. **Recruit two independent raters.** Does not require ML expertise —
   just someone who can read a column name and a handful of sample
   values and assign one of the nine coarse roles (Identifier,
   Date/time, Monetary amount, Quantity, Category, Rating, Geography,
   Status, Free text) or "other." A departmental colleague or two
   works. Each rater labels independently, **without seeing CAAGA's own
   prediction column** — hide or strip that column before handing out
   the template.
4. **Resolve disagreements.** Wherever `rater1_label` ≠ `rater2_label`,
   the two raters (or a third adjudicator) discuss and agree on
   `resolved_label`. This is also where Cohen's kappa gets computed —
   on the raters' independent labels, *before* resolution, so it
   measures genuine agreement rather than agreement manufactured by the
   resolution step itself.
5. **State the coarse-role mapping in Section 4.4 before running the
   numbers**, not after. Three mappings in `COARSE_ROLE_MAP` are real
   judgment calls that affect the reported macro-F1: `discount` →
   Monetary amount, `duration` → Quantity, `name_label` → Free text.
   Writing this into the methodology text up front means a reviewer
   sees it as a stated design decision, not something they have to
   extract from a script.
6. **Run the evaluation.**
   `python scripts/evaluate_semantic_role_inference.py` against the
   export plus the resolved labels produces Cohen's kappa, per-role
   precision/recall/F1, macro-F1, the top confusion pairs (for the
   "quantity vs. monetary" style sentence Section 5.2 wants), and
   `table3_semantic_role_accuracy.csv` / `.md` ready to paste in.
7. **Fill in the manuscript placeholders**: Abstract's macro-F1
   sentence, Section 4.4's procedure (now including the coarse-role
   mapping statement from step 5), Section 5.2's Table 3 and results
   narrative, Section 6.1 Principal Findings, and the Conclusion.

### Estimated effort

An afternoon for steps 1–2. A few days of calendar time for steps 3–4
(bounded by rater availability, not by data volume — the 8-dataset
smoke test produced 179 columns across 8 datasets, so 17 datasets is
likely in the 150–250 column range). An hour for steps 6–7.

### What this does and doesn't prove

Proves: CAAGA's semantic-role classifier's actual accuracy against real
user-supplied data it was never tuned against, with an honest
inter-rater-agreement figure backing the ground truth it's scored
against. Does **not** prove the classifier generalizes to business
domains or column-naming conventions entirely outside MIT 267's dataset
pool (e.g., a different country's invoicing conventions) — worth one
explicit sentence in Limitations rather than letting the number imply
more than it does.

---

## Part 2 — Minimal real-SME field study

### Why this is the bigger lift

Not recruitment — instrumentation. TAM measures perceived usefulness
and ease of use; it has never asked what anyone actually *did* with
the output. Recommendation #1 (from the original four-recommendation
peer-review plan, `claude/gating-comparison.md`) specifically asks for
decision quality "rated blind by two or three experts in business
analytics" — real SME owners' real decisions, judged by people who
weren't told whose decision they're reading. That instrument does not
exist yet anywhere in the project. This section specifies it.

The design below deliberately adds **zero new database tables, routes,
or UI** — the entire new instrument lives outside the app, as a
consent script, a short form, and a paper rubric. The app's only role
is the one it already plays: SME Owner signup, dataset upload, and the
four analytics modules, all untouched.

### Recruitment criteria

- **Who**: an owner, manager, or someone with real decision-making
  authority at an actual operating small or medium enterprise —
  explicitly *not* a student role-playing an SME owner.
- **How many**: 8–10 participants. Enough for a credible qualitative/
  descriptive synthesis in a dissertation timeline; not intended to
  support inferential statistics, and the manuscript should say so
  plainly rather than overclaim.
- **Data**: participants upload data they already have on hand —
  historical transaction records, whatever they already track in a
  spreadsheet or POS export. This is what keeps the study feasible on
  a dissertation timeline: no one waits weeks for new transactions to
  accumulate.
- **Business type**: any category covered by the app's 28-field
  transaction schema; no need to restrict to a single sector, though
  noting the sectors actually recruited (retail, food service,
  services, etc.) in the final write-up strengthens the organizational-
  context claim the editor is asking for.
- **Sourcing**: outside what I can scope technically — likely your
  existing local SME network, chamber of commerce or LGU economic-
  development contacts in Koronadal/South Cotabato, or your DIT
  adviser's own professional network. Flag this as the one piece that
  depends on fieldwork access rather than app engineering.

### Protocol

1. Participant signs up through the existing public `/signup` flow
   (role `SME Owner` — completely separate from the Template Evaluator
   machinery, and the actual flow a real SME owner would use in
   production).
2. Participant completes the existing informed-consent screen (RA
   10173) and uploads their own real dataset.
3. Participant explores at least one of the four analytics modules
   (Descriptive, Diagnostic, Predictive, or Prescriptive) relevant to a
   real question they have about their business.
4. Immediately afterward, participant completes the **decision-report
   form** (text below) and the **existing TAM questionnaire** (no
   changes needed — it already works for the SME Owner role).
5. An Admin tags the account `field_study` via the Cohort dropdown on
   Manage SME Accounts (already built; this is the entire reason that
   column exists).
6. The decision-report write-up is stripped of the participant's name
   and business name and handed to the blind raters along with a
   screenshot or export of the specific CMA-Flow output they referenced
   (so raters can judge groundedness without knowing who the
   participant is).
7. Two or three raters independently score each write-up against the
   rubric below. Compute inter-rater agreement (ICC or Cohen's kappa,
   same approach as the semantic-role retest) before any averaging or
   resolution.

### Decision-report form (use this text)

> **CMA-Flow Field Study — Decision Report**
>
> Thank you for trying CMA-Flow with your own business data. This
> short form is the only other thing we'll ask of you today.
>
> 1. Which part of CMA-Flow did you look at just now? (Descriptive /
>    Diagnostic / Predictive / Prescriptive — circle one or more)
> 2. In your own words, what did that analysis show you?
> 3. **Based on what you just saw, what would you do next in your
>    business, and why?** Please be as specific as you can — "I'd lower
>    prices" is harder to evaluate than "I'd drop the price on [product/
>    category] by about 10% next month, since the tool showed it's
>    priced above where demand holds up."
> 4. Is this something you'd actually act on, or more of a "worth
>    thinking about"? (Definitely would / Probably would / Not sure /
>    Probably wouldn't)
> 5. Was there anything the tool showed you that you didn't trust or
>    weren't sure how to use?

Question 3 is the artifact the blind raters score. Questions 1–2 give
raters the context to judge groundedness without needing account
access. Question 4 is a self-reported actionability check, reported
alongside the blind ratings rather than folded into them. Question 5
is free usability signal, complementary to TAM, costs nothing extra to
collect.

### Blind-rating rubric (use this text)

Each rater scores every decision write-up independently, without
knowing the participant's identity or any other rater's scores, on
four 1–5 items:

| # | Criterion | 1 (low) | 5 (high) |
|---|---|---|---|
| 1 | **Evidence-groundedness** — is the stated decision traceable to a specific thing CMA-Flow actually showed? | No discernible link to the tool's output | Decision directly cites a specific number, trend, or recommendation from the output |
| 2 | **Actionability** — is it concrete enough to actually implement? | Vague sentiment ("improve sales") | Specific action, target, and rough timeframe |
| 3 | **Soundness** — would a reasonable business-analytics practitioner consider this a defensible response to that evidence? (Not "the only correct answer" — business decisions rarely have one.) | Non sequitur or contradicts the evidence shown | Clearly follows from the evidence, with reasonable business judgment |
| 4 | **Restraint** — does the decision stay within what the evidence actually supports, rather than over-extrapolating from a weak or suppressed signal? | Leans on a claim stronger than the data justifies | Appropriately cautious; doesn't overreach |

Criterion 4 is deliberately framed to connect to the gate-comparison
feature already built (`claude/gating-comparison.md`): a decision that
leans on an output CAAGA's gate would have suppressed is a concrete,
rater-visible way to show what the gate is protecting against, outside
a synthetic test.

Report the four subscales separately rather than collapsing to one
composite — a decision can be highly actionable but poorly grounded,
and that distinction is more useful to a reviewer than a single number.

### Timeline estimate

The rate-limiting step is recruitment and scheduling, not analysis.
Once 8–10 participants are lined up, each session (signup through
decision-report) is a single sitting of perhaps 30–45 minutes. Rater
scoring for 8–10 short write-ups is an afternoon per rater. The
realistic bottleneck is finding and scheduling real SME owners willing
to share real data — budget for that taking longer than every other
step combined.

### What this does and doesn't prove

Proves: that real SME owners, not students, can use CMA-Flow on their
own real data and produce decisions a blind business-analytics rater
judges as grounded, actionable, and appropriately cautious — direct
evidence against the "technically literate graduate students" and
"decision-support effectiveness" complaints, from a real (if small)
sample. Also yields a first TAM reading from an actual SME population,
addressing recommendation #4 as a byproduct, cleanly separated from the
MIT 267 cohort via the existing `cohort` tag.

Does **not** prove the decisions were actually implemented or that they
improved real business outcomes — that would need a prospective,
multi-month study tracking what participants actually did and what
happened afterward. Worth stating as the natural next round, not
something this minimal version claims to have done.

---

## How this maps back to the editorial letter

| Editorial complaint | Addressed by |
|---|---|
| "Technical correctness rather than effectiveness in context" | Field study's decision-report + blind rating (Part 2) |
| "Semantic-role inference shows limited generalization" | Held-out retest (Part 1) |
| "Small cohort of technically literate graduate students" | Field study's real-SME recruitment criteria (Part 2) |
| "Stronger empirical validation of decision-support value" | Field study's blind-rated decision quality (Part 2) |

Neither part requires new app engineering beyond what's already built
and shipped. The semantic-role retest is bottlenecked on two raters'
time and a short dataset-ID lookup. The field study is bottlenecked on
recruitment access, which is the one piece of this plan that depends
on fieldwork rather than tooling.
