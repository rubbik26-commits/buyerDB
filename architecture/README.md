# /architecture/ — Layer A (SOPs)

One markdown SOP per subsystem: goal, inputs, tool logic, edge cases.
Golden Rule: when logic changes, update the SOP here **before** touching `/execution/`.

Current SOPs (Phase A completed 2026-07-06):

- `SOP-daily-refresh.md` — the live nightly refresh: pg_cron → Supabase edge
  functions → `sync_upsert_deals()`. THE current source of truth for triggers,
  cutover state, and decommission steps.
- `SOP-deploy-links.md` — deploy-target runbooks (Netlify, Supabase, the
  optional Render backend, legacy GitHub-Actions worker). Sections that predate
  the pg_cron-native architecture are marked superseded inline.
