-- Real support for the super-admin billing/expiry countdown and
-- notification system. Two dedup columns - without them, a daily check
-- that just re-evaluates "is this within N days" would re-send the same
-- notification every single day until the threshold actually passes,
-- not just once at the real moment it's crossed.
alter table public.contracts add column if not exists next_billing_notified_for date;
alter table public.contracts add column if not exists expiry_notified_for date;

comment on column public.contracts.next_billing_notified_for is
  'The billing date we last sent a "3 days before" notice for - prevents re-notifying every day until that date passes.';
comment on column public.contracts.expiry_notified_for is
  'The end_date we last sent an expiry warning for - prevents re-notifying every day once the frequency-specific threshold is crossed.';
