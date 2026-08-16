-- =========================================================================
-- Advanced folio & billing management (hotel roadmap, module 6). The
-- real gap: hotel_folios already had payer_type/company_name (a folio
-- could be marked "bill to company" since migration 0038), but checkOut
-- never actually implemented direct billing - a company folio with an
-- outstanding balance blocked checkout exactly like a personal one,
-- which defeats the entire point of a corporate account. A real city
-- ledger (accounts receivable) closes that gap.
-- =========================================================================

alter table public.hotel_folios drop constraint if exists hotel_folios_status_check;
alter table public.hotel_folios add constraint hotel_folios_status_check
  check (status in ('open', 'closed', 'billed_to_account'));

create table if not exists public.hotel_city_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  folio_id uuid not null references public.hotel_folios(id) on delete cascade unique,
  company_name text not null,
  amount_aed numeric not null,
  billed_at timestamptz not null default now(),
  paid_at timestamptz,
  payment_reference text default '',
  notes text default ''
);
create index if not exists idx_city_ledger_business on public.hotel_city_ledger_entries(business_id, paid_at);

alter table public.hotel_city_ledger_entries enable row level security;
create policy "tenant manages own city ledger" on public.hotel_city_ledger_entries for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Catches up the audit log constraint with every action added across
-- this session's hotel work that was never actually registered here -
-- logAction fails silently (no throw), so those calls have been quietly
-- no-op-ing rather than breaking anything, but the audit trail itself
-- was incomplete. Fixed for real, not just left as a known gap.
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
    'city_ledger_settled'
  ));
