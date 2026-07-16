-- =========================================================================
-- Storage (business logos/covers) + analytics additions (country, returning
-- visitors)
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. STORAGE — one public bucket for business logos/covers. Public read
--    (these appear on public landing pages), but writes are locked to the
--    business that owns the folder, same pattern as every other table.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('business-assets', 'business-assets', true)
on conflict (id) do nothing;

create policy "public can read business assets"
  on storage.objects for select
  to public
  using (bucket_id = 'business-assets');

create policy "tenant can upload own business assets"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'business-assets'
    and (
      public.current_role_name() = 'super_admin'
      or (storage.foldername(name))[1] = public.current_business_id()::text
    )
  );

create policy "tenant can update own business assets"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'business-assets'
    and (
      public.current_role_name() = 'super_admin'
      or (storage.foldername(name))[1] = public.current_business_id()::text
    )
  );

create policy "tenant can delete own business assets"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'business-assets'
    and (
      public.current_role_name() = 'super_admin'
      or (storage.foldername(name))[1] = public.current_business_id()::text
    )
  );

-- ---------------------------------------------------------------------
-- 2. ANALYTICS — add country breakdown and new-vs-returning visitors to
--    the existing summary function. "Returning" is computed by checking
--    whether a session_id seen in this date range has any earlier event
--    before the range started - not tied to any personal info, just
--    whether the same anonymous browser-generated id has shown up before.
-- ---------------------------------------------------------------------
create or replace function public.get_business_summary(
  p_business_id uuid,
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'totalTaps', (
      select count(*) from public.events
      where business_id = p_business_id and type = 'nfc_tap'
        and created_at between p_from and p_to
    ),
    'tapsByDay', (
      select coalesce(jsonb_agg(row_to_json(d)), '[]'::jsonb) from (
        select to_char(created_at, 'YYYY-MM-DD') as day, count(*) as count
        from public.events
        where business_id = p_business_id and type = 'nfc_tap'
          and created_at between p_from and p_to
        group by day order by day
      ) d
    ),
    'eventsByType', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select type, count(*) as count
        from public.events
        where business_id = p_business_id
          and created_at between p_from and p_to
        group by type order by count desc
      ) t
    ),
    'devicesSplit', (
      select coalesce(jsonb_agg(row_to_json(dv)), '[]'::jsonb) from (
        select device, count(*) as count
        from public.events
        where business_id = p_business_id
          and created_at between p_from and p_to
        group by device
      ) dv
    ),
    'topHours', (
      select coalesce(jsonb_agg(row_to_json(h)), '[]'::jsonb) from (
        select extract(hour from created_at) as hour, count(*) as count
        from public.events
        where business_id = p_business_id and type = 'nfc_tap'
          and created_at between p_from and p_to
        group by hour order by count desc limit 5
      ) h
    ),
    'topCountries', (
      select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb) from (
        select country, count(*) as count
        from public.events
        where business_id = p_business_id
          and country != '' and country is not null
          and created_at between p_from and p_to
        group by country order by count desc limit 10
      ) c
    ),
    'returningVisitors', (
      select jsonb_build_object(
        'new', count(*) filter (
          where not exists (
            select 1 from public.events e2
            where e2.session_id = s.session_id
              and e2.business_id = p_business_id
              and e2.created_at < p_from
          )
        ),
        'returning', count(*) filter (
          where exists (
            select 1 from public.events e2
            where e2.session_id = s.session_id
              and e2.business_id = p_business_id
              and e2.created_at < p_from
          )
        )
      )
      from (
        select distinct session_id
        from public.events
        where business_id = p_business_id
          and session_id != '' and session_id is not null
          and created_at between p_from and p_to
      ) s
    )
  ) into result;

  return result;
end;
$$;
