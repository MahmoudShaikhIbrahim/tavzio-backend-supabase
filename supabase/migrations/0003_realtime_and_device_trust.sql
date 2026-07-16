-- =========================================================================
-- Fast, atomic admin-card reissue + device trust + live dashboard support
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. Atomic reissue — disable-old + create-new in ONE function call, so
--    there's no window (crash between two separate requests) where a
--    person has zero active cards. security invoker so the caller's own
--    RLS still governs whether they're allowed to touch these rows.
-- ---------------------------------------------------------------------
create or replace function public.reissue_admin_card(
  p_business_id uuid,
  p_user_id uuid,
  p_label text default 'Admin card'
)
returns public.cards
language plpgsql
security invoker
as $$
declare
  new_card public.cards;
begin
  update public.cards
    set status = 'disabled'
    where business_id = p_business_id
      and linked_user_id = p_user_id
      and status = 'active';

  insert into public.cards (business_id, linked_user_id, label)
  values (p_business_id, p_user_id, p_label)
  returning * into new_card;

  return new_card;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. TRUSTED_DEVICES — a device that's already confirmed once skips the
--    email-confirmation step on every future tap and goes straight to a
--    self-signed session (the fast path).
-- ---------------------------------------------------------------------
create table if not exists public.trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_token text not null unique,
  label text default '', -- e.g. "iPhone, Safari" — filled in from the User-Agent at confirm time
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_trusted_devices_user on public.trusted_devices(user_id);

-- ---------------------------------------------------------------------
-- 3. PENDING_DEVICE_CONFIRMATIONS — created on a tap from an unrecognized
--    device; resolved when the person clicks the confirmation link emailed
--    to them (opened on that same device).
-- ---------------------------------------------------------------------
create table if not exists public.pending_device_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','confirmed','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

-- ---------------------------------------------------------------------
-- 4. RLS for the two new tables — a user manages only their own devices;
--    everything else here (creating pending confirmations, confirming
--    them) happens through the backend's service role, same pattern as
--    the other public/anonymous-facing flows.
-- ---------------------------------------------------------------------
alter table public.trusted_devices enable row level security;
alter table public.pending_device_confirmations enable row level security;

create policy "user can read own trusted devices"
  on public.trusted_devices for select
  to authenticated
  using (user_id = auth.uid());

create policy "user can remove own trusted devices"
  on public.trusted_devices for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 5. Admin-card logins get logged as events too, so "who's using the
--    dashboard and when" shows up in the same timeline as customer taps.
-- ---------------------------------------------------------------------
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check check (type in (
  'nfc_tap','landing_open','google_reviews_click','instagram_click',
  'tiktok_click','facebook_click','website_click','whatsapp_click',
  'call_click','menu_click','directions_click','appointment_click',
  'admin_login'
));

-- ---------------------------------------------------------------------
-- 6. REALTIME — add the tables a live dashboard needs to watch to the
--    Realtime publication. The frontend subscribes directly via
--    supabase-js (`.channel(...).on('postgres_changes', ...)`), using
--    the logged-in user's own session — Realtime enforces the same RLS
--    policies defined above, so a business only ever receives its own
--    rows over the socket, exactly like any other query.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.loyalty_memberships;
alter publication supabase_realtime add table public.loyalty_transactions;
alter publication supabase_realtime add table public.cards;
