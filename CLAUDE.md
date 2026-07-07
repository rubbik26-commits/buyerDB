# CLAUDE.md — buyerDB Project Constitution

Governing protocol: **B.L.A.S.T.** (Blueprint → Link → Architect → Stylize → Trigger)
with the **A.N.T.** 3-layer build (Architecture `/architecture/` · Navigation · Tools `/execution/`).
Living memory lives in `/memory/` — read `task_plan.md`, `findings.md`, `progress.md`,
`decisions.md` at the start of every session, and keep them current.

## State tracking

| Phase | Status | Output |
|---|---|---|
| 0 — Initialization | ✅ 2026-07-06 | memory + constitution + skeleton committed |
| B — Blueprint | ✅ 2026-07-06 | 5 discovery answers recorded below; Payload shape confirmed |
| L — Link | ✅ 2026-07-06 | All payload-critical links green: Supabase, Netlify, Base44, Socrata, pg_cron. GitHub-Actions worker path reclassified LEGACY (see SOP-daily-refresh) |
| A — Architect | ✅ 2026-07-06 | `sync_upsert_deals()` (migrations 005/006) + `skyline-sync` edge fn; SOPs in `/architecture/` |
| S — Stylize | ✅ (pre-existing) | payload = the live app; four tabs already styled and serving |
| T — Trigger | ✅ 2026-07-06 | pg_cron job `skyline-sync-daily` 07:40 UTC armed & verified; full trigger map in SOP-daily-refresh.md |
| M — Maintenance | ✅ 2026-07-07 | full-system read/optimize/improve pass on branch `claude/system-debug-refactor-724uem`: every file reviewed; verified fixes across worker/backend/frontend/edge-fns/SQL/infra; migration 009 + edge-fn v2 sources STAGED (D-011). 27 tests + 13 assertions green on a fresh DB |

**Protocol 0 halt lifted 2026-07-06:** all five discovery questions answered by the user,
Payload shape confirmed below, Blueprint approved in `task_plan.md`. `/execution/` may now
hold Phase L probe scripts and approved tools.

**Maintenance pass 2026-07-07 (self-annealing, per the log below):** a full review found
and fixed an auth fail-open in four edge functions, a rubber-stamped amount gate + anonymous
review-write + count inflation in SQL (→ migration 009, staged), the unenforced
no-contact-data-to-Gemini rule, an LLM-reachable SQL-guard bypass, and a class of silent
worker data-loss bugs. **Deploy step for the user:** apply `009_hardening.sql` and deploy the
six updated `supabase/functions/` sources in one window (see `memory/progress.md`).

## Repository map

- `skyline/` — **existing production system** (Skyline Deal Intelligence: React frontend,
  FastAPI backend, Python scraper worker, Supabase SQL migrations). Prior art; do not
  modify outside an approved Blueprint task. Its own docs: `README.md`,
  `SKYLINE_MASTER_BLUEPRINT.md`.
- `NEW_YORK_CLOSED_ENRICHED_v8.csv` — canonical dataset, 4,129 rows × 27 cols.
- `exclusion_ledger_additions_2026-07-02.csv` — deed-verified condo exclusions.
- `.github/workflows/` — daily-incremental, weekly-enrichment, ci (path-adjusted for `skyline/`).
- `/memory/`, `/architecture/`, `/execution/`, `/.tmp/` — B.L.A.S.T. working structure.

## Data Schemas

### Input shape (confirmed — the canonical CSV row, 27 columns)
```json
{
  "Sale Date": "2026-06-08",            "Post Date": "ISO timestamp",
  "Address": "1528 Williamsbridge Road","Market": "bronx",
  "Borough": "Bronx",                   "Asset Type": "Development Site",
  "Buyer": "…", "Buyer Phone": "…", "Buyer Email": "…", "Buyer Website": "…", "Buyer Address": "…",
  "Seller": "…","Seller Phone": "…","Seller Email": "…","Seller Website": "…","Seller Address": "…",
  "Sale Price": 3000000.0, "Units": 1.0, "PPU": 3000000.0, "Sq Ft": 3750.0, "PPSF": 800.0,
  "Source URL": "https://traded.co/…",  "Shortcode": "TRADED-…",
  "Confidence": 95.0,                    "Parse Status": "ok | needs_review",
  "Notes": "provenance string",          "sale_date_iso": "2026-06-08"
}
```
Relational shape (properties / entities / deals / deal_parties / contacts / interactions /
ledgers) is fully specified in `SKYLINE_MASTER_BLUEPRINT.md` §4–5 and
`skyline/database/migrations/`.

### Output / Payload shape — ✅ CONFIRMED 2026-07-06
The Payload is the **live, full-stack Skyline deployment**. Project is Complete only when
every field below is real and verified:

