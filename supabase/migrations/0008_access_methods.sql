-- =========================================================================
-- Access methods (card / website / both) - per business, super_admin only
-- =========================================================================
-- Reverses the earlier "owner/staff can never use password login" rule,
-- but only where explicitly allowed per business - not universally. Tap
-- stays the default; website login becomes a second option a business can
-- be granted, same one-tier super_admin-only toggle pattern as everything
-- else in `features`.

alter table public.businesses
  alter column features set default '{
    "accessMethods": {"card": true, "website": false},
    "ordering": {"menuView": false, "submission": false, "posIntegration": false, "callWaiter": false, "requestBill": false},
    "booking": {"menuView": false, "submission": false, "integration": false},
    "loyalty": false,
    "staffAccounts": false
  }'::jsonb;

-- Backfill existing rows created before this migration with the new key,
-- defaulting to the pre-existing behavior (card-only, matches what every
-- business already had).
update public.businesses
set features = features || '{"accessMethods": {"card": true, "website": false}}'::jsonb
where not (features ? 'accessMethods');
