# Synthetic SME Dataset — full CMA-Flow cycle

Four CSVs designed to exercise every stage of CMA-Flow end to end: Upload → Map & Transform → CMA Canonical Schema → Monetization Discovery → Descriptive → Diagnostic → Predictive → Prescriptive analytics.

## What's in it

| File | Rows | Canonical entity |
|---|---|---|
| `customers.csv` | 2,600 | Customer |
| `transactions.csv` | 61,418 | Transaction |
| `entitlements.csv` | 3,023 | Entitlement |
| `monetization_configs.csv` | 8 | MonetizationConfig |
| **Total** | **67,049** | |

Every column header is the exact CMA canonical field name (`customer_id`, `amount`, `timestamp`, `product_service`, `effective_from`, …), so Map & Transform's auto-suggested mapping matches every field at full confidence — nothing to fix by hand.

Roughly 24 months of history, ending "today" (whenever the dataset was generated) — so churn recency, lifecycle staging, and the revenue forecast all read naturally right after upload.

## The 5 products, one per mechanism (plus one upgrade path)

- **Pro Plan** — Subscription. 900 customers, $49.99/mo → $59.99/mo price increase partway through the history (real price-change history for Diagnostic/Prescriptive to read).
- **Pro Plan (Enterprise)** — Subscription. ~8% of Pro Plan subscribers upgrade into a flat $199.99/mo Enterprise tier partway through their tenure (shows up as an "Upgraded" entitlement and a distinct product in Monetization Discovery).
- **Cloud Storage** — Pay-per-use. ~780 customers, billed by GB-month at $0.023 → $0.019 (a price cut, with a genuinely elastic volume response for Diagnostic's price-elasticity read).
- **Analytics API** — Data-as-a-Service. 380 customers, metered by call volume; the engine reads it as DaaS with a secondary pay-per-use signal (a realistic "hybrid mechanism" flag).
- **Insight Suite** — Freemium. 670 customers hold an entitlement; most stay on the free tier forever (never bill), a portion convert to a paid $34.99/mo tier after some weeks/months — a real free/paid split.

Customer relationship health is modeled explicitly, not left to chance: ~72% stay active, ~16% go quiet (at-risk: recency drifts past 90–180 days, some with auto-renew turned off), ~12% formally churn (a `churn_date`, a cancellation reason, entitlement closed out). ~5% signed up in the last 30 days for a "New" lifecycle cohort. This is what gives Predictive Analytics a real spread across Low / Medium / High risk and Churned, instead of one bucket holding everyone.

## How to upload it

1. **Upload New Dataset** → pick any Dataset ID/name → **+ Add files…** → select all 4 CSVs at once.
2. Label each row exactly: `customers`, `transactions`, `entitlements`, `monetization_configs` (the file names already suggest these).
3. Submit — this ingests 67,049 raw rows in one batch.
4. **Map & Transform entire dataset** — the entity guesses and field mappings should already be correct for every file (every header is a canonical field name); just confirm & run transform. Expect **67,049 valid, 0 invalid**.
5. Visit **Monetization discovery** — all 5 products should come back "High confidence" with concrete evidence sentences; nothing needs correcting, though you're welcome to confirm them.
6. **Descriptive**, **Diagnostic**, **Predictive**, and **Prescriptive** analytics are then all live with real numbers — pick this Dataset ID from the dropdown on each page.

## One thing to expect, not a bug

Diagnostic Insight's **Revenue bridge** compares the two most recent calendar months that have transaction data. If you upload partway through a calendar month, that in-progress month will look artificially low next to the prior full month — that's genuinely how any live dataset behaves mid-month, not a defect in this data. It self-corrects as the month completes (or immediately, if you upload right after a month rolls over).

## Verification performed

Uploaded through the app's real pipeline (not just checked by eye): all 67,049 rows froze **valid** with zero validation errors; Monetization Discovery classified all 5 products correctly and confidently; every tab of Descriptive/Diagnostic/Predictive/Prescriptive Analytics rendered with real, non-zero, sensible figures — including a genuine two-product price-change/elasticity read (Cloud Storage price cut → elastic response; Pro Plan price increase → inelastic response) and a churn-risk distribution spread realistically across all four bands.
