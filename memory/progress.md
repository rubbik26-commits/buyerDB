# Progress Log

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

## Blocked on (user)
1. Set the `DATABASE_URL` repo secret (Supabase session pooler string) so the worker crons go green.
2. Backend host decision + credentials (Render/Railway/Fly) for the FastAPI layer.
3. Optional: AI provider key(s), Socrata app token, alert webhook.
