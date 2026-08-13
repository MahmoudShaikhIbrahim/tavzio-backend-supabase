-- Real bug fix, same class as migration 0050: booking_group_created
-- (used by hotelBookingGroupsController.js) was never added to this
-- constraint when that feature was built, meaning every "create booking
-- group" request has been failing with a 500 the whole time, since
-- logAction's insert throws on the constraint violation and that
-- throw propagates up through asyncHandler. Also adding this session's
-- two new linked-account actions up front, so account switching doesn't
-- ship with the same bug on day one.
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
    'linked_accounts_created', 'account_switched', 'org_menu_published'
  ));
