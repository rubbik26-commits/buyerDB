-- 003_sbi_netlify_runtime_access.sql
-- Allows the deployed Netlify API functions to read the public sbi runtime tables
-- when only a publishable/anon key is configured. Write-heavy operations should
-- still prefer SUPABASE_SERVICE_ROLE_KEY in Netlify environment variables.
BEGIN;

grant select on table public.sbi_deals to anon;
grant select on table public.sbi_properties to anon;
grant select on table public.sbi_entities to anon;
grant select on table public.sbi_deal_parties to anon;
grant select on table public.sbi_contacts to anon;
grant select on table public.sbi_review_queue to anon;
grant select on table public.sbi_source_runs to anon;

do $$ begin
  create policy "netlify_read_sbi_deals" on public.sbi_deals for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_properties" on public.sbi_properties for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_entities" on public.sbi_entities for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_deal_parties" on public.sbi_deal_parties for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_contacts" on public.sbi_contacts for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_review_queue" on public.sbi_review_queue for select to anon using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "netlify_read_sbi_source_runs" on public.sbi_source_runs for select to anon using (true);
exception when duplicate_object then null; end $$;

COMMIT;
