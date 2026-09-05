-- Real, longstanding bug found: migration 0029 replaced this constraint
-- to add 'awaiting_payment' but silently dropped 'preparing' from the
-- allowed list in the process. Every "Start" tap on the Kitchen page
-- since then has been failing this CHECK constraint on the database
-- itself - masked by updateOrderStatus's own error handling, which
-- treats any failed 'preparing' update as "already started" and quietly
-- returns the unchanged row as if it succeeded. The order looked like it
-- moved to "In progress" in the tab that clicked Start (optimistic UI),
-- then reverted the moment that tab reloaded or another tab opened the
-- same data, because the database was never actually updated.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('awaiting_payment', 'pending', 'preparing', 'ready', 'completed', 'cancelled'));
