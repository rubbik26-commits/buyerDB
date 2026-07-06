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

## Phase L — Link (Connectivity)  ← CURRENT
- [ ] Supabase: list/inspect (or create) project; apply 4 migrations; verify with SQL probe
- [ ] Netlify: verify account/site access via MCP reader
- [ ] GitHub Actions: confirm workflows present + secrets list needed for worker
- [ ] Socrata (ACRIS/PLUTO): unauthenticated probe from `/execution/probe_socrata.py`
- [ ] traded.co: reachability note (curl_cffi only proves out on the Actions runner)
- [ ] Backend host: BLOCKED — needs user's Render/Railway credentials or host decision
- [ ] All green links logged in progress.md; broken links halt their dependent phases

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
