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

-- Real bug fix: org-level purchase orders have business_id = null
-- (they use organization_id instead) - "tenant manages own purchase
-- orders"/"tenant manages own po items" only ever matched
-- business_id = current_business_id(), which an org-level PO's item
-- never satisfies. A member business could see its OWN
-- purchase_order_allocations row (that table's policy checks the
-- allocation's own business_id directly, unaffected), but the embedded
-- purchase_order_items(...) it points to came back null under RLS -
-- which is exactly what crashed "Mark received" with "Cannot read
-- properties of null (reading 'item_name')": the allocation was real,
-- the item lookup silently wasn't.
create policy "business can read po items for its own allocations"
  on public.purchase_order_items for select
  to authenticated
  using (
    exists (
      select 1 from public.purchase_order_allocations poa
      where poa.purchase_order_item_id = purchase_order_items.id
        and poa.business_id = public.current_business_id()
    )
  );

create policy "business can read org pos for its own allocations"
  on public.purchase_orders for select
  to authenticated
  using (
    exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_order_allocations poa on poa.purchase_order_item_id = poi.id
      where poi.purchase_order_id = purchase_orders.id
        and poa.business_id = public.current_business_id()
    )
  );
