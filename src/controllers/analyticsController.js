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

module.exports = { getSummary, getCardBreakdown };
