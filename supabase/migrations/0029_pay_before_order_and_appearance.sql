-- =========================================================================
-- Pay-before-order (card + cash), Table Receipts + printer connector,
-- audit log fixes, and business appearance customization.
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. ORDER STATUS — new 'awaiting_payment' state. An order sitting here
--    has real, server-priced items already saved, but is invisible to
--    Kitchen/Orders and never pushed to POS until payment genuinely
--    clears (card, redirect, or staff-confirmed cash) - see
--    orderController.recordManualPayment and publicController's new
--    orders/pay, orders/pay-session, orders/pay-cash, orders/confirm-payment.
-- ---------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('awaiting_payment', 'pending', 'ready', 'completed', 'cancelled'));

-- ---------------------------------------------------------------------
-- 2. FEATURES — new self-service ordering toggle, payBeforeOrder.
--    Off by default for every existing business (backfilled) and for
--    every new business (default template updated) - nothing changes
--    for anyone until an owner/staff member explicitly turns it on, and
--    the frontend additionally requires a connected payment integration
--    before the toggle is enabled.
-- ---------------------------------------------------------------------
update public.businesses
set features = jsonb_set(features, '{ordering,payBeforeOrder}', 'false'::jsonb)
where not (features->'ordering' ? 'payBeforeOrder');

alter table public.businesses
  alter column features set default '{
    "accessMethods": {"card": false, "website": true},
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false, "payBeforeOrder": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false
  }'::jsonb;

-- ---------------------------------------------------------------------
-- 3. AUDIT LOG — two real, pre-existing bugs fixed: 'manual_payment_recorded'
--    and 'payment_integration_updated' are both already used in code
--    (orderController.js, paymentController.js) but were never added to
--    this constraint, so every one of those inserts has been silently
--    failing since they shipped. Also adds 'receipt_item_removed' for
--    the new Table Receipts adjustment feature below.
-- ---------------------------------------------------------------------
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed'
  ));

-- ---------------------------------------------------------------------
-- 4. POS_INTEGRATIONS — new 'printing' purpose (PrintNode connector for
--    Table Receipts) and 'printnode' provider. Same owner-only lockdown
--    as 'payment' - a printer API key is a credential like any other,
--    not even super_admin can read the raw config, only a sanitized
--    connected/not-connected status via the controller.
-- ---------------------------------------------------------------------
alter table public.pos_integrations drop constraint if exists pos_integrations_purpose_check;
alter table public.pos_integrations
  add constraint pos_integrations_purpose_check check (purpose in ('ordering', 'booking', 'payment', 'printing'));

alter table public.pos_integrations drop constraint if exists pos_integrations_provider_check;
alter table public.pos_integrations
  add constraint pos_integrations_provider_check
  check (provider in ('foodics', 'square', 'zenoti', 'loyverse', 'fresha', 'tap', 'telr', 'ngenius', 'ziina', 'custom', 'printnode'));

drop policy if exists "owner manages own payment integration" on public.pos_integrations;
create policy "owner manages own payment integration"
  on public.pos_integrations for all
  to authenticated
  using (
    purpose in ('payment', 'printing')
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  )
  with check (
    purpose in ('payment', 'printing')
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  );

-- ---------------------------------------------------------------------
-- 5. APPEARANCE — background + button color, two independent settings:
--    one for the customer-facing NFC pages (Landing/Menu/Bill/Booking),
--    one shared business-wide for the owner/staff dashboard itself (not
--    per-person - deliberately separate from profiles.theme_preference,
--    which stays the existing per-account dark/light toggle). Both
--    default to null - null means "use Tavzio's own default palette",
--    so this is fully backward compatible until an owner picks a color.
-- ---------------------------------------------------------------------
update public.businesses
set theme = theme || '{"customerBackground": null, "customerButton": null, "dashboardBackground": null, "dashboardButton": null}'::jsonb
where not (theme ? 'customerBackground');

alter table public.businesses
  alter column theme set default '{
    "darkMode": true,
    "accentColor": "",
    "customerBackground": null,
    "customerButton": null,
    "dashboardBackground": null,
    "dashboardButton": null
  }'::jsonb;
