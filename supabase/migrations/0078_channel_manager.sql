-- =========================================================================
-- Phase: Channel manager (OTA rate/inventory/booking sync). Hotel-only -
-- restaurants have no equivalent concept of third-party rate distribution.
-- Builds on hotel_pricing_rules (revenue management) as the source of
-- truth for rates; this module is what pushes those rates OUT to OTAs
-- and pulls bookings back IN, the same shape as external_hotel_systems
-- already used for SiteMinder/OPERA (credentials + sync_status pattern).
-- =========================================================================

create table if not exists public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null check (channel in ('booking_com', 'expedia', 'airbnb', 'agoda', 'other')),
  -- Encrypted at the app layer with the same AES-256-GCM helper already
  -- used for hotel_payment_processing credentials - never store OTA API
  -- keys in plaintext, consistent with how every other integration in
  -- this schema handles third-party credentials.
  credentials_encrypted text,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text check (last_sync_status in ('success', 'partial', 'failed')),
  last_sync_error text default '',
  created_at timestamptz not null default now(),
  unique(business_id, channel)
);

create index if not exists idx_channel_connections_business on public.channel_connections(business_id);

alter table public.channel_connections enable row level security;
create policy "tenant manages own channel connections" on public.channel_connections for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Rate + availability, per room type per date per channel. This is
-- what actually gets pushed out on each sync - kept as its own table
-- (not computed live from hotel_pricing_rules every time) so we have
-- an exact record of what was last confirmed sent to each OTA, and can
-- detect drift if a channel's rate falls out of sync with Tavzio's.
create table if not exists public.channel_rate_sync (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel_connection_id uuid not null references public.channel_connections(id) on delete cascade,
  -- hotel_rooms.room_type is a free-text field (see 0037_pms_core.sql),
  -- not a normalized table - matched here the same way rather than
  -- inventing a room-type table this schema doesn't otherwise have.
  room_type text not null,
  stay_date date not null,
  rate_aed numeric(10,2) not null,
  available_rooms integer not null default 0,
  synced_at timestamptz,
  sync_status text not null default 'pending' check (sync_status in ('pending', 'synced', 'failed')),
  created_at timestamptz not null default now(),
  unique(channel_connection_id, room_type, stay_date)
);

create index if not exists idx_channel_rate_sync_business on public.channel_rate_sync(business_id, stay_date);
create index if not exists idx_channel_rate_sync_pending on public.channel_rate_sync(channel_connection_id) where sync_status = 'pending';

alter table public.channel_rate_sync enable row level security;
create policy "tenant manages own channel rate sync" on public.channel_rate_sync for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Bookings pulled IN from OTAs. Deliberately a separate table from the
-- core bookings table (rather than tagging bookings.source) so an
-- OTA booking can be reconciled/inspected on its own before being
-- confirmed into the real booking flow - avoids a bad OTA payload
-- (double-booking, malformed dates) corrupting the live bookings table
-- directly.
create table if not exists public.channel_bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel_connection_id uuid not null references public.channel_connections(id) on delete cascade,
  external_booking_ref text not null,
  guest_name text not null,
  guest_email text default '',
  room_type text default '',
  check_in date not null,
  check_out date not null,
  total_amount_aed numeric(10,2) not null default 0,
  status text not null default 'received' check (status in ('received', 'confirmed', 'rejected', 'cancelled')),
  -- Set once this OTA booking has been turned into a real reservation -
  -- references hotel_reservations (the actual PMS booking table; there
  -- is no separate generic "bookings" table for hotel stays).
  internal_reservation_id uuid references public.hotel_reservations(id) on delete set null,
  received_at timestamptz not null default now(),
  unique(channel_connection_id, external_booking_ref)
);

create index if not exists idx_channel_bookings_business on public.channel_bookings(business_id, check_in);
create index if not exists idx_channel_bookings_unconfirmed on public.channel_bookings(business_id) where status = 'received';

alter table public.channel_bookings enable row level security;
create policy "tenant manages own channel bookings" on public.channel_bookings for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
