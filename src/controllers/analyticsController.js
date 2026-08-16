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

// @route GET /api/businesses/:businessId/analytics/top-items?from=&to=&limit=
// Best sellers by revenue AND by quantity (they're often not the same
// item - a AED 8 side sold 200 times can outrank a AED 80 entree sold 10
// times on revenue, but not on quantity). Both orderings returned so the
// dashboard doesn't have to guess which one a manager actually wants.
const getTopItems = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

  const { data: orderItems, error } = await req.supabase
    .from('order_items')
    .select('item_name, unit_price, quantity, orders!inner(business_id, created_at, status)')
    .eq('orders.business_id', req.params.businessId)
    .neq('orders.status', 'cancelled')
    .eq('voided', false)
    .gte('orders.created_at', from)
    .lte('orders.created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const byItem = new Map();
  let grandTotal = 0;
  for (const oi of orderItems || []) {
    const revenue = Number(oi.unit_price) * oi.quantity;
    grandTotal += revenue;
    const entry = byItem.get(oi.item_name) || { name: oi.item_name, quantitySold: 0, revenueAed: 0 };
    entry.quantitySold += oi.quantity;
    entry.revenueAed += revenue;
    byItem.set(oi.item_name, entry);
  }

  const items = Array.from(byItem.values()).map((i) => ({
    ...i,
    revenueAed: Math.round(i.revenueAed * 100) / 100,
    revenueSharePct: grandTotal > 0 ? Math.round((i.revenueAed / grandTotal) * 1000) / 10 : 0,
  }));

  res.json({
    from, to,
    byRevenue: [...items].sort((a, b) => b.revenueAed - a.revenueAed).slice(0, limit),
    byQuantity: [...items].sort((a, b) => b.quantitySold - a.quantitySold).slice(0, limit),
  });
});

// @route GET /api/businesses/:businessId/analytics/revenue-trend?from=&to=
// Daily revenue for a date range - the trend line that was missing:
// "taps over time" (already tracked) is visitor behavior, not money.
// This is real revenue per day, for a line chart.
const getRevenueTrend = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('total, created_at, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const byDate = new Map();
  for (const o of orders || []) {
    const dateKey = o.created_at.slice(0, 10);
    byDate.set(dateKey, (byDate.get(dateKey) || 0) + Number(o.total));
  }
  const trend = Array.from(byDate.entries())
    .map(([date, revenueAed]) => ({ date, revenueAed: Math.round(revenueAed * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ from, to, trend, totalRevenueAed: Math.round(trend.reduce((sum, t) => sum + t.revenueAed, 0) * 100) / 100 });
});

// @route GET /api/businesses/:businessId/analytics/peak-hours?from=&to=
// Order VOLUME by hour of day (0-23) - distinct from the existing "top
// hours" (nfc_tap events, i.e. visitor foot traffic) which doesn't tell
// you when orders themselves actually land. Both matter for staffing and
// kitchen prep, but they're genuinely different signals.
const getPeakHours = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('created_at, status')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const counts = Array.from({ length: 24 }, () => 0);
  for (const o of orders || []) {
    counts[new Date(o.created_at).getUTCHours()] += 1;
  }
  const hours = counts.map((count, hour) => ({ hour, orderCount: count }));

  res.json({ from, to, hours, peakHour: hours.reduce((a, b) => (b.orderCount > a.orderCount ? b : a), hours[0]).hour });
});

// @route GET /api/businesses/:businessId/analytics/kitchen-performance?from=&to=
// How long tickets actually take, using the timestamps updateOrderStatus
// now stamps: time-to-start (pending -> preparing), prep time (preparing
// -> ready), and total ticket time (pending -> ready). Orders missing a
// timestamp (placed before this feature existed, or still in progress)
// are excluded from that specific average rather than treated as 0.
const getKitchenPerformance = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('created_at, prep_started_at, ready_at, status')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const timeToStartMins = [];
  const prepTimeMins = [];
  const totalTicketMins = [];
  for (const o of orders || []) {
    if (o.prep_started_at) timeToStartMins.push((new Date(o.prep_started_at) - new Date(o.created_at)) / 60000);
    if (o.prep_started_at && o.ready_at) prepTimeMins.push((new Date(o.ready_at) - new Date(o.prep_started_at)) / 60000);
    if (o.ready_at) totalTicketMins.push((new Date(o.ready_at) - new Date(o.created_at)) / 60000);
  }
  const avg = (arr) => (arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);

  res.json({
    from, to,
    ticketCount: (orders || []).length,
    avgTimeToStartMins: avg(timeToStartMins),
    avgPrepTimeMins: avg(prepTimeMins),
    avgTotalTicketMins: avg(totalTicketMins),
    trackedTicketCount: totalTicketMins.length,
  });
});

