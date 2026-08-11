-- =========================================================================
-- Production payment processing for hotels - reuses the SAME real
-- gateway adapters already built and working for restaurant Pay Bill
-- (Tap, Telr, N-Genius, Ziina) rather than inventing a parallel payment
-- system. What's new here is the hotel-specific plumbing (folio
-- payments, POS card charges) plus a real reconciliation ledger.
-- =========================================================================

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('tap', 'telr', 'ngenius', 'ziina')),
  transaction_type text not null check (transaction_type in ('charge', 'refund')),
  amount_aed numeric not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  provider_ref text default '',
  context_type text not null check (context_type in ('restaurant_payment', 'hotel_folio_charge', 'pos_order')),
  context_id uuid not null,
  failure_reason text default '',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists idx_payment_transactions_business on public.payment_transactions(business_id, created_at desc);
create index if not exists idx_payment_transactions_context on public.payment_transactions(context_type, context_id);

alter table public.payment_transactions enable row level security;
create policy "tenant reads own payment transactions" on public.payment_transactions for select to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

alter table public.hotel_folio_charges add column if not exists payment_transaction_id uuid references public.payment_transactions(id) on delete set null;
alter table public.orders add column if not exists payment_transaction_id uuid references public.payment_transactions(id) on delete set null;

-- POS terminal now supports a real online card charge, distinct from
-- the "an external card machine handled it" trust-based option that
-- already existed - the constraint needs to allow the new value.
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check (payment_method in ('cash', 'card', 'card_online', 'other'));

-- Telr's refund/void endpoint needs the actual settled transaction
-- reference (transaction.ref from their check response), not the order
-- reference already stored in provider_ref - captured at confirmation
-- time so a later refund has what it needs.
alter table public.payments add column if not exists telr_tran_ref text default '';
