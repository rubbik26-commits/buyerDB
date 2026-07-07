# Task Plan — buyerDB under the B.L.A.S.T. Protocol

**Session start:** 2026-07-06
**Branch:** `claude/blast-protocol-setup-l8c6yu`
**Status:** Phase B ✅ approved (all 5 answers given 2026-07-06) → **Phase L in progress.**

## Protocol 0 — Initialization
- [x] `/memory/` created (task_plan, findings, progress, decisions)
- [x] `CLAUDE.md` Project Constitution created at repo root
- [x] `/architecture/`, `/execution/`, `/.tmp/` skeleton created
- [x] Halt: no logic written in `/execution/` — Blueprint questions outstanding

## Phase B — Blueprint (Vision & Logic) ✅ 2026-07-06
- [x] **North Star:** deploy the existing Skyline system live end-to-end (user-selected).
- [x] **Integrations:** Supabase ready (MCP), Netlify ready (MCP), GitHub Actions (this repo).
      Open: backend Python host credentials; AI provider keys (non-blocking — honest degradation).
- [x] **Source of Truth:** Supabase Postgres after CSV migration; CSV becomes snapshot.
- [x] **Delivery Payload:** live public URL, full stack; shape confirmed in CLAUDE.md.
- [x] **Behavioral Rules:** all seven repo invariants adopted unchanged.
- [x] Data Schema (Input + Output) confirmed in CLAUDE.md
- [x] Research logged in `/memory/findings.md`

## Phase L — Link (Connectivity)  ← CURRENT (5/7 green)
- [x] Supabase: project "Skyline" ACTIVE_HEALTHY; migrations 001–004 applied; 4,099 deals loaded; RPC health 200
- [x] Netlify: buyerdb.netlify.app live (200), bundle in RPC mode
- [x] GitHub Actions: ci + deploy-frontend green
- [x] Socrata (ACRIS): probe green (`execution/probe_links.sh`)
- [ ] Worker crons: RED — awaiting user-set `DATABASE_URL` secret (SOP written); re-run + verify after
- [ ] Backend on Render: awaiting user to connect repo in Render dashboard (render.yaml ready); then verify /api/health + set Netlify VITE_API_URL
- [x] Green links logged in progress.md; red links have runbooks in /architecture/SOP-deploy-links.md

## Phase A — Architect (A.N.T.)
- [ ] `/architecture/` SOP per subsystem (ingest, gate/merge, enrichment, agent, delivery)
- [ ] Navigation layer: routing between SOPs and tools defined
- [ ] `/execution/` atomic tools; secrets via `.env`; temp files via `/.tmp/`

## Phase S — Stylize
- [ ] Payload formatted for its destination (per Phase B answer)
- [ ] Every output has a verify step (test / screenshot / one-liner)
- [ ] User sign-off before deployment

## Phase T — Trigger
- [ ] Production transfer
- [ ] Firing mechanism (cron/webhook/manual) documented in CLAUDE.md
- [ ] Maintenance log finalized; self-annealing loop in effect

## Phase M — Maintenance (2026-07-07) — full-system review/optimize/improve loop
Branch `claude/system-debug-refactor-724uem`. Every tracked file read; verified findings fixed.
- [x] Six-subsystem review (worker, backend, frontend, edge functions, SQL, infra/docs)
- [x] Edge functions: fail-closed auth + shared `_shared/mod.ts` + honest failure reporting; `deno check` clean
- [x] SQL: migration 009 (api_buyers fan-out, anon review-write revoke, sync gate/conflict/lock, api_deals notes) — STAGED, not applied (D-011); real 007/008 sources restored
- [x] Worker: fetch-ledger blacklist, SoQL apostrophe, zero-price crash, party-conflict flagging, deterministic ordering, ledger-as-table; 27/27 tests
- [x] Backend: Gemini deny-list enforced, run_readonly_sql bypasses closed, /buyers fan-out, uploads NaN/idempotency, review action validation, pool sizing, router non-ProviderError failover
- [x] Frontend: NaN-filter, agent history roles, 5 fetch races, dead affordances removed, error-boundary, notes provenance surfaced
- [x] Infra/docs: legacy crons gated (ENABLE_LEGACY_WORKER), workflow bugs, seed SQL hardened + idempotent, render healthcheck, probe robustness, stale docs synced to D-008/D-010, zip removed
- [x] Verified end-to-end on a fresh Postgres 16: migrations 001–009 + CSV load → 13/13 assertions → 27/27 tests → frontend build → deno check
- [ ] **User deploy step:** apply `009_hardening.sql` + deploy the six `supabase/functions/` v2 sources in one window; verify a sync run + Buyers tab
