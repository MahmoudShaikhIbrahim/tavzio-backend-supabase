-- =========================================================================
-- Phase: Payroll (hotels AND restaurants - every business with staff
-- needs this, not hotel-specific). Builds on staff_schedules (labor
-- scheduling) and tip_distributions (HR module) already in place -
-- payroll_runs pulls hours from schedules and tips from distributions
-- rather than duplicating that data.
-- =========================================================================

-- One row per staff member per business: their pay structure. A person
-- can only have one active salary structure per business at a time -
-- history is preserved by closing out (effective_to) and inserting a
-- new row on any change, never mutating in place.
create table if not exists public.salary_structures (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  pay_type text not null check (pay_type in ('monthly', 'hourly', 'daily')),
  base_amount_aed numeric(10,2) not null default 0,
  housing_allowance_aed numeric(10,2) not null default 0,
  transport_allowance_aed numeric(10,2) not null default 0,
  other_allowances_aed numeric(10,2) not null default 0,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now()
);

create index if not exists idx_salary_structures_business on public.salary_structures(business_id);
create index if not exists idx_salary_structures_staff_active on public.salary_structures(staff_id) where effective_to is null;

alter table public.salary_structures enable row level security;
create policy "tenant manages own salary structures" on public.salary_structures for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- A payroll run = one pay period being processed for a business.
-- Deliberately staged (draft -> approved -> paid) so nothing pays out
-- silently - mirrors the pattern already used by hotel_night_audits and
-- the standalone contracts pipeline (draft -> sent -> signed -> paid).
create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'cancelled')),
  total_gross_aed numeric(10,2) not null default 0,
  total_deductions_aed numeric(10,2) not null default 0,
  total_net_aed numeric(10,2) not null default 0,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payroll_runs_period_valid check (period_end >= period_start)
);

create index if not exists idx_payroll_runs_business on public.payroll_runs(business_id, period_start desc);

alter table public.payroll_runs enable row level security;
create policy "tenant manages own payroll runs" on public.payroll_runs for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- One payslip per staff member per run. Snapshots the salary structure
-- at time of run (not a live join) so a later salary change never
-- rewrites history on an already-issued payslip.
create table if not exists public.payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id),
  base_amount_aed numeric(10,2) not null default 0,
  allowances_aed numeric(10,2) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  overtime_amount_aed numeric(10,2) not null default 0,
  tips_amount_aed numeric(10,2) not null default 0,
  gross_aed numeric(10,2) not null default 0,
  -- Deductions itemized as jsonb (leave without pay, loan repayment,
  -- absence, etc.) rather than fixed columns, since deduction types
  -- vary a lot business to business and this avoids another migration
  -- every time a new deduction type shows up.
  deductions jsonb not null default '[]'::jsonb,
  total_deductions_aed numeric(10,2) not null default 0,
  net_aed numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  unique(payroll_run_id, staff_id)
);

create index if not exists idx_payslips_run on public.payslips(payroll_run_id);
create index if not exists idx_payslips_staff on public.payslips(staff_id, created_at desc);

alter table public.payslips enable row level security;
create policy "tenant manages own payslips" on public.payslips for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
-- Staff can view their own payslips even though they're not
-- business_owner/super_admin - payslips are personal financial data.
create policy "staff view own payslips" on public.payslips for select to authenticated
  using (staff_id = auth.uid());

-- WPS (Wage Protection System) is the UAE-mandated payroll file format
-- banks require for salary transfers. One export record per run so
-- there's an audit trail of what was actually submitted to the bank.
create table if not exists public.wps_exports (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  file_format text not null default 'sif' check (file_format in ('sif')),
  generated_at timestamptz not null default now(),
  generated_by uuid references public.profiles(id)
);

alter table public.wps_exports enable row level security;
create policy "tenant manages own wps exports" on public.wps_exports for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
