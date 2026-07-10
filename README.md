# Skyline Deal Intelligence

Skyline Deal Intelligence is a live NYC commercial-real-estate prospecting and buyer-matching system built from the verified master blueprint.

## Production topology

```text
buyerdb.netlify.app
  React/Vite frontend
  Netlify Functions: SQL-first AI agent, scraper control plane
  Netlify scheduled/background functions: long-running scraper orchestration
        |
        v
Supabase project pdvyuepsdnpxctmagdcq
  canonical sbi_* tables
  durable fetch/exclusion/rolling ledgers
  review queue + scraper run audit
  source-safe RPC write path
  ACRIS / Traded / DOS Edge Functions
```

GitHub stores and tests the source. It does **not** execute production scraper jobs.

## Implemented scraper train

- **ACRIS fresh window** — deed masters, legals, parties, PLUTO classification, $1M floor, residential/condo rejection, BBL/provenance, amount-gated parties.
- **Traded** — New York listing pages plus NY-scoped sitemap discovery, durable fetch dispositions, challenge detection, structured party extraction with title fallback, server-side ScraperAPI transport.
- **Crexi** — configured Apify actor/dataset ingestion; active listings remain explicitly labeled as listing intelligence rather than closed-sale facts; broker contacts retain source provenance.
- **Rolling Sales** — fills units/square footage only when all matching city rows agree; R classes are ignored; >20% conflicts are reviewed and never overwrite verified values.
- **Phase 2 ACRIS lag closer** — address → legals → deed masters → party details; priced rows require deed amount within 3% and ≤400 days; no-price rows use the unique-deed path and the final write remains amount-gated.
- **NYS DOS** — entity mailing/key-person enrichment with registered-agent-mill filtering.

Scheduled Netlify dispatches:

- ACRIS: `17 13 * * *`
- Traded: `47 13 * * *`
- Rolling Sales: `27 14 * * *`
- Crexi: `17 15 * * *`
- Weekly ACRIS party lag + DOS: `43 11 * * 0`

Every manual or scheduled request creates a durable `sbi_source_runs` row before execution. The Scrapers tab dispatches the real server-side background job and shows its counters/errors.

## Database invariants

- No condos, co-ops, single-family, two-family, or 1–2 family rows.
- Every merge consults `sbi_exclusion_ledger`.
- Discovery checkpoints live in `sbi_fetch_ledger`; Rolling completion lives in `sbi_rolling_ledger`.
- ACRIS parties physically require `amount_gate_passed=true`, a verified deed amount, and a provenance reference.
- Existing non-null facts are never silently replaced. Source disagreements create review rows.
- Duplicate checks use ACRIS document ID/source key first, then property + price + date.

## Deal Desk

`/api/agent` is SQL-first:

1. Deterministic intent extraction handles the common broker questions without an LLM.
2. A configured fast provider can plan long-tail questions into one allowlisted tool.
3. The selected Supabase RPC executes against real rows.
4. A quality provider may narrate those rows; deterministic narration remains available if every provider is unavailable.

Named tools include contact lookup, latest interaction, similar-buyer scoring, buyer leaderboard, entity history, similar sellers, contact gaps, recent changes, and recent deals.

The similar-buyer tool ports the artifact’s scoring concept into SQL: asset, borough, price, keyword, recurrence, and SPV-discount factors. Contact-sensitive results are never sent through Gemini. Every provider attempt is recorded in `sbi_ai_logs`; the answer never invents a phone, email, owner, buyer, price, or interaction.

Providers supported through Netlify environment variables:

- Groq
- Gemini
- OpenRouter
- Cloudflare Workers AI
- Anthropic
- OpenAI

## Required production environment

Frontend-safe build variables:

- `VITE_API_URL`
- `VITE_USE_SUPABASE_RPC=true`
- `VITE_SUPABASE_ANON_KEY`

Netlify Functions/runtime:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`
- `SCRAPER_TRIGGER_SECRET`, `SYNC_SECRET`, or `CRON_SECRET`
- `SOCRATA_APP_TOKEN`
- `SCRAPERAPI_KEY`
- `APIFY_TOKEN`
- `APIFY_CREXI_ACTOR`
- AI provider keys and `AI_PROVIDER_ORDER` / `AI_QUALITY_PROVIDER`

`/api/runtime-health` reports presence booleans only; it never exposes values.

## Repository layout

```text
skyline/frontend/                  React/Vite app
skyline/frontend/netlify/functions Netlify API, background, and scheduled functions
skyline/frontend/netlify/lib/      scraper orchestration/runtime libraries
skyline/supabase/functions/        source-specific Supabase Edge Functions
skyline/database/migrations/       reproducible SBI schema/RPC migrations
skyline/worker/                    verified original Python pipeline and tests
skyline/backend/                   FastAPI reference implementation and provider/tool tests
```

## CI

`.github/workflows/ci.yml` is test-only. It:

- loads the original worker schema into a fresh PostgreSQL 16 instance,
- migrates/asserts the canonical CSV,
- runs the proven pipeline and backend tests,
- builds the frontend and scans `dist/` for server secrets,
- verifies live Supabase health and the Brooklyn multifamily buyer recommendation query.

Netlify’s native Git integration handles preview and production builds. Broken token-dependent GitHub deploy jobs and all GitHub scraper-worker workflows were removed.
