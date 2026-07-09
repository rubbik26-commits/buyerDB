# Skyline Deal Intelligence

A production system that turns a static NYC commercial-real-estate deal artifact into a
living application: scrapers refresh the dataset on a schedule, a Python backend/worker serves
and enriches it, Netlify provides the broker-facing control panel, and an in-app agent
answers deal questions — "who's the best buyer for this?", "what's this owner's phone
number?", "when did we last contact them?" — as SQL over Postgres, narrated by whichever
of six providers is up and within quota.

```
skyline/
  frontend/  React 18 + Vite static app, deployed to Netlify buyerdb.netlify.app
  backend/   FastAPI API for optional server-side uploads, AI, admin, and workflow routes
  worker/    the proven Python scraper pipeline + queue daemon + cron entrypoints
  shared/    normalize.py — one implementation of address/entity/building-class invariants
  database/  numbered SQL migrations for the production sbi_* schema
  scripts/   CSV → Postgres migration + assertions
```

> **Repository layout:** in this repo the application lives in the `skyline/`
> subfolder — `cd skyline` before running local commands. Netlify remains linked
> to `rubbik26-commits/buyerDB`, branch `ACRIS`, with build base
> `skyline/frontend`.
>
> **Consolidated source of truth:** `rubbik26-commits/buyerDB` is the unified
> Buyer Intelligence / Deal Intelligence repository. The older
> `rubbik26-commits/buyers` repo is legacy source material only.
>
> **Production topology:** Netlify is the static frontend/control panel. The
> scraper runtime is Python: `worker.scheduler` runs as a queue daemon plus cron
> jobs on a Python host such as Render/Railway/Fly/VPS. Supabase/Postgres stores
> the `sbi_*` tables and RPC functions the frontend reads. See
> `architecture/PYTHON_WORKER_CRON_BLUEPRINT.md`.
>
> **GitHub Actions:** workflow files remain as a fallback and test harness, but
> they are not the primary production scraper runtime.

Why a backend/worker is mandatory: browsers cannot run cron, a client bundle cannot hold
provider/scraper keys, Traded requires the Python `curl_cffi` transport path for reliable
Cloudflare handling, and the dataset grows beyond a static embedded artifact.

## The invariants: encoded, not hoped for

- **Amount gate** — an ACRIS-sourced party is only attached when the deed amount is within
  3% of the deal price, or for no-price deals when the deed is within the allowed date window.
- **No residential leakage** — condos, co-ops, single-family, and 1–2 family are rejected by
  building-class/source gates and/or placed into the exclusion ledger.
- **Ledgers are durable tables**, not pickle files: `sbi_fetch_ledger`,
  `sbi_exclusion_ledger`, and rolling/enrichment run state.
- **Never overwrite non-null; conflicts are flagged, never resolved automatically.**
- **Every scraper run is auditable** through `sbi_source_runs` with status, stats, and error.

## Quick start: local development

Prereqs: Python 3.12, Node 18+, PostgreSQL/Supabase connection string.

```bash
cd skyline

# Python dependencies
pip install -r requirements.txt

# Database
export DATABASE_URL="postgresql://..."
for f in database/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# Optional initial load
python scripts/migrate_csv.py NEW_YORK_CLOSED_ENRICHED_v8.csv exclusion_ledger_additions_2026-07-02.csv
python scripts/assert_migration.py NEW_YORK_CLOSED_ENRICHED_v8.csv

# Optional FastAPI backend
uvicorn backend.app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

Without any AI key the data tabs still work. The Deal Desk must return an honest
"no provider configured" response rather than fabricating a result.

## Python scraper runtime

The production scraper runtime is `worker.scheduler`:

```bash
# Claim one manual Scrapers-tab request
python -m worker.scheduler --mode queue-once --max-claims 1

# Long-running queue daemon for manual requests from Netlify/Supabase
python -m worker.scheduler --mode queue-daemon

# Daily cron: Traded incremental + fresh ACRIS + Rolling Sales
python -m worker.scheduler --mode daily

# Weekly cron: delayed ACRIS party/owner enrichment
python -m worker.scheduler --mode weekly

# Full repair/backfill pass: daily + weekly + optional Crexi
python -m worker.scheduler --mode full
```

Manual flow:

1. Netlify Scrapers tab calls `api_request_scrape()`.
2. Supabase inserts a durable `sbi_source_runs` row with `stats.requested_status='requested'`.
3. `worker.scheduler --mode queue-daemon` claims the row.
4. `worker.run_requested` dispatches the correct Python module.
5. `sbi_source_runs` is updated with completed/failed status, stats, and errors.

Job dispatch:

| UI job | Python runtime |
|---|---|
| `traded_refresh` | `worker.run_incremental` |
| `acris_refresh` | `worker.phase3_fresh` |
| `property_owner_refresh` | `worker.phase2_stages` |
| `crexi_refresh` | `worker.crexi_refresh` if Apify credentials exist; otherwise skipped honestly |
| `full_refresh` | Traded + ACRIS fresh + Rolling Sales + phase2 + optional Crexi |

## Deploy

### Netlify

Static frontend only.

- Project: `buyerdb`
- Repo: `rubbik26-commits/buyerDB`
- Branch: `ACRIS`
- Base: `skyline/frontend`
- Build: `npm install && npm run build`
- Publish: `dist`

### Python runtime

Use `render.yaml` to deploy:

- `skyline-api` — optional FastAPI service.
- `skyline-scraper-queue` — long-running queue daemon.
- `skyline-daily-refresh` — daily cron.
- `skyline-weekly-owner-enrichment` — weekly cron.
- `skyline-weekly-full-refresh` — weekly repair/backfill cron.

Required secret on every worker/cron service:

```bash
DATABASE_URL=<Supabase session-pooler connection string>
```

Optional:

```bash
SOCRATA_APP_TOKEN=<NYC Open Data token>
SCRAPERAPI_KEY=<fallback for Traded if curl_cffi path needs help>
APIFY_TOKEN=<Crexi refresh>
APIFY_CREXI_ACTOR=<Crexi Apify actor id>
ALERT_WEBHOOK_URL=<failure alerts, where supported>
```

## Tests and verification

```bash
cd skyline
python -m pytest worker/test_store.py worker/test_run_incremental.py worker/test_phase2_enrichment.py worker/test_phase3_fresh.py worker/test_rolling_sales.py backend/tests -q
python scripts/assert_migration.py NEW_YORK_CLOSED_ENRICHED_v8.csv
cd frontend && npm run build
```

Operational verification:

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

## The AI agent

Structured data → SQL-first tool use, not vector guessing. "Phone for owner X" is a JOIN, not
a similarity answer. Contact values render only from `sbi_contacts` rows; the model never invents
one. Provider failover remains configurable through `AI_PROVIDER_ORDER` and `AI_QUALITY_PROVIDER`.

## Acceptance standard

A build is not considered working because a UI button exists. It is working when:

1. A manual request appears in `sbi_source_runs`.
2. The Python queue daemon claims it.
3. The correct Python module runs.
4. Stats/errors are written back to `sbi_source_runs`.
5. New/changed rows pass through `sbi_store.merge_deal()` or the amount-gated party-fill path.
6. Netlify reflects the updated data through Supabase RPC without exposing scraper/provider secrets.
