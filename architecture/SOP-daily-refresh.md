# SOP — Daily data refresh (the REAL architecture, verified 2026-07-06)

**Goal:** buyerdb.netlify.app always shows yesterday's new NYC CRE deals without
anyone touching anything.

## ⚡ 2026-07-06 (late): Base44 removal in progress — cutover state

User directive: Base44 is NOT part of this system. Cutover to direct
Supabase writes, status:

| Piece | State |
|---|---|
| Base44 Contact enrichment (phones/emails/key persons/mailing) | ✅ HARVESTED into Supabase: 1,521 contacts + 4,457 entity mailing addresses (migration 007) |
| acris-v2 | ✅ REWRITTEN + deployed + tested: writes via `sync_upsert_deals()`, secret from app_config |
| traded-daily | ✅ REWRITTEN + deployed + tested: dedupe reads Supabase shortcodes; `body.maxFetches` caps spend |
| crexi-ingest / crexi-run / dos-enrich | 🟡 REWRITES STAGED in `skyline/supabase/functions/` — deploy blocked by an MCP tool-approval prompt; deploy verbatim when cleared |
| pipeline-reconcile, llm-enrich | 🟡 still scheduled — retire (cron.unschedule jobs 4, 8) ONLY after crexi-ingest rewrite is live |
| skyline-sync (Base44→Supabase bridge, job 9) | 🟡 KEEP until crexi-ingest rewrite is live (it still ferries crexi/Base44 output); then unschedule + delete function |
| ScraperAPI | ❌ 0 credits left (6,869/1,000 used; resets ~Jul 24) — traded.co discovery silently returns 0 until reset/upgrade, or re-arm the free curl_cffi GitHub-Actions worker |
| llm-enrich replacement | ⏸ parked — it used Base44's InvokeLLM (web-grounded Gemini). Needs an AI provider key (Phase B: none supplied yet) to rebuild off-Base44 |

Decommission checklist (in order): deploy 3 staged functions → invoke each once,
verify `errors:0` → `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN
('dealflow-reconcile-daily','dealflow-llm-enrich-daily','skyline-sync-daily')` →
delete functions skyline-sync, pipeline-reconcile, llm-enrich, acris-daily,
acris-window, traded-fetch-probe → rotate the Base44 API key (it is burned into
old function versions) → Base44 app becomes an archive.

## How data actually flows (target architecture after cutover)

```
pg_cron (Supabase)                              all times UTC
  05:00/05:50 Sun  crexi-run / crexi-ingest ─┐
  06:00  acris-v2 (deed pulls, class gates)  ├─▶  sync_upsert_deals()  ─▶ deals/
  06:12  traded-daily                        │    (single invariant     properties/
  06:50  dos-enrich (NYS registry)          ─┘     write path in SQL)   entities/
                                                                        deal_parties/
                                                                        contacts
                                              │ PostgREST RPC (api_*, anon key, RLS)
                                              ▼
                                     buyerdb.netlify.app
```

## Legacy data flow (pre-cutover, for reference)

```
pg_cron (Supabase)                              all times UTC
  05:00/05:50 Sun  crexi-run / crexi-ingest ─┐
  06:00  acris-v2 (deed pulls, class gates)  ├─▶  Base44 app "dealflow"
  06:12  traded-daily                        │    (Deal / Contact entities)
  06:30  pipeline-reconcile (merge/dedupe)   │
  06:50  dos-enrich   07:10  llm-enrich     ─┘
  07:40  skyline-sync ──── Base44 Deals ──▶ Supabase deals/properties/entities/
                                            deal_parties/contacts  (invariant-gated)
                                              │ PostgREST RPC (api_*, anon key, RLS)
                                              ▼
                                     buyerdb.netlify.app
```

- **skyline-sync** (edge function, `skyline/supabase/functions/skyline-sync/`) pages
  Base44 `Deal` entities and calls `sync_upsert_deals()` (migrations 005/006).
- Invariants enforced in the SQL function: residential/condo types skipped
  (`Condo`, `Commercial Condo`, `Co-op`, `Single Family`), dedupe by shortcode AND by
  property+price(+date-or-unknown), properties fill nulls only, parties carry
  source + provenance (`amount_gate_passed=true` for deed-native ACRIS parties),
  contacts only from real source rows (`source='base44:sync'`).
- Secrets: `app_config` table (RLS, no policies) holds `base44_app_id`,
  `base44_api_key`, `sync_secret`. Nothing in git; the cron job reads the secret
  from `app_config` at fire time.

## Verify (any time)

```bash
# 1. sync health + last run stats
curl -s -X POST https://hvsvxjdwfbsqaqlmuwlt.supabase.co/functions/v1/skyline-sync \
  -H 'Content-Type: application/json' -d '{"secret":"<app_config.sync_secret>"}'
# expect: {"ok":true, "errors":0, ...}; run twice → second run inserted:0 (idempotent)

# 2. site-facing count
bash execution/probe_links.sh          # supabase-rpc-health / netlify / socrata

# 3. cron trail
# SELECT jobname,status,start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
```

## Edge cases & lessons (self-annealing log)

- **2026-07-06 — 143 duplicate deals on first sync.** Junk source dates ("December 1",
  `2026-6-8`) nulled by a strict client validator bypassed the addr+price+date dedupe.
  Fix in BOTH layers: client normalizes unpadded dates instead of discarding
  (isoDate), SQL treats property+price with either date unknown as duplicate
  (migration 006). Cleanup deleted the 126 residual dup rows. Full table now has
  0 duplicate (property, price, date) groups.
- Base44 holds condo/commercial-condo rows (~173) by design; the sync intentionally
  skips them — the Skyline DB CHECK would reject them anyway.
- `cron.job_run_details` "succeeded" only proves the HTTP POST was queued;
  check `net._http_response` status codes and table deltas for the truth.

## Legacy / parallel paths

- **GitHub Actions workflows** (`daily-incremental`, `weekly-enrichment`,
  `load-database`) are the older Python-worker refresh path. They fail-fast without
  a `DATABASE_URL` repo secret and are NOT required for the daily refresh anymore.
  Either leave them red (harmless, noisy) or disable the schedules; re-arm only if
  the curl_cffi scraping path (traded.co Cloudflare bypass) becomes needed again.
- **⚠️ SECURITY DEBT:** the older dealflow edge functions (acris-v2, traded-daily,
  pipeline-reconcile, …) contain a **hardcoded Base44 API key + cron secret in
  source** — flagged in SKYLINE_MASTER_BLUEPRINT §7 since 2026-07-02. Rotate the
  Base44 key in the Base44 dashboard, update `app_config.base44_api_key`
  (skyline-sync picks it up automatically), and redeploy the older functions to
  read from `app_config` too.
