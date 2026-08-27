-- Real fix for the explicit request: the demo phone showed a plain
-- placeholder circle where a business photo should be, and had no
-- notification flow at all - just ordering and a kitchen display.
-- This adds both: a single-row settings table for the demo's business
-- name/cover photo, and a real requests table (Call Waiter / Request
-- the Bill) mirroring the actual product's Requests feature.

create table if not exists public.demo_settings (
  id integer primary key default 1,
  business_name text not null default 'Al Bait Restaurant',
  cover_image_url text not null default '',
  updated_at timestamptz not null default now(),
  constraint demo_settings_singleton check (id = 1)
);
insert into public.demo_settings (id) values (1) on conflict (id) do nothing;

alter table public.demo_settings enable row level security;
create policy "anyone can view demo settings" on public.demo_settings for select to anon using (true);
create policy "super_admin manages demo settings" on public.demo_settings for all
  to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

create table if not exists public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  type text not null check (type in ('call_waiter', 'request_bill')),
  status text not null default 'pending' check (status in ('pending', 'acknowledged')),
  created_at timestamptz not null default now()
);
create index if not exists idx_demo_requests_session on public.demo_requests(session_id, created_at desc);
create index if not exists idx_demo_requests_created on public.demo_requests(created_at);

alter table public.demo_requests enable row level security;
create policy "anyone can view demo requests" on public.demo_requests for select to anon using (true);
create policy "anyone can create demo requests" on public.demo_requests for insert to anon with check (true);
create policy "anyone can update demo requests" on public.demo_requests for update to anon using (true) with check (true);

alter publication supabase_realtime add table public.demo_settings;
alter publication supabase_realtime add table public.demo_requests;
