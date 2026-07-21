-- =========================================================================
-- Multi-provider payments: Tap (in-page), Telr and N-Genius (redirect).
-- `provider` records which gateway processed each payment; `provider_ref`
-- is the payment's reference at that provider (Telr order ref, N-Genius
-- order reference). The existing tap_charge_id column stays untouched
-- for Tap payments and historical rows.
--
-- Redirect payments use the EXISTING 'pending' status while the customer
-- is on the provider's page (status has a check constraint - pending/
-- completed/failed only - and the instant Tap flow never actually used
-- 'pending', so it's free for exactly this). The return-confirmation
-- check flips it to 'completed'/'failed'. Rows left in 'pending' are
-- customers who abandoned the provider's page - harmless, never counted
-- as revenue anywhere (all revenue queries filter to 'completed').
-- =========================================================================

alter table public.payments
  add column if not exists provider text not null default 'tap',
  add column if not exists provider_ref text not null default '';
