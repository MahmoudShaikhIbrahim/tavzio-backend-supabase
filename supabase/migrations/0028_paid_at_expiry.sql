-- Needed to expire the Pay Bill "Paid" section 10 minutes after payment,
-- regardless of whether auto-close ever gets its one synchronized
-- "everything paid at once" moment. A plain paid boolean has no way to
-- express "how long ago" - this does.
alter table public.order_items
  add column if not exists paid_at timestamptz;

-- Backfill: existing paid items get a timestamp already outside the
-- 10-minute window, so old stale paid data (like leftover test items)
-- disappears immediately on deploy instead of getting one more fresh
-- 10-minute window before expiring.
update public.order_items set paid_at = now() - interval '1 day' where paid = true and paid_at is null;
