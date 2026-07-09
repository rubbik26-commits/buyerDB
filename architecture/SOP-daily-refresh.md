# SOP — Daily data refresh

**Goal:** buyerdb.netlify.app always shows fresh NYC commercial real-estate deal intelligence without anyone manually running scripts.

## Current production architecture

Netlify is the frontend/control panel. Python is the scraper runtime. Supabase/Postgres is the system of record.

```
Render/Railway/Fly/VPS Python cron + queue worker              all times UTC
  queue daemon   claims manual Netlify/Supabase requests ─────┐
  07:40 daily    Traded incremental + fresh ACRIS + rolling   │
  11:43 Sunday   delayed owner/party ACRIS enrichment         ├─▶ worker.sbi_store / amount-gated writes
  08:17 Saturday full repair/backfill + optional Crexi        │      └─ sbi_* tables + durable ledgers
                                                              │
Netlify buyerdb.netlify.app ── PostgREST RPC api_* ◀──────────┘
```

The production runtime is implemented in:

- `skyline/worker/scheduler.py` — queue daemon + daily/weekly/full cron entrypoints.
- `skyline/worker/run_requested.py` — claims Scrapers-tab requests from `sbi_source_runs` and dispatches Python modules.
- `skyline/worker/run_incremental.py` — Traded discovery/fetch/merge.
- `skyline/worker/phase3_fresh.py` — fresh ACRIS deed-window ingest.
- `skyline/worker/phase2_stages.py` — delayed ACRIS buyer/seller party enrichment.
- `skyline/worker/rolling_sales.py` — Rolling Sales sqft/units fill.
- `skyline/worker/crexi_refresh.py` — optional Python Crexi/Apify refresh.
- `skyline/worker/sbi_store.py` — single production write path and ledgers.

## Manual Scrapers tab flow

1. Broker clicks **Request run** in Netlify.
2. Frontend calls Supabase RPC `api_request_scrape()`.
3. Supabase inserts a durable row into `sbi_source_runs`:

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

4. `python -m worker.scheduler --mode queue-daemon` claims the row with `FOR UPDATE SKIP LOCKED`.
5. `worker.run_requested` dispatches the job.
6. `sbi_source_runs` is updated to `completed`, `failed`, `timeout`, or `completed_with_errors`.

## Scheduled cron commands

Run from `skyline/` with `DATABASE_URL` set.

### Daily refresh

```bash
python -m worker.scheduler --mode daily
```

Sequence:

1. `worker.run_incremental` — Traded discovery minus fetch ledger, fetch/parse via the Python Traded path, merge through `sbi_store`.
2. `worker.phase3_fresh` — fresh ACRIS deed-window ingest with PLUTO/building-class gates.
3. `worker.rolling_sales` — fill sqft/units only when Rolling Sales values agree; conflicts go to review.

Recommended schedule: `40 7 * * *` UTC.

### Weekly owner/party enrichment

```bash
python -m worker.scheduler --mode weekly
```

Sequence:

1. `worker.phase2_stages` — deals missing buyer/seller party data are matched to ACRIS legals and deed masters.
2. The fill path enforces amount-gate behavior before attaching ACRIS parties.

Recommended schedule: `43 11 * * 0` UTC.

### Weekly full refresh / repair pass

```bash
python -m worker.scheduler --mode full
```

Sequence:

1. Daily sequence.
2. Weekly owner/party enrichment.
3. Optional Crexi refresh if `APIFY_TOKEN` and `APIFY_CREXI_ACTOR` are set.

Recommended schedule: `17 8 * * 6` UTC.

## Required environment

```bash
DATABASE_URL=<Supabase session pooler connection string>
```

Optional:

```bash
SOCRATA_APP_TOKEN=<NYC Open Data token>
SCRAPERAPI_KEY=<fallback transport only; curl_cffi is primary for Traded>
APIFY_TOKEN=<Crexi/Apify refresh>
APIFY_CREXI_ACTOR=<Crexi actor id>
ROLLING_BATCH=400
WORKER_POLL_SECONDS=30
WORKER_MAX_CLAIMS_PER_TICK=1
```

## Deploy with Render blueprint

The root `render.yaml` now defines:

- `skyline-api` — optional FastAPI service.
- `skyline-scraper-queue` — long-running queue daemon.
- `skyline-daily-refresh` — daily Python cron.
- `skyline-weekly-owner-enrichment` — weekly Python cron.
- `skyline-weekly-full-refresh` — weekly Python repair/backfill cron.

Netlify remains linked to `rubbik26-commits/buyerDB` branch `ACRIS` with build base `skyline/frontend`.

## Verify

### Queue / run ledger

```sql
select job,status,started_at,finished_at,error,stats
from sbi_source_runs
order by started_at desc
limit 20;
```

Expected states:

- Manual request starts as `running` with `stats.requested_status='requested'`.
- Queue daemon changes it to claimed while running.
- Final state is `completed` or `failed` with stats/error.

### Fetch ledger

```sql
select disposition,count(*)
from sbi_fetch_ledger
group by disposition
order by count(*) desc;
```

### Review queue

```sql
select issue_class,count(*)
from sbi_review_queue
where status='open'
group by issue_class
order by count(*) desc;
```

### Site-facing health

```bash
curl -s https://buyerdb.netlify.app/api/health
```

or, in RPC mode, call Supabase RPC `api_health()`.

## Invariants

- Netlify never stores scraper or provider secrets.
- Netlify never runs long scrapers.
- Python modules remain the scraper/runtime source of truth.
- All merges go through `worker.sbi_store.merge_deal()`.
- Durable ledgers are consulted before writes.
- Ambiguity creates `needs_review`; it is not guessed away.
- ACRIS party fills remain amount-gated.
- Existing non-null values are not overwritten.

## Fallbacks

GitHub Actions workflows remain available as fallback/test harnesses, but they are not the primary production scraper runtime. Re-enable them only if an external Python host is unavailable or as a short-term incident fallback.

Supabase edge functions remain useful source material and may still exist in the repository, but the production Python worker path is the implementation that preserves the existing Python scraper logic directly.
