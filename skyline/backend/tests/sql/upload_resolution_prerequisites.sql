-- Minimal pre-existing live SBI contract needed to apply and execute migrations
-- 027z/028/029 in CI. The production project already has these objects from earlier
-- migrations; this fixture exists only because the worker CI intentionally loads 001_schema.sql.

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create unique index if not exists sbi_entity_aliases_alias_norm_uq
  on public.sbi_entity_aliases(alias_norm);

create or replace function public.sbi_get_or_create_entity(raw_name text)
returns uuid
language plpgsql volatile security definer set search_path=public as $$
declare n text; eid uuid;
begin
  n:=public.sbi_norm_entity(raw_name);
  if n is null then return null; end if;
  select entity_id into eid from public.sbi_entities where norm_name=n limit 1;
  if eid is null then
    insert into public.sbi_entities(display_name,entity_type)
    values(btrim(raw_name),'unknown')
    on conflict(norm_name) do update set updated_at=now()
    returning entity_id into eid;
  end if;
  return eid;
end;
$$;

create or replace function public.sbi_norm_contact_phone(v text)
returns text language sql immutable set search_path=public as $$
  select nullif(regexp_replace(coalesce(v,''),'[^0-9]','','g'),'')
$$;
create or replace function public.sbi_norm_contact_email(v text)
returns text language sql immutable set search_path=public as $$
  select nullif(lower(btrim(coalesce(v,''))),'')
$$;
create or replace function public.sbi_norm_contact_website(v text)
returns text language sql immutable set search_path=public as $$
  select nullif(lower(regexp_replace(regexp_replace(regexp_replace(
    btrim(coalesce(v,'')),'^https?://','','i'),'^www\.','','i'),'/+$','','g')),'')
$$;
create or replace function public.sbi_norm_contact_address(v text)
returns text language sql immutable set search_path=public as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(upper(coalesce(v,'')),'[^A-Z0-9]+',' ','g'),
                '\m(SUITE|STE)\M','STE','g'),
              '\m(FLOOR|FL)\M','FL','g'),
            '\mAVENUE\M','AVE','g'),
          '\mSTREET\M','ST','g'),
        '\mROAD\M','RD','g'),
      '\mBOULEVARD\M','BLVD','g'),
    '\s+',' ','g')),'')
$$;

create or replace function public.api_upload_stage(
  filename text,
  user_id text default 'broker',
  rows jsonb default '[]'::jsonb,
  columns jsonb default '[]'::jsonb,
  mapping jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare uid uuid; idx integer:=0; item jsonb;
begin
  insert into public.sbi_uploads(user_id,filename,row_count,column_mapping,status)
  values(coalesce(api_upload_stage.user_id,'broker'),api_upload_stage.filename,
    jsonb_array_length(coalesce(api_upload_stage.rows,'[]'::jsonb)),
    coalesce(api_upload_stage.mapping,'{}'::jsonb),'staged')
  returning upload_id into uid;
  for item in select * from jsonb_array_elements(coalesce(api_upload_stage.rows,'[]'::jsonb)) loop
    insert into public.sbi_upload_rows(upload_id,row_num,raw,status)
    values(uid,idx,item,'staged');
    idx:=idx+1;
  end loop;
  return jsonb_build_object('upload_id',uid,'row_count',idx,'columns',coalesce(api_upload_stage.columns,'[]'::jsonb),
    'proposed_mapping',coalesce(api_upload_stage.mapping,'{}'::jsonb));
end;
$$;
