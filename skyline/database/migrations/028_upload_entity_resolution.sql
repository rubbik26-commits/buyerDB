-- 028_upload_entity_resolution.sql
-- Implements the blueprint upload workflow: exact/alias auto-match, fuzzy matches
-- routed to human review, sourced contact deduplication, E.164 phone normalization,
-- uploaded interaction dates, and review confirmation that actually imports the row.

create or replace function public.sbi_upload_value(
  p_raw jsonb,
  p_mapping jsonb,
  p_canonical text
) returns text
language sql immutable set search_path=public as $$
  select nullif(btrim(p_raw->>m.key),'')
  from jsonb_each_text(coalesce(p_mapping,'{}'::jsonb)) m
  where m.value=p_canonical
  limit 1
$$;

create or replace function public.sbi_normalize_phone_e164(v text)
returns text
language plpgsql immutable set search_path=public as $$
declare digits text;
begin
  digits := regexp_replace(coalesce(v,''),'[^0-9]','','g');
  if digits='' then return null; end if;
  if length(digits)=10 then return '+1'||digits; end if;
  if length(digits)=11 and left(digits,1)='1' then return '+'||digits; end if;
  if length(digits) between 8 and 15 then return '+'||digits; end if;
  return null;
end;
$$;

create or replace function public.sbi_upload_timestamp(v text)
returns timestamptz
language plpgsql immutable set search_path=public as $$
begin
  if nullif(btrim(v),'') is null then return null; end if;
  begin
    return v::timestamptz;
  exception when others then
    begin
      return (v::date)::timestamptz;
    exception when others then
      return null;
    end;
  end;
end;
$$;

