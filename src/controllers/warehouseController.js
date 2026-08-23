const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/warehouses
const listWarehouses = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('warehouses')
    .select('*, ingredient_stock(ingredient_id, quantity)')
    .eq('business_id', req.params.businessId)
    .order('created_at');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/warehouses
const createWarehouse = asyncHandler(async (req, res) => {
  const { name, type = 'general', address = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await req.supabase
    .from('warehouses')
    .insert({ name, type, address, business_id: req.params.businessId })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/warehouses/:warehouseId
const updateWarehouse = asyncHandler(async (req, res) => {
  const { name, type, address } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (type !== undefined) update.type = type;
  if (address !== undefined) update.address = address;

  const { data, error } = await req.supabase
    .from('warehouses')
    .update(update)
    .eq('id', req.params.warehouseId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Warehouse not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/warehouses/:warehouseId
// Blocked if it still holds any stock - deleting a warehouse with real
// stock in it would silently make that stock disappear rather than
// forcing it to be transferred out first, the same "explainable, never
// silent" discipline stock_movements already enforces everywhere else
// in this schema.
const deleteWarehouse = asyncHandler(async (req, res) => {
  const { data: stock } = await req.supabase
    .from('ingredient_stock')
    .select('id')
    .eq('warehouse_id', req.params.warehouseId)
    .gt('quantity', 0)
    .limit(1);
  if (stock && stock.length > 0) {
    return res.status(400).json({ message: 'This warehouse still has stock in it - transfer it out first.' });
  }

  const { error, count } = await req.supabase
    .from('warehouses')
    .delete({ count: 'exact' })
    .eq('id', req.params.warehouseId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Warehouse not found' });
  res.json({ message: 'Deleted' });
});

// @route GET /api/businesses/:businessId/warehouses/:warehouseId/stock
// The per-location breakdown a business can now see once it's using
// more than one warehouse - joined with the ingredient's own name/unit
// so this reads as a real stock sheet, not a table of raw ids.
const getWarehouseStock = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('ingredient_stock')
    .select('quantity, ingredients(id, name, unit, low_stock_threshold)')
    .eq('warehouse_id', req.params.warehouseId)
    .order('ingredients(name)');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse, getWarehouseStock };
