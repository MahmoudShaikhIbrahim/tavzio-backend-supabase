-- =========================================================================
-- Fixes a real, currently-blocking gap: there was no way for a super
-- admin or business owner to reset a locked-out account's password.
-- Owners get a temporary password at account creation and are forced to
-- change it on first login - but if they forget the new one, or a
-- staff member forgets theirs, nobody had any path back in. Adding a
-- real audit action for this rather than reusing an unrelated one.
-- =========================================================================

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed',
    'reservation_created', 'reservation_checked_in', 'reservation_checked_out', 'reservation_cancelled',
    'folio_charge_added', 'folio_payment_recorded', 'folio_refund_issued', 'folio_adjustment_made',
    'folio_split', 'folio_transferred', 'night_audit_run',
    'password_reset'
  ));
