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
  (select count(*) from public.sbi_contacts where nullif(btrim(phone),'') is not null) as contact_phones,
  (select count(*) from public.sbi_contacts where nullif(btrim(email),'') is not null) as contact_emails,
  (select count(*) from public.sbi_contacts where nullif(btrim(website),'') is not null) as contact_websites,
  (select count(*) from public.sbi_contacts where nullif(btrim(mailing_address),'') is not null) as contact_mailing_addresses,
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
  ('public.api_delete_view(uuid,text)'),
  ('public.api_import_canonical_contacts(int,int)'),
  ('public.api_dedupe_canonical_contacts()'),
  ('public.api_rank_primary_contacts()'),
  ('public.api_seed_canonical_csv_rows(jsonb)'),
  ('public.api_seed_from_github_csv(int,int)')
) x(fn);

\echo '== hard invariants =='
with checks as (
  select 'duplicate_property_price_date' as check_name, count(*)::bigint as failures
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
  select 'factless_canonical_seed_rows', count(*)
  from public.sbi_deals d
  where d.provenance->>'loader'='api_seed_canonical_csv_rows'
    and d.shortcode is null
    and d.source_url is null
    and d.sale_date is null
    and d.sale_price is null
    and d.asset_type is null
    and not exists(select 1 from public.sbi_deal_parties dp where dp.deal_id=d.deal_id)
  union all
  select 'running_source_runs_over_1h', count(*)
  from public.sbi_source_runs
  where status='running' and started_at < now() - interval '1 hour'
  union all
  select 'orphan_contacts', count(*)
  from public.sbi_contacts c
  left join public.sbi_entities e using(entity_id)
  where e.entity_id is null
  union all
  select 'entities_with_multiple_primary_contacts', count(*)
  from (
    select entity_id
    from public.sbi_contacts
    where is_primary is true
    group by entity_id
    having count(*) > 1
  ) x
  union all
  select 'normalized_duplicate_contacts', count(*)
  from (
    select entity_id, role, source,
      public.sbi_norm_contact_phone(phone),
      public.sbi_norm_contact_email(email),
      public.sbi_norm_contact_website(website),
      public.sbi_norm_contact_address(mailing_address)
    from public.sbi_contacts
    group by 1,2,3,4,5,6,7
    having count(*) > 1
  ) x
  union all
  select 'placeholder_contact_entities', count(*)
  from public.sbi_contacts c
  join public.sbi_entities e using(entity_id)
  where lower(btrim(e.display_name)) ~
    '^(unknown|n/?a|not\s+specified|not\s+provided|not\s+disclosed|not\s+found|undisclosed|confidential|withheld|anonymous|private\s+investor|various|multiple|null|undefined|none|no\s+name|tbd|tba|-+|\*+)$'
  union all
  select 'public_contact_maintenance_rpc_grants', count(*)
  from (values
    ('public.api_import_canonical_contacts(integer,integer)'),
    ('public.api_dedupe_canonical_contacts()'),
    ('public.api_rank_primary_contacts()'),
    ('public.sbi_import_canonical_contact(text,text,text,text,text,text,text,text)')
  ) f(signature)
  where has_function_privilege('anon',signature,'EXECUTE')
     or has_function_privilege('authenticated',signature,'EXECUTE')
  union all
  select 'public_canonical_seed_rpc_grants', count(*)
  from (values
    ('public.api_seed_canonical_csv_rows(jsonb)'),
    ('public.api_seed_canonical_csv_rows_unfiltered(jsonb)'),
    ('public.api_seed_from_github_csv(integer,integer)')
  ) f(signature)
  where has_function_privilege('anon',signature,'EXECUTE')
     or has_function_privilege('authenticated',signature,'EXECUTE')
)
select * from checks order by check_name;

\echo '== enforce zero-failure invariants =='
do $$
declare failures bigint;
begin
  select count(*) into failures from (
    select 1 from (
      select property_id,sale_price,sale_date,count(*)
      from public.sbi_deals group by 1,2,3 having count(*)>1
    ) d
    union all
    select 1 from public.sbi_deal_parties dp
      where dp.source_system='acris' and dp.role in ('buyer','seller')
        and coalesce(dp.amount_gate_passed,false) is not true
    union all
    select 1 from public.sbi_deals
      where asset_type in ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family')
    union all
    select 1 from public.sbi_deals d
      where d.provenance->>'loader'='api_seed_canonical_csv_rows'
        and d.shortcode is null and d.source_url is null and d.sale_date is null
        and d.sale_price is null and d.asset_type is null
        and not exists(select 1 from public.sbi_deal_parties dp where dp.deal_id=d.deal_id)
    union all
    select 1 from public.sbi_contacts c left join public.sbi_entities e using(entity_id)
      where e.entity_id is null
    union all
    select 1 from (
      select entity_id from public.sbi_contacts where is_primary is true
      group by entity_id having count(*)>1
    ) p
    union all
    select 1 from (
      select entity_id,role,source,
        public.sbi_norm_contact_phone(phone),public.sbi_norm_contact_email(email),
        public.sbi_norm_contact_website(website),public.sbi_norm_contact_address(mailing_address)
      from public.sbi_contacts group by 1,2,3,4,5,6,7 having count(*)>1
    ) c
  ) all_failures;
  if failures <> 0 then
    raise exception 'live SBI invariant verification failed: % failing rows/groups', failures;
  end if;

  if has_function_privilege('anon','public.api_import_canonical_contacts(integer,integer)','EXECUTE')
     or has_function_privilege('authenticated','public.api_import_canonical_contacts(integer,integer)','EXECUTE')
     or has_function_privilege('anon','public.api_dedupe_canonical_contacts()','EXECUTE')
     or has_function_privilege('authenticated','public.api_dedupe_canonical_contacts()','EXECUTE')
     or has_function_privilege('anon','public.api_rank_primary_contacts()','EXECUTE')
     or has_function_privilege('authenticated','public.api_rank_primary_contacts()','EXECUTE')
  then
    raise exception 'canonical contact maintenance RPCs are publicly executable';
  end if;

  if has_function_privilege('anon','public.api_seed_canonical_csv_rows(jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.api_seed_canonical_csv_rows(jsonb)','EXECUTE')
     or has_function_privilege('anon','public.api_seed_canonical_csv_rows_unfiltered(jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.api_seed_canonical_csv_rows_unfiltered(jsonb)','EXECUTE')
     or has_function_privilege('anon','public.api_seed_from_github_csv(integer,integer)','EXECUTE')
     or has_function_privilege('authenticated','public.api_seed_from_github_csv(integer,integer)','EXECUTE')
  then
    raise exception 'canonical seed RPCs are publicly executable';
  end if;
end;
$$;

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
select public.api_contact_search('Townhouse Rental II',10) as contact_search_smoke;
SQL

curl -fsS -X POST "$SUPABASE_URL/rest/v1/rpc/api_health" \
  -H 'Content-Type: application/json' \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{}'
echo
