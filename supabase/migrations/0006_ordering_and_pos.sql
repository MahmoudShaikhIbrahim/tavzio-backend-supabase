-- =========================================================================
-- Ordering system + POS integration architecture
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. Feature entitlements - super_admin-controlled toggles for what a
--    business is even allowed to use, separate from day-to-day config.
--    Extensible JSON so future features slot in without new columns.
-- ---------------------------------------------------------------------
alter table public.businesses
  add column if not exists features jsonb not null default '{"ordering_enabled": false}'::jsonb;

-- ---------------------------------------------------------------------
-- 2. MENU — categories and items, managed by the business owner/staff
--    day-to-day (this is their catalog, changes often - unlike feature
--    entitlements, which are set once by the platform operator).
-- ---------------------------------------------------------------------
create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_menu_categories_business on public.menu_categories(business_id);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category_id uuid references public.menu_categories(id) on delete set null,
  name text not null,
  description text default '',
  price numeric(10,2) not null default 0,
  image_url text default '',
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_menu_items_business on public.menu_items(business_id, is_available);

-- ---------------------------------------------------------------------
-- 3. ORDERS — one row per order placed from a tap, plus its line items.
--    table_label and item_name/unit_price are deliberately denormalized
--    snapshots: relabeling a card or editing a menu item later must never
--    rewrite what an already-placed order actually said at the time.
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  table_label text default '',
  status text not null default 'pending'
    check (status in ('pending','preparing','ready','completed','cancelled')),
  note text default '',
  total numeric(10,2) not null default 0,
  source text not null default 'tavzio',

  -- Which tap this order followed, for audit/debugging - unlike loyalty
  -- check-ins (one credit per tap, enforced by a unique constraint),
  -- multiple orders from the same tap are fine, so no uniqueness here.
  source_event_id bigint references public.events(id) on delete set null,

  -- Set only if this business has POS integration enabled; otherwise stays
  -- 'not_applicable' and the order only ever exists on Tavzio's own screen.
  pos_sync_status text not null default 'not_applicable'
    check (pos_sync_status in ('not_applicable','pending','synced','failed')),
  pos_external_id text default '',
  pos_sync_error text default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_business_status on public.orders(business_id, status, created_at desc);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  item_name text not null,
  unit_price numeric(10,2) not null default 0,
  quantity integer not null default 1,
  note text default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_order_items_order on public.order_items(order_id);

-- ---------------------------------------------------------------------
-- 4. POS_INTEGRATIONS — one row per business, super_admin-managed only.
--    `config` holds provider-specific credentials (API tokens, branch
--    ids) - sensitive, so RLS restricts this table to super_admin
--    entirely; owner/staff get a separate sanitized status view through
--    the backend (never direct table access), same pattern as everything
--    else that touches secrets in this system.
-- ---------------------------------------------------------------------
create table if not exists public.pos_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('foodics')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'disconnected' check (status in ('disconnected','connected','error')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.pos_integrations enable row level security;

-- Menu: tenant CRUD for owner/staff; public read (customers browsing the
-- menu from a tap) only for available items of an active, ordering-enabled
-- business - same "public can read active businesses" pattern as before.
create policy "tenant can manage own menu categories"
  on public.menu_categories for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "public can read categories of ordering-enabled businesses"
  on public.menu_categories for select
  to anon
  using (
    exists (
      select 1 from public.businesses b
      where b.id = menu_categories.business_id
        and b.status = 'active'
        and (b.features->>'ordering_enabled')::boolean is true
    )
  );

create policy "tenant can manage own menu items"
  on public.menu_items for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "public can read available items of ordering-enabled businesses"
  on public.menu_items for select
  to anon
  using (
    is_available = true
    and exists (
      select 1 from public.businesses b
      where b.id = menu_items.business_id
        and b.status = 'active'
        and (b.features->>'ordering_enabled')::boolean is true
    )
  );

-- Orders: owner/staff read their own; writes happen via the backend's
-- service role (anonymous customers placing orders, same pattern as
-- events/loyalty check-in), so no anon/authenticated insert policy here.
create policy "tenant can read own orders"
  on public.orders for select
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant can update own orders"
  on public.orders for update
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant can read own order items"
  on public.order_items for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.orders o where o.id = order_items.order_id and o.business_id = public.current_business_id())
  );

-- POS integrations: super_admin only, full stop - owner/staff never touch
-- this table directly, they get a sanitized status through the backend.
create policy "super_admin manages pos integrations"
  on public.pos_integrations for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

-- ---------------------------------------------------------------------
-- 6. REALTIME — orders need to appear on Tavzio's own order screen live,
--    same mechanism as everything else that updates without a refresh.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
