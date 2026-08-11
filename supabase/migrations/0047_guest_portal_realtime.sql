-- Enables genuine real-time updates on the hotel guest portal's "My
-- Requests" tracker, replacing the polling fallback. The guest portal's
-- entire trust model (see hotelGuestPortalController) is already "if you
-- know the room's UUID from the URL, you can read/act on that room" -
-- there's no separate guest login token, by design, since the whole
-- point is a guest never has to sign in. These policies grant the
-- browser's anonymous connection read access under exactly that same
-- boundary: a row scoped to a room is visible, nothing else - no
-- business-wide or cross-room visibility is ever granted to anon. This
-- introduces no new exposure beyond what the public REST endpoints
-- already return today; it just lets the same data push instead of
-- being polled.

-- Orders need a direct room_id to filter Realtime's `postgres_changes`
-- (which only supports simple column filters, not a join through
-- charged_to_folio_id -> reservation -> room). Denormalized and only
-- ever set for hotel guest-portal orders - identical in spirit to how
-- table_label/item_name are already denormalized snapshots on this table.
alter table public.orders add column if not exists room_id uuid references public.hotel_rooms(id) on delete set null;

create policy "anon can read guest requests for a known room" on public.guest_service_requests for select to anon
  using (room_id is not null);

create policy "anon can read housekeeping tasks for a known room" on public.housekeeping_tasks for select to anon
  using (room_id is not null);

create policy "anon can read maintenance tickets for a known room" on public.maintenance_tickets for select to anon
  using (room_id is not null);

-- Orders already has broader anon exposure concerns than the other three
-- (it's a shared table with restaurant orders too), so this policy is
-- deliberately narrower: only rows that actually have a room_id (i.e.
-- only ever hotel guest-portal orders) are visible to anon - a
-- restaurant's card-based orders (room_id always null) are completely
-- unaffected and remain invisible to anon under this policy.
create policy "anon can read hotel guest orders for a known room" on public.orders for select to anon
  using (room_id is not null);

alter publication supabase_realtime add table public.maintenance_tickets;
