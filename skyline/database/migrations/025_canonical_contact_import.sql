-- 025_canonical_contact_import.sql
-- Imports the buyer/seller contact fields already present in the verified canonical CSV
-- into sbi_contacts, preserves row-level provenance, and deterministically removes
-- formatting-only duplicates. All import entry points remain service-role only.

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

create or replace function public.sbi_import_canonical_contact(
  p_name text,
  p_role text,
  p_phone text default null,
  p_email text default null,
  p_website text default null,
  p_mailing_address text default null,
  p_shortcode text default null,
  p_source_url text default null
) returns text
language plpgsql volatile security definer
set search_path=public,extensions as $$
declare
  v_name text := nullif(btrim(p_name),'');
  v_role text := case when p_role in ('Buyer','Seller') then p_role else 'Other' end;
  v_phone text := nullif(btrim(p_phone),'');
  v_email text := nullif(lower(btrim(p_email)),'');
  v_website text := nullif(btrim(p_website),'');
  v_mailing text := nullif(btrim(p_mailing_address),'');
  v_entity uuid;
  v_contact uuid;
  v_provenance jsonb;
begin
  if v_name is null or lower(v_name) ~
    '^(unknown|n/?a|not\s+specified|not\s+provided|not\s+disclosed|not\s+found|undisclosed|confidential|withheld|anonymous|private\s+investor|various|multiple|null|undefined|none|no\s+name|tbd|tba|-+|\*+)$'
  then
    return 'skipped_placeholder';
  end if;

  if v_phone is null and v_email is null and v_website is null and v_mailing is null then
    return 'skipped_empty';
  end if;

  v_entity := public.sbi_get_or_create_entity(v_name);
  if v_entity is null then return 'skipped_entity'; end if;

  v_provenance := jsonb_strip_nulls(jsonb_build_object(
    'loader','canonical_csv_v8',
    'shortcode',nullif(btrim(p_shortcode),''),
    'source_url',nullif(btrim(p_source_url),''),
    'first_imported_at',now()
  ));

  update public.sbi_entities e
     set mailing_address = coalesce(e.mailing_address, v_mailing),
         website = coalesce(e.website, v_website),
         enrichment_status = case
           when e.enrichment_status in ('not_started','pending') then 'partial'
           else e.enrichment_status
         end,
         enrichment_confidence = greatest(coalesce(e.enrichment_confidence,0),95),
         provenance = coalesce(e.provenance,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'canonical_contact_source','NEW_YORK_CLOSED_ENRICHED_v8.csv',
           'canonical_contact_imported_at',now()
         )),
         updated_at = now()
   where e.entity_id = v_entity;

  select c.contact_id into v_contact
  from public.sbi_contacts c
  where c.entity_id = v_entity
    and c.role = v_role
    and c.source = 'canonical_csv_v8'
    and (c.phone is null or v_phone is null or public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone))
    and (c.email is null or v_email is null or public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email))
    and (c.website is null or v_website is null or public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website))
    and (c.mailing_address is null or v_mailing is null or public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing))
    and (
      (c.phone is not null and v_phone is not null and public.sbi_norm_contact_phone(c.phone)=public.sbi_norm_contact_phone(v_phone)) or
      (c.email is not null and v_email is not null and public.sbi_norm_contact_email(c.email)=public.sbi_norm_contact_email(v_email)) or
      (c.website is not null and v_website is not null and public.sbi_norm_contact_website(c.website)=public.sbi_norm_contact_website(v_website)) or
      (c.mailing_address is not null and v_mailing is not null and public.sbi_norm_contact_address(c.mailing_address)=public.sbi_norm_contact_address(v_mailing))
    )
  order by ((c.phone is not null)::int + (c.email is not null)::int +
            (c.website is not null)::int + (c.mailing_address is not null)::int) desc
  limit 1;

  if v_contact is null then
    insert into public.sbi_contacts(
      entity_id, company, role, phone, email, website, mailing_address,
      source, confidence, is_primary, provenance
    ) values (
      v_entity, v_name, v_role, v_phone, v_email, v_website, v_mailing,
      'canonical_csv_v8', 95,
      not exists(select 1 from public.sbi_contacts c where c.entity_id=v_entity and c.is_primary is true),
      v_provenance
    ) returning contact_id into v_contact;
    return 'inserted';
  end if;

  update public.sbi_contacts c
     set phone = coalesce(c.phone, v_phone),
         email = coalesce(c.email, v_email),
         website = coalesce(c.website, v_website),
         mailing_address = coalesce(c.mailing_address, v_mailing),
         company = coalesce(c.company, v_name),
         confidence = greatest(coalesce(c.confidence,0),95),
         provenance = coalesce(c.provenance,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'last_seen_shortcode',nullif(btrim(p_shortcode),''),
           'last_seen_source_url',nullif(btrim(p_source_url),''),
           'last_seen_at',now()
         )),
         updated_at = now()
   where c.contact_id = v_contact;
  return 'updated';
