-- =========================================================================
-- Adds Tavzio's own cyber liability insurance details to the existing
-- receipt_branding singleton (Tavzio's company-level record, already
-- used for legal_name/TRN/stamp/signature on receipts and contracts).
-- These fields are optional and left blank until a real policy exists -
-- buildContractText() in contractController.js only states insurance
-- coverage in an issued contract when both fields are actually set,
-- and falls back to an honest "in the process of obtaining" clause
-- otherwise. Never represent coverage that doesn't exist yet.
-- =========================================================================

alter table public.receipt_branding
  add column if not exists cyber_insurance_provider text not null default '',
  add column if not exists cyber_insurance_policy_number text not null default '';

comment on column public.receipt_branding.cyber_insurance_provider is 'Insurer name once a real cyber liability policy is purchased (e.g. AXA, RSA). Leave blank until coverage is actually in place.';
comment on column public.receipt_branding.cyber_insurance_policy_number is 'Policy number for the cyber liability policy referenced above. Leave blank until coverage is actually in place.';
