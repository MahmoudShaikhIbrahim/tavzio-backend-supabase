-- =========================================================================
-- Tracks whether a given account has completed (or explicitly skipped)
-- the guided product tour, so the dashboard knows whether to auto-show
-- it on login without re-showing it every single time someone signs in.
-- Per-profile, not per-business, since an owner and each staff member
-- log in separately and each should get their own first-run experience -
-- a staff member invited six months after the owner still deserves to
-- see the tour on their own first login, not have it suppressed because
-- the owner already saw it once.
-- =========================================================================

alter table public.profiles
  add column if not exists tour_completed_at timestamptz;

comment on column public.profiles.tour_completed_at is
  'NULL = tour not yet shown (or was reset via Business Profile "Restart guide") - the dashboard auto-opens it on next login. Non-null = timestamp of completion or explicit skip; the tour stays available anytime via Business Profile but no longer auto-opens.';
