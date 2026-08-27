const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/public/demo/menu
// No auth, no business context - the whole point of the demo is that a
// visitor from a marketing video needs zero setup to try it.
const getDemoMenu = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('demo_menu_items')
    .select('id, name, description, price_aed, image_url, category, sort_order')
    .eq('enabled', true)
    .order('category')
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/public/demo/orders
// Body: { sessionId: string, items: [{ menuItemId: string, quantity: number }] }
// sessionId is a random id the demo page generates once and keeps in
// localStorage - not tied to any account or real business, purely what
// scopes "my order" vs "someone else demoing this at the same time" on
// the kitchen display panel.
const placeDemoOrder = asyncHandler(async (req, res) => {
  const { sessionId, items } = req.body;
  if (!sessionId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'sessionId and at least one item are required' });
  }

  const menuItemIds = items.map((i) => i.menuItemId);
  const { data: menuItems } = await supabaseAdmin
    .from('demo_menu_items')
    .select('id, name, price_aed')
    .in('id', menuItemIds);
  const menuItemMap = new Map((menuItems || []).map((m) => [m.id, m]));

  const { data: order, error: orderError } = await supabaseAdmin
    .from('demo_orders')
    .insert({ session_id: sessionId, status: 'pending' })
    .select()
    .single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  // Name/price are snapshotted at order time - same reasoning as every
  // real order in this schema (menu_items.name/price can change later;
  // an already-placed order must never silently reflect that).
  const lineItems = items
    .map((i) => {
      const menuItem = menuItemMap.get(i.menuItemId);
      if (!menuItem) return null;
      return {
        demo_order_id: order.id,
        demo_menu_item_id: menuItem.id,
        name_snapshot: menuItem.name,
        price_aed_snapshot: menuItem.price_aed,
        quantity: Math.max(1, Number(i.quantity) || 1),
      };
    })
    .filter(Boolean);

  if (lineItems.length === 0) {
    await supabaseAdmin.from('demo_orders').delete().eq('id', order.id);
    return res.status(400).json({ message: 'None of the requested items exist' });
  }

  const { error: itemsError } = await supabaseAdmin.from('demo_order_items').insert(lineItems);
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  res.status(201).json({ id: order.id, status: order.status });
});

// @route GET /api/public/demo/orders?sessionId=...
// Powers both "my orders" on the ordering panel and the kitchen display
// panel - same visitor, same session, watching their own order appear
// on the other side of the same screen. Scoped to sessionId so two
// people demoing simultaneously never see each other's fake orders.
const getDemoOrders = asyncHandler(async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ message: 'sessionId is required' });

  const { data, error } = await supabaseAdmin
    .from('demo_orders')
    .select('id, status, created_at, demo_order_items(id, name_snapshot, price_aed_snapshot, quantity)')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/public/demo/orders/:orderId/ready
// The kitchen-display side of the demo needs a "Mark ready" action too
// (mirrors the real Kitchen tab), so the loop is genuinely two-way, not
// just order-in/nothing-out.
const markDemoOrderReady = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('demo_orders')
    .update({ status: 'ready' })
    .eq('id', req.params.orderId)
    .eq('status', 'pending')
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Order not found' });
  res.json(data);
});

// @route POST /api/public/demo/orders/:orderId/pay
// Confirmed requirement: Pay Bill must be part of the demo experience.
// This is a genuine simulation, not a real charge - there is no real
// business or payment gateway behind a demo order, so "paying" here
// means marking the fake order paid, nothing more. Never wired to
// Stripe/Tap/any real gateway - a demo visitor's card details, if they
// were ever asked for any (they aren't), would have nowhere legitimate
// to go.
const payDemoOrder = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('demo_orders')
    .update({ status: 'paid' })
    .eq('id', req.params.orderId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Order not found' });
  res.json(data);
});

// @route GET /api/public/demo/settings
// The real business identity for the demo phone - name and cover photo,
// managed by super_admin (see demoAdminController.js), not hardcoded.
const getDemoSettings = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('demo_settings').select('business_name, cover_image_url').eq('id', 1).single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/public/demo/requests
// Body: { sessionId, type: 'call_waiter' | 'request_bill' }
// The real notification flow the demo was missing - mirrors the actual
// product's Requests feature, not a simulated toast with nothing behind
// it. Same sessionId scoping as demo_orders, so two people demoing at
// once never see each other's fake requests.
const createDemoRequest = asyncHandler(async (req, res) => {
  const { sessionId, type } = req.body;
  if (!sessionId || !['call_waiter', 'request_bill'].includes(type)) {
    return res.status(400).json({ message: 'sessionId and a valid type are required' });
  }
  const { data, error } = await supabaseAdmin.from('demo_requests').insert({ session_id: sessionId, type }).select().single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route GET /api/public/demo/requests?sessionId=...
const getDemoRequests = asyncHandler(async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ message: 'sessionId is required' });
  const { data, error } = await supabaseAdmin
    .from('demo_requests')
    .select('id, type, status, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/public/demo/requests/:requestId/acknowledge
const acknowledgeDemoRequest = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('demo_requests')
    .update({ status: 'acknowledged' })
    .eq('id', req.params.requestId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Request not found' });
  res.json(data);
});

module.exports = { getDemoMenu, placeDemoOrder, getDemoOrders, markDemoOrderReady, payDemoOrder, getDemoSettings, createDemoRequest, getDemoRequests, acknowledgeDemoRequest };
