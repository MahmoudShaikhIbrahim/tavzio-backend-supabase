-- =========================================================================
-- Loyalty redesign + reward claims + RLS fix for staff-placed orders
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. RLS FIX — staff-placed orders (Round 1) write via the authenticated,
--    RLS-scoped connection, but orders/order_items never had an INSERT
--    policy for authenticated users at all - only the backend's own
--    service-role access could insert (customer orders go through that
--    path). This is what caused "violates row-level security policy" the
--    moment a staff member tried to place an order directly.
-- ---------------------------------------------------------------------
create policy "tenant can insert own orders"
  on public.orders for insert
  to authenticated
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant can insert own order items"
  on public.order_items for insert
  to authenticated
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.orders o where o.id = order_items.order_id and o.business_id = public.current_business_id())
  );

-- ---------------------------------------------------------------------
-- 2. LOYALTY REDESIGN — two independent choices instead of one fixed
--    type: `earn_method` (visit or spend) and `structure` (threshold -
--    earn once, redeem once, reset - or tiered - ongoing status, applies
--    automatically forever, never resets). Every combination is now
--    valid, including spend+tiered, which never existed before.
--    `use_points` is a visit+threshold-only multiplier (visits ×
--    pointsPerVisit) - it was never really its own type, just a way of
--    measuring visit-based progress.
-- ---------------------------------------------------------------------
alter table public.loyalty_programs alter column type drop not null;
alter table public.loyalty_programs alter column type set default 'punch_card';

alter table public.loyalty_programs
  add column if not exists earn_method text not null default 'visit' check (earn_method in ('visit', 'spend')),
  add column if not exists structure text not null default 'threshold' check (structure in ('threshold', 'tiered')),
  add column if not exists use_points boolean not null default false;

-- Structured, threshold-only reward (tiered rewards live per-tier inside
-- config.tiers, since each tier needs its own reward). A real number the
-- system can act on, not free text a human has to interpret - this is
-- what makes auto-applying a reward to a bill possible at all.
alter table public.loyalty_programs
  add column if not exists reward_type text check (reward_type in ('percentage', 'fixed_amount', 'manual')),
  add column if not exists reward_value numeric(10,2) not null default 0,
  add column if not exists reward_description text not null default '';

-- Backfill existing programs from their old `type` - best-effort, since
-- the old free-text `reward` string could have meant anything; existing
-- programs land on 'manual' (staff apply it themselves) rather than
-- guessing a number out of text that was never structured to begin with.
update public.loyalty_programs set
  earn_method = case when type = 'spend' then 'spend' else 'visit' end,
  structure = case when type = 'tiered' then 'tiered' else 'threshold' end,
  use_points = (type = 'points'),
  reward_type = 'manual',
  reward_description = coalesce(config->>'reward', '')
where reward_type is null;

-- ---------------------------------------------------------------------
-- 3. REWARD CLAIMS — the actual claim-and-apply flow. Only ever used for
--    threshold rewards (tiered applies automatically at Pay Bill, no
--    claim needed - Option A, confirmed). A claim doesn't touch the
--    membership's points/visits at all until it's genuinely applied
--    (bill paid, or staff marks a manual reward applied) - nothing is
--    "spent" just by tapping Claim.
-- ---------------------------------------------------------------------
create table if not exists public.loyalty_reward_claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  membership_id uuid not null references public.loyalty_memberships(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  table_label text not null default '',
  reward_type text not null check (reward_type in ('percentage', 'fixed_amount', 'manual')),
  reward_value numeric(10,2) not null default 0,
  reward_description text not null default '',
  status text not null default 'pending' check (status in ('pending', 'applied', 'cancelled')),
  applied_to_payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists idx_loyalty_claims_business on public.loyalty_reward_claims(business_id, status);
create index if not exists idx_loyalty_claims_card on public.loyalty_reward_claims(card_id, status);

alter table public.loyalty_reward_claims enable row level security;

-- No anon insert policy - the public claim endpoint (customer tapping
-- "Claim reward") goes through the backend's service role, same
-- established pattern as every other anonymous customer-facing write.
create policy "tenant can manage own reward claims"
  on public.loyalty_reward_claims for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.loyalty_reward_claims;

-- Payments need to show a reward discount explicitly - both on the
-- receipt and in exports - not just silently subtract it from the total.
alter table public.payments
  add column if not exists discount_amount numeric(10,2) not null default 0,
  add column if not exists reward_claim_id uuid references public.loyalty_reward_claims(id) on delete set null;
