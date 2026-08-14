-- Unifies "Call a Waiter" / "Request the Bill" (previously hardcoded
-- Features toggles) and any new custom guest-notification button (e.g.
-- Housekeeping) into ONE system, managed from Landing Page Buttons -
-- confirmed decision, not a parallel feature.
--
-- custom_buttons already exists for external-link buttons - this adds a
-- second button TYPE that, instead of opening a URL, submits a request
-- straight into the same orders/Requests system staff already use for
-- Call Waiter/Request Bill today (real-time, dashboard-visible,
-- dismissible) - reusing that plumbing rather than building a parallel
-- notification system from scratch.
alter table public.custom_buttons add column if not exists button_type text not null default 'link' check (button_type in ('link', 'notification'));

-- request_type on orders gains one more value: 'custom', for any
-- notification-type custom button. The actual label shown to staff
-- comes from custom_request_label, captured at the moment the request
-- is made - so it keeps showing correctly even if the button is later
-- renamed or deleted.
alter table public.orders drop constraint if exists orders_request_type_check;
alter table public.orders add constraint orders_request_type_check
  check (request_type in ('order', 'call_waiter', 'request_bill', 'custom'));
alter table public.orders add column if not exists custom_request_label text;

-- Migrate every business that currently has Call Waiter and/or Request
-- Bill turned on (via the old Features toggle) into real notification-
-- type custom_buttons rows, so nobody's landing page silently loses a
-- button they already had live. sort_order pushes these above whatever
-- link buttons already exist, matching their old prominent position.
insert into public.custom_buttons (business_id, label, icon, url, button_type, sort_order, enabled)
select id, 'Call a Waiter', 'bell', '', 'notification', -20, true
from public.businesses b
where coalesce((features->'ordering'->>'callWaiter')::boolean, false) = true
  -- Idempotency guard - without this, re-running this migration (which
  -- has genuinely happened) silently duplicates the button every time,
  -- since a plain INSERT...SELECT has no built-in protection against
  -- running twice. This is exactly the bug that produced a real
  -- duplicate "Request the Bill" row in production.
  and not exists (
    select 1 from public.custom_buttons cb
    where cb.business_id = b.id and cb.label = 'Call a Waiter' and cb.button_type = 'notification'
  );

insert into public.custom_buttons (business_id, label, icon, url, button_type, sort_order, enabled)
select id, 'Request the Bill', 'receipt', '', 'notification', -10, true
from public.businesses b
where coalesce((features->'ordering'->>'requestBill')::boolean, false) = true
  and not exists (
    select 1 from public.custom_buttons cb
    where cb.business_id = b.id and cb.label = 'Request the Bill' and cb.button_type = 'notification'
  );
