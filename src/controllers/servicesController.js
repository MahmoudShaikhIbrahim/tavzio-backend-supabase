const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/services
const listServices = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('services')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('sort_order');

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/services
const createService = asyncHandler(async (req, res) => {
  const { name, description, price, durationMinutes, sortOrder = 0 } = req.body;
  const { data, error } = await req.supabase
    .from('services')
    .insert({
      business_id: req.params.businessId,
      name,
      description: description || '',
      price: price || 0,
      duration_minutes: durationMinutes || 30,
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/services/:serviceId
const updateService = asyncHandler(async (req, res) => {
  const { name, description, price, durationMinutes, isAvailable, sortOrder } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (price !== undefined) update.price = price;
  if (durationMinutes !== undefined) update.duration_minutes = durationMinutes;
  if (isAvailable !== undefined) update.is_available = isAvailable;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('services')
    .update(update)
    .eq('id', req.params.serviceId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Service not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/services/:serviceId
const deleteService = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('services')
    .delete({ count: 'exact' })
    .eq('id', req.params.serviceId)
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Service not found' });
  res.json({ message: 'Service deleted' });
});

// @route GET /api/businesses/:businessId/services/:serviceId/options
const listServiceOptions = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('service_options')
    .select('*')
    .eq('service_id', req.params.serviceId)
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/services/:serviceId/options
const createServiceOption = asyncHandler(async (req, res) => {
  const { label, priceDelta = 0, sortOrder = 0 } = req.body;
  if (!label?.trim()) return res.status(400).json({ message: 'A label is required (e.g. "With cake")' });
  const { data, error } = await req.supabase
    .from('service_options')
    .insert({ service_id: req.params.serviceId, label: label.trim(), price_delta: priceDelta, sort_order: sortOrder })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/services/:serviceId/options/:optionId
const updateServiceOption = asyncHandler(async (req, res) => {
  const { label, priceDelta, sortOrder } = req.body;
  const update = {};
  if (label !== undefined) update.label = label.trim();
  if (priceDelta !== undefined) update.price_delta = priceDelta;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('service_options')
    .update(update)
    .eq('id', req.params.optionId)
    .eq('service_id', req.params.serviceId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Option not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/services/:serviceId/options/:optionId
const deleteServiceOption = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('service_options')
    .delete({ count: 'exact' })
    .eq('id', req.params.optionId)
    .eq('service_id', req.params.serviceId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Option not found' });
  res.json({ message: 'Option deleted' });
});

module.exports = { listServices, createService, updateService, deleteService, listServiceOptions, createServiceOption, updateServiceOption, deleteServiceOption };
