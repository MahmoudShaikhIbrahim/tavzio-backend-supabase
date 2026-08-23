-- =========================================================================
-- Multi-warehouse stock tracking, for a single business (e.g. main
-- kitchen vs walk-in freezer vs dry store) and for an organization (a
-- central warehouse feeding multiple member businesses) - confirmed
-- requirement, both shapes at once, same mechanism.
--
-- Deliberate design choice, made after checking every existing call
-- site of ingredients.stock_qty (order deduction, manual adjustment,
-- PO receiving, low-stock alerts, waste/valuation reports - 4 write
-- paths, several reads, all in inventoryController.js): rewriting
-- ingredients to be warehouse-scoped directly would cascade into
-- recipe costing, menu_item_ingredients, and every existing inventory
-- report screen - too large and risky a change for what's actually
-- being asked for. Instead, ingredient_stock is a genuinely NEW,
-- additive layer: ingredients.stock_qty stays exactly as-is (the
-- business-wide total, unchanged, every existing feature keeps working
-- untouched), while ingredient_stock adds the granular per-location
-- breakdown a business can now optionally use. The two stay in sync by
-- application logic (see stockTransferController.js and
-- warehouseController.js), not a database trigger, matching how this
-- schema already keeps costs/stock in sync elsewhere (weighted-average
-- cost on PO receipt, purchaseOrderController.js).
-- =========================================================================

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'general' check (type in ('central', 'kitchen', 'dry_store', 'cold_store', 'general')),
  business_id uuid references public.businesses(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  address text default '',
  created_at timestamptz not null default now(),
  -- Exactly one owner - a warehouse belongs to a single business (an
  -- internal storage location) or to an organization (a shared central
  -- warehouse), never both and never neither.
  constraint warehouses_owner_check check (
    (business_id is not null and organization_id is null) or
    (business_id is null and organization_id is not null)
  )
);

create index if not exists idx_warehouses_business on public.warehouses(business_id) where business_id is not null;
create index if not exists idx_warehouses_organization on public.warehouses(organization_id) where organization_id is not null;

create table if not exists public.ingredient_stock (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  quantity numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (ingredient_id, warehouse_id)
);

create index if not exists idx_ingredient_stock_warehouse on public.ingredient_stock(warehouse_id);

-- Every business that already has at least one ingredient gets a
-- default "Main" warehouse, seeded with each ingredient's current
-- stock_qty - so a business using warehouses for the first time sees
-- its real, existing stock already accounted for in one location,
-- rather than starting from zero and looking like everything just
-- vanished.
insert into public.warehouses (name, type, business_id)
select 'Main', 'general', b.id
from public.businesses b
where exists (select 1 from public.ingredients i where i.business_id = b.id)
on conflict do nothing;

insert into public.ingredient_stock (ingredient_id, warehouse_id, quantity)
select i.id, w.id, i.stock_qty
from public.ingredients i
join public.warehouses w on w.business_id = i.business_id and w.name = 'Main'
on conflict (ingredient_id, warehouse_id) do nothing;

-- A real workflow (requested -> approved -> in_transit -> received),
-- not a silent number change - matches the audit-trail philosophy
-- stock_movements already established for single-location stock
-- changes, extended here to cover stock actually moving between two
-- locations. from_warehouse_id is nullable to also cover a brand-new
-- delivery straight into a warehouse with no prior source (e.g. a
-- supplier delivering directly to a business's dry store) - functions
-- identically to receiving, just through the same tracked workflow.
create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  from_warehouse_id uuid references public.warehouses(id) on delete set null,
  to_warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'approved', 'in_transit', 'received', 'cancelled')),
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  received_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  received_at timestamptz,
  note text default ''
);

create index if not exists idx_stock_transfers_to on public.stock_transfers(to_warehouse_id, status);
create index if not exists idx_stock_transfers_from on public.stock_transfers(from_warehouse_id, status) where from_warehouse_id is not null;

create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  stock_transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  quantity numeric not null
);

create index if not exists idx_stock_transfer_items_transfer on public.stock_transfer_items(stock_transfer_id);

-- stock_movements already logs every single-location stock change;
-- adding warehouse_id lets a movement also say WHERE it happened, now
-- that a business can have more than one location. Nullable - a
-- business that never adopts warehouses (still the default, unchanged
-- behavior) simply never sets it, exactly as before this migration.
alter table public.stock_movements add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;

-- Authorization for all of this is handled entirely at the route/
-- controller layer (see warehouseController.js and
-- stockTransferController.js), reusing the exact same requireOrgOwner
-- pattern and req.supabase business-scoping already established
-- elsewhere in this schema - not RLS policies here, matching how
-- migration 0051 deliberately kept org_owner authorization out of RLS
-- to avoid touching every existing business_id-scoped policy.
alter table public.warehouses enable row level security;
alter table public.ingredient_stock enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;

create policy "business members access own warehouses" on public.warehouses for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or organization_id = (select organization_id from public.profiles where id = auth.uid())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or organization_id = (select organization_id from public.profiles where id = auth.uid())
  );

create policy "business members access own ingredient stock" on public.ingredient_stock for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.warehouses w where w.id = warehouse_id and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid())))
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.warehouses w where w.id = warehouse_id and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid())))
  );

create policy "business members access own stock transfers" on public.stock_transfers for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.warehouses w where (w.id = to_warehouse_id or w.id = from_warehouse_id) and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid())))
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.warehouses w where (w.id = to_warehouse_id or w.id = from_warehouse_id) and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid())))
  );

create policy "business members access own transfer items" on public.stock_transfer_items for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (
      select 1 from public.stock_transfers t
      join public.warehouses w on w.id = t.to_warehouse_id or w.id = t.from_warehouse_id
      where t.id = stock_transfer_id
        and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid()))
    )
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (
      select 1 from public.stock_transfers t
      join public.warehouses w on w.id = t.to_warehouse_id or w.id = t.from_warehouse_id
      where t.id = stock_transfer_id
        and (w.business_id = public.current_business_id() or w.organization_id = (select organization_id from public.profiles where id = auth.uid()))
    )
  );
