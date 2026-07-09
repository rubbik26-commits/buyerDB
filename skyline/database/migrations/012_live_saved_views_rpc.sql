drop function if exists public.api_saved_views(text,text);

create function public.api_saved_views(p_user_id text default 'broker', p_surface text default null)
returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('views', coalesce((
    select jsonb_agg(to_jsonb(v) order by v.surface, v.updated_at desc nulls last)
    from public.sbi_saved_views v
    where v.user_id = coalesce(p_user_id, 'broker')
      and (p_surface is null or p_surface = '' or v.surface = p_surface)
  ), '[]'::jsonb));
$$;

create or replace function public.api_save_view(
  user_id text default 'broker',
  name text default null,
  surface text default null,
  filters jsonb default '{}'::jsonb,
  sort jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare out_view jsonb;
begin
  if coalesce(trim(api_save_view.name), '') = '' then
    return jsonb_build_object('error', 'saved-view name is required');
  end if;
  if api_save_view.surface not in ('deals','buyers','properties','outreach','audit') then
    return jsonb_build_object('error', 'invalid saved-view surface');
  end if;
  with upserted as (
    insert into public.sbi_saved_views(user_id, name, surface, filters, sort)
    values(coalesce(api_save_view.user_id, 'broker'), trim(api_save_view.name), api_save_view.surface, coalesce(api_save_view.filters, '{}'::jsonb), coalesce(api_save_view.sort, '{}'::jsonb))
    on conflict on constraint sbi_saved_views_user_id_surface_name_key
    do update set filters=excluded.filters, sort=excluded.sort, updated_at=now()
    returning *
  )
  select to_jsonb(upserted.*) into out_view from upserted;
  return jsonb_build_object('view', out_view);
end;
$$;

create or replace function public.api_delete_view(view_id uuid, user_id text default 'broker')
returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare deleted_id uuid;
begin
  delete from public.sbi_saved_views
   where sbi_saved_views.view_id = api_delete_view.view_id
     and sbi_saved_views.user_id = coalesce(api_delete_view.user_id, 'broker')
   returning sbi_saved_views.view_id into deleted_id;
  return jsonb_build_object('deleted', deleted_id is not null, 'view_id', api_delete_view.view_id);
end;
$$;

grant execute on function public.api_saved_views(text,text), public.api_save_view(text,text,text,jsonb,jsonb), public.api_delete_view(uuid,text) to anon;
notify pgrst, 'reload schema';
