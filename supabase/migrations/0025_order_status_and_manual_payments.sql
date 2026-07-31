-- =========================================================================
-- 1. Simplify order status: pending -> ready -> completed (+ cancelled).
--    'preparing' removed - kitchen-stage granularity nobody was using.
--    Existing rows sitting in 'preparing' are moved to 'ready' first so
--    the new CHECK constraint doesn't reject real data.
-- =========================================================================
update public.orders set status = 'ready' where status = 'preparing';

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending', 'ready', 'completed', 'cancelled'));

-- =========================================================================
-- 2. Customer-facing "pay in cash" intent. This does NOT mark an item
--    paid - it only flags that a customer has said they'll settle it in
--    cash, so staff can be alerted and go collect it. The item stays
--    fully visible and still payable online by anyone at the table in
--    the meantime (whoever gets there first, same as any split-bill
--    item) - only an explicit staff confirmation (via the same payments
--    flow as any other manual settlement) actually marks it paid and
--    clears this flag.
-- =========================================================================
alter table public.order_items
  add column if not exists cash_pending boolean not null default false;

-- =========================================================================
-- 3. Staff-recorded manual settlements (cash / card machine / other) live
--    as ordinary rows in the existing payments table, distinguished only
--    by provider ('manual_cash' / 'manual_card_machine' / 'manual_other'
--    vs the online gateways). recorded_by is the accountability trail -
--    which staff member confirmed the money actually came in.
-- =========================================================================
alter table public.payments
  add column if not exists recorded_by uuid references public.profiles(id) on delete set null;
