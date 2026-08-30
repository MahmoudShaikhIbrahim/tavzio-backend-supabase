-- =========================================================================
-- Index audit: cross-referenced every high-traffic table's actual query
-- patterns in the controllers against its existing indexes. Two real,
-- confirmed gaps found - not speculative additions, each one matches an
-- actual .eq()/.order() pattern already running in production code today.
-- =========================================================================

-- Gap 1: the hotel guest portal's "my requests" lookup (getGuestPortal in
-- hotelGuestPortalController.js) queries all four of these tables the
-- exact same way - .eq('room_id', room.id).order('created_at', {
-- ascending: false }).limit(20) - and none of the four had any index
-- covering room_id at all. Invisible at low volume (a full scan of a
-- small table is fast regardless), but every one of these tables is
-- shared platform-wide across every hotel on Tavzio, so this gets
-- slower for every guest's portal load as adoption grows, not just for
-- one business's own data. A composite (room_id, created_at desc) lets
-- Postgres seek directly to the matching room's rows already in the
-- right order, making the LIMIT 20 cheap instead of a sort over however
-- many rows this business has accumulated.
--
-- orders and maintenance_tickets have room_id as nullable (most rows -
-- restaurant orders, maintenance issues with no specific room - have it
-- null), so those two get a partial index that only covers the rows
-- that actually have a room_id, matching exactly how the column is ever
-- queried (never room_id is null). guest_service_requests and
-- housekeeping_tasks have room_id as not null already, so a plain
-- composite index is the right shape there.
create index if not exists idx_orders_room_time on public.orders(room_id, created_at desc) where room_id is not null;
create index if not exists idx_maintenance_room_time on public.maintenance_tickets(room_id, created_at desc) where room_id is not null;
create index if not exists idx_guest_requests_room_time on public.guest_service_requests(room_id, created_at desc);
create index if not exists idx_housekeeping_room_time on public.housekeeping_tasks(room_id, created_at desc);

-- Gap 2: isPhoneVerified (utils/phoneVerification.js) - the real check
-- behind both booking's own verification and, since today, every single
-- loyalty check-in too (previously loyalty had no OTP at all, so this
-- table's read volume from that flow alone is new) - filters by
-- (business_id, phone) and orders by verified_at desc. The existing
-- idx_booking_otp_phone index (migration 0092) covers the same two
-- filter columns but orders by created_at instead, which is right for
-- verifyBookingOtp's own separate "most recent OTP attempt for this
-- phone, verified or not" lookup, but doesn't match this query's actual
-- sort column - Postgres still has to sort after finding the rows.
-- Left the original index in place (still the right one for the other
-- query); this is an addition for the one that didn't have a match, not
-- a replacement.
create index if not exists idx_booking_otp_phone_verified on public.booking_otp_codes(business_id, phone, verified_at desc) where verified_at is not null;
