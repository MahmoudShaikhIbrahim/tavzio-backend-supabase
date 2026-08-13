-- ============================================================
-- Multi-outlet / franchise support
-- ============================================================
-- Design note (why this shape, not a bigger RLS rewrite):
--
-- Every RLS policy in this whole system is built on
-- current_business_id() returning exactly ONE business per profile.
-- Retrofitting that to span multiple businesses per login would mean
-- touching every one of ~50 existing policies across the whole schema -
-- getting even one wrong is a real cross-tenant data leak, and there's
-- no way to test that live in this environment before it ships.
--
-- Instead: org_owner is a new role that works exactly like super_admin
-- already does - broad access authorized at the Express/route layer
-- (see hrController.js's requireHrFeature-style pattern, or staffRoutes'
-- authorize() gate), not by trying to make RLS itself understand
-- multiple businesses per session. super_admin already crosses every
-- business's RLS boundary via `current_role_name() = 'super_admin'` in
-- every policy - org_owner is the same trust model, just scoped down to
-- "only businesses in my organization" instead of "everything." This
-- reuses a pattern this codebase already trusts, rather than inventing
-- a new one.
--
-- The separate "two unrelated businesses, same owner" case (confirmed
-- explicitly NOT to share a menu or reporting) is solved differently
-- and more simply below, via linked_accounts - a login-switch
-- convenience that hands off to a genuinely separate session. Zero
-- changes to RLS, zero new attack surface, because nothing is actually
-- shared - it's the same as logging out and back in as a different
-- account, just without retyping credentials.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- A location's parent org, if any. NULL = standalone business, exactly
-- today's behavior - this is 100% additive, no existing business is
-- affected unless explicitly linked to an org.
alter table public.businesses add column if not exists organization_id uuid references public.organizations(id) on delete set null;
create index if not exists idx_businesses_organization on public.businesses(organization_id) where organization_id is not null;

-- org_owner: a new account type, scoped to an organization instead of a
-- single business. Deliberately NOT given a business_id - its access is
-- authorized entirely at the route layer (see org routes), keeping
-- every existing business_id-scoped RLS policy completely untouched.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('super_admin', 'org_owner', 'business_owner', 'staff'));
alter table public.profiles add column if not exists organization_id uuid references public.organizations(id) on delete set null;

alter table public.organizations enable row level security;
create policy "org_owner and super_admin manage own organization" on public.organizations for all to authenticated
  using (public.current_role_name() = 'super_admin' or id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'))
  with check (public.current_role_name() = 'super_admin' or id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'));

-- ============================================================
-- Organization master menu - centrally managed, published down to
-- locations. Structurally identical to menu_categories/menu_items on
-- purpose (same shape, same fields), so nothing about how POS, kitchen,
-- inventory, or ordering already read menu_items has to change at all -
-- a published item is just a normal row in that location's own
-- menu_items table, tagged with where it came from.
-- ============================================================

create table if not exists public.organization_menu_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_menu_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid references public.organization_menu_categories(id) on delete set null,
  name text not null,
  description text default '',
  price numeric(10,2) not null default 0,
  image_url text default '',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Which org item a location's own menu_items row was published from -
-- nullable, since most existing items were never touched by this
-- system at all. Re-publishing updates name/description/image on
-- linked rows automatically; a location's own price/availability
-- override (already-existing columns) is deliberately left alone -
-- confirmed behavior: "shared master, per-location price override."
alter table public.menu_items add column if not exists organization_source_id uuid references public.organization_menu_items(id) on delete set null;
alter table public.menu_items add column if not exists price_is_overridden boolean not null default false;
create index if not exists idx_menu_items_org_source on public.menu_items(organization_source_id) where organization_source_id is not null;

alter table public.organization_menu_categories enable row level security;
create policy "org_owner and super_admin manage own org menu categories" on public.organization_menu_categories for all to authenticated
  using (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'))
  with check (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'));

alter table public.organization_menu_items enable row level security;
create policy "org_owner and super_admin manage own org menu items" on public.organization_menu_items for all to authenticated
  using (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'))
  with check (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner'));

-- ============================================================
-- Linked accounts - the login-switch convenience, for BOTH cases:
-- an org_owner switching into one of their locations' own dashboards
-- (to do location-specific work an org-wide view can't do, like
-- managing that location's till or staff), and the confirmed-separate
-- case of one person owning two unrelated businesses. Symmetric link;
-- either side can switch to the other. This grants no new data access
-- by itself - it only works between accounts that already fully exist
-- and belong to the same real person, confirmed at link-creation time.
-- ============================================================

create table if not exists public.linked_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id_a uuid not null references public.profiles(id) on delete cascade,
  profile_id_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint linked_accounts_no_self_link check (profile_id_a <> profile_id_b),
  constraint linked_accounts_unique_pair unique (profile_id_a, profile_id_b)
);
create index if not exists idx_linked_accounts_a on public.linked_accounts(profile_id_a);
create index if not exists idx_linked_accounts_b on public.linked_accounts(profile_id_b);

alter table public.linked_accounts enable row level security;
-- A profile can only see/manage links involving itself, or super_admin
-- for support purposes - never someone else's link list.
create policy "profiles manage own account links" on public.linked_accounts for all to authenticated
  using (public.current_role_name() = 'super_admin' or profile_id_a = auth.uid() or profile_id_b = auth.uid())
  with check (public.current_role_name() = 'super_admin' or profile_id_a = auth.uid() or profile_id_b = auth.uid());
