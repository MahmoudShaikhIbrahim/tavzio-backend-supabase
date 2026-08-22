-- =========================================================================
-- Phase: Marketing automation (email/SMS campaigns). Applies to hotels
-- AND restaurants equally. Recipients draw from hotel_guests OR the
-- existing loyalty membership table depending on business type, so this
-- doesn't duplicate guest/customer records - it references them.
-- =========================================================================

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('email', 'sms')),
  subject text default '',
  body text not null default '',
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_marketing_campaigns_business on public.marketing_campaigns(business_id, created_at desc);

alter table public.marketing_campaigns enable row level security;
create policy "tenant manages own marketing campaigns" on public.marketing_campaigns for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Per-recipient send record. recipient_ref/recipient_type is a loose
-- pointer (not a hard FK) because recipients can come from either
-- hotel_guests or the loyalty membership table depending on business
-- type - a hard FK to one would break for the other. This mirrors how
-- the codebase already handles the "two different guest concepts"
-- problem rather than forcing a shared table that doesn't fit either.
create table if not exists public.marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('hotel_guest', 'loyalty_member', 'manual')),
  recipient_ref uuid,
  contact_value text not null, -- resolved email or phone at send time, so a later contact change doesn't rewrite send history
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'opened', 'clicked', 'unsubscribed')),
  sent_at timestamptz,
  failure_reason text default ''
);

create index if not exists idx_campaign_recipients_campaign on public.marketing_campaign_recipients(campaign_id);
create index if not exists idx_campaign_recipients_pending on public.marketing_campaign_recipients(campaign_id) where status = 'pending';

alter table public.marketing_campaign_recipients enable row level security;
create policy "tenant manages own campaign recipients" on public.marketing_campaign_recipients for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Reusable content blocks (welcome series, birthday offer, win-back,
-- post-stay/post-visit review request) so campaigns aren't always
-- written from scratch.
create table if not exists public.marketing_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('email', 'sms')),
  subject text default '',
  body text not null default '',
  category text default 'general' check (category in ('general', 'welcome', 'birthday', 'win_back', 'review_request', 'promotion')),
  created_at timestamptz not null default now()
);

create index if not exists idx_marketing_templates_business on public.marketing_templates(business_id);

alter table public.marketing_templates enable row level security;
create policy "tenant manages own marketing templates" on public.marketing_templates for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());

-- Explicit opt-out tracking, separate from any one recipient table
-- since it must persist even if a guest/loyalty record is later
-- deleted - a phone/email that unsubscribed must stay suppressed.
create table if not exists public.marketing_suppressions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_value text not null,
  channel text not null check (channel in ('email', 'sms')),
  reason text default 'unsubscribed',
  created_at timestamptz not null default now(),
  unique(business_id, contact_value, channel)
);

alter table public.marketing_suppressions enable row level security;
create policy "tenant manages own marketing suppressions" on public.marketing_suppressions for all to authenticated
  using (public.current_role_name() = 'super_admin' or business_id = public.current_business_id())
  with check (public.current_role_name() = 'super_admin' or business_id = public.current_business_id());
