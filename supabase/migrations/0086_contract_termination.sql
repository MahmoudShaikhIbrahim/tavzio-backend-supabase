-- =========================================================================
-- Real fix for a confirmed gap: there was no way to cancel or terminate
-- a contract anywhere in the codebase - only create/send/sign/onboard.
-- 'terminated' has been a valid contracts.status value since migration
-- 0030, but nothing ever set it.
--
-- Confirmed requirement: terminating a contract must follow "its rules
-- and paths to the account" - meaning the real consequences the signed
-- contract text itself promises (Section 3: suspension for non-payment;
-- Section 9: termination for breach or 90-day notice; Section 4: stand
-- return) must actually happen to the business account, not just flip
-- a status column silently. terminate_reason/terminated_by/terminated_at
-- are what let the business-facing side (and any future audit) show
-- WHY and under which contractual basis a termination happened, not
-- just that it did.
-- =========================================================================

alter table public.contracts
  add column if not exists terminated_at timestamptz,
  add column if not exists terminated_by uuid references public.profiles(id),
  add column if not exists termination_reason text,
  -- Matches the contract's own Section 9 language exactly, so the
  -- reason recorded here is always one of the bases the signed
  -- document actually gives for termination - not a free-form label
  -- that could drift from what the client actually agreed to.
  add column if not exists termination_basis text
    check (termination_basis in ('non_payment', 'material_breach', 'client_convenience', 'mutual_agreement'));

comment on column public.contracts.termination_basis is
  'Which contractual basis (Agreement Section 9, or Section 3 for non_payment) this termination relies on - required whenever terminated_at is set, so a termination is always traceable to a real clause in the signed contract.';

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
    'contract_terminated', 'contract_deleted', 'email_changed'
  ));
