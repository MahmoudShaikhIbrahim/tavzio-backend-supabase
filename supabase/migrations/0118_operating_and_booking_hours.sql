-- Real fix for the explicit request: a genuine, three-level opening-
-- hours system. operating_hours is the actual restaurant/hotel hours
-- (set in Business Profile). booking_hours is optional and, when set,
-- overrides operating_hours specifically for Online Booking's own
-- time picker - a business might be open until midnight but only
-- accept table reservations until 10pm. Per-day-of-week shape (not one
-- flat range) since real businesses commonly close or shorten hours
-- on specific days.
--
-- Shape: { "mon": {"open": "09:00", "close": "23:00"}, "tue": null, ... }
-- - a null value for a day means closed that day. All 7 keys optional;
-- a missing key is treated as "no restriction" by the application, not
-- "closed" - this keeps existing businesses fully unaffected until an
-- owner deliberately sets hours.
alter table public.businesses add column if not exists operating_hours jsonb;
alter table public.businesses add column if not exists booking_hours jsonb;

comment on column public.businesses.operating_hours is 'Real opening/closing hours per day of week, e.g. {"mon":{"open":"09:00","close":"23:00"},"tue":null}. Null day = closed. Missing/null column = no restriction applied.';
comment on column public.businesses.booking_hours is 'Optional override of operating_hours specifically for Online Booking''s own availability - same shape. Null column = falls back to operating_hours.';

-- Real, service-specific availability window - the actual "only show
-- time options where this service is available" request. A simple
-- single daily range (not per-day-of-week, to keep this genuinely
-- usable to configure) - null on either means no restriction for that
-- bound, so a service with neither set is available any time the
-- booking itself is.
alter table public.services add column if not exists available_start_time time;
alter table public.services add column if not exists available_end_time time;

comment on column public.services.available_start_time is 'Earliest time of day this service can be requested for, e.g. 18:00. Null = no lower bound.';
comment on column public.services.available_end_time is 'Latest time of day this service can be requested for, e.g. 22:00. Null = no upper bound.';
