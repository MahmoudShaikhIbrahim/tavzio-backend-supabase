-- Real gap found via a live "Forbidden: insufficient role" error: the
-- ordering-purpose POS integration page was built for business owners
-- to self-serve, but the underlying route (and this RLS policy) only
-- ever allowed super_admin - a pre-existing restriction from before
-- that page existed, never updated to match. The route authorization
-- (posIntegrationRoutes.js) is fixed separately; this is the matching
-- database-level fix, since getIntegration reads through the RLS-scoped
-- client (req.supabase), not supabaseAdmin - the route fix alone isn't
-- enough, the database itself was independently blocking it too.
--
-- Mirrors "owner manages own payment integration" exactly, just for
-- purpose = 'ordering' instead of 'payment'.
create policy "owner manages own ordering integration"
  on public.pos_integrations for all
  to authenticated
  using (
    purpose = 'ordering'
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  )
  with check (
    purpose = 'ordering'
    and business_id = public.current_business_id()
    and public.current_role_name() = 'business_owner'
  );
