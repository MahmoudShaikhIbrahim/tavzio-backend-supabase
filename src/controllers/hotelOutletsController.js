const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');

// @route GET /api/businesses/:businessId/hotel/outlets
const listOutlets = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_outlets')
    .select('*, hotel_outlet_items(id, menu_item_id, price_override_aed, available)')
    .eq('business_id', req.params.businessId)
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hotel/outlets
// Body: { name, outletType, location, openingHours, sortOrder }
const createOutlet = asyncHandler(async (req, res) => {
  const { name, outletType, location = '', openingHours = '', sortOrder = 0 } = req.body;
  if (!name || !outletType) return res.status(400).json({ message: 'name and outletType are required' });
  const { data, error } = await req.supabase
    .from('hotel_outlets')
    .insert({ business_id: req.params.businessId, name, outlet_type: outletType, location, opening_hours: openingHours, sort_order: sortOrder })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/hotel/outlets/:outletId
const updateOutlet = asyncHandler(async (req, res) => {
  const { name, enabled, location, openingHours, sortOrder } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (location !== undefined) patch.location = location;
  if (openingHours !== undefined) patch.opening_hours = openingHours;
  if (sortOrder !== undefined) patch.sort_order = sortOrder;
  const { data, error } = await req.supabase
    .from('hotel_outlets')
    .update(patch)
    .eq('id', req.params.outletId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Outlet not found' });
  res.json(data);
});

const deleteOutlet = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_outlets')
    .delete({ count: 'exact' })
    .eq('id', req.params.outletId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Outlet not found' });
  res.json({ message: 'Outlet deleted' });
});

// @route PUT /api/businesses/:businessId/hotel/outlets/:outletId/items
// Body: { menuItemIds: string[] }
// Full-replace, same pattern as recipe-setting elsewhere - simplest
// correct way to let an owner just check/uncheck items in a picker
// without diffing adds/removes client-side.
const setOutletItems = asyncHandler(async (req, res) => {
  const { menuItemIds } = req.body;
  if (!Array.isArray(menuItemIds)) return res.status(400).json({ message: 'menuItemIds must be an array' });

  const { data: outlet } = await req.supabase.from('hotel_outlets').select('id').eq('id', req.params.outletId).eq('business_id', req.params.businessId).single();
  if (!outlet) return res.status(404).json({ message: 'Outlet not found' });

  await req.supabase.from('hotel_outlet_items').delete().eq('outlet_id', req.params.outletId);
  if (menuItemIds.length > 0) {
    const { error } = await req.supabase
      .from('hotel_outlet_items')
      .insert(menuItemIds.map((id) => ({ outlet_id: req.params.outletId, menu_item_id: id })));
    if (error) return res.status(400).json({ message: error.message });
  }
  res.json({ message: 'Outlet items updated' });
});

// @route GET /api/public/hotel/:slug/room/:roomId/outlets
// No login required - the guest portal's menu source. Returns only
// enabled outlets, each with its live menu items (name/price/image/
// description straight from the shared menu engine, with any per-outlet
// price override applied).
const listPublicOutlets = asyncHandler(async (req, res) => {
  const { data: business } = await supabaseAdmin.from('businesses').select('id, category').eq('slug', req.params.slug).eq('status', 'active').single();
  if (!business || business.category !== 'hotel') return res.status(404).json({ message: 'Not found' });

  const { data: outlets } = await supabaseAdmin
    .from('hotel_outlets')
    .select('id, name, outlet_type, location, opening_hours')
    .eq('business_id', business.id)
    .eq('enabled', true)
    .order('sort_order');

  const results = [];
  for (const outlet of outlets || []) {
    const { data: outletItems } = await supabaseAdmin
      .from('hotel_outlet_items')
      .select('menu_item_id, price_override_aed, available, menu_items(id, name, description, price, image_url, category_id, is_available)')
      .eq('outlet_id', outlet.id)
      .eq('available', true);

    const items = (outletItems || [])
      .filter((oi) => oi.menu_items?.is_available)
      .map((oi) => ({
        id: oi.menu_items.id,
        name: oi.menu_items.name,
        description: oi.menu_items.description,
        price: oi.price_override_aed != null ? Number(oi.price_override_aed) : Number(oi.menu_items.price),
        imageUrl: oi.menu_items.image_url,
        categoryId: oi.menu_items.category_id,
      }));

    results.push({ id: outlet.id, name: outlet.name, outletType: outlet.outlet_type, location: outlet.location, openingHours: outlet.opening_hours, items });
  }
  res.json(results);
});

module.exports = { listOutlets, createOutlet, updateOutlet, deleteOutlet, setOutletItems, listPublicOutlets };
