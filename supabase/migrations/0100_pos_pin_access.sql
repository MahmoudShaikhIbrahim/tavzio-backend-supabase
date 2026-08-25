-- Real PIN-based POS access. Hashed, never stored or logged in plain
-- text - same principle as a password, just shorter and used for a
-- different purpose (confirming WHICH staff member is physically
-- performing a sensitive action right now, not signing in for a
-- session). pin_hash format is 'salt:hash' hex, produced by Node's
-- built-in crypto.scrypt (see utils/pin.js) - no new dependency added
-- for this, scrypt is a real, memory-hard, industry-standard choice
-- already built into Node itself.
--
-- Deliberately NOT set at invite time - a PIN is something a staff
-- member chooses themselves the first time they need it (first POS
-- payment/void/discount action), same reasoning a password isn't
-- chosen for someone else. pin_set_at is null until they do.
alter table public.profiles
  add column if not exists pin_hash text,
  add column if not exists pin_set_at timestamptz,
  -- Real lockout after repeated wrong PIN attempts - a 4-6 digit PIN
  -- has a tiny keyspace, so without this, sensitive actions (payment,
  -- void, discount, refund) would be brute-forceable in seconds by
  -- anyone standing at an already-logged-in terminal. Reset to 0 on
  -- every successful verification.
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz;

comment on column public.profiles.pin_hash is
  'scrypt hash (format: salt:hash, both hex) of this staff member''s POS PIN - never the plain PIN itself. Set by the staff member on first use, cleared (not reset to a known value) by an owner via Staff page if forgotten.';
