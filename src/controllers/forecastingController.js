const asyncHandler = require('../utils/asyncHandler');

async function requireForecastingFeature(req, res) {
  const { data: business } = await req.supabase.from('businesses').select('features').eq('id', req.params.businessId).single();
  if (!business?.features?.forecasting?.enabled) {
    res.status(403).json({ message: 'Forecasting is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  return business;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HISTORY_WEEKS = 8;

// @route GET /api/businesses/:businessId/forecasting/sales-forecast?days=7
// Day-of-week seasonality forecast, not a black-box model: for each day
// being forecast, averages what that SAME weekday actually made over the
// trailing 8 weeks, and projects that forward. A restaurant's Friday and
// Tuesday are genuinely different businesses - a flat daily average would
// systematically under-forecast weekends and over-forecast weekdays.
// Every projected number carries the sample size and historical average
// it's built from, so a manager can see exactly why the forecast says
// what it says, not just trust a number.
const getSalesForecast = asyncHandler(async (req, res) => {
  if (!(await requireForecastingFeature(req, res))) return;
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const historyStart = new Date(Date.now() - HISTORY_WEEKS * 7 * 86400000).toISOString();

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('total, created_at, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', historyStart);
  if (error) return res.status(400).json({ message: error.message });

  // Bucket historical revenue by calendar date first (so multiple orders
  // the same day combine into one day-total), then by weekday.
  const revenueByDate = new Map();
  for (const o of orders || []) {
    const dateKey = o.created_at.slice(0, 10);
    revenueByDate.set(dateKey, (revenueByDate.get(dateKey) || 0) + Number(o.total));
  }
  const byWeekday = Array.from({ length: 7 }, () => []);
  for (const [dateKey, revenue] of revenueByDate) {
    const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
    byWeekday[weekday].push(revenue);
  }
  const weekdayAverages = byWeekday.map((values) => ({
    avgRevenueAed: values.length > 0 ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100 : null,
    sampleSize: values.length,
  }));

  const forecast = [];
  for (let i = 1; i <= days; i++) {
    const date = new Date(Date.now() + i * 86400000);
    const weekday = date.getUTCDay();
    const stats = weekdayAverages[weekday];
    forecast.push({
      date: date.toISOString().slice(0, 10),
      dayOfWeek: DAY_NAMES[weekday],
      forecastRevenueAed: stats.avgRevenueAed,
      basedOnSampleSize: stats.sampleSize,
    });
  }

  const totalForecastAed = forecast.reduce((sum, f) => sum + (f.forecastRevenueAed || 0), 0);
  const lowConfidenceDays = forecast.filter((f) => f.basedOnSampleSize < 3).length;

  res.json({
    days, historyWeeks: HISTORY_WEEKS,
    forecast,
    totalForecastAed: Math.round(totalForecastAed * 100) / 100,
    lowConfidenceDays, // fewer than 3 historical samples for that weekday - young business or a new day-of-week pattern
  });
});

// --- Budgets ---

// @route GET /api/businesses/:businessId/forecasting/budget?month=YYYY-MM
const getBudget = asyncHandler(async (req, res) => {
  if (!(await requireForecastingFeature(req, res))) return;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { data, error } = await req.supabase
    .from('business_budgets')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('period_month', `${month}-01`)
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PUT /api/businesses/:businessId/forecasting/budget
// Body: { month: 'YYYY-MM', revenueBudgetAed?, foodCostPctBudget?, laborCostPctBudget? }
// One row per calendar month - upsert, so setting this month's budget
// twice updates it rather than creating a duplicate.
const setBudget = asyncHandler(async (req, res) => {
  if (!(await requireForecastingFeature(req, res))) return;
  const { month, revenueBudgetAed, foodCostPctBudget, laborCostPctBudget } = req.body;
  if (!month) return res.status(400).json({ message: 'month is required (YYYY-MM)' });

  const { data, error } = await req.supabase
    .from('business_budgets')
    .upsert({
      business_id: req.params.businessId,
      period_month: `${month}-01`,
      revenue_budget_aed: revenueBudgetAed ?? null,
      food_cost_pct_budget: foodCostPctBudget ?? null,
      labor_cost_pct_budget: laborCostPctBudget ?? null,
      created_by: req.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,period_month' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/forecasting/budget-vs-actual?month=YYYY-MM
// Actual revenue for the month against the budget set for it. Food cost %
// and labor cost % actuals are included only when inventory/HR labor-cost
// tracking are genuinely enabled and have real data - reported as null
// with a plain reason otherwise, never silently shown as 0% (which would
// look like "on budget" when it's actually just untracked).
const getBudgetVsActual = asyncHandler(async (req, res) => {
  if (!(await requireForecastingFeature(req, res))) return;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01T00:00:00.000Z`;
  const nextMonth = new Date(new Date(`${month}-01T00:00:00.000Z`).setUTCMonth(new Date(`${month}-01T00:00:00.000Z`).getUTCMonth() + 1)).toISOString();

  const { data: budget } = await req.supabase
    .from('business_budgets')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('period_month', `${month}-01`)
    .maybeSingle();

  const { data: orders } = await req.supabase
    .from('orders')
    .select('total, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', monthStart)
    .lt('created_at', nextMonth);
  const actualRevenueAed = Math.round((orders || []).reduce((sum, o) => sum + Number(o.total), 0) * 100) / 100;

  const { data: business } = await req.supabase.from('businesses').select('features').eq('id', req.params.businessId).single();

  // Food cost actual - same computation as the dedicated food-cost report
  // (recipe cost of what was actually sold), only run here if inventory
  // tracking is genuinely on for this business.
  let actualFoodCostPct = null;
  let foodCostNote = 'Inventory tracking is not enabled for this business';
  if (business?.features?.inventory?.enabled) {
    const { data: orderItems } = await req.supabase
      .from('order_items')
      .select('menu_item_id, unit_price, quantity, orders!inner(business_id, created_at)')
      .eq('orders.business_id', req.params.businessId)
      .eq('voided', false)
      .gte('orders.created_at', monthStart)
      .lt('orders.created_at', nextMonth);
    const menuItemIds = [...new Set((orderItems || []).map((i) => i.menu_item_id).filter(Boolean))];
    const { data: recipeRows } = await req.supabase
      .from('menu_item_ingredients')
      .select('menu_item_id, quantity, ingredients(cost_per_unit)')
      .in('menu_item_id', menuItemIds.length ? menuItemIds : ['00000000-0000-0000-0000-000000000000']);
    const recipeCostByMenuItem = new Map();
    const hasRecipe = new Set();
    for (const r of recipeRows || []) {
      hasRecipe.add(r.menu_item_id);
      recipeCostByMenuItem.set(r.menu_item_id, (recipeCostByMenuItem.get(r.menu_item_id) || 0) + Number(r.quantity) * Number(r.ingredients?.cost_per_unit || 0));
    }
    let trackedRevenue = 0;
    let totalCost = 0;
    for (const oi of orderItems || []) {
      if (oi.menu_item_id && hasRecipe.has(oi.menu_item_id)) {
        trackedRevenue += Number(oi.unit_price) * oi.quantity;
        totalCost += recipeCostByMenuItem.get(oi.menu_item_id) * oi.quantity;
      }
    }
    actualFoodCostPct = trackedRevenue > 0 ? Math.round((totalCost / trackedRevenue) * 1000) / 10 : null;
    foodCostNote = actualFoodCostPct != null ? '' : 'No recipe-tracked sales this month yet';
  }

  // Labor cost actual - same computation as the dedicated labor-cost
  // report, only run here if labor cost tracking is genuinely on.
  let actualLaborCostPct = null;
  let laborCostNote = 'Labor cost tracking is not enabled for this business';
  if (business?.features?.hr?.laborCost) {
    const { data: shifts } = await req.supabase
      .from('staff_shifts')
      .select('clock_in_at, clock_out_at, profiles!staff_shifts_staff_id_fkey(hourly_rate_aed)')
      .eq('business_id', req.params.businessId)
      .gte('clock_in_at', monthStart)
      .lt('clock_in_at', nextMonth)
      .not('clock_out_at', 'is', null);
    let totalLaborCostAed = 0;
    for (const s of shifts || []) {
      const rate = s.profiles?.hourly_rate_aed;
      if (rate == null) continue;
      const hours = (new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 3600000;
      totalLaborCostAed += hours * Number(rate);
    }
    actualLaborCostPct = actualRevenueAed > 0 ? Math.round((totalLaborCostAed / actualRevenueAed) * 1000) / 10 : null;
    laborCostNote = actualLaborCostPct != null ? '' : 'No revenue recorded this month yet';
  }

  res.json({
    month,
    budget: budget || null,
    actual: {
      revenueAed: actualRevenueAed,
      foodCostPct: actualFoodCostPct,
      foodCostNote,
      laborCostPct: actualLaborCostPct,
      laborCostNote,
    },
    variance: budget ? {
      revenueAed: budget.revenue_budget_aed != null ? Math.round((actualRevenueAed - Number(budget.revenue_budget_aed)) * 100) / 100 : null,
      foodCostPct: budget.food_cost_pct_budget != null && actualFoodCostPct != null ? Math.round((actualFoodCostPct - Number(budget.food_cost_pct_budget)) * 10) / 10 : null,
      laborCostPct: budget.labor_cost_pct_budget != null && actualLaborCostPct != null ? Math.round((actualLaborCostPct - Number(budget.labor_cost_pct_budget)) * 10) / 10 : null,
    } : null,
  });
});

module.exports = { getSalesForecast, getBudget, setBudget, getBudgetVsActual };
