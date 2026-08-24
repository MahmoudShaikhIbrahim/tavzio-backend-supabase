-- Adds public.profiles to the realtime publication. Needed for the Staff
-- page's new live-update subscription (see subscribeToBusinessTable in
-- supabaseClient.ts) - without this, Realtime never emits events for this
-- table at all, no matter how correct the RLS policy or the frontend
-- subscription are (this is a separate gate from RLS, not a substitute
-- for it). RLS still fully applies on top: an owner's subscription only
-- ever receives rows their own SELECT policies (0001 + 0094) already let
-- them see - same-business staff/owner rows, nothing cross-tenant.
alter publication supabase_realtime add table public.profiles;
