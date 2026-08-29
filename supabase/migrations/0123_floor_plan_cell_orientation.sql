-- Real, explicit request: door cells only ever rendered with one fixed
-- swing direction - staff had no way to make it match which side of
-- the actual doorway the door really opens from. A real field, not a
-- baked-in rendering choice, so this can genuinely be set per door
-- (and reused by any future directional element, not just doors).
alter table public.floor_plan_cells
  add column if not exists orientation text not null default 'left'
    check (orientation in ('left', 'right', 'top', 'bottom'));
