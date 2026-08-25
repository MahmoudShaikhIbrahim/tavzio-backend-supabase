-- Real fix for a confirmed, reproduced bug: "infinite recursion detected
-- in policy for relation 'purchase_orders'". The actual cycle: the
-- purchase_orders SELECT policy added in 0094 ("business can read org
-- pos for its own allocations") queries purchase_order_items in a
-- subquery - but purchase_order_items' own policy (from 0030) queries
-- back into purchase_orders to check ownership. Evaluating either
-- policy required evaluating the other, forever.
--
-- Same fix this codebase already uses for exactly this class of
-- problem (see current_business_id()/current_role_name() in 0001): a
-- security definer helper function. Running with the function owner's
-- privileges means the internal queries inside it don't re-trigger RLS
-- on the tables they touch, which is what actually breaks the cycle -
-- a plain subquery, however it's written, can't avoid it as long as
-- both tables' policies reference each other.

create or replace function public.business_can_read_purchase_order(po_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.purchase_order_items poi
    join public.purchase_order_allocations poa on poa.purchase_order_item_id = poi.id
    where poi.purchase_order_id = po_id
      and poa.business_id = public.current_business_id()
  );
$$;

drop policy if exists "business can read org pos for its own allocations" on public.purchase_orders;

create policy "business can read org pos for its own allocations"
  on public.purchase_orders for select
  to authenticated
  using (public.business_can_read_purchase_order(id));
