-- 020_blueprint_runtime_hardening.sql
-- Applied to production project pdvyuepsdnpxctmagdcq on 2026-07-10.

create table if not exists public.sbi_ai_logs (
  log_id uuid primary key default gen_random_uuid(),
  user_id text,
  provider text not null,
  model text,
  purpose text,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  fallback_from text,
  status text not null,
  created_at timestamptz default now()
);
create index if not exists sbi_ai_logs_created_idx on public.sbi_ai_logs(created_at desc);

-- Imported ACRIS parties predate verified_deed_amount. Preserve their already-gated
-- evidence before strengthening the physical database constraint.
update public.sbi_deal_parties dp
set verified_deed_amount = coalesce(d.sale_price, 0)
from public.sbi_deals d
where dp.deal_id=d.deal_id
  and dp.source_system='acris'
  and dp.amount_gate_passed is true
  and dp.verified_deed_amount is null;

alter table public.sbi_deal_parties drop constraint if exists sbi_acris_requires_amount_gate;
alter table public.sbi_deal_parties add constraint sbi_acris_requires_amount_gate check (
  source_system <> 'acris'
  or (amount_gate_passed is true and verified_deed_amount is not null and provenance_ref is not null)
);

create or replace function public.sbi_queue_review(
  p_object_type text,
  p_object_id text,
  p_issue_class text,
  p_payload jsonb default '{}'::jsonb,
  p_severity text default 'normal'
) returns uuid
language plpgsql volatile security definer set search_path=public as $$
declare v_id uuid;
begin
  select review_id into v_id
  from public.sbi_review_queue
  where status='open'
    and object_type=p_object_type
    and object_id=p_object_id
    and issue_class=p_issue_class
  order by created_at desc limit 1;
  if v_id is null then
    insert into public.sbi_review_queue(object_type,object_id,issue_class,severity,payload)
    values(p_object_type,p_object_id,p_issue_class,coalesce(p_severity,'normal'),coalesce(p_payload,'{}'::jsonb))
    returning review_id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.sbi_log_ai(
  p_user_id text,
  p_provider text,
  p_model text,
  p_purpose text,
  p_latency_ms int,
  p_input_tokens int,
  p_output_tokens int,
  p_fallback_from text,
  p_status text
) returns uuid
language plpgsql volatile security definer set search_path=public as $$
declare v_id uuid;
begin
  insert into public.sbi_ai_logs(user_id,provider,model,purpose,latency_ms,input_tokens,output_tokens,fallback_from,status)
  values(p_user_id,p_provider,p_model,p_purpose,p_latency_ms,p_input_tokens,p_output_tokens,p_fallback_from,p_status)
  returning log_id into v_id;
  return v_id;
end;
$$;

create or replace function public.sbi_attach_party(
  p_deal_id uuid,
  p_role text,
  p_name text,
  p_mailing_address text,
  p_source_system text,
  p_provenance_ref text,
  p_amount_gate_passed boolean default null,
  p_verified_deed_amount numeric default null,
  p_match_confidence integer default null
) returns jsonb
language plpgsql volatile security definer set search_path=public,extensions as $$
declare
  v_entity_id uuid;
  v_existing uuid;
begin
  if p_name is null or trim(p_name)='' or lower(trim(p_name)) in ('unknown','undisclosed','n/a','na','null','none','confidential') then
    return jsonb_build_object('status','skipped_placeholder');
  end if;
  if p_role not in ('buyer','seller','lender','borrower','landlord','tenant','owner') then
    return jsonb_build_object('status','rejected_role');
  end if;
  if p_source_system='acris' and not (
    p_amount_gate_passed is true and p_verified_deed_amount is not null and p_provenance_ref is not null
  ) then
    perform public.sbi_queue_review('deal',p_deal_id::text,'acris_party_without_gate',
      jsonb_build_object('role',p_role,'incoming_name',p_name,'provenance_ref',p_provenance_ref));
    return jsonb_build_object('status','gated_out');
  end if;

  v_entity_id := public.sbi_get_or_create_entity(p_name);
  if v_entity_id is null then return jsonb_build_object('status','invalid_entity'); end if;

  select entity_id into v_existing
  from public.sbi_deal_parties
  where deal_id=p_deal_id and role=p_role and entity_id<>v_entity_id
  limit 1;
  if v_existing is not null then
    perform public.sbi_queue_review('deal',p_deal_id::text,'party_conflict',
      jsonb_build_object('role',p_role,'existing_entity_id',v_existing,'incoming_entity_id',v_entity_id,
        'incoming_name',p_name,'source_system',p_source_system,'provenance_ref',p_provenance_ref));
    return jsonb_build_object('status','conflict','entity_id',v_entity_id);
  end if;

  insert into public.sbi_deal_parties(
    deal_id,entity_id,role,mailing_address,source_system,provenance_ref,
    amount_gate_passed,verified_deed_amount,match_confidence
  ) values(
    p_deal_id,v_entity_id,p_role,nullif(trim(p_mailing_address),''),p_source_system,p_provenance_ref,
    p_amount_gate_passed,p_verified_deed_amount,p_match_confidence
  ) on conflict (deal_id,entity_id,role) do update set
    mailing_address=coalesce(public.sbi_deal_parties.mailing_address,excluded.mailing_address),
    provenance_ref=coalesce(public.sbi_deal_parties.provenance_ref,excluded.provenance_ref),
    amount_gate_passed=coalesce(public.sbi_deal_parties.amount_gate_passed,excluded.amount_gate_passed),
    verified_deed_amount=coalesce(public.sbi_deal_parties.verified_deed_amount,excluded.verified_deed_amount),
    match_confidence=greatest(coalesce(public.sbi_deal_parties.match_confidence,0),coalesce(excluded.match_confidence,0));

  return jsonb_build_object('status','attached','entity_id',v_entity_id);
end;
$$;

grant execute on function public.sbi_log_ai(text,text,text,text,int,int,int,text,text) to service_role;
grant execute on function public.sbi_attach_party(uuid,text,text,text,text,text,boolean,numeric,integer) to service_role;
