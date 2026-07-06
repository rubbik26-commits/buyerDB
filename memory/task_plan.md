# Task Plan — buyerDB under the B.L.A.S.T. Protocol

**Session start:** 2026-07-06
**Branch:** `claude/blast-protocol-setup-l8c6yu`
**Status:** Protocol 0 complete → **HALTED at Phase B awaiting the five discovery answers.**

## Protocol 0 — Initialization
- [x] `/memory/` created (task_plan, findings, progress, decisions)
- [x] `CLAUDE.md` Project Constitution created at repo root
- [x] `/architecture/`, `/execution/`, `/.tmp/` skeleton created
- [x] Halt: no logic written in `/execution/` — Blueprint questions outstanding

## Phase B — Blueprint (Vision & Logic)  ← CURRENT
Discovery questions (each must be answered by the user before coding):
- [ ] **North Star** — the singular outcome that means we won.
      *Working hypothesis from repo evidence (unconfirmed):* live, daily-refreshed NYC CRE deal/buyer intelligence answering "who is the best buyer for this deal, and how do I reach them?"
- [ ] **Integrations** — which external services, and are credentials ready?
      *Candidates found in repo:* Supabase (Postgres), Render/Railway (FastAPI), Netlify/Vercel (frontend), GitHub Actions (worker cron), NYC Open Data/Socrata (ACRIS/PLUTO), traded.co scrape, AI providers (Groq/Gemini/OpenRouter/Cloudflare/Anthropic/OpenAI), optionally Apollo.io + Base44 (connected to this session).
- [ ] **Source of Truth** — where the primary data lives.
      *Candidates:* the canonical CSV (`NEW_YORK_CLOSED_ENRICHED_v8.csv`, 4,129 rows) vs. a live Supabase Postgres instance (migrations exist in `skyline/database/`). Is a Supabase project already provisioned and loaded?
- [ ] **Delivery Payload** — how/where the final result lands (deployed web app? Slack digest? Sheet? email?).
- [ ] **Behavioral Rules** — tone, must-dos, must-not-dos, refusal triggers.
      *Already encoded in repo (to confirm they remain law):* amount gate, no-residential gate, never overwrite non-null, conflicts flagged not resolved, no fabricated contact info, no contact data to trainable free tiers.
- [ ] Data Schema (Input + Output) confirmed in CLAUDE.md — Payload shape signed off
- [ ] Research logged in `/memory/findings.md` (initial pass done; extend per answers)

## Phase L — Link (Connectivity)
- [ ] Enumerate every credential from Phase B answers into `.env`
- [ ] Probe script per service in `/execution/` (e.g. `probe_supabase.py`, `probe_socrata.py`, `probe_ai_providers.py`)
- [ ] All probes green, results logged in progress.md — else halt

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
