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
      (select count(*)::integer from public.sbi_upload_rows ur where ur.upload_id=u.upload_id) as staged_rows,
      (select count(*)::integer from public.sbi_upload_rows ur where ur.upload_id=u.upload_id and ur.status='imported') as imported_rows,
      (select count(*)::integer from public.sbi_upload_rows ur where ur.upload_id=u.upload_id and ur.status='needs_review') as needs_review_rows,
      (select count(*)::integer from public.sbi_upload_rows ur where ur.upload_id=u.upload_id and ur.status='rejected') as rejected_rows,
      (select count(*)::integer from public.sbi_upload_rows ur where ur.upload_id=u.upload_id and ur.status in ('staged','pending')) as pending_rows,
      (select count(*)::integer from public.sbi_review_queue q
        where q.object_type='upload_row' and q.object_id like u.upload_id::text||':%' and q.status='open') as open_review_items,
      (select max(q.created_at) from public.sbi_review_queue q
        where q.object_type='upload_row' and q.object_id like u.upload_id::text||':%' and q.status='open') as latest_open_review_at,
      coalesce((
        select jsonb_object_agg(s.status,s.row_count)
        from (
          select ur.status,count(*)::integer as row_count
          from public.sbi_upload_rows ur
          where ur.upload_id=u.upload_id
          group by ur.status
        ) s
      ),'{}'::jsonb) as row_status_counts
    from public.sbi_uploads u
    order by u.created_at desc
    limit 100
  ) x;
$$;

-- The function exposes aggregate upload metadata, not raw uploaded rows.
grant execute on function public.api_uploads_list() to anon,authenticated;
notify pgrst,'reload schema';
