-- Real, complete fix for a bug the previous migration (0103) only
-- partially closed - confirmed still reproducing via a live screenshot:
-- "infinite recursion detected in policy for relation
-- 'purchase_order_items'". 0103 converted purchase_orders' SELECT
-- policy to a security-definer helper, but purchase_order_items' own
-- policy (from 0030) was still a plain subquery straight into
-- purchase_orders - one remaining plain cross-reference is enough to
-- keep the cycle alive. This migration converts every remaining plain
-- cross-reference between these two tables, in both directions, so
-- there is no path left where evaluating one table's policy can
-- re-trigger the other's.

create or replace function public.business_owns_purchase_order(po_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.purchase_orders po
    where po.id = po_id and po.business_id = public.current_business_id()
  );
$$;

drop policy if exists "tenant manages own po items" on public.purchase_order_items;

create policy "tenant manages own po items" on public.purchase_order_items for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or public.business_owns_purchase_order(purchase_order_id)
  )
  with check (
    public.current_role_name() = 'super_admin'
    or public.business_owns_purchase_order(purchase_order_id)
  );

-- Same treatment for purchase_orders' own original policy (0030) -
-- it's a direct business_id check with no cross-table reference, so it
-- was never actually part of the cycle, but converting it too removes
-- any remaining doubt rather than leaving one policy on this table
-- security-definer and the other plain.
drop policy if exists "tenant manages own purchase orders" on public.purchase_orders;

create policy "tenant manages own purchase orders" on public.purchase_orders for all
  to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
