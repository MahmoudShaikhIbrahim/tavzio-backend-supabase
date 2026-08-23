-- =========================================================================
-- Online booking, confirmed scope: a business can turn on public
-- booking (with an optional food pre-order step, toggleable
-- independently), require phone OTP verification before a booking is
-- accepted, optionally require a down payment (full/percentage/fixed,
-- toggleable), and track arrival via two independent paths - staff
-- marking it directly, or the guest confirming on their own device
-- after tapping the table's NFC card, whichever happens first.
--
-- Reuses existing infrastructure rather than duplicating it:
-- - public.payments already has real gateway-charge tracking (refunds,
--   provider, audit trail) - a down payment gets a booking_id link on
--   the SAME table, not a parallel payments system.
-- - public.menu_items already exists for pre-order items - booking_items
--   references it directly, the same way order_items does for regular
--   orders.
-- - public.businesses.features (jsonb) already holds every other
--   per-business toggle - booking config lives there too, not new
--   dedicated columns, consistent with how every other feature flag in
--   this schema is stored. Application code reads/writes an
--   "onlineBooking" key (deliberately NOT "booking" - that key already
--   existed with a different, unrelated shape gating the internal
--   staff-facing bookings tab - see DashboardLayout.tsx's nav gating -
--   reusing it would have silently collided with that) shaped like:
--   {
--     "enabled": boolean,
--     "allowPreOrder": boolean,        -- booking-only vs booking+food
--     "downPayment": {
--       "enabled": boolean,
--       "mode": "full" | "percentage" | "fixed",
--       "value": number                -- percentage (0-100) or AED amount; ignored for "full"
--     }
--   }
-- =========================================================================

alter table public.payments add column if not exists booking_id uuid references public.bookings(id) on delete set null;
create index if not exists idx_payments_booking on public.payments(booking_id) where booking_id is not null;

-- Pre-ordered items tied to a booking - only populated when the
-- business has allowPreOrder on AND the customer actually added items;
-- an empty set here means "table only," exactly matching the
-- booking-only toggle's intent without needing a separate flag on the
-- booking row itself.
create table if not exists public.booking_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  item_name text not null default '', -- snapshot, survives the menu item being renamed/deleted later
  quantity integer not null default 1,
  unit_price numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_booking_items_booking on public.booking_items(booking_id);

-- Short-lived phone verification codes - a booking is only ever
-- created after one of these is verified, so this table's own
-- verified_at is the proof, not something duplicated onto the booking
-- row itself. Cleared out by age, not by a foreign key, since a
-- verification can legitimately happen before the booking row exists
-- yet (verify first, then submit the booking).
create table if not exists public.booking_otp_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone text not null,
  code text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_booking_otp_phone on public.booking_otp_codes(business_id, phone, created_at desc);

alter table public.bookings
  add column if not exists customer_phone_verified boolean not null default false,
  -- 0 = ready exactly at reservation time; 5/10/15 = ready that many
  -- minutes after arrival is confirmed (by whichever path gets there
  -- first). Null means no food pre-order on this booking at all -
  -- distinct from 0, which is a real, deliberate choice the customer made.
  add column if not exists food_ready_offset_minutes integer check (food_ready_offset_minutes in (0, 5, 10, 15)),
  add column if not exists arrival_status text not null default 'not_arrived' check (arrival_status in ('not_arrived', 'arrived')),
  add column if not exists arrived_at timestamptz,
  -- Which path actually confirmed it - staff saw the guest, or the
  -- guest tapped their assigned table's card and confirmed on their
  -- own device. Both are legitimate; this is just which one won.
  add column if not exists arrived_via text check (arrived_via in ('staff', 'customer_tap')),
  add column if not exists down_payment_required_aed numeric(10,2) not null default 0,
  add column if not exists down_payment_status text not null default 'not_required'
    check (down_payment_status in ('not_required', 'pending', 'paid', 'failed', 'refunded'));

-- A tap on this table's card, while a confirmed-but-not-yet-arrived
-- booking is assigned to it, is what shows the "Confirm arrival" screen
-- (see publicController.js) - this is what makes that lookup a single
-- indexed query instead of a full table scan on every single tap this
-- business ever receives.
create index if not exists idx_bookings_table_arrival on public.bookings(table_id, arrival_status) where table_id is not null and status = 'confirmed';

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed',
    'reservation_created', 'reservation_checked_in', 'reservation_checked_out', 'reservation_cancelled',
    'folio_charge_added', 'folio_payment_recorded', 'folio_refund_issued', 'folio_adjustment_made',
    'folio_split', 'folio_transferred', 'night_audit_run',
    'password_reset',
    'booking_group_created',
    'linked_accounts_created', 'account_switched', 'org_menu_published',
    'folio_charge_deleted',
    'reservation_no_show', 'reservation_modified', 'reservation_room_transferred',
    'city_ledger_settled',
    'event_created', 'event_status_changed',
    'booking_created_by_staff',
    'contract_onboarded',
    'full_access_granted', 'full_access_revoked',
    'contract_terminated', 'contract_deleted', 'email_changed',
    'stock_transfer_received', 'org_purchase_order_created',
    'booking_arrival_confirmed', 'booking_down_payment_charged'
  ));

alter table public.booking_items enable row level security;
create policy "tenant can access own booking items" on public.booking_items for all to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.business_id = public.current_business_id()))
  with check (exists (select 1 from public.bookings b where b.id = booking_id and b.business_id = public.current_business_id()));

alter table public.booking_otp_codes enable row level security;
create policy "tenant can access own otp codes" on public.booking_otp_codes for all to authenticated
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());
