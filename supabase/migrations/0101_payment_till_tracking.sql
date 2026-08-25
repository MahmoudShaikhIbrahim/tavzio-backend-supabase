-- Real, necessary consequence of splitting "Send to Kitchen" from
-- "Payment" into two separate actions/moments: closeTill used to sum
-- cash directly off orders.till_session_id + orders.payment_method,
-- which only worked because payment method was always chosen at the
-- exact same moment the order was created and till-tied. Once an order
-- can sit open and unpaid for a while - a dine-in table paying later, a
-- pickup order collected and paid tomorrow - that assumption breaks:
-- the till that should get credit for the cash is whichever one was
-- open at the moment someone actually handed over the cash, which may
-- be a different till session (even a different staff member's shift)
-- than whichever till was open when the order was first rung in.
alter table public.payments
  add column if not exists till_session_id uuid references public.till_sessions(id) on delete set null;

create index if not exists idx_payments_till_session on public.payments(till_session_id) where till_session_id is not null;
