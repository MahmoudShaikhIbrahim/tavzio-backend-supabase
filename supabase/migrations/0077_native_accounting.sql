-- =========================================================================
-- Phase: Native accounting (GL / AP / AR). Applies to hotels AND
-- restaurants equally - every business needs a general ledger.
--
-- Design note: this does NOT replace zoho_books_integrations - that
-- stays as an export path for businesses who already run Zoho. This is
-- for businesses who want accounting IN Tavzio natively, with double-entry
-- bookkeeping as the source of truth. The two can coexist: a business
-- could post natively and still sync a summary out to Zoho.
-- =========================================================================

create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_account_id uuid references public.chart_of_accounts(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(business_id, code)
);

create index if not exists idx_coa_business on public.chart_of_accounts(business_id);

alter table public.chart_of_accounts enable row level security;
create policy "tenant manages own chart of accounts" on public.chart_of_accounts for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Double-entry journal. journal_entries is the header; lines are the
-- actual debits/credits. A trigger enforces debits = credits on post -
-- never allow an unbalanced entry to reach 'posted' status.
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  entry_date date not null default current_date,
  reference text default '',
  description text default '',
  -- Where this entry came from, if auto-generated (POS close, payroll
  -- run, AP bill, AR invoice) vs manually entered. Nullable source_id
  -- since manual entries have no upstream record.
  source_type text check (source_type in ('manual', 'pos_close', 'payroll', 'ap_bill', 'ar_invoice', 'night_audit')),
  source_id uuid,
  status text not null default 'draft' check (status in ('draft', 'posted', 'voided')),
  posted_by uuid references public.profiles(id),
  posted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_journal_entries_business on public.journal_entries(business_id, entry_date desc);
create index if not exists idx_journal_entries_source on public.journal_entries(source_type, source_id) where source_id is not null;

alter table public.journal_entries enable row level security;
create policy "tenant manages own journal entries" on public.journal_entries for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create table if not exists public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.chart_of_accounts(id),
  debit_aed numeric(12,2) not null default 0,
  credit_aed numeric(12,2) not null default 0,
  memo text default '',
  constraint jel_debit_or_credit_not_both check (not (debit_aed > 0 and credit_aed > 0))
);

create index if not exists idx_jel_entry on public.journal_entry_lines(journal_entry_id);
create index if not exists idx_jel_account on public.journal_entry_lines(account_id);

alter table public.journal_entry_lines enable row level security;
create policy "tenant manages own journal entry lines" on public.journal_entry_lines for all to authenticated
  using (
    public.current_role_name() = 'super_admin'
    or journal_entry_id in (select id from public.journal_entries where business_id = public.current_business_id())
  )
  with check (
    public.current_role_name() = 'super_admin'
    or journal_entry_id in (select id from public.journal_entries where business_id = public.current_business_id())
  );

-- Enforce balanced entries at post time only (draft entries can be
-- unbalanced mid-edit - that's normal while someone is building one up).
create or replace function public.check_journal_entry_balanced()
returns trigger as $$
declare
  total_debits numeric;
  total_credits numeric;
begin
  if new.status = 'posted' and (old.status is null or old.status <> 'posted') then
    select coalesce(sum(debit_aed), 0), coalesce(sum(credit_aed), 0)
      into total_debits, total_credits
      from public.journal_entry_lines where journal_entry_id = new.id;
    if total_debits <> total_credits then
      raise exception 'journal entry % is not balanced: debits % != credits %', new.id, total_debits, total_credits;
    end if;
    new.posted_at = coalesce(new.posted_at, now());
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_journal_entry_balanced on public.journal_entries;
create trigger trg_journal_entry_balanced
  before update on public.journal_entries
  for each row execute function public.check_journal_entry_balanced();

-- Accounts Payable: vendors + bills owed to them.
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  contact_email text default '',
  contact_phone text default '',
  payment_terms_days integer not null default 30,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_vendors_business on public.vendors(business_id);

alter table public.vendors enable row level security;
create policy "tenant manages own vendors" on public.vendors for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

create table if not exists public.ap_bills (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id),
  -- Optional link to the purchase order this bill settles, connecting
  -- into the existing advanced inventory purchase_orders table rather
  -- than duplicating a vendor-bill relationship there.
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  bill_number text default '',
  bill_date date not null default current_date,
  due_date date not null,
  amount_aed numeric(10,2) not null default 0,
  amount_paid_aed numeric(10,2) not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid', 'partial', 'paid', 'overdue', 'voided')),
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ap_bills_business on public.ap_bills(business_id, due_date);
create index if not exists idx_ap_bills_vendor on public.ap_bills(vendor_id);

alter table public.ap_bills enable row level security;
create policy "tenant manages own ap bills" on public.ap_bills for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Accounts Receivable: invoices owed to the business. Distinct from
-- hotel_city_ledger_entries (which is guest-folio-specific, deferred
-- payment on a guest's room) - ar_invoices is broader: corporate
-- clients, event/banqueting clients, any B2B receivable.
create table if not exists public.ar_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_name text not null,
  customer_email text default '',
  invoice_number text default '',
  invoice_date date not null default current_date,
  due_date date not null,
  amount_aed numeric(10,2) not null default 0,
  amount_received_aed numeric(10,2) not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid', 'partial', 'paid', 'overdue', 'voided')),
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ar_invoices_business on public.ar_invoices(business_id, due_date);

alter table public.ar_invoices enable row level security;
create policy "tenant manages own ar invoices" on public.ar_invoices for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
