-- =========================================================================
-- Round 1: table/order management, staff ordering, card delete, audit
-- log, refunds, paid add-ons, support messages
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. VOIDING — a deliberate choice over a blunt "session cutoff": voiding
--    marks SPECIFIC orders/items, giving a precise, auditable record of
--    exactly what was cleared, rather than silently hiding everything
--    before an arbitrary timestamp. "Clear table" (staff-facing) is just
--    "void everything currently unpaid for this card" using this same
--    mechanism - not a separate concept.
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists voided boolean not null default false,
  add column if not exists voided_by uuid references public.profiles(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text default '';

alter table public.order_items
  add column if not exists voided boolean not null default false;

-- order_items previously only had a SELECT policy - voiding a specific
-- item needs UPDATE too, which never existed until now.
create policy "tenant can update own order items"
  on public.order_items for update
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.orders o where o.id = order_items.order_id and o.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.orders o where o.id = order_items.order_id and o.business_id = public.current_business_id())
  );

-- ---------------------------------------------------------------------
-- 2. STAFF-PLACED ORDERS — reuses the exact same order flow; this column
--    is the only thing distinguishing "a staff member typed this in for
--    someone" from "the customer submitted it themselves."
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists placed_by_staff_id uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------
-- 3. PAID ADD-ONS — a business's own optional extras per menu item
--    ("Extra cheese +5 AED"). `order_items` stores which ones were
--    selected and their price AT ORDER TIME (same denormalization
--    reasoning as item_name/unit_price - editing an add-on's price later
--    must never rewrite an already-placed order).
-- ---------------------------------------------------------------------
create table if not exists public.menu_item_addons (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_menu_item_addons_item on public.menu_item_addons(menu_item_id);

alter table public.menu_item_addons enable row level security;

-- Same pattern as menu_items itself: tenant manages their own, public can
-- read add-ons belonging to available items of ordering-enabled businesses.
create policy "tenant can manage own menu item addons"
  on public.menu_item_addons for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.menu_items mi where mi.id = menu_item_addons.menu_item_id and mi.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.menu_items mi where mi.id = menu_item_addons.menu_item_id and mi.business_id = public.current_business_id())
  );

create policy "public can read addons of available items"
  on public.menu_item_addons for select
  to anon
  using (
    exists (
      select 1 from public.menu_items mi
      join public.businesses b on b.id = mi.business_id
      where mi.id = menu_item_addons.menu_item_id
        and mi.is_available = true
        and b.status = 'active'
        and (b.features->'ordering'->>'menuView')::boolean is true
    )
  );

alter table public.order_items
  add column if not exists addons jsonb not null default '[]'::jsonb, -- [{name, price}]
  add column if not exists addon_total numeric(10,2) not null default 0;

-- ---------------------------------------------------------------------
-- 4. REFUNDS — staff or owner (both, per explicit decision), real money
--    moving back through the business's own Tap Payments account, same
--    as the original charge.
-- ---------------------------------------------------------------------
alter table public.payments
  add column if not exists refunded boolean not null default false,
  add column if not exists refund_amount numeric(10,2) not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references public.profiles(id) on delete set null,
  add column if not exists tap_refund_id text default '';

-- Owner/staff can update their own business's payments (for the refund
-- fields specifically - enforced in the controller, not by column-level
-- RLS, since Postgres RLS doesn't restrict which columns an UPDATE touches).
create policy "tenant can update own payments for refunds"
  on public.payments for update
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- ---------------------------------------------------------------------
-- 5. CARD DELETE — restored, but ONLY for super_admin, exactly as
--    decided. Owner/staff still have no delete capability at all -
--    "Disable" remains their only retirement path, unchanged.
-- ---------------------------------------------------------------------
create policy "only super_admin can delete cards"
  on public.cards for delete
  to authenticated
  using (public.current_role_name() = 'super_admin');

-- ---------------------------------------------------------------------
-- 6. AUDIT LOG — deliberately scoped to exactly 4 action types, per
--    explicit decision: void, refund, staff-placed orders, card deletes.
--    Not a general-purpose activity feed - loyalty adjustments and
--    feature-toggle changes are explicitly NOT logged here.
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text default '',
  actor_role text default '',
  action text not null check (action in ('void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted')),
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_business on public.audit_log(business_id, created_at desc);

alter table public.audit_log enable row level security;

create policy "tenant can read own audit log"
  on public.audit_log for select
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
-- No insert/update/delete policy for any authenticated role - this table
-- is only ever written by the backend's service role, from the exact
-- moment each of the 4 actions happens, never editable after the fact.

-- ---------------------------------------------------------------------
-- 7. SUPPORT MESSAGES — a real two-way channel, replacing "there's no
--    way for a business to actually reach the platform operator."
-- ---------------------------------------------------------------------
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sender_role text not null check (sender_role in ('business', 'super_admin')),
  sender_id uuid references public.profiles(id) on delete set null,
  message text not null,
  read_by_business boolean not null default false,
  read_by_super_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_support_messages_business on public.support_messages(business_id, created_at);

alter table public.support_messages enable row level security;

create policy "tenant can manage own support messages"
  on public.support_messages for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.support_messages;
alter publication supabase_realtime add table public.audit_log;
