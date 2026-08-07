const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { maybeAutoCloseTable } = require('../utils/tableAutoClose');

// @route GET /api/businesses/:businessId/orders?status=
// Only real food orders - call_waiter/request_bill quick requests are
// NOT orders in any meaningful sense (no items, no kitchen prep, no
// "mark preparing" workflow) and have their own listRequests endpoint.
const listOrders = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    // A pay-before-order order sitting in awaiting_payment hasn't been
    // paid for (or is mid-checkout) yet - it was never "sent", so it
    // never appears here, exactly like an unpaid Starbucks order never
    // reaches the barista.
    .neq('status', 'awaiting_payment')
    .order('created_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/requests
// Call Waiter / Request Bill pings - a lightweight, separate feed, never
// mixed into the kitchen's order queue. Only ever pending or completed
// (dismissed) - never goes through preparing/ready/cancelled.
const listRequests = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('orders')
    .select('id, table_label, request_type, status, created_at')
    .eq('business_id', req.params.businessId)
    .neq('request_type', 'order')
    .eq('voided', false)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/requests/:requestId/dismiss
// The only action a Call Waiter/Request Bill ping needs - no food-order
// lifecycle applies to it.
const dismissRequest = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('orders')
    .update({ status: 'completed' })
    .eq('id', req.params.requestId)
    .eq('business_id', req.params.businessId)
    .neq('request_type', 'order')
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Request not found' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/orders/:orderId
// Body: { status: 'pending'|'ready'|'completed'|'cancelled' }
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'ready', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const update = { status };
  // Fires the "Table X's order is ready" notification on the Orders page
  // - reset every time an order goes ready, including a second time if
  // it somehow moves back to pending and ready again.
  if (status === 'ready') update.ready_ack = false;

  const { data, error } = await req.supabase
    .from('orders')
    .update(update)
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Order not found' });
  res.json(data);
});

// @route POST /api/businesses/:businessId/orders/:orderId/ready-ack
// Marks the "this order is ready" notification as seen on the Orders
// page - deliberately does NOT touch the order's own status. Same
// principle as dismissing any other request: acknowledging it is a
// separate fact from resolving it.
const ackOrderReady = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('orders')
    .update({ ready_ack: true })
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Order not found' });
  res.json(data);
});

// @route POST /api/businesses/:businessId/orders/:orderId/void
// Voids an entire order (all its items) - the "this whole order is stray
// leftover from a previous customer" case. Body: { reason? }
const voidOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const { data: order, error } = await req.supabase
    .from('orders')
    .update({ voided: true, voided_by: req.user.id, voided_at: new Date().toISOString(), void_reason: reason || '' })
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !order) return res.status(404).json({ message: 'Order not found' });

  await req.supabase.from('order_items').update({ voided: true }).eq('order_id', order.id);

  res.json(order);
});

// @route POST /api/businesses/:businessId/orders/:orderId/items/:itemId/void
// Voids exactly one item within an order, leaving everything else on that
// order (including a different customer's own genuine order) untouched -
// the precise fix for "a new customer's order got mixed with a stray one."
const voidOrderItem = asyncHandler(async (req, res) => {
  const { data: item, error } = await req.supabase
    .from('order_items')
    .update({ voided: true })
    .eq('id', req.params.itemId)
    .eq('order_id', req.params.orderId)
    .select()
    .single();
  if (error || !item) return res.status(404).json({ message: 'Item not found' });

  res.json(item);
});

// @route POST /api/businesses/:businessId/orders/clear-table
// Body: { cardId }
// Voids everything currently unpaid, non-voided at this table in one
// action - the actual "Clear table" button. Same underlying mechanism as
// voidOrder, just applied to every affected order at once, in a single
// audit entry rather than one per order.
const clearTable = asyncHandler(async (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ message: 'cardId is required' });

  const { data: orders } = await req.supabase
    .from('orders')
    .select('id, order_items(id, paid, voided)')
    .eq('business_id', req.params.businessId)
    .eq('card_id', cardId)
    .eq('voided', false);

  const affectedOrderIds = [];
  for (const order of orders || []) {
    const hasUnpaidUnvoidedItems = order.order_items.some((i) => !i.paid && !i.voided);
    if (!hasUnpaidUnvoidedItems) continue; // nothing outstanding on this order, leave it alone

    affectedOrderIds.push(order.id);
    await req.supabase
      .from('order_items')
      .update({ voided: true })
      .eq('order_id', order.id)
      .eq('paid', false);
  }

  if (affectedOrderIds.length > 0) {
    await req.supabase
      .from('orders')
      .update({ voided: true, voided_by: req.user.id, voided_at: new Date().toISOString(), void_reason: 'Table cleared' })
      .in('id', affectedOrderIds);
  }

  res.json({ message: 'Table cleared', clearedOrderIds: affectedOrderIds });
});

