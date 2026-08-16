const asyncHandler = require('../utils/asyncHandler');

// --- Suppliers ---
const listSuppliers = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('suppliers').select('*').eq('business_id', req.params.businessId).order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createSupplier = asyncHandler(async (req, res) => {
  const { name, contactName = '', phone = '', email = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'Supplier name is required' });
  const { data, error } = await req.supabase
    .from('suppliers')
    .insert({ business_id: req.params.businessId, name, contact_name: contactName, phone, email })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// --- Ingredients ---
const listIngredients = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('ingredients').select('*, suppliers(name)').eq('business_id', req.params.businessId).order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createIngredient = asyncHandler(async (req, res) => {
  const { name, unit, lowStockThreshold = 0, supplierId = null } = req.body;
  if (!name || !unit) return res.status(400).json({ message: 'name and unit are required' });
  const { data, error } = await req.supabase
    .from('ingredients')
    .insert({ business_id: req.params.businessId, name, unit, low_stock_threshold: lowStockThreshold, supplier_id: supplierId })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateIngredient = asyncHandler(async (req, res) => {
  const { name, unit, lowStockThreshold, supplierId } = req.body;
  const patch = {};
  if (name != null) patch.name = name;
  if (unit != null) patch.unit = unit;
  if (lowStockThreshold != null) patch.low_stock_threshold = lowStockThreshold;
  if (supplierId !== undefined) patch.supplier_id = supplierId;
  const { data, error } = await req.supabase
    .from('ingredients')
    .update(patch)
    .eq('id', req.params.ingredientId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Deleting cascades to its recipe links and stock-movement history (see
// migration 0030's `on delete cascade` on ingredient_id) - so this is
// only for ingredients that were never actually used. If it's linked to
// a menu item's recipe or has real stock history, block it and point the
// owner at archiving via a zero threshold instead of silently wiping
// movement records an FTA audit might need later.
const deleteIngredient = asyncHandler(async (req, res) => {
  const { ingredientId, businessId } = req.params;

  const { count: recipeCount } = await req.supabase
    .from('menu_item_ingredients')
    .select('id', { count: 'exact', head: true })
    .eq('ingredient_id', ingredientId);
  const { count: movementCount } = await req.supabase
    .from('stock_movements')
    .select('id', { count: 'exact', head: true })
    .eq('ingredient_id', ingredientId);

  if (recipeCount || movementCount) {
    return res.status(400).json({
      message: recipeCount
        ? 'This ingredient is used in one or more recipes - remove it from those recipes first.'
        : 'This ingredient has stock history and can\'t be deleted (needed for your records). Set its stock to 0 instead.',
    });
  }

  const { error, count } = await req.supabase
    .from('ingredients')
    .delete({ count: 'exact' })
    .eq('id', ingredientId)
    .eq('business_id', businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Ingredient not found' });
  res.json({ message: 'Ingredient deleted' });
});

// Manual stock adjustment - waste, recount, correction. Always goes
// through stock_movements so there's a real explanation on record, never
// a silent overwrite of the stock number.
const adjustStock = asyncHandler(async (req, res) => {
  const { changeQty, reason = 'manual_adjustment', note = '' } = req.body;
  if (changeQty == null || Number(changeQty) === 0) return res.status(400).json({ message: 'changeQty is required and must be non-zero' });

  const { data: ingredient } = await req.supabase.from('ingredients').select('*').eq('id', req.params.ingredientId).single();
  if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });

  const newQty = Number(ingredient.stock_qty) + Number(changeQty);
  const { data: updated, error } = await req.supabase
    .from('ingredients')
    .update({ stock_qty: newQty })
    .eq('id', req.params.ingredientId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await req.supabase.from('stock_movements').insert({
    business_id: req.params.businessId,
    ingredient_id: req.params.ingredientId,
    change_qty: Number(changeQty),
    reason,
    note,
    created_by: req.user.id,
  });

  res.json(updated);
});

// Waste is recorded separately from a generic adjustment (even though
// both ultimately write to the same stock_movements ledger) because it
// needs to be reportable on its own - a manager asking "how much did we
// waste this month, and why" shouldn't have to guess which of the
// generic adjustments were actually waste. Always negative (waste never
// adds stock) and always carries a category, so the report below can
// actually break down the "why".
const recordWaste = asyncHandler(async (req, res) => {
  const { quantity, wasteCategory, note = '' } = req.body;
  const VALID_CATEGORIES = ['spoilage', 'prep_error', 'breakage', 'expired', 'other'];
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ message: 'quantity must be a positive number' });
  if (!VALID_CATEGORIES.includes(wasteCategory)) return res.status(400).json({ message: 'wasteCategory must be one of: ' + VALID_CATEGORIES.join(', ') });

  const { data: ingredient } = await req.supabase.from('ingredients').select('*').eq('id', req.params.ingredientId).single();
  if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });

  const changeQty = -Math.abs(Number(quantity));
  const newQty = Number(ingredient.stock_qty) + changeQty;
  const { data: updated, error } = await req.supabase
    .from('ingredients')
    .update({ stock_qty: newQty })
    .eq('id', req.params.ingredientId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await req.supabase.from('stock_movements').insert({
    business_id: req.params.businessId,
    ingredient_id: req.params.ingredientId,
    change_qty: changeQty,
    reason: 'waste',
    waste_category: wasteCategory,
    note,
    created_by: req.user.id,
  });

  res.json(updated);
});

// @route GET /api/businesses/:businessId/inventory/waste-report?days=30
// Total cost of waste over the window, broken down by ingredient and by
// category - the two questions a manager actually asks: "what's costing
// us the most" and "why is it happening". Valued at each ingredient's
// CURRENT weighted-average cost_per_unit (not the cost at the moment of
// waste) - consistent with how the rest of inventory values stock, and
// avoids needing to snapshot cost on every single movement row.
const getWasteReport = asyncHandler(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: movements, error } = await req.supabase
    .from('stock_movements')
    .select('id, ingredient_id, change_qty, waste_category, note, created_at, ingredients(name, unit, cost_per_unit)')
    .eq('business_id', req.params.businessId)
    .eq('reason', 'waste')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });

  const byIngredient = new Map();
  const byCategory = new Map();
  let totalCostAed = 0;

  for (const m of movements || []) {
    const qty = Math.abs(Number(m.change_qty));
    const costPerUnit = Number(m.ingredients?.cost_per_unit || 0);
    const cost = qty * costPerUnit;
    totalCostAed += cost;

    const ingKey = m.ingredient_id;
    const ingEntry = byIngredient.get(ingKey) || { ingredientId: ingKey, name: m.ingredients?.name || 'Unknown', unit: m.ingredients?.unit || '', quantity: 0, costAed: 0 };
    ingEntry.quantity += qty;
    ingEntry.costAed += cost;
    byIngredient.set(ingKey, ingEntry);

    const catKey = m.waste_category || 'other';
    const catEntry = byCategory.get(catKey) || { category: catKey, quantityEvents: 0, costAed: 0 };
    catEntry.quantityEvents += 1;
    catEntry.costAed += cost;
    byCategory.set(catKey, catEntry);
  }

  res.json({
    days,
    totalCostAed: Math.round(totalCostAed * 100) / 100,
    byIngredient: Array.from(byIngredient.values()).sort((a, b) => b.costAed - a.costAed),
    byCategory: Array.from(byCategory.values()).sort((a, b) => b.costAed - a.costAed),
    events: (movements || []).map((m) => ({
      id: m.id,
      ingredientName: m.ingredients?.name || 'Unknown',
      quantity: Math.abs(Number(m.change_qty)),
      unit: m.ingredients?.unit || '',
      costAed: Math.round(Math.abs(Number(m.change_qty)) * Number(m.ingredients?.cost_per_unit || 0) * 100) / 100,
      wasteCategory: m.waste_category || 'other',
      note: m.note || '',
      createdAt: m.created_at,
    })),
  });
});

