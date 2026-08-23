-- Real bug fix: the only SELECT policy on public.profiles was "user can
-- read own profile" (id = auth.uid()) - there was never a policy letting
-- a business_owner (or a full_access staff account acting on the
-- owner's behalf) see any OTHER profile row at all. listStaff runs
-- through req.supabase (the caller's own RLS-bound client, not
-- supabaseAdmin), so every staff member - not just newly invited ones -
-- was silently filtered down to nothing but the owner's own row. The
-- invite itself always worked (it uses supabaseAdmin, which bypasses
-- RLS); the row was just never visible afterward.
create policy "business owner can read own business staff"
  on public.profiles for select
  to authenticated
  using (
    business_id is not null
    and business_id = public.current_business_id()
    and (public.current_role_name() = 'business_owner' or public.current_role_name() = 'staff')
  );
