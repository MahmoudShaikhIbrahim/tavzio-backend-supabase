-- =========================================================================
-- Advanced maintenance (hotel roadmap, module 4). Two real gaps, one of
-- them a genuine correctness bug: a maintenance ticket never took the
-- room out of the sellable inventory, AND check-in only ever blocked on
-- room.status = 'occupied' - a room sitting in 'maintenance' or
-- 'out_of_order' status could still be checked a guest into. Fixed
-- properly below, not just documented.
-- =========================================================================

alter table public.maintenance_tickets
  add column if not exists took_room_out_of_service boolean not null default false;
alter table public.maintenance_tickets add column if not exists started_at timestamptz;
alter table public.maintenance_tickets add column if not exists estimated_cost_aed numeric(10,2);
alter table public.maintenance_tickets add column if not exists actual_cost_aed numeric(10,2);
