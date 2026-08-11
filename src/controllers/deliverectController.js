const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');

// =========================================================================
// Deliverect integration. Real, working code against Deliverect's actual
// documented webhook shape - but it can't receive a single real order
// until two things exist that don't yet: (1) a Deliverect partner
// account (their "become an integration partner" signup, reviewed on
// their end), and (2) the per-partner HMAC secret they issue once that
// integration goes live, which is what DELIVERECT_HMAC_SECRET below is
// waiting on. Until then, every call here safely rejects rather than
// pretending to succeed - same pattern as Stripe before real keys exist.
// =========================================================================

function verifyDeliverectSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// @route POST /api/deliverect/register
const registerPos = asyncHandler(async (req, res) => {
  const { locationId, externalLocationId } = req.body;
  if (!externalLocationId) return res.status(400).json({ message: 'externalLocationId is required' });

  const { data: integration } = await supabaseAdmin
    .from('delivery_integrations')
    .select('business_id')
    .eq('business_id', externalLocationId)
    .maybeSingle();
  if (!integration) return res.status(404).json({ message: 'Unknown location' });

  await supabaseAdmin
    .from('delivery_integrations')
    .update({ deliverect_location_id: locationId, enabled: true })
    .eq('business_id', externalLocationId);

  const base = process.env.API_BASE_URL || '';
  res.json({
    ordersWebhookURL: `${base}/api/deliverect/orders`,
    syncProductsURL: `${base}/api/deliverect/products`,
    syncTablesURL: `${base}/api/deliverect/tables`,
    syncFloorsURL: `${base}/api/deliverect/floors`,
  });
});

// @route POST /api/deliverect/orders
const receiveOrder = asyncHandler(async (req, res) => {
  const secret = process.env.DELIVERECT_HMAC_SECRET;
  const signature = req.headers['x-deliverect-hmac-sha256'] || req.headers['x-hmac-sha256'];
  if (!verifyDeliverectSignature(req.rawBody, signature, secret)) {
    return res.status(401).json({ message: 'Invalid or missing signature - Deliverect integration not fully configured yet' });
  }

  const payload = req.body;
  const externalLocationId = payload.location;
  const { data: integration } = await supabaseAdmin
    .from('delivery_integrations')
    .select('business_id')
    .eq('deliverect_location_id', externalLocationId)
    .eq('enabled', true)
    .maybeSingle();
  if (!integration) return res.status(404).json({ message: 'Unrecognized location' });

  const items = payload.items || [];
  const orderItemRows = items.map((item) => ({
    menu_item_id: null,
    item_name: item.plu ? `${item.name} (${item.plu})` : item.name,
    unit_price: (item.price || 0) / 100,
    quantity: item.quantity || 1,
    note: item.comment || '',
    addons: (item.subItems || []).map((s) => ({ name: s.name, price: (s.price || 0) / 100 })),
    addon_total: (item.subItems || []).reduce((sum, s) => sum + (s.price || 0) / 100, 0),
    paid: true,
    paid_at: new Date().toISOString(),
  }));
  const total = (payload.orderTotal || payload.total || 0) / 100 || orderItemRows.reduce((s, i) => s + (i.unit_price + i.addon_total) * i.quantity, 0);

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: integration.business_id,
      card_id: null,
      table_label: `${payload.channel ? `Channel ${payload.channel} - ` : ''}Delivery`,
      note: payload.note || '',
      total,
      status: 'pending',
      source: 'delivery',
      delivery_platform: String(payload.channel || 'unknown'),
      delivery_channel_order_id: payload.channelOrderId || payload._id || '',
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  if (orderItemRows.length > 0) {
    await supabaseAdmin.from('order_items').insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })));
  }

  res.status(200).json({ status: 'ok', orderId: order.id });
});

const syncProducts = asyncHandler(async (req, res) => {
  res.json({ message: 'Product sync endpoint ready - full menu mapping happens once a real Deliverect account is connected' });
});

// @route GET /api/businesses/:businessId/delivery-integration  (owner/super_admin)
const getDeliveryIntegration = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('delivery_integrations')
    .select('*')
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data || { business_id: req.params.businessId, provider: 'deliverect', enabled: false });
});

// @route PUT /api/businesses/:businessId/delivery-integration
// Creating this row is what makes registerPos able to recognize this
// business later - it's the "I have a Deliverect account, here's where
// to link it" step, done once, before Deliverect's dashboard is
// configured to point at Tavzio at all.
const upsertDeliveryIntegration = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('delivery_integrations')
    .upsert({ business_id: req.params.businessId, provider: 'deliverect' }, { onConflict: 'business_id' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { registerPos, receiveOrder, syncProducts, verifyDeliverectSignature, getDeliveryIntegration, upsertDeliveryIntegration };