create or replace function public.sbi_upload_apply_row(
  p_upload_id uuid,
  p_row_num integer,
  p_entity_id uuid,
  p_user_id text default 'broker',
  p_resolution_method text default 'exact'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  v_raw jsonb;
  v_mapping jsonb;
  v_entity_name text;
  v_person text;
  v_phone_raw text;
  v_phone text;
  v_email text;
  v_website text;
  v_mailing text;
  v_title text;
  v_role_raw text;
  v_role text;
  v_notes text;
  v_channel_raw text;
  v_channel text;
  v_last_contact text;
  v_occurred timestamptz;
  v_contact uuid;
  v_contact_created integer := 0;
  v_contact_updated integer := 0;
  v_interaction_created integer := 0;
begin
  select ur.raw,u.column_mapping
  into v_raw,v_mapping
  from public.sbi_upload_rows ur
  join public.sbi_uploads u using(upload_id)
  where ur.upload_id=p_upload_id and ur.row_num=p_row_num
  for update;

  if v_raw is null then
    return jsonb_build_object('error','upload row not found');
  end if;

  v_entity_name := public.sbi_upload_value(v_raw,v_mapping,'entity_name');
  v_person := public.sbi_upload_value(v_raw,v_mapping,'person_name');
  v_phone_raw := public.sbi_upload_value(v_raw,v_mapping,'phone');
  v_phone := public.sbi_normalize_phone_e164(v_phone_raw);
  v_email := lower(public.sbi_upload_value(v_raw,v_mapping,'email'));
  v_website := public.sbi_upload_value(v_raw,v_mapping,'website');
  v_mailing := public.sbi_upload_value(v_raw,v_mapping,'mailing_address');
  v_title := public.sbi_upload_value(v_raw,v_mapping,'title');
  v_role_raw := lower(coalesce(public.sbi_upload_value(v_raw,v_mapping,'role'),'other'));
  v_role := case
    when v_role_raw in ('buyer','acquisitions','acquisition') then 'Buyer'
    when v_role_raw in ('seller','dispositions','disposition') then 'Seller'
    when v_role_raw in ('owner','principal') then 'Owner'
    when v_role_raw in ('broker','agent') then 'Broker'
    when v_role_raw in ('lender','bank') then 'Lender'
    else 'Other'
  end;
  v_notes := public.sbi_upload_value(v_raw,v_mapping,'interaction_notes');
  v_channel_raw := lower(coalesce(public.sbi_upload_value(v_raw,v_mapping,'channel'),'other'));
  v_channel := case when v_channel_raw in ('call','email','text','meeting','mail','other') then v_channel_raw else 'other' end;
  v_last_contact := public.sbi_upload_value(v_raw,v_mapping,'last_contact_date');
  v_occurred := coalesce(public.sbi_upload_timestamp(v_last_contact),now());

  if coalesce(v_person,v_phone,v_email,v_website,v_mailing,v_title) is not null then
    select c.contact_id into v_contact
    from public.sbi_contacts c
    where c.entity_id=p_entity_id
      and (c.role=v_role or c.role is null)
      and (c.phone is null or v_phone is null or public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone))
      and (c.email is null or v_email is null or public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email))
      and (c.website is null or v_website is null or public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website))
      and (c.mailing_address is null or v_mailing is null or public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing))
      and (
        (v_phone is not null and public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone)) or
        (v_email is not null and public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email)) or
        (v_website is not null and public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website)) or
        (v_mailing is not null and public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing)) or
        (v_person is not null and public.sbi_norm_entity(c.person_name)=public.sbi_norm_entity(v_person))
      )
    order by c.is_primary desc,c.confidence desc nulls last,c.created_at
    limit 1;

    if v_contact is null then
      insert into public.sbi_contacts(
        entity_id,person_name,company,title,role,phone,email,website,mailing_address,
        source,confidence,is_primary,provenance
      ) values (
        p_entity_id,v_person,v_entity_name,v_title,v_role,v_phone,v_email,v_website,v_mailing,
        'upload:'||p_upload_id::text,100,
        not exists(select 1 from public.sbi_contacts x where x.entity_id=p_entity_id and x.is_primary is true),
        jsonb_strip_nulls(jsonb_build_object(
          'upload_id',p_upload_id,'row_num',p_row_num,'resolution_method',p_resolution_method,
          'raw_phone',nullif(v_phone_raw,''),'imported_at',now()
        ))
      ) returning contact_id into v_contact;
      v_contact_created := 1;
    else
      update public.sbi_contacts c set
        person_name=coalesce(c.person_name,v_person),
        company=coalesce(c.company,v_entity_name),
        title=coalesce(c.title,v_title),
        role=coalesce(c.role,v_role),
        phone=coalesce(c.phone,v_phone),
        email=coalesce(c.email,v_email),
        website=coalesce(c.website,v_website),
        mailing_address=coalesce(c.mailing_address,v_mailing),
        confidence=greatest(coalesce(c.confidence,0),100),
        provenance=coalesce(c.provenance,'{}'::jsonb)||jsonb_build_object(
          'last_upload_id',p_upload_id,'last_upload_row',p_row_num,
          'last_resolution_method',p_resolution_method,'last_seen_at',now()
        )
      where c.contact_id=v_contact;
      v_contact_updated := 1;
    end if;
  end if;

  if v_notes is not null or v_last_contact is not null then
    if not exists(
      select 1 from public.sbi_interactions i
      where i.entity_id=p_entity_id
        and i.occurred_at=v_occurred
        and coalesce(i.notes,'')=coalesce(v_notes,'')
        and i.subject='Uploaded contact note'
    ) then
      insert into public.sbi_interactions(
        entity_id,contact_id,user_id,channel,occurred_at,subject,notes,outcome
      ) values (
        p_entity_id,v_contact,coalesce(p_user_id,'broker'),v_channel,v_occurred,
        'Uploaded contact note',v_notes,'uploaded'
      );
      v_interaction_created := 1;
    end if;
  end if;

  update public.sbi_upload_rows set
    status='imported',
    resolution=jsonb_build_object(
      'entity_id',p_entity_id,'method',p_resolution_method,
      'contact_id',v_contact,'imported_at',now()
    )
  where upload_id=p_upload_id and row_num=p_row_num;

  return jsonb_build_object(
    'entity_id',p_entity_id,
    'contact_id',v_contact,
    'contacts_created',v_contact_created,
    'contacts_updated',v_contact_updated,
    'interactions_created',v_interaction_created
  );
end;
$$;

