-- =========================================================================
-- Kitchen marking an order "ready" needs to actively notify whoever's on
-- the Orders page - not just a silent status flip they might not notice.
-- This is purely a notification-seen flag, deliberately separate from
-- the order's own status: dismissing the notification never touches the
-- order itself, same principle as dismissing Call Waiter doesn't
-- resolve anything about the order it came from.
-- =========================================================================
alter table public.orders
  add column if not exists ready_ack boolean not null default true;

-- Existing rows default to true (nothing to notify about retroactively -
-- only orders marked ready going forward should ever produce a
-- notification). New row inserts and 'ready' transitions explicitly set
-- this to false in application code.
