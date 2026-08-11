-- =========================================================================
-- External hotel system connections - for hotels that want Tavzio's
-- guest-facing NFC layer without switching off their existing PMS/POS,
-- exactly the requirement: "in case some hotels don't wanna change
-- their system... integrate with their system to put my NFC stands and
-- its flow to their system." One table, five real providers, each
-- gated on real partner credentials that don't exist yet - same
-- pattern as every other not-yet-live integration in this codebase.
-- =========================================================================

create table if not exists public.external_hotel_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('siteminder', 'opera_cloud', 'simphony', 'shiji_infrasys', 'shiji_daylight')),
  role text not null check (role in ('channel_manager', 'pos', 'pms')),
  external_property_id text default '',
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, provider)
);

alter table public.external_hotel_integrations enable row level security;
create policy "tenant manages own external hotel integrations" on public.external_hotel_integrations for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter table public.hotel_reservations add column if not exists external_source_provider text;
alter table public.hotel_reservations add column if not exists external_reservation_id text;