create or replace function public.api_upload_resolve(
  upload_id uuid,
  mapping jsonb default '{}'::jsonb,
  user_id text default 'broker'
) returns jsonb
language plpgsql volatile security definer set search_path=public,extensions as $$
declare
  r record;
  v_name text;
  v_norm text;
  v_property text;
  v_property_norm text;
  v_borough text;
  v_asset text;
  v_entity uuid;
  v_exact_method text;
  v_candidates jsonb;
  v_top_score numeric;
  v_apply jsonb;
  v_review uuid;
  v_auto integer := 0;
  v_alias integer := 0;
  v_new integer := 0;
  v_needs_review integer := 0;
  v_skipped integer := 0;
  v_contacts_created integer := 0;
  v_contacts_updated integer := 0;
  v_interactions integer := 0;
begin
  if not exists(select 1 from public.sbi_uploads u where u.upload_id=api_upload_resolve.upload_id) then
    return jsonb_build_object('error','upload not found');
  end if;

  update public.sbi_uploads set
    status='resolving',
    column_mapping=coalesce(api_upload_resolve.mapping,'{}'::jsonb)
  where sbi_uploads.upload_id=api_upload_resolve.upload_id;

  for r in
    select ur.row_num,ur.raw
    from public.sbi_upload_rows ur
    where ur.upload_id=api_upload_resolve.upload_id
      and ur.status in ('staged','pending')
    order by ur.row_num
  loop
    v_name := public.sbi_upload_value(r.raw,api_upload_resolve.mapping,'entity_name');
    v_norm := public.sbi_norm_entity(v_name);
    v_property := public.sbi_upload_value(r.raw,api_upload_resolve.mapping,'property_address');
    v_property_norm := public.sbi_norm_address(v_property);
    v_borough := public.sbi_upload_value(r.raw,api_upload_resolve.mapping,'borough');
    v_asset := public.sbi_upload_value(r.raw,api_upload_resolve.mapping,'asset_type');
    v_entity := null;
    v_exact_method := null;

    if v_norm is null or public.sbi_placeholder_entity(v_name) then
      update public.sbi_upload_rows set status='rejected',resolution=jsonb_build_object('reason','missing_or_placeholder_entity_name')
      where sbi_upload_rows.upload_id=api_upload_resolve.upload_id and row_num=r.row_num;
      v_skipped := v_skipped+1;
      continue;
    end if;

    select e.entity_id,'exact_name' into v_entity,v_exact_method
    from public.sbi_entities e
    where e.norm_name=v_norm
    limit 1;

    if v_entity is null then
      select a.entity_id,'exact_alias' into v_entity,v_exact_method
      from public.sbi_entity_aliases a
      where a.alias_norm=v_norm
      limit 1;
    end if;

    if v_entity is not null then
      v_apply := public.sbi_upload_apply_row(api_upload_resolve.upload_id,r.row_num,v_entity,api_upload_resolve.user_id,v_exact_method);
      v_contacts_created := v_contacts_created+coalesce((v_apply->>'contacts_created')::integer,0);
      v_contacts_updated := v_contacts_updated+coalesce((v_apply->>'contacts_updated')::integer,0);
      v_interactions := v_interactions+coalesce((v_apply->>'interactions_created')::integer,0);
      if v_exact_method='exact_alias' then v_alias:=v_alias+1; else v_auto:=v_auto+1; end if;
      continue;
    end if;

    with candidate_base as (
      select e.entity_id,e.display_name,e.norm_name,e.is_spv_suspect,
        greatest(
          similarity(e.norm_name,v_norm),
          coalesce((select max(similarity(a.alias_norm,v_norm)) from public.sbi_entity_aliases a where a.entity_id=e.entity_id),0)
        ) as name_score,
        exists(
          select 1 from public.sbi_deal_parties dp
          join public.sbi_deals d using(deal_id)
          join public.sbi_properties p using(property_id)
          where dp.entity_id=e.entity_id
            and v_property_norm is not null
            and similarity(p.address_norm,v_property_norm)>=0.72
        ) as property_match,
        exists(
          select 1 from public.sbi_deal_parties dp
          join public.sbi_deals d using(deal_id)
          join public.sbi_properties p using(property_id)
          where dp.entity_id=e.entity_id and v_borough is not null and p.borough=v_borough
        ) as borough_match,
        exists(
          select 1 from public.sbi_deal_parties dp
          join public.sbi_deals d using(deal_id)
          where dp.entity_id=e.entity_id and v_asset is not null and lower(d.asset_type)=lower(v_asset)
        ) as asset_match
      from public.sbi_entities e
      where e.norm_name % v_norm
         or similarity(e.norm_name,v_norm)>=0.28
         or exists(select 1 from public.sbi_entity_aliases a where a.entity_id=e.entity_id and similarity(a.alias_norm,v_norm)>=0.28)
    ), scored as (
      select *,least(1.0,greatest(0.0,
        name_score+
        case when property_match then 0.25 else 0 end+
        case when borough_match then 0.08 else 0 end+
        case when asset_match then 0.08 else 0 end-
        case when is_spv_suspect and not property_match then 0.06 else 0 end
      ))::numeric(6,4) as score
      from candidate_base
    ), top_candidates as (
      select * from scored order by score desc,name_score desc,display_name limit 5
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'entity_id',entity_id,'display_name',display_name,'score',score,
        'reason',concat_ws(' · ',
          'name '||round(name_score::numeric,2),
          case when property_match then 'property match' end,
          case when borough_match then 'borough history' end,
          case when asset_match then 'asset history' end,
          case when is_spv_suspect then 'SPV' end
        )
      ) order by score desc),'[]'::jsonb),
      max(score)
    into v_candidates,v_top_score
    from top_candidates;

    if coalesce(v_top_score,0)>=0.55 then
      select q.review_id into v_review
      from public.sbi_review_queue q
      where q.object_type='upload_row'
        and q.object_id=api_upload_resolve.upload_id::text||':'||r.row_num::text
        and q.issue_class='entity_merge'
        and q.status='open'
      limit 1;

      if v_review is null then
        insert into public.sbi_review_queue(object_type,object_id,issue_class,severity,payload,status)
        values(
          'upload_row',api_upload_resolve.upload_id::text||':'||r.row_num::text,
          'entity_merge','normal',jsonb_strip_nulls(jsonb_build_object(
            'upload_id',api_upload_resolve.upload_id,'row_num',r.row_num,
            'name',v_name,'normalized_name',v_norm,'property_address',v_property,
            'borough',v_borough,'asset_type',v_asset,'candidates',v_candidates
          )),'open'
        ) returning review_id into v_review;
      end if;

      update public.sbi_upload_rows set
        status='needs_review',
        resolution=jsonb_build_object('review_id',v_review,'candidate_count',jsonb_array_length(v_candidates),'top_score',v_top_score)
      where sbi_upload_rows.upload_id=api_upload_resolve.upload_id and row_num=r.row_num;
      v_needs_review:=v_needs_review+1;
    else
      v_entity:=public.sbi_get_or_create_entity(v_name);
      v_apply:=public.sbi_upload_apply_row(api_upload_resolve.upload_id,r.row_num,v_entity,api_upload_resolve.user_id,'new_entity');
      v_contacts_created:=v_contacts_created+coalesce((v_apply->>'contacts_created')::integer,0);
      v_contacts_updated:=v_contacts_updated+coalesce((v_apply->>'contacts_updated')::integer,0);
      v_interactions:=v_interactions+coalesce((v_apply->>'interactions_created')::integer,0);
      v_new:=v_new+1;
    end if;
  end loop;

  update public.sbi_uploads set status=case
    when exists(select 1 from public.sbi_upload_rows ur where ur.upload_id=api_upload_resolve.upload_id and ur.status='needs_review') then 'review_pending'
    else 'imported'
  end where sbi_uploads.upload_id=api_upload_resolve.upload_id;

  return jsonb_build_object(
    'upload_id',api_upload_resolve.upload_id,
    'stats',jsonb_build_object(
      'auto_matched',v_auto,'alias_matched',v_alias,'new_entity',v_new,
      'needs_review',v_needs_review,'skipped_no_name',v_skipped,
      'contacts_created',v_contacts_created,'contacts_updated',v_contacts_updated,
      'interactions_created',v_interactions
    )
  );
