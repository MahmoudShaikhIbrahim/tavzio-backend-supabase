-- =========================================================================
-- Ordering pause toggles - owner/staff controlled, day-to-day (not a
-- platform-granted entitlement like features.ordering, which only
-- super_admin sets). Lets a business pause the whole kitchen ("closed
-- right now, too busy") or just one category ("food's paused, hookahs
-- still orderable") without touching every individual item's own
-- availability.
--
-- Also: is_available on menu_items now means "show it, grayed out,
-- can't be ordered" rather than "hide it entirely" - the customer-facing
-- read no longer filters these out, letting the frontend render the
-- disabled state instead of making the item vanish.
-- =========================================================================

alter table public.businesses
  add column if not exists ordering_paused boolean not null default false;

alter table public.menu_categories
  add column if not exists paused boolean not null default false;
