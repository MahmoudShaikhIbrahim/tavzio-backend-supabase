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
const receivePurchaseOrder = asyncHandler(async (req, res) => {
  const { data: po } = await req.supabase
    .from('purchase_orders')
    .select('*, purchase_order_items(*)')
    .eq('id', req.params.poId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!po) return res.status(404).json({ message: 'Purchase order not found' });
  if (po.status === 'received') return res.status(400).json({ message: 'Already received' });

  for (const item of po.purchase_order_items) {
    const { data: ingredient } = await req.supabase.from('ingredients').select('*').eq('id', item.ingredient_id).single();
    if (!ingredient) continue;

    const existingValue = Number(ingredient.stock_qty) * Number(ingredient.cost_per_unit);
    const incomingValue = Number(item.quantity) * Number(item.unit_cost_aed);
    const newQty = Number(ingredient.stock_qty) + Number(item.quantity);
    const newAvgCost = newQty > 0 ? (existingValue + incomingValue) / newQty : ingredient.cost_per_unit;

    await req.supabase.from('ingredients').update({ stock_qty: newQty, cost_per_unit: newAvgCost }).eq('id', item.ingredient_id);
    await req.supabase.from('stock_movements').insert({
      business_id: req.params.businessId,
      ingredient_id: item.ingredient_id,
      change_qty: Number(item.quantity),
      reason: 'purchase',
      purchase_order_id: po.id,
      created_by: req.user.id,
    });
  }

  const { data: updated, error } = await req.supabase
    .from('purchase_orders')
    .update({ status: 'received', received_at: new Date().toISOString() })
    .eq('id', req.params.poId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(updated);
});

module.exports = {
  listSuppliers, createSupplier,
  listIngredients, createIngredient, updateIngredient, adjustStock,
  getRecipe, setRecipe,
  listPurchaseOrders, createPurchaseOrder, receivePurchaseOrder,
};
