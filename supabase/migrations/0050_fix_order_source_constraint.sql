-- Real bug fix, found while building Sales by Channel: the hotel guest
-- portal's room-service ordering (built in migration 0045-era work)
-- inserts source = 'guest_portal_hotel', but the check constraint from
-- migration 0035 never included it - only 'customer_tap', 'staff_pos',
-- and 'delivery' were ever allowed. Every hotel guest F&B order has been
-- failing at the database level since that feature was built. This also
-- widens the constraint to the fuller channel vocabulary Sales by
-- Channel needs to report against.
alter table public.orders drop constraint if exists orders_source_check;
alter table public.orders add constraint orders_source_check
  check (source in ('customer_tap', 'staff_pos', 'delivery', 'guest_portal_hotel'));
