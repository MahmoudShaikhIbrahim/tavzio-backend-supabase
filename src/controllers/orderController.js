const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/orders?status=
const listOrders = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/orders/:orderId
// Body: { status: 'pending'|'preparing'|'ready'|'completed'|'cancelled' }
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const { data, error } = await req.supabase
    .from('orders')
    .update({ status })
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

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'void_order',
    targetId: order.id,
    details: { table: order.table_label, reason: reason || '' },
  });

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

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'void_item',
    targetId: item.id,
    details: { itemName: item.item_name, orderId: req.params.orderId },
  });

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

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'void_order',
    targetId: cardId,
    details: { clearedTable: true, orderIds: affectedOrderIds },
  });

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

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'staff_order_placed',
    targetId: order.id,
    details: { table: card.label, itemCount: orderItemRows.length, total },
  });

  res.status(201).json({ order, items: orderItemRows });
});

module.exports = { listOrders, updateOrderStatus, voidOrder, voidOrderItem, clearTable, placeStaffOrder };
