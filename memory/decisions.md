# Decisions Log

Each entry: what was decided, and why. If a decision is reversed, append — never delete.

## 2026-07-07

**D-011 — Migration 009 + edge-function v2s are STAGED in git, not auto-applied to prod.**
The refactor branch fixes live-schema defects (api_buyers fan-out, anonymous
api_review_act write, sync_upsert_deals gate/conflict/lock hardening) as
`009_hardening.sql` plus rewritten function sources, all verified on a fresh
local Postgres (27/27 tests, 13/13 assertions). Applying to prod is a
one-window user step: run 009, deploy the six functions (acris-v2 now sends
`deed_amount`), verify a sync run. *Why:* the same session earlier could not
deploy edge functions (tool approval), and coupling a schema change to
un-deployed function sources would break the gate evidence handshake.

**D-012 — TS normalization unified in `_shared/mod.ts`; SQL-side normalization deferred.**
The four divergent edge-function copies of canonicalizeAddress/normalizeEntity
are now one module mirroring `shared/normalize.py` (uppercase preserved so
sync-era rows keep matching). Computing `address_norm` inside
`sync_upsert_deals()` — the true single-implementation fix — needs a
re-normalization data migration over existing rows (unique-collision merges)
and is deferred to its own Blueprint task. *Why:* shortcode-first dedupe makes
same-source re-runs safe today; the residual risk is cross-source property
duplicates, which predates this change.

## 2026-07-06

**D-001 — Layer B.L.A.S.T. structure alongside the existing `skyline/` app, not inside it.**
`/memory/`, `/architecture/`, `/execution/`, `CLAUDE.md` live at repo root; `skyline/` is
treated as prior art / an existing engine, untouched until the Blueprint says otherwise.
*Why:* Surgical Changes principle — the existing system is tested and documented; restructuring
it before knowing the North Star would be speculative.

**D-002 — Treat `SKYLINE_MASTER_BLUEPRINT.md` as inherited research, not as the approved Blueprint.**
Its schemas and constraints are logged in findings.md and referenced by CLAUDE.md, but Phase B
discovery still runs: the user's North Star for *buyerDB* may extend or diverge from it.
*Why:* Never guess at business logic; the blueprint predates this protocol and this task.

**D-003 — `/.tmp/` is gitignored; `/memory/`, `/architecture/`, `CLAUDE.md` are committed.**
*Why:* memory must survive container recycling (remote ephemeral environment); intermediates must not
pollute the repo.

**D-005 — Blueprint answers (user, via interactive prompts, 2026-07-06).**
North Star = deploy Skyline live full-stack; Supabase Postgres canonical; payload = live
public URL with health checks + green cron; all seven invariants kept unchanged.

**D-006 — Worker `DATABASE_URL` secret: user will add it later themselves.**
Runbook written in `/architecture/SOP-deploy-links.md`. Crons stay red until then; nothing
else blocks on it.

**D-007 — Backend host = Render (user choice), via the existing `render.yaml` blueprint.**
Needs the user's Render account to connect the repo; assistant verifies `/api/health` and
flips Netlify's `VITE_API_URL` afterward. Data tabs stay on Supabase RPC mode meanwhile.

**D-010 — Base44 is OUT of the system (user directive, 2026-07-06 night).**
Supersedes the D-008 sync-bridge architecture: scrapers now write directly into
Supabase via `sync_upsert_deals()`; the bridge and Base44-only functions retire once
the last staged deploy (crexi-ingest) lands. Enriched Base44 contact data was
harvested first (1,521 contacts, 4,457 mailing addresses). *Why:* the user states
Base44 is not part of this system; Supabase is the Phase-B source of truth; one write
path, one platform, and the hardcoded-key exposure disappears with the Base44 hop.

**D-008 — Daily refresh is Supabase-native (Base44 → skyline-sync), NOT GitHub Actions (2026-07-06).**
The user's operating stack (Netlify + Supabase + Base44, pg_cron already green daily)
was discovered live; a sync bridge respects it instead of forcing the GitHub worker
path. D-007's Render plan and the `DATABASE_URL` GitHub secret become optional/legacy —
only needed if the curl_cffi scraper or FastAPI features (uploads, AI Deal Desk) are
wanted later. *Why:* reliability over rebuilding; zero user-side steps; the invariants
move into one SQL write path (`sync_upsert_deals`).

**D-009 — Sync secrets live in `app_config` (RLS'd table), not in function source.**
Older dealflow functions hardcode the Base44 key (pre-existing debt, rotation SOP'd);
the new path reads config at runtime so rotation is a single UPDATE.

**D-004 — Existing repo invariants adopted as provisional Behavioral Rules in CLAUDE.md.**
Amount gate, no-residential, never-overwrite-non-null, flagged-not-resolved conflicts,
no fabricated contacts, no contact data to trainable free tiers.
*Why:* each one encodes a documented, hard-won failure (e.g. the 34/34 wrong-party audit);
dropping them silently would re-introduce known error classes. User may amend in Phase B.
