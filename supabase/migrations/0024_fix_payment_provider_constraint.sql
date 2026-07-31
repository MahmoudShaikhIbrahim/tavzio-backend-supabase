-- =========================================================================
-- Fix: pos_integrations_provider_check never included telr, ngenius, or
-- ziina - only the ordering/booking POS providers plus 'tap' were ever
-- added (migration 0009). Every attempt to save Telr, N-Genius, or Ziina
-- as a business's Pay Bill provider has been failing at the database
-- level since those were introduced - the request never even reached
-- business logic, it was rejected by this constraint.
-- =========================================================================
alter table public.pos_integrations drop constraint if exists pos_integrations_provider_check;
alter table public.pos_integrations
  add constraint pos_integrations_provider_check
  check (provider in ('foodics', 'square', 'zenoti', 'loyverse', 'fresha', 'tap', 'telr', 'ngenius', 'ziina', 'custom'));
