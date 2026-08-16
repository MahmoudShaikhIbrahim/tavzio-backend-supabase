-- =========================================================================
-- Advanced KDS (restaurant roadmap, module 7). The 'preparing' status
-- already existed in orders_status_check but was never reachable through
-- the API - this closes that gap for real, plus adds timing (for a
-- kitchen performance report) and station routing.
-- =========================================================================

alter table public.orders add column if not exists prep_started_at timestamptz;
alter table public.orders add column if not exists ready_at timestamptz;

-- Which physical station in the kitchen makes this item (Grill, Cold,
-- Dessert, Bar, etc.) - free text, owner-defined, not a fixed enum, since
-- every kitchen's own station layout is different. Null = unassigned,
-- shows on every station view rather than disappearing from all of them.
alter table public.menu_items add column if not exists station text default '';
