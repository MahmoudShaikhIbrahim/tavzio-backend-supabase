-- Self-service profile photo: an owner or staff member's own picture, so
-- managers can recognize a face immediately when reviewing staff, instead
-- of only ever seeing an initials circle. Nullable, no default - accounts
-- keep showing their initials until they actually set one.
alter table profiles add column if not exists avatar_url text;
