-- =========================================================================
-- Advanced hotel financial requirements: night audit/EOD, advanced
-- folios (deposits/refunds/adjustments/split/transfer/company-paid),
-- audit trail, rate management, and double-booking prevention (the part
-- of "central inventory" that's actually buildable without a channel
-- manager - real OTA sync needs a channel manager partner integration,
-- same situation as delivery platforms, scaffolded separately).
-- =========================================================================

-- --- Split folios + company/guest billing ---
-- A reservation can now have more than one folio (e.g. one company-paid,
-- one guest-paid) - the old one-folio-per-reservation unique constraint
-- is dropped in favor of tracking which folio is the "primary" one
-- created at check-in.
alter table public.hotel_folios drop constraint if exists hotel_folios_reservation_id_key;
alter table public.hotel_folios add column if not exists is_primary boolean not null default true;
alter table public.hotel_folios add column if not exists payer_type text not null default 'guest' check (payer_type in ('guest', 'company'));
alter table public.hotel_folios add column if not exists company_name text default '';

-- Wider charge_type vocabulary for advanced folio operations.
alter table public.hotel_folio_charges drop constraint if exists hotel_folio_charges_charge_type_check;
alter table public.hotel_folio_charges add constraint hotel_folio_charges_charge_type_check
  check (charge_type in ('room', 'fnb', 'service', 'other', 'payment', 'deposit', 'refund', 'adjustment'));

-- --- Audit trail for every financial transaction ---
-- Reuses the existing audit_log table/utility (already used everywhere
-- else in the app) rather than a parallel hotel-only log - one place to
-- look for "who did what, when" across the whole platform.
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed',
    'reservation_created', 'reservation_checked_in', 'reservation_checked_out', 'reservation_cancelled',
    'folio_charge_added', 'folio_payment_recorded', 'folio_refund_issued', 'folio_adjustment_made',
    'folio_split', 'folio_transferred', 'night_audit_run'
  ));

-- --- Rate management ---
create table if not exists public.hotel_rate_plans (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  rate_type text not null default 'flexible' check (rate_type in (
    'seasonal', 'weekend', 'corporate', 'promotional', 'non_refundable',
    'flexible', 'package', 'breakfast_included', 'half_board', 'full_board'
  )),
  base_rate_aed numeric not null default 0,
  is_refundable boolean not null default true,
  meal_plan text not null default 'none' check (meal_plan in ('none', 'breakfast', 'half_board', 'full_board')),
  valid_from date,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.hotel_rate_plans enable row level security;
create policy "tenant manages own rate plans" on public.hotel_rate_plans for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter table public.hotel_reservations add column if not exists rate_plan_id uuid references public.hotel_rate_plans(id) on delete set null;

-- --- Night audit / end-of-day ---
create table if not exists public.hotel_night_audits (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  business_date date not null,
  run_at timestamptz not null default now(),
  run_by uuid references public.profiles(id),
  room_revenue_aed numeric not null default 0,
  fnb_revenue_aed numeric not null default 0,
  other_revenue_aed numeric not null default 0,
  total_payments_aed numeric not null default 0,
  rooms_sold integer not null default 0,
  rooms_available integer not null default 0,
  occupancy_rate numeric not null default 0,
  arrivals_count integer not null default 0,
  departures_count integer not null default 0,
  unique (business_id, business_date)
);

create index if not exists idx_night_audits_business on public.hotel_night_audits(business_id, business_date desc);

alter table public.hotel_night_audits enable row level security;
create policy "tenant manages own night audits" on public.hotel_night_audits for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- The hotel's current open business date - what "today" means for
-- folio charges and the night audit, distinct from the calendar date so
-- a hotel that hasn't run its audit yet is still operating "yesterday"
-- as far as the books are concerned.
create table if not exists public.hotel_business_date (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  current_date_value date not null default current_date
);

alter table public.hotel_business_date enable row level security;
create policy "tenant manages own business date" on public.hotel_business_date for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