// @route POST /api/businesses/:businessId/orders/staff-place
// Staff placing an order on a customer's behalf - same menu/cart data
// shape as the public flow, but no tap needed since staff are already
// authenticated and picking the table directly.
// Body: { cardId, items: [{menuItemId, quantity, note, addonIds}], note }
const placeStaffOrder = asyncHandler(async (req, res) => {
  const { cardId, items, note } = req.body;
  if (!cardId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'cardId and at least one item are required' });
  }

  const { data: card } = await req.supabase.from('cards').select('id, label').eq('id', cardId).maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found' });

  const menuItemIds = items.map((i) => i.menuItemId);
  const { data: menuItems } = await req.supabase
    .from('menu_items')
    .select('id, name, price')
    .in('id', menuItemIds)
    .eq('business_id', req.params.businessId)
    .eq('is_available', true);
  if (!menuItems || menuItems.length !== menuItemIds.length) {
    return res.status(400).json({ message: 'One or more items are no longer available' });
  }
  const menuItemsById = Object.fromEntries(menuItems.map((m) => [m.id, m]));

  // Look up every requested add-on across all items in one query, same
  // never-trust-the-client pricing rule as the base item price.
  const allAddonIds = items.flatMap((i) => i.addonIds || []);
  let addonsById = {};
  if (allAddonIds.length > 0) {
    const { data: addons } = await req.supabase.from('menu_item_addons').select('id, name, price').in('id', allAddonIds);
    addonsById = Object.fromEntries((addons || []).map((a) => [a.id, a]));
  }

  const orderItemRows = items.map((i) => {
    const menuItem = menuItemsById[i.menuItemId];
    const selectedAddons = (i.addonIds || []).map((id) => addonsById[id]).filter(Boolean);
    const addonTotal = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
    return {
      menu_item_id: menuItem.id,
      item_name: menuItem.name,
      unit_price: menuItem.price,
      quantity: Math.max(1, Number(i.quantity) || 1),
      note: i.note || '',
      addons: selectedAddons.map((a) => ({ name: a.name, price: a.price })),
      addon_total: addonTotal,
    };
  });
  const total = orderItemRows.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);

  const { data: order, error: orderError } = await req.supabase
    .from('orders')
    .insert({
      business_id: req.params.businessId,
      card_id: card.id,
      table_label: card.label || '',
      note: note || '',
      total,
      placed_by_staff_id: req.user.id,
    })
    .select()
    .single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  const { error: itemsError } = await req.supabase
    .from('order_items')
    .insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })));
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  res.status(201).json({ order, items: orderItemRows });
});

