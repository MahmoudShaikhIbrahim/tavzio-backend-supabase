-- =========================================================================
-- Confirmed requirement: pricing is coming off the homepage entirely,
-- replaced by a lightweight "Contact us" form (email, phone, preferred
-- contact method) for anyone who wants pricing info without committing
-- to the full "Get Started" intake (which asks business type and stand
-- count). Both land in the same leads table - "a separate lead section
-- inside the [existing] Leads section," not a whole new admin page -
-- distinguished by `source`, so the super_admin can tell at a glance
-- which kind of inquiry each one is.
-- =========================================================================

alter table public.leads
  add column if not exists source text not null default 'get_started'
    check (source in ('get_started', 'pricing_inquiry')),
  add column if not exists preferred_contact_method text
    check (preferred_contact_method in ('email', 'phone'));

comment on column public.leads.source is
  'get_started = the full intake form (business type, stand count). pricing_inquiry = the lightweight "Contact us for pricing" form (email + phone + preferred contact method only).';

-- business_type/stands_estimate only ever applied to the get_started
-- form - a pricing_inquiry lead has neither, so both must become
-- optional rather than staying not-null.
alter table public.leads alter column business_type drop not null;
alter table public.leads alter column stands_estimate drop not null;
alter table public.leads alter column stands_estimate set default 0;
