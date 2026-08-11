-- =========================================================================
-- Guest-facing hotel portal (NFC card in a specific room), housekeeping,
-- maintenance, and a provider-agnostic channel manager scaffold.
-- =========================================================================

-- A card placed in a hotel room, distinct from a restaurant table card -
-- nullable, only meaningful for category='hotel' businesses.
alter table public.cards add column if not exists room_id uuid references public.hotel_rooms(id) on delete set null;

create table if not exists public.housekeeping_tasks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  room_id uuid not null references public.hotel_rooms(id) on delete cascade,
  task_type text not null default 'cleaning' check (task_type in ('cleaning', 'turndown', 'inspection', 'deep_clean')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')),
  assigned_to uuid references public.profiles(id),
  notes text default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_housekeeping_business on public.housekeeping_tasks(business_id, status);

create table if not exists public.maintenance_tickets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  room_id uuid references public.hotel_rooms(id) on delete set null, -- nullable: could be a common area, not a specific room
  title text not null,
  description text default '',
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_maintenance_business on public.maintenance_tickets(business_id, status);

-- Guest-initiated requests from the in-room portal (housekeeping,
-- towels, maintenance, taxi, etc) - a lighter-weight inbox than a full
-- housekeeping_task/maintenance_ticket, since not every guest request
-- needs that much structure (e.g. "extra towels" doesn't need a
-- priority/assignment workflow the way a broken AC does).
create table if not exists public.guest_service_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  room_id uuid not null references public.hotel_rooms(id) on delete cascade,
  reservation_id uuid references public.hotel_reservations(id) on delete set null,
  request_type text not null default 'other' check (request_type in ('towels', 'housekeeping', 'maintenance', 'taxi', 'laundry', 'other')),
  note text default '',
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_guest_requests_business on public.guest_service_requests(business_id, status);

alter table public.housekeeping_tasks enable row level security;
alter table public.maintenance_tickets enable row level security;
alter table public.guest_service_requests enable row level security;

create policy "tenant manages own housekeeping" on public.housekeeping_tasks for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own maintenance" on public.maintenance_tickets for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own guest requests" on public.guest_service_requests for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Guests submit requests through the public tap portal, same trust
-- model as every other public-facing write in this schema (order
-- submission, loyalty check-in, etc) - service-role inserts only,
-- never a direct anon RLS grant.
alter publication supabase_realtime add table public.guest_service_requests;
alter publication supabase_realtime add table public.housekeeping_tasks;

-- =========================================================================
-- Channel manager integration - deliberately provider-agnostic. Unlike
-- Deliverect (whose real webhook shape was verified against their public
-- docs), no specific channel manager (SiteMinder, RateGain, etc) has
-- been chosen yet, so this is a generic inbound/outbound scaffold, not a
-- vendor-specific implementation - the exact payload mapping is real
-- work to do once a provider is actually chosen.
-- =========================================================================
create table if not exists public.channel_manager_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade unique,
  provider text default '', -- e.g. 'siteminder', 'ratengain' - set once a vendor is chosen
  external_property_id text default '',
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.channel_manager_integrations enable row level security;
create policy "tenant manages own channel manager integration" on public.channel_manager_integrations for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter table public.hotel_reservations add column if not exists ota_booking_reference text default '';
