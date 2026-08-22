-- =========================================================================
-- Fields required to actually generate a UAE WPS SIF file (see
-- payrollController.buildWpsSifFile) - these did not exist anywhere in
-- the schema before now, and the WPS export was silently unusable
-- without them.
-- =========================================================================

alter table public.businesses
  add column if not exists mol_establishment_id text default '',
  add column if not exists wps_routing_code text default '';

comment on column public.businesses.mol_establishment_id is 'UAE Ministry of Labour establishment ID - required as the WPS SIF header employer identifier';
comment on column public.businesses.wps_routing_code is 'Employer bank routing code assigned by the paying bank for WPS - required in the WPS SIF header';

alter table public.profiles
  add column if not exists iban text default '',
  add column if not exists labour_card_no text default '';

comment on column public.profiles.iban is 'Staff member IBAN - required for WPS SIF salary transfer records';
comment on column public.profiles.labour_card_no is 'UAE labour card number - the unique WPS employee identifier';
