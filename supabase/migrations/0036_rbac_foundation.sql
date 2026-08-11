-- =========================================================================
-- Phase 2: real RBAC for hotel-context staff roles (front desk, F&B
-- manager, waiter, housekeeping, etc). Deliberately additive rather than
-- replacing the existing profiles.role enum (super_admin/business_owner/
-- staff), which the entire rest of the codebase already authorizes
-- against - changing that enum would risk breaking every existing
-- authorize() check across the whole app. job_role is a second,
-- optional layer: only staff accounts in hotel-context modules need it,
-- everything else keeps working exactly as it already does.
-- =========================================================================

alter table public.profiles add column if not exists job_role text;

create table if not exists public.role_permissions (
  role_key text primary key,
  permissions jsonb not null default '[]'::jsonb,
  label text not null default ''
);

alter table public.role_permissions enable row level security;

create policy "authenticated can read role permissions" on public.role_permissions for select to authenticated using (true);
create policy "super_admin manages role permissions" on public.role_permissions for all to authenticated
  using (public.current_role_name() = 'super_admin')
  with check (public.current_role_name() = 'super_admin');

-- Seeded from the roles/permissions the requirements doc spells out
-- directly - a real starting set, not placeholders. business_owner and
-- super_admin are deliberately NOT listed here: they already have
-- implicit full access to their own business (and everything,
-- respectively) via the existing role system, so they never need a
-- job_role or a permissions lookup at all.
insert into public.role_permissions (role_key, label, permissions) values
  ('hotel_manager', 'Hotel Manager', '["hotels.read","rooms.read","rooms.manage","reservations.read","reservations.create","reservations.manage","guests.read","folios.read","folios.manage","reports.read","staff.manage","fnb.read","fnb.manage"]'::jsonb),
  ('front_desk', 'Front Desk', '["reservations.read","reservations.create","reservations.update","guests.read","guests.create","rooms.read","rooms.assign","checkin.perform","checkout.perform","folios.read"]'::jsonb),
  ('fnb_manager', 'F&B Manager', '["restaurants.read","restaurants.manage","menus.manage","tables.read","tables.manage","orders.read","orders.manage","kitchen.read","fnb.reports.read","fnb.staff.manage"]'::jsonb),
  ('waiter', 'Waiter', '["tables.read","orders.create","orders.read","orders.update"]'::jsonb),
  ('room_service_staff', 'Room Service Staff', '["orders.read.roomservice","orders.update.roomservice","delivery.status.update"]'::jsonb),
  ('kitchen_staff', 'Kitchen Staff', '["kitchen.read","orders.status.update"]'::jsonb),
  ('housekeeping', 'Housekeeping', '["rooms.read.assigned","rooms.status.update","housekeeping.tasks.read","housekeeping.tasks.update","maintenance.read"]'::jsonb),
  ('maintenance', 'Maintenance', '["maintenance.tickets.read.assigned","maintenance.tickets.update"]'::jsonb),
  ('cashier', 'Cashier', '["payments.read","payments.process","checks.read","refunds.create","cash.manage"]'::jsonb),
  ('accountant', 'Accountant', '["reports.financial.read","folios.read","payments.read","taxes.read","revenue.read"]'::jsonb)
on conflict (role_key) do nothing;
