-- 022_blueprint_enrichment_and_agent_tools.sql
-- Applied to production on 2026-07-10.

create or replace function public.sbi_rolling_targets(lim int default 400)
returns table(deal_id uuid,address_raw text,borough text,sqft int,units int)
language sql stable security definer set search_path=public as $$
  select d.deal_id,p.address_raw,p.borough,d.sqft,d.units
  from public.sbi_deals d join public.sbi_properties p using(property_id)
  where (d.sqft is null or d.units is null)
    and p.borough in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')
    and not exists(select 1 from public.sbi_rolling_ledger l where l.deal_id=d.deal_id)
  order by d.sale_date desc nulls last
  limit least(greatest(sbi_rolling_targets.lim,1),2000);
$$;

create or replace function public.sbi_rolling_apply(
  p_deal_id uuid,
  p_sqft int default null,
  p_units int default null,
  p_source_rows jsonb default '[]'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  v_sqft int;
  v_units int;
  v_filled text[]:='{}';
  v_conflicts text[]:='{}';
begin
  select sqft,units into v_sqft,v_units from public.sbi_deals where deal_id=p_deal_id;
  if not found then return jsonb_build_object('status','no_such_deal'); end if;
  if v_sqft is null and p_sqft is not null and p_sqft>0 then
    update public.sbi_deals set sqft=p_sqft,updated_at=now() where deal_id=p_deal_id and sqft is null;
    v_filled:=array_append(v_filled,'sqft');
  elsif v_sqft is not null and p_sqft is not null and p_sqft>0 and abs(p_sqft-v_sqft)::numeric/greatest(p_sqft,v_sqft)>0.20 then
    v_conflicts:=array_append(v_conflicts,'sqft');
  end if;
  if v_units is null and p_units is not null and p_units>0 then
    update public.sbi_deals set units=p_units,updated_at=now() where deal_id=p_deal_id and units is null;
    v_filled:=array_append(v_filled,'units');
  elsif v_units is not null and p_units is not null and p_units>0 and abs(p_units-v_units)::numeric/greatest(p_units,v_units)>0.20 then
    v_conflicts:=array_append(v_conflicts,'units');
  end if;
  if cardinality(v_conflicts)>0 then
    update public.sbi_deals set parse_status='needs_review',record_quality='needs_review',updated_at=now() where deal_id=p_deal_id;
    perform public.sbi_queue_review('deal',p_deal_id::text,'rolling_sales_conflict',
      jsonb_build_object('fields',v_conflicts,'existing_sqft',v_sqft,'rolling_sqft',p_sqft,'existing_units',v_units,'rolling_units',p_units,'source_rows',p_source_rows));
  end if;
  insert into public.sbi_rolling_ledger(deal_id) values(p_deal_id) on conflict do nothing;
  update public.sbi_deals set
    notes=case when cardinality(v_filled)>0 and position('RollingSales(usep-8jbt)' in coalesce(notes,''))=0
      then trim(both ' |' from coalesce(notes,'')||' | RollingSales(usep-8jbt): '||array_to_string(v_filled,',')) else notes end
  where deal_id=p_deal_id;
  return jsonb_build_object('status','processed','filled',to_jsonb(v_filled),'conflicts',to_jsonb(v_conflicts));
end;
$$;

create or replace function public.sbi_phase2_targets(lim int default 400)
returns table(deal_id uuid,address_raw text,borough text,sale_price numeric,sale_date date,has_buyer boolean,has_seller boolean)
language sql stable security definer set search_path=public as $$
  select d.deal_id,p.address_raw,p.borough,d.sale_price,d.sale_date,
    exists(select 1 from public.sbi_deal_parties x where x.deal_id=d.deal_id and x.role='buyer'),
    exists(select 1 from public.sbi_deal_parties x where x.deal_id=d.deal_id and x.role='seller')
  from public.sbi_deals d join public.sbi_properties p using(property_id)
  where coalesce(d.source_system,'')<>'acris'
    and p.borough in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')
    and (not exists(select 1 from public.sbi_deal_parties x where x.deal_id=d.deal_id and x.role='buyer')
      or not exists(select 1 from public.sbi_deal_parties x where x.deal_id=d.deal_id and x.role='seller'))
  order by d.sale_date desc nulls last
  limit least(greatest(sbi_phase2_targets.lim,1),2000);
$$;

grant execute on function public.sbi_rolling_targets(int), public.sbi_rolling_apply(uuid,int,int,jsonb), public.sbi_phase2_targets(int) to service_role;

create or replace function public.api_buyers(
  borough text default null,
  asset_type text default null,
  price_min numeric default null,
  price_max numeric default null,
  date_min date default null,
  min_deals int default 1,
  rank_by text default 'count',
  lim int default 60
) returns jsonb language sql stable security definer set search_path=public as $$
  with g as (
    select e.entity_id,e.display_name as name,e.is_spv_suspect,count(distinct d.deal_id) as n,
      coalesce(sum(d.sale_price),0) as vol,max(d.sale_date) as last_deal,min(d.sale_price) as min_price,max(d.sale_price) as max_price,
      array_agg(distinct d.asset_type) filter(where d.asset_type is not null) as types,
      array_agg(distinct p.borough) filter(where p.borough is not null) as boroughs,
      exists(select 1 from public.sbi_contacts c where c.entity_id=e.entity_id and (c.phone is not null or c.email is not null)) as has_contact
    from public.sbi_deal_parties dp join public.sbi_entities e using(entity_id)
    join public.sbi_deals d using(deal_id) join public.sbi_properties p using(property_id)
    where dp.role='buyer'
      and (api_buyers.borough is null or api_buyers.borough='' or p.borough=api_buyers.borough)
      and (api_buyers.asset_type is null or api_buyers.asset_type='' or d.asset_type=api_buyers.asset_type)
      and (api_buyers.price_min is null or d.sale_price>=api_buyers.price_min)
      and (api_buyers.price_max is null or d.sale_price<=api_buyers.price_max)
      and (api_buyers.date_min is null or d.sale_date>=api_buyers.date_min)
    group by e.entity_id,e.display_name,e.is_spv_suspect
    having count(distinct d.deal_id)>=greatest(api_buyers.min_deals,1)
    order by case when api_buyers.rank_by in ('vol','volume') then coalesce(sum(d.sale_price),0) else count(distinct d.deal_id) end desc
    limit least(greatest(api_buyers.lim,1),200)
  )
  select jsonb_build_object('buyers',coalesce((select jsonb_agg(to_jsonb(g)) from g),'[]'::jsonb));
$$;

create or replace function public.api_similar_buyers(
  asset_type text default null,
  borough text default null,
  price numeric default null,
  keywords text[] default '{}',
  lim int default 15
) returns jsonb language sql stable security definer set search_path=public as $$
  with bd as (
    select e.entity_id,e.display_name,e.is_spv_suspect,d.deal_id,d.asset_type,p.borough,d.sale_price,d.sale_date,p.address_raw,p.market
    from public.sbi_deal_parties dp join public.sbi_entities e using(entity_id)
    join public.sbi_deals d using(deal_id) join public.sbi_properties p using(property_id)
    where dp.role='buyer'
  ), s as (
    select entity_id,display_name as name,is_spv_suspect,count(distinct deal_id) deal_count,
      coalesce(sum(sale_price),0) volume,max(sale_date) last_deal,
      sum(case when api_similar_buyers.asset_type is null or api_similar_buyers.asset_type='' then 0 when bd.asset_type=api_similar_buyers.asset_type then 3 else -2 end) asset_pts,
      sum(case when api_similar_buyers.borough is null or api_similar_buyers.borough='' then 0 when bd.borough=api_similar_buyers.borough then 2 else -1 end) borough_pts,
      sum(case when api_similar_buyers.price is null then 0 when bd.sale_price between api_similar_buyers.price*0.5 and api_similar_buyers.price*2 then 1 when bd.sale_price is not null then -1 else 0 end) price_pts,
      sum(case when cardinality(coalesce(api_similar_buyers.keywords,'{}'::text[]))=0 then 0 when exists(
        select 1 from unnest(api_similar_buyers.keywords) k
        where lower(coalesce(address_raw,'')||' '||coalesce(market,'')) like '%'||lower(k)||'%'
      ) then 2 else 0 end) keyword_pts
    from bd group by entity_id,display_name,is_spv_suspect
  ), ranked as (
    select s.*,
      asset_pts+borough_pts+price_pts+keyword_pts+0.5*least(deal_count,5)-case when is_spv_suspect then 3 else 0 end score,
      exists(select 1 from public.sbi_contacts c where c.entity_id=s.entity_id and (c.phone is not null or c.email is not null)) has_contact
    from s order by score desc,deal_count desc,volume desc limit least(greatest(lim,1),100)
  )
  select jsonb_build_object(
    'criteria',jsonb_build_object('asset_type',asset_type,'borough',borough,'price',price,'keywords',keywords),
    'candidates',coalesce((select jsonb_agg(to_jsonb(ranked) order by score desc,deal_count desc) from ranked),'[]'::jsonb)
  );
$$;

create or replace function public.api_last_interaction(q text, lim int default 5)
returns jsonb language sql stable security definer set search_path=public,extensions as $$
  with matches as (
    select e.entity_id,e.display_name as name,
      case when e.norm_name=public.sbi_norm_entity(q) then 1.0 else similarity(e.norm_name,public.sbi_norm_entity(q)) end score
    from public.sbi_entities e
    where e.norm_name=public.sbi_norm_entity(q) or similarity(e.norm_name,public.sbi_norm_entity(q))>0.45
    order by score desc limit 5
  )
  select jsonb_build_object('matches',coalesce((select jsonb_agg(jsonb_build_object(
    'entity_id',m.entity_id,'name',m.name,'match_score',m.score,
    'interactions',coalesce((select jsonb_agg(jsonb_build_object(
      'interaction_id',i.interaction_id,'channel',i.channel,'occurred_at',i.occurred_at,
      'subject',i.subject,'notes',i.notes,'outcome',i.outcome,'user_id',i.user_id
    ) order by i.occurred_at desc) from (
      select * from public.sbi_interactions z where z.entity_id=m.entity_id order by z.occurred_at desc limit least(greatest(lim,1),25)
    ) i),'[]'::jsonb)
  ) order by m.score desc) from matches m),'[]'::jsonb));
$$;

create or replace function public.api_entity_history(q text, party_role text default null, lim int default 100)
returns jsonb language sql stable security definer set search_path=public,extensions as $$
  with m as (
    select e.entity_id,e.display_name as name,
      case when e.norm_name=public.sbi_norm_entity(q) then 1.0 else similarity(e.norm_name,public.sbi_norm_entity(q)) end score
    from public.sbi_entities e
    where e.norm_name=public.sbi_norm_entity(q) or similarity(e.norm_name,public.sbi_norm_entity(q))>0.45
    order by score desc limit 1
  ), h as (
    select m.entity_id,m.name,m.score,dp.role,d.deal_id,d.shortcode,d.sale_date,p.address_raw as address,
      p.borough,p.market,d.asset_type,d.sale_price,d.units,d.sqft,d.source_system,d.source_url
    from m join public.sbi_deal_parties dp using(entity_id)
    join public.sbi_deals d using(deal_id) join public.sbi_properties p using(property_id)
    where party_role is null or party_role='' or dp.role=party_role
    order by d.sale_date desc nulls last limit least(greatest(lim,1),500)
  )
  select jsonb_build_object(
    'entity',coalesce((select jsonb_build_object('entity_id',entity_id,'name',name,'match_score',score) from m),'null'::jsonb),
    'deals',coalesce((select jsonb_agg(to_jsonb(h) order by sale_date desc nulls last) from h),'[]'::jsonb)
  );
$$;

create or replace function public.api_similar_sellers(asset_type text default null, borough text default null, lim int default 25)
returns jsonb language sql stable security definer set search_path=public as $$
  with s as (
    select e.entity_id,e.display_name as name,count(distinct d.deal_id) sales,coalesce(sum(d.sale_price),0) volume,max(d.sale_date) last_sale,
      exists(select 1 from public.sbi_contacts c where c.entity_id=e.entity_id and (c.phone is not null or c.email is not null)) has_contact
    from public.sbi_deal_parties dp join public.sbi_entities e using(entity_id)
    join public.sbi_deals d using(deal_id) join public.sbi_properties p using(property_id)
    where dp.role='seller'
      and (api_similar_sellers.asset_type is null or api_similar_sellers.asset_type='' or d.asset_type=api_similar_sellers.asset_type)
      and (api_similar_sellers.borough is null or api_similar_sellers.borough='' or p.borough=api_similar_sellers.borough)
    group by e.entity_id,e.display_name order by sales desc,volume desc limit least(greatest(lim,1),100)
  )
  select jsonb_build_object('sellers',coalesce((select jsonb_agg(to_jsonb(s)) from s),'[]'::jsonb));
$$;

create or replace function public.api_missing_contacts(asset_type text default null, borough text default null, min_deals int default 2, lim int default 50)
returns jsonb language sql stable security definer set search_path=public as $$
  with x as (
    select e.entity_id,e.display_name as name,count(distinct d.deal_id) deals,coalesce(sum(d.sale_price),0) volume,max(d.sale_date) last_deal
    from public.sbi_deal_parties dp join public.sbi_entities e using(entity_id)
    join public.sbi_deals d using(deal_id) join public.sbi_properties p using(property_id)
    where dp.role='buyer'
      and (api_missing_contacts.asset_type is null or api_missing_contacts.asset_type='' or d.asset_type=api_missing_contacts.asset_type)
      and (api_missing_contacts.borough is null or api_missing_contacts.borough='' or p.borough=api_missing_contacts.borough)
      and not exists(select 1 from public.sbi_contacts c where c.entity_id=e.entity_id and (c.phone is not null or c.email is not null))
    group by e.entity_id,e.display_name
    having count(distinct d.deal_id)>=greatest(min_deals,1)
    order by volume desc limit least(greatest(lim,1),200)
  )
  select jsonb_build_object('entities_missing_contact',coalesce((select jsonb_agg(to_jsonb(x)) from x),'[]'::jsonb));
$$;

create or replace function public.api_recent_changes(days int default 7, lim int default 50)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('days',days,'deals',coalesce((select jsonb_agg(to_jsonb(x) order by x.changed_at desc) from (
    select d.deal_id,d.shortcode,d.sale_date,p.address_raw as address,p.borough,d.asset_type,d.sale_price,
      d.source_system,d.source_url,greatest(d.created_at,d.updated_at) changed_at
    from public.sbi_deals d join public.sbi_properties p using(property_id)
    where d.created_at>now()-(greatest(days,1)||' days')::interval
       or d.updated_at>now()-(greatest(days,1)||' days')::interval
    order by changed_at desc limit least(greatest(lim,1),200)
  ) x),'[]'::jsonb));
$$;

grant execute on function public.api_buyers(text,text,numeric,numeric,date,int,text,int),
  public.api_similar_buyers(text,text,numeric,text[],int),
  public.api_last_interaction(text,int),
  public.api_entity_history(text,text,int),
  public.api_similar_sellers(text,text,int),
  public.api_missing_contacts(text,text,int,int),
  public.api_recent_changes(int,int)
to anon,authenticated;

notify pgrst,'reload schema';
