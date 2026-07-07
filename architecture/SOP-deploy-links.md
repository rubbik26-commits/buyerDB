# SOP — Deployment links (updated 2026-07-07 for D-008/D-010)

**Goal:** every link in the Payload (CLAUDE.md → Output shape) green.
**Verify at any time:** `bash execution/probe_links.sh` (credential-free links) +
the Supabase `sync_state` row / cron run history (live refresh) + the GitHub
Actions run list (legacy fallback only).

> **Superseded notice (2026-07-07).** The original version of this SOP treated
> the GitHub-Actions worker crons as a required red link. Decisions **D-008 /
> D-010** reclassified that whole path as **optional legacy fallback**: the live
> refresh is `pg_cron → Supabase edge functions → sync_upsert_deals()`, verified
> green 2026-07-06 (+434 net-new deals, idempotent re-run). Nothing below is
> required for the daily refresh to work. See `SOP-daily-refresh.md` — that file
> is the source of truth for the live pipeline.

## Current live topology (verified 2026-07-06)

```
pg_cron (Supabase) ─▶ edge functions (acris-v2, traded-daily, …) ─▶ sync_upsert_deals()
                                                                        │
buyerdb.netlify.app ──(PostgREST RPC, anon key, RLS)──▶  Supabase "Skyline"
   React, RPC-mode bundle                                hvsvxjdwfbsqaqlmuwlt
   Deals/Buyers/Leaderboards/Review live                 4,533 deals (2026-07-06)

Optional / legacy:
  GitHub Actions worker crons ── disabled by default (ENABLE_LEGACY_WORKER repo var)
  FastAPI backend (uploads/merges/AI Deal Desk) ── not hosted yet (render.yaml ready)
  GitHub Pages mirror ── deploy-frontend.yml publishes a fallback copy of the bundle
```

## Optional link 1 — legacy worker `DATABASE_URL` secret (only if the fallback is wanted)

Enable only if the free curl_cffi scraper fallback is needed (e.g. ScraperAPI
credits exhausted — see the 2026-07-06 finding in `memory/progress.md`):

1. Supabase dashboard → project **Skyline** → **Connect** button (top bar) →
   copy the **Session pooler** URI (`postgresql://postgres.hvsvxjdwfbsqaqlmuwlt:…@aws-0-us-east-1.pooler.supabase.com:5432/postgres`).
   ⚠️ Not the direct `db.hvsvxjdwfbsqaqlmuwlt.supabase.co` host — it is IPv6-only and
   unreachable from Actions runners (this exact failure is in run 28824659351's log).
2. GitHub → `rubbik26-commits/buyerDB` → Settings → Secrets and variables → Actions →
   **New repository secret** → name `DATABASE_URL`, value = the pooler URI.
3. Same screen → **Variables** → new repository variable `ENABLE_LEGACY_WORKER` = `true`
   (the scheduled runs are gated on it; `workflow_dispatch` works regardless).
4. Optional secrets: `SOCRATA_APP_TOKEN` (lifts anonymous throttle),
   `ALERT_WEBHOOK_URL` (failure pings), `SCRAPERAPI_KEY` (scraper fallback).
5. Verify: Actions tab → `daily-incremental` → **Run workflow** → must end green.

## Optional link 2 — FastAPI backend on Render (enables uploads / merges / AI Deal Desk)

1. render.com → **New → Blueprint** → connect `rubbik26-commits/buyerDB`.
   `render.yaml` at repo root defines service `skyline-api` (free plan, Python 3.12,
   rootDir `skyline`).
2. When prompted for env vars: `DATABASE_URL` = the same session-pooler URI;
   `FRONTEND_URL` = `https://buyerdb.netlify.app`; `GROQ_API_KEY` optional (free at
   console.groq.com — enables the AI Deal Desk's tool lane).
3. Verify: `curl https://skyline-api.onrender.com/api/health` → 200.
4. Then flip the frontend to the full backend: Netlify site `buyerdb` →
   Environment variables → set `VITE_API_URL` to the Render URL → redeploy, and
   add the Render host to `connect-src` in `netlify.toml`'s CSP header.
   (Until then the bundle stays in RPC mode — data tabs keep working either way.)

## Edge cases / lessons

- Free Render services sleep after idle; first request takes ~30s. Acceptable, or
  upgrade the plan.
- Supabase free tier pauses after 7 idle days; the nightly pg_cron writes prevent
  this on their own.
- The anon key in the client bundle is public **by design**; RLS + SECURITY DEFINER
  `api_*` functions are the security boundary. Never put the `service_role` key
  anywhere client-side or in the frontend build env (CI greps the bundle for
  `service_role` / `sb_secret_` patterns).
- Migration 009 (staged 2026-07-07, apply to prod when ready): fixes the
  `api_buyers` contact fan-out, revokes the anonymous `api_review_act` write,
  and hardens `sync_upsert_deals` (amount-gate evidence, conflict flagging,
  advisory lock). The updated edge-function sources in
  `skyline/supabase/functions/` should be deployed in the same window.
