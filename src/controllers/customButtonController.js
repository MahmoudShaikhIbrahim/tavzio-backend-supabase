const asyncHandler = require('../utils/asyncHandler');
const { translateToAllLanguages } = require('../utils/translate');

// @route GET /api/businesses/:businessId/custom-buttons
const listCustomButtons = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('custom_buttons')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('sort_order');

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/custom-buttons
const createCustomButton = asyncHandler(async (req, res) => {
  const { label, icon, imageUrl, url, sortOrder = 0 } = req.body;
  const labelI18n = await translateToAllLanguages(label).catch(() => ({}));
  const { data, error } = await req.supabase
    .from('custom_buttons')
    .insert({
      business_id: req.params.businessId,
      label,
      label_i18n: labelI18n,
      icon: icon || 'link',
      image_url: imageUrl || null,
      url: url || '',
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/custom-buttons/:buttonId
const updateCustomButton = asyncHandler(async (req, res) => {
  const { label, icon, imageUrl, url, enabled, sortOrder } = req.body;
  const update = {};
  if (label !== undefined) {
    update.label = label;
    update.label_i18n = await translateToAllLanguages(label).catch(() => ({}));
  }
  if (icon !== undefined) update.icon = icon;
  if (imageUrl !== undefined) update.image_url = imageUrl;
  if (url !== undefined) update.url = url;
  if (enabled !== undefined) update.enabled = enabled;
  if (sortOrder !== undefined) update.sort_order = sortOrder;

  const { data, error } = await req.supabase
    .from('custom_buttons')
    .update(update)
    .eq('id', req.params.buttonId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Button not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/custom-buttons/:buttonId
const deleteCustomButton = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('custom_buttons')
    .delete({ count: 'exact' })
    .eq('id', req.params.buttonId)
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Button not found' });
  res.json({ message: 'Button deleted' });
});

module.exports = { listCustomButtons, createCustomButton, updateCustomButton, deleteCustomButton };
