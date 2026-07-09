# Skyline BuyerDB — Production Python Scraper + Cron Blueprint

## Target operating model

Netlify is the static frontend and broker control panel. It does not run scrapers.
The Python worker is the scraper runtime. Supabase/Postgres is the durable system
of record for deals, properties, entities, contacts, review flags, and ledgers.

```
Netlify buyerdb.netlify.app
  └─ Scrapers tab / RPC api_request_scrape()
       └─ sbi_source_runs row: status=running, stats.requested_status=requested
            └─ Python queue worker claims row with FOR UPDATE SKIP LOCKED
                 ├─ traded_refresh          -> worker.run_incremental
                 ├─ acris_refresh           -> worker.phase3_fresh
                 ├─ property_owner_refresh  -> worker.phase2_stages
                 ├─ crexi_refresh           -> worker.crexi_refresh, optional Apify creds
                 └─ full_refresh            -> Traded + ACRIS fresh + Rolling + phase2 + optional Crexi
                      └─ worker.sbi_store.merge_deal / ledgers / review queue
                           └─ Supabase sbi_* tables
                                └─ Netlify reads via PostgREST RPC api_*
```

## Why this is the correct runtime

The scraper correctness is already in Python:

- `worker/traded_scraper.py` owns Traded discovery and the curl_cffi/ScraperAPI transport chain.
- `worker/traded_backfill.py` owns the structured Traded page parser, Cloudflare challenge detection, and geo/date conflict behavior.
- `worker/run_incremental.py` is the daily Traded runner: discovery minus fetch ledger, fetch/parse, gated merge, fetch disposition recording.
- `worker/acris_enrich.py` owns ACRIS/PLUTO SoQL utilities and building-class classification.
- `worker/phase3_fresh.py` owns the fresh ACRIS deed-window ingest.
- `worker/phase2_stages.py` owns delayed ACRIS party/owner enrichment for missing parties.
- `worker/rolling_sales.py` owns Rolling Sales sqft/units fills and conflict review flags.
- `worker/sbi_store.py` owns the single production write path into the `sbi_*` schema.

The system should not re-port these rules into Netlify JS functions. Netlify is not a
Python scraping runtime and cannot reliably run long Traded/ACRIS ingestion jobs.

## Runtime services

### 1. `skyline-api` web service

Purpose: optional FastAPI backend for uploads, AI/Deal Desk, admin tools, and richer
server-side workflows.

Render command:

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
```

### 2. `skyline-scraper-queue` worker service

Purpose: continuously claim broker-requested scraper jobs from the Scrapers tab.

Render command:

```bash
python -m worker.scheduler --mode queue-daemon
```

Environment:

```bash
DATABASE_URL=<Supabase session-pooler connection string>
SOCRATA_APP_TOKEN=<optional NYC Open Data app token>
SCRAPERAPI_KEY=<optional Traded fallback; curl_cffi remains primary>
APIFY_TOKEN=<optional Crexi>
APIFY_CREXI_ACTOR=<optional Crexi actor id>
WORKER_POLL_SECONDS=30
WORKER_MAX_CLAIMS_PER_TICK=1
ROLLING_BATCH=400
```

### 3. `skyline-daily-refresh` cron

Purpose: keep the dataset fresh without a broker touching the UI.

Render cron schedule: `40 7 * * *`

Command:

```bash
python -m worker.scheduler --mode daily
```

Sequence:

1. `worker.run_incremental` — Traded discovery/fetch/merge.
2. `worker.phase3_fresh` — recent ACRIS deed-window ingest.
3. `worker.rolling_sales` — sqft/units fill with conflict flags.

### 4. `skyline-weekly-owner-enrichment` cron

Purpose: close ACRIS party-recording lag after deed/party records catch up.

Render cron schedule: `43 11 * * 0`

Command:

```bash
python -m worker.scheduler --mode weekly
```

Sequence:

1. `worker.phase2_stages` — missing buyer/seller matching through legals → deed masters → parties.
2. `worker.apply_enrichment` / `sbi_store.apply_acris_party_fill` semantics remain amount-gated.

### 5. `skyline-weekly-full-refresh` cron

Purpose: larger weekly repair/backfill pass.

Render cron schedule: `17 8 * * 6`

Command:

```bash
python -m worker.scheduler --mode full
```

Sequence:

1. Daily sequence.
2. Weekly phase2 owner/party enrichment.
3. Optional Crexi refresh if Apify credentials exist.

## Manual Scrapers tab behavior

The frontend should create durable rows only. It should not claim that a browser or
Netlify function ran the scraper.

`api_request_scrape()` inserts into `sbi_source_runs`:

```json
{
  "source": "manual",
  "job": "traded_refresh | acris_refresh | crexi_refresh | property_owner_refresh | full_refresh",
  "status": "running",
  "stats": {
    "requested_by": "broker",
    "requested_status": "requested",
    "options": {}
  }
}
```

`worker.scheduler --mode queue-daemon` claims that row and changes
`stats.requested_status` to `claimed`. When the Python job finishes, the row is
updated to `completed`, `failed`, `timeout`, or `completed_with_errors`.

## Acceptance checks

Run from `skyline/` after setting `DATABASE_URL`:

```bash
python -m worker.scheduler --mode queue-once --max-claims 1
python -m worker.scheduler --mode daily --limit 25 --rolling-batch 25
python -m worker.scheduler --mode weekly --limit 25
python -m worker.scheduler --mode full --limit 10 --rolling-batch 10
```

Database checks:

```sql
select job,status,started_at,finished_at,error
from sbi_source_runs
order by started_at desc
limit 20;

select disposition,count(*)
from sbi_fetch_ledger
group by disposition
order by count(*) desc;

select issue_class,count(*)
from sbi_review_queue
where status='open'
group by issue_class
order by count(*) desc;
```

## Deployment checklist

1. Keep Netlify linked to `rubbik26-commits/buyerDB`, branch `ACRIS`, base `skyline/frontend`.
2. Deploy `render.yaml` as the Python runtime blueprint.
3. Set `DATABASE_URL` on every Render service/cron job.
4. Set optional keys: `SOCRATA_APP_TOKEN`, `SCRAPERAPI_KEY`, `APIFY_TOKEN`, `APIFY_CREXI_ACTOR`.
5. Confirm the queue worker starts with `mode=queue_daemon`.
6. Trigger a Scrapers-tab job and verify one `sbi_source_runs` row moves from requested → claimed → completed/failed.
7. Verify daily/weekly cron run rows and table deltas.
8. Leave GitHub Actions disabled unless explicitly needed as a fallback.

## Non-negotiable invariants

- Every merge goes through `worker.sbi_store.merge_deal()`.
- Every fetched URL gets a ledger disposition unless the failure is retryable.
- Exclusion ledger is checked before inserts.
- Condos, co-ops, single-family, and 1–2-family rows do not enter silently.
- Ambiguity creates `needs_review`; it is not guessed away.
- ACRIS parties only attach through the amount-gated path.
- Existing non-null values are not overwritten by enrichment.
