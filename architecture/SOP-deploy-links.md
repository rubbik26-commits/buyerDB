# SOP — Deployment links & the two remaining red links

**Goal:** every link in the Payload (CLAUDE.md → Output shape) green.
**Verify at any time:** `bash execution/probe_links.sh` (credential-free links) +
the GitHub Actions run list (worker links).

## Current live topology (verified 2026-07-06)

```
buyerdb.netlify.app  ──(PostgREST RPC, anon key, RLS)──▶  Supabase "Skyline"
   React, RPC-mode bundle                                hvsvxjdwfbsqaqlmuwlt
   Deals/Buyers/Leaderboards/Review live                 4,099 deals loaded
                                                            ▲
GitHub Actions crons ────── RED: no DATABASE_URL secret ────┘
FastAPI backend (uploads/merges/AI Deal Desk) ── RED: not hosted yet
```

## Red link 1 — worker `DATABASE_URL` secret (user action, ~2 min)

1. Supabase dashboard → project **Skyline** → **Connect** button (top bar) →
   copy the **Session pooler** URI (`postgresql://postgres.hvsvxjdwfbsqaqlmuwlt:…@aws-0-us-east-1.pooler.supabase.com:5432/postgres`).
   ⚠️ Not the direct `db.hvsvxjdwfbsqaqlmuwlt.supabase.co` host — it is IPv6-only and
   unreachable from Actions runners (this exact failure is in run 28824659351's log).
2. GitHub → `rubbik26-commits/buyerDB` → Settings → Secrets and variables → Actions →
   **New repository secret** → name `DATABASE_URL`, value = the pooler URI.
3. Optional same screen: `SOCRATA_APP_TOKEN` (lifts anonymous throttle),
   `ALERT_WEBHOOK_URL` (failure pings), `SCRAPERAPI_KEY` (scraper fallback).
4. Verify: Actions tab → `daily-incremental` → **Run workflow** → must end green.

## Red link 2 — FastAPI backend on Render (user action + assistant follow-up)

1. render.com → **New → Blueprint** → connect `rubbik26-commits/buyerDB`.
   `render.yaml` at repo root defines service `skyline-api` (free plan, Python 3.12,
   rootDir `skyline`).
2. When prompted for env vars: `DATABASE_URL` = the same session-pooler URI;
   `FRONTEND_URL` = `https://buyerdb.netlify.app`; `GROQ_API_KEY` optional (free at
   console.groq.com — enables the AI Deal Desk's tool lane).
3. Verify: `curl https://skyline-api.onrender.com/api/health` → 200.
4. Then flip the frontend to the full backend: Netlify site `buyerdb` →
   Environment variables → set `VITE_API_URL` to the Render URL → redeploy.
   (Until then the bundle stays in RPC mode — data tabs keep working either way.)

## Edge cases / lessons

- Free Render services sleep after idle; first request takes ~30s. Acceptable, or
  upgrade the plan.
- Supabase free tier pauses after 7 idle days; the daily cron's writes prevent this
  once red link 1 is fixed — until then, occasional dashboard visits keep it awake.
- The anon key in the client bundle is public **by design**; RLS + SECURITY DEFINER
  `api_*` functions are the security boundary. Never put the `service_role` key
  anywhere client-side or in the frontend build env.
