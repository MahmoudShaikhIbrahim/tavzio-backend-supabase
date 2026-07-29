-- =========================================================================
-- Receipts - issued by the platform operator (super_admin only) to a
-- business, for a one-time charge, a monthly subscription payment, or a
-- later adjustment. Line items are jsonb: [{ description, amount }, ...]
-- so a single receipt can itemize "10 NFC cards - setup" and "Monthly
-- subscription - July 2026" separately, or just one line for simple
-- cases.
--
-- stamp_url / signature_url are captured PER RECEIPT at generation time,
-- not looked up live from settings - confirmed decision: updating the
-- stamp/signature later must never change what a past receipt shows when
-- re-downloaded. Each receipt freezes whatever was active when it was
-- made.
-- =========================================================================

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_number text not null unique,
  receipt_type text not null check (receipt_type in ('one_time', 'monthly', 'adjustment')),
  line_items jsonb not null default '[]'::jsonb,
  amount numeric not null,
  period_label text not null default '', -- e.g. "July 2026" for monthly receipts, blank otherwise
  notes text not null default '',
  stamp_url text not null default '',
  signature_url text not null default '',
  status text not null default 'issued' check (status in ('issued', 'void')),
  issued_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists receipts_business_id_idx on public.receipts(business_id);

alter table public.receipts enable row level security;

-- Same established pattern as every other table (current_role_name() /
-- current_business_id() helpers, not inline profile subqueries).
create policy "super_admin full access on receipts"
  on public.receipts for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

-- A business owner/staff can only ever READ their own business's
-- receipts - never create, edit, or void one themselves.
create policy "business can view own receipts"
  on public.receipts for select
  to authenticated
  using (business_id = public.current_business_id());

-- Settings for the currently-active stamp/signature - what NEW receipts
-- use going forward. A single row (one business-wide setting, since this
-- is the platform's own stamp/signature, not per-business).
create table if not exists public.receipt_branding (
  id uuid primary key default gen_random_uuid(),
  stamp_url text not null default '',
  signature_url text not null default '',
  legal_name text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.receipt_branding enable row level security;

create policy "super_admin full access on receipt_branding"
  on public.receipt_branding for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');
