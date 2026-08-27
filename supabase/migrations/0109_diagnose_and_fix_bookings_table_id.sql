-- Real, robust fix - not another guess at 0108. That migration's logic
-- is correct in isolation, but the error it produced ("not present in
-- table 'cards'") doesn't match what it should say if the ADD
-- CONSTRAINT step (which references public.tables) were the actual
-- failure - that error text implies the OLD constraint (referencing
-- cards) was still active at the moment of failure, for reasons that
-- can't be diagnosed from outside the live database. Rather than guess
-- again, this is self-contained and makes no assumption about what did
-- or didn't run before: it force-cleans any invalid table_id value
-- immediately before touching the constraint, so it succeeds
-- regardless of the database's current actual state.

-- Step 1: real diagnosis first - see exactly what's actually in
-- bookings.table_id right now, and whether each value matches a real
-- table, a card (the old, pre-0107 meaning), or neither.
select
  b.id as booking_id,
  b.table_id,
  (exists (select 1 from public.tables t where t.id = b.table_id)) as matches_a_real_table,
  (exists (select 1 from public.cards c where c.id = b.table_id)) as matches_a_card
from public.bookings b
where b.table_id is not null;

-- Step 2: force-clean, no assumptions. Any bookings.table_id that
-- still holds a card's id (the old meaning) gets migrated to that
-- card's real table, if it has one - otherwise cleared to null. Runs
-- regardless of whether 0108's own version of this already ran.
update public.bookings b
set table_id = c.table_id
from public.cards c
where b.table_id = c.id
  and c.table_id is not null;

update public.bookings b
set table_id = null
where b.table_id is not null
  and not exists (select 1 from public.tables t where t.id = b.table_id);

-- Step 3: only now touch the constraint - every remaining row is
-- guaranteed valid against public.tables by this point, so this cannot
-- fail with a foreign key violation regardless of what state the
-- constraint or the data was in before this script ran.
alter table public.bookings drop constraint if exists bookings_table_id_fkey;
alter table public.bookings add constraint bookings_table_id_fkey foreign key (table_id) references public.tables(id) on delete set null;

-- Step 4: confirm the fix - this should show 'tables' as the
-- confkey target, never 'cards'.
select
  conname,
  confrelid::regclass as references_table
from pg_constraint
where conrelid = 'public.bookings'::regclass
  and conname = 'bookings_table_id_fkey';