// @route GET /api/businesses/:businessId/inventory/low-stock
// Everything currently at or below its threshold, with a suggested
// reorder quantity - a simple par-level heuristic (top back up to twice
// the threshold) rather than anything demand-forecast-based, deliberately:
// good enough to act on immediately, not a black box a manager has to trust.
const getLowStock = asyncHandler(async (req, res) => {
  const { data: ingredients, error } = await req.supabase
    .from('ingredients')
    .select('*, suppliers(id, name)')
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });

  const low = (ingredients || [])
    .filter((i) => Number(i.low_stock_threshold) > 0 && Number(i.stock_qty) <= Number(i.low_stock_threshold))
    .map((i) => ({
      ingredientId: i.id,
      name: i.name,
      unit: i.unit,
      stockQty: Number(i.stock_qty),
      lowStockThreshold: Number(i.low_stock_threshold),
      costPerUnit: Number(i.cost_per_unit),
      supplierId: i.supplier_id,
      supplierName: i.suppliers?.name || null,
      suggestedReorderQty: Math.max(0, Math.round((Number(i.low_stock_threshold) * 2 - Number(i.stock_qty)) * 100) / 100),
    }))
    .sort((a, b) => (a.stockQty / (a.lowStockThreshold || 1)) - (b.stockQty / (b.lowStockThreshold || 1)));

  res.json(low);
});

