const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { maybeAutoCloseTable } = require('../utils/tableAutoClose');
const { calculateVatInclusive } = require('../utils/vat');
const { decryptConfig } = require('../utils/credentialEncryption');
const { primaryClientUrl } = require('../utils/clientUrl');
const { printKitchenTickets } = require('../utils/kitchenTicketPrinter');

// @route GET /api/businesses/:businessId/orders?status=
// Only real food orders - call_waiter/request_bill quick requests are
// NOT orders in any meaningful sense (no items, no kitchen prep, no
// "mark preparing" workflow) and have their own listRequests endpoint.
const listOrders = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('orders')
    // Station joined live from the current menu (not snapshotted at order
    // time, unlike item_name/price) - deliberately: if an owner moves
    // "Burger" from Grill to a new station, every ticket should route to
    // where it's actually being made today, not wherever it was made when
    // the order happened to be placed.
    .select('*, order_items(*, menu_items(station))')
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

  // Flatten the joined station onto each item so the frontend doesn't
  // need to know about the nested menu_items relation at all.
  const orders = (data || []).map((o) => ({
    ...o,
    order_items: (o.order_items || []).map((i) => ({ ...i, station: i.menu_items?.station || '', menu_items: undefined })),
  }));
  res.json(orders);
});

// @route GET /api/businesses/:businessId/requests
// Call Waiter / Request Bill pings - a lightweight, separate feed, never
// mixed into the kitchen's order queue. Only ever pending or completed
// (dismissed) - never goes through preparing/ready/cancelled.
const listRequests = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('orders')
    .select('id, table_label, request_type, custom_request_label, target_section, status, created_at')
    .eq('business_id', req.params.businessId)
    .neq('request_type', 'order')
    .eq('voided', false)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(400).json({ message: error.message });

  // Real fix for a confirmed dead end: hotel guest portal submissions
  // (transportation, laundry, pool, reception messages, feedback, and
  // any other non-housekeeping/maintenance request) are written to
  // guest_service_requests, a table this page never queried. Staff had
  // no way to ever see them - not a UI gap, a genuine black hole for
  // real guest requests. Normalized into the same RequestRow shape the
  // frontend already renders, so no frontend change was needed beyond
  // this merge.
  const { data: guestRequests, error: guestError } = await req.supabase
    .from('guest_service_requests')
    .select('id, room_id, request_type, note, status, created_at, target_section, hotel_rooms(room_number)')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (guestError) return res.status(400).json({ message: guestError.message });

  const normalizedGuestRequests = (guestRequests || []).map((r) => ({
    // Prefixed so dismissRequest can tell which table an id belongs to
    // without a second lookup - orders ids are never prefixed, so this
    // never collides with a real orders.id.
    id: `gsr:${r.id}`,
    table_label: r.hotel_rooms?.room_number ? `Room ${r.hotel_rooms.room_number}` : 'Front Desk',
    request_type: 'custom',
    custom_request_label: `${r.request_type.replace(/_/g, ' ')}${r.note ? ' - ' + r.note : ''}`,
    target_section: r.target_section,
    // guest_service_requests uses 'done'; orders uses 'completed' - the
    // frontend's active/completed filter only knows 'completed', so this
    // is normalized here rather than teaching the frontend a second
    // status vocabulary for the same concept.
    status: r.status === 'done' ? 'completed' : r.status,
    created_at: r.created_at,
  }));

  const combined = [...(data || []), ...normalizedGuestRequests]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);

  // Section filtering happens here, not in the query itself, since a
  // request with no target_section (NULL) must stay visible to
  // everyone with Requests access - that's the deliberate backward-
  // compatible default (see migration 0057), and it's simpler to
  // express as "keep if unrestricted OR section matches" in code than
  // in a single SQL clause covering both a NULL request and a NULL
  // staff restriction correctly.
  const assignedSections = req.user.assigned_sections;
  const visible = Array.isArray(assignedSections)
    ? combined.filter((r) => !r.target_section || assignedSections.includes(r.target_section))
    : combined; // unrestricted staff (or owner) sees everything

  res.json(visible);
});

