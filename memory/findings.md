# Findings — research, discoveries, constraints

## 2026-07-06 — Repo survey (Protocol 0 / Phase B research pass)

### This is not a greenfield repo
`buyerDB` already contains **Skyline Deal Intelligence**, a four-part production system
(built ~2026-07-02) living in `skyline/`:

- `skyline/frontend/` — React 18 + Vite, four tabs (Deals, Buyers, Leaderboards, Agent Desk)
- `skyline/backend/` — FastAPI: `/api/deals /buyers /leaderboards /agent /uploads /review`,
  AI provider router with failover (Groq → Gemini → OpenRouter → Cloudflare → Anthropic/OpenAI)
- `skyline/worker/` — Python scraper/enrichment pipeline (traded.co via curl_cffi, ACRIS/PLUTO via Socrata)
- `skyline/database/` — 4 numbered SQL migrations + seeds (Supabase-targeted; RLS + REST RPC migrations present)
- `.github/workflows/` — `daily-incremental.yml` (13:17 UTC), `weekly-enrichment.yml` (Sun 11:43), `ci.yml`
- `SKYLINE_MASTER_BLUEPRINT.md` — 43 KB verified architecture document; effectively a completed
  Blueprint for the existing system. Reuse, don't re-derive.

### Canonical dataset
`NEW_YORK_CLOSED_ENRICHED_v8.csv` (repo root and duplicated in `skyline/`):
**4,129 rows × 27 columns.** Fill rates (verified in blueprint): Buyer 79%, Seller 78%,
addresses 65%, phone/email ~2%, price 93%. Sources: ACRIS 2,482 / traded 964 / crexi 594 / other 89.
372 rows `needs_review`. Plus `exclusion_ledger_additions_2026-07-02.csv` (deed-verified condo exclusions).

### Hard-won invariants already encoded (must survive any new build)
1. **Amount gate** — ACRIS party attaches only if deed amount within 3% of price
   (or no-price + ≤60d). DB CHECK `acris_requires_gate` makes ungated rows impossible.
   Root cause: a documented 34/34 wrong-party failure from address+date-only matching.
2. **No residential** — condo/co-op/1–2-family rejected by DB CHECK + building-class gate.
3. **Ledgers are durable tables** (`fetch_ledger`, `exclusion_ledger`, `rolling_ledger`) —
   a lost pickle file once silently re-admitted excluded condos.
4. **Never overwrite non-null; conflicts → `review_queue`**, never auto-resolved.
5. **Contacts render only from `contacts` rows** — the agent never invents a phone/email.
6. **No uploaded contact data to Gemini free tier** (may train on prompts).

### Transport/infra constraints (verified in blueprint 2026-07-02)
- traded.co Cloudflare blocks python-requests but passes **curl_cffi** Chrome impersonation →
  worker must stay Python (GitHub Actions runner works, $0). JS/Deno hosts need ScraperAPI (~11 credits/page).
- GitHub Actions cron: best-effort timing, schedule at odd minutes, keep-alive commit defeats
  the 60-day auto-disable.
- Supabase free tier pauses after 7 idle days; Pro ($25/mo) recommended for backups.
- The original Claude-artifact `callClaude` only works inside claude.ai's proxy → backend is mandatory.

### Session environment (this Claude Code session)
MCP connectors available: **Supabase, Netlify, Apollo.io, Base44, GitHub, Wix, Canva, Adobe** —
Supabase + Netlify + GitHub map directly onto the deploy targets; Apollo.io could close the
2% phone/email gap (contact enrichment) — a possible Phase B integration, needs user confirmation
and credit-budget decision. Base44 was the earlier alternative host (blueprint §3 keeps it fallback-only).

### Open questions (feed into Phase B discovery)
- Is a Supabase project already provisioned/loaded, or does the CSV remain the only source of truth?
- Is anything currently deployed (Netlify site, Render service), or is this repo the whole state?
- What does "buyerDB" mean to the user beyond the existing system — a new deliverable
  (e.g. buyer-matching outreach engine, Apollo-enriched contact DB) or productionizing what exists?
