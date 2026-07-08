-- 011_live_sbi_rpc_api.sql
-- Live Supabase RPC API for the production sbi_* schema.
-- Mirrors the frontend api_* contract used by skyline/frontend/src/api/client.js.

create or replace function api_health() returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('status','ok','deals',(select count(*) from sbi_deals),'runtime','supabase-rpc-sbi');
$$;

create or replace function api_meta() returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'asset_types', coalesce((select jsonb_agg(x.asset_type order by x.asset_type) from (select distinct asset_type from sbi_deals where asset_type is not null) x),'[]'::jsonb),
    'boroughs', coalesce((select jsonb_agg(x.borough order by x.borough) from (select distinct borough from sbi_properties where borough is not null) x),'[]'::jsonb),
    'stats', jsonb_build_object(
      'deals',(select count(*) from sbi_deals),
      'priced',(select count(*) from sbi_deals where sale_price is not null),
      'total_volume',(select coalesce(sum(sale_price),0) from sbi_deals),
      'earliest',(select min(sale_date) from sbi_deals),
      'latest',(select max(sale_date) from sbi_deals),
      'unique_buyers',(select count(distinct entity_id) from sbi_deal_parties where role='buyer'),
      'open_reviews',(select count(*) from sbi_review_queue where status='open'),
      'contacts',(select count(*) from sbi_contacts)
    )
  );
$$;

create or replace function api_deals(
  q text default null, borough text default null, asset_type text default null,
  market text default null, price_min numeric default null, price_max numeric default null,
  date_min date default null, date_max date default null,
  units_min int default null, units_max int default null,
  sqft_min int default null, sqft_max int default null,
  ppsf_max numeric default null, confidence_min int default null,
  status text default null, has_buyer boolean default false,
  sort_by text default 'sale_date', order_dir text default 'desc',
  page int default 1, per_page int default 50)
returns jsonb language sql stable security definer set search_path=public as $$
  with f as (
    select d.deal_id, d.sale_date, p.address_raw as address, p.borough, p.market,
           d.asset_type, b.display_name as buyer, b.entity_id as buyer_entity_id,
           s.display_name as seller, s.entity_id as seller_entity_id,
           d.sale_price, d.units, d.sqft, d.ppu, d.ppsf, d.confidence, d.parse_status,
           d.source_url, d.source_system,
           case api_deals.sort_by when 'sale_price' then d.sale_price when 'units' then d.units when 'sqft' then d.sqft when 'ppsf' then d.ppsf when 'ppu' then d.ppu when 'confidence' then d.confidence else extract(epoch from d.sale_date) end as sort_num,
           case when api_deals.sort_by='address' then p.address_raw else null end as sort_text
    from sbi_deals d
    join sbi_properties p using(property_id)
    left join lateral (select e.entity_id, e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='buyer' order by dp.created_at asc limit 1) b on true
    left join lateral (select e.entity_id, e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='seller' order by dp.created_at asc limit 1) s on true
    where (api_deals.q is null or api_deals.q='' or p.address_raw ilike '%'||api_deals.q||'%' or b.display_name ilike '%'||api_deals.q||'%' or s.display_name ilike '%'||api_deals.q||'%')
      and (api_deals.borough is null or api_deals.borough='' or p.borough=api_deals.borough)
      and (api_deals.asset_type is null or api_deals.asset_type='' or d.asset_type=api_deals.asset_type)
      and (api_deals.market is null or api_deals.market='' or p.market=api_deals.market)
      and (api_deals.price_min is null or d.sale_price>=api_deals.price_min)
      and (api_deals.price_max is null or d.sale_price<=api_deals.price_max)
      and (api_deals.date_min is null or d.sale_date>=api_deals.date_min)
      and (api_deals.date_max is null or d.sale_date<=api_deals.date_max)
      and (api_deals.units_min is null or d.units>=api_deals.units_min)
      and (api_deals.units_max is null or d.units<=api_deals.units_max)
      and (api_deals.sqft_min is null or d.sqft>=api_deals.sqft_min)
      and (api_deals.sqft_max is null or d.sqft<=api_deals.sqft_max)
      and (api_deals.ppsf_max is null or d.ppsf<=api_deals.ppsf_max)
      and (api_deals.confidence_min is null or d.confidence>=api_deals.confidence_min)
      and (api_deals.status is null or api_deals.status='' or d.parse_status=api_deals.status)
      and (not api_deals.has_buyer or b.display_name is not null)
  ), pg as (
    select *, row_number() over (order by
      case when api_deals.order_dir='asc' then sort_num end asc nulls last,
      case when api_deals.order_dir<>'asc' then sort_num end desc nulls last,
      case when api_deals.order_dir='asc' then sort_text end asc nulls last,
      case when api_deals.order_dir<>'asc' then sort_text end desc nulls last,
      deal_id) as rn
    from f
    limit least(greatest(api_deals.per_page,1),200)
    offset (greatest(api_deals.page,1)-1)*least(greatest(api_deals.per_page,1),200)
  )
  select jsonb_build_object(
    'total',(select count(*) from f),'page',greatest(api_deals.page,1),'per_page',least(greatest(api_deals.per_page,1),200),
    'pulse',(select jsonb_build_object('n',count(*),'vol',coalesce(sum(sale_price),0),'median',percentile_cont(0.5) within group(order by sale_price)) from f where sale_price is not null),
    'deals',coalesce((select jsonb_agg(to_jsonb(pg) - 'sort_num' - 'sort_text' - 'rn' order by rn) from pg),'[]'::jsonb));