// @route PATCH /api/businesses/:businessId/requests/:requestId/dismiss
// The only action a Call Waiter/Request Bill ping needs - no food-order
// lifecycle applies to it. Also handles guest_service_requests rows
// (prefixed "gsr:" by listRequests above) so the same Dismiss button
// works regardless of which table a request actually lives in.
const dismissRequest = asyncHandler(async (req, res) => {
  if (req.params.requestId.startsWith('gsr:')) {
    const realId = req.params.requestId.slice(4);
    const { data, error } = await req.supabase
      .from('guest_service_requests')
      .update({ status: 'done', resolved_at: new Date().toISOString() })
      .eq('id', realId)
      .eq('business_id', req.params.businessId)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ message: 'Request not found' });
    return res.json({ ...data, id: req.params.requestId, status: 'completed' });
  }

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
  const allowed = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const update = { status };
  // Fires the "Table X's order is ready" notification on the Orders page
  // - reset every time an order goes ready, including a second time if
  // it somehow moves back to pending and ready again.
  if (status === 'ready') { update.ready_ack = false; update.ready_at = new Date().toISOString(); }
  // Timing captured for the kitchen performance report - only stamped
  // the first time a ticket starts, never overwritten by a later status
  // change back through 'preparing' (an order shouldn't look like it
  // "started" twice just because it was corrected).
  if (status === 'preparing') update.prep_started_at = new Date().toISOString();

  let query = req.supabase.from('orders').update(update).eq('id', req.params.orderId).eq('business_id', req.params.businessId);
  if (status === 'preparing') query = query.is('prep_started_at', null);
  const { data, error } = await query.select().single();

  if (error || !data) {
    // The .is('prep_started_at', null) guard above means "no row updated"
    // can also just mean this ticket already started - not a real error,
    // so fetch and return it as-is rather than reporting a false failure.
    if (status === 'preparing') {
      const { data: existing } = await req.supabase.from('orders').select('*').eq('id', req.params.orderId).eq('business_id', req.params.businessId).single();
      if (existing) return res.json(existing);
    }
    return res.status(404).json({ message: 'Order not found' });
  }
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

  // Real fix for a confirmed bug: this order's own stored total was
  // never recalculated after voiding just one item out of several -
  // it kept reflecting the pre-void amount even though the voided
  // item correctly disappeared from every item list that filters on
  // voided=false, causing the table's displayed total to silently
  // include money for an item nobody could even see anymore.
  const { data: siblings } = await supabaseAdmin
    .from('order_items')
    .select('unit_price, addon_total, quantity, paid, voided')
    .eq('order_id', req.params.orderId);
  const { data: orderRow } = await supabaseAdmin.from('orders').select('discount_amount_aed').eq('id', req.params.orderId).single();
  const liveItems = (siblings || []).filter((i) => !i.voided);
  const newSubtotal = liveItems.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);
  const recalculatedTotal = Math.max(0, newSubtotal - Number(orderRow?.discount_amount_aed || 0));
  await supabaseAdmin.from('orders').update({ total: recalculatedTotal }).eq('id', req.params.orderId);

  // If that was the last live item on this order (everything else is
  // either already paid or already voided too), the order itself is now
  // an empty shell with nothing left to deliver or collect. Without this,
  // it used to sit on the Orders page forever showing "All items deleted"
  // with no way to make it go away - Clear table's own "nothing
  // outstanding" check treated it the same as a fully-paid order and
  // silently skipped it every time.
  const stillHasLiveItems = liveItems.some((i) => !i.paid);
  const hasAnyPaidItems = (siblings || []).some((i) => i.paid);
  if (!stillHasLiveItems && !hasAnyPaidItems) {
    await supabaseAdmin.from('orders').update({ voided: true }).eq('id', req.params.orderId);
  }

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
    const hasPaidItems = order.order_items.some((i) => i.paid);
    // Skip only a genuinely fully-paid order - that one belongs to Mark
    // Completed, not Clear table. An order with nothing left because
    // every item was individually deleted (not paid) has no unpaid items
    // either, but it's not "done" - it's empty, and needs voiding here
    // too or it sits on the Orders page forever with no way to clear it.
    if (!hasUnpaidUnvoidedItems && hasPaidItems) continue;

    affectedOrderIds.push(order.id);
    if (hasUnpaidUnvoidedItems) {
      await req.supabase
        .from('order_items')
        .update({ voided: true })
        .eq('order_id', order.id)
        .eq('paid', false);
    }
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
      source: 'staff_pos',
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

