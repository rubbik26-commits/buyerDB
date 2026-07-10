# SOP — Production refresh train

## Runtime

- Frontend and server-side control plane: Netlify project `buyerdb`
- Canonical database: Supabase project `pdvyuepsdnpxctmagdcq`
- Source control and CI only: GitHub repository `rubbik26-commits/buyerDB`
- GitHub Actions does not execute production scraper jobs.

## Execution flow

```text
Netlify scheduled function or Scrapers tab
  -> POST /api/scrapers/run
  -> api_request_scrape() creates sbi_source_runs status=requested
  -> Netlify background function receives job/run_id
  -> source-specific scraper/enrichment path
  -> canonical RPC write path
  -> sbi_* tables + ledgers + review queue
  -> sbi_source_runs final counters/error
```

The scheduled functions are lightweight dispatchers. Long-running work is executed by the Netlify background function, not by a browser request and not by GitHub Actions.

## Schedule

| Job | UTC cron | Runtime |
|---|---:|---|
| ACRIS fresh window | `17 13 * * *` | `sbi-acris-refresh` Supabase Edge Function |
| Traded | `47 13 * * *` | `sbi-traded-refresh` Supabase Edge Function, invoked by Netlify with server-side ScraperAPI key |
| Rolling Sales | `27 14 * * *` | Netlify background function + NYC Open Data |
| Crexi | `17 15 * * *` | Netlify background function + configured Apify actor |
| Phase 2 party lag + NYS DOS | `43 11 * * 0` | Netlify background function + `sbi-dos-enrich` |

## Source behavior

### ACRIS

- 120-day fresh window
- $1M floor
- deed masters → legals/parties → PLUTO
- rejects residential/condo building classes
- writes deed amount, ACRIS document ID, BBL, and mailing evidence
- ACRIS buyer/seller rows are attached only if the physical database amount gate passes

### Traded

- New York asset/borough listing pages plus NY-scoped sitemap discovery
- subtracts `sbi_fetch_ledger` before fetching detail pages
- challenge/error pages remain retryable dispositions
- structured buyer/seller payload is primary; title extraction is fallback and forces review status
- every fetched URL receives a durable disposition
- merge checks exclusion ledger and source/deal duplicate keys

### Crexi

- uses `APIFY_TOKEN` and `APIFY_CREXI_ACTOR`
- only New York rows enter the staging map
- business-for-sale and note/loan records are excluded
- asking prices remain labeled as active-listing intelligence, not closed-sale facts
- broker phone/company rows retain `crexi_broker` provenance

### Rolling Sales

- address matching uses canonical street names and borough codes
- R-class rows are ignored
- sqft/units fill only when all relevant rows agree
- >20% disagreement with a non-null value creates `rolling_sales_conflict`
- existing values are never overwritten

### Phase 2 ACRIS lag closer

- priced rows: deed amount within 3%, nearest date, ≤400 days
- no-price rows: ≥$200K and unique/nearest deed within 240 days
- final application still uses `sbi_apply_acris_party_fill`, which re-checks the 3% gate or the validated no-price date rule
- conflicting existing party identities create review rows

### NYS DOS

- fills null mailing/key-person fields only
- registered-agent mills are filtered from key-person insertion
- all inserted contact rows retain `nys_dos` provenance

## Durable state

- `sbi_fetch_ledger`: discovery/fetch dispositions
- `sbi_exclusion_ledger`: source-proofed residential/excluded property keys
- `sbi_rolling_ledger`: processed Rolling Sales targets
- `sbi_source_runs`: requested/running/final state and counters
- `sbi_review_queue`: source conflicts, amount-gate violations, entity conflicts, and enrichment disagreements

## Manual operation

The Scrapers tab calls `/api/scrapers/run`. Supported jobs:

- `acris_refresh`
- `traded_refresh`
- `crexi_refresh`
- `rolling_sales`
- `phase2_enrichment`
- `dos_enrich`
- `property_owner_refresh`
- `full_refresh`

`full_refresh` fans out into separate auditable source runs rather than hiding all sources in one opaque job.

## Environment gates

`/api/runtime-health` reports presence booleans for:

- Supabase public and server credentials
- scheduler credential
- Socrata token
- ScraperAPI key
- Apify token/actor
- all six AI providers and provider order

It never returns a credential value.

## Acceptance checks

After any production cutover or scraper-code change:

1. `/api/runtime-health` shows the required environment booleans.
2. `/api/agent` answers the Brooklyn multifamily ~$3M test using `find_similar_buyers` and real Supabase rows.
3. Run ACRIS with a small limit; confirm a final `sbi_source_runs` status and no duplicate group increase.
4. Run Rolling Sales with a small limit; confirm fills/conflicts and durable ledger rows.
5. Run Phase 2 with a small limit; confirm no ACRIS party row violates the strengthened gate.
6. Run Traded; confirm discovery counts and fetch-ledger dispositions. If ScraperAPI quota is exhausted, the run must show `quota_blocked` or explicit fetch errors—never false success.
7. Run Crexi; confirm the Apify dataset ID and that listing rows remain `needs_review` listing intelligence.
8. Verify:

```sql
select count(*) from (
  select property_id,sale_price,sale_date,count(*)
  from sbi_deals group by property_id,sale_price,sale_date having count(*)>1
) duplicate_groups;

select count(*)
from sbi_deal_parties
where source_system='acris'
  and not (amount_gate_passed is true and verified_deed_amount is not null and provenance_ref is not null);
```

Both counts must be zero.
