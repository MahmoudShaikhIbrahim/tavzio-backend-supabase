-- =========================================================================
-- Advanced inventory (restaurant roadmap, module 1): partial PO receiving
-- and richer waste tracking. Additive only - existing full-receive flow,
-- ingredients, recipes, and stock movements are untouched.
-- =========================================================================

-- Partial receiving - a delivery rarely arrives complete in one shot (a
-- supplier short-ships an item, or a second truck comes later). Tracks
-- how much of each PO line has actually been received so far, separate
-- from the ordered quantity, so a PO can be received in more than one
-- pass without losing track of what's still outstanding.
alter table public.purchase_order_items
  add column if not exists received_quantity numeric not null default 0;

alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in ('pending', 'partially_received', 'received', 'cancelled'));

-- Waste needs a reason category beyond the free-text note - "why" matters
-- for a real food-cost report (spoilage vs. prep error vs. breakage are
-- different operational problems with different fixes), not just "how
-- much". Nullable: only meaningful when stock_movements.reason = 'waste'.
alter table public.stock_movements
  add column if not exists waste_category text
    check (waste_category is null or waste_category in ('spoilage', 'prep_error', 'breakage', 'expired', 'other'));
