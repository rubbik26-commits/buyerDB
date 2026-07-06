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
| L — Link | 🟡 5/7 GREEN | Supabase (loaded!), Netlify (live), Socrata, CI, deploy-frontend ✅ · worker crons ❌ (no `DATABASE_URL` secret) · backend host ❌ (not provisioned) — see `/memory/progress.md` |
| A — Architect | ⬜ not started | — |
| S — Stylize | ⬜ not started | — |
| T — Trigger | ⬜ not started | — |

**Protocol 0 halt lifted 2026-07-06:** all five discovery questions answered by the user,
Payload shape confirmed below, Blueprint approved in `task_plan.md`. `/execution/` may now
hold Phase L probe scripts and approved tools.

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
    "migrations_applied": ["001_schema","002_borough_statewide","003_enable_rls","004_rest_rpc_api"],
    "deals_loaded": "NEW_YORK_CLOSED_ENRICHED_v8.csv via scripts/migrate_csv.py",
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
- **L — Link (🟡 2026-07-06):** database + frontend + data-tab pipeline fully live —
  buyerdb.netlify.app → Supabase RPC → 4,099 deals. Probe: `execution/probe_links.sh`.
  Red links (user credentials required): worker `DATABASE_URL` secret; backend host.
  Full table in `/memory/progress.md`.
- **A — Architect:** *(pending)*
- **S — Stylize:** *(pending)*
- **T — Trigger:** *(pending — triggers documented here when armed; existing GitHub Actions
  crons for `skyline/` remain as-is: daily 13:17 UTC incremental, Sunday 11:43 UTC enrichment)*

## Maintenance log / self-annealing

*(finalized in Phase T)* — On any failure: read the trace → patch `/execution/` → verify →
write the lesson into the matching `/architecture/` SOP.