// @route GET /api/businesses/:businessId/analytics/hotel-performance?from=&to=
// Hotel-specific analytics - distinct from the single-period consolidated
// cross-property snapshot built for multi-property: this is trend data
// and channel/outcome breakdowns for ONE property over time. Four real
// reports in one call rather than four chatty round-trips:
//   - occupancy/ADR/RevPAR trend (from night audit history, for a chart)
//   - booking source breakdown (direct/walk-in/OTA/phone - where
//     reservations actually come from, and what each channel is worth)
//   - reservation outcomes (checked out / cancelled / no-show rates -
//     real operational KPIs, not just a raw count)
//   - average length of stay
const getHotelPerformance = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const { data: audits } = await req.supabase
    .from('hotel_night_audits')
    .select('business_date, occupancy_rate, room_revenue_aed, rooms_sold, rooms_available')
    .eq('business_id', req.params.businessId)
    .gte('business_date', from)
    .lte('business_date', to)
    .order('business_date');

  const occupancyTrend = (audits || []).map((a) => ({
    date: a.business_date,
    occupancyPct: Math.round(Number(a.occupancy_rate) * 10) / 10,
    adrAed: a.rooms_sold > 0 ? Math.round((Number(a.room_revenue_aed) / a.rooms_sold) * 100) / 100 : null,
    revParAed: a.rooms_available > 0 ? Math.round((Number(a.room_revenue_aed) / a.rooms_available) * 100) / 100 : null,
  }));

  // Booking source and length-of-stay use rate_aed * nights - the
  // booked-rate economics, same basis hotel_reservations already uses
  // at check-in - not the final folio total (which would also pull in
  // F&B, extras, and adjustments that have nothing to do with which
  // channel brought the booking in).
  const { data: reservations } = await req.supabase
    .from('hotel_reservations')
    .select('source, status, check_in_date, check_out_date, rate_aed')
    .eq('business_id', req.params.businessId)
    .gte('check_in_date', from)
    .lte('check_in_date', to);

  const SOURCE_LABELS = { direct: 'Direct', walk_in: 'Walk-in', ota: 'OTA', phone: 'Phone' };
  const bySource = {};
  let totalSourceRevenue = 0;
  const outcomes = { checked_out: 0, cancelled: 0, no_show: 0, confirmed: 0, checked_in: 0 };
  const stayNights = [];

  for (const r of reservations || []) {
    outcomes[r.status] = (outcomes[r.status] || 0) + 1;
    const nights = Math.max(1, Math.round((new Date(r.check_out_date) - new Date(r.check_in_date)) / 86400000));
    const revenue = Number(r.rate_aed) * nights;

    const entry = bySource[r.source] || { source: r.source, label: SOURCE_LABELS[r.source] || r.source, count: 0, revenueAed: 0 };
    entry.count += 1;
    entry.revenueAed += revenue;
    bySource[r.source] = entry;
    totalSourceRevenue += revenue;

    if (r.status === 'checked_out') stayNights.push(nights);
  }

  const bookingSources = Object.values(bySource).map((s) => ({
    ...s,
    revenueAed: Math.round(s.revenueAed * 100) / 100,
    percentage: totalSourceRevenue > 0 ? Math.round((s.revenueAed / totalSourceRevenue) * 1000) / 10 : 0,
  })).sort((a, b) => b.revenueAed - a.revenueAed);

  const totalOutcomes = outcomes.checked_out + outcomes.cancelled + outcomes.no_show;
  const avgLengthOfStayNights = stayNights.length > 0 ? Math.round((stayNights.reduce((s, n) => s + n, 0) / stayNights.length) * 10) / 10 : null;

  res.json({
    from, to,
    occupancyTrend,
    bookingSources,
    reservationOutcomes: {
      checkedOut: outcomes.checked_out,
      cancelled: outcomes.cancelled,
      noShow: outcomes.no_show,
      stillUpcoming: outcomes.confirmed + outcomes.checked_in,
      cancellationRatePct: totalOutcomes > 0 ? Math.round((outcomes.cancelled / totalOutcomes) * 1000) / 10 : null,
      noShowRatePct: totalOutcomes > 0 ? Math.round((outcomes.no_show / totalOutcomes) * 1000) / 10 : null,
    },
    avgLengthOfStayNights,
  });
});

module.exports = { getSummary, getCardBreakdown, getSalesByChannel, getTopItems, getRevenueTrend, getPeakHours, getKitchenPerformance, getHotelPerformance };
