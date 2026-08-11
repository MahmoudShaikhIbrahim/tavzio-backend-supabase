-- Lets an owner restrict a staff account to only the dashboard sections
-- (tabs) it should see - e.g. a waiter who should only ever land on
-- Orders and Tables, not Inventory or Staff. NULL (the default, and the
-- value for every existing account) means "unrestricted" - so nothing
-- changes for any account until an owner explicitly assigns sections to
-- it. A non-null array, even an empty one, means "restricted to exactly
-- this list."
alter table public.profiles add column if not exists assigned_sections text[];

comment on column public.profiles.assigned_sections is
  'NULL = unrestricted (sees every section their role/features allow). Non-null array = staff restricted to exactly these dashboard section keys (see DashboardLayout TABS/SETTINGS_ITEMS path keys on the frontend).';
