-- 026_normalize_contact_lookup.sql
-- Makes contact lookup resilient to natural-language articles such as
-- "the CSC Real Estate" while continuing to return only database-backed rows.

create or replace function public.api_contact_search(
  q text default null,
  lim integer default 10
) returns jsonb
language sql stable security definer
set search_path=public as $$
  with input as (
    select
      nullif(
        trim(regexp_replace(coalesce(api_contact_search.q,''), '^(the|a|an)\s+', '', 'i')),
        ''
      ) as query,
      least(greatest(api_contact_search.lim,1),50) as row_limit
  )
  select jsonb_build_object('matches', coalesce((
    select jsonb_agg(jsonb_build_object(
      'entity_id', e.entity_id,
      'name', e.display_name,
      'entity_type', e.entity_type,
      'mailing_address', e.mailing_address,
      'contacts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'contact_id', c.contact_id,
          'person_name', c.person_name,
          'company', c.company,
          'role', c.role,
          'phone', c.phone,
          'email', c.email,
          'website', c.website,
          'source', c.source,
          'confidence', c.confidence,
          'mailing_address', c.mailing_address,
          'provenance', c.provenance
        ) order by c.is_primary desc nulls last, c.created_at desc)
        from public.sbi_contacts c
        where c.entity_id=e.entity_id
      ), '[]'::jsonb)
    ) order by e.display_name)
    from public.sbi_entities e, input i
    where i.query is null
       or e.display_name ilike '%'||i.query||'%'
       or e.norm_name ilike '%'||public.sbi_norm_entity(i.query)||'%'
    limit (select row_limit from input)
  ), '[]'::jsonb));
$$;

grant execute on function public.api_contact_search(text,integer) to anon,authenticated;
notify pgrst, 'reload schema';
