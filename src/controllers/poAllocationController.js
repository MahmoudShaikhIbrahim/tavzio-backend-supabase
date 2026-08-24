const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/po-allocations?received=false
// What THIS business is waiting on from any org-level purchase order -
// never another member business's share, even though they came from
// the same PO.
const listPoAllocations = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('purchase_order_allocations')
    .select('*, purchase_order_items(item_name, item_unit, quantity, unit_cost_aed, purchase_orders(ordered_at, suppliers(name)))')
    .eq('business_id', req.params.businessId)
    .order('id', { ascending: false });
  if (req.query.received !== undefined) query = query.eq('received', req.query.received === 'true');

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/po-allocations/:allocationId/receive
// Body: { ingredientId, warehouseId }
// The business decides which of ITS OWN ingredients this delivery
// restocks, and which of its own warehouses to put it in - an org_owner
// splitting a bulk order across businesses doesn't (and shouldn't) need
// to know each business's internal ingredient-naming or warehouse
// layout. Real stock arithmetic, same reasoning as
// stockTransferController.js's receiveStockTransfer: this is stock
// genuinely entering the business for the first time, so both the
// specific warehouse's ingredient_stock AND the business-wide
// ingredients.stock_qty total go up together.
const receivePoAllocation = asyncHandler(async (req, res) => {
  const { ingredientId, warehouseId } = req.body;
  if (!ingredientId || !warehouseId) {
    return res.status(400).json({ message: 'ingredientId and warehouseId are required' });
  }

  const { data: allocation } = await req.supabase
    .from('purchase_order_allocations')
    .select('*, purchase_order_items(item_name, quantity)')
    .eq('id', req.params.allocationId)
    .eq('business_id', req.params.businessId)
    .eq('received', false)
    .maybeSingle();
  if (!allocation) return res.status(400).json({ message: 'Allocation not found or already received' });
  if (!allocation.purchase_order_items) {
    return res.status(400).json({ message: 'Could not load the purchase order item for this allocation - it may have been removed' });
  }

  // Real, not silent - the same explainable-stock-movement discipline
  // as everywhere else in this schema. Creating this as a proper
  // stock_transfer row (fully received immediately, since there's no
  // shipping leg for an org-PO delivery) means it shows up in this
  // business's normal transfer history alongside every other stock
  // movement, not as a special case invisible to that history.
  const { data: transfer, error: transferError } = await supabaseAdmin
    .from('stock_transfers')
    .insert({
      from_warehouse_id: null,
      to_warehouse_id: warehouseId,
      status: 'received',
      requested_by: req.user.id,
      received_by: req.user.id,
      received_at: new Date().toISOString(),
      note: `Org purchase order allocation - ${allocation.purchase_order_items.item_name}`,
    })
    .select()
    .single();
  if (transferError) return res.status(400).json({ message: transferError.message });

  await supabaseAdmin.from('stock_transfer_items').insert({
    stock_transfer_id: transfer.id,
    ingredient_id: ingredientId,
    quantity: allocation.quantity,
  });

  const { data: existing } = await supabaseAdmin
    .from('ingredient_stock')
    .select('quantity')
    .eq('ingredient_id', ingredientId)
    .eq('warehouse_id', warehouseId)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from('ingredient_stock')
      .update({ quantity: Number(existing.quantity) + Number(allocation.quantity), updated_at: new Date().toISOString() })
      .eq('ingredient_id', ingredientId)
      .eq('warehouse_id', warehouseId);
  } else {
    await supabaseAdmin.from('ingredient_stock').insert({ ingredient_id: ingredientId, warehouse_id: warehouseId, quantity: allocation.quantity });
  }

  const { data: ingredient } = await supabaseAdmin.from('ingredients').select('stock_qty').eq('id', ingredientId).maybeSingle();
  if (ingredient) {
    await supabaseAdmin.from('ingredients').update({ stock_qty: Number(ingredient.stock_qty) + Number(allocation.quantity) }).eq('id', ingredientId);
  }

  const { data: updatedAllocation, error } = await req.supabase
    .from('purchase_order_allocations')
    .update({
      received: true,
      received_at: new Date().toISOString(),
      received_into_warehouse_id: warehouseId,
      ingredient_id: ingredientId,
    })
    .eq('id', allocation.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'stock_transfer_received',
    targetId: transfer.id,
    details: { source: 'org_purchase_order_allocation', item: allocation.purchase_order_items.item_name, quantity: allocation.quantity },
  });

  res.json(updatedAllocation);
});

module.exports = { listPoAllocations, receivePoAllocation };
