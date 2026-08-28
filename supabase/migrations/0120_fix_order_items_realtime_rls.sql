-- Real fix for a confirmed gap: staff on the Requests / POS Terminal /
-- Orders screens don't see order_items changes (e.g. a customer marking
-- "pay in cash", a kitchen-ready flag, a void) live - only a manual
-- refresh picks them up. order_items' SELECT/UPDATE/INSERT policies
-- (from 0006/0010/0011) all used a plain inline
-- `exists (select 1 from public.orders o where ...)` subquery. This
-- codebase already hit and fixed the exact same class of bug for
-- purchase_order_items in 0105 - a plain cross-table subquery inside an
-- RLS policy is unreliable for Supabase Realtime's postgres_changes
-- authorization check specifically (it evaluates policies against a
-- single changed row and does not reliably support joins/subqueries
-- into other RLS-protected tables), even though the exact same policy
-- works fine for ordinary PostgREST/REST reads. Wrapping the lookup in
-- a security-definer helper function - same fix 0105 applied - is the
-- established, working pattern in this codebase for this exact symptom.

create or replace function public.business_owns_order(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.business_id = public.current_business_id()
  );
$$;

drop policy if exists "tenant can read own order items" on public.order_items;
create policy "tenant can read own order items"
  on public.order_items for select
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or public.business_owns_order(order_id)
  );

drop policy if exists "tenant can update own order items" on public.order_items;
create policy "tenant can update own order items"
  on public.order_items for update
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or public.business_owns_order(order_id)
  )
  with check (
    public.current_role_name() = 'super_admin'
    or public.business_owns_order(order_id)
  );

drop policy if exists "tenant can insert own order items" on public.order_items;
create policy "tenant can insert own order items"
  on public.order_items for insert
  to authenticated
  with check (
    public.current_role_name() = 'super_admin'
    or public.business_owns_order(order_id)
  );

-- REPLICA IDENTITY FULL: without this, a DELETE's "old record" in the
-- Realtime payload only contains the primary key, not order_id - so
-- Realtime cannot evaluate the policy above (which needs order_id) for
-- DELETE events at all, and they get silently dropped. INSERT/UPDATE
-- were never affected (their "new record" is always complete regardless
-- of replica identity) but voided/removed order_items - a real, used
-- action on the Requests and POS screens - is exactly this DELETE case
-- if it's ever implemented as a hard delete rather than a `voided` flag
-- flip. Cheap and safe to set now rather than rediscover this gap later.
alter table public.order_items replica identity full;
alter table public.orders replica identity full;
alter table public.bookings replica identity full;
alter table public.guest_service_requests replica identity full;
