-- =========================================================================
-- Forced password change on first login (owner accounts only - staff
-- already sets their own via Supabase's real invite-email flow, so
-- there's no gap for them to close), and a leads table for the new
-- marketing homepage's "Get Started" signup form.
-- =========================================================================

alter table public.profiles add column if not exists must_change_password boolean not null default false;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  phone text not null,
  business_type text not null,
  stands_estimate integer not null default 0,
  note text default '',
  converted boolean not null default false,
  converted_business_id uuid references public.businesses(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;

-- Anyone can submit a lead (the public "Get Started" form) - this is
-- deliberately the one place in the schema an anonymous person can
-- insert without any tap/token gate, since it's a marketing signup, not
-- customer/business data.
create policy "anyone can submit a lead"
  on public.leads for insert
  to anon, authenticated
  with check (true);

create policy "super_admin manages leads"
  on public.leads for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');