// @route POST /api/businesses/:businessId/pos/orders
// Body: { tableLabel, items, note, paymentMethod }
// A genuine walk-in/phone/takeaway order - no NFC tap, no existing card
// at all. This is the actual POS terminal entry point: staff builds the
// cart and charges it right there, same real-time transaction a
// physical till handles. Unlike a tap-placed order (which starts
// unpaid and gets settled later), a POS order is paid the moment it's
// created - the staff member is standing at the counter collecting the
// money in the same motion as ringing it up.
const ORDER_TYPE_LABELS = { dine_in: 'Dine-in', walk_in: 'Walk-in', pickup: 'Pickup', delivery: 'Delivery' };

const createPosOrder = asyncHandler(async (req, res) => {
  const { orderType = 'walk_in', items, note = '', chargeToFolioId, discountType, discountValue, discountReason, tableId } = req.body;
  let { tableLabel } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required' });
  }
  if (!Object.keys(ORDER_TYPE_LABELS).includes(orderType)) {
    return res.status(400).json({ message: 'orderType must be dine_in, walk_in, pickup, or delivery' });
  }
  if (discountType && !['percentage', 'fixed'].includes(discountType)) {
    return res.status(400).json({ message: 'discountType must be percentage or fixed' });
  }
  // A discount always needs a reason on record - this is what turns "the
  // owner comps a regular a free coffee" from an invisible cash-drawer
  // discrepancy into something accountable and auditable. A 100% comp is
  // just a percentage discount of 100, so this same mechanism covers both.
  if (discountType && !discountReason?.trim()) {
    return res.status(400).json({ message: 'A reason is required when applying a discount or comp' });
  }
  if (chargeToFolioId) {
    const { data: folio } = await req.supabase.from('hotel_folios').select('status').eq('id', chargeToFolioId).eq('business_id', req.params.businessId).single();
    if (!folio) return res.status(404).json({ message: 'Folio not found' });
    if (folio.status === 'closed') return res.status(400).json({ message: 'This folio is closed - cannot charge to it' });
  }

  // Real fix: tableId now refers to the real, independent table entity,
  // not a card directly - a table can genuinely have no card connected
  // yet (freshly created, or its old card was lost and hasn't been
  // replaced), and the order still needs to work correctly either way,
  // just without a card_id yet. Once a card IS connected later, that's
  // handled by the connect-card endpoint updating the card itself, not
  // by anything here.
  let resolvedCardId = null;
  if (orderType === 'dine_in' && tableId) {
    const { data: table } = await req.supabase
      .from('tables')
      .select('id, label, cards(id, status, linked_user_id)')
      .eq('id', tableId)
      .eq('business_id', req.params.businessId)
      .maybeSingle();
    if (!table) return res.status(404).json({ message: 'That table was not found for this business' });
    const card = table.cards?.[0];
    if (card && !card.linked_user_id && card.status === 'active') resolvedCardId = card.id;
    if (!tableLabel?.trim()) tableLabel = table.label;
  }

  // Real fix for the grouping-collision bug: if the client left the
  // label blank (the normal case for walk-in/pickup/delivery - there's
  // no real table number to type), auto-number it server-side against
  // today's actual count for this exact type+business, so two orders
  // never land on the identical label - and this stays correct even
  // with several POS terminals ringing up orders on the same business
  // at the same time, which a client-side counter could never guarantee.
  if (!tableLabel || !tableLabel.trim()) {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { count } = await req.supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', req.params.businessId)
      .eq('order_type', orderType)
      .gte('created_at', startOfDay.toISOString());
    tableLabel = `${ORDER_TYPE_LABELS[orderType]} #${(count || 0) + 1}`;
  }

  const { data: business } = await req.supabase.from('businesses').select('features, category').eq('id', req.params.businessId).single();

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
    // A course left blank fires immediately, exactly like today - this
    // is purely opt-in. Assigning a course (Starter/Main/Dessert) holds
    // it back from the kitchen until a server explicitly fires that
    // course via POST /orders/:orderId/fire-course, the standard
    // full-service pattern of not sending mains until starters are cleared.
    const course = (i.course || '').trim();
    return {
      menu_item_id: menuItem.id,
      item_name: menuItem.name,
      unit_price: menuItem.price,
      quantity: Math.max(1, Number(i.quantity) || 1),
      note: i.note || '',
      addons: selectedAddons.map((a) => ({ name: a.name, price: a.price })),
      addon_total: addonTotal,
      // card_online stays unpaid until the gateway actually confirms it
      // Real fix: Send to Kitchen and Payment are separate actions now
      // (a dine-in table can sit open through the whole meal; a pickup
      // order can be paid on collection, well after being made) - items
      // are unpaid at creation, always, except chargeToFolioId, which
      // genuinely IS the settlement (charging to the guest's room),
      // not a placeholder for a tender choice made later.
      paid: !!chargeToFolioId,
      paid_at: chargeToFolioId ? new Date().toISOString() : null,
      course,
      course_status: course ? 'held' : 'fired',
      fired_at: course ? null : new Date().toISOString(),
    };
  });
  const subtotal = orderItemRows.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);
  let discountAmount = 0;
  if (discountType === 'percentage') {
    discountAmount = Math.round(subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100) * 100) / 100;
  } else if (discountType === 'fixed') {
    discountAmount = Math.min(subtotal, Math.max(0, Number(discountValue) || 0));
  }
  const total = Math.max(0, subtotal - discountAmount);

  // Same inventory check every other order path already has - a POS
  // terminal is not exempt from "can the kitchen actually make this".
  if (business?.features?.inventory?.enabled) {
    const { checkStockAvailability } = require('../utils/inventoryStock');
    const stockCheck = await checkStockAvailability({ orderItemRows });
    if (!stockCheck.ok && business.features.inventory.blockOrdersOnLowStock !== false) {
      return res.status(400).json({ message: stockCheck.message });
    }
  }

  // Real fix, consequence of Send to Kitchen and Payment being separate
  // actions now: which till gets credit for cash is decided at Payment
  // time (see recordPayment), not here - payment method isn't even
  // known yet at this point, an order can sit open for a while before
  // anyone chooses a tender. What's STILL required here, hotel-only: an
  // open till is how an order gets tagged with which outlet it came
  // from - a till is locked to one outlet for its whole session, the
  // real, unspoofable source of truth (never taken from client input
  // directly). That's an outlet-identity fact, unrelated to payment
  // timing, so it stays a creation-time requirement for hotels only.
  let tillSessionId = null;
  let hotelOutletId = null;
  if (business?.category === 'hotel') {
    const { data: till } = await req.supabase
      .from('till_sessions')
      .select('id, outlet_id')
      .eq('staff_id', req.user.id)
      .eq('status', 'open')
      .maybeSingle();
    if (!till) {
      return res.status(400).json({ message: 'Open a till for your outlet before taking an order' });
    }
    tillSessionId = till.id;
    hotelOutletId = till.outlet_id;
  }

  const { data: order, error: orderError } = await req.supabase
    .from('orders')
    .insert({
      business_id: req.params.businessId,
      card_id: resolvedCardId,
      table_label: tableLabel,
      order_type: orderType,
      note,
      total,
      status: 'pending',
      source: 'staff_pos',
      payment_method: chargeToFolioId ? 'other' : null,
      till_session_id: tillSessionId,
      hotel_outlet_id: hotelOutletId,
      placed_by: req.user.id,
      charged_to_folio_id: chargeToFolioId || null,
      discount_type: discountType || null,
      discount_value: discountType ? Number(discountValue) || 0 : 0,
      discount_amount_aed: discountAmount,
      discount_reason: discountType ? discountReason.trim() : '',
      discounted_by: discountType ? req.user.id : null,
    })
    .select()
    .single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  if (chargeToFolioId) {
    await req.supabase.from('hotel_folio_charges').insert({
      folio_id: chargeToFolioId,
      description: `${tableLabel} - F&B order (${items.length} item${items.length === 1 ? '' : 's'})`,
      amount_aed: total,
      charge_type: 'fnb',
      source_order_id: order.id,
    });
  }

  const { data: insertedItems, error: itemsError } = await req.supabase
    .from('order_items')
    .insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })))
    .select();
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  if (business?.features?.inventory?.enabled) {
    const { deductStock } = require('../utils/inventoryStock');
    deductStock({ businessId: req.params.businessId, orderItemRows: insertedItems, orderId: order.id }).catch(() => {});
  }

  // Real KOT printing - only items firing immediately (course_status
  // 'fired'); anything held for a later course prints when fireCourse
  // actually releases it, not here. Never awaited/blocking - a slow or
  // offline printer should never delay the kitchen screen or the
  // response to the terminal.
  const firedItems = insertedItems
    .filter((i) => i.course_status === 'fired')
    .map((i) => ({ ...i, station: menuItemsById[i.menu_item_id]?.station || '' }));
  if (firedItems.length > 0) {
    printKitchenTickets(req.params.businessId, { tableLabel, note, orderType, items: firedItems }).catch(() => {});
  }

  // No payments insert here anymore - Send to Kitchen no longer settles
  // anything by itself (see recordPayment below for where that real
  // ledger entry now gets created, at actual settlement time). The one
  // exception, chargeToFolioId, already has its own real ledger via the
  // hotel_folio_charges insert above - charging to a room genuinely is
  // the settlement, not a placeholder for a tender choice made later.

  if (business?.features?.ordering?.posIntegration) {
    const { data: integration } = await supabaseAdmin
      .from('pos_integrations')
      .select('*')
      .eq('business_id', req.params.businessId)
      .eq('purpose', 'ordering')
      .eq('enabled', true)
      .maybeSingle();
    if (integration) {
      const { pushOrderToPos } = require('../utils/posDispatcher');
      pushOrderToPos(integration.provider, decryptConfig(integration.config), order, insertedItems).catch(() => {});
    }
  }

  res.status(201).json({ order, items: insertedItems, vatBreakdown: calculateVatInclusive(order.total) });
});

