-- =========================================================================
-- Translation storage - every one of these *_i18n columns holds a jsonb
-- object like {"en": "...", "ar": "...", "fr": "...", ...}, one entry per
-- supported language, populated automatically by Google Translate the
-- moment an owner saves the original text. Nullable/defaulting to '{}' -
-- existing rows simply have no translations yet until they're next
-- edited, and every read path falls back to the original field when a
-- given language's translation is missing for any reason.
-- =========================================================================

alter table public.menu_categories
  add column if not exists name_i18n jsonb not null default '{}'::jsonb;

alter table public.menu_items
  add column if not exists name_i18n jsonb not null default '{}'::jsonb,
  add column if not exists description_i18n jsonb not null default '{}'::jsonb;

alter table public.businesses
  add column if not exists description_i18n jsonb not null default '{}'::jsonb;

alter table public.custom_buttons
  add column if not exists label_i18n jsonb not null default '{}'::jsonb;

alter table public.loyalty_programs
  add column if not exists reward_description_i18n jsonb not null default '{}'::jsonb;
