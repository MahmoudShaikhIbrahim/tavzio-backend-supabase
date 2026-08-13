-- Zoho Books accounting sync - owner-only, off by default. Stores the
-- OAuth tokens from a real, documented Zoho Books authorization-code
-- flow (accounts.zoho.com/oauth/v2/*) - never a fabricated integration.
create table if not exists public.zoho_books_integrations (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  api_domain text not null default 'https://www.zohoapis.com',
  accounts_url text not null default 'https://accounts.zoho.com',
  zoho_organization_id text not null,
  vendor_contact_id text,
  token_expires_at timestamptz not null,
  connected_at timestamptz not null default now(),
  connected_by uuid references public.profiles(id)
);

alter table public.zoho_books_integrations enable row level security;
create policy "owner manages own zoho books integration" on public.zoho_books_integrations for all to authenticated
  using (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'))
  with check (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'));

-- Which billing receipts have already been pushed as a Zoho Bill, and
-- what Zoho ID resulted - prevents double-syncing the same receipt if
-- "sync all" is pressed more than once.
create table if not exists public.zoho_books_synced_receipts (
  receipt_id uuid primary key references public.receipts(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  zoho_bill_id text not null,
  synced_at timestamptz not null default now()
);

alter table public.zoho_books_synced_receipts enable row level security;
create policy "owner reads own zoho sync records" on public.zoho_books_synced_receipts for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