// @route POST /api/businesses/:businessId/orders/:orderId/manual-payment
// Body: { itemIds: string[], tenders: [{ method: 'cash'|'card', amount: number }], pin: string }
// The one real settlement action for anything that didn't go through a
// live Tavzio gateway - a restaurant's own card machine, or cash. Lives
// as ordinary rows in the same `payments` table as online Pay Bill
// transactions, distinguished only by provider ('pos_cash' /
// 'pos_card'). Shared by both POS Terminal (paying right after Send to
// Kitchen) and Orders (paying an order that's been sitting open for a
// while, possibly rung up by a different staff member's shift) -
// deliberately the same function either way, so the security guarantees
// (PIN, real tender records, real audit trail) never depend on which
// screen it was opened from.
//
// Real multi-tender: tenders is an array, not a single method - a bill
// can be split cash+card in one settlement, one payments row per
// tender actually used. PIN is re-verified HERE, not trusted from an
// earlier /pin/verify call - closes the gap a "verify now, act later"
// flow would leave open between confirming identity and moving real
// money into the ledger.
const recordManualPayment = asyncHandler(async (req, res) => {
  const { itemIds, tenders, pin } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ message: 'No items selected' });
  }
  if (!Array.isArray(tenders) || tenders.length === 0) {
    return res.status(400).json({ message: 'At least one tender (cash or card) is required' });
  }
  for (const tender of tenders) {
    if (!['cash', 'card'].includes(tender.method) || !(Number(tender.amount) > 0)) {
      return res.status(400).json({ message: 'Each tender needs a valid method (cash or card) and a positive amount' });
    }
  }

  const { checkPin } = require('./pinController');
  const pinResult = await checkPin(req.user.id, pin);
  if (!pinResult.ok) return res.status(pinResult.status).json({ message: pinResult.message });

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

  const amountOwed = selectedItems.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  const tenderTotal = tenders.reduce((sum, t) => sum + Number(t.amount), 0);
  // 1 fils tolerance for float rounding - not a loophole, just the same
  // allowance any real cash drawer math needs.
  if (Math.abs(tenderTotal - amountOwed) > 0.01) {
    return res.status(400).json({ message: `Tenders total AED ${tenderTotal.toFixed(2)} but AED ${amountOwed.toFixed(2)} is owed` });
  }
  const settledIds = selectedItems.map((i) => i.id);

  // Cash needs a real open till to be attributed to - the till that's
  // open RIGHT NOW, at the moment this cash is actually being handed
  // over, not whichever till (if any) was open when the order was first
  // rung in. This is what makes closeTill's reconciliation correct even
  // when the order was created hours earlier or by someone else's shift.
  let tillSessionId = null;
  if (tenders.some((t) => t.method === 'cash')) {
    const { data: till } = await req.supabase
      .from('till_sessions')
      .select('id')
      .eq('staff_id', req.user.id)
      .eq('status', 'open')
      .maybeSingle();
    if (!till) return res.status(400).json({ message: 'Open a till before recording a cash payment' });
    tillSessionId = till.id;
  }

  // supabaseAdmin here deliberately - payments has no authenticated
  // insert policy at all (every existing write path is service-role,
  // matching the online-payment flows), so a manual settlement has to
  // go through it too. Tenant safety already happened above via
  // req.supabase - this write is scoped to exactly the items just
  // verified to belong to this business's order. One row per tender
  // actually used, not one row for the whole bill, so a split
  // cash+card payment shows up as two real, separately-attributable
  // ledger entries instead of one row hiding a mixed amount.
  const paymentRows = tenders.map((t) => ({
    business_id: req.params.businessId,
    card_id: order.card_id,
    order_item_ids: settledIds,
    amount: Number(t.amount),
    tip_amount: 0,
    status: 'completed',
    provider: `pos_${t.method}`,
    provider_ref: '',
    recorded_by: req.user.id,
    till_session_id: t.method === 'cash' ? tillSessionId : null,
  }));
  const { error: paymentError } = await supabaseAdmin.from('payments').insert(paymentRows);
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
      integration = data ? { ...data, config: decryptConfig(data.config) } : data;
    }

    await supabaseAdmin
      .from('orders')
      .update({ status: 'pending', pos_sync_status: integration ? 'pending' : 'not_applicable' })
      .eq('id', order.id);

    if (business?.features?.inventory?.enabled) {
      const { deductStock } = require('../utils/inventoryStock');
      deductStock({ businessId: req.params.businessId, orderItemRows: order.order_items, orderId: order.id }).catch(() => {});
    }

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
    details: { tenders, amount: amountOwed, itemCount: settledIds.length },
  });

  res.status(201).json({ amount: amountOwed, itemCount: settledIds.length, tenders });
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

