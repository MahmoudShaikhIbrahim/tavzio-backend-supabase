-- Real bug fix #1: there has only ever been ONE update policy on
-- public.profiles - "user can update own profile" (id = auth.uid()),
-- from migration 0001. Every staff-management mutation that updates
-- ANOTHER profile's row - setStaffActive (deactivate), setStaffFullAccess,
-- setStaffSections, setStaffOutlets, setStaffJobRole - runs through
-- req.supabase (RLS-bound, not supabaseAdmin). With no policy covering
-- this case, every one of those updates has been silently blocked by
-- RLS - the query matches zero rows, and the controller correctly
-- reports "Staff member not found" for what looks like a normal 404,
-- masking that the row was actually right there the whole time.
-- Mirrors the same shape as the 0094/0096 SELECT policy fix - same
-- root cause pattern (a mutation exists in app code with no matching
-- RLS policy behind it), just never caught until Deactivate/full-access
-- was actually clicked on an account with real activity.
create policy "business owner can update own business staff"
  on public.profiles for update
  to authenticated
  using (
    business_id is not null
    and business_id = public.current_business_id()
    and (public.current_role_name() = 'business_owner' or public.current_role_name() = 'staff')
    and role in ('staff', 'org_owner')
  )
  with check (
    business_id is not null
    and business_id = public.current_business_id()
    and role in ('staff', 'org_owner')
  );

-- Real bug fix #2: 23 columns referencing public.profiles(id) were
-- created with no explicit `on delete` behavior, which Postgres
-- defaults to NO ACTION - blocking the delete outright the moment any
-- referencing row exists anywhere. deleteStaff calls
-- supabaseAdmin.auth.admin.deleteUser(), which cascades through
-- auth.users -> profiles (that part is fine, on delete cascade) but
-- then hits the first of these un-cascaded references and fails with
-- a generic, unhelpful "Database error deleting user" - exactly what
-- surfaced trying to delete an org_owner account, but this was never
-- specific to org_owner: it blocks deleting ANY staff member the
-- moment they have so much as one contract, purchase order, shift,
-- HR document, journal entry, etc. attributed to them. Switched to
-- on delete set null throughout - matches the pattern already used
-- correctly elsewhere in this schema (voided_by, issued_by,
-- recorded_by, refunded_by, actor_id, sender_id all already do this) -
-- the historical record stays, it just stops pointing at a deleted
-- account, exactly like "deleted user" shows up in any product that
-- keeps history past account deletion.
alter table public.contracts
  drop constraint if exists contracts_created_by_fkey,
  add constraint contracts_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null,
  drop constraint if exists contracts_terminated_by_fkey,
  add constraint contracts_terminated_by_fkey foreign key (terminated_by) references public.profiles(id) on delete set null;

alter table public.purchase_orders
  drop constraint if exists purchase_orders_created_by_fkey,
  add constraint purchase_orders_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.stock_movements
  drop constraint if exists stock_movements_created_by_fkey,
  add constraint stock_movements_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.hotel_night_audits
  drop constraint if exists hotel_night_audits_run_by_fkey,
  add constraint hotel_night_audits_run_by_fkey foreign key (run_by) references public.profiles(id) on delete set null;

alter table public.housekeeping_tasks
  drop constraint if exists housekeeping_tasks_assigned_to_fkey,
  add constraint housekeeping_tasks_assigned_to_fkey foreign key (assigned_to) references public.profiles(id) on delete set null;

alter table public.maintenance_tickets
  drop constraint if exists maintenance_tickets_assigned_to_fkey,
  add constraint maintenance_tickets_assigned_to_fkey foreign key (assigned_to) references public.profiles(id) on delete set null;

alter table public.orders
  drop constraint if exists orders_discounted_by_fkey,
  add constraint orders_discounted_by_fkey foreign key (discounted_by) references public.profiles(id) on delete set null,
  drop constraint if exists orders_placed_by_fkey,
  add constraint orders_placed_by_fkey foreign key (placed_by) references public.profiles(id) on delete set null;

alter table public.staff_documents
  drop constraint if exists staff_documents_uploaded_by_fkey,
  add constraint staff_documents_uploaded_by_fkey foreign key (uploaded_by) references public.profiles(id) on delete set null;

alter table public.tip_distributions
  drop constraint if exists tip_distributions_created_by_fkey,
  add constraint tip_distributions_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.zoho_books_integrations
  drop constraint if exists zoho_books_integrations_connected_by_fkey,
  add constraint zoho_books_integrations_connected_by_fkey foreign key (connected_by) references public.profiles(id) on delete set null;

alter table public.staff_schedules
  drop constraint if exists staff_schedules_created_by_fkey,
  add constraint staff_schedules_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.business_budgets
  drop constraint if exists business_budgets_created_by_fkey,
  add constraint business_budgets_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.hotel_events
  drop constraint if exists hotel_events_created_by_fkey,
  add constraint hotel_events_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.bookings
  drop constraint if exists bookings_created_by_staff_id_fkey,
  add constraint bookings_created_by_staff_id_fkey foreign key (created_by_staff_id) references public.profiles(id) on delete set null;

alter table public.payroll_runs
  drop constraint if exists payroll_runs_approved_by_fkey,
  add constraint payroll_runs_approved_by_fkey foreign key (approved_by) references public.profiles(id) on delete set null;

alter table public.wps_exports
  drop constraint if exists wps_exports_generated_by_fkey,
  add constraint wps_exports_generated_by_fkey foreign key (generated_by) references public.profiles(id) on delete set null;

alter table public.journal_entries
  drop constraint if exists journal_entries_posted_by_fkey,
  add constraint journal_entries_posted_by_fkey foreign key (posted_by) references public.profiles(id) on delete set null;

alter table public.marketing_campaigns
  drop constraint if exists marketing_campaigns_created_by_fkey,
  add constraint marketing_campaigns_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.stock_transfers
  drop constraint if exists stock_transfers_requested_by_fkey,
  add constraint stock_transfers_requested_by_fkey foreign key (requested_by) references public.profiles(id) on delete set null,
  drop constraint if exists stock_transfers_approved_by_fkey,
  add constraint stock_transfers_approved_by_fkey foreign key (approved_by) references public.profiles(id) on delete set null,
  drop constraint if exists stock_transfers_received_by_fkey,
  add constraint stock_transfers_received_by_fkey foreign key (received_by) references public.profiles(id) on delete set null;

-- NOT fixed here, deliberately: public.till_sessions.staff_id and
-- public.payslips.staff_id are both `not null` - "on delete set null"
-- is impossible on a NOT NULL column, and picking cascade (delete their
-- till/payroll history along with them) vs. leaving them blocking
-- (can never delete a staff member with till or payslip history) is a
-- real business decision, not a technical default to pick silently.
