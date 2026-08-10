const { supabaseAdmin } = require('../config/supabaseClient');

// Checks whether current ingredient stock can cover this set of order
// items (via each menu item's recipe). Read-only - never deducts.
async function checkStockAvailability({ orderItemRows }) {
  const menuItemIds = orderItemRows.map((i) => i.menu_item_id);
  const { data: recipeRows } = await supabaseAdmin
    .from('menu_item_ingredients')
    .select('menu_item_id, ingredient_id, quantity, ingredients(id, name, unit, stock_qty)')
    .in('menu_item_id', menuItemIds);

  if (!recipeRows || recipeRows.length === 0) return { ok: true };

  const required = new Map();
  for (const item of orderItemRows) {
    const recipesForItem = recipeRows.filter((r) => r.menu_item_id === item.menu_item_id);
    for (const r of recipesForItem) {
      const needed = Number(r.quantity) * item.quantity;
      const existing = required.get(r.ingredient_id);
      required.set(r.ingredient_id, { qty: (existing?.qty || 0) + needed, ingredient: r.ingredients });
    }
  }

  for (const [, { qty, ingredient }] of required) {
    if (!ingredient) continue;
    if (Number(ingredient.stock_qty) < qty) {
      return { ok: false, message: `Not enough ${ingredient.name} in stock to fulfill this order` };
    }
  }
  return { ok: true };
}

// Deducts stock for this set of order items and logs the movement.
// Call only after the order itself has actually been created (needs a
// real orderId for the movement log) and after checkStockAvailability
// has already confirmed there's enough to deduct.
async function deductStock({ businessId, orderItemRows, orderId }) {
  const menuItemIds = orderItemRows.map((i) => i.menu_item_id);
  const { data: recipeRows } = await supabaseAdmin
    .from('menu_item_ingredients')
    .select('menu_item_id, ingredient_id, quantity')
    .in('menu_item_id', menuItemIds);
  if (!recipeRows || recipeRows.length === 0) return;

  const required = new Map();
  for (const item of orderItemRows) {
    const recipesForItem = recipeRows.filter((r) => r.menu_item_id === item.menu_item_id);
    for (const r of recipesForItem) {
      const needed = Number(r.quantity) * item.quantity;
      required.set(r.ingredient_id, (required.get(r.ingredient_id) || 0) + needed);
    }
  }

  for (const [ingredientId, qty] of required) {
    const { data: current } = await supabaseAdmin.from('ingredients').select('stock_qty').eq('id', ingredientId).single();
    if (!current) continue;
    await supabaseAdmin.from('ingredients').update({ stock_qty: Number(current.stock_qty) - qty }).eq('id', ingredientId);
    await supabaseAdmin.from('stock_movements').insert({
      business_id: businessId,
      ingredient_id: ingredientId,
      change_qty: -qty,
      reason: 'order',
      order_id: orderId || null,
    });
  }
}

module.exports = { checkStockAvailability, deductStock };
