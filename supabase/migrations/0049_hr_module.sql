-- Owner-only HR module, gated behind features.hr.enabled (and each
-- sub-feature behind its own flag) - staff never see any of this
-- regardless of section assignment, enforced server-side below, not
-- just hidden in the UI.

-- 1) Staff documents (ID, visa, labor card, signed contract) - distinct
--    from hotel guest documents, which already exist separately.
create table if not exists public.staff_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  doc_type text not null,
  file_url text not null,
  label text default '',
  expiry_date date,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_documents_staff on public.staff_documents(staff_id);

alter table public.staff_documents enable row level security;
-- Owner/super_admin only, deliberately - no staff-facing policy at all,
-- not even for a staff member to read their own documents. RLS is the
-- real backstop here, not just route-level authorize() checks.
create policy "owner manages own business staff documents" on public.staff_documents for all to authenticated
  using (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'))
  with check (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'));

-- 2) Commission rate per staff member - owner-set, used to compute a
--    commission report from orders (attributed via placed_by or
--    placed_by_staff_id, both already exist).
alter table public.profiles add column if not exists commission_rate numeric(5,2);
alter table public.profiles add column if not exists commission_type text check (commission_type in ('percentage', 'fixed_per_order'));

-- 3) Tip pooling - a distribution event (e.g. "Friday night tips") split
--    across staff, with a record of who got what, not just a total.
create table if not exists public.tip_distributions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  total_amount_aed numeric(10,2) not null,
  method text not null default 'even' check (method in ('even', 'by_hours')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.tip_distribution_shares (
  id uuid primary key default gen_random_uuid(),
  distribution_id uuid not null references public.tip_distributions(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  amount_aed numeric(10,2) not null
);
create index if not exists idx_tip_shares_distribution on public.tip_distribution_shares(distribution_id);

alter table public.tip_distributions enable row level security;
create policy "owner manages own tip distributions" on public.tip_distributions for all to authenticated
  using (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'))
  with check (public.current_role_name() = 'super_admin' or (business_id = public.current_business_id() and public.current_role_name() = 'business_owner'));

alter table public.tip_distribution_shares enable row level security;
create policy "owner manages own tip shares" on public.tip_distribution_shares for all to authenticated
  using (public.current_role_name() = 'super_admin' or exists (
    select 1 from public.tip_distributions d where d.id = distribution_id and d.business_id = public.current_business_id() and public.current_role_name() = 'business_owner'
  ))
  with check (public.current_role_name() = 'super_admin' or exists (
    select 1 from public.tip_distributions d where d.id = distribution_id and d.business_id = public.current_business_id() and public.current_role_name() = 'business_owner'
  ));

-- Private storage bucket for HR documents (staff ID/passport/visa/labor
-- card/contracts) - deliberately NOT public, unlike business-assets.
-- Those documents are sensitive; a public bucket would mean anyone with
-- the URL could view someone's passport with no login at all. Access
-- here requires an authenticated business_owner (or super_admin) whose
-- business_id matches the folder the file lives in - the frontend must
-- request a short-lived signed URL to actually view/download a file,
-- never a permanent public link.
insert into storage.buckets (id, name, public)
values ('staff-documents', 'staff-documents', false)
on conflict (id) do nothing;

create policy "owner can read own business staff documents bucket"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'staff-documents'
    and (
      public.current_role_name() = 'super_admin'
      or (
        public.current_role_name() = 'business_owner'
        and (storage.foldername(name))[1] = public.current_business_id()::text
      )
    )
  );

create policy "owner can upload own business staff documents"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'staff-documents'
    and (
      public.current_role_name() = 'super_admin'
      or (
        public.current_role_name() = 'business_owner'
        and (storage.foldername(name))[1] = public.current_business_id()::text
      )
    )
  );

create policy "owner can delete own business staff documents"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'staff-documents'
    and (
      public.current_role_name() = 'super_admin'
      or (
        public.current_role_name() = 'business_owner'
        and (storage.foldername(name))[1] = public.current_business_id()::text
      )
    )
  );
