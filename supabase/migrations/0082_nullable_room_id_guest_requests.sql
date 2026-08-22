-- =========================================================================
-- Real fix for a confirmed bug: hotel NFC stands that aren't bound to a
-- specific room (lobby stands, reception, or a room that was never
-- linked) were falling all the way through to the plain restaurant-style
-- LandingPage - a page with zero awareness of Guest Portal Services -
-- because resolveCardTap only routed to the hotel guest portal when
-- card.room_id was set (see publicController.js). housekeeping_tasks
-- and guest_service_requests required room_id NOT NULL, which is why
-- that path was never built: there was nowhere to route a roomless
-- request. This migration makes both nullable so a lobby/unassigned
-- stand can submit a genuine "front desk, no room" request instead of
-- being silently pushed onto the wrong page entirely.
-- =========================================================================

alter table public.housekeeping_tasks alter column room_id drop not null;
alter table public.guest_service_requests alter column room_id drop not null;

comment on column public.housekeeping_tasks.room_id is 'Nullable - a request submitted from a lobby/unassigned stand has no specific room and is handled as a general front-desk task.';
comment on column public.guest_service_requests.room_id is 'Nullable - a request submitted from a lobby/unassigned stand has no specific room and is handled as a general front-desk request.';