end;
$$;

create or replace function public.api_import_canonical_contacts(
  offset_rows integer default 0,
  max_rows integer default 1000
) returns jsonb
language plpgsql volatile security definer
set search_path=public,extensions as $$
declare
  csv text;
  lines text[];
  headers text[];
  vals text[];
  obj jsonb;
  i integer;
  j integer;
  first_line integer;
  last_line integer;
  total_lines integer;
  status text;
  inserted_count integer := 0;
  updated_count integer := 0;
  skipped_empty_count integer := 0;
  skipped_placeholder_count integer := 0;
  processed_rows integer := 0;
begin
  select content into csv
  from extensions.http_get(
    'https://raw.githubusercontent.com/rubbik26-commits/buyerDB/ACRIS/skyline/NEW_YORK_CLOSED_ENRICHED_v8.csv'
  );
  if csv is null or length(csv) < 100 then raise exception 'CSV fetch returned empty content'; end if;

  lines := regexp_split_to_array(csv, E'\n');
  headers := public.seed_csv_line_to_array(lines[1]);
  total_lines := array_length(lines,1)-1;
  first_line := greatest(2, 2 + coalesce(offset_rows,0));
  last_line := least(array_length(lines,1), first_line + greatest(coalesce(max_rows,1000),1)-1);

  for i in first_line..last_line loop
    if btrim(coalesce(lines[i],''))='' then continue; end if;
    vals := public.seed_csv_line_to_array(trim(trailing E'\r' from lines[i]));
    obj := '{}'::jsonb;
    for j in 1..array_length(headers,1) loop
      obj := obj || jsonb_build_object(headers[j],coalesce(vals[j],''));
    end loop;

    if nullif(btrim(obj->>'Borough'),'') is not null
       and nullif(btrim(obj->>'Borough'),'') not in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')
    then
      continue;
    end if;
    processed_rows := processed_rows + 1;

    status := public.sbi_import_canonical_contact(
      obj->>'Buyer','Buyer',obj->>'Buyer Phone',obj->>'Buyer Email',
      obj->>'Buyer Website',obj->>'Buyer Address',obj->>'Shortcode',obj->>'Source URL'
    );
    if status='inserted' then inserted_count:=inserted_count+1;
    elsif status='updated' then updated_count:=updated_count+1;
    elsif status='skipped_placeholder' then skipped_placeholder_count:=skipped_placeholder_count+1;
    else skipped_empty_count:=skipped_empty_count+1;
    end if;

    status := public.sbi_import_canonical_contact(
      obj->>'Seller','Seller',obj->>'Seller Phone',obj->>'Seller Email',
      obj->>'Seller Website',obj->>'Seller Address',obj->>'Shortcode',obj->>'Source URL'
    );
    if status='inserted' then inserted_count:=inserted_count+1;
    elsif status='updated' then updated_count:=updated_count+1;
    elsif status='skipped_placeholder' then skipped_placeholder_count:=skipped_placeholder_count+1;
    else skipped_empty_count:=skipped_empty_count+1;
    end if;
  end loop;

  return jsonb_build_object(
    'status','imported_contacts_batch',
    'offset_rows',offset_rows,
    'max_rows',max_rows,
    'total_data_rows',total_lines,
    'line_start',first_line,
    'line_end',last_line,
    'processed_rows',processed_rows,
    'inserted',inserted_count,
    'updated',updated_count,
    'skipped_empty',skipped_empty_count,
    'skipped_placeholder',skipped_placeholder_count
  );
end;
$$;

