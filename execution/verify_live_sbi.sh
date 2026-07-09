#!/usr/bin/env bash
# Live production verification for the current Supabase SBI deployment.
# This does not rewrite scraper logic and does not apply migrations. It proves the
# deployed database contract that buyerdb.netlify.app reads through Supabase RPC.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SUPABASE_URL:=https://pdvyuepsdnpxctmagdcq.supabase.co}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X <<'SQL'
\echo '== live sbi totals =='
select
  (select count(*) from public.sbi_deals) as sbi_deals,
  (select count(*) from public.sbi_properties) as sbi_properties,
  (select count(*) from public.sbi_entities) as sbi_entities,
  (select count(*) from public.sbi_deal_parties) as sbi_deal_parties,
  (select count(*) from public.sbi_contacts) as sbi_contacts,
  (select count(*) from public.sbi_review_queue where status='open') as open_reviews,
  (select count(*) from public.sbi_source_runs) as source_runs;

\echo '== required live rpc functions =='
select fn, to_regprocedure(fn) is not null as exists
from (values
  ('public.api_health()'),
  ('public.api_meta()'),
  ('public.api_deals(text,text,text,text,numeric,numeric,date,date,int,int,int,int,numeric,int,text,boolean,text,text,int,int)'),
  ('public.api_buyers(text,text,numeric,numeric,date,int,text,int)'),
  ('public.api_request_scrape(text,text,jsonb)'),
  ('public.api_scraper_runs(int)'),
  ('public.api_workbench()'),
  ('public.api_upload_stage(text,text,jsonb,jsonb,jsonb)'),
  ('public.api_upload_resolve(uuid,jsonb,text)'),
  ('public.api_contact_search(text,int)'),
  ('public.api_recent_deals(text,int)'),
  ('public.api_saved_views(text,text)'),
  ('public.api_save_view(text,text,text,jsonb,jsonb)'),
  ('public.api_delete_view(uuid,text)')
) x(fn);

\echo '== hard invariants =='
select 'duplicate_property_price_date' as check_name, count(*) as failures
from (
  select property_id, sale_price, sale_date, count(*)
  from public.sbi_deals
  group by property_id, sale_price, sale_date
  having count(*) > 1
) x
union all
select 'acris_parties_without_amount_gate', count(*)
from public.sbi_deal_parties dp
join public.sbi_deals d using (deal_id)
where dp.source_system='acris'
  and dp.role in ('buyer','seller')
  and coalesce(dp.amount_gate_passed,false) is not true
union all
select 'banned_asset_types', count(*)
from public.sbi_deals
where asset_type in ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family')
union all
select 'running_source_runs_over_1h', count(*)
from public.sbi_source_runs
where status='running' and started_at < now() - interval '1 hour';

\echo '== source run status =='
select job, status, count(*)
from public.sbi_source_runs
group by job,status
order by job,status;

\echo '== public rpc smoke =='
select public.api_health() as api_health;
select jsonb_array_length(public.api_deals(per_page => 5)->'deals') as deals_sample_rows;
select jsonb_array_length(public.api_buyers(lim => 5)->'buyers') as buyer_sample_rows;
select public.api_saved_views('broker','deals') as saved_views_smoke;
SQL

curl -fsS -X POST "$SUPABASE_URL/rest/v1/rpc/api_health" \
  -H 'Content-Type: application/json' \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{}'
echo
