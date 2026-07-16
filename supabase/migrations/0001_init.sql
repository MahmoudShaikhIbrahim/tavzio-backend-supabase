-- =========================================================================
-- Tavzio schema for Supabase (Postgres)
-- Run via Supabase SQL editor or `supabase db push`
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. BUSINESSES (the tenant)
-- ---------------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner uuid not null references auth.users(id) on delete cascade,
  category text not null default 'other'
    check (category in ('restaurant','cafe','retail','hotel','salon','clinic','gym','other')),

  logo_url text default '',
  cover_image_url text default '',
  description text default '',

  -- Every landing page button lives here as { enabled: bool, value: string }.
  -- Adding a new button later (loyalty, request bill, etc.) is just a new
  -- key in this JSON — no migration required.
  links jsonb not null default '{
    "googleReviews": {"enabled": false, "value": ""},
    "instagram": {"enabled": false, "value": ""},
    "tiktok": {"enabled": false, "value": ""},
    "facebook": {"enabled": false, "value": ""},
    "whatsapp": {"enabled": false, "value": ""},
    "call": {"enabled": false, "value": ""},
    "website": {"enabled": false, "value": ""},
    "directions": {"enabled": false, "value": ""},
    "menu": {"enabled": false, "value": ""},
    "bookAppointment": {"enabled": false, "value": ""},
    "specialOffers": {"enabled": false, "value": ""},
    "requestBill": {"enabled": false, "value": ""},
    "callWaiter": {"enabled": false, "value": ""}
  }'::jsonb,

  theme jsonb not null default '{"darkMode": false, "accentColor": "#111111"}'::jsonb,

  status text not null default 'pending' check (status in ('active','suspended','pending')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_businesses_owner on public.businesses(owner);
create index if not exists idx_businesses_slug on public.businesses(slug);

-- ---------------------------------------------------------------------
-- 2. PROFILES (extends auth.users with role + tenant membership)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'business_owner'
    check (role in ('super_admin','business_owner','staff')),
  business_id uuid references public.businesses(id) on delete set null,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_business on public.profiles(business_id);

-- Auto-create a profile row whenever a new Supabase Auth user signs up.
-- name/role are passed in via signUp's `options.data` metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'business_owner')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 3. CARDS (physical NFC inventory)
-- ---------------------------------------------------------------------
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  uid text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 10),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text default '',
  -- If set, this is an admin tap-login card for that specific person
  -- (owner or staff) rather than a customer-facing card. Tying it to a
  -- user (not just "the business") is what lets the owner and a staff
  -- member each carry their own working card at the same time.
  linked_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active','inactive','lost','disabled')),
  last_programmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cards_business on public.cards(business_id, status);
create index if not exists idx_cards_uid on public.cards(uid);

-- Only one active admin card per PERSON at a time (not per business) — so
-- the owner and a staff member can each have their own live card
-- simultaneously, but reissuing one person's lost card can't accidentally
-- leave two live cards logged into that same individual's account.
create unique index if not exists idx_cards_one_active_per_user
  on public.cards(linked_user_id)
  where linked_user_id is not null and status = 'active';

-- ---------------------------------------------------------------------
-- 4. EVENTS (every trackable interaction — taps + button clicks)
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  type text not null check (type in (
    'nfc_tap','landing_open','google_reviews_click','instagram_click',
    'tiktok_click','facebook_click','website_click','whatsapp_click',
    'call_click','menu_click','directions_click','appointment_click'
  )),
  device text not null default 'other' check (device in ('ios','android','desktop','other')),
  country text default '',
  city text default '',
  referrer text default '',
  session_id text default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_events_business_type_time on public.events(business_id, type, created_at desc);
create index if not exists idx_events_business_time on public.events(business_id, created_at desc);

-- ---------------------------------------------------------------------
-- 5. SUBSCRIPTIONS (billing placeholder, unused until Stripe is wired)
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  plan text not null default 'trial' check (plan in ('trial','starter','pro','enterprise')),
  status text not null default 'trialing' check (status in ('active','past_due','canceled','trialing')),
  stripe_customer_id text default '',
  stripe_subscription_id text default '',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================================================================
