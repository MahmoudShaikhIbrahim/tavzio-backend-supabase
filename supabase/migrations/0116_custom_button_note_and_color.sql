-- Real fix for two confirmed requests: not every notification button
-- should force a notes box on the guest (Call Waiter never needed one,
-- Order Adjustments genuinely does) - allow_note makes this a real,
-- explicit per-button choice instead of a blanket behavior. color lets
-- staff assign their own request-card color per button, stored as a
-- plain hex string and applied only via inline styles on that specific
-- card - never a CSS variable or global class, so a bad color choice
-- can only ever affect that one button's own card, never leak into any
-- other color in the app.
alter table public.custom_buttons add column if not exists allow_note boolean not null default true;
alter table public.custom_buttons add column if not exists color text;

comment on column public.custom_buttons.allow_note is 'Whether a guest can add an optional note before sending this notification. Defaults to true for existing buttons to preserve current behavior.';
comment on column public.custom_buttons.color is 'Optional hex color (e.g. #b8925a) for this button''s request card. Null falls back to the default brass/type-based color.';

-- Carries the button's chosen color through to the actual request
-- record at creation time, so the request card the staff sees can
-- read it directly - the button definition itself isn't joined against
-- when rendering the Requests/Orders/Kitchen notification cards.
alter table public.orders add column if not exists request_color text;
alter table public.guest_service_requests add column if not exists request_color text;