// @route POST /api/businesses/:businessId/orders/:orderId/fire-course
// Body: { course }
// Releases every held item of that course on this order to the kitchen
// in one motion - the actual server action ("fire the mains") that
// makes course holding useful instead of just a label.
const fireCourse = asyncHandler(async (req, res) => {
  const { course } = req.body;
  if (!course) return res.status(400).json({ message: 'course is required' });

  const { data, error } = await req.supabase
    .from('order_items')
    .update({ course_status: 'fired', fired_at: new Date().toISOString() })
    .eq('order_id', req.params.orderId)
    .eq('course', course)
    .eq('course_status', 'held')
    .select('*, menu_items(station)');
  if (error) return res.status(400).json({ message: error.message });
  if (!data || data.length === 0) return res.status(404).json({ message: 'No held items found for that course' });

  // Real KOT printing for exactly what just fired - a held course's
  // items were deliberately not printed at order-creation time (see
  // createPosOrder), this is the actual moment they're supposed to
  // reach the kitchen.
  const { data: order } = await req.supabase.from('orders').select('table_label, note, order_type').eq('id', req.params.orderId).single();
  if (order) {
    const printableItems = data.map((i) => ({ ...i, station: i.menu_items?.station || '' }));
    printKitchenTickets(req.params.businessId, { tableLabel: order.table_label, note: order.note, orderType: order.order_type, items: printableItems }).catch(() => {});
  }

  res.json({ message: `Fired ${data.length} item(s)`, items: data });
});

