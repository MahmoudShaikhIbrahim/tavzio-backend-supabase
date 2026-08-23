-- =========================================================================
-- Multi-business supply management for organizations - confirmed
-- design: suppliers become shareable at the org level (one real
-- supplier record, not a duplicate re-entered per business), and a
-- purchase order can be placed once at the org level and split across
-- specific member businesses. Ingredients themselves deliberately stay
-- business-scoped (see 0089's comment for why) - each business still
-- has its own stock and recipe costing, but no longer has to maintain
-- its own separate supplier contact for the same real-world vendor.
-- =========================================================================

alter table public.suppliers
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.suppliers alter column business_id drop not null;
alter table public.suppliers add constraint suppliers_owner_check check (
  (business_id is not null and organization_id is null) or
  (business_id is null and organization_id is not null)
);

create index if not exists idx_suppliers_organization on public.suppliers(organization_id) where organization_id is not null;

alter table public.purchase_orders
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.purchase_orders alter column business_id drop not null;
alter table public.purchase_orders add constraint purchase_orders_owner_check check (
  (business_id is not null and organization_id is null) or
  (business_id is null and organization_id is not null)
);

create index if not exists idx_purchase_orders_organization on public.purchase_orders(organization_id) where organization_id is not null;

-- Splits one org-level purchase_order_items row (e.g. "200kg flour from
-- Fresh Foods LLC") across whichever member businesses actually
-- ordered a share of it - each business only ever sees and receives
-- its own allocated quantity, into its own warehouse/stock, never the
-- other businesses' shares.
create table if not exists public.purchase_order_allocations (
  id uuid primary key default gen_random_uuid(),
  purchase_order_item_id uuid not null references public.purchase_order_items(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  quantity numeric not null,
  received boolean not null default false,
  received_at timestamptz,
  received_into_warehouse_id uuid references public.warehouses(id) on delete set null,
  unique (purchase_order_item_id, business_id)
);

create index if not exists idx_po_allocations_item on public.purchase_order_allocations(purchase_order_item_id);
create index if not exists idx_po_allocations_business on public.purchase_order_allocations(business_id, received);

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed',
    'reservation_created', 'reservation_checked_in', 'reservation_checked_out', 'reservation_cancelled',
    'folio_charge_added', 'folio_payment_recorded', 'folio_refund_issued', 'folio_adjustment_made',
    'folio_split', 'folio_transferred', 'night_audit_run',
    'password_reset',
    'booking_group_created',
    'linked_accounts_created', 'account_switched', 'org_menu_published',
    'folio_charge_deleted',
    'reservation_no_show', 'reservation_modified', 'reservation_room_transferred',
    'city_ledger_settled',
    'event_created', 'event_status_changed',
    'booking_created_by_staff',
    'contract_onboarded',
    'full_access_granted', 'full_access_revoked',
    'contract_terminated', 'contract_deleted', 'email_changed',
    'stock_transfer_received', 'org_purchase_order_created'
  ));

alter table public.purchase_order_allocations enable row level security;
-- A member business sees only its own allocation rows, never another
-- member's - even though they're all part of the same org-level PO.
create policy "business sees own po allocations, org_owner sees all" on public.purchase_order_allocations for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.id = purchase_order_item_id
        and po.organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner')
    )
  )
  with check (
    public.current_role_name() = 'super_admin'
    or business_id = public.current_business_id()
    or exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.id = purchase_order_item_id
        and po.organization_id = (select organization_id from public.profiles where id = auth.uid() and role = 'org_owner')
    )
  );
