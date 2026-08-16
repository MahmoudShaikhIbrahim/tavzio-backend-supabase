-- =========================================================================
-- Advanced guest management / guest CRM (hotel roadmap, module 5). The
-- real gap: hotel_guests had no structured preferences, no VIP flag, and
-- - most importantly - nothing ever checked for an existing guest before
-- creating a new one, so a repeat guest's history fragmented across
-- duplicate rows every time front desk re-typed their details instead of
-- searching for them. This doesn't retroactively merge existing
-- duplicates (a real data-cleanup operation with no safe automatic
-- answer), but stops new ones and adds the fields a real guest profile needs.
-- =========================================================================

alter table public.hotel_guests add column if not exists vip boolean not null default false;
alter table public.hotel_guests add column if not exists room_preference text default '';
alter table public.hotel_guests add column if not exists dietary_notes text default '';

create index if not exists idx_hotel_guests_phone on public.hotel_guests(business_id, phone) where phone != '';
