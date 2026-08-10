-- =========================================================================
-- Stripe-based automated billing + public (no-login) contract signing.
-- Real API keys aren't set yet (no live Stripe account until the trade
-- license/business bank account exist) - every Stripe call here degrades
-- to a clear error rather than pretending to succeed, same pattern as
-- every other payment adapter in this codebase (SMTP, Ziina, Tap).
-- =========================================================================

alter table public.contracts add column if not exists sign_token text unique;
alter table public.contracts add column if not exists sign_token_expires_at timestamptz;
alter table public.contracts add column if not exists stripe_customer_id text;
alter table public.contracts add column if not exists stripe_subscription_id text;
alter table public.contracts add column if not exists sent_at timestamptz;

create index if not exists idx_contracts_sign_token on public.contracts(sign_token);

-- Receipts issued automatically from a Stripe webhook the instant a
-- charge succeeds are already paid - no Ziina link, nothing to chase.
alter table public.receipts add column if not exists source text not null default 'manual' check (source in ('manual', 'stripe_auto'));