$$;

create or replace function api_buyers(borough text default null, asset_type text default null, price_min numeric default null, price_max numeric default null, date_min date default null, min_deals int default 1, rank_by text default 'count', lim int default 60)
returns jsonb language sql stable security definer set search_path=public as $$
  with g as (
    select e.entity_id, e.display_name as name, e.is_spv_suspect, count(distinct d.deal_id) as n, coalesce(sum(d.sale_price),0) as vol, max(d.sale_date) as last_deal, min(d.sale_price) as min_price, max(d.sale_price) as max_price, array_agg(distinct d.asset_type) filter(where d.asset_type is not null) as types, array_agg(distinct p.borough) filter(where p.borough is not null) as boroughs, bool_or(c.contact_id is not null) as has_contact
    from sbi_deal_parties dp join sbi_entities e using(entity_id) join sbi_deals d using(deal_id) join sbi_properties p using(property_id) left join sbi_contacts c on c.entity_id=e.entity_id
    where dp.role='buyer' and (api_buyers.borough is null or api_buyers.borough='' or p.borough=api_buyers.borough) and (api_buyers.asset_type is null or api_buyers.asset_type='' or d.asset_type=api_buyers.asset_type) and (api_buyers.price_min is null or d.sale_price>=api_buyers.price_min) and (api_buyers.price_max is null or d.sale_price<=api_buyers.price_max) and (api_buyers.date_min is null or d.sale_date>=api_buyers.date_min)
    group by e.entity_id,e.display_name,e.is_spv_suspect having count(distinct d.deal_id)>=greatest(api_buyers.min_deals,1)
    order by case when api_buyers.rank_by='vol' then coalesce(sum(d.sale_price),0) else count(distinct d.deal_id) end desc limit least(greatest(api_buyers.lim,1),200)
  ) select jsonb_build_object('buyers',coalesce((select jsonb_agg(to_jsonb(g)) from g),'[]'::jsonb));
$$;

create or replace function api_leaderboards(group_by text default 'asset_type', rank_by text default 'count', top int default 5)
returns jsonb language sql stable security definer set search_path=public as $$
  with g as (
    select case when api_leaderboards.group_by='borough' then p.borough else d.asset_type end as grp, e.display_name as name, count(distinct d.deal_id) as n, coalesce(sum(d.sale_price),0) as vol
    from sbi_deal_parties dp join sbi_entities e using(entity_id) join sbi_deals d using(deal_id) join sbi_properties p using(property_id)
    where dp.role='buyer' and (case when api_leaderboards.group_by='borough' then p.borough else d.asset_type end) is not null group by 1,2
  ), r as (select grp,name,n,vol,row_number() over(partition by grp order by case when api_leaderboards.rank_by='vol' then vol else n end desc) as rk from g)
  select jsonb_build_object('boards',coalesce((select jsonb_agg(to_jsonb(r) order by grp,rk) from r where rk<=least(greatest(api_leaderboards.top,1),25)),'[]'::jsonb));
$$;

create or replace function api_entity(eid uuid) returns jsonb
language sql stable security definer set search_path=public as $$
  select case when not exists(select 1 from sbi_entities where entity_id=eid) then jsonb_build_object('error','not found') else jsonb_build_object('entity',(select to_jsonb(e) from sbi_entities e where e.entity_id=eid),'deals',coalesce((select jsonb_agg(jsonb_build_object('role',dp.role,'sale_date',d.sale_date,'address',p.address_raw,'borough',p.borough,'asset_type',d.asset_type,'sale_price',d.sale_price,'source_url',d.source_url) order by d.sale_date desc nulls last) from sbi_deal_parties dp join sbi_deals d using(deal_id) join sbi_properties p using(property_id) where dp.entity_id=eid),'[]'::jsonb),'contacts',coalesce((select jsonb_agg(to_jsonb(c)) from sbi_contacts c where c.entity_id=eid),'[]'::jsonb)) end;
$$;

