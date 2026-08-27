-- Real fix for a genuine regression the table-entity redesign (0107)
-- introduced: bookings.table_id was defined as a foreign key into
-- public.cards(id) - it was really holding a CARD's id the whole time,
-- just confusingly named "table_id". Now that real tables exist and
-- the booking table picker (BookingsPage.tsx) correctly returns real
-- table ids from listTables(), assigning one to a booking would
-- violate the old foreign key (it still expects a card id) and fail
-- outright.
--
-- Real fix: migrate every existing bookings.table_id from the card it
-- currently points to, to that card's own newly-linked table (set up by
-- 0107's own data migration) - then repoint the foreign key itself at
-- public.tables instead of public.cards, matching what this column was
-- actually always trying to represent.

update public.bookings b
set table_id = c.table_id
from public.cards c
where b.table_id = c.id
  and c.table_id is not null;

-- Any booking whose card never got a linked table (e.g. an inactive
-- card, or one with an empty label that 0107 skipped) can't be safely
-- carried forward - clearing it is the honest outcome, not silently
-- keeping a reference to a place that credibly no longer exists as a
-- distinct concept in the new model.
update public.bookings b
set table_id = null
where table_id is not null
  and not exists (select 1 from public.tables t where t.id = b.table_id);

alter table public.bookings drop constraint if exists bookings_table_id_fkey;
alter table public.bookings add constraint bookings_table_id_fkey foreign key (table_id) references public.tables(id) on delete set null;
