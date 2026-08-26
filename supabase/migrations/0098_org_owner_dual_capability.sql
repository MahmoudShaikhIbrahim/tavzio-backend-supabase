-- Real fix: appointOrgOwner previously did `role: 'org_owner'` on
-- promotion - a full overwrite, not an addition. Promoting a staff
-- member this way silently stripped their `staff` role (and every
-- section/outlet restriction tied to it); promoting the business owner
-- would have stripped their `business_owner` role entirely, losing
-- every owner-only capability across the app the instant they tried to
-- also run the org. Same mistake `full_access` (migration 0083) already
-- solved correctly for staff: a boolean capability layered ON TOP of
-- the existing role, never a replacement for it.
--
-- is_org_owner works the same way, for both staff and business_owner:
-- meaningless (and a foot-gun if ever true) for anyone whose role isn't
-- one of those two - same discipline as full_access's own comment.
alter table public.profiles
  add column if not exists is_org_owner boolean not null default false;

comment on column public.profiles.is_org_owner is
  'Org-management capability layered on top of role (staff or business_owner) - not a role swap. See migration 0083''s full_access for the same pattern applied to owner-equivalent access.';

-- Existing self-service org_owner rows (role literally overwritten to
-- 'org_owner' by the old buggy appointOrgOwner) get migrated back to
-- their real underlying role with the new flag set instead - undoing
-- the damage the old code path already did, for every business this
-- shipped to before this fix. Only touches rows with a business_id
-- (self-service, home-business-scoped) - true standalone org_owner
-- accounts (business_id is null, created via the super-admin
-- inviteOrgOwner path) are untouched; they never had another role to
-- restore and keep working exactly as before.
--
-- Restored role is a reliable check, not a guess: businesses.owner is a
-- direct FK to auth.users(id) - if this profile's id is literally the
-- owner of its home business, it was business_owner; otherwise staff.
-- These accounts only ever passed through appointOrgOwner, which only
-- ever promoted an existing business_owner or staff account on their
-- own business to begin with, so this check is exhaustive for every
-- row this migration touches.
update public.profiles p
set
  is_org_owner = true,
  role = case
    when exists (select 1 from public.businesses b where b.id = p.business_id and b.owner = p.id) then 'business_owner'
    else 'staff'
  end
where p.role = 'org_owner' and p.business_id is not null;

-- Real, currently-dormant gap, fixed while it's fresh: every org-level
-- RLS policy still hardcodes `role = 'org_owner'` in its subquery -
-- organizationController.js's org-data functions all use supabaseAdmin
-- (bypasses RLS entirely), so this has never actually rejected anyone
-- yet, but it's still the real enforcement underneath per this
-- codebase's own stated philosophy (see enforceTenant's comment) - if
-- any of these ever move to req.supabase, a self-service org owner
-- would silently fail the exact same way the Express-level check just
-- got fixed above. All four rewritten to accept either the standalone
-- kind (role = 'org_owner') or the self-service kind (is_org_owner).
drop policy if exists "org_owner and super_admin manage own organization" on public.organizations;
create policy "org_owner and super_admin manage own organization" on public.organizations for all to authenticated
  using (public.current_role_name() = 'super_admin' or id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)))
  with check (public.current_role_name() = 'super_admin' or id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)));

drop policy if exists "org_owner and super_admin manage own org menu categories" on public.organization_menu_categories;
create policy "org_owner and super_admin manage own org menu categories" on public.organization_menu_categories for all to authenticated
  using (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)))
  with check (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)));

drop policy if exists "org_owner and super_admin manage own org menu items" on public.organization_menu_items;
create policy "org_owner and super_admin manage own org menu items" on public.organization_menu_items for all to authenticated
  using (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)))
  with check (public.current_role_name() = 'super_admin' or organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner)));

drop policy if exists "business sees own po allocations, org_owner sees all" on public.purchase_order_allocations;
create policy "business sees own po allocations, org_owner sees all" on public.purchase_order_allocations for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.id = purchase_order_item_id
        and po.organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner))
    )
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.id = purchase_order_item_id
        and po.organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner))
    )
  );
