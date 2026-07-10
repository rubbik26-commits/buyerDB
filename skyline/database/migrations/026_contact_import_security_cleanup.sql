-- 026_contact_import_security_cleanup.sql
-- Maintenance RPCs are never browser-callable. Explicit role revokes are required
-- because CREATE OR REPLACE preserves grants from earlier function versions.

revoke all on function public.sbi_import_canonical_contact(text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.api_import_canonical_contacts(integer,integer)
  from public, anon, authenticated;
revoke all on function public.api_rank_primary_contacts()
  from public, anon, authenticated;
revoke all on function public.api_dedupe_canonical_contacts()
  from public, anon, authenticated;

grant execute on function
  public.api_import_canonical_contacts(integer,integer),
  public.api_rank_primary_contacts(),
  public.api_dedupe_canonical_contacts()
to service_role;

-- Remove temporary deployment material used during the one-time Netlify diagnostic.
drop function if exists public.sbi_get_ephemeral_deploy_material(text);
drop table if exists public.sbi_ephemeral_deploy_material;
