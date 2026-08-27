-- Real fix for a genuine ordering bug in 0108/0109, confirmed by direct
-- diagnosis: bookings_table_id_fkey was always the correct constraint
-- name, but it was never actually being dropped - both earlier scripts
-- ran their data-cleanup UPDATEs BEFORE dropping the old constraint,
-- and that old constraint (still requiring table_id to be a valid card
-- ID at that point) was violated by the UPDATE itself, rolling back the
-- entire script before it ever reached the DROP/ADD CONSTRAINT lines.
-- That's why the constraint came back unchanged every single time.
--
-- Correct order this time: drop the old constraint FIRST (so table_id
-- is briefly unconstrained), THEN clean the data, THEN add the new
-- constraint - each step now has nothing standing in its way.

alter table public.bookings drop constraint if exists bookings_table_id_fkey;

update public.bookings b
set table_id = c.table_id
from public.cards c
where b.table_id = c.id
  and c.table_id is not null;

update public.bookings b
set table_id = null
where b.table_id is not null
  and not exists (select 1 from public.tables t where t.id = b.table_id);

alter table public.bookings add constraint bookings_table_id_fkey foreign key (table_id) references public.tables(id) on delete set null;

-- Real verification - should now say 'tables', not 'cards'.
select
  con.conname as constraint_name,
  con.confrelid::regclass as references_table
from pg_constraint con
join pg_attribute att on att.attnum = any(con.conkey) and att.attrelid = con.conrelid
where con.conrelid = 'public.bookings'::regclass
  and con.contype = 'f'
  and att.attname = 'table_id';
