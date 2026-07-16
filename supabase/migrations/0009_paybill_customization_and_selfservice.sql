-- =========================================================================
-- Notification sounds, Pay Bill / split payments, custom buttons,
-- card-creation lockdown, staff self-service toggles, generic POS connector
-- =========================================================================

-- ---------------------------------------------------------------------
-- 0. CRITICAL FIX — admin cards are being removed entirely (website-only
--    login from here on). accessMethods.website previously defaulted to
--    false, meaning a brand-new business with no card AND no website
--    access would leave the owner with zero way to ever log in. Website
--    access must now default to true unconditionally, for every business,
--    including ones that already exist.
-- ---------------------------------------------------------------------
update public.businesses
set features = jsonb_set(features, '{accessMethods,website}', 'true'::jsonb)
where (features->'accessMethods'->>'website')::boolean is not true;

alter table public.businesses
  alter column features set default '{
    "accessMethods": {"card": false, "website": true},
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false
  }'::jsonb;

-- ---------------------------------------------------------------------
-- 1. NOTIFICATION SOUNDS — 4 independent events, each with its own
--    on/off, preset choice, and optional uploaded custom sound.
-- ---------------------------------------------------------------------
alter table public.businesses
  add column if not exists notification_settings jsonb not null default '{
    "callWaiter": {"enabled": true, "sound": "default", "customUrl": ""},
    "requestBill": {"enabled": true, "sound": "default", "customUrl": ""},
    "newOrder": {"enabled": true, "sound": "default", "customUrl": ""},
    "newBooking": {"enabled": true, "sound": "default", "customUrl": ""},
    "paymentConfirmed": {"enabled": true, "sound": "default", "customUrl": ""}
  }'::jsonb;

-- ---------------------------------------------------------------------
-- 2. FEATURE TOGGLES — now self-service for owner AND staff, not just
--    super_admin. RLS previously only let 'business_owner' update the
--    businesses row (besides super_admin) - extend to 'staff' too.
--    super_admin keeps full access regardless, for help/override.
-- ---------------------------------------------------------------------
drop policy if exists "owner can update own business" on public.businesses;

create policy "owner or staff can update own business"
  on public.businesses for update
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or (id = public.current_business_id() and public.current_role_name() in ('business_owner', 'staff'))
  );

-- ---------------------------------------------------------------------
-- 3. CARDS — creation locked to super_admin only (owner/staff could
--    previously create cards; per the "no accidental Add button" decision,
--    only super_admin can now insert new card rows). Rename/status
--    changes remain available to the tenant, unaffected by this.
-- ---------------------------------------------------------------------
drop policy if exists "tenant can manage own cards" on public.cards;

create policy "tenant can view and update own cards"
  on public.cards for select
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant can rename or change status of own cards"
  on public.cards for update
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "only super_admin can create cards"
  on public.cards for insert
  to authenticated
  with check (public.current_role_name() = 'super_admin');

-- No delete policy at all - matches the deliberate "disable, never delete"
-- decision; a missing policy means RLS denies delete outright for everyone
-- except whatever bypasses RLS entirely (the backend's service role, used
-- only for rare, deliberate manual cleanup, never exposed in any UI).

-- ---------------------------------------------------------------------
-- 4. PAY BILL / SPLIT PAYMENTS
-- ---------------------------------------------------------------------

-- Track which order items have actually been paid for - Pay Bill only
-- ever shows what's still outstanding, across every order for that table,
-- not just the most recent one.
alter table public.order_items
  add column if not exists paid boolean not null default false;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  order_item_ids uuid[] not null default '{}', -- which specific items this payment covered
  amount numeric(10,2) not null,
  tip_amount numeric(10,2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  tap_charge_id text default '',
  failure_reason text default '',
  source_event_id bigint references public.events(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_payments_business on public.payments(business_id, created_at desc);

alter table public.payments enable row level security;

create policy "tenant can read own payments"
  on public.payments for select
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.payments;

-- ---------------------------------------------------------------------
-- 5. POS_INTEGRATIONS — add 'payment' as a third purpose (alongside
--    ordering/booking), and expand providers to include 'tap' (Tap
--    Payments) and 'custom' (the generic no-code connector).
-- ---------------------------------------------------------------------
alter table public.pos_integrations drop constraint if exists pos_integrations_purpose_check;
alter table public.pos_integrations
  add constraint pos_integrations_purpose_check check (purpose in ('ordering', 'booking', 'payment'));

alter table public.pos_integrations drop constraint if exists pos_integrations_provider_check;
alter table public.pos_integrations
  add constraint pos_integrations_provider_check
  check (provider in ('foodics', 'square', 'zenoti', 'loyverse', 'fresha', 'tap', 'custom'));

-- Payment credentials (Tap Payments secret key) are deliberately MORE
-- restricted than ordering/booking POS credentials - owner-only, not even
-- super_admin can read the raw config once purpose='payment'. This is
-- enforced at the RLS level itself, not just in controller code, so it
-- holds even against a future controller bug or direct API misuse.
drop policy if exists "super_admin manages pos integrations" on public.pos_integrations;

create policy "super_admin manages ordering and booking integrations"
  on public.pos_integrations for all
  to authenticated
  using (public.current_role_name() = 'super_admin' and purpose in ('ordering', 'booking'))
  with check (public.current_role_name() = 'super_admin' and purpose in ('ordering', 'booking'));

create policy "owner manages own payment integration"
  on public.pos_integrations for all
  to authenticated
  using (
    purpose = 'payment'
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  )
  with check (
    purpose = 'payment'
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  );

-- Everyone (owner, staff, AND super_admin) only ever gets the sanitized
-- status view for payment integrations via supabaseAdmin in the
-- controller - never a real RLS-based SELECT on the raw config for
-- purpose='payment', by anyone but the owner via the policy above.

-- ---------------------------------------------------------------------
-- 6. CUSTOM BUTTONS — genuinely new landing-page buttons beyond the
--    fixed set of 7, with their own icon/label/link. Self-service for
--    owner, staff, AND super_admin - full parity, no restriction.
-- ---------------------------------------------------------------------
create table if not exists public.custom_buttons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  icon text not null default 'Link',
  url text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_custom_buttons_business on public.custom_buttons(business_id);

alter table public.custom_buttons enable row level security;

create policy "tenant can manage own custom buttons"
  on public.custom_buttons for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "public can read enabled custom buttons of active businesses"
  on public.custom_buttons for select
  to anon
  using (
    enabled = true
    and exists (select 1 from public.businesses b where b.id = custom_buttons.business_id and b.status = 'active')
  );

alter publication supabase_realtime add table public.custom_buttons;
