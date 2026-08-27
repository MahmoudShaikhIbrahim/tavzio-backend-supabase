-- Real fix for a genuinely missed part of the recursion cycle. 0103 and
-- 0105 converted every plain cross-reference on purchase_orders and
-- purchase_order_items themselves - but this policy on a THIRD table,
-- purchase_order_allocations, was updated later in 0098 to add its own
-- plain join back into purchase_order_items + purchase_orders, and was
-- never re-checked after that update. Combined with 0094's still-plain
-- "business can read po items for its own allocations" policy (which
-- queries INTO purchase_order_allocations), this forms exactly the
-- remaining cycle: purchase_order_items -> purchase_order_allocations
-- -> purchase_order_items/purchase_orders -> potentially back again.
-- Same real fix as before: a security-definer helper, so the internal
-- query doesn't re-trigger RLS on the tables it touches.

create or replace function public.org_owner_can_see_po_allocation(alloc_purchase_order_item_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.id = alloc_purchase_order_item_id
      and po.organization_id = (select organization_id from public.profiles where id = auth.uid() and (role = 'org_owner' or is_org_owner))
  );
$$;

drop policy if exists "business sees own po allocations, org_owner sees all" on public.purchase_order_allocations;

create policy "business sees own po allocations, org_owner sees all" on public.purchase_order_allocations for all
  to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or public.org_owner_can_see_po_allocation(purchase_order_item_id)
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or public.org_owner_can_see_po_allocation(purchase_order_item_id)
  );

-- Second half of the same fix - this policy on purchase_order_items
-- queries INTO purchase_order_allocations, the other direction of the
-- exact same cycle. Converting only one side worked out to be
-- insufficient before (see 0105's own history with 0103); doing both
-- together this time removes any doubt.
create or replace function public.business_has_allocation_for_po_item(po_item_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.purchase_order_allocations poa
    where poa.purchase_order_item_id = po_item_id
      and poa.business_id = public.current_business_id()
  );
$$;

drop policy if exists "business can read po items for its own allocations" on public.purchase_order_items;

create policy "business can read po items for its own allocations"
  on public.purchase_order_items for select
  to authenticated
  using (public.business_has_allocation_for_po_item(id));
