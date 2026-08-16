const asyncHandler = require('../utils/asyncHandler');

// --- Rate calendar (date-specific overrides on a rate plan) ---

// @route GET /api/businesses/:businessId/hotel/revenue/rate-overrides?ratePlanId=
const listRateOverrides = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('hotel_rate_overrides')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('override_date');
  if (req.query.ratePlanId) query = query.eq('rate_plan_id', req.query.ratePlanId);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PUT /api/businesses/:businessId/hotel/revenue/rate-overrides
// Body: { ratePlanId, overrideDate, rateAed }
// Upsert - setting the same plan+date twice updates it rather than
// erroring on a duplicate.
const setRateOverride = asyncHandler(async (req, res) => {
  const { ratePlanId, overrideDate, rateAed } = req.body;
  if (!ratePlanId || !overrideDate || rateAed == null) {
    return res.status(400).json({ message: 'ratePlanId, overrideDate, and rateAed are required' });
  }
  const { data, error } = await req.supabase
    .from('hotel_rate_overrides')
    .upsert(
      { business_id: req.params.businessId, rate_plan_id: ratePlanId, override_date: overrideDate, rate_aed: rateAed },
      { onConflict: 'rate_plan_id,override_date' }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const deleteRateOverride = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_rate_overrides')
    .delete({ count: 'exact' })
    .eq('id', req.params.overrideId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Override not found' });
  res.json({ message: 'Rate override removed' });
});

// --- Occupancy-based pricing rules ---

const listPricingRules = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_pricing_rules')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('occupancy_threshold_pct');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createPricingRule = asyncHandler(async (req, res) => {
  const { name, occupancyThresholdPct, surchargePct } = req.body;
  if (!name || !occupancyThresholdPct || !surchargePct) {
    return res.status(400).json({ message: 'name, occupancyThresholdPct, and surchargePct are required' });
  }
  const { data, error } = await req.supabase
    .from('hotel_pricing_rules')
    .insert({ business_id: req.params.businessId, name, occupancy_threshold_pct: occupancyThresholdPct, surcharge_pct: surchargePct })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updatePricingRule = asyncHandler(async (req, res) => {
  const { name, occupancyThresholdPct, surchargePct, active } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (occupancyThresholdPct !== undefined) update.occupancy_threshold_pct = occupancyThresholdPct;
  if (surchargePct !== undefined) update.surcharge_pct = surchargePct;
  if (active !== undefined) update.active = active;
  const { data, error } = await req.supabase
    .from('hotel_pricing_rules')
    .update(update)
    .eq('id', req.params.ruleId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Pricing rule not found' });
  res.json(data);
});

const deletePricingRule = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_pricing_rules')
    .delete({ count: 'exact' })
    .eq('id', req.params.ruleId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Pricing rule not found' });
  res.json({ message: 'Pricing rule removed' });
});

// Occupancy % for one specific date - shared by getEffectiveRate and
// getOccupancyForecast below so the two can never disagree with each
// other about what "occupancy" means on a given day.
async function occupancyForDate(supabase, businessId, dateStr) {
  const { count: totalRooms } = await supabase
    .from('hotel_rooms')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .neq('status', 'out_of_order');
  if (!totalRooms) return { occupancyPct: 0, totalRooms: 0, occupiedRooms: 0 };

  const { data: reservations } = await supabase
    .from('hotel_reservations')
    .select('id')
    .eq('business_id', businessId)
    .in('status', ['confirmed', 'checked_in'])
    .lte('check_in_date', dateStr)
    .gt('check_out_date', dateStr);
  const occupiedRooms = (reservations || []).length;

  return { occupancyPct: Math.round((occupiedRooms / totalRooms) * 1000) / 10, totalRooms, occupiedRooms };
}

// @route GET /api/businesses/:businessId/hotel/revenue/effective-rate?ratePlanId=&date=
// Transparent, explainable price calculation - not a black box: shows
// the base rate, whether a date-specific override applied, current
// occupancy for that date, and which pricing rule (if any) fired,
// alongside the final number. A manager can see exactly why a rate is
// what it is, same principle as the sales forecast and reorder suggestions.
async function computeEffectiveRate(supabase, businessId, ratePlanId, date) {
  const { data: plan } = await supabase.from('hotel_rate_plans').select('*').eq('id', ratePlanId).eq('business_id', businessId).single();
  if (!plan) return null;

  const { data: override } = await supabase
    .from('hotel_rate_overrides')
    .select('rate_aed')
    .eq('rate_plan_id', ratePlanId)
    .eq('override_date', date)
    .maybeSingle();

  const baseForDate = override ? Number(override.rate_aed) : Number(plan.base_rate_aed);

  const { occupancyPct } = await occupancyForDate(supabase, businessId, date);
  const { data: rules } = await supabase
    .from('hotel_pricing_rules')
    .select('*')
    .eq('business_id', businessId)
    .eq('active', true)
    .lte('occupancy_threshold_pct', occupancyPct)
    .order('occupancy_threshold_pct', { ascending: false })
    .limit(1);
  const appliedRule = rules?.[0] || null;

  const finalRateAed = appliedRule ? Math.round(baseForDate * (1 + Number(appliedRule.surcharge_pct) / 100) * 100) / 100 : baseForDate;

  return {
    ratePlanId, date,
    baseRateAed: Number(plan.base_rate_aed),
    overrideApplied: !!override,
    rateBeforeSurchargeAed: baseForDate,
    occupancyPct,
    appliedRule: appliedRule ? { id: appliedRule.id, name: appliedRule.name, surchargePct: Number(appliedRule.surcharge_pct) } : null,
    finalRateAed,
  };
}

const getEffectiveRate = asyncHandler(async (req, res) => {
  const { ratePlanId, date } = req.query;
  if (!ratePlanId || !date) return res.status(400).json({ message: 'ratePlanId and date are required' });
  const result = await computeEffectiveRate(req.supabase, req.params.businessId, ratePlanId, date);
  if (!result) return res.status(404).json({ message: 'Rate plan not found' });
  res.json(result);
});

// @route GET /api/businesses/:businessId/hotel/revenue/occupancy-forecast?days=14
const getOccupancyForecast = asyncHandler(async (req, res) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const forecast = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
    const { occupancyPct, totalRooms, occupiedRooms } = await occupancyForDate(req.supabase, req.params.businessId, date);
    forecast.push({ date, occupancyPct, totalRooms, occupiedRooms });
  }
  res.json({ days, forecast });
});

module.exports = {
  listRateOverrides, setRateOverride, deleteRateOverride,
  listPricingRules, createPricingRule, updatePricingRule, deletePricingRule,
  getEffectiveRate, getOccupancyForecast, computeEffectiveRate,
};
