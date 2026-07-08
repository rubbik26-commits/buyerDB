-- 014_live_agent_support_rpc.sql
-- Read-only support functions for the live Deal Desk fallback in Supabase RPC mode.

create or replace function api_contact_search(q text default null, lim int default 10) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('matches', coalesce((
    select jsonb_agg(jsonb_build_object(
      'entity_id', e.entity_id,
      'name', e.display_name,
      'entity_type', e.entity_type,
      'mailing_address', e.mailing_address,
      'contacts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'contact_id', c.contact_id,
          'person_name', c.person_name,
          'phone', c.phone,
          'email', c.email,
          'source', c.source,
          'mailing_address', c.mailing_address
        ) order by c.is_primary desc nulls last, c.created_at desc)
        from sbi_contacts c where c.entity_id=e.entity_id
      ), '[]'::jsonb)
    ) order by e.display_name)
    from sbi_entities e
    where api_contact_search.q is null or api_contact_search.q='' or e.display_name ilike '%'||api_contact_search.q||'%' or e.norm_name ilike '%'||upper(api_contact_search.q)||'%'
    limit least(greatest(api_contact_search.lim,1),50)
  ), '[]'::jsonb));
$$;

create or replace function api_recent_deals(q text default null, lim int default 10) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('deals', coalesce((
    select jsonb_agg(jsonb_build_object(
      'deal_id', d.deal_id,
      'sale_date', d.sale_date,
      'address', p.address_raw,
      'borough', p.borough,
      'market', p.market,
      'asset_type', d.asset_type,
      'sale_price', d.sale_price,
      'buyer', b.display_name,
      'seller', s.display_name,
      'source_url', d.source_url
    ) order by d.sale_date desc nulls last, d.created_at desc)
    from sbi_deals d
    join sbi_properties p using(property_id)
    left join lateral (select e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='buyer' limit 1) b on true
    left join lateral (select e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='seller' limit 1) s on true
    where api_recent_deals.q is null or api_recent_deals.q='' or p.address_raw ilike '%'||api_recent_deals.q||'%' or b.display_name ilike '%'||api_recent_deals.q||'%' or s.display_name ilike '%'||api_recent_deals.q||'%'
    limit least(greatest(api_recent_deals.lim,1),50)
  ), '[]'::jsonb));
$$;

grant execute on function api_contact_search(text,int), api_recent_deals(text,int) to anon;
notify pgrst, 'reload schema';
