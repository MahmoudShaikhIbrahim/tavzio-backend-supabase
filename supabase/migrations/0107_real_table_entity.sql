-- Real architecture change: tables become a genuine, independent entity,
-- exactly mirroring the already-proven hotel_rooms / cards.room_id
-- pattern already in production for hotels (see 0037_pms_core.sql). A
-- table is no longer just "whichever card happens to have this label" -
-- it has its own stable identity, survives a lost/damaged card, and can
-- be created before any physical card exists at all.
create table if not exists public.tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  seat_count integer not null default 2,
  status text not null default 'available' check (status in ('available', 'occupied', 'reserved', 'cleaning')),
  -- Table-level now, not card-level - merging is genuinely about
  -- combining TABLES for a bigger party, the card was never really the
  -- right place for this to live conceptually.
  merged_with_table_id uuid references public.tables(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, label)
);

create index if not exists idx_tables_business on public.tables(business_id);

-- The real link, mirroring cards.room_id exactly - a card OPTIONALLY
-- connects to a table; it's the access mechanism, not the table's
-- identity. Nullable and one-directional (a table doesn't need to know
-- its card - the card knows its table), same shape as room_id.
alter table public.cards add column if not exists table_id uuid references public.tables(id) on delete set null;
create index if not exists idx_cards_table on public.cards(table_id) where table_id is not null;

comment on table public.tables is 'Real, independent table entity for restaurant floor plans - mirrors hotel_rooms. A card connects to a table via cards.table_id, not the other way around.';
comment on column public.cards.table_id is 'Which table this card is currently connected to, if any - a table survives this card being lost/replaced, exactly like cards.room_id already works for hotel rooms.';

-- Real data migration: every active card currently using its own label
-- as a de facto table (the old model) gets a genuine table row created
-- for it, and the card is linked to that new table - nothing on any
-- existing floor plan is lost or renamed in this move.
insert into public.tables (business_id, label, seat_count, status, created_at)
select business_id, label, coalesce(seat_count, 2), coalesce(table_status, 'available'), created_at
from public.cards
where status = 'active'
  and label is not null and label <> ''
  and room_id is null -- hotel cards use the room model already, not this one
  and table_id is null
on conflict (business_id, label) do nothing;

update public.cards c
set table_id = t.id
from public.tables t
where c.business_id = t.business_id
  and c.label = t.label
  and c.table_id is null
  and c.status = 'active'
  and c.room_id is null;

-- Real fix for the "on delete set null" leaving RLS un-enabled -
-- tables needs the exact same tenant-isolation policy every other
-- business-scoped table in this schema already has.
alter table public.tables enable row level security;

create policy "tenant manages own tables" on public.tables for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.tables;