create or replace function api_review(status text default 'open', issue_class text default null, lim int default 50) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (select review_id,object_type,object_id,issue_class,severity,payload,created_at from sbi_review_queue r where r.status=coalesce(nullif(api_review.status,''),'open') and (api_review.issue_class is null or api_review.issue_class='' or r.issue_class=api_review.issue_class) order by created_at desc limit least(greatest(api_review.lim,1),200)) i),'[]'::jsonb),'open_counts',coalesce((select jsonb_object_agg(issue_class,n) from (select issue_class,count(*) n from sbi_review_queue where status='open' group by issue_class) c),'{}'::jsonb));
$$;

create or replace function api_review_act(review_id uuid, action text, user_id text default 'system') returns jsonb
language plpgsql volatile security definer set search_path=public as $$
begin
  if action in ('resolve','dismiss') then
    update sbi_review_queue set status=case when action='resolve' then 'resolved' else 'dismissed' end, resolved_by=coalesce(user_id,'system'), resolved_at=now() where sbi_review_queue.review_id=api_review_act.review_id;
    return jsonb_build_object('status','ok');
  end if;
  return jsonb_build_object('error','Unsupported action in RPC mode');
end;
$$;

create or replace function api_workbench() returns jsonb
language sql stable security definer set search_path=public as $$
  with buyers as (select (b->>'entity_id')::uuid entity_id,b->>'name' name,(b->>'n')::int deal_count,(b->>'vol')::numeric volume,b->>'last_deal' last_deal,(b->>'has_contact')::boolean has_contact from jsonb_array_elements((api_buyers(lim=>200)->'buyers')) b), latest as (select distinct on(d.property_id) d.*,p.address_raw,p.borough,p.market,p.bbl,b.entity_id owner_entity_id,b.display_name current_owner,s.display_name seller from sbi_deals d join sbi_properties p using(property_id) left join lateral(select e.entity_id,e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='buyer' limit 1)b on true left join lateral(select e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='seller' limit 1)s on true order by d.property_id,d.sale_date desc nulls last)
  select jsonb_build_object('stats',jsonb_build_object('deals',(select count(*) from sbi_deals),'priced_deals',(select count(*) from sbi_deals where sale_price is not null),'total_volume',(select coalesce(sum(sale_price),0) from sbi_deals),'unique_buyers',(select count(distinct entity_id) from sbi_deal_parties where role='buyer'),'unique_sellers',(select count(distinct entity_id) from sbi_deal_parties where role='seller'),'contacts',(select count(*) from sbi_contacts),'contact_gaps',(select count(*) from buyers where deal_count>=2 and not has_contact),'open_reviews',(select count(*) from sbi_review_queue where status='open')),'contact_gaps',coalesce((select jsonb_agg(to_jsonb(x) order by volume desc) from (select * from buyers where deal_count>=2 and not has_contact order by volume desc limit 12)x),'[]'::jsonb),'owner_targets',coalesce((select jsonb_agg(jsonb_build_object('property_id',property_id,'deal_id',deal_id,'address',address_raw,'borough',borough,'market',market,'bbl',bbl,'sale_date',sale_date,'sale_price',sale_price,'asset_type',asset_type,'owner_entity_id',owner_entity_id,'current_owner',current_owner,'known_owner',current_owner,'seller',seller,'has_contact',exists(select 1 from sbi_contacts c where c.entity_id=owner_entity_id)) order by sale_price desc nulls last) from (select * from latest order by sale_price desc nulls last limit 12)x),'[]'::jsonb),'review_items',coalesce((select jsonb_agg(to_jsonb(r) order by created_at desc) from (select review_id,object_type,object_id,issue_class,severity,payload,created_at from sbi_review_queue where status='open' order by created_at desc limit 12)r),'[]'::jsonb),'scrape_runs',coalesce((select jsonb_agg(to_jsonb(r) order by started_at desc) from (select run_id,job,started_at,finished_at,status,stats,error from sbi_source_runs order by started_at desc limit 12)r),'[]'::jsonb));
$$;

