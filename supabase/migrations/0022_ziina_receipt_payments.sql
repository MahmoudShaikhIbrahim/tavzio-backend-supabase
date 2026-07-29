-- =========================================================================
-- Ziina automatic payment tracking on receipts. `status` (issued/void)
-- is an administrative state; `payment_status` is a separate, orthogonal
-- concern - has the owner actually paid this receipt yet. Kept as two
-- columns rather than overloading one, since a receipt can be issued-
-- and-unpaid, issued-and-paid, or void regardless of payment state.
--
-- ziina_payment_intent_id is the join key a webhook uses to find which
-- receipt an incoming Ziina event belongs to - set once, at receipt
-- creation, never changed after.
-- =========================================================================

alter table public.receipts
  add column if not exists payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  add column if not exists ziina_payment_intent_id text not null default '',
  add column if not exists payment_link_url text not null default '',
  add column if not exists paid_at timestamptz;
