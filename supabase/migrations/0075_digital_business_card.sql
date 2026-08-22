-- =========================================================================
-- Digital Business Card
--
-- Two ownership modes, enforced at the database level (not just hidden
-- in the frontend):
--   - Normal business: exactly one card, business_id set, enforced by a
--     unique index. Editable by business_owner/super_admin only - same
--     rule as the businesses table itself (staff are read-only there
--     today, so staff stay read-only here too, rather than inventing a
--     new permission this app doesn't otherwise have).
--   - Super admin: business_id is NULL, owner_user_id is the super_admin
--     who created it. Any number of these, but only a super_admin can
--     ever read/write a row where business_id is null - a normal
--     business's RLS-scoped client can never even see these rows exist.
-- =========================================================================

create table if not exists public.digital_cards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  slug text not null unique,
  card_type text not null default 'business' check (card_type in ('business', 'person')),
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),

  name text not null default '',
  title text default '',
  company text default '',
  description text default '',
  logo_url text,
  photo_url text,

  phone text default '',
  whatsapp text default '',
  email text default '',
  website text default '',
  address text default '',
  location_url text default '',
  working_hours text default '',
  -- Which of the fields above actually render on the public card, e.g.
  -- {"phone": true, "email": false, ...} - lets a business fill in an
  -- email without necessarily wanting it public.
  contact_visibility jsonb not null default '{}'::jsonb,

  -- {"instagram": {"url": "...", "enabled": true}, "linkedin": {...}, ...}
  social_links jsonb not null default '{}'::jsonb,

  -- {"template": "classic", "primaryColor": "#...", "secondaryColor": "#...", "buttonStyle": "..."}
  design jsonb not null default '{}'::jsonb,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exactly one thing can own a card: a business, or a super_admin user -
  -- never both, never neither.
  constraint digital_cards_owner_check check (
    (business_id is not null and owner_user_id is null)
    or (business_id is null and owner_user_id is not null)
  )
);

-- The actual enforcement of "one card per business" - a bug or a
-- rewritten backend route can't accidentally create a second one, the
-- database itself refuses it.
create unique index if not exists idx_digital_cards_one_per_business
  on public.digital_cards(business_id) where business_id is not null;

create index if not exists idx_digital_cards_owner_user on public.digital_cards(owner_user_id) where owner_user_id is not null;
create index if not exists idx_digital_cards_slug on public.digital_cards(slug);

create table if not exists public.digital_card_analytics (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.digital_cards(id) on delete cascade,
  event_type text not null check (event_type in (
    'view', 'phone_click', 'whatsapp_click', 'email_click', 'website_click',
    'social_click', 'save_contact', 'share'
  )),
  created_at timestamptz not null default now()
);

create index if not exists idx_digital_card_analytics_card on public.digital_card_analytics(card_id, event_type);

alter table public.digital_cards enable row level security;
alter table public.digital_card_analytics enable row level security;

-- ---- digital_cards ----
create policy "tenant can read own business card"
  on public.digital_cards for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
  );

create policy "owner can manage own business card"
  on public.digital_cards for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner')
  )
  with check (
    public.current_role_name() = 'super_admin'
    or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner')
  );

-- ---- digital_card_analytics ----
-- Reads/writes for this table happen through backend endpoints
-- (supabaseAdmin, since the public track endpoint is unauthenticated) -
-- this policy is defense in depth for the authenticated dashboard read,
-- not the only thing standing between a tenant and someone else's data.
create policy "tenant can read own card analytics"
  on public.digital_card_analytics for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (
      select 1 from public.digital_cards c
      where c.id = digital_card_analytics.card_id
        and c.business_id = public.current_business_id()
    )
  );
