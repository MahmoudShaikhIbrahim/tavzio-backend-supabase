-- =========================================================================
-- Remove country/city analytics - IP-based geolocation only reflects the
-- network connection, not where a customer is actually from. For a
-- business operating entirely within the UAE, nearly every tap would just
-- show "UAE" regardless of whether the customer is a lifelong local or a
-- tourist on a UAE SIM/wifi - not a useful distinction, so removed rather
-- than kept as dead weight. Returning-visitor tracking (a separate,
-- unrelated anonymous signal) stays exactly as it was.
-- =========================================================================
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
