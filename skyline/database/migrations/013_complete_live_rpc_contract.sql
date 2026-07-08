-- 013_complete_live_rpc_contract.sql
-- Completes the live sbi_* RPC contract used by skyline/frontend/src/api/client.js.

create or replace function api_log_interaction(
  entity_id uuid,
  channel text default 'other',
  subject text default null,
  notes text default null,
  outcome text default null,
  user_id text default 'broker'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare iid uuid; safe_channel text;
begin
  safe_channel := case when api_log_interaction.channel in ('call','email','text','meeting','mail','other') then api_log_interaction.channel else 'other' end;
  insert into sbi_interactions(entity_id,user_id,channel,occurred_at,subject,notes,outcome)
  values(api_log_interaction.entity_id,coalesce(api_log_interaction.user_id,'broker'),safe_channel,now(),api_log_interaction.subject,api_log_interaction.notes,api_log_interaction.outcome)
  returning interaction_id into iid;
  return jsonb_build_object('interaction_id',iid,'status','logged');
end;
$$;

create or replace function api_upload_stage(
  filename text,
  user_id text default 'broker',
  rows jsonb default '[]'::jsonb,
  columns jsonb default '[]'::jsonb,
  mapping jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare uid uuid; idx int := 0; item jsonb;
begin
  insert into sbi_uploads(user_id, filename, row_count, column_mapping, status)
  values(coalesce(api_upload_stage.user_id,'broker'), api_upload_stage.filename, jsonb_array_length(coalesce(api_upload_stage.rows,'[]'::jsonb)), coalesce(api_upload_stage.mapping,'{}'::jsonb), 'staged')
  returning upload_id into uid;

  for item in select * from jsonb_array_elements(coalesce(api_upload_stage.rows,'[]'::jsonb)) loop
    insert into sbi_upload_rows(upload_id,row_num,raw,status) values(uid,idx,item,'staged');
    idx := idx + 1;
  end loop;

  return jsonb_build_object(
    'upload_id',uid,
    'row_count',idx,
    'columns',coalesce(api_upload_stage.columns,'[]'::jsonb),
    'proposed_mapping',coalesce(api_upload_stage.mapping,'{}'::jsonb),
    'sample',(select coalesce(jsonb_agg(raw order by row_num),'[]'::jsonb) from sbi_upload_rows where upload_id=uid and row_num<5)
  );
end;
$$;

create or replace function api_upload_resolve(
  upload_id uuid,
  mapping jsonb default '{}'::jsonb,
  user_id text default 'broker'
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare
  r record; src_col text; canon text;
  entity_name text; person text; ph text; em text; mail text; ttl text; notes_val text; chan text;
  safe_chan text; eid uuid; normalized text;
  stats jsonb := '{"contacts_created":0,"interactions_created":0,"new_entity":0,"auto_matched":0,"needs_review":0,"skipped_no_name":0}'::jsonb;
begin
  update sbi_uploads set status='resolving', column_mapping=coalesce(api_upload_resolve.mapping,'{}'::jsonb)
  where sbi_uploads.upload_id=api_upload_resolve.upload_id;

  for r in select row_num,raw from sbi_upload_rows where sbi_upload_rows.upload_id=api_upload_resolve.upload_id order by row_num loop
    entity_name:=null; person:=null; ph:=null; em:=null; mail:=null; ttl:=null; notes_val:=null; chan:=null;

    for src_col, canon in select key,value from jsonb_each_text(coalesce(api_upload_resolve.mapping,'{}'::jsonb)) loop
      if canon='entity_name' then entity_name:=r.raw->>src_col; end if;
      if canon='person_name' then person:=r.raw->>src_col; end if;
      if canon='phone' then ph:=r.raw->>src_col; end if;
      if canon='email' then em:=r.raw->>src_col; end if;
      if canon='mailing_address' then mail:=r.raw->>src_col; end if;
      if canon='title' then ttl:=r.raw->>src_col; end if;
      if canon='interaction_notes' then notes_val:=r.raw->>src_col; end if;
      if canon='channel' then chan:=r.raw->>src_col; end if;
    end loop;

    if coalesce(trim(entity_name),'')='' then
      stats:=jsonb_set(stats,'{skipped_no_name}',to_jsonb((stats->>'skipped_no_name')::int+1));
      update sbi_upload_rows set status='rejected',resolution='{"reason":"missing entity_name"}'::jsonb
      where sbi_upload_rows.upload_id=api_upload_resolve.upload_id and row_num=r.row_num;
      continue;
    end if;

    normalized:=trim(regexp_replace(regexp_replace(upper(entity_name),'[^A-Z0-9]+',' ','g'),'\s+',' ','g'));
    select e.entity_id into eid from sbi_entities e where e.norm_name=normalized limit 1;

    if eid is null then
      insert into sbi_entities(display_name,entity_type) values(entity_name,'unknown') returning entity_id into eid;
      stats:=jsonb_set(stats,'{new_entity}',to_jsonb((stats->>'new_entity')::int+1));
    else
      stats:=jsonb_set(stats,'{auto_matched}',to_jsonb((stats->>'auto_matched')::int+1));
    end if;

    if coalesce(ph,'')<>'' or coalesce(em,'')<>'' or coalesce(person,'')<>'' or coalesce(mail,'')<>'' then
      insert into sbi_contacts(entity_id,person_name,title,phone,email,mailing_address,source)
      values(eid,nullif(person,''),nullif(ttl,''),nullif(ph,''),nullif(em,''),nullif(mail,''),'upload:'||api_upload_resolve.upload_id::text);
      stats:=jsonb_set(stats,'{contacts_created}',to_jsonb((stats->>'contacts_created')::int+1));
    end if;

    if coalesce(notes_val,'')<>'' then
      safe_chan:=case when chan in ('call','email','text','meeting','mail','other') then chan else 'other' end;
      insert into sbi_interactions(entity_id,user_id,channel,occurred_at,subject,notes,outcome)
      values(eid,coalesce(api_upload_resolve.user_id,'broker'),safe_chan,now(),'Uploaded contact note',notes_val,'uploaded');
      stats:=jsonb_set(stats,'{interactions_created}',to_jsonb((stats->>'interactions_created')::int+1));
    end if;

    update sbi_upload_rows set status='imported',resolution=jsonb_build_object('entity_id',eid)
    where sbi_upload_rows.upload_id=api_upload_resolve.upload_id and row_num=r.row_num;
  end loop;

  update sbi_uploads set status='imported' where sbi_uploads.upload_id=api_upload_resolve.upload_id;
  return jsonb_build_object('upload_id',api_upload_resolve.upload_id,'stats',stats);
end;
$$;

grant execute on function api_log_interaction(uuid,text,text,text,text,text), api_upload_stage(text,text,jsonb,jsonb,jsonb), api_upload_resolve(uuid,jsonb,text) to anon;
notify pgrst, 'reload schema';
