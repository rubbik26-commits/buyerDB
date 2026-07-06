# Skyline Deal Intelligence

A production system that turns a static NYC commercial-real-estate deal artifact into a
living application: scrapers refresh the dataset on a schedule, a FastAPI backend serves
it (and proxies every AI call so no key ever reaches the browser), and an in-app agent
answers deal questions — "who's the best buyer for this?", "what's this owner's phone
number?", "when did we last contact them?" — as SQL over Postgres, narrated by whichever
of six providers is up and within quota.

```
frontend/  React 18 + Vite (static) ── the four tabs, deployable to Vercel/Netlify
backend/   FastAPI ─────────────────── /api/deals /buyers /leaderboards /agent /uploads /review
worker/    the proven Python pipeline ─ scrapers + amount-gated merges, on a schedule
shared/    normalize.py ────────────── ONE implementation of every invariant, imported by both
database/  numbered SQL migrations
scripts/   CSV → Postgres migration + assertions
```

Why a backend is mandatory (not a preference): browsers can't run cron, a client bundle
can't hold provider/scraper keys, the artifact's Anthropic call only works behind Claude.ai's
proxy, and the dataset is already >1 MB and grows daily. All four are structural.

## The invariants (encoded, not hoped for)

- **Amount gate** — an ACRIS-sourced party is only attached when the deed amount is within
  3% of the deal price (or, for no-price deals, the deed is within 60 days). This killed a
  documented 34/34 wrong-party failure. It lives in one Python write path **and** as a
  Postgres CHECK (`acris_requires_gate`): an ungated ACRIS party row physically cannot exist.
- **No residential** — condos, co-ops, single-family and 1–2 family are rejected by a DB CHECK
  and by a building-class gate in the merge path (the hole that once admitted 30 rows).
- **Ledgers are durable tables**, not pickle files: `fetch_ledger` (discovery dedupe),
  `exclusion_ledger` (consulted on every merge), `rolling_ledger`.
- **Never overwrite non-null; conflicts are flagged, never resolved** (`review_queue`).

## Quick start (local)

Prereqs: Python 3.12, Node 18+, PostgreSQL 16.

```bash
# 1. database
createdb skyline
psql skyline -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
export DATABASE_URL=postgresql://localhost/skyline
for f in database/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 2. load the canonical dataset (+ exclusion ledger) and verify
pip install -r requirements.txt
python scripts/migrate_csv.py NEW_YORK_CLOSED_ENRICHED_v8.csv exclusion_ledger_additions_2026-07-02.csv
python scripts/assert_migration.py NEW_YORK_CLOSED_ENRICHED_v8.csv     # must print ALL ASSERTIONS PASSED

# 3. backend
cp .env.example .env          # add provider keys as available
uvicorn backend.app.main:app --reload      # http://localhost:8000

# 4. frontend
cd frontend && cp .env.example .env         # VITE_API_URL=http://localhost:8000
npm install && npm run dev                  # http://localhost:5173
```

Without any AI key the four data tabs work fully; the Deal Desk returns an honest
"no provider configured" message (never a fabricated answer).

## Tests

```bash
python -m pytest worker/test_store.py backend/tests worker/test_run_incremental.py -q
python scripts/assert_migration.py NEW_YORK_CLOSED_ENRICHED_v8.csv
cd frontend && npm run build      # production build; grep dist/ shows no secrets
```

## The AI agent

Structured data → SQL-first tool-use, not vector search. "Phone for owner X" is a JOIN, not
a similarity guess. Nine named tools (`lookup_contact`, `find_similar_buyers` — the artifact's
`rankCandidates` scoring in SQL, `buyer_leaderboard`, `last_interaction`, `entity_history`,
`missing_contact_report`, `seller_owners_of_similar`, `recent_changes`) plus a guarded
`run_readonly_sql` escape hatch (SELECT-only, allowlisted tables, auto-LIMIT, 5s timeout).
Two stages: a fast lane plans the tool + arguments, a quality lane narrates the rows and cites
them. Contact values render only from `contacts` rows — the model never invents one.

## Providers (verified 2026-07-02; re-verify before relying on limits)

| Provider | Free tier | Role |
|---|---|---|
| Groq | ~30 RPM, 1K–14.4K RPD | primary tool lane |
| Gemini | Flash only, ~10–15 RPM (may train on prompts — no contact data) | secondary |
| OpenRouter | 50 RPD free, 1,000/day after one-time $10 | breadth |
| Cloudflare | 10,000 neurons/day | utility |
| Anthropic | no free tier (paid) | quality lane |
| OpenAI | no permanent free tier | optional quality |

The router (`AI_PROVIDER_ORDER`, `AI_QUALITY_PROVIDER`) fails over on 429/5xx/timeout/network,
pre-emptively skips a provider whose daily budget is spent, and logs every attempt
(`provider`, `latency`, `fallback_from`, `status`) to `ai_logs`.

## Scheduling (GitHub Actions, free tier)

- `daily-incremental.yml` (`17 13 * * *`): traded discovery minus the fetch ledger → gated
  merge → fresh ACRIS window → rolling batch → keep-alive commit (defeats the 60-day
  schedule auto-disable) → fails loudly with a webhook alert.
- `weekly-enrichment.yml` (`43 11 * * 0`): phase2 match → amount-gated apply; closes the
  7–8 week ACRIS party-recording lag as the window rolls.
- `ci.yml`: spins a fresh Postgres, applies migrations, runs the full test suite, builds the
  frontend, and fails if any secret pattern appears in `dist/`.

curl_cffi bypasses traded.co's Cloudflare for free on the Python runner; a JS/Deno host would
need ScraperAPI (~11 credits per protected page). That's why the worker stays Python.

## Deploy

Frontend → Vercel/Netlify (static; set `VITE_API_URL`). Backend → Render/Railway (FastAPI
container; set the backend env vars). Postgres → Supabase (Pro recommended for backups and
no idle-pause). Worker → GitHub Actions (private repo; set repo Secrets). Estimated cost:
$0 prototype → ~$32–42/mo production.

## Acceptance evidence (this build)

- **A — scheduled ingest + ledger dedupe:** `worker/test_run_incremental.py` — a run merges a
  new deal, the exclusion ledger blocks a residential one, the re-run dedupes discovery via the
  fetch ledger. PASS.
- **B — phone from an uploaded CSV, with provenance:** upload → entity resolution → `lookup_contact`
  returns the uploaded number with `source=upload:<id>`, linked to the buyer's real deal history.
  Verified end-to-end.
- **C — provider failover:** `backend/tests/test_provider_router.py` — kill the primary, the
  request succeeds via fallback, `fallback_from` is logged. 6/6 PASS.
- **D — no secrets in the client bundle:** the built `dist/` references only `VITE_API_URL`; the
  precise secret-pattern scan is clean.