// @route GET /api/businesses/:businessId/inventory/valuation
// Total value currently sitting in stock, at each ingredient's own
// weighted-average cost - the number a manager needs before a stock
// count, or to answer "how much money is tied up in inventory right now".
const getValuation = asyncHandler(async (req, res) => {
  const { data: ingredients, error } = await req.supabase
    .from('ingredients')
    .select('id, name, unit, stock_qty, cost_per_unit')
    .eq('business_id', req.params.businessId)
    .order('name');
  if (error) return res.status(400).json({ message: error.message });

  const lines = (ingredients || []).map((i) => ({
    ingredientId: i.id,
    name: i.name,
    unit: i.unit,
    stockQty: Number(i.stock_qty),
    costPerUnit: Number(i.cost_per_unit),
    valueAed: Math.round(Number(i.stock_qty) * Number(i.cost_per_unit) * 100) / 100,
  }));
  const totalValueAed = Math.round(lines.reduce((sum, l) => sum + l.valueAed, 0) * 100) / 100;

  res.json({ totalValueAed, lines: lines.sort((a, b) => b.valueAed - a.valueAed) });
});

// @route GET /api/businesses/:businessId/inventory/food-cost
// Theoretical food cost per menu item: what the recipe SHOULD cost at
// current ingredient prices, against what it's sold for. An item with no
// recipe attached is returned with foodCostPct/marginAed = null rather
// than silently treated as zero cost - a manager needs to know "we don't
// track this one yet" is a different fact from "this one is free to make".
const getMenuItemFoodCost = asyncHandler(async (req, res) => {
  const { data: menuItems, error } = await req.supabase
    .from('menu_items')
    .select('id, name, price, is_available')
    .eq('business_id', req.params.businessId)
    .order('name');
  if (error) return res.status(400).json({ message: error.message });

  const { data: recipeRows } = await req.supabase
    .from('menu_item_ingredients')
    .select('menu_item_id, quantity, ingredients(cost_per_unit)')
    .in('menu_item_id', (menuItems || []).map((m) => m.id));

  const costByMenuItem = new Map();
  const hasRecipe = new Set();
  for (const r of recipeRows || []) {
    hasRecipe.add(r.menu_item_id);
    const lineCost = Number(r.quantity) * Number(r.ingredients?.cost_per_unit || 0);
    costByMenuItem.set(r.menu_item_id, (costByMenuItem.get(r.menu_item_id) || 0) + lineCost);
  }

  const items = (menuItems || []).map((m) => {
    if (!hasRecipe.has(m.id)) {
      return { menuItemId: m.id, name: m.name, price: Number(m.price), isAvailable: m.is_available, recipeCostAed: null, foodCostPct: null, marginAed: null, marginPct: null, trackedByRecipe: false };
    }
    const recipeCostAed = Math.round(costByMenuItem.get(m.id) * 100) / 100;
    const price = Number(m.price);
    const foodCostPct = price > 0 ? Math.round((recipeCostAed / price) * 1000) / 10 : null;
    const marginAed = Math.round((price - recipeCostAed) * 100) / 100;
    const marginPct = price > 0 ? Math.round((marginAed / price) * 1000) / 10 : null;
    return { menuItemId: m.id, name: m.name, price, isAvailable: m.is_available, recipeCostAed, foodCostPct, marginAed, marginPct, trackedByRecipe: true };
  });

  const trackedItems = items.filter((i) => i.trackedByRecipe);
  const avgFoodCostPct = trackedItems.length > 0
    ? Math.round((trackedItems.reduce((sum, i) => sum + (i.foodCostPct || 0), 0) / trackedItems.length) * 10) / 10
    : null;

  res.json({
    items: items.sort((a, b) => (b.foodCostPct ?? -1) - (a.foodCostPct ?? -1)),
    avgFoodCostPct,
    untrackedCount: items.length - trackedItems.length,
  });
});

