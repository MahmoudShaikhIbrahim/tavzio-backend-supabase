-- =========================================================================
-- Analytics fixes: returning visitors was comparing against the wrong
-- thing, and adds busiest-day-of-week data.
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
    -- Busiest days of the week (Monday, Tuesday, etc.), aggregated across
    -- the whole reporting period - replaces the iOS/Android split, which
    -- tells an NFC-tap business nothing actionable. This does: it's a
    -- direct answer to "which days should I staff up for."
    'busiestDays', (
      select coalesce(jsonb_agg(row_to_json(bd)), '[]'::jsonb) from (
        select to_char(created_at, 'Day') as day_name,
               extract(dow from created_at) as day_number,
               count(*) as count
        from public.events
        where business_id = p_business_id and type = 'nfc_tap'
          and created_at between p_from and p_to
        group by day_name, day_number order by count desc
      ) bd
    ),
    -- Was comparing each visit against the START OF THE REPORTING WINDOW
    -- rather than the visitor's own actual history - meaning literally
    -- every tap looked like a first-ever visit for the entire duration of
    -- a new business's first 30 days, no matter how many times the same
    -- person tapped. Fixed: a session counts as "returning" if it has
    -- MORE THAN ONE tap total, ever (not bounded by the reporting
    -- window) - "new" if this is its only tap on record.
    'returningVisitors', (
      select jsonb_build_object(
        'new', count(*) filter (where total_taps = 1),
        'returning', count(*) filter (where total_taps > 1)
      )
      from (
        select e.session_id, count(*) as total_taps
        from public.events e
        where e.business_id = p_business_id
          and e.type = 'nfc_tap'
          and e.session_id != '' and e.session_id is not null
        group by e.session_id
        having exists (
          select 1 from public.events e2
          where e2.session_id = e.session_id
            and e2.business_id = p_business_id
            and e2.type = 'nfc_tap'
            and e2.created_at between p_from and p_to
        )
      ) s
    )
  ) into result;

  return result;
end;
$$;
