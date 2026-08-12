-- 1) Order-level discounts/comps (percentage or fixed, with a reason and
--    who applied it - a comp with no accountability is exactly what an
--    FTA audit or an owner reviewing till discrepancies would flag).
alter table public.orders add column if not exists discount_type text check (discount_type in ('percentage', 'fixed'));
alter table public.orders add column if not exists discount_value numeric(10,2) not null default 0;
alter table public.orders add column if not exists discount_amount_aed numeric(10,2) not null default 0;
alter table public.orders add column if not exists discount_reason text default '';
alter table public.orders add column if not exists discounted_by uuid references public.profiles(id);

-- 2) Staff clock-in/clock-out - separate from till sessions (which track
--    cash, not hours). One open shift per staff member at a time.
create table if not exists public.staff_shifts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_shifts_open on public.staff_shifts(staff_id) where clock_out_at is null;
create index if not exists idx_staff_shifts_business on public.staff_shifts(business_id, clock_in_at);

alter table public.staff_shifts enable row level security;
create policy "tenant manages own staff shifts" on public.staff_shifts for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- 3) Course firing (starter/main/dessert, held until fired to the kitchen).
--    NULL course = no course assigned, behaves exactly as it does today
--    (fires immediately) - this is purely additive, existing restaurants
--    see zero behavior change unless they start using courses.
alter table public.order_items add column if not exists course text default '';
alter table public.order_items add column if not exists course_status text not null default 'fired' check (course_status in ('held', 'fired'));
alter table public.order_items add column if not exists fired_at timestamptz;

-- 4) Hotel: Tourism Dirham fee tracking for DTCM reporting - a real UAE
--    hotel compliance requirement, not a generic PMS nicety. Rate is set
--    per business (varies by hotel classification), applied per
--    room-night at check-in/night audit.
alter table public.businesses add column if not exists tourism_dirham_rate_aed numeric(10,2) not null default 0;
alter table public.hotel_folio_charges add column if not exists is_tourism_dirham boolean not null default false;

-- 5) Group/block bookings - links several reservations together (a
--    wedding party, a corporate block) so they can be viewed, adjusted,
--    and billed as one unit rather than independently.
create table if not exists public.hotel_booking_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  group_name text not null,
  contact_name text default '',
  contact_phone text default '',
  contact_email text default '',
  notes text default '',
  created_at timestamptz not null default now()
);
alter table public.hotel_reservations add column if not exists booking_group_id uuid references public.hotel_booking_groups(id) on delete set null;
create index if not exists idx_reservations_booking_group on public.hotel_reservations(booking_group_id) where booking_group_id is not null;

alter table public.hotel_booking_groups enable row level security;
create policy "tenant manages own booking groups" on public.hotel_booking_groups for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
