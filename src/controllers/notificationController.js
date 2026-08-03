const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');

const SECTIONS = ['orders', 'requests', 'payments'];

// Defaults to "the beginning of time" for a section nobody's ever opened -
// everything currently pending counts, which is the correct behavior for
// a brand new business or a section visited for the first time.
async function getLastViewed(businessId, section) {
  const { data } = await supabaseAdmin
    .from('dashboard_section_views')
    .select('last_viewed_at')
    .eq('business_id', businessId)
    .eq('section', section)
    .maybeSingle();
  return data?.last_viewed_at || '1970-01-01T00:00:00Z';
}

// @route GET /api/businesses/:businessId/notifications/counts
const getNotificationCounts = asyncHandler(async (req, res) => {
  const businessId = req.params.businessId;
  const [ordersViewed, requestsViewed, paymentsViewed] = await Promise.all(
    SECTIONS.map((s) => getLastViewed(businessId, s))
  );

  const [ordersCount, callWaiterCount, cashPendingCount, claimsCount, paymentsCount] = await Promise.all([
    supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('request_type', 'order').eq('status', 'pending')
      .gte('created_at', ordersViewed),
    supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).neq('request_type', 'order').neq('status', 'completed')
      .gte('created_at', requestsViewed),
    // cash_pending has no created_at of its own (it's a flag on an
    // existing item, not a new row) - approximated via the order's
    // updated_at isn't tracked either, so this counts against the
    // order's created_at as the closest available signal. Acceptable
    // for a badge count; not used anywhere money is actually calculated.
    supabaseAdmin.from('order_items').select('id, orders!inner(business_id, created_at)', { count: 'exact', head: true })
      .eq('orders.business_id', businessId).eq('cash_pending', true).eq('paid', false)
      .gte('orders.created_at', requestsViewed),
    supabaseAdmin.from('loyalty_reward_claims').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('status', 'pending')
      .gte('created_at', requestsViewed),
    supabaseAdmin.from('payments').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('status', 'completed')
      .gte('created_at', paymentsViewed),
  ]);

  res.json({
    orders: ordersCount.count || 0,
    requests: (callWaiterCount.count || 0) + (cashPendingCount.count || 0) + (claimsCount.count || 0),
    payments: paymentsCount.count || 0,
  });
});

// @route POST /api/businesses/:businessId/notifications/:section/mark-viewed
// Shared across all staff, deliberately - the first person who opens
// Orders clears it for everyone, same as dismissing a request already
// works. Simpler and matches the existing mental model; per-staff
// "seen" tracking would be a materially bigger, separate feature.
const markSectionViewed = asyncHandler(async (req, res) => {
  const { section } = req.params;
  if (!SECTIONS.includes(section)) {
    return res.status(400).json({ message: 'Unknown section' });
  }
  const { error } = await supabaseAdmin
    .from('dashboard_section_views')
    .upsert({ business_id: req.params.businessId, section, last_viewed_at: new Date().toISOString() }, { onConflict: 'business_id,section' });
  if (error) return res.status(400).json({ message: error.message });
  res.json({ section, viewedAt: new Date().toISOString() });
});

module.exports = { getNotificationCounts, markSectionViewed };
