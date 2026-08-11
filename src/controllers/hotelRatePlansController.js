const asyncHandler = require('../utils/asyncHandler');

const listRatePlans = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_rate_plans')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createRatePlan = asyncHandler(async (req, res) => {
  const { name, rateType = 'flexible', baseRateAed, isRefundable = true, mealPlan = 'none', validFrom = null, validTo = null } = req.body;
  if (!name || baseRateAed == null) return res.status(400).json({ message: 'name and baseRateAed are required' });

  const { data, error } = await req.supabase
    .from('hotel_rate_plans')
    .insert({
      business_id: req.params.businessId, name, rate_type: rateType, base_rate_aed: baseRateAed,
      is_refundable: isRefundable, meal_plan: mealPlan, valid_from: validFrom, valid_to: validTo,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateRatePlan = asyncHandler(async (req, res) => {
  const { name, rateType, baseRateAed, isRefundable, mealPlan, validFrom, validTo, active } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (rateType !== undefined) update.rate_type = rateType;
  if (baseRateAed !== undefined) update.base_rate_aed = baseRateAed;
  if (isRefundable !== undefined) update.is_refundable = isRefundable;
  if (mealPlan !== undefined) update.meal_plan = mealPlan;
  if (validFrom !== undefined) update.valid_from = validFrom;
  if (validTo !== undefined) update.valid_to = validTo;
  if (active !== undefined) update.active = active;

  const { data, error } = await req.supabase
    .from('hotel_rate_plans')
    .update(update)
    .eq('id', req.params.ratePlanId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listRatePlans, createRatePlan, updateRatePlan };
