-- =========================================================================
-- Delivery platform integration via Deliverect - Deliverect aggregates
-- Talabat, Deliveroo, Careem, and others behind one webhook-based API,
-- so this is a single integration rather than three separate ones.
-- Orders arrive as a webhook push (Deliverect calls Tavzio, not the
-- other way around), same pattern as every other webhook in this
-- codebase (Ziina, Stripe).
-- =========================================================================

alter table public.orders add column if not exists delivery_platform text; -- e.g. 'talabat', 'deliveroo', 'careem' - which channel this came from, as reported by Deliverect
alter table public.orders add column if not exists delivery_channel_order_id text; -- Deliverect's own order ID, needed to push status updates back

create index if not exists idx_orders_delivery_channel on public.orders(delivery_channel_order_id) where delivery_channel_order_id is not null;

-- One row per connected Deliverect location - the mapping between "this
-- Tavzio business" and "this Deliverect location", plus the per-partner
-- HMAC secret Deliverect issues once your integration goes live.
create table if not exists public.delivery_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade unique,
  provider text not null default 'deliverect' check (provider in ('deliverect')),
  deliverect_account_id text default '',
  deliverect_location_id text default '',
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.delivery_integrations enable row level security;

create policy "tenant manages own delivery integration" on public.delivery_integrations for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- orders.source already exists ('customer_tap' | 'staff_pos') - add the
-- third real source rather than overloading either existing value.
alter table public.orders drop constraint if exists orders_source_check;
alter table public.orders add constraint orders_source_check check (source in ('customer_tap', 'staff_pos', 'delivery'));
