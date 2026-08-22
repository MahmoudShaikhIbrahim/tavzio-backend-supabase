-- =========================================================================
-- Two independent additions to profiles:
--
-- 1. full_access: lets a business_owner grant a specific staff account
--    (Manager, CEO, CFO, whoever) everything the owner can do, without
--    actually making them a business_owner. Kept separate from role
--    deliberately - role='business_owner' carries other meaning
--    elsewhere (billing contact, ownership transfer, contract
--    signatory) that a delegated "acts like the owner" account should
--    not inherit. authorize() and requirePermission() in middleware/auth.js
--    both treat full_access as equivalent to business_owner for every
--    existing owner-only route across the whole app - this is a single
--    server-side capability, not a per-page checkbox that would need
--    updating everywhere it's used.
--
-- 2. nav_layout: per-person dashboard tab customization (hide/reorder).
--    Deliberately per-profile, not per-business, since an owner and each
--    staff member may each want a different layout on the same account.
--    NULL (default) = the normal, unmodified tab order every account
--    already has today - nothing changes until someone touches it.
-- =========================================================================

alter table public.profiles
  add column if not exists full_access boolean not null default false,
  add column if not exists nav_layout jsonb;

comment on column public.profiles.full_access is
  'Owner-granted, staff-only. When true, this account passes every business_owner-gated check (authorize, requirePermission) without changing its role. Never set for role=business_owner (redundant) or role=super_admin (meaningless - already unrestricted).';

comment on column public.profiles.nav_layout is
  'Per-person dashboard tab customization: { hidden: string[], order: string[] }, keyed to the same section keys as assigned_sections. NULL = default order, nothing hidden.';

-- full_access is meaningless (and a foot-gun if ever true) for anyone
-- who isn't role=staff - enforced here, not just left to application
-- code discipline, so no code path can accidentally set it on a role
-- where it would either do nothing or grant something incoherent.
alter table public.profiles
  add constraint profiles_full_access_only_staff
  check (full_access = false or role = 'staff');

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
    'full_access_granted', 'full_access_revoked'
  ));

-- Real fix: a staff account granted full_access must pass every
-- existing RLS policy written as current_role_name() = 'business_owner'
-- - there are 8+ such policies across the schema, and rewriting each
-- one individually would be error-prone and easy to miss on the next
-- one written. Reporting 'business_owner' for a full_access staff
-- account here means every one of those policies, past and future,
-- respects it automatically with this single change, mirroring how
-- authorize() in the backend's middleware/auth.js handles the same
-- equivalence at the app layer. The real underlying role (visible via
-- a direct profiles query, not this function) is still 'staff' - this
-- only affects RLS's view of "does this session have owner-level data
-- access."
create or replace function public.current_role_name()
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when role = 'staff' and full_access then 'business_owner'
    else role
  end
  from public.profiles where id = auth.uid();
$$;
