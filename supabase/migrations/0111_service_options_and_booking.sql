-- Real fix for the confirmed request: services need real, selectable
-- options (e.g. "with cake" vs "without cake"), and a customer booking
-- one needs to say when they want it - which is often genuinely
-- different from the table reservation's own time (the cake might need
-- to arrive at 8pm during a 7pm dinner, not at check-in).

create table if not exists public.service_options (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  label text not null,
  -- Real, explicit price adjustment per option - "with cake" might add
  -- 50 AED over the base service price, "without cake" might add
  -- nothing. Signed so an option could even discount the base price if
  -- a business ever wanted that, not just add to it.
  price_delta numeric(10,2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_service_options_service on public.service_options(service_id);

alter table public.service_options enable row level security;
create policy "tenant manages own service options" on public.service_options for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.services s where s.id = service_id and s.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.services s where s.id = service_id and s.business_id = public.current_business_id())
  );

-- Public/anonymous read - a customer booking online needs to see these
-- options before they've logged in or tapped any card at all, same
-- trust model the public menu itself already uses.
create policy "anyone can view service options" on public.service_options for select
  to anon
  using (true);

alter publication supabase_realtime add table public.service_options;

-- Real fix: the public booking flow had zero service support at all -
-- only the staff-side manual booking creation could attach one, and
-- even that had no option and no separate time for it. service_id
-- already existed on bookings (staff-side only); this adds the two
-- pieces that were actually missing.
alter table public.bookings add column if not exists service_option_id uuid references public.service_options(id) on delete set null;
alter table public.bookings add column if not exists service_requested_at timestamptz;

comment on column public.bookings.service_option_id is 'Which option was chosen for this booking''s service, if any (e.g. "with cake").';
comment on column public.bookings.service_requested_at is 'When the service itself should happen - often genuinely different from requested_at, the table reservation''s own time.';
