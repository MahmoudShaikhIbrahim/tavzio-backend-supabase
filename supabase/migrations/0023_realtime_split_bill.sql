-- =========================================================================
-- Real-time split-bill support
-- =========================================================================
-- Two things needed for the customer-facing Pay Bill page to update
-- live (Friend A pays, Friend B's screen removes that item instantly)
-- and to show a "Paid" section:
--
-- 1. order_items currently has NO anon SELECT policy at all - only
--    `authenticated` can read it (see 0006). That's correct for the
--    dashboard, but the Pay Bill page is anonymous by design (no login),
--    so Supabase Realtime (a direct client-side websocket, not proxied
--    through our backend) has had zero table access until now.
--
-- 2. Granting anon a broad "select all order_items" policy would leak
--    EVERY business's live orders to anyone - a real privacy problem,
--    not a hypothetical one. So visibility is scoped to the exact same
--    legitimacy check the backend's own getBill/computeBillContext
--    already performs: the item's order must belong to a card that had
--    a genuinely recent NFC tap (same 30-minute window as
--    TAP_TOKEN_VALID_MINUTES in publicController.js). A stranger without
--    a real, current tap on that exact table sees nothing.
-- =========================================================================

-- security definer so the existence check itself isn't blocked by RLS on
-- orders/events (anon has no policy on either) - the function is the
-- ONLY thing allowed to peek across those tables; callers still only
-- ever get a plain true/false back, never row data.
create or replace function public.order_item_is_publicly_visible(p_order_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.orders o
    join public.events e on e.card_id = o.card_id and e.type = 'nfc_tap'
    where o.id = p_order_id
      and o.request_type = 'order'
      and o.voided = false
      and e.created_at > now() - interval '30 minutes'
  );
$$;

create policy "anon can read recently-tapped order items"
  on public.order_items for select
  to anon
  using (public.order_item_is_publicly_visible(order_items.order_id));

-- Note: order_items was already added to the supabase_realtime
-- publication back in migration 0006 - it just had no anon SELECT
-- policy until now, so nothing was actually reachable by an anonymous
-- customer connection. No publication change needed here.
