-- =========================================================================
-- Add icon defaults to the links column's default shape, matching the
-- keys used by the new shared icon library (frontend). Existing
-- businesses are unaffected - the frontend already falls back to a
-- sensible default icon per link type when `icon` is missing, so this is
-- purely about new businesses getting a fully-populated default from the
-- start rather than relying on that fallback forever.
-- =========================================================================
alter table public.businesses alter column links set default '{
  "googleReviews": {"enabled": false, "value": "", "icon": "star"},
  "instagram": {"enabled": false, "value": "", "icon": "instagram"},
  "tiktok": {"enabled": false, "value": "", "icon": "tiktok"},
  "facebook": {"enabled": false, "value": "", "icon": "facebook"},
  "whatsapp": {"enabled": false, "value": "", "icon": "whatsapp"},
  "website": {"enabled": false, "value": "", "icon": "globe"},
  "directions": {"enabled": false, "value": "", "icon": "mapPin"}
}'::jsonb;
