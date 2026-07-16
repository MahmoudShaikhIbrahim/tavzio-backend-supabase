-- =========================================================================
-- Tavzio loyalty programs — supports punch card, points, visit-based tiers,
-- and manually-logged spend. No POS integration required for any of these.
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. CUSTOMERS — identified by phone, shared across businesses (a person
--    visiting 3 different Tavzio businesses is still one customer row;
--    their loyalty progress per business lives in `loyalty_memberships`).
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. LOYALTY_PROGRAMS — one program per business, fully reconfigurable.
--    `config` shape depends on `type`:
--      punch_card: { "visitsRequired": 10, "reward": "Free coffee" }
--      points:     { "pointsPerVisit": 10, "redeemThreshold": 100, "reward": "AED 20 off" }
--      tiered:     { "tiers": [{"name":"Silver","visitsRequired":5,"perk":"5% off"}, ...] }
--      spend:      { "thresholdAmount": 500, "currency": "AED", "reward": "AED 50 credit" }
--                   (spend amounts are entered by staff — no POS feed)
-- ---------------------------------------------------------------------
create table if not exists public.loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  type text not null check (type in ('punch_card','points','tiered','spend')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. LOYALTY_MEMBERSHIPS — one customer's running progress at one business.
-- ---------------------------------------------------------------------
create table if not exists public.loyalty_memberships (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  visits integer not null default 0,
  points integer not null default 0,
  total_spend numeric(10,2) not null default 0,
  current_tier text default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, customer_id)
);

create index if not exists idx_loyalty_memberships_business on public.loyalty_memberships(business_id);
create index if not exists idx_loyalty_memberships_customer on public.loyalty_memberships(customer_id);

-- ---------------------------------------------------------------------
-- 4. LOYALTY_TRANSACTIONS — every earn/redeem/manual-adjust, audit trail.
--    `source_event_id` ties an earn back to a real NFC tap event. The
--    partial unique index below is what physically prevents the same tap
--    from ever being credited twice, even under a race condition.
-- ---------------------------------------------------------------------
create table if not exists public.loyalty_transactions (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  membership_id uuid not null references public.loyalty_memberships(id) on delete cascade,
  type text not null check (type in ('earn_visit','earn_points','earn_spend','redeem','manual_adjust')),
  amount numeric(10,2) not null default 0,
  note text default '',
  source_event_id bigint references public.events(id) on delete set null,
  created_by uuid references auth.users(id), -- staff/owner who made a manual adjustment; null if automatic
  created_at timestamptz not null default now()
);

create unique index if not exists idx_loyalty_tx_source_event
  on public.loyalty_transactions(source_event_id)
  where source_event_id is not null;

create index if not exists idx_loyalty_tx_membership on public.loyalty_transactions(membership_id, created_at desc);

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================
alter table public.customers enable row level security;
alter table public.loyalty_programs enable row level security;
alter table public.loyalty_memberships enable row level security;
alter table public.loyalty_transactions enable row level security;

-- ---- loyalty_programs ----
-- Public landing pages need to know if loyalty is enabled and what the
-- reward is, so customers know what they're working toward.
create policy "public can read enabled programs of active businesses"
  on public.loyalty_programs for select
  to anon
  using (
    enabled = true
    and exists (
      select 1 from public.businesses b
      where b.id = loyalty_programs.business_id and b.status = 'active'
    )
  );

create policy "tenant can manage own loyalty program"
  on public.loyalty_programs for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- ---- loyalty_memberships ----
-- No anon policy — public check-in/status lookups go through the backend's
-- service role (same pattern as the public tap/event endpoints), since
-- there's no logged-in session for an anonymous customer to scope to.
create policy "tenant can read own members"
  on public.loyalty_memberships for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- ---- loyalty_transactions ----
create policy "tenant can read own transactions"
  on public.loyalty_transactions for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- Manual adjustments/redemptions are inserted by logged-in staff/owners
-- directly (unlike automatic earns, which go through the service role).
create policy "tenant can insert manual transactions"
  on public.loyalty_transactions for insert
  to authenticated
  with check (
    (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
    and type in ('redeem','manual_adjust')
  );

-- ---- customers ----
-- A business can only see customer contact info for people who actually
-- have a membership at THAT business — not the whole customers table.
create policy "tenant can read own customers"
  on public.customers for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (
      select 1 from public.loyalty_memberships m
      where m.customer_id = customers.id and m.business_id = public.current_business_id()
    )
  );
