-- =========================================================================
-- Forecasting & budgeting (restaurant roadmap, module 5). Sales
-- forecasting itself needs no new schema - it's computed live from
-- existing order history. This adds only what genuinely needs to persist:
-- the owner's own monthly budget targets, to compare actuals against.
-- =========================================================================

create table if not exists public.business_budgets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Always the 1st of the month - one budget row per calendar month,
  -- never a range, so "this month's budget" is always a single lookup.
  period_month date not null,
  revenue_budget_aed numeric(12,2),
  food_cost_pct_budget numeric(5,2),
  labor_cost_pct_budget numeric(5,2),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique (business_id, period_month)
);

create index if not exists idx_business_budgets_business on public.business_budgets(business_id, period_month);

alter table public.business_budgets enable row level security;
create policy "tenant manages own budgets" on public.business_budgets for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- New top-level feature flag - forecasting/budgeting spans revenue, food
-- cost, and labor cost, so it doesn't naturally belong nested under any
-- one existing module (inventory, hr). Off by default, same convention
-- as everything else.
update public.businesses
set features = jsonb_set(features, '{forecasting}', '{"enabled": false}'::jsonb)
where not (features ? 'forecasting');

alter table public.businesses
  alter column features set default '{
    "accessMethods": {"card": false, "website": true},
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false, "payBeforeOrder": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false,
    "inventory": {"enabled": false, "blockOrdersOnLowStock": true},
    "forecasting": {"enabled": false}
  }'::jsonb;
