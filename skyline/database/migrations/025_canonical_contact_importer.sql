-- 025_canonical_contact_importer.sql
-- Imports only real contact values already present in the canonical v8 CSV.
-- Entity linkage is exact on sbi_norm_entity(); unmatched names are skipped.
-- No fuzzy matching, entity creation, or invented contact data is permitted.

create or replace function public.sbi_csv_first_fields(
  p_line text,
  p_limit int default 16
) returns text[]
language plpgsql immutable
set search_path=public as $$
declare
  v_fields text[] := array[]::text[];
  v_field text := '';
  v_i int := 1;
  v_len int := length(coalesce(p_line,''));
  v_ch text;
  v_quoted boolean := false;
begin
  while v_i <= v_len loop
    v_ch := substr(p_line,v_i,1);
    if v_quoted then
      if v_ch='"' then
        if v_i < v_len and substr(p_line,v_i+1,1)='"' then
          v_field := v_field || '"';
          v_i := v_i + 1;
        else
          v_quoted := false;
        end if;
      else
        v_field := v_field || v_ch;
      end if;
    else
      if v_ch='"' and v_field='' then
        v_quoted := true;
      elsif v_ch=',' then
        v_fields := array_append(v_fields,nullif(v_field,''));
        v_field := '';
        if coalesce(array_length(v_fields,1),0) >= p_limit then
          return v_fields;
        end if;
      else
        v_field := v_field || v_ch;
      end if;
    end if;
    v_i := v_i + 1;
  end loop;

  if coalesce(array_length(v_fields,1),0) < p_limit then
    v_fields := array_append(v_fields,nullif(rtrim(v_field,E'\r'),''));
  end if;
  return v_fields;
end;
$$;

create or replace function public.sbi_import_canonical_contacts(p_csv_url text)
returns jsonb
language plpgsql volatile security definer
set search_path=public,extensions as $$
declare
  v_response extensions.http_response;
  v_line text;
  v_fields text[];
  v_side text;
  v_role text;
  v_name text;
  v_phone text;
  v_email text;
  v_website text;
  v_address text;
  v_entity uuid;
  v_source_rows int := 0;
  v_matched int := 0;
  v_inserted int := 0;
  v_existing int := 0;
  v_unmatched int := 0;
  v_bad_lines int := 0;
begin
  select * into v_response from extensions.http_get(p_csv_url::varchar);
  if v_response.status <> 200 then
    raise exception 'canonical CSV fetch failed with HTTP %', v_response.status;
  end if;

  for v_line in select regexp_split_to_table(v_response.content,E'\n') loop
    v_fields := public.sbi_csv_first_fields(v_line,16);
    if coalesce(array_length(v_fields,1),0) < 16 then
      v_bad_lines := v_bad_lines + 1;
      continue;
    end if;
    if v_fields[1]='Sale Date' then
      continue;
    end if;

    foreach v_side in array array['buyer','seller'] loop
      v_role := initcap(v_side);
      if v_side='buyer' then
        v_name:=nullif(btrim(v_fields[7]),'');
        v_phone:=nullif(btrim(v_fields[8]),'');
        v_email:=nullif(btrim(v_fields[9]),'');
        v_website:=nullif(btrim(v_fields[10]),'');
        v_address:=nullif(btrim(v_fields[11]),'');
      else
        v_name:=nullif(btrim(v_fields[12]),'');
        v_phone:=nullif(btrim(v_fields[13]),'');
        v_email:=nullif(btrim(v_fields[14]),'');
        v_website:=nullif(btrim(v_fields[15]),'');
        v_address:=nullif(btrim(v_fields[16]),'');
      end if;

      if v_name is null or (v_phone is null and v_email is null and v_website is null) then
        continue;
      end if;
      v_source_rows := v_source_rows + 1;

      v_entity := null;
      select e.entity_id into v_entity
      from public.sbi_entities e
      where e.norm_name=public.sbi_norm_entity(v_name)
      limit 1;

      if v_entity is null then
        v_unmatched := v_unmatched + 1;
        continue;
      end if;
      v_matched := v_matched + 1;

      if exists (
        select 1
        from public.sbi_contacts c
        where c.entity_id=v_entity
          and coalesce(c.phone,'')=coalesce(v_phone,'')
          and coalesce(c.email,'')=coalesce(v_email,'')
          and coalesce(c.website,'')=coalesce(v_website,'')
          and coalesce(c.role,'')=v_role
      ) then
        v_existing := v_existing + 1;
        continue;
      end if;

      insert into public.sbi_contacts(
        entity_id,company,role,phone,email,website,mailing_address,
        source,confidence,provenance
      ) values (
        v_entity,v_name,v_role,v_phone,v_email,v_website,v_address,
        'canonical_csv_v8',95,
        jsonb_build_object(
          'source','canonical_csv_v8',
          'source_url',p_csv_url,
          'side',v_side,
          'imported_at',now()
        )
      );
      v_inserted := v_inserted + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'source_rows',v_source_rows,
    'matched',v_matched,
    'inserted',v_inserted,
    'existing',v_existing,
    'unmatched',v_unmatched,
    'bad_physical_lines',v_bad_lines
  );
end;
$$;

revoke all on function public.sbi_import_canonical_contacts(text) from public;
grant execute on function public.sbi_import_canonical_contacts(text) to service_role;
