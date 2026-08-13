-- Split-bill race condition fix: two customers at the same table could
-- both select overlapping unpaid items and both get charged, since the
-- old "unpaid items" query only checked `paid = false` - nothing
-- stopped a second payment attempt from starting while the first was
-- already in flight (the charge itself happens on the gateway's side,
-- seconds before this app ever marks anything paid, so a guard only at
-- the final "mark paid" step is too late - by then both cards may have
-- already been charged).
--
-- The fix: the moment a payment attempt genuinely starts for a set of
-- items (not when it completes), they're reserved for a short window.
-- A second attempt for any of the same items during that window is
-- rejected outright, before any card is ever charged. The reservation
-- expires on its own (5 minutes) if the flow is abandoned, so a
-- genuinely stuck reservation never permanently locks an item.
alter table public.order_items add column if not exists payment_reserved_until timestamptz;
create index if not exists idx_order_items_payment_reserved on public.order_items(payment_reserved_until) where payment_reserved_until is not null;
