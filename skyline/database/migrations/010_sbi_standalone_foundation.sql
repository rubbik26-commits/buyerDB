-- 010_sbi_standalone_foundation.sql
-- Standalone NYC investment-property intelligence foundation.
-- Runtime does not depend on Base44 or any app-builder system.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.sbi_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.sbi_norm_entity(v text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select nullif(
    regexp_replace(
      regexp_replace(upper(coalesce(v,'')), '\m(LLC|L\.L\.C|INC|CORP|CORPORATION|LP|L\.P|LTD|COMPANY|CO)\M', '', 'g'),
      '[^A-Z0-9]+', ' ', 'g'
    ),
    ''
  )
$$;

create or replace function public.sbi_norm_address(v text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select nullif(trim(regexp_replace(regexp_replace(regexp_replace(upper(coalesce(v,'')), '\b(NEW YORK|NY|NYC|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND)\b\s*$', '', 'gi'), '[.,;:#()]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

create or replace function public.sbi_asset_type_allowed(p_asset_type text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(trim(p_asset_type), '') = ''
      or trim(p_asset_type) not in ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family')
$$;

create table if not exists public.sbi_source_runs (
  run_id uuid primary key default gen_random_uuid(),
  source text not null,
  job text not null,
  status text not null default 'running' check (status in ('running','completed','completed_with_errors','failed','quota_blocked','timeout','cancelled','partial_success')),
  started_at timestamptz default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  events jsonb not null default '[]'::jsonb,
  error text
);

create table if not exists public.sbi_fetch_ledger (
  source text not null,
  source_key text not null,
  disposition text not null,
  fetched_at timestamptz default now(),
  payload_hash text,
  primary key (source, source_key)
);

create table if not exists public.sbi_exclusion_ledger (
  exclusion_id uuid primary key default gen_random_uuid(),
  addr_norm text,
  bbl char(10),
  price numeric(14,2),
  reason text not null,
  evidence text,
  source text,
  created_at timestamptz default now(),
  unique (addr_norm, price, reason)
);

create table if not exists public.sbi_properties (
  property_id uuid primary key default gen_random_uuid(),
  address_raw text not null,
  address_norm text generated always as (public.sbi_norm_address(address_raw)) stored,
  borough text check (borough in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')),
  neighborhood text,
  market text,
  zip text,
  bbl char(10) unique,
  block text,
  lot text,
  tax_class text,
  building_class text,
  zoning text,
  lot_area int,
  building_area int,
  residential_units int,
  commercial_units int,
  total_units int,
  year_built int,
  latitude numeric,
  longitude numeric,
  current_owner text,
  current_owner_norm text generated always as (public.sbi_norm_entity(current_owner)) stored,
  current_owner_mailing_address text,
  owner_status text default 'unverified' check (owner_status in ('ok','verified','unverified','needs_review')),
  owner_history jsonb not null default '[]'::jsonb,
  verification_status text default 'unverified' check (verification_status in ('unverified','verified','needs_review','conflict')),
  record_quality text default 'ok' check (record_quality in ('ok','needs_review','quarantined')),
  source text,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (address_norm, borough)
);

create table if not exists public.sbi_entities (
  entity_id uuid primary key default gen_random_uuid(),
  display_name text not null,
  norm_name text generated always as (public.sbi_norm_entity(display_name)) stored,
  entity_type text default 'unknown' check (entity_type in ('llc','individual','fund','corp','trust','gov','unknown')),
  is_spv_suspect boolean default false,
  mailing_address text,
  website text,
  key_person text,
  enrichment_status text default 'not_started' check (enrichment_status in ('not_started','pending','partial','enriched','not_found','source_missing','source_unavailable','failed','needs_review','quota_blocked')),
  enrichment_confidence int check (enrichment_confidence between 0 and 100),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (norm_name)
);

create table if not exists public.sbi_entity_aliases (
  alias_id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.sbi_entities(entity_id) on delete cascade not null,
  alias_raw text not null,
  alias_norm text generated always as (public.sbi_norm_entity(alias_raw)) stored,
  source text not null,
  created_at timestamptz default now(),
  unique (alias_norm)
);

create table if not exists public.sbi_deals (
  deal_id uuid primary key default gen_random_uuid(),
  property_id uuid references public.sbi_properties(property_id) not null,
  sale_date date,
  post_date timestamptz,
  asset_type text,
  transaction_type text default 'sale',
  sale_price numeric(14,2),
  units int,
  sqft int,
  ppu numeric(12,2) generated always as (case when units > 0 and sale_price is not null then round(sale_price / units, 2) end) stored,
  ppsf numeric(12,2) generated always as (case when sqft > 0 and sale_price is not null then round(sale_price / sqft, 2) end) stored,
  source_system text check (source_system in ('acris','traded','crexi','instagram','upload','manual','other')),
  source_url text,
  source_urls text[],
  source_key text unique,
  acris_doc_id text unique,
  confidence int check (confidence between 0 and 100),
  parse_status text default 'ok' check (parse_status in ('ok','needs_review','failed_parse')),
  verification_status text default 'unverified' check (verification_status in ('unverified','verified','needs_review','conflict')),
  record_quality text default 'ok' check (record_quality in ('ok','needs_review','quarantined')),
  notes text,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint sbi_no_residential_asset check (asset_type is null or asset_type not in ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family')),
  unique (property_id, sale_price, sale_date)
);

create table if not exists public.sbi_deal_parties (
  deal_id uuid references public.sbi_deals(deal_id) on delete cascade not null,
  entity_id uuid references public.sbi_entities(entity_id) not null,
  role text not null check (role in ('buyer','seller','lender','borrower','landlord','tenant','owner')),
  mailing_address text,
  source_system text not null,
  provenance_ref text,
  amount_gate_passed boolean,
  verified_deed_amount numeric(14,2),
  match_confidence int check (match_confidence between 0 and 100),
  created_at timestamptz default now(),
  primary key (deal_id, entity_id, role),
  constraint sbi_acris_requires_amount_gate check (source_system <> 'acris' or amount_gate_passed is true)
);

create table if not exists public.sbi_contacts (
  contact_id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.sbi_entities(entity_id) on delete cascade,
  person_name text,
  company text,
  title text,
  role text check (role in ('Buyer','Seller','Owner','Broker','Lender','Other')),
  phone text,
  email text,
  website text,
  linkedin text,
  mailing_address text,
  source text not null,
  confidence int default 100 check (confidence between 0 and 100),
  is_primary boolean default false,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.sbi_interactions (
  interaction_id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.sbi_entities(entity_id) on delete cascade,
  contact_id uuid references public.sbi_contacts(contact_id) on delete set null,
  channel text check (channel in ('call','email','text','meeting','mail','other')),
  occurred_at timestamptz not null,
  subject text,
  notes text,
  outcome text,
  user_id text,
  created_at timestamptz default now()
);

create table if not exists public.sbi_review_queue (
  review_id uuid primary key default gen_random_uuid(),
  object_type text not null,
  object_id text not null,
  issue_class text not null,
  severity text default 'normal' check (severity in ('low','normal','high','critical')),
  payload jsonb not null default '{}'::jsonb,
  status text default 'open' check (status in ('open','resolved','dismissed')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.sbi_buyer_scores (
  score_id uuid primary key default gen_random_uuid(),
  subject_deal_id uuid references public.sbi_deals(deal_id) on delete cascade,
  entity_id uuid references public.sbi_entities(entity_id) on delete cascade not null,
  score numeric(10,2) not null,
  score_breakdown jsonb not null default '{}'::jsonb,
  criteria jsonb not null default '{}'::jsonb,
  generated_at timestamptz default now(),
  unique (subject_deal_id, entity_id)
);

create index if not exists sbi_properties_bbl_idx on public.sbi_properties(bbl);
create index if not exists sbi_properties_addr_trgm_idx on public.sbi_properties using gin(address_norm gin_trgm_ops);
create index if not exists sbi_entities_norm_trgm_idx on public.sbi_entities using gin(norm_name gin_trgm_ops);
create index if not exists sbi_entity_aliases_entity_id_idx on public.sbi_entity_aliases(entity_id);
create index if not exists sbi_deals_sale_date_idx on public.sbi_deals(sale_date desc);
create index if not exists sbi_deals_asset_idx on public.sbi_deals(asset_type);
create index if not exists sbi_deal_parties_entity_role_idx on public.sbi_deal_parties(entity_id, role);
create index if not exists sbi_contacts_entity_idx on public.sbi_contacts(entity_id);
create index if not exists sbi_interactions_entity_time_idx on public.sbi_interactions(entity_id, occurred_at desc);
create index if not exists sbi_interactions_contact_id_idx on public.sbi_interactions(contact_id);
create index if not exists sbi_review_status_idx on public.sbi_review_queue(status, severity, created_at desc);
create index if not exists sbi_buyer_scores_entity_id_idx on public.sbi_buyer_scores(entity_id);
create index if not exists sbi_buyer_scores_subject_deal_id_idx on public.sbi_buyer_scores(subject_deal_id);

create or replace function public.sbi_get_or_create_entity(p_display_name text)
returns uuid
language plpgsql
set search_path = public, extensions
as $$
declare
  eid uuid;
begin
  if p_display_name is null or trim(p_display_name) = '' then
    return null;
  end if;
  insert into public.sbi_entities(display_name)
  values (trim(p_display_name))
  on conflict (norm_name) do update set updated_at = now()
  returning entity_id into eid;
  return eid;
end;
$$;

create or replace function public.sbi_ingest_deal(
  p_address text,
  p_borough text default null,
  p_neighborhood text default null,
  p_market text default null,
  p_asset_type text default null,
  p_transaction_type text default 'sale',
  p_sale_price numeric default null,
  p_units int default null,
  p_sqft int default null,
  p_sale_date date default null,
  p_post_date timestamptz default null,
  p_buyer text default null,
  p_seller text default null,
  p_source_system text default 'manual',
  p_source_url text default null,
  p_source_key text default null,
  p_acris_doc_id text default null,
  p_confidence int default null,
  p_parse_status text default 'ok',
  p_verification_status text default 'unverified',
  p_record_quality text default 'ok',
  p_notes text default null,
  p_provenance jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_property_id uuid;
  v_deal_id uuid;
  v_buyer_id uuid;
  v_seller_id uuid;
  v_source_system text;
  v_asset text;
  v_borough text;
  v_source_key text;
begin
  if p_address is null or trim(p_address) = '' then
    return jsonb_build_object('status','rejected','reason','missing_address');
  end if;

  v_asset := nullif(trim(p_asset_type), '');
  v_borough := nullif(trim(p_borough), '');
  if v_borough not in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island') then v_borough := null; end if;

  if not public.sbi_asset_type_allowed(v_asset) then
    insert into public.sbi_exclusion_ledger(addr_norm, price, reason, evidence, source)
    values (public.sbi_norm_address(p_address), p_sale_price, 'excluded_asset_type', v_asset, coalesce(p_source_system,'manual'))
    on conflict do nothing;
    insert into public.sbi_review_queue(object_type, object_id, issue_class, severity, payload)
    values ('deal', coalesce(p_source_key, p_source_url, public.sbi_norm_address(p_address)), 'excluded_asset_type', 'normal', jsonb_build_object('address', p_address, 'asset_type', v_asset, 'sale_price', p_sale_price, 'source_url', p_source_url));
    return jsonb_build_object('status','rejected','reason','excluded_asset_type','asset_type',v_asset);
  end if;

  v_source_system := case
    when p_source_system in ('acris','traded','crexi','instagram','upload','manual','other') then p_source_system
    when lower(coalesce(p_source_system,'')) like '%acris%' then 'acris'
    when lower(coalesce(p_source_system,'')) like '%traded%' then 'traded'
    when lower(coalesce(p_source_system,'')) like '%crexi%' then 'crexi'
    when lower(coalesce(p_source_system,'')) like '%upload%' then 'upload'
    else 'manual'
  end;

  v_source_key := coalesce(nullif(trim(p_source_key), ''), md5(coalesce(v_source_system,'manual') || '|' || public.sbi_norm_address(p_address) || '|' || coalesce(p_sale_price::text,'') || '|' || coalesce(p_sale_date::text,'')));

  insert into public.sbi_properties(address_raw, borough, neighborhood, market, source, provenance)
  values (trim(p_address), v_borough, nullif(trim(p_neighborhood), ''), nullif(trim(p_market), ''), v_source_system, jsonb_build_object('ingest', coalesce(p_provenance, '{}'::jsonb)))
  on conflict (address_norm, borough) do update set
    neighborhood = coalesce(public.sbi_properties.neighborhood, excluded.neighborhood),
    market = coalesce(public.sbi_properties.market, excluded.market),
    provenance = public.sbi_properties.provenance || excluded.provenance,
    updated_at = now()
  returning property_id into v_property_id;

  insert into public.sbi_deals(property_id, sale_date, post_date, asset_type, transaction_type, sale_price, units, sqft, source_system, source_url, source_urls, source_key, acris_doc_id, confidence, parse_status, verification_status, record_quality, notes, provenance)
  values (v_property_id, p_sale_date, p_post_date, v_asset, coalesce(nullif(trim(p_transaction_type),''),'sale'), p_sale_price, p_units, p_sqft, v_source_system, p_source_url, case when p_source_url is null then null else array[p_source_url] end, v_source_key, nullif(trim(p_acris_doc_id),''), p_confidence, coalesce(nullif(trim(p_parse_status),''),'ok'), coalesce(nullif(trim(p_verification_status),''),'unverified'), coalesce(nullif(trim(p_record_quality),''),'ok'), p_notes, coalesce(p_provenance, '{}'::jsonb))
  on conflict (source_key) do update set
    property_id = excluded.property_id,
    sale_date = coalesce(public.sbi_deals.sale_date, excluded.sale_date),
    asset_type = coalesce(public.sbi_deals.asset_type, excluded.asset_type),
    sale_price = coalesce(public.sbi_deals.sale_price, excluded.sale_price),
    units = coalesce(public.sbi_deals.units, excluded.units),
    sqft = coalesce(public.sbi_deals.sqft, excluded.sqft),
    source_url = coalesce(public.sbi_deals.source_url, excluded.source_url),
    confidence = greatest(coalesce(public.sbi_deals.confidence,0), coalesce(excluded.confidence,0)),
    provenance = public.sbi_deals.provenance || excluded.provenance,
    updated_at = now()
  returning deal_id into v_deal_id;

  if p_buyer is not null and trim(p_buyer) <> '' and lower(trim(p_buyer)) not in ('unknown','undisclosed','n/a','na','null') then
    v_buyer_id := public.sbi_get_or_create_entity(p_buyer);
    insert into public.sbi_deal_parties(deal_id, entity_id, role, source_system, provenance_ref, amount_gate_passed, verified_deed_amount, match_confidence)
    values (v_deal_id, v_buyer_id, 'buyer', v_source_system, v_source_key, case when v_source_system = 'acris' then true else null end, case when v_source_system = 'acris' then p_sale_price else null end, p_confidence)
    on conflict do nothing;
  end if;

  if p_seller is not null and trim(p_seller) <> '' and lower(trim(p_seller)) not in ('unknown','undisclosed','n/a','na','null') then
    v_seller_id := public.sbi_get_or_create_entity(p_seller);
    insert into public.sbi_deal_parties(deal_id, entity_id, role, source_system, provenance_ref, amount_gate_passed, verified_deed_amount, match_confidence)
    values (v_deal_id, v_seller_id, 'seller', v_source_system, v_source_key, case when v_source_system = 'acris' then true else null end, case when v_source_system = 'acris' then p_sale_price else null end, p_confidence)
    on conflict do nothing;
  end if;

  return jsonb_build_object('status','upserted','deal_id',v_deal_id,'property_id',v_property_id,'buyer_id',v_buyer_id,'seller_id',v_seller_id,'source_key',v_source_key);
end;
$$;

create or replace function public.sbi_match_buyers(
  p_asset_type text default null,
  p_borough text default null,
  p_price numeric default null,
  p_keywords text[] default '{}',
  p_since date default (current_date - interval '365 days')::date,
  p_limit int default 25
)
returns table (
  entity_id uuid,
  buyer_name text,
  deal_count bigint,
  total_volume numeric,
  last_deal date,
  asset_types text[],
  boroughs text[],
  has_contact boolean,
  score numeric,
  score_breakdown jsonb
)
language sql
stable
set search_path = public, extensions
as $$
with buyer_deals as (
  select e.entity_id, e.display_name, e.is_spv_suspect, d.asset_type, p.borough, d.sale_price, d.sale_date,
         lower(coalesce(p.address_raw,'') || ' ' || coalesce(p.neighborhood,'') || ' ' || coalesce(p.market,'')) as hay
  from public.sbi_deal_parties dp
  join public.sbi_entities e on e.entity_id = dp.entity_id
  join public.sbi_deals d on d.deal_id = dp.deal_id
  join public.sbi_properties p on p.property_id = d.property_id
  where dp.role = 'buyer'
    and d.record_quality <> 'quarantined'
    and d.verification_status <> 'conflict'
    and (d.sale_date is null or d.sale_date >= p_since)
), scored as (
  select entity_id, display_name, is_spv_suspect,
         count(*) as deal_count,
         coalesce(sum(sale_price),0) as total_volume,
         max(sale_date) as last_deal,
         array_remove(array_agg(distinct asset_type), null) as asset_types,
         array_remove(array_agg(distinct borough), null) as boroughs,
         sum(case when p_asset_type is not null and asset_type = p_asset_type then 18 when p_asset_type is not null and asset_type is distinct from p_asset_type then -8 else 0 end) as asset_pts,
         sum(case when p_borough is not null and borough = p_borough then 12 when p_borough is not null and borough is distinct from p_borough then -4 else 0 end) as borough_pts,
         sum(case when p_price is not null and sale_price between p_price * 0.5 and p_price * 2.0 then 10 when p_price is not null and sale_price is not null then -4 else 0 end) as price_pts,
         sum(case when cardinality(coalesce(p_keywords,'{}'::text[])) > 0 and exists (select 1 from unnest(p_keywords) k where hay like '%' || lower(k) || '%') then 8 else 0 end) as keyword_pts
  from buyer_deals
  group by entity_id, display_name, is_spv_suspect
)
select s.entity_id,
       s.display_name as buyer_name,
       s.deal_count,
       s.total_volume,
       s.last_deal,
       s.asset_types,
       s.boroughs,
       exists(select 1 from public.sbi_contacts c where c.entity_id = s.entity_id and (c.phone is not null or c.email is not null)) as has_contact,
       (asset_pts + borough_pts + price_pts + keyword_pts + least(deal_count, 10) * 2 + least(total_volume / 10000000, 40) - case when is_spv_suspect then 12 else 0 end)::numeric(10,2) as score,
       jsonb_build_object('asset_pts', asset_pts, 'borough_pts', borough_pts, 'price_pts', price_pts, 'keyword_pts', keyword_pts, 'recurrence_pts', least(deal_count, 10) * 2, 'volume_pts', least(total_volume / 10000000, 40), 'spv_penalty', case when is_spv_suspect then -12 else 0 end) as score_breakdown
from scored s
order by score desc, deal_count desc, total_volume desc
limit greatest(1, least(coalesce(p_limit,25), 100));
$$;

create or replace view public.sbi_deal_cards with (security_invoker = true) as
select d.deal_id, d.sale_date, d.post_date, p.address_raw as address, p.address_norm, p.borough, p.neighborhood, p.bbl,
       d.asset_type, d.transaction_type, d.sale_price, d.units, d.sqft, d.ppu, d.ppsf,
       d.source_system, d.source_url, d.source_key, d.acris_doc_id, d.confidence, d.parse_status, d.verification_status, d.record_quality,
       buyer.display_name as buyer, seller.display_name as seller,
       exists(select 1 from public.sbi_contacts c join public.sbi_deal_parties dp2 on dp2.entity_id = c.entity_id where dp2.deal_id = d.deal_id and dp2.role = 'buyer' and (c.phone is not null or c.email is not null)) as buyer_has_contact
from public.sbi_deals d
join public.sbi_properties p on p.property_id = d.property_id
left join lateral (select e.display_name from public.sbi_deal_parties dp join public.sbi_entities e on e.entity_id = dp.entity_id where dp.deal_id = d.deal_id and dp.role = 'buyer' order by e.entity_id limit 1) buyer on true
left join lateral (select e.display_name from public.sbi_deal_parties dp join public.sbi_entities e on e.entity_id = dp.entity_id where dp.deal_id = d.deal_id and dp.role = 'seller' order by e.entity_id limit 1) seller on true;

create or replace function public.sbi_api_meta()
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
select jsonb_build_object(
  'deals', (select count(*) from public.sbi_deals),
  'properties', (select count(*) from public.sbi_properties),
  'entities', (select count(*) from public.sbi_entities),
  'contacts', (select count(*) from public.sbi_contacts),
  'open_reviews', (select count(*) from public.sbi_review_queue where status = 'open'),
  'total_volume', (select coalesce(sum(sale_price),0) from public.sbi_deals),
  'latest_deal', (select max(sale_date) from public.sbi_deals)
)
$$;

create or replace function public.sbi_search_deals(
  p_query text default null,
  p_borough text default null,
  p_asset_type text default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_since date default null,
  p_limit int default 100,
  p_offset int default 0
)
returns setof public.sbi_deal_cards
language sql
stable
set search_path = public, extensions
as $$
  select * from public.sbi_deal_cards d
  where (p_query is null or d.address_norm ilike '%' || public.sbi_norm_address(p_query) || '%' or d.buyer ilike '%' || p_query || '%' or d.seller ilike '%' || p_query || '%')
    and (p_borough is null or d.borough = p_borough)
    and (p_asset_type is null or d.asset_type = p_asset_type)
    and (p_min_price is null or d.sale_price >= p_min_price)
    and (p_max_price is null or d.sale_price <= p_max_price)
    and (p_since is null or d.sale_date >= p_since)
  order by d.sale_date desc nulls last, d.sale_price desc nulls last
  limit greatest(1, least(coalesce(p_limit,100), 500))
  offset greatest(0, coalesce(p_offset,0));
$$;

create or replace function public.sbi_lookup_owner_or_buyer(p_name text)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
with ent as (
  select * from public.sbi_entities
  where norm_name = public.sbi_norm_entity(p_name)
     or norm_name % public.sbi_norm_entity(p_name)
  order by similarity(norm_name, public.sbi_norm_entity(p_name)) desc nulls last
  limit 1
), stats as (
  select e.entity_id,
         count(*) filter (where dp.role='buyer') as buyer_deals,
         count(*) filter (where dp.role='seller') as seller_deals,
         coalesce(sum(d.sale_price) filter (where dp.role='buyer'),0) as buyer_volume,
         max(d.sale_date) as last_deal
  from ent e
  left join public.sbi_deal_parties dp on dp.entity_id = e.entity_id
  left join public.sbi_deals d on d.deal_id = dp.deal_id
  group by e.entity_id
), contacts as (
  select e.entity_id, jsonb_agg(jsonb_build_object('person_name', c.person_name, 'company', c.company, 'role', c.role, 'phone', c.phone, 'email', c.email, 'source', c.source, 'confidence', c.confidence) order by c.is_primary desc, c.confidence desc) as contact_rows
  from ent e
  left join public.sbi_contacts c on c.entity_id = e.entity_id
  group by e.entity_id
)
select coalesce(jsonb_build_object(
  'entity', jsonb_build_object('entity_id', e.entity_id, 'display_name', e.display_name, 'entity_type', e.entity_type, 'website', e.website, 'mailing_address', e.mailing_address, 'enrichment_status', e.enrichment_status),
  'stats', jsonb_build_object('buyer_deals', s.buyer_deals, 'seller_deals', s.seller_deals, 'buyer_volume', s.buyer_volume, 'last_deal', s.last_deal),
  'contacts', coalesce(c.contact_rows, '[]'::jsonb)
), jsonb_build_object('entity', null, 'contacts', '[]'::jsonb))
from ent e
left join stats s on s.entity_id = e.entity_id
left join contacts c on c.entity_id = e.entity_id;
$$;

alter table public.sbi_source_runs enable row level security;
alter table public.sbi_fetch_ledger enable row level security;
alter table public.sbi_exclusion_ledger enable row level security;
alter table public.sbi_properties enable row level security;
alter table public.sbi_entities enable row level security;
alter table public.sbi_entity_aliases enable row level security;
alter table public.sbi_deals enable row level security;
alter table public.sbi_deal_parties enable row level security;
alter table public.sbi_contacts enable row level security;
alter table public.sbi_interactions enable row level security;
alter table public.sbi_review_queue enable row level security;
alter table public.sbi_buyer_scores enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sbi_source_runs','sbi_fetch_ledger','sbi_exclusion_ledger','sbi_properties','sbi_entities','sbi_entity_aliases','sbi_deals','sbi_deal_parties','sbi_contacts','sbi_interactions','sbi_review_queue','sbi_buyer_scores'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_read') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_authenticated_read', t);
    end if;
  end loop;
end;
$$;

revoke all on public.sbi_source_runs, public.sbi_fetch_ledger, public.sbi_exclusion_ledger, public.sbi_properties, public.sbi_entities, public.sbi_entity_aliases, public.sbi_deals, public.sbi_deal_parties, public.sbi_contacts, public.sbi_interactions, public.sbi_review_queue, public.sbi_buyer_scores from anon;
revoke execute on function public.sbi_get_or_create_entity(text) from anon, authenticated, public;
revoke execute on function public.sbi_ingest_deal(text,text,text,text,text,text,numeric,integer,integer,date,timestamp with time zone,text,text,text,text,text,text,integer,text,text,text,text,jsonb) from anon, authenticated, public;
grant select on public.sbi_deal_cards to authenticated;
grant execute on function public.sbi_api_meta() to authenticated, service_role;
grant execute on function public.sbi_match_buyers(text,text,numeric,text[],date,integer) to authenticated, service_role;
grant execute on function public.sbi_search_deals(text,text,text,numeric,numeric,date,integer,integer) to authenticated, service_role;
grant execute on function public.sbi_lookup_owner_or_buyer(text) to authenticated, service_role;
grant execute on function public.sbi_get_or_create_entity(text) to service_role;
grant execute on function public.sbi_ingest_deal(text,text,text,text,text,text,numeric,integer,integer,date,timestamp with time zone,text,text,text,text,text,text,integer,text,text,text,text,jsonb) to service_role;
