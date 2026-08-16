-- Each staff/owner account can pick its own preferred language, same 9
-- languages already offered on the customer-facing NFC interface, stored
-- per-account (like theme_preference) rather than per-business - two staff
-- on the same account can each have their own.
alter table public.profiles
  add column if not exists preferred_language text not null default 'en'
    check (preferred_language in ('en', 'ar', 'ru', 'es', 'hi', 'ur', 'tl', 'zh', 'fr'));