// @route PATCH /api/businesses/:businessId/orders/:orderId/assign-table
// Real fix for the confirmed request: a walk-in customer who decides to
// sit down, or a dine-in party that moved tables, needs a way to attach
// (or re-attach) an existing order to a real table card - without this,
// staff would have to void the order and recreate it from scratch just
// to change which table it belongs to. Same strict validation as order
// creation: a real, active, non-admin card belonging to this business,
// never accepted unvalidated.
const assignTable = asyncHandler(async (req, res) => {
  const { tableId } = req.body;
  if (!tableId) return res.status(400).json({ message: 'tableId is required' });

  const { data: table } = await req.supabase
    .from('tables')
    .select('id, label, cards(id, status, linked_user_id)')
    .eq('id', tableId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!table) return res.status(404).json({ message: 'That table was not found for this business' });
  const card = table.cards?.[0];
  const resolvedCardId = card && !card.linked_user_id && card.status === 'active' ? card.id : null;

  const { data: order, error } = await req.supabase
    .from('orders')
    .update({ order_type: 'dine_in', card_id: resolvedCardId, table_label: table.label })
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !order) return res.status(404).json({ message: 'Order not found' });
  res.json(order);
});

module.exports = { listOrders, updateOrderStatus, voidOrder, voidOrderItem, clearTable, placeStaffOrder, createPosOrder, listRequests, dismissRequest, recordManualPayment, listCashPendingItems, ackOrderReady, fireCourse, assignTable };
