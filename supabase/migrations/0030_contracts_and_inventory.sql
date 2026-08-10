-- =========================================================================
-- Contracts + e-signature + contract-linked receipts, TRN, and Tier 2
-- ingredient-level inventory (recipes, stock deduction, suppliers, POs).
-- Every new capability here is gated behind its own features.* flag so
-- nothing changes for an existing business until the owner turns it on.
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. CONTRACTS - one per business, 1-year term, payment frequency chosen
--    independently of the term. E-signature captured per Federal
--    Decree-Law No. 46/2021 (UAE Electronic Transactions Law) - a
--    "simple" e-signature is legally valid for standard commercial
--    contracts, provided it's genuinely linked to the signatory and the
--    exact agreed text is preserved. That's what signed_snapshot_text is
--    for: the immutable copy of what was actually agreed to, so the
--    contract terms can never silently drift out from under a signature
--    taken against an earlier version.
-- ---------------------------------------------------------------------
create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contract_number text not null unique,
  start_date date not null,
  end_date date not null,
  payment_frequency text not null check (payment_frequency in ('monthly', 'quarterly', 'yearly')),
  stands_count integer not null default 0,
  system_fee_aed numeric not null default 200,
  card_price_aed numeric not null default 20,
  annual_total_aed numeric not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'active', 'terminated', 'expired')),
  signed_snapshot_text text,
  signed_by_name text,
  signed_at timestamptz,
  signed_ip text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_contracts_business on public.contracts(business_id);

alter table public.contracts enable row level security;

create policy "super_admin manages contracts"
  on public.contracts for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

create policy "business owner reads own contract"
  on public.contracts for select
  to authenticated
  using (business_id = public.current_business_id());

-- ---------------------------------------------------------------------
-- 2. Link receipts to a contract, with installment tracking. Existing
--    one_time/adjustment receipts keep contract_id null - unchanged
--    behavior, since those are explicitly outside any contract.
-- ---------------------------------------------------------------------
alter table public.receipts add column if not exists contract_id uuid references public.contracts(id) on delete set null;
alter table public.receipts add column if not exists installment_number integer;
alter table public.receipts add column if not exists installment_total integer;

-- ---------------------------------------------------------------------
-- 3. TRN - two different things. issuer_trn is Tavzio's own TRN, which
--    must appear on any invoice Tavzio issues to be a valid tax invoice
--    at all. businesses.trn is the CLIENT's TRN, optional, shown when
--    set so the client can reclaim input VAT on what they paid Tavzio.
-- ---------------------------------------------------------------------
alter table public.businesses add column if not exists trn text;
alter table public.receipt_branding add column if not exists issuer_trn text default '';

-- ---------------------------------------------------------------------
-- 4. INVENTORY (Tier 2) - ingredient-level stock, recipes, suppliers,
--    purchase orders. Gated by features.inventory.enabled, self-service
--    like the other ordering toggles, but off by default.
-- ---------------------------------------------------------------------
update public.businesses
set features = jsonb_set(features, '{inventory}', '{"enabled": false, "blockOrdersOnLowStock": true}'::jsonb)
where not (features ? 'inventory');

alter table public.businesses
  alter column features set default '{
    "accessMethods": {"card": false, "website": true},
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false, "payBeforeOrder": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false,
    "inventory": {"enabled": false, "blockOrdersOnLowStock": true}
  }'::jsonb;

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  contact_name text default '',
  phone text default '',
  email text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'piece')),
  stock_qty numeric not null default 0,
  low_stock_threshold numeric not null default 0,
  cost_per_unit numeric not null default 0, -- weighted-average cost, updated on each purchase order receipt
  supplier_id uuid references public.suppliers(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingredients_business on public.ingredients(business_id);

-- The recipe (bill of materials) for a menu item - how much of each
-- ingredient one unit of that menu item consumes.
create table if not exists public.menu_item_ingredients (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  quantity numeric not null,
  unique (menu_item_id, ingredient_id)
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'received', 'cancelled')),
  total_cost_aed numeric not null default 0,
  ordered_at timestamptz not null default now(),
  received_at timestamptz,
  created_by uuid references public.profiles(id)
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  quantity numeric not null,
  unit_cost_aed numeric not null
);

-- A running log of every stock change - purchases, order deductions,
-- and manual adjustments (waste, recount) - so stock levels are always
-- explainable after the fact, not just a single mutable number.
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  change_qty numeric not null, -- positive = added, negative = consumed/wasted
  reason text not null check (reason in ('order', 'purchase', 'manual_adjustment', 'waste')),
  order_id uuid references public.orders(id) on delete set null,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  note text default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_movements_ingredient on public.stock_movements(ingredient_id, created_at desc);

alter table public.suppliers enable row level security;
alter table public.ingredients enable row level security;
alter table public.menu_item_ingredients enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.stock_movements enable row level security;

create policy "tenant manages own suppliers" on public.suppliers for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own ingredients" on public.ingredients for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own recipes" on public.menu_item_ingredients for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.menu_items mi where mi.id = menu_item_id and mi.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.menu_items mi where mi.id = menu_item_id and mi.business_id = public.current_business_id())
  );

create policy "tenant manages own purchase orders" on public.purchase_orders for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own po items" on public.purchase_order_items for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.purchase_orders po where po.id = purchase_order_id and po.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.purchase_orders po where po.id = purchase_order_id and po.business_id = public.current_business_id())
  );

create policy "tenant reads own stock movements" on public.stock_movements for select to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.ingredients;

-- ---------------------------------------------------------------------
-- 5. Audit log needs its own action for contract signing - reusing an
--    unrelated existing category would misrepresent what happened in
--    the audit trail.
-- ---------------------------------------------------------------------
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed'
  ));
