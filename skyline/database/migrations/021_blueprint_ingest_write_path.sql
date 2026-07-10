-- 021_blueprint_ingest_write_path.sql
-- Canonical source-safe write path: exclusion ledger, non-overwrite updates,
-- source conflict review, ACRIS amount-gated parties, and batch compatibility RPC.

create or replace function public.sbi_ingest_deal(
  p_address text,
  p_borough text default null,
  p_neighborhood text default null,
  p_market text default null,
  p_asset_type text default null,
  p_transaction_type text default 'sale',
  p_sale_price numeric default null,
  p_units integer default null,
  p_sqft integer default null,
  p_sale_date date default null,
  p_post_date timestamptz default null,
  p_buyer text default null,
  p_seller text default null,
  p_source_system text default 'manual',
  p_source_url text default null,
  p_source_key text default null,
  p_acris_doc_id text default null,
  p_confidence integer default null,
  p_parse_status text default 'ok',
  p_verification_status text default 'unverified',
  p_record_quality text default 'ok',
  p_notes text default null,
  p_provenance jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path=public,extensions as $$
declare
  v_property_id uuid;
  v_deal_id uuid;
  v_source text;
  v_asset text;
  v_borough text;
  v_addr_norm text;
  v_existing public.sbi_deals%rowtype;
  v_conflicts text[] := '{}';
  v_deed_amount numeric;
  v_gate boolean := false;
  v_buyer_result jsonb;
  v_seller_result jsonb;
  v_class text;
begin
  if p_address is null or trim(p_address)='' then
    return jsonb_build_object('status','rejected','reason','missing_address');
  end if;

  v_addr_norm := public.sbi_norm_address(p_address);
  v_asset := nullif(trim(p_asset_type),'');
  v_borough := nullif(trim(p_borough),'');
  if v_borough not in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island') then v_borough:=null; end if;
  v_source := case
    when lower(coalesce(p_source_system,'')) in ('acris','traded','crexi','instagram','upload','base44','manual','other','csv') then lower(p_source_system)
    when lower(coalesce(p_source_system,'')) like '%acris%' then 'acris'
    when lower(coalesce(p_source_system,'')) like '%traded%' then 'traded'
    when lower(coalesce(p_source_system,'')) like '%crexi%' then 'crexi'
    when lower(coalesce(p_source_system,'')) like '%upload%' then 'upload'
    else 'other'
  end;

  if not public.sbi_asset_type_allowed(v_asset) then
    insert into public.sbi_exclusion_ledger(addr_norm,price,reason,evidence,source)
    values(v_addr_norm,p_sale_price,'excluded_asset_type',v_asset,v_source) on conflict do nothing;
    perform public.sbi_queue_review('deal',coalesce(p_source_key,p_acris_doc_id,p_source_url,v_addr_norm),
      'excluded_asset_type',jsonb_build_object('address',p_address,'asset_type',v_asset,'sale_price',p_sale_price,'source_url',p_source_url));
    return jsonb_build_object('status','rejected','reason','excluded_asset_type');
  end if;

  if exists(
    select 1 from public.sbi_exclusion_ledger x
    where x.addr_norm=v_addr_norm and x.price is not distinct from p_sale_price
  ) then
    return jsonb_build_object('status','rejected','reason','exclusion_ledger');
  end if;

  v_class:=upper(coalesce(p_provenance->>'bldg_class',p_provenance->>'building_class',''));
  if v_class ~ '^(A|B|R|C0|C3|C6|C8|D0|D4|DC)' then
    insert into public.sbi_exclusion_ledger(addr_norm,price,reason,evidence,source)
    values(v_addr_norm,p_sale_price,'residential_building_class',v_class,v_source) on conflict do nothing;
    return jsonb_build_object('status','rejected','reason','residential_building_class');
  end if;

  insert into public.sbi_properties(address_raw,borough,neighborhood,market,bbl,building_class,total_units,building_area,source,provenance)
  values(trim(p_address),v_borough,nullif(trim(p_neighborhood),''),nullif(trim(p_market),''),
    nullif(p_provenance->>'bbl','')::char(10),nullif(v_class,''),p_units,p_sqft,v_source,
    jsonb_build_object('ingest',coalesce(p_provenance,'{}'::jsonb)))
  on conflict (address_norm,borough) do update set
    neighborhood=coalesce(public.sbi_properties.neighborhood,excluded.neighborhood),
    market=coalesce(public.sbi_properties.market,excluded.market),
    bbl=coalesce(public.sbi_properties.bbl,excluded.bbl),
    building_class=coalesce(public.sbi_properties.building_class,excluded.building_class),
    total_units=coalesce(public.sbi_properties.total_units,excluded.total_units),
    building_area=coalesce(public.sbi_properties.building_area,excluded.building_area),
    source=coalesce(public.sbi_properties.source,excluded.source),
    provenance=coalesce(public.sbi_properties.provenance,'{}'::jsonb)||excluded.provenance,
    updated_at=now()
  returning property_id into v_property_id;

  select d.* into v_existing from public.sbi_deals d
  where (p_acris_doc_id is not null and d.acris_doc_id=p_acris_doc_id)
     or (p_source_key is not null and (d.shortcode=p_source_key or d.source_key=p_source_key))
     or (d.property_id=v_property_id and d.sale_price is not distinct from p_sale_price and d.sale_date is not distinct from p_sale_date)
  order by case
    when p_acris_doc_id is not null and d.acris_doc_id=p_acris_doc_id then 0
    when p_source_key is not null and (d.shortcode=p_source_key or d.source_key=p_source_key) then 1
    else 2 end
  limit 1;

  if v_existing.deal_id is null then
    insert into public.sbi_deals(property_id,sale_date,post_date,asset_type,transaction_type,sale_price,units,sqft,
      source_system,source_url,source_urls,shortcode,source_key,acris_doc_id,confidence,parse_status,verification_status,
      record_quality,notes,provenance)
    values(v_property_id,p_sale_date,p_post_date,v_asset,coalesce(nullif(trim(p_transaction_type),''),'sale'),p_sale_price,p_units,p_sqft,
      v_source,p_source_url,case when p_source_url is null then null else array[p_source_url] end,nullif(trim(p_source_key),''),
      nullif(trim(p_source_key),''),nullif(trim(p_acris_doc_id),''),p_confidence,
      case when p_parse_status in ('ok','needs_review','failed_parse') then p_parse_status else 'needs_review' end,
      case when p_verification_status in ('unverified','verified','needs_review','conflict') then p_verification_status else 'unverified' end,
      case when p_record_quality in ('ok','needs_review','quarantined') then p_record_quality else 'ok' end,
      p_notes,coalesce(p_provenance,'{}'::jsonb))
    returning deal_id into v_deal_id;
  else
    v_deal_id:=v_existing.deal_id;
    if v_existing.sale_price is not null and p_sale_price is not null and v_existing.sale_price<>p_sale_price then v_conflicts:=array_append(v_conflicts,'sale_price'); end if;
    if v_existing.sale_date is not null and p_sale_date is not null and v_existing.sale_date<>p_sale_date then v_conflicts:=array_append(v_conflicts,'sale_date'); end if;
    if v_existing.asset_type is not null and v_asset is not null and v_existing.asset_type<>v_asset then v_conflicts:=array_append(v_conflicts,'asset_type'); end if;
    if v_existing.units is not null and p_units is not null and v_existing.units<>p_units then v_conflicts:=array_append(v_conflicts,'units'); end if;
    if v_existing.sqft is not null and p_sqft is not null and v_existing.sqft<>p_sqft then v_conflicts:=array_append(v_conflicts,'sqft'); end if;

    update public.sbi_deals set
      sale_date=coalesce(sale_date,p_sale_date),
      post_date=coalesce(post_date,p_post_date),
      asset_type=coalesce(asset_type,v_asset),
      transaction_type=coalesce(transaction_type,p_transaction_type),
      sale_price=coalesce(sale_price,p_sale_price),
      units=coalesce(units,p_units),
      sqft=coalesce(sqft,p_sqft),
      source_url=coalesce(source_url,p_source_url),
      source_urls=case when p_source_url is null or p_source_url=any(coalesce(source_urls,'{}'::text[])) then source_urls else array_append(coalesce(source_urls,'{}'::text[]),p_source_url) end,
      confidence=greatest(coalesce(confidence,0),coalesce(p_confidence,0)),
      parse_status=case when cardinality(v_conflicts)>0 then 'needs_review' else coalesce(parse_status,p_parse_status,'ok') end,
      verification_status=case when cardinality(v_conflicts)>0 then 'conflict' else verification_status end,
      record_quality=case when cardinality(v_conflicts)>0 then 'needs_review' else record_quality end,
      notes=case when p_notes is null or position(p_notes in coalesce(notes,''))>0 then notes else trim(both ' |' from coalesce(notes,'')||' | '||p_notes) end,
      provenance=coalesce(provenance,'{}'::jsonb)||coalesce(p_provenance,'{}'::jsonb),
      updated_at=now()
    where deal_id=v_deal_id;

    if cardinality(v_conflicts)>0 then
      perform public.sbi_queue_review('deal',v_deal_id::text,'source_conflict',
        jsonb_build_object('fields',v_conflicts,'source',v_source,'source_key',p_source_key,'source_url',p_source_url));
    end if;
  end if;

  if v_source='acris' then
    begin v_deed_amount:=nullif(p_provenance->>'deed_amount','')::numeric; exception when others then v_deed_amount:=null; end;
    v_gate:=v_deed_amount is not null and p_sale_price is not null and p_sale_price>0
      and abs(v_deed_amount-p_sale_price)/p_sale_price<=0.03;
  end if;

  v_buyer_result:=public.sbi_attach_party(v_deal_id,'buyer',p_buyer,p_provenance->>'buyer_address',v_source,
    coalesce(p_acris_doc_id,p_source_key,p_source_url),case when v_source='acris' then v_gate else null end,
    case when v_source='acris' and v_gate then v_deed_amount else null end,p_confidence);
  v_seller_result:=public.sbi_attach_party(v_deal_id,'seller',p_seller,p_provenance->>'seller_address',v_source,
    coalesce(p_acris_doc_id,p_source_key,p_source_url),case when v_source='acris' then v_gate else null end,
    case when v_source='acris' and v_gate then v_deed_amount else null end,p_confidence);

  return jsonb_build_object('status',case when v_existing.deal_id is null then 'inserted' else 'duplicate' end,
    'deal_id',v_deal_id,'property_id',v_property_id,'conflicts',to_jsonb(v_conflicts),
    'buyer_status',v_buyer_result->>'status','seller_status',v_seller_result->>'status');
end;
$$;

create or replace function public.sync_upsert_deals(rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path=public,extensions as $$
declare
  r jsonb;
  v jsonb;
  n_inserted int:=0;
  n_dup int:=0;
  n_res int:=0;
  n_invalid int:=0;
  n_parties int:=0;
  n_errors int:=0;
  n_conflicts int:=0;
  samples jsonb:='[]'::jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) loop
    begin
      v:=public.sbi_ingest_deal(
        p_address=>coalesce(r->>'address',r->>'address_raw'),
        p_borough=>r->>'borough',
        p_neighborhood=>r->>'neighborhood',
        p_market=>r->>'market',
        p_asset_type=>r->>'asset_type',
        p_transaction_type=>coalesce(r->>'transaction_type','sale'),
        p_sale_price=>nullif(r->>'sale_price','')::numeric,
        p_units=>nullif(r->>'units','')::integer,
        p_sqft=>nullif(r->>'sqft','')::integer,
        p_sale_date=>nullif(r->>'sale_date','')::date,
        p_post_date=>nullif(r->>'post_date','')::timestamptz,
        p_buyer=>r->>'buyer',
        p_seller=>r->>'seller',
        p_source_system=>r->>'source_system',
        p_source_url=>r->>'source_url',
        p_source_key=>coalesce(r->>'shortcode',r->>'source_key'),
        p_acris_doc_id=>coalesce(r->>'acris_doc_id',case when r->>'source_system'='acris' then replace(r->>'shortcode','ACRIS-','') end),
        p_confidence=>nullif(r->>'confidence','')::integer,
        p_parse_status=>coalesce(r->>'parse_status','ok'),
        p_verification_status=>coalesce(r->>'verification_status',case when r->>'source_system'='acris' then 'verified' else 'unverified' end),
        p_record_quality=>coalesce(r->>'record_quality','ok'),
        p_notes=>r->>'notes',
        p_provenance=>coalesce(r->'provenance','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object(
          'bbl',r->>'bbl','bldg_class',coalesce(r->>'bldg_class',r->>'building_class'),'deed_amount',r->>'deed_amount',
          'buyer_address',r->>'buyer_address','seller_address',r->>'seller_address'))
      );
      if v->>'status'='inserted' then n_inserted:=n_inserted+1;
      elsif v->>'status'='duplicate' then n_dup:=n_dup+1;
      elsif v->>'reason' in ('excluded_asset_type','residential_building_class','exclusion_ledger') then n_res:=n_res+1;
      else n_invalid:=n_invalid+1;
      end if;
      if v->>'buyer_status'='attached' then n_parties:=n_parties+1; end if;
      if v->>'seller_status'='attached' then n_parties:=n_parties+1; end if;
      n_conflicts:=n_conflicts+coalesce(jsonb_array_length(v->'conflicts'),0);
    exception when others then
      n_errors:=n_errors+1;
      if jsonb_array_length(samples)<5 then samples:=samples||jsonb_build_array(sqlerrm); end if;
    end;
  end loop;
  return jsonb_build_object('inserted',n_inserted,'dup',n_dup,'skipped_residential',n_res,
    'skipped_invalid',n_invalid,'parties',n_parties,'contacts',0,'errors',n_errors,
    'conflicts_flagged',n_conflicts,'error_samples',samples);
