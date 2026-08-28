-- Real fix for the explicit request: pre-ordered food during Online
-- Booking now genuinely matches the NFC menu's per-item note capability
-- ("no onions", "extra spicy") - booking_items had no column to hold
-- one at all before this.
alter table public.booking_items add column if not exists note text not null default '';
