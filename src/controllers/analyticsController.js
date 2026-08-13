const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/analytics/summary?from=&to=
const getSummary = asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  const { data, error } = await req.supabase.rpc('get_business_summary', {
    p_business_id: req.params.businessId,
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
  });

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/analytics/cards
const getCardBreakdown = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.rpc('get_card_breakdown', {
    p_business_id: req.params.businessId,
  });

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/analytics/sales-by-channel?from=&to=
// Revenue split by how the order actually came in - not a fabricated
// "Dine-in/Takeaway/Delivery" bucket that doesn't map to anything real
// in this schema, but the genuine channels Tavzio tracks: table (NFC
// tap), counter (staff POS), delivery platform, and hotel room service.
const CHANNEL_LABELS = {
  customer_tap: 'Table (NFC Tap)',
  staff_pos: 'POS / Counter',
  delivery: 'Delivery',
  guest_portal_hotel: 'Hotel Room Service',
};
const getSalesByChannel = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('source, total, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const bySource = {};
  for (const o of orders || []) {
    const key = o.source || 'customer_tap';
    if (!bySource[key]) bySource[key] = { count: 0, total: 0 };
    bySource[key].count += 1;
    bySource[key].total += Number(o.total);
  }

  const grandTotal = Object.values(bySource).reduce((sum, s) => sum + s.total, 0);
  const channels = Object.entries(bySource).map(([source, stats]) => ({
    source,
    label: CHANNEL_LABELS[source] || source,
    orderCount: stats.count,
    total: Math.round(stats.total * 100) / 100,
    percentage: grandTotal > 0 ? Math.round((stats.total / grandTotal) * 1000) / 10 : 0,
  })).sort((a, b) => b.total - a.total);

  res.json({ from, to, channels, grandTotal: Math.round(grandTotal * 100) / 100 });
});

module.exports = { getSummary, getCardBreakdown, getSalesByChannel };
