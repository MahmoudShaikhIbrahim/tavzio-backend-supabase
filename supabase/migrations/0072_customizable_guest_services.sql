-- =========================================================================
-- Real fix for a genuine gap: the hotel guest portal's "Services" list
-- (Extra towels, Turndown, Housekeeping, Report an issue, Laundry
-- pickup, Transportation, Pool service) was hardcoded directly in the
-- frontend component - no owner could rename, hide, reorder, or add to
-- any of it. This table makes that data-driven per business, while
-- keeping the underlying routing_type fixed to the values the backend
-- already knows how to route (housekeeping_tasks vs maintenance_tickets
-- vs guest_service_requests) - only the guest-facing label, sub-options,
-- visibility, and order become owner-controlled.
-- =========================================================================

create table if not exists public.hotel_guest_services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- What this actually routes to on submission - fixed set, matches
  -- submitGuestRequest's own routing logic exactly. A custom/new service
  -- an owner adds routes through 'other' (a plain guest_service_requests
  -- row staff see in Requests) unless they deliberately pick one of the
  -- task-creating types.
  routing_type text not null check (routing_type in ('towels', 'turndown', 'housekeeping', 'maintenance', 'taxi', 'laundry', 'pool', 'transportation', 'other')),
  label text not null,
  options text[] not null default '{}',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_guest_services_business on public.hotel_guest_services(business_id, sort_order);

alter table public.hotel_guest_services enable row level security;
create policy "tenant manages own guest services" on public.hotel_guest_services for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Guests browsing the portal (anonymous) need to read the enabled list -
-- same public-read pattern already used for custom_buttons.
create policy "public reads enabled guest services" on public.hotel_guest_services for select to anon
  using (enabled = true);

-- Seeds every existing hotel business with today's exact hardcoded list,
-- so nothing changes for anyone until they actually customize it. Guarded
-- by "this business has no rows yet" rather than ON CONFLICT (no unique
-- constraint exists to conflict against) - safe even if this migration
-- were ever re-run.
insert into public.hotel_guest_services (business_id, routing_type, label, options, sort_order)
select b.id, v.routing_type, v.label, v.options, v.sort_order
from public.businesses b
cross join (values
  ('towels', 'Extra towels', array[]::text[], 0),
  ('turndown', 'Turndown service', array[]::text[], 1),
  ('housekeeping', 'Housekeeping', array[]::text[], 2),
  ('maintenance', 'Report an issue', array['Air Conditioning','Lights','Bathroom','Door','TV','Electricity','Plumbing','Other'], 3),
  ('laundry', 'Laundry pickup', array['Express','Same Day','Standard'], 4),
  ('transportation', 'Transportation', array['Taxi','Airport Transfer','Hotel Car'], 5),
  ('pool', 'Pool service', array['Request Towel','Sunbed Assistance','Other'], 6)
) as v(routing_type, label, options, sort_order)
where b.category = 'hotel'
  and not exists (select 1 from public.hotel_guest_services existing where existing.business_id = b.id);
