const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/admin/demo/menu-items
const listDemoMenuItems = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('demo_menu_items')
    .select('*')
    .order('category')
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/admin/demo/menu-items
const createDemoMenuItem = asyncHandler(async (req, res) => {
  const { name, description = '', priceAed, imageUrl = '', category = 'Main', sortOrder = 0 } = req.body;
  if (!name || priceAed == null) return res.status(400).json({ message: 'name and priceAed are required' });
  const { data, error } = await req.supabase
    .from('demo_menu_items')
    .insert({ name, description, price_aed: Number(priceAed), image_url: imageUrl, category, sort_order: Number(sortOrder) })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/admin/demo/menu-items/:itemId
const updateDemoMenuItem = asyncHandler(async (req, res) => {
  const { name, description, priceAed, imageUrl, category, sortOrder, enabled } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (priceAed !== undefined) update.price_aed = Number(priceAed);
  if (imageUrl !== undefined) update.image_url = imageUrl;
  if (category !== undefined) update.category = category;
  if (sortOrder !== undefined) update.sort_order = Number(sortOrder);
  if (enabled !== undefined) update.enabled = enabled;

  const { data, error } = await req.supabase
    .from('demo_menu_items')
    .update(update)
    .eq('id', req.params.itemId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Demo item not found' });
  res.json(data);
});

// @route DELETE /api/admin/demo/menu-items/:itemId
const deleteDemoMenuItem = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase.from('demo_menu_items').delete({ count: 'exact' }).eq('id', req.params.itemId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Demo item not found' });
  res.json({ message: 'Deleted' });
});

// @route POST /api/admin/demo/menu-items/import
// Body: { businessId: string }
// A ONE-TIME copy, not a live link - confirmed requirement: the real
// business (Al Bait) may be deleted later, and the demo must keep
// working afterward. This reads Al Bait's current menu once and writes
// independent rows into demo_menu_items; nothing here stores a
// foreign key back to the source business, so there is nothing left to
// break when that account is eventually deleted. Calling this again
// later (e.g. to refresh from an updated real menu) simply adds more
// independent copies - it does not touch or replace existing demo
// items, so re-running it is safe but not a "sync."
const importFromBusiness = asyncHandler(async (req, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ message: 'businessId is required' });

  const { data: sourceItems, error } = await req.supabase
    .from('menu_items')
    .select('name, description, price, image_url, is_available, sort_order, menu_categories(name)')
    .eq('business_id', businessId)
    .eq('is_available', true);
  if (error) return res.status(400).json({ message: error.message });
  if (!sourceItems || sourceItems.length === 0) {
    return res.status(400).json({ message: 'That business has no available menu items to copy' });
  }

  const rows = sourceItems.map((item) => ({
    name: item.name,
    description: item.description || '',
    price_aed: item.price,
    image_url: item.image_url || '',
    category: item.menu_categories?.name || 'Main',
    sort_order: item.sort_order || 0,
  }));

  const { data: inserted, error: insertError } = await req.supabase.from('demo_menu_items').insert(rows).select();
  if (insertError) return res.status(400).json({ message: insertError.message });
  res.status(201).json({ message: `Imported ${inserted.length} item(s) as independent demo copies`, items: inserted });
});

// @route GET /api/admin/demo/settings
const getDemoSettingsAdmin = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('demo_settings').select('*').eq('id', 1).single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/admin/demo/settings
const updateDemoSettings = asyncHandler(async (req, res) => {
  const { businessName, coverImageUrl } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (businessName !== undefined) update.business_name = businessName;
  if (coverImageUrl !== undefined) update.cover_image_url = coverImageUrl;

  const { data, error } = await req.supabase.from('demo_settings').update(update).eq('id', 1).select().single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listDemoMenuItems, createDemoMenuItem, updateDemoMenuItem, deleteDemoMenuItem, importFromBusiness, getDemoSettingsAdmin, updateDemoSettings };
