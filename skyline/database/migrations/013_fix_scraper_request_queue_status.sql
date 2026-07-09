alter table public.sbi_source_runs drop constraint if exists sbi_source_runs_status_check;
alter table public.sbi_source_runs add constraint sbi_source_runs_status_check
  check (status in ('requested','running','completed','failed','timeout','quota_blocked','completed_with_errors'));

create or replace function public.api_request_scrape(job text, user_id text default 'broker', options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare rid uuid;
begin
  if api_request_scrape.job not in ('traded_refresh','acris_refresh','crexi_refresh','property_owner_refresh','full_refresh') then
    return jsonb_build_object('error','Unsupported scraper job');
  end if;

  insert into public.sbi_source_runs(source, job, status, stats)
  values(
    'manual',
    api_request_scrape.job,
    'requested',
    jsonb_build_object(
      'requested_by', coalesce(api_request_scrape.user_id,'broker'),
      'options', coalesce(api_request_scrape.options,'{}'::jsonb)
    )
  )
  returning run_id into rid;

  return jsonb_build_object('run_id',rid,'job',api_request_scrape.job,'status','requested');
end;
$$;

grant execute on function public.api_request_scrape(text,text,jsonb) to anon;
notify pgrst, 'reload schema';
