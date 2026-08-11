-- =========================================================================
-- Phase 3 (hotel): PMS core. A reservation is the central object -
-- check-in/check-out are status transitions on it rather than a
-- separate "stay" table, keeping one source of truth for "is this
-- guest currently in the hotel" instead of two tables that could drift
-- out of sync with each other.
-- =========================================================================

create table if not exists public.hotel_rooms (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  room_number text not null,
  room_type text not null default 'standard',
  floor text default '',
  max_occupancy integer not null default 2,
  base_rate_aed numeric not null default 0,
  status text not null default 'available' check (status in ('available', 'occupied', 'dirty', 'maintenance', 'out_of_order')),
  created_at timestamptz not null default now(),
  unique (business_id, room_number)
);

create table if not exists public.hotel_guests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  email text default '',
  phone text default '',
  id_document_type text default '',
  id_document_number text default '',
  nationality text default '',
  notes text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.hotel_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  guest_id uuid not null references public.hotel_guests(id),
  room_id uuid references public.hotel_rooms(id),
  check_in_date date not null,
  check_out_date date not null,
  adults integer not null default 1,
  children integer not null default 0,
  status text not null default 'confirmed' check (status in ('confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  source text not null default 'direct' check (source in ('direct', 'walk_in', 'ota', 'phone')),
  rate_aed numeric not null default 0, -- per-night rate agreed at booking, may differ from room's current base_rate_aed
  actual_check_in_at timestamptz,
  actual_check_out_at timestamptz,
  notes text default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_reservations_business on public.hotel_reservations(business_id, status);
create index if not exists idx_reservations_room on public.hotel_reservations(room_id) where status = 'checked_in';

create table if not exists public.hotel_folios (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  reservation_id uuid not null references public.hotel_reservations(id) unique,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.hotel_folio_charges (
  id uuid primary key default gen_random_uuid(),
  folio_id uuid not null references public.hotel_folios(id) on delete cascade,
  description text not null,
  amount_aed numeric not null,
  charge_type text not null default 'other' check (charge_type in ('room', 'fnb', 'service', 'other', 'payment')),
  -- payment charge_type rows use a NEGATIVE amount_aed - a payment taken
  -- against the folio, reducing the balance, in the same running ledger
  -- rather than a separate table to reconcile against.
  source_order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_folio_charges_folio on public.hotel_folio_charges(folio_id);

alter table public.hotel_rooms enable row level security;
alter table public.hotel_guests enable row level security;
alter table public.hotel_reservations enable row level security;
alter table public.hotel_folios enable row level security;
alter table public.hotel_folio_charges enable row level security;

create policy "tenant manages own rooms" on public.hotel_rooms for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own guests" on public.hotel_guests for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own reservations" on public.hotel_reservations for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own folios" on public.hotel_folios for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own folio charges" on public.hotel_folio_charges for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.hotel_folios f where f.id = folio_id and f.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.hotel_folios f where f.id = folio_id and f.business_id = public.current_business_id())
  );

-- Links a normal Tavzio order (F&B, POS, etc) to whichever folio it was
-- "charged to room" against - the F&B-to-PMS bridge the requirements
-- doc calls for. Nullable: only relevant for hotel businesses.
alter table public.orders add column if not exists charged_to_folio_id uuid references public.hotel_folios(id) on delete set null;

alter publication supabase_realtime add table public.hotel_rooms;
alter publication supabase_realtime add table public.hotel_reservations;
