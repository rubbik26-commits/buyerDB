-- 015_allow_crexi_refresh_request.sql
-- Aligns api_request_scrape with the Scrapers UI job list.

create or replace function api_request_scrape(job text, user_id text default 'broker', options jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare rid uuid;
begin
  if api_request_scrape.job not in ('traded_refresh','acris_refresh','crexi_refresh','property_owner_refresh','full_refresh') then
    return jsonb_build_object('error','Unsupported scraper job');
  end if;
  insert into sbi_source_runs(source,job,status,stats)
  values('manual',api_request_scrape.job,'running',jsonb_build_object('requested_by',coalesce(api_request_scrape.user_id,'broker'),'requested_status','requested','options',coalesce(api_request_scrape.options,'{}'::jsonb)))
  returning run_id into rid;
  return jsonb_build_object('run_id',rid,'job',api_request_scrape.job,'status','requested');
end;
$$;

grant execute on function api_request_scrape(text,text,jsonb) to anon;
notify pgrst, 'reload schema';
