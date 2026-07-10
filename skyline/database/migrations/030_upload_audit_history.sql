-- 030_upload_audit_history.sql
-- Broker-facing audit history for every contact upload. Raw source rows remain in
-- sbi_upload_rows, while this public RPC returns only file metadata and outcome counts.

create or replace function public.api_uploads_list()
returns jsonb
language sql
stable
security definer
set search_path=public as $$
  select jsonb_build_object(
    'uploads',
    coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
  )
  from (
    select
      u.upload_id,
      u.user_id,
      u.filename,
      u.row_count,
      u.status,
      u.column_mapping,
      u.created_at,
      count(ur.row_num)::integer as staged_rows,
      count(ur.row_num) filter (where ur.status='imported')::integer as imported_rows,
      count(ur.row_num) filter (where ur.status='needs_review')::integer as needs_review_rows,
      count(ur.row_num) filter (where ur.status='rejected')::integer as rejected_rows,
      count(ur.row_num) filter (where ur.status in ('staged','pending'))::integer as pending_rows,
      count(q.review_id) filter (where q.status='open')::integer as open_review_items,
      max(q.created_at) filter (where q.status='open') as latest_open_review_at,
      coalesce(
        jsonb_object_agg(ur.status,ur.status_count) filter (where ur.status is not null),
        '{}'::jsonb
      ) as row_status_counts
    from public.sbi_uploads u
    left join lateral (
      select rows.status,count(*)::integer as status_count,min(rows.row_num) as row_num
      from public.sbi_upload_rows rows
      where rows.upload_id=u.upload_id
      group by rows.status
    ) ur on true
    left join public.sbi_review_queue q
      on q.object_type='upload_row'
     and q.object_id like u.upload_id::text||':%'
    group by u.upload_id,u.user_id,u.filename,u.row_count,u.status,u.column_mapping,u.created_at
    order by u.created_at desc
    limit 100
  ) x;
$$;

-- The function exposes aggregate upload metadata, not raw uploaded rows.
grant execute on function public.api_uploads_list() to anon,authenticated;
notify pgrst,'reload schema';
