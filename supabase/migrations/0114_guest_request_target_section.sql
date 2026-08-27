-- Real fix for a confirmed, silent bug: a custom notification button's
-- configured target_section (e.g. "Kitchen") was never actually
-- persisted for a general guest request - submitGuestRequest never
-- accepted it, and listRequests hardcoded target_section: null for
-- every normalized guest_service_requests row regardless of what the
-- button was configured to do. The admin's own routing choice was
-- silently discarded the entire time; the request always fell back to
-- "visible to everyone with Requests access."
alter table public.guest_service_requests add column if not exists target_section text;
