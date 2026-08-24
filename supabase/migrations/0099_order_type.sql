-- Real bug fix: every non-table POS order defaulted to the literal
-- string 'Walk-in' for table_label, and the Orders page groups orders
-- by that exact string (`const key = o.table_label || 'No table'`) -
-- so every walk-in order rung up in a day collapsed into one visual
-- bucket unless staff manually retyped something unique each time.
-- order_type is a real, separate semantic field (not a substitute for
-- table_label, which stays free text for an actual table number or a
-- custom name/phone) - Orders/Kitchen can now group and filter by real
-- type, and createPosOrder auto-numbers the label server-side per type
-- per business per day so two walk-in orders never collide by default
-- again, regardless of how many POS terminals are ringing up orders at
-- once.
alter table public.orders
  add column if not exists order_type text not null default 'walk_in'
    check (order_type in ('dine_in', 'walk_in', 'pickup', 'delivery'));

create index if not exists idx_orders_business_type_created
  on public.orders(business_id, order_type, created_at desc);
