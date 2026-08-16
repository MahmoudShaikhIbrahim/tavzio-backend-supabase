-- =========================================================================
-- Advanced revenue management (hotel roadmap, module 2 - folded with
-- reservations gap-fill above as module 1). Rate plans were completely
-- flat - one number for the plan's whole valid_from/valid_to window, no
-- date-specific pricing, no response to how full the hotel actually is.
-- Both genuine gaps closed here, additively - a rate plan with no
-- overrides and no matching pricing rule behaves exactly as before.
-- =========================================================================

-- Date-specific price override on a rate plan - a holiday, an event
-- weekend, whatever needs its own number without spinning up a whole
-- separate rate plan just for one date.
create table if not exists public.hotel_rate_overrides (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  rate_plan_id uuid not null references public.hotel_rate_plans(id) on delete cascade,
  override_date date not null,
  rate_aed numeric not null,
  created_at timestamptz not null default now(),
  unique (rate_plan_id, override_date)
);
create index if not exists idx_rate_overrides_plan on public.hotel_rate_overrides(rate_plan_id, override_date);

alter table public.hotel_rate_overrides enable row level security;
create policy "tenant manages own rate overrides" on public.hotel_rate_overrides for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Occupancy-based dynamic pricing - deliberately a transparent rule, not
-- a black-box model: "at or above this occupancy %, apply this surcharge".
-- A business can define several thresholds; when several are met for a
-- given date, only the HIGHEST one applies (never stacked/compounded -
-- an owner setting 70%->10% and 90%->25% almost never means "35% on top
-- of itself at 90%+", they mean "this is how aggressive to get as it
-- fills up", so the single most-applicable tier wins).
create table if not exists public.hotel_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  occupancy_threshold_pct numeric not null check (occupancy_threshold_pct > 0 and occupancy_threshold_pct <= 100),
  surcharge_pct numeric not null check (surcharge_pct > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_pricing_rules_business on public.hotel_pricing_rules(business_id);

alter table public.hotel_pricing_rules enable row level security;
create policy "tenant manages own pricing rules" on public.hotel_pricing_rules for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
