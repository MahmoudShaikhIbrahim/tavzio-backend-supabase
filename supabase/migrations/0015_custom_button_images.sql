-- =========================================================================
-- Custom buttons can now use an uploaded image instead of a picked icon -
-- an owner's own logo or picture for that specific link, stored the same
-- way logo/cover images already are (Supabase Storage, business-assets
-- bucket). Nullable and optional - existing buttons keep using their icon
-- exactly as before until someone explicitly uploads an image for one.
-- =========================================================================
alter table public.custom_buttons
  add column if not exists image_url text;