// @route POST /api/businesses/:businessId/orders/:orderId/manual-payment
// Body: { itemIds: string[], method: 'card_machine' | 'cash' }
// Records money staff collected OUTSIDE Tavzio entirely (the restaurant's
// own card machine, or cash) - lives as an ordinary row in the same
// `payments` table as online Pay Bill transactions, distinguished only by
// provider ('manual_cash' / 'manual_card_machine'). This
// is the ONLY thing that ever marks an item paid when money didn't move
// through a Tavzio gateway - it can never be created without pointing at
// real, currently-unpaid items already on this order, by design: there is
// no path here that lets a payment exist disconnected from real items.
const recordManualPayment = asyncHandler(async (req, res) => {
  const { itemIds, method } = req.body;
  const allowedMethods = ['card_machine', 'cash'];
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ message: 'No items selected' });
  }
  if (!allowedMethods.includes(method)) {
    return res.status(400).json({ message: 'Invalid payment method' });
  }

  // Tenant-scoped lookup via req.supabase (RLS) confirms this order
  // genuinely belongs to this business before anything is written -
  // req.supabase, not supabaseAdmin, specifically so a staff member from
  // a different business could never settle someone else's order.
  const { data: order, error: orderError } = await req.supabase
    .from('orders')
    .select('id, status, card_id, order_items(*)')
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .single();
  if (orderError || !order) return res.status(404).json({ message: 'Order not found' });

  const unpaidItems = order.order_items.filter((i) => !i.paid && !i.voided);
  const selectedItems = unpaidItems.filter((i) => itemIds.includes(i.id));
  if (selectedItems.length === 0) {
    return res.status(400).json({ message: 'None of those items are unpaid on this order' });
  }

  const amount = selectedItems.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  const settledIds = selectedItems.map((i) => i.id);

  // supabaseAdmin here deliberately - payments has no authenticated
  // insert policy at all (every existing write path is service-role,
  // matching the online-payment flows), so a manual settlement has to
  // go through it too. Tenant safety already happened above via
  // req.supabase - this write is scoped to exactly the items just
  // verified to belong to this business's order.
  const { error: paymentError } = await supabaseAdmin.from('payments').insert({
    business_id: req.params.businessId,
    card_id: order.card_id,
    order_item_ids: settledIds,
    amount,
    tip_amount: 0,
    status: 'completed',
    provider: `manual_${method}`,
    provider_ref: '',
    recorded_by: req.user.id,
  });
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  await supabaseAdmin
    .from('order_items')
    .update({ paid: true, cash_pending: false, paid_at: new Date().toISOString() })
    .in('id', settledIds);

  // Pay-before-order cash flow: this order was never sent to the kitchen
  // (sitting in awaiting_payment). Confirming the cash payment is the
  // moment it becomes real - same "pay at cashier, then get your order"
  // rule the feature was built around. A normal, already-placed order
  // (status already 'pending'/'ready'/etc) is untouched by this.
  if (order.status === 'awaiting_payment') {
    let integration = null;
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('features')
      .eq('id', req.params.businessId)
      .maybeSingle();
    if (business?.features?.ordering?.posIntegration) {
      const { data } = await supabaseAdmin
        .from('pos_integrations')
        .select('*')
        .eq('business_id', req.params.businessId)
        .eq('purpose', 'ordering')
        .eq('enabled', true)
        .maybeSingle();
      integration = data;
    }

    await supabaseAdmin
      .from('orders')
      .update({ status: 'pending', pos_sync_status: integration ? 'pending' : 'not_applicable' })
      .eq('id', order.id);

    if (integration) {
      const { pushOrderToPos } = require('../utils/posDispatcher');
      pushOrderToPos(integration.provider, integration.config, order, order.order_items)
        .then(async (result) => {
          await supabaseAdmin
            .from('orders')
            .update({
              pos_sync_status: result.success ? 'synced' : 'failed',
              pos_external_id: result.externalOrderId || '',
              pos_sync_error: result.error || '',
            })
            .eq('id', order.id);
        })
        .catch(() => {});
    }
  }

  await maybeAutoCloseTable(supabaseAdmin, req.params.businessId, order.card_id);

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'manual_payment_recorded',
    targetId: order.id,
    details: { method, amount, itemCount: settledIds.length },
  });

  res.status(201).json({ amount, itemCount: settledIds.length, method });
});

// @route GET /api/businesses/:businessId/orders/cash-pending
// Every item across every table currently flagged cash-pending by a
// customer, not yet confirmed received by staff. Lives right alongside
// Call Waiter/Request Bill on the Requests page - this is the same kind
// of thing ("someone needs a staff member's attention at a table"),
// customers just don't have a dedicated view for it the way this page
// gives Call Waiter its own feed.
const listCashPendingItems = asyncHandler(async (req, res) => {
  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('id, table_label, order_items(*)')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .eq('voided', false);
  if (error) return res.status(400).json({ message: error.message });

  const items = (orders || []).flatMap((o) =>
    o.order_items
      .filter((i) => i.cash_pending && !i.paid && !i.voided)
      .map((i) => ({ ...i, order_id: o.id, table_label: o.table_label }))
  );
  res.json(items);
});

module.exports = { listOrders, updateOrderStatus, voidOrder, voidOrderItem, clearTable, placeStaffOrder, listRequests, dismissRequest, recordManualPayment, listCashPendingItems, ackOrderReady };
