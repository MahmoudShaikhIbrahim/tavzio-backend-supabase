-- Self-service organizations: a business owner can now create an org and
-- appoint an org_owner (themselves or a team member) without super_admin,
-- and that account shows up and is manageable on their own Staff page -
-- see appointOrgOwner in organizationController.js and the extended
-- deleteStaff/listStaff in staffController.js.
--
-- This does NOT change how org-level data access is authorized - every
-- organizationRoutes.js route still checks req.user.organization_id via
-- requireOrgOwner, exactly as migration 0051 designed it. What changes
-- is purely presentational/administrative: a self-service org_owner row
-- now also carries business_id, pointing at the business that appointed
-- it - "whose Staff page can see and delete this account" - which is a
-- separate question from "what organization-level data can this account
-- touch." A super_admin-created org_owner spanning multiple businesses
-- (the real multi-tenant-franchise case migration 0051 exists for) is
-- deliberately left with business_id = null, exactly as originally
-- designed, so it stays invisible to and undeletable by any single
-- member business - only the self-service, single-business kind gets
-- this new visibility.
drop policy if exists "business owner can read own business staff" on public.profiles;

create policy "business owner can read own business staff"
  on public.profiles for select
  to authenticated
  using (
    business_id is not null
    and business_id = public.current_business_id()
    and (
      public.current_role_name() = 'business_owner'
      or public.current_role_name() = 'staff'
      or public.current_role_name() = 'org_owner'
    )
  );
