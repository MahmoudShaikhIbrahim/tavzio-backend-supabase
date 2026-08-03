-- =========================================================================
-- 1. Special offers - deliberately NOT a real category an item gets moved
--    into and back out of. An item stays in its real category always;
--    when offer_price is set and "now" falls inside [starts_at, ends_at],
--    it's ALSO surfaced under a computed "Special Offers" section at the
--    top of the menu, with the original price struck through next to the
--    offer price. This means expiry needs zero cleanup logic anywhere -
--    it's naturally always correct because it's derived live from the
--    current time, never stored as a state that could get stuck.
-- =========================================================================
alter table public.menu_items
  add column if not exists offer_price numeric,
  add column if not exists offer_starts_at timestamptz,
  add column if not exists offer_ends_at timestamptz;

-- =========================================================================
-- 2. Notification badges - shared across all staff on a business (not
--    per-staff-member), matching how Requests already works today (one
--    dismiss clears it for everyone). One row per business per dashboard
--    section, tracking when that section was last opened by ANYONE on
--    staff - a badge count is just "how many relevant things were
--    created after this timestamp."
-- =========================================================================
create table if not exists public.dashboard_section_views (
  business_id uuid not null references public.businesses(id) on delete cascade,
  section text not null check (section in ('orders', 'requests', 'payments')),
  last_viewed_at timestamptz not null default now(),
  primary key (business_id, section)
);

alter table public.dashboard_section_views enable row level security;

create policy "tenant can read own section views"
  on public.dashboard_section_views for select
  to authenticated
  using (business_id = public.current_business_id());

create policy "tenant can upsert own section views"
  on public.dashboard_section_views for insert
  to authenticated
  with check (business_id = public.current_business_id());

create policy "tenant can update own section views"
  on public.dashboard_section_views for update
  to authenticated
  using (business_id = public.current_business_id());
