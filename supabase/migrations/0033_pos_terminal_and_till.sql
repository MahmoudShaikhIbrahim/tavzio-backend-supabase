-- =========================================================================
-- Phase 3, part 1: POS terminal (staff-placed walk-in/phone/takeaway
-- orders, no NFC tap involved) + per-staff till sessions with cash
-- reconciliation (X/Z report equivalent).
-- =========================================================================

create table if not exists public.till_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id),
  opening_float_aed numeric not null default 0,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  -- Computed at close time: opening float + every cash POS order taken
  -- during this session. counted_cash_aed is what the staff member
  -- physically counted in the drawer; variance is the honest difference
  -- between what the system expected and what was actually there -
  -- never silently corrected, always on record.
  expected_cash_aed numeric,
  counted_cash_aed numeric,
  variance_aed numeric,
  notes text default ''
);

create index if not exists idx_till_sessions_business on public.till_sessions(business_id, opened_at desc);
create index if not exists idx_till_sessions_staff_open on public.till_sessions(staff_id) where status = 'open';

alter table public.till_sessions enable row level security;

create policy "tenant manages own till sessions" on public.till_sessions for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Orders placed by staff at a terminal (walk-in/phone/takeaway) rather
-- than by a customer tapping their own card. card_id/table_label were
-- already nullable/free-text, so no change needed there - a POS order
-- just uses table_label as a plain description ("Walk-in", "Phone #3")
-- with card_id left null.
alter table public.orders add column if not exists source text not null default 'customer_tap' check (source in ('customer_tap', 'staff_pos'));
alter table public.orders add column if not exists till_session_id uuid references public.till_sessions(id) on delete set null;
alter table public.orders add column if not exists payment_method text check (payment_method in ('cash', 'card', 'other'));
alter table public.orders add column if not exists placed_by uuid references public.profiles(id);

create index if not exists idx_orders_till_session on public.orders(till_session_id) where till_session_id is not null;
