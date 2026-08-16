-- =========================================================================
-- Advanced housekeeping (hotel roadmap, module 3). Two real gaps: nothing
-- automatically queued a cleaning task when a room actually became dirty
-- (checkout, room transfer) - housekeeping only ever saw a task if
-- someone remembered to create one by hand - and no priority or turnover
-- timing existed at all.
-- =========================================================================

alter table public.housekeeping_tasks
  add column if not exists priority text not null default 'normal' check (priority in ('normal', 'urgent'));

-- Stamped when a task moves to in_progress - lets a turnover-time report
-- distinguish "how long it sat in the queue" from "how long the actual
-- clean took", same distinction the kitchen performance report already
-- makes between time-to-start and prep time.
alter table public.housekeeping_tasks add column if not exists started_at timestamptz;
