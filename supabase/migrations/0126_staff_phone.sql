-- A staff member's contact phone number, set by an owner/manager (not
-- self-service, unlike avatar_url) - shown alongside their email in the
-- Staff overview panel.
alter table profiles add column if not exists phone text;