end;
$$;

create or replace function public.api_review_act(
  review_id uuid,
  action text,
  entity_id uuid default null,
  user_id text default 'system'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  v_payload jsonb;
  v_issue text;
  v_name text;
  v_upload uuid;
  v_row integer;
  v_entity uuid;
  v_apply jsonb;
begin
  select r.payload,r.issue_class into v_payload,v_issue
  from public.sbi_review_queue r
  where r.review_id=api_review_act.review_id
  for update;

  if v_payload is null then return jsonb_build_object('error','review item not found'); end if;

  if v_issue='entity_merge' then
    v_upload:=nullif(v_payload->>'upload_id','')::uuid;
    v_row:=nullif(v_payload->>'row_num','')::integer;
    v_name:=coalesce(v_payload->>'name',v_payload->>'entity_name',v_payload->>'alias');

    if api_review_act.action='confirm_merge' then
      if api_review_act.entity_id is null then return jsonb_build_object('error','confirm_merge requires entity_id'); end if;
      if not exists(select 1 from public.sbi_entities e where e.entity_id=api_review_act.entity_id) then return jsonb_build_object('error','entity not found'); end if;
      v_entity:=api_review_act.entity_id;
      if public.sbi_norm_entity(v_name) is not null then
        insert into public.sbi_entity_aliases(entity_id,alias_raw,alias_norm,source)
        values(v_entity,v_name,public.sbi_norm_entity(v_name),'review_confirm')
        on conflict(alias_norm) do nothing;
      end if;
      v_apply:=public.sbi_upload_apply_row(v_upload,v_row,v_entity,api_review_act.user_id,'review_confirm');
      update public.sbi_review_queue set status='resolved',resolved_by=coalesce(api_review_act.user_id,'system'),resolved_at=now()
      where sbi_review_queue.review_id=api_review_act.review_id;
    elsif api_review_act.action='create_new' then
      v_entity:=public.sbi_get_or_create_entity(v_name);
      v_apply:=public.sbi_upload_apply_row(v_upload,v_row,v_entity,api_review_act.user_id,'review_create_new');
      update public.sbi_review_queue set status='resolved',resolved_by=coalesce(api_review_act.user_id,'system'),resolved_at=now()
      where sbi_review_queue.review_id=api_review_act.review_id;
    elsif api_review_act.action='dismiss' then
      update public.sbi_upload_rows set status='rejected',resolution=coalesce(resolution,'{}'::jsonb)||jsonb_build_object('reason','review_dismissed','dismissed_at',now())
      where upload_id=v_upload and row_num=v_row;
      update public.sbi_review_queue set status='dismissed',resolved_by=coalesce(api_review_act.user_id,'system'),resolved_at=now()
      where sbi_review_queue.review_id=api_review_act.review_id;
      v_apply:=jsonb_build_object('status','dismissed');
    else
      return jsonb_build_object('error','Unsupported entity_merge action');
    end if;

    update public.sbi_uploads set status=case
      when exists(select 1 from public.sbi_upload_rows ur where ur.upload_id=v_upload and ur.status='needs_review') then 'review_pending'
      else 'imported'
    end where upload_id=v_upload;

    return jsonb_build_object('status',api_review_act.action,'entity_id',v_entity,'result',v_apply);
  end if;

  if api_review_act.action in ('resolve','dismiss') then
    update public.sbi_review_queue set
      status=case when api_review_act.action='resolve' then 'resolved' else 'dismissed' end,
      resolved_by=coalesce(api_review_act.user_id,'system'),resolved_at=now()
    where sbi_review_queue.review_id=api_review_act.review_id;
    return jsonb_build_object('status','ok');
  end if;

  return jsonb_build_object('error','Unsupported action');
end;
$$;

revoke all on function public.sbi_upload_apply_row(uuid,integer,uuid,text,text) from public,anon,authenticated;
grant execute on function public.api_upload_resolve(uuid,jsonb,text),public.api_review_act(uuid,text,uuid,text) to anon,authenticated;
notify pgrst,'reload schema';
