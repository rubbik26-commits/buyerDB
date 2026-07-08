-- 018_rpc_workflow_persistence.sql
-- Completes RPC-mode workflow persistence for audit cleanup and outreach drafts.

create or replace function api_fix_stale_runs() returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare fixed jsonb;
begin
  with updated as (
    update sbi_source_runs
       set status='timeout', finished_at=now(), error=coalesce(error,'Marked timeout by admin audit')
     where status='running'
       and started_at < now() - interval '1 hour'
     returning run_id, job, started_at, finished_at, status
  )
  select coalesce(jsonb_agg(to_jsonb(updated)), '[]'::jsonb) into fixed from updated;
  return jsonb_build_object('fixed', fixed, 'count', jsonb_array_length(fixed));
end;
$$;

create or replace function api_outreach_draft(
  entity_id uuid,
  property_summary text default null,
  user_id text default 'broker'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  ent jsonb;
  contacts jsonb;
  recent jsonb;
  first_name text;
  recent_line text := '';
  property_line text;
  subject text := 'NYC investment sale opportunity';
  body text;
  draft_row jsonb;
  new_draft_id uuid;
begin
  select to_jsonb(e) into ent from sbi_entities e where e.entity_id=api_outreach_draft.entity_id;
  if ent is null then
    return jsonb_build_object('error','entity not found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.is_primary desc nulls last, c.created_at desc), '[]'::jsonb)
    into contacts
    from sbi_contacts c
   where c.entity_id=api_outreach_draft.entity_id;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.sale_date desc nulls last), '[]'::jsonb)
    into recent
    from (
      select d.sale_date, p.address_raw as address, p.borough, d.asset_type, d.sale_price
        from sbi_deal_parties dp
        join sbi_deals d using(deal_id)
        join sbi_properties p using(property_id)
       where dp.entity_id=api_outreach_draft.entity_id and dp.role='buyer'
       order by d.sale_date desc nulls last
       limit 5
    ) x;

  select nullif(split_part(coalesce((contacts->0->>'person_name'), ''), ' ', 1), '') into first_name;
  if jsonb_array_length(recent) > 0 then
    recent_line := ' I noticed your recent activity including ' ||
      (select string_agg(format('%s (%s, %s, $%s)', r->>'address', coalesce(r->>'borough','NYC'), coalesce(r->>'asset_type','asset'), to_char((r->>'sale_price')::numeric, 'FM999,999,999,999')), '; ')
         from (select value r from jsonb_array_elements(recent) limit 3) s) || '.';
  end if;
  property_line := case when coalesce(trim(api_outreach_draft.property_summary),'') <> ''
    then 'I am reaching out about ' || trim(api_outreach_draft.property_summary) || '.'
    else 'I am reaching out about a potential NYC investment sale opportunity.' end;
  body := (case when first_name is null then 'Hi,' else 'Hi ' || first_name || ',' end) || E'\n\n' || property_line || recent_line || E'\n\n' ||
          'Given your transaction history, I thought this may be worth putting in front of you. If it is not a fit, no problem - I would still appreciate knowing what you are focused on right now.' || E'\n\nBest,\nRobert';

  insert into sbi_outreach_drafts(entity_id, user_id, property_summary, subject, body)
  values(api_outreach_draft.entity_id, coalesce(api_outreach_draft.user_id,'broker'), api_outreach_draft.property_summary, subject, body)
  returning draft_id into new_draft_id;

  select to_jsonb(d) into draft_row from sbi_outreach_drafts d where d.draft_id = new_draft_id;

  return jsonb_build_object('entity', ent, 'contacts', contacts, 'recent_deals', recent, 'subject', subject, 'body', body, 'draft', draft_row);
end;
$$;

grant execute on function api_fix_stale_runs(), api_outreach_draft(uuid,text,text) to anon;
notify pgrst, 'reload schema';