```json
{
  "frontend_url": "https://<site>.netlify.app — serves all four tabs",
  "backend_url": "https://<service> — FastAPI, Python host",
  "database": {
    "host": "Supabase Postgres (canonical source of truth)",
    "migrations_applied": ["001_schema","002_borough_statewide","003_enable_rls","004_rest_rpc_api","005_base44_sync","006_sync_dedupe_null_dates","007_b44_contact_harvest","008_broker_and_dos_writes"],
    "migrations_staged": ["009_hardening — apply to prod with the edge-fn v2 deploy (D-011)"],
    "deals_loaded": "NEW_YORK_CLOSED_ENRICHED_v8.csv via scripts/migrate_csv.py (4,533 live as of 2026-07-06)",
    "assertions": "scripts/assert_migration.py → ALL ASSERTIONS PASSED"
  },
  "health_checks": {
    "GET {backend}/api/health": 200,
    "GET {backend}/api/deals?limit=1": "200 with a real row",
    "frontend Deals tab": "renders live data (screenshot)",
    "no secrets in dist/": "CI secret-pattern scan clean"
  },
  "cron": {
    "daily-incremental.yml": "green run against Supabase",
    "weekly-enrichment.yml": "enabled"
  }
}
```

## Behavioral rules (provisional — adopted from repo invariants; user may amend in Phase B)

1. **Amount gate:** an ACRIS-sourced party attaches only when the deed amount is within 3%
   of the deal price (or, for no-price deals, deed within 60 days). Enforced in one Python
   write path AND the `acris_requires_gate` DB CHECK.
2. **No residential:** condos, co-ops, single-family, 1–2-family are rejected (DB CHECK +
   building-class gate in the merge path).
3. **Never overwrite non-null; conflicts are flagged (`review_queue`), never auto-resolved.**
4. **Ledgers are durable tables** (fetch / exclusion / rolling), never loose files.
5. **No fabricated contact info:** contact values render only from `contacts` rows with
   provenance. "No data" is a valid, required answer.
6. **Privacy:** never send uploaded contact data to providers that may train on prompts
   (e.g. Gemini free tier).
7. **Provenance on every fill** — who said so, queryable.

## Architectural invariants

- Deterministic business logic lives in `/execution/` scripts (and the existing
  `skyline/worker` + `shared/normalize.py`); LLMs route and narrate, they do not decide facts.
- One implementation of every invariant: normalization/gating stays in Python — do not port
  to JS (documented error class).
- If logic changes, update the `/architecture/` SOP **before** the code (Golden Rule).
- Credentials in `.env` / host secret stores only; never in source, never in the client bundle.
- Intermediate files go through `/.tmp/` (gitignored). A task is Complete only when the
  Payload lands at its destination.

## B.L.A.S.T. phase outputs

- **B — Blueprint (✅ 2026-07-06, user-answered):**
  1. *North Star:* the existing Skyline Deal Intelligence system running live in production
     end-to-end — Supabase loaded, backend deployed, frontend on Netlify, daily scraper cron green.
  2. *Integrations:* Supabase ✅ ready (MCP connected), Netlify ✅ ready (MCP connected),
     GitHub ✅ (this repo). Backend Python host (Render/Railway/Fly) — credentials NOT yet
     provided. AI provider keys — NOT yet provided (app degrades honestly without them).
  3. *Source of Truth:* Supabase Postgres after CSV migration; the repo CSV becomes a
     historical snapshot; scrapers write to the database.
  4. *Delivery Payload:* live public URL, full stack (shape above).
  5. *Behavioral Rules:* all seven repo invariants adopted unchanged; agent tone is
     professional broker-grade, cites sources, answers "no data" rather than guessing.
- **L — Link (✅ 2026-07-06):** operating architecture is **Netlify + Supabase + Base44**:
  pg_cron → dealflow edge functions → Base44; site reads Supabase via PostgREST RPC.
  The gap (fresh deals stranded in Base44) is closed by `skyline-sync`. GitHub-Actions
  Python worker = legacy fallback, not required. Probe: `execution/probe_links.sh`.
- **A — Architect (✅ 2026-07-06):** single write path `sync_upsert_deals()` (migrations
  005/006) enforces all invariants in SQL; the edge function is transport only.
  SOP: `/architecture/SOP-daily-refresh.md`.
- **T — Trigger (✅ 2026-07-06):** pg_cron `skyline-sync-daily` (`40 7 * * *` UTC) after
  the dealflow train; secret read from `app_config` at fire time. Verified: +434 net-new
  deals (4,099 → 4,533), idempotent re-run, 0 duplicate groups.
- **A — Architect:** *(pending)*
- **S — Stylize:** *(pending)*
- **T — Trigger:** *(pending — triggers documented here when armed; existing GitHub Actions
  crons for `skyline/` remain as-is: daily 13:17 UTC incremental, Sunday 11:43 UTC enrichment)*

## Maintenance log / self-annealing

*(finalized in Phase T)* — On any failure: read the trace → patch `/execution/` → verify →
write the lesson into the matching `/architecture/` SOP.
