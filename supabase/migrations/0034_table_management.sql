-- =========================================================================
-- Phase 3, part 2: Table management. A "table" is the same `cards` row
-- already used for NFC taps (it already has a `label` like "Table 1") -
-- this just adds the floor-status/seating layer on top, rather than
-- creating a second, disconnected concept of "table". `cards.status`
-- already means something else (active/inactive/lost/disabled - the
-- card's own lifecycle), so occupancy gets its own column entirely
-- rather than overloading that one.
-- =========================================================================

alter table public.cards add column if not exists table_status text not null default 'available'
  check (table_status in ('available', 'occupied', 'reserved', 'cleaning'));
alter table public.cards add column if not exists seat_count integer not null default 0;
-- Two tables pushed together for one larger party - orders from either
-- card should be treated as belonging to the same bill. Nullable,
-- self-referencing: only ever set on the "secondary" table, pointing at
-- the "primary" one that now represents the combined group.
alter table public.cards add column if not exists merged_with_card_id uuid references public.cards(id) on delete set null;

create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  guest_name text not null,
  party_size integer not null default 1,
  phone text default '',
  status text not null default 'waiting' check (status in ('waiting', 'seated', 'cancelled')),
  seated_card_id uuid references public.cards(id) on delete set null,
  created_at timestamptz not null default now(),
  seated_at timestamptz
);

create index if not exists idx_waitlist_business on public.waitlist_entries(business_id, status, created_at);

alter table public.waitlist_entries enable row level security;

create policy "tenant manages own waitlist" on public.waitlist_entries for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.waitlist_entries;
