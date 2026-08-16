-- Adds the "undo an Add Charge" capability - a real gap: there was
-- genuinely no way to delete a folio charge once added, no "security
-- come back" if it was a mistake. Only covers charges specifically -
-- a payment, deposit, or refund represents money that already actually
-- moved, so those stay permanent records on purpose; a charge that
-- hasn't been paid yet is safe to reverse.
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
    'folio_charge_deleted'
  ));
