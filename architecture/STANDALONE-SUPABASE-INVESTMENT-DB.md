# Standalone Supabase Investment Database Build

This branch moves the NYC investment-property intelligence system away from app-builder dependency and into a normal codebase + Supabase architecture.

## Hard rule

Base44 is not part of the runtime architecture for this build.

The system is a standalone application backed by Supabase/Postgres, with code stored in this repository, SQL migrations under `skyline/database/migrations/`, and Supabase Edge Functions under `skyline/supabase/functions/`.

## What this foundation builds

The database foundation is BBL/property/deal/entity/contact centered. It supports:

- NYC investment-property records by address, borough, BBL, building class, zoning, lot area, building area, units, ownership, and provenance.
- Commercial/investment sale records with buyer, seller, source, price, sale date, asset type, and review status.
- Entity normalization for LLCs, buyers, sellers, owners, aliases, contacts, and contact provenance.
- Buyer matching by asset type, borough, deal size, keywords, recency, volume, contact availability, and SPV penalty.
- Durable review queue and exclusion ledger.
- Hard exclusion of condos, co-ops, single-family, two-family, and 1–2 family records.
- Source-run logging and fetch ledger for future ACRIS, Traded, Crexi, NYC Open Data, DOB, and upload pipelines.

## Core objects

| Object | Purpose |
|---|---|
| `sbi_properties` | Canonical property/tax-lot records. |
| `sbi_entities` | Buyers, sellers, owners, LLCs, funds, individuals, trusts, companies. |
| `sbi_deals` | Sale/deal facts tied to a property. |
| `sbi_deal_parties` | Buyer/seller/lender/owner relationships. |
| `sbi_contacts` | Phone/email/person/company details with provenance and confidence. |
| `sbi_interactions` | Call/email/meeting/contact history. |
| `sbi_review_queue` | Human review items for conflicts, exclusions, parse gaps, and bad records. |
| `sbi_exclusion_ledger` | Durable blocked records, especially residential/condo/co-op exclusions. |
| `sbi_source_runs` | Scraper/import job observability. |
| `sbi_fetch_ledger` | Idempotency/deduplication ledger. |

## Public RPC/API surface

| Function | Use |
|---|---|
| `sbi_api_meta()` | Dashboard totals. |
| `sbi_search_deals(...)` | Filtered deal search. |
| `sbi_match_buyers(...)` | Buyer recommendation / buyer matching engine. |
| `sbi_lookup_owner_or_buyer(name)` | Entity lookup with stats and contacts. |
| `sbi_ingest_deal(...)` | Service-role-only canonical ingest path. |

## Security posture

- RLS enabled on canonical tables.
- Read-only dashboard RPCs granted to authenticated users.
- Ingest/write RPC restricted to service role.
- No browser bundle should ever contain scraper keys, AI keys, service keys, or enrichment provider keys.
- Contact data is returned only from stored `sbi_contacts` rows. The AI agent must not invent phone numbers, emails, owners, or buyer facts.

## Runtime direction

1. Apply migration `010_sbi_standalone_foundation.sql`.
2. Deploy Edge Function `sbi-api`.
3. Wire the frontend to `sbi-api` or direct authenticated RPC calls.
4. Build scrapers/importers to write only through `sbi_ingest_deal` or future narrow service-role functions.
5. Build the AI agent as SQL/tool-use over the same RPC surface, not vector guesses.

## Immediate next build modules

1. `sbi-api` Edge Function endpoints:
   - `GET /meta`
   - `GET /deals`
   - `GET /buyers`
   - `GET /entity?name=...`
   - `POST /ingest/deal`
2. React dashboard tabs:
   - Deals
   - Buyers
   - Properties
   - Contacts
   - Review Queue
   - Source Runs
   - AI Deal Desk
3. Import pipelines:
   - CSV/XLSX upload importer
   - ACRIS deed importer
   - NYC Open Data PLUTO/MapPLUTO importer
   - DOB/Housing/conversion enrichment
   - Traded/Crexi/manual source adapters

## Non-negotiable data rules

- Never overwrite a non-null trusted value with a lower-confidence value.
- Conflicts go to review queue.
- Condos, co-ops, single-family, two-family, and 1–2 family records go to the exclusion ledger.
- ACRIS parties require amount-gate verification before being attached as buyer/seller.
- All ingest paths must write provenance.
- All rows must be filterable/exportable from the dashboard.
