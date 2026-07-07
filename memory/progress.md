# Progress Log

## 2026-07-06 (night) — BASE44 REMOVAL (user directive: "this system has nothing to do with base44")
User chose "Cut Base44 out" — scrapers write directly to Supabase. Done so far:
1. **Contact harvest** (before decommission): pulled all 7,818 Base44 Contact records;
   6,344 had value → 4,498 entities matched → **1,521 contacts inserted** (889 phones /
   226 emails / 1,787 key persons in source set) + **4,457 entity mailing addresses**
   filled (null-only). Migrations 007/008.
2. **acris-v2 rewritten** → direct `sync_upsert_deals()`; deployed; tested on a May
   window: 646 masters → 103 qualified → 101 dup (continuity ✓), 0 errors.
3. **traded-daily rewritten** → deployed; tested (maxFetches=2): reads 1,112 TRADED
   shortcodes from Supabase ✓, 0 errors. Discovery returned 0 — see finding below.
4. **crexi-ingest / crexi-run / dos-enrich rewrites STAGED** in
   `skyline/supabase/functions/` — deploys blocked: the Supabase MCP
   `deploy_edge_function` tool now demands an approval this session can't grant
   (execute_sql still works). Deploy verbatim when approval clears.
5. Cron topology deliberately unchanged until step 4 lands (skyline-sync keeps
   bridging crexi output; reconcile/llm-enrich retire after). Checklist in
   SOP-daily-refresh.md.

**Finding:** ScraperAPI account has **0 credits** (6,869 used / 1,000 monthly, resets
~Jul 24) → traded.co discovery has been silently returning 0 for a while (predates
tonight). Options: wait for reset, upgrade plan, or re-arm the free curl_cffi
GitHub-Actions worker (the one thing the legacy path does better).
**Finding:** llm-enrich depends on Base44's InvokeLLM engine — parked until an AI
provider key exists (Phase B: none supplied).

## 2026-07-06 — Protocol 0 initialization
- Created `/memory/` (task_plan, findings, progress, decisions), `/architecture/`,
  `/execution/`, `/.tmp/` (gitignored), root `.gitignore`, and `CLAUDE.md` constitution.
- Surveyed the repo: existing Skyline Deal Intelligence system + master blueprint found;
  logged in findings.md. No existing files were modified.
- **No logic written in `/execution/`** — halted per Protocol 0.
- Tests run: none yet (no code written this session).
- Errors hit: none.

## 2026-07-06 — Phase B complete
All five discovery questions answered by the user via interactive prompts:
deploy Skyline live / Supabase+Netlify ready / Supabase Postgres canonical /
live URL full-stack payload / keep all seven invariants. Recorded in CLAUDE.md.

## 2026-07-06 — Phase L link-verification results

| Link | Probe | Result |
|---|---|---|
| Supabase project "Skyline" (`hvsvxjdwfbsqaqlmuwlt`) | MCP `list_projects` / `list_tables` / `list_migrations` | ✅ ACTIVE_HEALTHY, Postgres 17; skyline migrations 001–004 applied 2026-07-06; **data loaded**: deals 4,099, properties 3,871, entities 6,011, deal_parties 6,418, contacts 171, review_queue 355, exclusion_ledger 30 |
| Supabase PostgREST RPC | `execution/probe_links.sh` → `POST /rest/v1/rpc/api_health` | ✅ 200 `{"deals": 4099, "status": "ok"}` |
| Netlify site `buyerdb` | MCP `get-projects` + curl | ✅ live at buyerdb.netlify.app (200); deploy state ready; bundle built in **RPC mode** (talks straight to Supabase, no backend needed for data tabs) |
| Socrata / ACRIS | `execution/probe_links.sh` | ✅ 200, live deed-master rows |
| GitHub Actions — ci, deploy-frontend | runs on ACRIS branch | ✅ success |
| GitHub Actions — daily-incremental, weekly-enrichment, load-database | run logs (e.g. run 28824659351) | ❌ **RED — `DATABASE_URL` repo secret not set.** Workflow's own error: add the Supabase SESSION POOLER string under Settings → Secrets → Actions (direct db.* host is IPv6-only on runners). `SOCRATA_APP_TOKEN`, `ALERT_WEBHOOK_URL` also empty (optional). |
| FastAPI backend host | — | ❌ **not deployed** (no Render/Railway credentials). Data tabs unaffected; uploads / entity merges / AI Deal Desk offline until deployed. `render.yaml` exists at repo root. |
| AI provider keys | — | ⬜ none provided (optional; app degrades honestly) |

## 2026-07-06 (late) — TRUE ARCHITECTURE DISCOVERED; refresh loop closed end-to-end

User pushback ("we deployed on Netlify not render") led to checking Netlify env vars
and the Supabase project's edge functions. Findings, then the build:

1. User HAD saved credentials — 9 Supabase env vars on the Netlify buyerdb site
   (19:05 UTC, via the Supabase extension). My earlier "secret missing" framing was
   about the wrong machine: GitHub runners never see Netlify's vault.
2. A full **dealflow pipeline already runs Supabase-native**: pg_cron (7 jobs, green
   daily for days) → edge functions (acris-v2, traded-daily, crexi-*, pipeline-reconcile,
   dos-enrich, llm-enrich) → **Base44 app entities** (4,358 deals, 33 new this month).
3. THE GAP: the live site reads Supabase `deals` (one-time CSV load); fresh deals landed
   only in Base44 → the site would silently go stale.
4. BUILT + DEPLOYED the bridge: migrations skyline_005/006 (`app_config`, `sync_state`,
   `sync_upsert_deals()`), edge function `skyline-sync` (v3), pg_cron job
   `skyline-sync-daily` @ 07:40 UTC.
5. Self-annealing incident: first run created 143 dup deals (junk-date rows bypassing
   addr+price+date dedupe). Fixed in both layers (client date normalization + SQL
   unknown-date dup rule), deleted 126 residual dups, re-verified.
6. FINAL VERIFIED STATE: deals 4,099 → **4,533** (+434 net new), 0 duplicate
   (property,price,date) groups, newest post_date = today, 15 contacts with provenance,
   sync idempotent (two consecutive runs: inserted 0, errors 0), live `api_health`
   agrees: 4,533. Tests run: staged 500-row sync, 2× full sync, idempotency re-run,
   whole-table dup scan.
7. GitHub Actions worker path reclassified LEGACY (not needed for refresh); temporary
   diag-secrets workflow removed from ACRIS. ⚠️ Security debt logged: hardcoded Base44
   key in older edge functions — rotation steps in SOP-daily-refresh.md.

## Superseded — earlier blockers (kept for history)
1. `DATABASE_URL` repo secret: **user will add it later** (runbook:
   `/architecture/SOP-deploy-links.md`). Crons red until then.
2. Backend host: **Render chosen**; user must connect the repo in the Render
   dashboard (render.yaml is ready). Assistant then verifies `/api/health` and
   sets Netlify `VITE_API_URL`.
3. Optional keys (AI providers, Socrata token, alert webhook) — whenever available.

## Environment note
Live-site screenshot verification is blocked in this container: Playwright's Chromium
cannot trust the egress proxy's CA (no certutil/NSS store available, apt install fails).
Payload verified instead via HTTP probes: site 200, bundle confirmed RPC-mode,
`api_health` → 4,099 deals. Capture the screenshot at final Phase S sign-off.
