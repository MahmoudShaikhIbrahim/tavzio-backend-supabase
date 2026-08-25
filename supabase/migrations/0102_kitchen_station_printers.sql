-- Real KOT (kitchen order ticket) printing - station-routed, on top of
-- the existing single-printer setup (pos_integrations purpose=
-- 'printing'), which is specifically for customer-facing receipts and
-- stays exactly as it was. A kitchen commonly has several physical
-- printers (Grill, Bar, Dessert...), all under the same PrintNode
-- account - this table only stores which printerId each station routes
-- to; the account's apiKey is read from the existing printing
-- integration row, not duplicated here.
create table if not exists public.kitchen_station_printers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Free text, matching menu_items.station exactly (same field Kitchen's
  -- own station filter already reads) - not a fixed enum, since stations
  -- are whatever each business actually calls them.
  station text not null,
  printer_id text not null,
  printer_name text not null default '',
  created_at timestamptz not null default now(),
  unique (business_id, station)
);

create index if not exists idx_kitchen_station_printers_business on public.kitchen_station_printers(business_id);

alter table public.kitchen_station_printers enable row level security;

create policy "tenant manages own kitchen station printers"
  on public.kitchen_station_printers for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
