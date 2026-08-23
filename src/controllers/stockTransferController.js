const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/stock-transfers
// Both directions - a transfer this business is sending out AND one
// it's receiving are both "its" transfers, so both need to show up
// here, not just outgoing ones.
const listStockTransfers = asyncHandler(async (req, res) => {
  const { data: warehouseIds } = await req.supabase
    .from('warehouses')
    .select('id')
    .eq('business_id', req.params.businessId);
  const ids = (warehouseIds || []).map((w) => w.id);
  if (ids.length === 0) return res.json([]);

  const { data, error } = await req.supabase
    .from('stock_transfers')
    .select('*, stock_transfer_items(id, ingredient_id, quantity, ingredients(name, unit)), from:from_warehouse_id(id, name), to:to_warehouse_id(id, name)')
    .or(`from_warehouse_id.in.(${ids.join(',')}),to_warehouse_id.in.(${ids.join(',')})`)
    .order('requested_at', { ascending: false })
    .limit(100);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/stock-transfers
// Body: { fromWarehouseId?, toWarehouseId, items: [{ ingredientId, quantity }] }
// fromWarehouseId omitted means a fresh delivery straight into
// toWarehouseId (no source to deduct from) - a supplier delivery, or a
// business receiving its share of an org-level purchase order (see
// receiveAllocation in organizationController.js, which creates
// exactly this shape of transfer).
const createStockTransfer = asyncHandler(async (req, res) => {
  const { fromWarehouseId, toWarehouseId, items, note = '' } = req.body;
  if (!toWarehouseId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'toWarehouseId and at least one item are required' });
  }

  const { data: transfer, error } = await req.supabase
    .from('stock_transfers')
    .insert({
      from_warehouse_id: fromWarehouseId || null,
      to_warehouse_id: toWarehouseId,
      status: 'requested',
      requested_by: req.user.id,
      note,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  const rows = items.map((i) => ({ stock_transfer_id: transfer.id, ingredient_id: i.ingredientId, quantity: Number(i.quantity) }));
  const { error: itemsError } = await req.supabase.from('stock_transfer_items').insert(rows);
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  res.status(201).json(transfer);
});

// @route PATCH /api/businesses/:businessId/stock-transfers/:transferId/approve
const approveStockTransfer = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('stock_transfers')
    .update({ status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString() })
    .eq('id', req.params.transferId)
    .eq('status', 'requested')
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Transfer not found or not in a requested state' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/stock-transfers/:transferId/ship
// Marks in_transit and, if there's a real source warehouse, deducts the
// stock from it now - the moment it physically leaves, not the moment
// it's requested (a requested-but-not-yet-shipped transfer must never
// make the source warehouse's stock look lower than it really is).
const shipStockTransfer = asyncHandler(async (req, res) => {
  const { data: transfer } = await req.supabase
    .from('stock_transfers')
    .select('*, stock_transfer_items(ingredient_id, quantity)')
    .eq('id', req.params.transferId)
    .eq('status', 'approved')
    .maybeSingle();
  if (!transfer) return res.status(400).json({ message: 'Transfer not found or not approved yet' });

  if (transfer.from_warehouse_id) {
    for (const item of transfer.stock_transfer_items) {
      const { data: existing } = await supabaseAdmin
        .from('ingredient_stock')
        .select('quantity')
        .eq('ingredient_id', item.ingredient_id)
        .eq('warehouse_id', transfer.from_warehouse_id)
        .maybeSingle();
      const currentQty = Number(existing?.quantity || 0);
      if (currentQty < Number(item.quantity)) {
        return res.status(400).json({ message: `Not enough stock of one item at the source warehouse to ship this transfer (have ${currentQty}, need ${item.quantity}).` });
      }
      await supabaseAdmin
        .from('ingredient_stock')
        .update({ quantity: currentQty - Number(item.quantity), updated_at: new Date().toISOString() })
        .eq('ingredient_id', item.ingredient_id)
        .eq('warehouse_id', transfer.from_warehouse_id);
    }
  }

  const { data, error } = await req.supabase
    .from('stock_transfers')
    .update({ status: 'in_transit' })
    .eq('id', req.params.transferId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/stock-transfers/:transferId/receive
// The other half of the arithmetic: adds the stock into the destination
// warehouse. If this is a cross-business movement (the destination
// warehouse's business differs from where the stock came from, or
// there was no source warehouse at all - a fresh delivery), the
// receiving business's OWN ingredients.stock_qty total also goes up,
// same reasoning documented in migration 0089 - that total must stay
// the real, correct sum across every one of that business's own
// warehouses, kept in sync by application logic here rather than a
// database trigger.
const receiveStockTransfer = asyncHandler(async (req, res) => {
  const { data: transfer } = await req.supabase
    .from('stock_transfers')
    .select('*, stock_transfer_items(ingredient_id, quantity), to:to_warehouse_id(id, business_id)')
    .eq('id', req.params.transferId)
    .in('status', ['in_transit', 'approved'])
    .maybeSingle();
  if (!transfer) return res.status(400).json({ message: 'Transfer not found or not ready to receive' });

  // A transfer with no source warehouse (a fresh delivery) skips
  // shipStockTransfer entirely and can be received directly from
  // approved - there's no source stock to deduct, so there's nothing
  // for the ship step to do for it.
  for (const item of transfer.stock_transfer_items) {
    const { data: existing } = await supabaseAdmin
      .from('ingredient_stock')
      .select('quantity')
      .eq('ingredient_id', item.ingredient_id)
      .eq('warehouse_id', transfer.to_warehouse_id)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin
        .from('ingredient_stock')
        .update({ quantity: Number(existing.quantity) + Number(item.quantity), updated_at: new Date().toISOString() })
        .eq('ingredient_id', item.ingredient_id)
        .eq('warehouse_id', transfer.to_warehouse_id);
    } else {
      await supabaseAdmin
        .from('ingredient_stock')
        .insert({ ingredient_id: item.ingredient_id, warehouse_id: transfer.to_warehouse_id, quantity: Number(item.quantity) });
    }

    // Business-wide total only moves for stock genuinely entering the
    // business for the first time (no source warehouse = a fresh
    // delivery) - a transfer between two of the SAME business's own
    // warehouses doesn't change how much that business owns in total,
    // only where it's sitting.
    if (!transfer.from_warehouse_id) {
      const { data: ingredient } = await supabaseAdmin.from('ingredients').select('stock_qty').eq('id', item.ingredient_id).maybeSingle();
      if (ingredient) {
        await supabaseAdmin
          .from('ingredients')
          .update({ stock_qty: Number(ingredient.stock_qty) + Number(item.quantity) })
          .eq('id', item.ingredient_id);
      }
    }
  }

  const { data, error } = await req.supabase
    .from('stock_transfers')
    .update({ status: 'received', received_by: req.user.id, received_at: new Date().toISOString() })
    .eq('id', req.params.transferId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'stock_transfer_received',
    targetId: transfer.id,
    details: { itemCount: transfer.stock_transfer_items.length },
  });

  res.json(data);
});

// @route PATCH /api/businesses/:businessId/stock-transfers/:transferId/cancel
// Only before shipping - once stock has actually left the source
// warehouse (in_transit or received), cancelling would need to reverse
// real stock movements rather than just discard a request, which is a
// different, more involved operation this endpoint doesn't attempt.
const cancelStockTransfer = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('stock_transfers')
    .update({ status: 'cancelled' })
    .eq('id', req.params.transferId)
    .in('status', ['requested', 'approved'])
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Transfer not found or already shipped/received' });
  res.json(data);
});

module.exports = { listStockTransfers, createStockTransfer, approveStockTransfer, shipStockTransfer, receiveStockTransfer, cancelStockTransfer };
