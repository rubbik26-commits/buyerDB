-- 029_upload_resolution_fixes.sql
-- Follow-up corrections proven against the live workflow: alias_norm is generated,
-- and an upload with no role must still update a contact matched by phone/email.

create or replace function public.sbi_upload_apply_row(
  p_upload_id uuid,p_row_num integer,p_entity_id uuid,
  p_user_id text default 'broker',p_resolution_method text default 'exact'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  v_raw jsonb; v_mapping jsonb; v_entity_name text; v_person text;
  v_phone_raw text; v_phone text; v_email text; v_website text; v_mailing text;
  v_title text; v_role_raw text; v_role text; v_notes text; v_channel_raw text;
  v_channel text; v_last_contact text; v_occurred timestamptz; v_contact uuid;
  v_contact_created integer:=0; v_contact_updated integer:=0; v_interaction_created integer:=0;
begin
  select ur.raw,u.column_mapping into v_raw,v_mapping
  from public.sbi_upload_rows ur join public.sbi_uploads u using(upload_id)
  where ur.upload_id=p_upload_id and ur.row_num=p_row_num for update;
  if v_raw is null then return jsonb_build_object('error','upload row not found'); end if;

  v_entity_name:=public.sbi_upload_value(v_raw,v_mapping,'entity_name');
  v_person:=public.sbi_upload_value(v_raw,v_mapping,'person_name');
  v_phone_raw:=public.sbi_upload_value(v_raw,v_mapping,'phone');
  v_phone:=public.sbi_normalize_phone_e164(v_phone_raw);
  v_email:=lower(public.sbi_upload_value(v_raw,v_mapping,'email'));
  v_website:=public.sbi_upload_value(v_raw,v_mapping,'website');
  v_mailing:=public.sbi_upload_value(v_raw,v_mapping,'mailing_address');
  v_title:=public.sbi_upload_value(v_raw,v_mapping,'title');
  v_role_raw:=lower(coalesce(public.sbi_upload_value(v_raw,v_mapping,'role'),'other'));
  v_role:=case when v_role_raw in ('buyer','acquisitions','acquisition') then 'Buyer'
    when v_role_raw in ('seller','dispositions','disposition') then 'Seller'
    when v_role_raw in ('owner','principal') then 'Owner'
    when v_role_raw in ('broker','agent') then 'Broker'
    when v_role_raw in ('lender','bank') then 'Lender' else 'Other' end;
  v_notes:=public.sbi_upload_value(v_raw,v_mapping,'interaction_notes');
  v_channel_raw:=lower(coalesce(public.sbi_upload_value(v_raw,v_mapping,'channel'),'other'));
  v_channel:=case when v_channel_raw in ('call','email','text','meeting','mail','other') then v_channel_raw else 'other' end;
  v_last_contact:=public.sbi_upload_value(v_raw,v_mapping,'last_contact_date');
  v_occurred:=coalesce(public.sbi_upload_timestamp(v_last_contact),now());

  if coalesce(v_person,v_phone,v_email,v_website,v_mailing,v_title) is not null then
    select c.contact_id into v_contact from public.sbi_contacts c
    where c.entity_id=p_entity_id
      and (v_role='Other' or c.role=v_role or c.role is null or c.role='Other')
      and (c.phone is null or v_phone is null or public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone))
      and (c.email is null or v_email is null or public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email))
      and (c.website is null or v_website is null or public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website))
      and (c.mailing_address is null or v_mailing is null or public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing))
      and ((v_phone is not null and public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone))
        or (v_email is not null and public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email))
        or (v_website is not null and public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website))
        or (v_mailing is not null and public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing))
        or (v_person is not null and public.sbi_norm_entity(c.person_name)=public.sbi_norm_entity(v_person)))
    order by c.is_primary desc,c.confidence desc nulls last,c.created_at limit 1;

    if v_contact is null then
      insert into public.sbi_contacts(entity_id,person_name,company,title,role,phone,email,website,mailing_address,source,confidence,is_primary,provenance)
      values(p_entity_id,v_person,v_entity_name,v_title,v_role,v_phone,v_email,v_website,v_mailing,'upload:'||p_upload_id::text,100,
        not exists(select 1 from public.sbi_contacts x where x.entity_id=p_entity_id and x.is_primary is true),
        jsonb_strip_nulls(jsonb_build_object('upload_id',p_upload_id,'row_num',p_row_num,'resolution_method',p_resolution_method,'raw_phone',nullif(v_phone_raw,''),'imported_at',now())))
      returning contact_id into v_contact;
      v_contact_created:=1;
    else
      update public.sbi_contacts c set person_name=coalesce(c.person_name,v_person),company=coalesce(c.company,v_entity_name),
        title=coalesce(c.title,v_title),role=case when c.role is null or c.role='Other' then v_role else c.role end,
        phone=coalesce(c.phone,v_phone),email=coalesce(c.email,v_email),website=coalesce(c.website,v_website),mailing_address=coalesce(c.mailing_address,v_mailing),
        confidence=greatest(coalesce(c.confidence,0),100),provenance=coalesce(c.provenance,'{}'::jsonb)||jsonb_build_object('last_upload_id',p_upload_id,'last_upload_row',p_row_num,'last_resolution_method',p_resolution_method,'last_seen_at',now())
      where c.contact_id=v_contact;
      v_contact_updated:=1;
    end if;
  end if;

  if v_notes is not null or v_last_contact is not null then
    if not exists(select 1 from public.sbi_interactions i where i.entity_id=p_entity_id and i.occurred_at=v_occurred and coalesce(i.notes,'')=coalesce(v_notes,'') and i.subject='Uploaded contact note') then
      insert into public.sbi_interactions(entity_id,contact_id,user_id,channel,occurred_at,subject,notes,outcome)
      values(p_entity_id,v_contact,coalesce(p_user_id,'broker'),v_channel,v_occurred,'Uploaded contact note',v_notes,'uploaded');
      v_interaction_created:=1;
    end if;
  end if;

  update public.sbi_upload_rows set status='imported',resolution=jsonb_build_object('entity_id',p_entity_id,'method',p_resolution_method,'contact_id',v_contact,'imported_at',now())
  where upload_id=p_upload_id and row_num=p_row_num;
  return jsonb_build_object('entity_id',p_entity_id,'contact_id',v_contact,'contacts_created',v_contact_created,'contacts_updated',v_contact_updated,'interactions_created',v_interaction_created);
end;
$$;

create or replace function public.api_review_act(
  review_id uuid,action text,entity_id uuid default null,user_id text default 'system'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  v_payload jsonb; v_issue text; v_name text; v_upload uuid; v_row integer;
  v_entity uuid; v_apply jsonb;
begin
  select r.payload,r.issue_class into v_payload,v_issue from public.sbi_review_queue r
  where r.review_id=api_review_act.review_id for update;
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
        insert into public.sbi_entity_aliases(entity_id,alias_raw,source)
        values(v_entity,v_name,'review_confirm')
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

    update public.sbi_uploads set status=case when exists(select 1 from public.sbi_upload_rows ur where ur.upload_id=v_upload and ur.status='needs_review') then 'review_pending' else 'imported' end
    where upload_id=v_upload;
    return jsonb_build_object('status',api_review_act.action,'entity_id',v_entity,'result',v_apply);
  end if;

  if api_review_act.action in ('resolve','dismiss') then
    update public.sbi_review_queue set status=case when api_review_act.action='resolve' then 'resolved' else 'dismissed' end,
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
