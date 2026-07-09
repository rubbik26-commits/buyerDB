#!/usr/bin/env bash
# Exact production deploy window from CLAUDE.md D-011 and architecture/SOP-daily-refresh.md.
#
# This script does NOT change scraper logic. It applies the already-reviewed SQL
# hardening migration and deploys the already-staged Supabase Edge Function
# sources verbatim from skyline/supabase/functions/.
#
# Required local tools:
#   supabase CLI authenticated to the Skyline project
#   psql
#   curl
#
# Required env vars:
#   SUPABASE_PROJECT_REF=hvsvxjdwfbsqaqlmuwlt
#   DATABASE_URL=<Supabase Postgres/session-pooler connection string>
#   SUPABASE_URL=https://hvsvxjdwfbsqaqlmuwlt.supabase.co
#   SUPABASE_ANON_KEY=<public anon key>
#   SYNC_SECRET=<app_config.sync_secret value>
#
# Optional env vars:
#   ACRIS_SECRET=<app_config.dealflow_secret value, only if invoking acris-v2 directly>
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${SUPABASE_PROJECT_REF:=hvsvxjdwfbsqaqlmuwlt}"
: "${SUPABASE_URL:=https://hvsvxjdwfbsqaqlmuwlt.supabase.co}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"
: "${SYNC_SECRET:?SYNC_SECRET is required}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}
need psql
need curl
need supabase

log() { printf '\n==> %s\n' "$*"; }

log "Preflight: required files exist"
for f in \
  skyline/database/migrations/009_hardening.sql \
  skyline/supabase/functions/_shared/mod.ts \
  skyline/supabase/functions/acris-v2/index.ts \
  skyline/supabase/functions/traded-daily/index.ts \
  skyline/supabase/functions/crexi-run/index.ts \
  skyline/supabase/functions/crexi-ingest/index.ts \
  skyline/supabase/functions/dos-enrich/index.ts \
  skyline/supabase/functions/skyline-sync/index.ts; do
  test -f "$f" || { echo "Missing $f" >&2; exit 1; }
done

log "Preflight: current DB shape"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "select api_health();"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "select count(*) as deals_before from deals;"

log "Apply migration 009_hardening.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -f skyline/database/migrations/009_hardening.sql

log "Verify 009 landed"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X <<'SQL'
select
  pg_get_functiondef('sync_upsert_deals(jsonb)'::regprocedure) like '%conflicts_flagged%' as sync_v3_has_conflict_counter,
  pg_get_functiondef('sync_upsert_deals(jsonb)'::regprocedure) like '%pg_advisory_xact_lock%' as sync_v3_has_lock,
  pg_get_functiondef('sync_upsert_deals(jsonb)'::regprocedure) like '%deed_amount%' as sync_v3_has_deed_amount_gate;
select has_function_privilege('anon', 'api_review_act(uuid,text,text)', 'EXECUTE') as anon_can_review_act_should_be_false;
SQL

log "Deploy six staged Supabase Edge Functions verbatim"
supabase functions deploy acris-v2      --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
supabase functions deploy traded-daily  --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
supabase functions deploy crexi-run     --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
supabase functions deploy crexi-ingest  --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
supabase functions deploy dos-enrich    --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
supabase functions deploy skyline-sync  --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt

log "Invoke skyline-sync once, then again for idempotency"
for i in 1 2; do
  echo "-- skyline-sync run $i"
  curl -fsS -X POST "$SUPABASE_URL/functions/v1/skyline-sync" \
    -H 'Content-Type: application/json' \
    -d "{\"secret\":\"${SYNC_SECRET}\"}" | tee "/tmp/skyline-sync-${i}.json"
  echo
done

log "Verify site-facing RPC health and core counts"
curl -fsS -X POST "$SUPABASE_URL/rest/v1/rpc/api_health" \
  -H 'Content-Type: application/json' \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{}'
echo

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X <<'SQL'
select count(*) as deals_after from deals;
select property_id, sale_price, sale_date, count(*)
from deals
group by property_id, sale_price, sale_date
having count(*) > 1
order by count(*) desc
limit 20;
select jobname, schedule, active from cron.job order by jobname;
SQL

log "Done. Next manual checks: buyerdb.netlify.app Buyers tab counts, Scrapers tab run ledger, cron.job_run_details statuses."