// @route GET /api/businesses/:businessId/inventory/food-cost/actual?from=&to=
// Real COGS from what was actually SOLD in the window (paid, non-voided
// order items), not just the theoretical menu - answers "what did food
// actually cost us this month" rather than "what should it cost in
// theory". Revenue from items with no recipe is called out separately
// (untrackedRevenueAed) so it's never silently folded into a food-cost %
// that would then understate the real number.
const getActualFoodCost = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: orderItems, error } = await req.supabase
    .from('order_items')
    .select('menu_item_id, item_name, unit_price, quantity, orders!inner(business_id, created_at)')
    .eq('orders.business_id', req.params.businessId)
    .eq('voided', false)
    .gte('orders.created_at', from)
    .lte('orders.created_at', to);
  if (error) return res.status(400).json({ message: error.message });

  const menuItemIds = [...new Set((orderItems || []).map((i) => i.menu_item_id).filter(Boolean))];
  const { data: recipeRows } = await req.supabase
    .from('menu_item_ingredients')
    .select('menu_item_id, quantity, ingredients(cost_per_unit)')
    .in('menu_item_id', menuItemIds.length ? menuItemIds : ['00000000-0000-0000-0000-000000000000']);

  const recipeCostByMenuItem = new Map();
  const hasRecipe = new Set();
  for (const r of recipeRows || []) {
    hasRecipe.add(r.menu_item_id);
    const lineCost = Number(r.quantity) * Number(r.ingredients?.cost_per_unit || 0);
    recipeCostByMenuItem.set(r.menu_item_id, (recipeCostByMenuItem.get(r.menu_item_id) || 0) + lineCost);
  }

  let totalRevenueAed = 0;
  let totalCostAed = 0;
  let untrackedRevenueAed = 0;
  const byItem = new Map();

  for (const oi of orderItems || []) {
    const lineRevenue = Number(oi.unit_price) * oi.quantity;
    totalRevenueAed += lineRevenue;

    const tracked = oi.menu_item_id && hasRecipe.has(oi.menu_item_id);
    const lineCost = tracked ? recipeCostByMenuItem.get(oi.menu_item_id) * oi.quantity : 0;
    if (tracked) totalCostAed += lineCost;
    else untrackedRevenueAed += lineRevenue;

    const key = oi.menu_item_id || oi.item_name;
    const entry = byItem.get(key) || { name: oi.item_name, quantitySold: 0, revenueAed: 0, costAed: 0, trackedByRecipe: tracked };
    entry.quantitySold += oi.quantity;
    entry.revenueAed += lineRevenue;
    entry.costAed += lineCost;
    byItem.set(key, entry);
  }

  const trackedRevenue = totalRevenueAed - untrackedRevenueAed;
  const foodCostPct = trackedRevenue > 0 ? Math.round((totalCostAed / trackedRevenue) * 1000) / 10 : null;

  res.json({
    from, to,
    totalRevenueAed: Math.round(totalRevenueAed * 100) / 100,
    totalCostAed: Math.round(totalCostAed * 100) / 100,
    untrackedRevenueAed: Math.round(untrackedRevenueAed * 100) / 100,
    foodCostPct,
    byItem: Array.from(byItem.values())
      .map((i) => ({ ...i, revenueAed: Math.round(i.revenueAed * 100) / 100, costAed: Math.round(i.costAed * 100) / 100 }))
      .sort((a, b) => b.revenueAed - a.revenueAed),
  });
});

// --- Recipes (menu item <-> ingredients) ---
const getRecipe = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('menu_item_ingredients')
    .select('*, ingredients(id, name, unit, stock_qty)')
    .eq('menu_item_id', req.params.menuItemId);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Replaces the full recipe for a menu item in one call - simpler and
// less error-prone than incremental add/remove for a form that always
// submits the whole ingredient list at once.
const setRecipe = asyncHandler(async (req, res) => {
  const { ingredients } = req.body; // [{ ingredientId, quantity }]
  if (!Array.isArray(ingredients)) return res.status(400).json({ message: 'ingredients array is required' });

  const { error: delError } = await req.supabase.from('menu_item_ingredients').delete().eq('menu_item_id', req.params.menuItemId);
  if (delError) return res.status(400).json({ message: delError.message });

  if (ingredients.length === 0) return res.json([]);

  const rows = ingredients
    .filter((i) => i.ingredientId && Number(i.quantity) > 0)
    .map((i) => ({ menu_item_id: req.params.menuItemId, ingredient_id: i.ingredientId, quantity: Number(i.quantity) }));

  const { data, error } = await req.supabase.from('menu_item_ingredients').insert(rows).select();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// --- Purchase Orders ---
const listPurchaseOrders = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('purchase_orders')
    .select('*, suppliers(name), purchase_order_items(*, ingredients(name, unit))')
    .eq('business_id', req.params.businessId)
    .order('ordered_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createPurchaseOrder = asyncHandler(async (req, res) => {
  const { supplierId = null, items } = req.body; // items: [{ ingredientId, quantity, unitCostAed }]
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'At least one item is required' });

  const totalCost = items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCostAed), 0);

  const { data: po, error } = await req.supabase
    .from('purchase_orders')
    .insert({ business_id: req.params.businessId, supplier_id: supplierId, total_cost_aed: totalCost, created_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  const rows = items.map((i) => ({
    purchase_order_id: po.id,
    ingredient_id: i.ingredientId,
    quantity: Number(i.quantity),
    unit_cost_aed: Number(i.unitCostAed),
  }));
  const { error: itemsError } = await req.supabase.from('purchase_order_items').insert(rows);
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  res.status(201).json(po);
});

