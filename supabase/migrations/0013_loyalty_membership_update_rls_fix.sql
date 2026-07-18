-- =========================================================================
-- RLS FIX — loyalty_memberships only ever had a SELECT policy for
-- authenticated tenant users, never UPDATE. Adjust and Redeem both write
-- directly to this table via the authenticated connection, so every
-- single call was silently blocked at the database level - the update
-- affected zero rows, and the follow-up "return the updated row" step
-- then failed with "Cannot coerce the result to a single JSON object"
-- (that error means a query expected exactly one row and got zero).
-- =========================================================================
create policy "tenant can update own members"
  on public.loyalty_memberships for update
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
