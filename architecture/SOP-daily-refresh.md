# SOP — Daily data refresh / live SBI production state

**Goal:** `buyerdb.netlify.app` shows the live Skyline Buyer Intelligence dataset from Supabase without mock data, browser scrapers, or Base44 as the canonical app database.

## Current verified production project

- Supabase project: `pdvyuepsdnpxctmagdcq`
- Frontend: Netlify project `buyerdb`
- Frontend runtime: Supabase RPC mode through public `api_*` functions
- Canonical tables: `sbi_properties`, `sbi_deals`, `sbi_deal_parties`, `sbi_entities`, `sbi_contacts`, `sbi_review_queue`, `sbi_source_runs`
- Live RPC health returns runtime `supabase-rpc-sbi`

## Current flow

```text
buyerdb.netlify.app
  -> Supabase PostgREST RPC api_* functions
  -> sbi_* canonical tables

Manual Scrapers tab
  -> api_request_scrape(job, user_id, options)
  -> sbi_source_runs row with status='requested'
  -> worker / operator process claims or executes the requested job
```

Netlify is only the static app/control panel. It does not run scrapers.

## Current known production facts

Verified against live Supabase on 2026-07-09:

- `api_health()` returns `status='ok'`, `runtime='supabase-rpc-sbi'`, `deals=4075`.
- `api_deals(per_page=>5)` returns 5 sample rows.
- `api_buyers(lim=>5)` returns 5 sample rows.
- `api_saved_views('broker','deals')` returns a valid empty list when no saved views exist.
- Duplicate `(property_id, sale_price, sale_date)` groups: `0`.
- ACRIS buyer/seller parties without the amount gate: `0`.
- Banned residential asset rows: `0`.
- Running scraper rows older than 1 hour: `0`.

## Required gates

The system remains governed by these non-negotiable rules:

1. Condos, co-ops, single-family, two-family, and 1–2 family rows are not allowed into the commercial deal ledger.
2. ACRIS buyer/seller party attachment must remain amount-gated.
3. Duplicate transaction rows must not be created for the same property/price/date group.
4. Source system, source URL, parse status, review status, and run status must stay visible.
5. Contacts are stored only from real source rows or uploads; the AI layer must not invent phone numbers or emails.
6. Netlify must remain the frontend/control panel, not the scraper runtime.

## Manual request behavior

`api_request_scrape()` now writes a durable queue row:

```sql
insert into sbi_source_runs(source, job, status, stats)
values ('manual', <job>, 'requested', ...)
```

Allowed jobs:

- `traded_refresh`
- `acris_refresh`
- `crexi_refresh`
- `property_owner_refresh`
- `full_refresh`

The request must appear in the Scrapers tab and remain auditable even if the actual worker is offline.

## Verification

Use the committed verification script when production database secrets are available:

```bash
bash execution/verify_live_sbi.sh
```

The script checks:

- live `sbi_*` totals
- required RPC function signatures
- duplicate deal groups
- ACRIS gate failures
- banned asset rows
- stale running source runs
- public `api_health` over PostgREST

## Open production gap

The live project currently has only one Edge Function deployed: `base44-to-sbi-sync`. That means the current production dataset is available and healthy, but the full direct scraper execution train is not yet deployed into the live SBI project. The next build step is not another Netlify rewrite; it is to connect the proven scraper execution path to the live `sbi_source_runs` queue and canonical `sbi_*` write path without changing the scraper logic.

## Security debt

Supabase advisors still report security warnings, including permissive anon policies and disabled RLS on some legacy/workflow tables. Do not blindly lock these down from the browser app without replacing those writes with authenticated/backend or service-role paths, or the app can break. Security hardening should be done as a controlled auth/API migration, not as an incidental scraper change.
