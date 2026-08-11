-- Fixes the "stuck on Awaiting real credentials with no way out" bug:
-- the old connect endpoint let a row be created with an empty
-- external_property_id, which the frontend then rendered as
-- "connected" with no disconnect action available. This clears out any
-- such placeholder rows so the affected businesses see "Connect" again
-- (their fresh, real connection attempt goes through the fixed endpoint,
-- which now rejects an empty property id up front).
delete from public.external_hotel_integrations
where coalesce(trim(external_property_id), '') = '';
