-- Real, explicit request: drive-through orders are genuine `orders` rows
-- flowing through the exact same Kitchen/Orders/POS pipeline every other
-- order already does - not a separate system - just visually distinct
-- and carrying a real arrival window. This is the schema for that.

-- Widen the order_type check constraint to include 'drive_through',
-- without assuming the exact auto-generated name Postgres gave the
-- original constraint (0099_order_type.sql added it inline, unnamed) -
-- guessing wrong and using `drop constraint if exists <guess>` would
-- silently leave the OLD constraint in place alongside a new one,
-- and inserts would still fail since every check constraint on a
-- column must pass. Looking it up from pg_constraint directly is the
-- only reliable way to drop the real one regardless of its name.
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.orders'::regclass
    and pg_get_constraintdef(oid) ilike '%order_type%';
  if constraint_name is not null then
    execute format('alter table public.orders drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.orders
  add constraint orders_order_type_check
    check (order_type in ('dine_in', 'walk_in', 'pickup', 'delivery', 'drive_through'));

-- The customer-selected arrival window (5-30 minutes from when they
-- placed the order, enforced server-side) - only ever set for
-- drive_through orders; null for everything else. This is what lets
-- Kitchen/Orders/POS show a real, live countdown instead of just a
-- static "drive-through" label.
--
-- Real correction made while building this: a "pay first" drive-through
-- order does NOT need a new staging mechanism at all - this codebase
-- already has a complete, proven pipeline for exactly this
-- (migration 0029, order status 'awaiting_payment' - an order that
-- exists but is invisible to Kitchen/Orders/POS until payment confirms,
-- at which point it flips to a normal visible status). Drive-through's
-- "pay first" mode reuses that exact mechanism instead of inventing a
-- second one, so no new payments column is needed here after all.
alter table public.orders
  add column if not exists arrival_at timestamptz;

