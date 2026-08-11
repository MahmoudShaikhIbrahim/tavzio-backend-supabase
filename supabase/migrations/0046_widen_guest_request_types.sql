-- Housekeeping and maintenance requests now route into their own real
-- tables (see hotelGuestPortalController), so this table only ever holds
-- the remaining categories - widened here to match the fuller guest
-- portal: pool service, transportation, a reception message thread, and
-- guest feedback, alongside the original taxi/laundry/other.
alter table public.guest_service_requests drop constraint if exists guest_service_requests_request_type_check;
alter table public.guest_service_requests add constraint guest_service_requests_request_type_check
  check (request_type in ('towels', 'housekeeping', 'maintenance', 'taxi', 'laundry', 'pool', 'transportation', 'reception_message', 'feedback', 'other'));
