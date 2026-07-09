create or replace function public.dos_targets(lim int default 400)
returns table(entity_id uuid, display_name text, norm_name text)
language sql stable security definer set search_path=public as $$
  select e.entity_id, e.display_name, e.norm_name
  from public.sbi_entities e
  where e.norm_name is not null
    and (e.mailing_address is null or e.key_person is null)
    and e.display_name !~* '^(UNKNOWN|UNDISCLOSED|N/A|NA)$'
  order by e.updated_at asc nulls first, e.created_at asc
  limit least(greatest(dos_targets.lim,1),2000);
$$;

create or replace function public.dos_apply(rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  r jsonb;
  v_entity uuid;
  v_mailing text;
  v_key_person text;
  v_mailing_filled int := 0;
  v_contacts_inserted int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) loop
    v_entity := nullif(r->>'entity_id','')::uuid;
    v_mailing := nullif(trim(r->>'mailing'),'');
    v_key_person := nullif(trim(r->>'key_person'),'');
    if v_entity is null then continue; end if;

    update public.sbi_entities e
       set mailing_address = coalesce(e.mailing_address, v_mailing),
           key_person = coalesce(e.key_person, v_key_person),
           enrichment_status = 'dos_checked',
           provenance = coalesce(e.provenance,'{}'::jsonb) || jsonb_build_object('nys_dos_checked_at', now()),
           updated_at = now()
     where e.entity_id = v_entity;
    if found and v_mailing is not null then v_mailing_filled := v_mailing_filled + 1; end if;

    if v_key_person is not null or v_mailing is not null then
      insert into public.sbi_contacts(entity_id, person_name, company, mailing_address, source, confidence, provenance)
      select v_entity, v_key_person, e.display_name, v_mailing, 'nys_dos', 80,
             jsonb_build_object('source','nys_dos','enriched_at',now())
      from public.sbi_entities e
      where e.entity_id = v_entity
        and not exists (
          select 1 from public.sbi_contacts c
          where c.entity_id = v_entity and c.source='nys_dos'
        );
      if found then v_contacts_inserted := v_contacts_inserted + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('mailing_filled', v_mailing_filled, 'contacts_inserted', v_contacts_inserted);
end;
$$;

create or replace function public.upsert_broker_contacts(rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  r jsonb;
  v_name text;
  v_company text;
  v_phone text;
  v_entity uuid;
  v_entities int := 0;
  v_contacts int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) loop
    v_name := nullif(trim(r->>'name'),'');
    v_company := nullif(trim(r->>'company'),'');
    v_phone := nullif(trim(r->>'phone'),'');
    if v_name is null then continue; end if;
    v_entity := public.sbi_get_or_create_entity(coalesce(v_company, v_name));
    v_entities := v_entities + 1;
    insert into public.sbi_contacts(entity_id, person_name, company, phone, source, confidence, provenance)
    values(v_entity, v_name, v_company, v_phone, 'crexi_broker', 70, jsonb_build_object('source','crexi','enriched_at',now()))
    on conflict do nothing;
    if found then v_contacts := v_contacts + 1; end if;
  end loop;
  return jsonb_build_object('entities_seen', v_entities, 'contacts_inserted', v_contacts);
end;
$$;

grant execute on function public.dos_targets(int), public.dos_apply(jsonb), public.upsert_broker_contacts(jsonb) to anon;
notify pgrst, 'reload schema';
