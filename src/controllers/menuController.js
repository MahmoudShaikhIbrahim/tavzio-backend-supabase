const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/menu/categories
const listCategories = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('menu_categories')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('sort_order');

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/menu/categories
const createCategory = asyncHandler(async (req, res) => {
  const { name, sortOrder = 0 } = req.body;
  const { data, error } = await req.supabase
    .from('menu_categories')
    .insert({ business_id: req.params.businessId, name, sort_order: sortOrder })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/menu/categories/:categoryId
const updateCategory = asyncHandler(async (req, res) => {
  const { name, sortOrder } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('menu_categories')
    .update(update)
    .eq('id', req.params.categoryId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Category not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/menu/categories/:categoryId
const deleteCategory = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('menu_categories')
    .delete({ count: 'exact' })
    .eq('id', req.params.categoryId)
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Category not found' });
  res.json({ message: 'Category deleted' });
});

// @route GET /api/businesses/:businessId/menu/items
const listItems = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('menu_items')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('sort_order');

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/menu/items
const createItem = asyncHandler(async (req, res) => {
  const { categoryId, name, description, price, imageUrl, sortOrder = 0 } = req.body;
  const { data, error } = await req.supabase
    .from('menu_items')
    .insert({
      business_id: req.params.businessId,
      category_id: categoryId || null,
      name,
      description: description || '',
      price: price || 0,
      image_url: imageUrl || '',
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/menu/items/:itemId
const updateItem = asyncHandler(async (req, res) => {
  const { categoryId, name, description, price, imageUrl, isAvailable, sortOrder } = req.body;
  const update = {};
  if (categoryId !== undefined) update.category_id = categoryId;
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (price !== undefined) update.price = price;
  if (imageUrl !== undefined) update.image_url = imageUrl;
  if (isAvailable !== undefined) update.is_available = isAvailable;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('menu_items')
    .update(update)
    .eq('id', req.params.itemId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Item not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/menu/items/:itemId
const deleteItem = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('menu_items')
    .delete({ count: 'exact' })
    .eq('id', req.params.itemId)
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Item not found' });
  res.json({ message: 'Item deleted' });
});

// @route GET /api/businesses/:businessId/menu/items/:itemId/addons
const listAddons = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('menu_item_addons')
    .select('*')
    .eq('menu_item_id', req.params.itemId)
    .order('sort_order');

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/menu/items/:itemId/addons
const createAddon = asyncHandler(async (req, res) => {
  const { name, price, sortOrder = 0 } = req.body;
  const { data, error } = await req.supabase
    .from('menu_item_addons')
    .insert({ menu_item_id: req.params.itemId, name, price: price || 0, sort_order: sortOrder })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/menu/items/:itemId/addons/:addonId
const updateAddon = asyncHandler(async (req, res) => {
  const { name, price, sortOrder } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (price !== undefined) update.price = price;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('menu_item_addons')
    .update(update)
    .eq('id', req.params.addonId)
    .eq('menu_item_id', req.params.itemId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Add-on not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/menu/items/:itemId/addons/:addonId
const deleteAddon = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('menu_item_addons')
    .delete({ count: 'exact' })
    .eq('id', req.params.addonId)
    .eq('menu_item_id', req.params.itemId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Add-on not found' });
  res.json({ message: 'Add-on deleted' });
});

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listItems, createItem, updateItem, deleteItem,
  listAddons, createAddon, updateAddon, deleteAddon,
};
