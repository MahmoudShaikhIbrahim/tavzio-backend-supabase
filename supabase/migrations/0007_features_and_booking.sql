-- =========================================================================
-- Full per-business feature toggle system (super_admin only) + booking
-- system (parallel to ordering) + multi-provider POS/booking integrations
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. FEATURES — restructured into the complete toggle set. Every one of
--    these is super_admin-only, one-tier control (no owner-side override)
--    - matches the "I'm the only switch" decision.
-- ---------------------------------------------------------------------
alter table public.businesses
  alter column features set default '{
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false
  }'::jsonb;

-- ---------------------------------------------------------------------
-- 2. LINKS — trimmed to the 7 buttons that are genuinely useful as plain
--    external links on their own (Call and Special Offers removed per
--    request; Menu and Book Appointment are no longer simple links - they
--    now route into Tavzio's own ordering/booking flows, governed by
--    `features` above, not a `links` entry). `enabled` on each remaining
--    link is now super_admin-only to write (enforced in controller code,
--    not schema - see businessController.js) - owner can still edit the
--    `value` (the actual URL) for whatever's been turned on.
-- ---------------------------------------------------------------------
alter table public.businesses
  alter column links set default '{
    "googleReviews": {"enabled": false, "value": ""},
    "instagram": {"enabled": false, "value": ""},
    "tiktok": {"enabled": false, "value": ""},
    "facebook": {"enabled": false, "value": ""},
    "whatsapp": {"enabled": false, "value": ""},
    "website": {"enabled": false, "value": ""},
    "directions": {"enabled": false, "value": ""}
  }'::jsonb;

-- ---------------------------------------------------------------------
-- 3. ORDERS — add request_type so Call Waiter / Request Bill can reuse
--    the same live order screen as a lightweight request with no items,
--    instead of being a separate system.
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists request_type text not null default 'order'
    check (request_type in ('order','call_waiter','request_bill'));

-- ---------------------------------------------------------------------
-- 4. BOOKING SYSTEM — mirrors the ordering system's shape: services
--    (like menu items), bookings (like orders). Deliberately simple for
--    now - a booking request with a preferred date/time that staff
--    confirm or decline, not a full staff-availability scheduling engine.
-- ---------------------------------------------------------------------
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  description text default '',
  price numeric(10,2) not null default 0,
  duration_minutes integer not null default 30,
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_services_business on public.services(business_id, is_available);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  service_name text not null default '',
  requested_at timestamptz not null,
  note text default '',
  contact_phone text default '',
  status text not null default 'pending'
    check (status in ('pending','confirmed','declined','completed','cancelled')),

  source_event_id bigint references public.events(id) on delete set null,

  pos_sync_status text not null default 'not_applicable'
    check (pos_sync_status in ('not_applicable','pending','synced','failed')),
  pos_external_id text default '',
  pos_sync_error text default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bookings_business_status on public.bookings(business_id, status, requested_at);

-- ---------------------------------------------------------------------
-- 5. POS_INTEGRATIONS — expand to support ordering AND booking
--    integrations independently (a business could conceivably want both,
--    e.g. a spa-restaurant combo), and add the 4 newly researched
--    providers. `purpose` + unique(business_id, purpose) replaces the
--    old unique(business_id) alone.
-- ---------------------------------------------------------------------
alter table public.pos_integrations drop constraint if exists pos_integrations_business_id_key;
alter table public.pos_integrations drop constraint if exists pos_integrations_provider_check;

alter table public.pos_integrations
  add column if not exists purpose text not null default 'ordering'
    check (purpose in ('ordering','booking'));

alter table public.pos_integrations
  add constraint pos_integrations_provider_check
  check (provider in ('foodics','square','zenoti','loyverse','fresha'));

alter table public.pos_integrations
  add constraint pos_integrations_business_purpose_key unique (business_id, purpose);

-- ---------------------------------------------------------------------
-- 6. RLS for the new tables - identical pattern to menu/orders.
-- ---------------------------------------------------------------------
alter table public.services enable row level security;
alter table public.bookings enable row level security;

create policy "tenant can manage own services"
  on public.services for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "public can read available services of booking-enabled businesses"
  on public.services for select
  to anon
  using (
    is_available = true
    and exists (
      select 1 from public.businesses b
      where b.id = services.business_id
        and b.status = 'active'
        and (b.features->'booking'->>'menuView')::boolean is true
    )
  );

create policy "tenant can read own bookings"
  on public.bookings for select
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant can update own bookings"
  on public.bookings for update
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- ---------------------------------------------------------------------
-- 7. REALTIME for the booking screen, same mechanism as orders/events.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.bookings;
