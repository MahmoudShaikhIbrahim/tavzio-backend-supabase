-- =========================================================================
-- The 7 fixed links can now have a custom label and an uploaded image,
-- same as custom buttons already could - both nullable/optional, so
-- existing businesses are unaffected until someone explicitly sets them.
-- =========================================================================
alter table public.businesses alter column links set default '{
  "googleReviews": {"enabled": false, "value": "", "icon": "star", "label": null, "imageUrl": null},
  "instagram": {"enabled": false, "value": "", "icon": "instagram", "label": null, "imageUrl": null},
  "tiktok": {"enabled": false, "value": "", "icon": "tiktok", "label": null, "imageUrl": null},
  "facebook": {"enabled": false, "value": "", "icon": "facebook", "label": null, "imageUrl": null},
  "whatsapp": {"enabled": false, "value": "", "icon": "whatsapp", "label": null, "imageUrl": null},
  "website": {"enabled": false, "value": "", "icon": "globe", "label": null, "imageUrl": null},
  "directions": {"enabled": false, "value": "", "icon": "mapPin", "label": null, "imageUrl": null}
}'::jsonb;
