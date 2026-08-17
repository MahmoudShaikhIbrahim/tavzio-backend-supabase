-- =========================================================================
-- Advanced booking system - the real gap: bookings was purely an
-- appointment model (a service + a duration), which is genuinely right
-- for a salon, clinic, or gym, but has no concept of party size or a
-- table at all - useless for a restaurant reservation, and there was no
-- way for staff to create a booking themselves for a phone caller in
-- the first place. Both fixed here without touching the appointment
-- model salons/clinics/gyms already rely on - service_id stays
-- optional, exactly as it always was.
-- =========================================================================

alter table public.bookings add column if not exists party_size integer;
-- "Table" in this schema is a card, not a separate table entity (see
-- tableManagementController.js's listFloorTables) - referencing cards
-- directly, not a floor_tables table that doesn't exist.
alter table public.bookings add column if not exists table_id uuid references public.cards(id) on delete set null;
alter table public.bookings add column if not exists guest_name text default '';
-- Who actually made this booking - a real distinction for a phone
-- reservation staff typed in themselves versus one a guest submitted on
-- their own device, useful on the list and for later analysis of where
-- reservations actually come from.
alter table public.bookings add column if not exists created_by_staff_id uuid references public.profiles(id);

create index if not exists idx_bookings_table on public.bookings(table_id) where table_id is not null;

-- Contracts now capture which plan the client actually signed up for -
-- the piece "advanced selected plan explanatory" was really asking for.
-- Existing rows default to 'connect' (the lower tier) rather than left
-- null, since every prior contract predates the two-plan structure and
-- was priced closest to what Connect represents.
alter table public.contracts add column if not exists plan_type text not null default 'connect' check (plan_type in ('connect', 'full'));

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
    'booking_created_by_staff'
  ));
