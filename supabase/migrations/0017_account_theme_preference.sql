-- =========================================================================
-- Each real account (super admin, owner, staff) now has its own theme
-- preference, stored on their profile - follows them across devices,
-- rather than being tied to one browser's local storage. Anonymous NFC
-- customer pages have no account to tie to, so they're deliberately
-- unaffected by this - they stay device-based, which is correct for a
-- visitor who's never logged into anything.
-- =========================================================================
alter table public.profiles
  add column if not exists theme_preference text not null default 'system'
    check (theme_preference in ('light', 'dark', 'system'));
