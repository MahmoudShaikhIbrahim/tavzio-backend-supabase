-- Hotel F&B outlets/services (Restaurant, Room Service, Bars, Pool,
-- Breakfast, etc). This is deliberately a thin layer ON TOP of the
-- existing menu_categories/menu_items engine, not a parallel menu
-- system - the same item can be offered through several outlets (a Club
-- Sandwich on both Room Service and the Pool Bar), each with its own
-- optional price override and availability. Restaurants/cafes never
-- touch this table at all; it's only ever queried where
-- business.category = 'hotel'.
create table if not exists public.hotel_outlets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  outlet_type text not null check (outlet_type in ('restaurant', 'room_service', 'bar', 'pool', 'breakfast', 'other')),
  enabled boolean not null default true,
  location text default '',
  opening_hours text default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_hotel_outlets_business on public.hotel_outlets(business_id, enabled);

-- Which menu items are offered through which outlet, and any per-outlet
-- override. Absence of a price_override_aed means "use the item's own
-- price" - most items in most outlets need no override at all.
create table if not exists public.hotel_outlet_items (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.hotel_outlets(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  price_override_aed numeric(10,2),
  available boolean not null default true,
  unique (outlet_id, menu_item_id)
);

create index if not exists idx_hotel_outlet_items_outlet on public.hotel_outlet_items(outlet_id);

-- Which outlet a placed order came through, for kitchen/station routing
-- and for the guest-facing order tracker to know which department to
-- show. Null for every non-hotel order and for hotel orders placed
-- directly from the POS without picking an outlet (e.g. front-desk
-- entering a walk-in restaurant charge).
alter table public.orders add column if not exists hotel_outlet_id uuid references public.hotel_outlets(id) on delete set null;

alter table public.hotel_outlets enable row level security;
create policy "tenant manages own hotel outlets" on public.hotel_outlets for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter table public.hotel_outlet_items enable row level security;
create policy "tenant manages own hotel outlet items" on public.hotel_outlet_items for all to authenticated
  using (public.current_role_name() = 'super_admin' or exists (
    select 1 from public.hotel_outlets o where o.id = outlet_id and o.business_id = public.current_business_id()
  ))
  with check (public.current_role_name() = 'super_admin' or exists (
    select 1 from public.hotel_outlets o where o.id = outlet_id and o.business_id = public.current_business_id()
  ));
