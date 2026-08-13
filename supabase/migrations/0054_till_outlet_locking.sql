-- One till, one outlet, per session (confirmed decision - not a
-- shared/multi-outlet till). Nullable: only ever set for hotel
-- businesses opening a till against a specific outlet (Beach, Lobby,
-- Pool Bar, etc.) - a restaurant's till (no outlets concept, per the
-- "hotel only for now" decision) is completely unaffected.
alter table public.till_sessions add column if not exists outlet_id uuid references public.hotel_outlets(id) on delete set null;
create index if not exists idx_till_sessions_outlet on public.till_sessions(outlet_id) where outlet_id is not null;

-- Which specific outlet(s) a staff member is allowed to open a till
-- for - NULL (the default, and every existing account's value) means
-- unrestricted, same "nothing changes until an owner explicitly
-- configures it" convention as assigned_sections. A beach attendant
-- assigned only to the Beach outlet can never accidentally open a
-- Lobby till.
alter table public.profiles add column if not exists assigned_outlet_ids uuid[];
