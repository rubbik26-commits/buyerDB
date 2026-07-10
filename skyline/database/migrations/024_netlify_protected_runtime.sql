-- 024_netlify_protected_runtime.sql
-- The value stored here is a one-way SHA-256 verifier for the Netlify-only runtime
-- credential; the credential itself is never committed or returned by an API.

create table if not exists public.sbi_runtime_config (
  config_key text primary key,
  value_hash text not null,
  updated_at timestamptz default now()
);
alter table public.sbi_runtime_config enable row level security;
revoke all on public.sbi_runtime_config from anon,authenticated;

-- Production migration installs/rotates this verifier out-of-band. Do not replace a
-- live verifier from a fresh-repo migration without rotating Netlify at the same time.
insert into public.sbi_runtime_config(config_key,value_hash)
values('netlify_runtime','92a739936cbbb955a24a6ebef02343ddd5b414aeb2679d24f23ae88a6d949b4e')
on conflict(config_key) do nothing;

create or replace function public.sbi_runtime_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path=public,extensions as $$
  select coalesce(
    encode(digest(coalesce(p_secret,''),'sha256'),'hex') =
      (select value_hash from public.sbi_runtime_config where config_key='netlify_runtime'),
    false
  );
$$;
revoke all on function public.sbi_runtime_secret_ok(text) from public;
grant execute on function public.sbi_runtime_secret_ok(text) to anon,authenticated,service_role;

create or replace function public.sbi_runtime_request_run(
  p_secret text,
  p_job text,
  p_user_id text default 'broker',
  p_options jsonb default '{}'::jsonb
) returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_id uuid;
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  if p_job not in ('traded_refresh','acris_refresh','crexi_refresh','property_owner_refresh','rolling_sales','dos_enrich','phase2_enrichment','full_refresh') then
    return jsonb_build_object('error','Unsupported scraper job');
  end if;
  insert into public.sbi_source_runs(source,job,status,stats)
  values('netlify',p_job,'requested',jsonb_build_object('requested_by',coalesce(p_user_id,'broker'),'options',coalesce(p_options,'{}'::jsonb)))
  returning run_id into v_id;
  return jsonb_build_object('run_id',v_id,'job',p_job,'status','requested');
end;
$$;

create or replace function public.sbi_runtime_active_run(p_secret text,p_job text,p_minutes int default 30)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  select to_jsonb(x) into v from (
    select run_id,job,status,started_at
    from public.sbi_source_runs
    where job=p_job and status in ('requested','running')
      and started_at>=now()-(greatest(p_minutes,1)||' minutes')::interval
    order by started_at desc limit 1
  ) x;
  return coalesce(v,'null'::jsonb);
end;
$$;

create or replace function public.sbi_runtime_update_run(
  p_secret text,p_run_id uuid,p_status text,p_stats jsonb default '{}'::jsonb,p_error text default null
) returns jsonb language plpgsql volatile security definer set search_path=public as $$
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  update public.sbi_source_runs set
    status=p_status,
    stats=coalesce(p_stats,'{}'::jsonb),
    error=p_error,
    started_at=case when p_status='running' then now() else started_at end,
    finished_at=case when p_status in ('completed','failed','timeout','quota_blocked','completed_with_errors') then now() else finished_at end
  where run_id=p_run_id;
  return jsonb_build_object('updated',found,'run_id',p_run_id,'status',p_status);
end;
$$;

create or replace function public.sbi_runtime_rolling_targets(p_secret text,p_lim int default 400)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v from public.sbi_rolling_targets(p_lim) x;
  return v;
end;
$$;

create or replace function public.sbi_runtime_rolling_apply(
  p_secret text,p_deal_id uuid,p_sqft int default null,p_units int default null,p_source_rows jsonb default '[]'::jsonb
) returns jsonb language plpgsql volatile security definer set search_path=public as $$
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  return public.sbi_rolling_apply(p_deal_id,p_sqft,p_units,p_source_rows);
end;
$$;

create or replace function public.sbi_runtime_phase2_targets(p_secret text,p_lim int default 400)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v from public.sbi_phase2_targets(p_lim) x;
  return v;
end;
$$;

create or replace function public.sbi_runtime_phase2_apply(
  p_secret text,p_deal_id uuid,p_doc_id text,p_deed_amount numeric,p_deed_date date,
  p_buyer text default null,p_seller text default null,p_buyer_address text default null,p_seller_address text default null
) returns jsonb language plpgsql volatile security definer set search_path=public as $$
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  return public.sbi_apply_acris_party_fill(p_deal_id,p_doc_id,p_deed_amount,p_deed_date,p_buyer,p_seller,p_buyer_address,p_seller_address);
end;
$$;

create or replace function public.sbi_runtime_sync(p_secret text,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  return public.sync_upsert_deals(p_rows);
end;
$$;

create or replace function public.sbi_runtime_broker_contacts(p_secret text,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
begin
  if not public.sbi_runtime_secret_ok(p_secret) then raise exception 'runtime authorization failed'; end if;
  return public.upsert_broker_contacts(p_rows);
end;
$$;

revoke all on function
  public.sbi_runtime_request_run(text,text,text,jsonb),
  public.sbi_runtime_active_run(text,text,int),
  public.sbi_runtime_update_run(text,uuid,text,jsonb,text),
  public.sbi_runtime_rolling_targets(text,int),
  public.sbi_runtime_rolling_apply(text,uuid,int,int,jsonb),
  public.sbi_runtime_phase2_targets(text,int),
  public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text),
  public.sbi_runtime_sync(text,jsonb),
  public.sbi_runtime_broker_contacts(text,jsonb)
from public;

grant execute on function
  public.sbi_runtime_request_run(text,text,text,jsonb),
  public.sbi_runtime_active_run(text,text,int),
  public.sbi_runtime_update_run(text,uuid,text,jsonb,text),
  public.sbi_runtime_rolling_targets(text,int),
  public.sbi_runtime_rolling_apply(text,uuid,int,int,jsonb),
  public.sbi_runtime_phase2_targets(text,int),
  public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text),
  public.sbi_runtime_sync(text,jsonb),
  public.sbi_runtime_broker_contacts(text,jsonb)
to anon,authenticated;

revoke execute on function public.api_request_scrape(text,text,jsonb) from anon;
revoke execute on function public.sbi_rolling_targets(int) from anon,authenticated;
revoke execute on function public.sbi_rolling_apply(uuid,int,int,jsonb) from anon,authenticated;
revoke execute on function public.sbi_phase2_targets(int) from anon,authenticated;
revoke execute on function public.sbi_apply_acris_party_fill(uuid,text,numeric,date,text,text,text,text) from anon,authenticated;
revoke execute on function public.sync_upsert_deals(jsonb) from anon,authenticated;
revoke execute on function public.upsert_broker_contacts(jsonb) from anon,authenticated;
notify pgrst,'reload schema';
