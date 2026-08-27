-- Real one-time backfill, not another code fix - the voidOrderItem fix
-- (recalculating an order's total whenever an item is voided) only
-- corrects totals going forward. Any order that had an item voided
-- BEFORE that fix shipped is still carrying its stale, pre-void total
-- right now, and will keep showing it forever unless something voids
-- another item on it (which may never happen). This recomputes every
-- order's total from its actual live (non-voided) items, once, so
-- existing data catches up immediately instead of waiting on a future
-- void that might never come. Correctly subtracts each order's own
-- already-locked-in discount_amount_aed from the new subtotal, so a
-- genuinely discounted or comped order doesn't get its total silently
-- overwritten with the full undiscounted sum.
update public.orders o
set total = greatest(0, coalesce((
  select sum((oi.unit_price + oi.addon_total) * oi.quantity)
  from public.order_items oi
  where oi.order_id = o.id and oi.voided = false
), 0) - coalesce(o.discount_amount_aed, 0))
where o.request_type = 'order'
  and o.voided = false;
