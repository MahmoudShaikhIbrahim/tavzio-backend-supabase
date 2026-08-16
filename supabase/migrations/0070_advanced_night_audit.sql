-- =========================================================================
-- Advanced night audit (hotel roadmap, module 7). The real gap: night
-- audit was a pure revenue-report generator with no operational
-- function at all - a reservation that never arrived stayed 'confirmed'
-- forever unless someone remembered to mark it no-show by hand (the
-- endpoint I added in module 1 existed, but nothing ever called it as
-- part of the audit that's specifically supposed to catch this), and a
-- guest still checked in past their own checkout date was invisible.
-- =========================================================================

alter table public.hotel_night_audits add column if not exists no_shows_processed integer not null default 0;
alter table public.hotel_night_audits add column if not exists unresolved_departures_count integer not null default 0;
