const asyncHandler = require('../utils/asyncHandler');
const { translateToAllLanguages } = require('../utils/translate');
const { supabaseAdmin } = require('../config/supabaseClient');

// Same 30-minute tap-token validity window used everywhere else a
// request must follow a real, recent tap - kept as its own constant
// here rather than imported from publicController.js, since that file
// doesn't export it and re-declaring one small constant is safer than
// creating a cross-controller dependency for it.
const TAP_TOKEN_VALID_MINUTES = 30;

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
  const { label, icon, imageUrl, url, sortOrder = 0, buttonType = 'link', notificationDestination = 'general', targetSection = null, parentButtonId = null } = req.body;
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
      button_type: buttonType,
      notification_destination: notificationDestination,
      target_section: targetSection,
      parent_button_id: parentButtonId,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/custom-buttons/:buttonId
const updateCustomButton = asyncHandler(async (req, res) => {
  const { label, icon, imageUrl, url, enabled, sortOrder, buttonType, notificationDestination, targetSection, parentButtonId } = req.body;
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
  if (buttonType !== undefined) update.button_type = buttonType;
  if (notificationDestination !== undefined) update.notification_destination = notificationDestination;
  if (targetSection !== undefined) update.target_section = targetSection;
  if (parentButtonId !== undefined) update.parent_button_id = parentButtonId;

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

// Resolves the room a tap's card is currently linked to, if any - the
// same room-stand link the Front Desk RoomsTab already manages. Shared
// by both destination branches below that need a real room, rather than
// duplicated.
// Resolves the room a tap's card is currently linked to, if any - real
// bug found and fixed here: this used to query hotel_rooms.card_id, a
// relationship that was never actually set by any code path in this
// system. The real link (see updateCard/cardController.js) is stored
// the other direction - cards.room_id, on the card itself. This means
// Housekeeping/Maintenance routing could never have worked before this
// fix, regardless of whether a stand was actually connected to a room.
async function resolveRoomFromCard(cardId) {
  if (!cardId) return null;
  const { data: card } = await supabaseAdmin.from('cards').select('room_id').eq('id', cardId).maybeSingle();
  return card?.room_id || null;
}

// @route POST /api/public/business/:slug/custom-buttons/:buttonId/request
// Body: { tapEventId }
// Where the request actually goes depends entirely on the button's own
// notification_destination - confirmed design: Housekeeping and
// Maintenance never touch the generic orders/Requests table at all,
// they land directly in the real, purpose-built systems staff already
// use for those, with real status tracking. Everything else stays on
// the existing Requests list, tagged with whichever section (if any)
// the owner assigned it to.
const submitCustomButtonRequest = asyncHandler(async (req, res) => {
  const { tapEventId, note = '' } = req.body;
  if (!tapEventId) return res.status(400).json({ message: 'tapEventId is required' });

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: button } = await supabaseAdmin
    .from('custom_buttons')
    .select('id, label, business_id, button_type, enabled, notification_destination, target_section')
    .eq('id', req.params.buttonId)
    .eq('business_id', business.id)
    .maybeSingle();
  if (!button || button.button_type !== 'notification' || !button.enabled) {
    return res.status(404).json({ message: 'This request is not available' });
  }

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent) {
    return res.status(400).json({ message: 'Requests must follow a real tap, and this one has expired or is invalid' });
  }

  if (button.notification_destination === 'housekeeping_task') {
    const roomId = await resolveRoomFromCard(tapEvent.card_id);
    if (!roomId) return res.status(400).json({ message: 'This stand is not linked to a room, so a housekeeping task cannot be created for it' });
    const { data: task, error } = await supabaseAdmin
      .from('housekeeping_tasks')
      .insert({ business_id: business.id, room_id: roomId, task_type: 'cleaning', notes: button.label })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    return res.status(201).json({ housekeepingTask: task });
  }

  if (button.notification_destination === 'maintenance_ticket') {
    // room_id is nullable here on purpose (see migration 0039) - a
    // maintenance issue can be a common area, not tied to any one room,
    // unlike housekeeping which always means a specific room.
    const roomId = await resolveRoomFromCard(tapEvent.card_id);
    const { data: ticket, error } = await supabaseAdmin
      .from('maintenance_tickets')
      .insert({ business_id: business.id, room_id: roomId, title: button.label, priority: 'normal' })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    return res.status(201).json({ maintenanceTicket: ticket });
  }

  // 'general' destination - the existing Requests flow, tagged with
  // whichever section the owner assigned (or none, meaning everyone
  // with Requests access sees it, same as today).
  let tableLabel = '';
  if (tapEvent.card_id) {
    const { data: card } = await supabaseAdmin.from('cards').select('label').eq('id', tapEvent.card_id).maybeSingle();
    tableLabel = card?.label || '';
  }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      table_label: tableLabel,
      note: '',
      total: 0,
      request_type: 'custom',
      custom_request_label: note.trim() ? `${button.label}: ${note.trim()}` : button.label,
      target_section: button.target_section,
      // Explicit, not relying on the column default - same fix, same
      // reasoning, as publicController.js's submitOrder.
      source: 'customer_tap',
      source_event_id: tapEventId,
      pos_sync_status: 'not_applicable',
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json({ order });
});

module.exports = { listCustomButtons, createCustomButton, updateCustomButton, deleteCustomButton, submitCustomButtonRequest };
