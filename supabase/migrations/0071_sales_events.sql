-- =========================================================================
-- Sales & Events / banquet management (hotel roadmap, module 8). Unlike
-- everything so far in the hotel roadmap, this is genuinely greenfield -
-- no event/function-space concept existed anywhere in the schema before
-- this. Mirrors the folio pattern deliberately (a running ledger of
-- charges, payment rows as negative amounts) so the billing model is
-- consistent with something already proven in this codebase, not a new
-- invented pattern.
-- =========================================================================

create table if not exists public.hotel_event_spaces (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  capacity integer not null default 0,
  hourly_rate_aed numeric(10,2) not null default 0,
  description text default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_event_spaces_business on public.hotel_event_spaces(business_id);

create table if not exists public.hotel_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  event_space_id uuid references public.hotel_event_spaces(id) on delete set null,
  client_name text not null,
  client_phone text default '',
  client_email text default '',
  event_type text not null default 'other' check (event_type in ('wedding', 'conference', 'meeting', 'corporate', 'social', 'other')),
  event_date date not null,
  start_time time not null,
  end_time time not null,
  expected_attendance integer not null default 0,
  -- Sales pipeline, not just a binary booked/not-booked - an inquiry
  -- that never converts is a real, common outcome a sales person needs
  -- to track (and eventually report a conversion rate from), not
  -- something that should be forced into "confirmed" or deleted.
  status text not null default 'inquiry' check (status in ('inquiry', 'tentative', 'confirmed', 'completed', 'cancelled')),
  sales_notes text default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists idx_events_business on public.hotel_events(business_id, event_date);
create index if not exists idx_events_space on public.hotel_events(event_space_id, event_date) where status in ('tentative', 'confirmed');

create table if not exists public.hotel_event_charges (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.hotel_events(id) on delete cascade,
  description text not null,
  amount_aed numeric not null,
  charge_type text not null default 'other' check (charge_type in ('venue', 'catering', 'av_equipment', 'service', 'other', 'payment')),
  -- Same convention as hotel_folio_charges: a 'payment' row uses a
  -- NEGATIVE amount_aed, one running ledger instead of a separate table
  -- to reconcile a balance against.
  created_at timestamptz not null default now()
);
create index if not exists idx_event_charges_event on public.hotel_event_charges(event_id);

alter table public.hotel_event_spaces enable row level security;
alter table public.hotel_events enable row level security;
alter table public.hotel_event_charges enable row level security;

create policy "tenant manages own event spaces" on public.hotel_event_spaces for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own events" on public.hotel_events for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create policy "tenant manages own event charges" on public.hotel_event_charges for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.hotel_events e where e.id = event_id and e.business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or exists (select 1 from public.hotel_events e where e.id = event_id and e.business_id = public.current_business_id())
  );

-- Audit log needs the new action categories this module introduces.
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in (
    'void_order', 'void_item', 'refund', 'staff_order_placed', 'card_deleted',
    'manual_payment_recorded', 'payment_integration_updated', 'receipt_item_removed',
    'contract_signed',
    'reservation_created', 'reservation_checked_in', 'reservation_checked_out', 'reservation_cancelled',
    'folio_charge_added', 'folio_payment_recorded', 'folio_refund_issued', 'folio_adjustment_made',
    'folio_split', 'folio_transferred', 'night_audit_run',
    'password_reset',
    'booking_group_created',
    'linked_accounts_created', 'account_switched', 'org_menu_published',
    'folio_charge_deleted',
    'reservation_no_show', 'reservation_modified', 'reservation_room_transferred',
    'city_ledger_settled',
    'event_created', 'event_status_changed'
  ));