create or replace function public.api_rank_primary_contacts()
returns jsonb
language plpgsql volatile security definer
set search_path=public as $$
declare updated_count integer;
begin
  update public.sbi_contacts set is_primary=false where source='canonical_csv_v8';
  with ranked as (
    select c.contact_id,
           row_number() over (
             partition by c.entity_id
             order by ((c.phone is not null)::int*4 + (c.email is not null)::int*4 +
                       (c.website is not null)::int*2 + (c.mailing_address is not null)::int) desc,
                      c.confidence desc nulls last,
                      c.created_at asc
           ) as rn
    from public.sbi_contacts c
    where c.source='canonical_csv_v8'
      and not exists(
        select 1 from public.sbi_contacts x
        where x.entity_id=c.entity_id and x.source<>'canonical_csv_v8' and x.is_primary is true
      )
  )
  update public.sbi_contacts c set is_primary=true, updated_at=now()
  from ranked r where c.contact_id=r.contact_id and r.rn=1;
  get diagnostics updated_count = row_count;
  return jsonb_build_object('primary_contacts_assigned',updated_count);
end;
$$;

create or replace function public.api_dedupe_canonical_contacts()
returns jsonb
language plpgsql volatile security definer
set search_path=public as $$
declare
  removed_count integer := 0;
  group_count integer := 0;
begin
  create temporary table _canonical_contact_rank on commit drop as
  select c.contact_id,
         first_value(c.contact_id) over (
           partition by c.entity_id,c.role,
             public.sbi_norm_contact_phone(c.phone),
             public.sbi_norm_contact_email(c.email),
             public.sbi_norm_contact_website(c.website),
             public.sbi_norm_contact_address(c.mailing_address)
           order by c.is_primary desc,
             ((c.phone is not null)::int*4 + (c.email is not null)::int*4 +
              (c.website is not null)::int*2 + (c.mailing_address is not null)::int) desc,
             c.created_at asc,c.contact_id
         ) as keep_id,
         row_number() over (
           partition by c.entity_id,c.role,
             public.sbi_norm_contact_phone(c.phone),
             public.sbi_norm_contact_email(c.email),
             public.sbi_norm_contact_website(c.website),
             public.sbi_norm_contact_address(c.mailing_address)
           order by c.is_primary desc,
             ((c.phone is not null)::int*4 + (c.email is not null)::int*4 +
              (c.website is not null)::int*2 + (c.mailing_address is not null)::int) desc,
             c.created_at asc,c.contact_id
         ) as rn
  from public.sbi_contacts c
  where c.source='canonical_csv_v8';

  select count(distinct keep_id) into group_count
  from _canonical_contact_rank where rn>1;

  update public.sbi_contacts keep
     set provenance = coalesce(keep.provenance,'{}'::jsonb) || jsonb_build_object(
       'canonical_dedupe_at',now(),
       'canonical_dedupe_removed',(
         select count(*) from _canonical_contact_rank r
         where r.keep_id=keep.contact_id and r.rn>1
       )
     ),
         updated_at=now()
   where exists(
     select 1 from _canonical_contact_rank r
     where r.keep_id=keep.contact_id and r.rn>1
   );

  delete from public.sbi_contacts c
  using _canonical_contact_rank r
  where c.contact_id=r.contact_id and r.rn>1;
  get diagnostics removed_count = row_count;

  return jsonb_build_object('duplicate_groups',group_count,'contacts_removed',removed_count);
end;
$$;

revoke all on function public.sbi_import_canonical_contact(text,text,text,text,text,text,text,text) from public;
revoke all on function public.api_import_canonical_contacts(integer,integer) from public;
revoke all on function public.api_rank_primary_contacts() from public;
revoke all on function public.api_dedupe_canonical_contacts() from public;
grant execute on function
  public.api_import_canonical_contacts(integer,integer),
  public.api_rank_primary_contacts(),
  public.api_dedupe_canonical_contacts()
to service_role;

-- Idempotent data migration. Each batch is bounded so the database statement remains
-- observable, while the helper merges existing values and never overwrites a non-null value.
select public.api_import_canonical_contacts(0,1000);
select public.api_import_canonical_contacts(1000,1000);
select public.api_import_canonical_contacts(2000,1000);
select public.api_import_canonical_contacts(3000,1000);
select public.api_import_canonical_contacts(4000,500);
select public.api_dedupe_canonical_contacts();
select public.api_rank_primary_contacts();

notify pgrst,'reload schema';