end;
$$;

create or replace function public.sbi_apply_acris_party_fill(
  p_deal_id uuid,
  p_doc_id text,
  p_deed_amount numeric,
  p_deed_date date,
  p_buyer text default null,
  p_seller text default null,
  p_buyer_address text default null,
  p_seller_address text default null
) returns jsonb
language plpgsql volatile security definer set search_path=public,extensions as $$
declare
  v_price numeric;
  v_date date;
  v_gate boolean:=false;
  v_b jsonb;
  v_s jsonb;
  v_filled text[]:='{}';
begin
  select sale_price,sale_date into v_price,v_date from public.sbi_deals where deal_id=p_deal_id;
  if not found then return jsonb_build_object('status','no_such_deal'); end if;
  if v_price is not null and v_price>0 then
    v_gate:=p_deed_amount is not null and p_deed_amount>0 and abs(p_deed_amount-v_price)/v_price<=0.03;
  elsif v_date is not null and p_deed_date is not null then
    v_gate:=abs(v_date-p_deed_date)<=60;
  end if;
  if not v_gate then return jsonb_build_object('status','gated_out'); end if;

  v_b:=public.sbi_attach_party(p_deal_id,'buyer',p_buyer,p_buyer_address,'acris',p_doc_id,true,p_deed_amount,100);
  v_s:=public.sbi_attach_party(p_deal_id,'seller',p_seller,p_seller_address,'acris',p_doc_id,true,p_deed_amount,100);
  if v_b->>'status'='attached' then v_filled:=array_append(v_filled,'buyer'); end if;
  if v_s->>'status'='attached' then v_filled:=array_append(v_filled,'seller'); end if;
  if v_price is null and p_deed_amount>0 then
    update public.sbi_deals set sale_price=p_deed_amount,updated_at=now() where deal_id=p_deal_id and sale_price is null;
    v_filled:=array_append(v_filled,'sale_price');
  end if;
  update public.sbi_deals set
    notes=case when position('parties from ACRIS '||p_doc_id in coalesce(notes,''))>0 then notes
      else trim(both ' |' from coalesce(notes,'')||' | parties from ACRIS '||p_doc_id||' (amount-gated)') end,
    updated_at=now()
  where deal_id=p_deal_id;
  return jsonb_build_object('status',case when cardinality(v_filled)>0 then 'filled' else 'nothing_to_fill' end,'filled',to_jsonb(v_filled));
end;
$$;

grant execute on function public.sbi_ingest_deal(text,text,text,text,text,text,numeric,integer,integer,date,timestamptz,text,text,text,text,text,text,integer,text,text,text,text,jsonb) to service_role;
grant execute on function public.sync_upsert_deals(jsonb) to service_role;
grant execute on function public.sbi_apply_acris_party_fill(uuid,text,numeric,date,text,text,text,text) to service_role;
