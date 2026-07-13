-- 027_canonical_seed_guard_and_security.sql
-- Prevent parser fragments/factless rows from entering the canonical deal ledger and
-- make canonical seeding a service-role-only maintenance operation.

do $$
begin
  if to_regprocedure('public.api_seed_canonical_csv_rows_unfiltered(jsonb)') is null then
    execute 'alter function public.api_seed_canonical_csv_rows(jsonb) rename to api_seed_canonical_csv_rows_unfiltered';
  end if;
end;
$$;

create or replace function public.api_seed_canonical_csv_rows(rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public as $$
declare
  filtered_rows jsonb := '[]'::jsonb;
  skipped_factless integer := 0;
  result jsonb;
begin
  if jsonb_typeof(rows) <> 'array' then
    raise exception 'rows must be a JSON array';
  end if;

  select
    coalesce(jsonb_agg(r) filter (where not factless), '[]'::jsonb),
    count(*) filter (where factless)
  into filtered_rows, skipped_factless
  from (
    select value as r,
      (
        nullif(btrim(value->>'Shortcode'),'') is null and
        nullif(btrim(value->>'Source URL'),'') is null and
        nullif(btrim(value->>'sale_date_iso'),'') is null and
        nullif(btrim(value->>'Sale Date'),'') is null and
        nullif(btrim(value->>'Sale Price'),'') is null and
        nullif(btrim(value->>'Buyer'),'') is null and
        nullif(btrim(value->>'Seller'),'') is null and
        nullif(btrim(value->>'Asset Type'),'') is null
      ) as factless
    from jsonb_array_elements(rows)
  ) source_rows;

  result := public.api_seed_canonical_csv_rows_unfiltered(filtered_rows);
  return coalesce(result,'{}'::jsonb) || jsonb_build_object('skipped_factless',skipped_factless);
end;
$$;

revoke all on function public.api_seed_canonical_csv_rows(jsonb) from public,anon,authenticated;
revoke all on function public.api_seed_canonical_csv_rows_unfiltered(jsonb) from public,anon,authenticated;
revoke all on function public.api_seed_from_github_csv(integer,integer) from public,anon,authenticated;
grant execute on function public.api_seed_canonical_csv_rows(jsonb) to service_role;
grant execute on function public.api_seed_from_github_csv(integer,integer) to service_role;

-- Clean only rows that are provably parser fragments: canonical-seed provenance,
-- no transaction facts, no source identifiers, and no parties. Preserve an audit hash.
with malformed as (
  select d.deal_id,d.property_id,p.address_norm,d.sale_price,
         md5(coalesce(p.address_norm,'')||'|'||coalesce(p.borough,'')||'|'||
             coalesce(d.sale_price::text,'')||'|'||coalesce(d.sale_date::text,'')) as audit_hash
  from public.sbi_deals d
  join public.sbi_properties p using(property_id)
  where d.provenance->>'loader'='api_seed_canonical_csv_rows'
    and d.shortcode is null
    and d.source_url is null
    and d.sale_date is null
    and d.sale_price is null
    and d.asset_type is null
    and not exists(select 1 from public.sbi_deal_parties dp where dp.deal_id=d.deal_id)
), ledgered as (
  insert into public.sbi_exclusion_ledger(addr_norm,price,reason,evidence,source)
  select m.address_norm,m.sale_price,'malformed_seed_row',m.audit_hash,'canonical_seed_audit'
  from malformed m
  where not exists(
    select 1 from public.sbi_exclusion_ledger x
    where x.reason='malformed_seed_row' and x.evidence=m.audit_hash
  )
  returning 1
), deleted_deals as (
  delete from public.sbi_deals d
  using malformed m
  where d.deal_id=m.deal_id
  returning d.property_id
)
delete from public.sbi_properties p
where p.property_id in (select property_id from deleted_deals)
  and not exists(select 1 from public.sbi_deals d where d.property_id=p.property_id);

notify pgrst,'reload schema';
