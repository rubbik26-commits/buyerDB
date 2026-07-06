# CLAUDE.md — buyerDB Project Constitution

Governing protocol: **B.L.A.S.T.** (Blueprint → Link → Architect → Stylize → Trigger)
with the **A.N.T.** 3-layer build (Architecture `/architecture/` · Navigation · Tools `/execution/`).
Living memory lives in `/memory/` — read `task_plan.md`, `findings.md`, `progress.md`,
`decisions.md` at the start of every session, and keep them current.

## State tracking

| Phase | Status | Output |
|---|---|---|
| 0 — Initialization | ✅ 2026-07-06 | memory + constitution + skeleton committed |
| B — Blueprint | 🟡 IN PROGRESS | **HALTED: awaiting the 5 discovery answers** (see `/memory/task_plan.md`) |
| L — Link | ⬜ not started | — |
| A — Architect | ⬜ not started | — |
| S — Stylize | ⬜ not started | — |
| T — Trigger | ⬜ not started | — |

**Standing halt:** no logic may be written in `/execution/` until the Blueprint discovery
questions are answered, the Data Schema below is confirmed (especially the Payload/output
shape), and the Blueprint in `task_plan.md` is approved by the user.

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

### Output / Payload shape — ⚠️ UNCONFIRMED
Defined only after the Blueprint "Delivery Payload" answer. **Coding begins only once this
shape is confirmed** (Data-First Rule).

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

- **B — Blueprint:** *(pending discovery answers)*
- **L — Link:** *(pending)*
- **A — Architect:** *(pending)*
- **S — Stylize:** *(pending)*
- **T — Trigger:** *(pending — triggers documented here when armed; existing GitHub Actions
  crons for `skyline/` remain as-is: daily 13:17 UTC incremental, Sunday 11:43 UTC enrichment)*

## Maintenance log / self-annealing

*(finalized in Phase T)* — On any failure: read the trace → patch `/execution/` → verify →
write the lesson into the matching `/architecture/` SOP.
