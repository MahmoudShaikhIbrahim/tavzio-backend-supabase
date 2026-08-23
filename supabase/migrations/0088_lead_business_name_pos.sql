-- =========================================================================
-- Confirmed gap: the "Get Started" form never actually asked for the
-- business's own name at all - only its category (restaurant/cafe/...).
-- Also adding current_pos_system, since knowing what a prospect is
-- migrating FROM (or that they have nothing yet) is genuinely useful
-- context for the sales conversation - "new business, no POS yet" is a
-- meaningfully different conversation than "currently on Foodics."
-- =========================================================================

alter table public.leads
  add column if not exists business_name text not null default '',
  add column if not exists current_pos_system text default '';

comment on column public.leads.business_name is 'The prospect''s own business name, as entered on the Get Started form - was never captured before this.';
comment on column public.leads.current_pos_system is 'Free text: what POS/system they currently use, or blank/explicit "none yet" for a new business. Optional - never blocks submitting the form.';
