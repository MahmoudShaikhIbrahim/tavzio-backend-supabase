-- Real fix for the explicit request: a genuine, explicit completed_at
-- timestamp - matching the same established pattern ready_at and
-- prep_started_at already use - rather than relying on updated_at,
-- which was never confirmed to be reliably refreshed on every status
-- change. This is what the 24-hour auto-cleanup job actually checks
-- against.
alter table public.orders add column if not exists completed_at timestamptz;

create index if not exists idx_orders_completed_at on public.orders(completed_at) where status = 'completed';