create or replace function api_properties(q text default null, borough text default null, asset_type text default null, contact_gap boolean default false, page int default 1, per_page int default 50) returns jsonb
language sql stable security definer set search_path=public as $$
  with latest as (select distinct on(d.property_id) d.property_id,d.deal_id,d.sale_date,d.sale_price,d.asset_type,p.address_raw address,p.address_norm,p.borough,p.market,p.zip,p.bbl,p.total_units property_units,p.building_area property_sqft,b.entity_id owner_entity_id,b.display_name current_owner,s.entity_id seller_entity_id,s.display_name seller from sbi_deals d join sbi_properties p using(property_id) left join lateral(select e.entity_id,e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='buyer' limit 1)b on true left join lateral(select e.entity_id,e.display_name from sbi_deal_parties dp join sbi_entities e using(entity_id) where dp.deal_id=d.deal_id and dp.role='seller' limit 1)s on true order by d.property_id,d.sale_date desc nulls last), f as (select l.*,exists(select 1 from sbi_contacts c where c.entity_id=l.owner_entity_id) has_contact,(select max(i.occurred_at) from sbi_interactions i where i.entity_id=l.owner_entity_id) last_interaction,(select count(*) from sbi_deals d2 where d2.property_id=l.property_id) deal_count from latest l where (api_properties.q is null or api_properties.q='' or l.address ilike '%'||api_properties.q||'%' or coalesce(l.bbl,'') ilike '%'||api_properties.q||'%' or coalesce(l.current_owner,'') ilike '%'||api_properties.q||'%' or coalesce(l.seller,'') ilike '%'||api_properties.q||'%') and (api_properties.borough is null or api_properties.borough='' or l.borough=api_properties.borough) and (api_properties.asset_type is null or api_properties.asset_type='' or l.asset_type=api_properties.asset_type) and (not api_properties.contact_gap or not exists(select 1 from sbi_contacts c where c.entity_id=l.owner_entity_id))), pg as (select * from f order by sale_price desc nulls last, sale_date desc nulls last limit least(greatest(api_properties.per_page,1),200) offset (greatest(api_properties.page,1)-1)*least(greatest(api_properties.per_page,1),200)) select jsonb_build_object('total',(select count(*) from f),'page',greatest(api_properties.page,1),'per_page',least(greatest(api_properties.per_page,1),200),'properties',coalesce((select jsonb_agg(to_jsonb(pg)) from pg),'[]'::jsonb));
$$;

create or replace function api_tasks(lim int default 100) returns jsonb
language sql stable security definer set search_path=public as $$
  with b as (select e.entity_id,e.display_name,count(distinct d.deal_id) deal_count,coalesce(sum(d.sale_price),0) volume,max(d.sale_date) last_deal,count(distinct c.contact_id) contacts from sbi_deal_parties dp join sbi_entities e using(entity_id) join sbi_deals d using(deal_id) left join sbi_contacts c on c.entity_id=e.entity_id where dp.role='buyer' group by e.entity_id,e.display_name having count(distinct d.deal_id)>=2 and count(distinct c.contact_id)=0), t as (select 'contact_gap' kind,case when volume>=25000000 then 'high' else 'normal' end priority,entity_id,null::uuid review_id,'Find phone/email for '||display_name title,deal_count::text||' buyer deals · last deal '||coalesce(last_deal::text,'unknown') detail,volume metric,last_deal::timestamptz sort_time from b union all select 'review',coalesce(severity,'normal'),null::uuid,review_id,'Review '||issue_class,object_type||' · '||object_id,null::numeric,created_at from sbi_review_queue where status='open') select jsonb_build_object('tasks',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'priority',priority,'entity_id',entity_id,'review_id',review_id,'title',title,'detail',detail,'metric',metric) order by sort_time desc nulls last) from (select * from t order by sort_time desc nulls last limit least(greatest(api_tasks.lim,1),250))x),'[]'::jsonb));
$$;

create or replace function api_scraper_runs(lim int default 75) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('runs',coalesce((select jsonb_agg(to_jsonb(r) order by started_at desc) from (select run_id,job,started_at,finished_at,status,stats,error from sbi_source_runs order by started_at desc limit least(greatest(api_scraper_runs.lim,1),200))r),'[]'::jsonb));
$$;

create or replace function api_request_scrape(job text, user_id text default 'broker', options jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare rid uuid;
begin
  if api_request_scrape.job not in ('traded_refresh','acris_refresh','crexi_refresh','property_owner_refresh','full_refresh') then return jsonb_build_object('error','Unsupported scraper job'); end if;
  insert into sbi_source_runs(source,job,status,stats) values('manual',api_request_scrape.job,'running',jsonb_build_object('requested_by',coalesce(api_request_scrape.user_id,'broker'),'requested_status','requested','options',coalesce(api_request_scrape.options,'{}'::jsonb))) returning run_id into rid;
  return jsonb_build_object('run_id',rid,'job',api_request_scrape.job,'status','requested');
end;
$$;

create or replace function api_uploads_list() returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('uploads',coalesce((select jsonb_agg(to_jsonb(u) order by created_at desc) from (select * from sbi_uploads order by created_at desc limit 50)u),'[]'::jsonb));
$$;

grant execute on function api_health(), api_meta(), api_deals(text,text,text,text,numeric,numeric,date,date,int,int,int,int,numeric,int,text,boolean,text,text,int,int), api_buyers(text,text,numeric,numeric,date,int,text,int), api_leaderboards(text,text,int), api_entity(uuid), api_review(text,text,int), api_review_act(uuid,text,text), api_workbench(), api_properties(text,text,text,boolean,int,int), api_tasks(int), api_scraper_runs(int), api_request_scrape(text,text,jsonb), api_uploads_list() to anon;
notify pgrst, 'reload schema';