// Marking a PO received is what actually moves stock - creating the PO
// alone doesn't touch inventory, since the goods haven't arrived yet.
// Updates each ingredient's stock and recalculates a weighted-average
// cost per unit, so cost-per-dish reporting reflects real purchase
// prices over time rather than a single stale number.
//
// Supports PARTIAL receiving: body may include `items: [{ purchaseOrderItemId,
// receivedQuantity }]` to receive only some of each line (a short-shipped
// delivery, or a second truck arriving later) - omit `items` entirely to
// receive everything outstanding in one shot, same as before. Each call
// only moves the NEWLY received amount (this call's quantity minus what
// was already received on that line), so calling it twice on the same
// line never double-counts stock.
const receivePurchaseOrder = asyncHandler(async (req, res) => {
  const { items: receivedItems } = req.body;

  const { data: po } = await req.supabase
    .from('purchase_orders')
    .select('*, purchase_order_items(*)')
    .eq('id', req.params.poId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!po) return res.status(404).json({ message: 'Purchase order not found' });
  if (po.status === 'received') return res.status(400).json({ message: 'Already received' });
  if (po.status === 'cancelled') return res.status(400).json({ message: 'This purchase order was cancelled' });

  const receivedMap = new Map((receivedItems || []).map((r) => [r.purchaseOrderItemId, Number(r.receivedQuantity)]));

  let allLinesComplete = true;
  for (const item of po.purchase_order_items) {
    const alreadyReceived = Number(item.received_quantity || 0);
    const remaining = Number(item.quantity) - alreadyReceived;
    if (remaining <= 0) continue; // this line was already fully received in an earlier partial call

    // No explicit `items` body = receive everything still outstanding on
    // every line, preserving the original one-shot "receive it all" behavior.
    const receivingNow = receivedMap.has(item.id) ? Math.min(remaining, Math.max(0, receivedMap.get(item.id))) : remaining;
    if (receivingNow <= 0) { allLinesComplete = false; continue; }
    if (receivingNow < remaining) allLinesComplete = false;

    const { data: ingredient } = await req.supabase.from('ingredients').select('*').eq('id', item.ingredient_id).single();
    if (!ingredient) continue;

    const existingValue = Number(ingredient.stock_qty) * Number(ingredient.cost_per_unit);
    const incomingValue = receivingNow * Number(item.unit_cost_aed);
    const newQty = Number(ingredient.stock_qty) + receivingNow;
    const newAvgCost = newQty > 0 ? (existingValue + incomingValue) / newQty : ingredient.cost_per_unit;

    await req.supabase.from('ingredients').update({ stock_qty: newQty, cost_per_unit: newAvgCost }).eq('id', item.ingredient_id);
    await req.supabase.from('purchase_order_items').update({ received_quantity: alreadyReceived + receivingNow }).eq('id', item.id);
    await req.supabase.from('stock_movements').insert({
      business_id: req.params.businessId,
      ingredient_id: item.ingredient_id,
      change_qty: receivingNow,
      reason: 'purchase',
      purchase_order_id: po.id,
      created_by: req.user.id,
    });
  }

  const newStatus = allLinesComplete ? 'received' : 'partially_received';
  const { data: updated, error } = await req.supabase
    .from('purchase_orders')
    .update({ status: newStatus, received_at: newStatus === 'received' ? new Date().toISOString() : po.received_at })
    .eq('id', req.params.poId)
    .select('*, suppliers(name), purchase_order_items(*, ingredients(name, unit))')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(updated);
});

module.exports = {
  listSuppliers, createSupplier,
  listIngredients, createIngredient, updateIngredient, deleteIngredient, adjustStock,
  recordWaste, getWasteReport, getLowStock, getValuation,
  getMenuItemFoodCost, getActualFoodCost,
  getRecipe, setRecipe,
  listPurchaseOrders, createPurchaseOrder, receivePurchaseOrder,
};
