# sbi-api

Standalone Supabase Edge Function for Skyline Buyer/Investment Intelligence.

This function is not connected to Base44 and does not call any app-builder service.

## Required secrets

Set these in Supabase Edge Function secrets:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<server-only Supabase service key or secret key>
```

`SUPABASE_SERVICE_KEY` must never be exposed to the browser.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sbi-api/meta` | Counts and dashboard totals. |
| `GET` | `/sbi-api/deals` | Filtered deal search. |
| `GET` | `/sbi-api/buyers` | Buyer matching / recommended buyers. |
| `GET` | `/sbi-api/entity?name=...` | Buyer/seller/owner lookup with contacts and stats. |
| `POST` | `/sbi-api/ingest/deal` | Service ingest for a normalized deal row. |

## Example deal search

```bash
curl "$SUPABASE_URL/functions/v1/sbi-api/deals?borough=Manhattan&asset_type=Office&min_price=10000000"
```

## Example buyer match

```bash
curl "$SUPABASE_URL/functions/v1/sbi-api/buyers?borough=Brooklyn&asset_type=Development%20Site&price=15000000&keywords=conversion,assemblage"
```

## Example entity lookup

```bash
curl "$SUPABASE_URL/functions/v1/sbi-api/entity?name=Vanbarton"
```

## Ingest contract

`POST /ingest/deal` expects neutral normalized fields:

```json
{
  "address": "101 Greenwich Street",
  "borough": "Manhattan",
  "asset_type": "Office",
  "sale_price": 105000000,
  "sale_date": "2026-01-20",
  "buyer": "101 GREENWICH PROPERTY OWNER LLC",
  "seller": "2 RECTOR STREET (NY), LLC",
  "source_system": "acris",
  "source_key": "ACRIS-2026012200003002",
  "source_url": "https://...",
  "confidence": 100,
  "provenance": {
    "importer": "acris"
  }
}
```

All writes go through `sbi_ingest_deal`; direct table writes should be avoided except for controlled migrations.
