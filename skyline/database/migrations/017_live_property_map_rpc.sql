-- 017_live_property_map_rpc.sql
-- Map feed for the Buyer Intelligence OS using actual property coordinates.

create or replace function api_property_map(lim int default 1000) returns jsonb
language sql stable security definer set search_path=public as $$
  with latest as (
    select distinct on (p.property_id)
      p.property_id,
      p.address_raw as address,
      p.borough,
      p.market,
      p.bbl,
      p.latitude,
      p.longitude,
      d.deal_id,
      d.sale_date,
      d.asset_type,
      d.sale_price,
      b.entity_id as buyer_entity_id,
      b.display_name as buyer,
      s.display_name as seller
    from sbi_properties p
    left join sbi_deals d on d.property_id=p.property_id
    left join lateral (
      select e.entity_id, e.display_name
      from sbi_deal_parties dp join sbi_entities e using(entity_id)
      where dp.deal_id=d.deal_id and dp.role='buyer'
      limit 1
    ) b on true
    left join lateral (
      select e.display_name
      from sbi_deal_parties dp join sbi_entities e using(entity_id)
      where dp.deal_id=d.deal_id and dp.role='seller'
      limit 1
    ) s on true
    where p.latitude is not null and p.longitude is not null
    order by p.property_id, d.sale_date desc nulls last, d.created_at desc nulls last
  )
  select jsonb_build_object(
    'points', coalesce((select jsonb_agg(to_jsonb(x) order by sale_price desc nulls last) from (select * from latest limit least(greatest(api_property_map.lim,1),5000)) x), '[]'::jsonb),
    'count', (select count(*) from latest)
  );
$$;

grant execute on function api_property_map(int) to anon;
notify pgrst, 'reload schema';
