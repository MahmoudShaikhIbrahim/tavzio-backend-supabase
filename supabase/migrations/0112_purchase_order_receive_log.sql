-- Real fix for the explicit request: a genuine, timestamped log of
-- every receive event on a purchase order - "for proof". Before this,
-- only one purchase_orders.received_at existed, and it only got set
-- once the WHOLE order was fully received - a partial receive (a
-- short-shipped delivery, a second truck arriving later) left no
-- record at all of when it happened or what was actually received
-- that time versus what was still outstanding.
create table if not exists public.purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  received_by uuid references public.profiles(id) on delete set null,
  is_partial boolean not null,
  -- Real snapshot of exactly what happened in THIS specific receive
  -- event - which ingredient, how much was received just now, and how
  -- much was still outstanding afterward on that line. Kept as its own
  -- permanent record rather than something reconstructed later from
  -- purchase_order_items' current (mutable) received_quantity, since
  -- that value keeps changing across multiple partial receives.
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_po_receipts_po on public.purchase_order_receipts(purchase_order_id, created_at);

alter table public.purchase_order_receipts enable row level security;
create policy "tenant manages own po receipts" on public.purchase_order_receipts for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter publication supabase_realtime add table public.purchase_order_receipts;
