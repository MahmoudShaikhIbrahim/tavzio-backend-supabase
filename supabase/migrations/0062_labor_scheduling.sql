-- =========================================================================
-- Advanced labor management & staff scheduling (restaurant roadmap,
-- module 4). Additive: staff_shifts (actual clock in/out) is untouched -
-- staff_schedules is the PLANNED roster, a genuinely new capability.
-- Gated behind features.hr.scheduling / features.hr.laborCost, same
-- owner-only convention as the rest of the HR module.
-- =========================================================================

alter table public.profiles add column if not exists hourly_rate_aed numeric(8,2);

create table if not exists public.staff_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  role_label text default '',
  notes text default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (scheduled_end > scheduled_start)
);

create index if not exists idx_staff_schedules_business on public.staff_schedules(business_id, scheduled_start);
create index if not exists idx_staff_schedules_staff on public.staff_schedules(staff_id, scheduled_start);

alter table public.staff_schedules enable row level security;

-- Owner/super_admin manage the roster; a staff member can only ever read
-- their OWN scheduled shifts, never anyone else's or edit any of it -
-- same asymmetry as the rest of HR (documents, commission, tips) being
-- owner-controlled, but scheduling specifically needs staff to at least
-- see when they're expected to work.
create policy "owner manages own business schedules" on public.staff_schedules for all to authenticated
  using (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'))
  with check (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'));

create policy "staff reads own scheduled shifts" on public.staff_schedules for select to authenticated
  using (staff_id = auth.uid());
