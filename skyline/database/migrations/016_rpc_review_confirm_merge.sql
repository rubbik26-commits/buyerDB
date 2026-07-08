-- 016_rpc_review_confirm_merge.sql
-- Allows the live RPC Review tab to confirm entity merges by writing sbi_entity_aliases.

drop function if exists api_review_act(uuid,text,text);

create or replace function api_review_act(
  review_id uuid,
  action text,
  entity_id uuid default null,
  user_id text default 'system'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare payload jsonb; alias_raw text; alias_norm text;
begin
  select r.payload into payload from sbi_review_queue r where r.review_id=api_review_act.review_id;

  if action='confirm_merge' then
    if api_review_act.entity_id is null then
      return jsonb_build_object('error','confirm_merge requires entity_id');
    end if;
    alias_raw := coalesce(payload->>'name', payload->>'entity_name', payload->>'alias');
    if coalesce(trim(alias_raw),'') <> '' then
      alias_norm := trim(regexp_replace(regexp_replace(upper(alias_raw),'[^A-Z0-9]+',' ','g'),'\s+',' ','g'));
      insert into sbi_entity_aliases(entity_id, alias_raw, alias_norm, source)
      values(api_review_act.entity_id, alias_raw, alias_norm, 'review_confirm')
      on conflict do nothing;
    end if;
    update sbi_review_queue
    set status='resolved', resolved_by=coalesce(api_review_act.user_id,'system'), resolved_at=now()
    where sbi_review_queue.review_id=api_review_act.review_id;
    return jsonb_build_object('status','merged','entity_id',api_review_act.entity_id);
  end if;

  if action in ('resolve','dismiss') then
    update sbi_review_queue
    set status=case when action='resolve' then 'resolved' else 'dismissed' end,
        resolved_by=coalesce(api_review_act.user_id,'system'),
        resolved_at=now()
    where sbi_review_queue.review_id=api_review_act.review_id;
    return jsonb_build_object('status','ok');
  end if;

  return jsonb_build_object('error','Unsupported action');
end;
$$;

grant execute on function api_review_act(uuid,text,uuid,text) to anon;
notify pgrst, 'reload schema';
