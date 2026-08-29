-- Real, explicit request: a real spatial floor plan, not a card grid -
-- "where is table 28" answered by looking at a map matching the actual
-- room, not by reading labels. This is the schema for that.

-- Grid position (null = not yet placed - the business hasn't arranged
-- their floor plan yet, falls back to the existing card-grid view),
-- shape (matches real furniture, not derived purely from seat count -
-- a business might genuinely have a long 4-seat table, not round), and
-- an optional landmark zone label ("By the Window") - anchoring the map
-- to real physical reference points instead of one person's screen
-- orientation, which is what actually solves "staff move around, whose
-- point of view is this."
alter table public.tables
  add column if not exists grid_x integer,
  add column if not exists grid_y integer,
  add column if not exists shape text not null default 'round' check (shape in ('round', 'long')),
  add column if not exists zone text not null default '';

-- Real architectural elements - walls, windows, a door, a bar counter -
-- placed on the exact same grid tables are, with the exact same
-- tap-to-place interaction (never freeform dragging, matching the
-- earlier decision this whole feature already rests on). This is what
-- makes the map look like the actual room instead of shapes floating in
-- empty space - a wall segment isn't just a color note, it's a real
-- placed element staff build the floor's outline from, the same way
-- they place tables.
create table if not exists public.floor_plan_cells (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  grid_x integer not null,
  grid_y integer not null,
  cell_type text not null check (cell_type in ('wall', 'window', 'door', 'counter', 'plant')),
  created_at timestamptz not null default now(),
  unique (business_id, grid_x, grid_y)
);

create index if not exists idx_floor_plan_cells_business on public.floor_plan_cells(business_id);

alter table public.floor_plan_cells enable row level security;

create policy "tenant manages own floor plan cells" on public.floor_plan_cells for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.floor_plan_cells;
