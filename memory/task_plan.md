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
