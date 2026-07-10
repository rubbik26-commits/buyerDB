-- 027z_upload_resolution_helpers.sql
-- Shared upload guard used before any entity match or creation.
create or replace function public.sbi_placeholder_entity(v text)
returns boolean
language sql immutable set search_path=public as $$
  select coalesce(
    nullif(btrim(v),'') is null or
    lower(btrim(v)) ~ '^(unknown|n/?a|not\s+specified|not\s+provided|not\s+disclosed|not\s+found|undisclosed|confidential|withheld|anonymous|private\s+investor|various|multiple|null|undefined|none|no\s+name|tbd|tba|-+|\*+)$',
    true
  )
$$;