-- HELPER FUNCTIONS — used inside RLS policies to avoid repeating subqueries.
-- security definer + stable so they run once per statement, not per row,
-- and can read profiles regardless of the caller's own row-level access.
-- =========================================================================
create or replace function public.current_role_name()
returns text
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_business_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select business_id from public.profiles where id = auth.uid();
$$;

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================
alter table public.businesses enable row level security;
alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.events enable row level security;
alter table public.subscriptions enable row level security;

-- ---- businesses ----
-- Public landing pages need anonymous read access to active businesses only.
create policy "public can read active businesses"
  on public.businesses for select
  to anon
  using (status = 'active');

create policy "tenant can read own business"
  on public.businesses for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or id = public.current_business_id()
  );

create policy "owner can update own business"
  on public.businesses for update
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or (id = public.current_business_id() and public.current_role_name() = 'business_owner')
  );

-- Inserts happen via the backend's service role during signup (bypasses RLS),
-- and deletes/suspensions are super_admin-only, done through the backend too.
create policy "super_admin can delete businesses"
  on public.businesses for delete
  to authenticated
  using (public.current_role_name() = 'super_admin');

-- ---- profiles ----
create policy "user can read own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.current_role_name() = 'super_admin');

create policy "user can update own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.current_role_name() = 'super_admin');

-- ---- cards ----
create policy "tenant can manage own cards"
  on public.cards for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- ---- events ----
-- Writes come from the backend's service role only (device parsing, etc.
-- happens server-side) — no insert policy for anon/authenticated.
create policy "tenant can read own events"
  on public.events for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- ---- subscriptions ----
create policy "tenant can read own subscription"
  on public.subscriptions for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

-- =========================================================================
-- ANALYTICS RPC FUNCTIONS
-- security invoker (default) so these run with the CALLER's privileges —
-- the same RLS policies above apply automatically, meaning a business_owner
-- calling this can only ever get numbers from their own tenant's events.
-- =========================================================================
create or replace function public.get_business_summary(
  p_business_id uuid,
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'totalTaps', (
      select count(*) from public.events
      where business_id = p_business_id and type = 'nfc_tap'
        and created_at between p_from and p_to
    ),
    'tapsByDay', (
      select coalesce(jsonb_agg(row_to_json(d)), '[]'::jsonb) from (
        select to_char(created_at, 'YYYY-MM-DD') as day, count(*) as count
        from public.events
        where business_id = p_business_id and type = 'nfc_tap'
          and created_at between p_from and p_to
        group by day order by day
      ) d
    ),
    'eventsByType', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select type, count(*) as count
        from public.events
        where business_id = p_business_id
          and created_at between p_from and p_to
        group by type order by count desc
      ) t
    ),
    'devicesSplit', (
      select coalesce(jsonb_agg(row_to_json(dv)), '[]'::jsonb) from (
        select device, count(*) as count
        from public.events
        where business_id = p_business_id
          and created_at between p_from and p_to
        group by device
      ) dv
    ),
    'topHours', (
      select coalesce(jsonb_agg(row_to_json(h)), '[]'::jsonb) from (
        select extract(hour from created_at) as hour, count(*) as count
        from public.events
        where business_id = p_business_id and type = 'nfc_tap'
          and created_at between p_from and p_to
        group by hour order by count desc limit 5
      ) h
    )
  ) into result;

  return result;
end;
$$;

create or replace function public.get_card_breakdown(p_business_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb) into result
  from (
    select
      cards.id as "cardId",
      cards.label,
      cards.status,
      count(events.id) as taps
    from public.cards
    left join public.events
      on events.card_id = cards.id and events.type = 'nfc_tap'
    where cards.business_id = p_business_id
    group by cards.id, cards.label, cards.status
    order by taps desc
  ) c;

  return result;
end;
$$;
