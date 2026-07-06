# Decisions Log

Each entry: what was decided, and why. If a decision is reversed, append — never delete.

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
