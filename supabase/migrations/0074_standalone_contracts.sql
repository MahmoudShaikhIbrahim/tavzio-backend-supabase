-- =========================================================================
-- Standalone contracts - a contract can now exist, be sent, and be signed
-- entirely before any business account exists. business_id becomes
-- nullable and stays null until the deliberate "Onboard" action (fired
-- by super_admin after the contract is signed and paid) creates the real
-- business + owner account and back-fills it. Until then, the client's
-- name/email/business details live directly on the contract row.
--
-- This replaces the old flow where an owner account was created the
-- moment "Create Business" was clicked - before the client had agreed to
-- anything - and where nothing stopped a second contract being created
-- and sent to a business that was already signed/active.
-- =========================================================================

alter table public.contracts alter column business_id drop not null;

alter table public.contracts add column if not exists client_name text;
alter table public.contracts add column if not exists client_email text;
alter table public.contracts add column if not exists client_business_name text;
alter table public.contracts add column if not exists client_category text;

-- New 'paid' status: Stripe checkout has succeeded but the business
-- hasn't been onboarded yet. 'active' now specifically means "onboarded
-- and live", not just "paid" - onboarding is what makes that transition.
alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check
  check (status in ('draft', 'sent', 'signed', 'paid', 'active', 'terminated', 'expired'));

create index if not exists idx_contracts_client_email on public.contracts(client_email);

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
    'contract_onboarded'
  ));
