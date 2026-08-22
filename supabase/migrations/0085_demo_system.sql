-- =========================================================================
-- The marketing demo (/demo) - a sandboxed, fully independent copy of a
-- restaurant menu, deliberately NOT linked to any row in `businesses` or
-- `menu_items`. Confirmed requirement: the real Al Bait Restaurant
-- account may be deleted later, and the demo must keep working
-- afterward - so demo_menu_items is populated by copying values in
-- (name, price, image, description) once, not by referencing Al Bait's
-- actual rows. Editable afterward from Super Admin > Demo Settings,
-- independently of whatever happens to the real account it started
-- from.
--
-- demo_orders/demo_order_items are scoped by session_id (a random id
-- the visitor's browser generates and keeps in localStorage) rather
-- than any real business_id or table - this is what keeps the demo's
-- "place an order, watch it hit the kitchen display" loop completely
-- isolated per visitor, and completely separate from any real
-- restaurant's real orders.
-- =========================================================================

create table if not exists public.demo_menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  price_aed numeric(10,2) not null default 0,
  image_url text not null default '',
  category text not null default 'Main',
  sort_order integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_demo_menu_items_sort on public.demo_menu_items(category, sort_order);

alter table public.demo_menu_items enable row level security;
-- Public read - the whole point is an anonymous visitor with no
-- account can load the demo menu.
create policy "anyone can view enabled demo menu items" on public.demo_menu_items for select
  using (enabled = true);
-- Managed exclusively from Super Admin > Demo Settings.
create policy "super_admin manages demo menu items" on public.demo_menu_items for all to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

create table if not exists public.demo_orders (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'paid')),
  created_at timestamptz not null default now()
);

create index if not exists idx_demo_orders_session on public.demo_orders(session_id, created_at desc);
-- Old demo activity is meaningless noise past a day or two - nothing
-- about a demo order needs to persist, unlike every other `created_at`
-- index in this schema which supports real historical reporting.
create index if not exists idx_demo_orders_created on public.demo_orders(created_at);

alter table public.demo_orders enable row level security;
-- Public select so the Realtime subscription driving the kitchen
-- display panel actually receives INSERT/UPDATE events for anonymous
-- visitors (Realtime enforces RLS the same as a normal query) - all
-- writes go through the backend's service-role client instead, so this
-- being open for SELECT doesn't also open it for writes.
create policy "anyone can view demo orders" on public.demo_orders for select
  using (true);

create table if not exists public.demo_order_items (
  id uuid primary key default gen_random_uuid(),
  demo_order_id uuid not null references public.demo_orders(id) on delete cascade,
  demo_menu_item_id uuid references public.demo_menu_items(id) on delete set null,
  name_snapshot text not null,
  price_aed_snapshot numeric(10,2) not null,
  quantity integer not null default 1
);

create index if not exists idx_demo_order_items_order on public.demo_order_items(demo_order_id);

alter table public.demo_order_items enable row level security;
create policy "anyone can view demo order items" on public.demo_order_items for select
  using (true);
