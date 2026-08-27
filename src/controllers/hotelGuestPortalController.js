const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { calculateVatInclusive } = require('../utils/vat');

// Fallback only - used when a business has zero hotel_guest_services rows
// (a brand-new hotel that hasn't been seeded, or one created before this
// feature existed and never got migrated). Matches migration 0072's own
// seed values exactly, so the guest-facing list never silently changes
// depending on which path served it.
const DEFAULT_GUEST_SERVICES = [
  { id: 'default-towels', routingType: 'towels', label: 'Extra towels', options: [] },
  { id: 'default-turndown', routingType: 'turndown', label: 'Turndown service', options: [] },
  { id: 'default-housekeeping', routingType: 'housekeeping', label: 'Housekeeping', options: [] },
  { id: 'default-maintenance', routingType: 'maintenance', label: 'Report an issue', options: ['Air Conditioning', 'Lights', 'Bathroom', 'Door', 'TV', 'Electricity', 'Plumbing', 'Other'] },
  { id: 'default-laundry', routingType: 'laundry', label: 'Laundry pickup', options: ['Express', 'Same Day', 'Standard'] },
  { id: 'default-transportation', routingType: 'transportation', label: 'Transportation', options: ['Taxi', 'Airport Transfer', 'Hotel Car'] },
  { id: 'default-pool', routingType: 'pool', label: 'Pool service', options: ['Request Towel', 'Sunbed Assistance', 'Other'] },
];

// Shared context resolver - every guest-portal endpoint needs the same
// business -> room -> active reservation chain, verified fresh every
// time rather than trusted from the client. roomId is optional: a
// lobby/unassigned stand has no room to resolve, and that's a valid,
// supported state now (see migration 0082) - not an error.
async function resolveGuestContext(slug, roomId) {
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, name, slug, logo_url, links, theme, category')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();
  if (!business || business.category !== 'hotel') return null;

  if (!roomId) {
    return { business, room: null, reservation: null };
  }

  const { data: room } = await supabaseAdmin
    .from('hotel_rooms')
    .select('id, room_number, room_type, status')
    .eq('id', roomId)
    .eq('business_id', business.id)
    .single();
  if (!room) return null;

  const { data: reservation } = await supabaseAdmin
    .from('hotel_reservations')
    .select('id, check_in_date, check_out_date, hotel_guests(name, phone)')
    .eq('room_id', room.id)
    .eq('status', 'checked_in')
    .maybeSingle();

  return { business, room, reservation };
}

const getGuestPortal = asyncHandler(async (req, res) => {
  const ctx = await resolveGuestContext(req.params.slug, req.params.roomId);
  if (!ctx) return res.status(404).json({ message: 'Not found' });
  const { business, room, reservation } = ctx;

  let folioId = null;
  let folioBalance = null;
  let charges = [];
  if (reservation) {
    const { data: folio } = await supabaseAdmin
      .from('hotel_folios')
      .select('id, hotel_folio_charges(id, description, amount_aed, charge_type, created_at)')
      .eq('reservation_id', reservation.id)
      .eq('is_primary', true)
      .eq('status', 'open')
      .maybeSingle();
    if (folio) {
      folioId = folio.id;
      charges = (folio.hotel_folio_charges || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      folioBalance = charges.reduce((sum, c) => sum + Number(c.amount_aed), 0);
    }
  }

  // Real fix for a genuine gap: this list used to be hardcoded in the
  // frontend, identical for every hotel and impossible for an owner to
  // touch. Falls back to the same 7 defaults inline (not persisted) if
  // this business genuinely has zero rows yet - a brand-new hotel still
  // sees a sensible starting list, not an empty page, without needing a
  // separate seeding step at business-creation time.
  const { data: services } = await supabaseAdmin
    .from('hotel_guest_services')
    .select('id, routing_type, label, options')
    .eq('business_id', business.id)
    .eq('enabled', true)
    .order('sort_order');
  const guestServices = (services && services.length > 0) ? services.map((s) => ({
    id: s.id, routingType: s.routing_type, label: s.label, options: s.options || [],
  })) : DEFAULT_GUEST_SERVICES;

  // Real fix: a hotel card never used to route to the general LandingPage
  // at all when room-bound (resolveCardTap sends it straight to this
  // room-scoped portal instead) - so "Landing Page Buttons" custom
  // buttons, configured under that same name in Settings, were being
  // fetched by a page a hotel guest could never actually reach. As of
  // this fix, EVERY hotel card (room-bound or not) reaches this same
  // portal, so both button systems always render together, one page.
  const { data: customButtons } = await supabaseAdmin
    .from('custom_buttons')
    .select('id, label, icon, image_url, url, button_type, notification_destination, target_section, parent_button_id')
    .eq('business_id', business.id)
    .eq('enabled', true)
    .order('sort_order');

  res.json({
    business: { name: business.name, slug: business.slug, logoUrl: business.logo_url, links: business.links, theme: business.theme },
    // room is null for a lobby/unassigned stand - the frontend hides
    // room number, guest welcome text, and My Bill accordingly rather
    // than rendering blank/broken fields for something that doesn't exist.
    room: room ? { id: room.id, roomNumber: room.room_number, roomType: room.room_type } : null,
    guest: reservation ? { name: reservation.hotel_guests?.name, checkInDate: reservation.check_in_date, checkOutDate: reservation.check_out_date } : null,
    folioId,
    folioBalance,
    // Room rate and F&B charges are quoted VAT-inclusive (same UAE
    // convention as menu prices) - this breaks that out for the guest's
    // bill, same way the restaurant Pay Bill flow already does.
    vatBreakdown: folioBalance !== null ? calculateVatInclusive(folioBalance) : null,
    charges,
    guestServices,
    customButtons: customButtons || [],
  });
});

// @route POST /api/public/hotel/:slug/room/:roomId/requests
// Body: { requestType, note, quantity? }
// Housekeeping and maintenance requests land in the SAME tables staff
// already work from (housekeeping_tasks / maintenance_tickets) - not a
// separate bucket nobody's watching. Everything else (laundry,
// transportation, pool, reception message, feedback, other) still goes
// into guest_service_requests, which staff see via the existing Requests
// list - a dedicated queue per department is a reasonable next step, but
// every request submitted here is real and staff-visible today either way.
const submitGuestRequest = asyncHandler(async (req, res) => {
  const { requestType = 'other', note = '', quantity, targetSection } = req.body;

  const ctx = await resolveGuestContext(req.params.slug, req.params.roomId);
  if (!ctx) return res.status(404).json({ message: 'Not found' });
  const { business, room, reservation } = ctx;

  const fullNote = quantity ? `Qty: ${quantity}${note ? ' - ' + note : ''}` : note;
  // A request with no room (lobby/unassigned stand) still needs to say
  // so explicitly in the note staff actually read - a silent null
  // room_id in a list otherwise full of room numbers reads as a bug,
  // not as "front desk, no room," to whoever's working the queue.
  const noteWithContext = room ? fullNote : `[Front desk - no room]${fullNote ? ' ' + fullNote : ''}`;

  if (requestType === 'housekeeping' || requestType === 'towels' || requestType === 'turndown') {
    // task_type is constrained to cleaning/turndown/inspection/deep_clean
    // at the database level - "extra towels" etc. isn't its own type,
    // it's a cleaning task with the detail captured in notes instead.
    const taskType = requestType === 'turndown' ? 'turndown' : 'cleaning';
    const notes = requestType === 'towels' ? `Extra towels${noteWithContext ? ' - ' + noteWithContext : ''}` : noteWithContext;
    const { data, error } = await supabaseAdmin
      .from('housekeeping_tasks')
      .insert({ business_id: business.id, room_id: room?.id || null, task_type: taskType, notes })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    return res.status(201).json({ message: 'Request received - housekeeping has been notified.', request: { ...data, kind: 'housekeeping' } });
  }

  if (requestType === 'maintenance') {
    const { data, error } = await supabaseAdmin
      .from('maintenance_tickets')
      .insert({ business_id: business.id, room_id: room?.id || null, title: note || 'Guest-reported issue', description: noteWithContext, priority: 'normal' })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    return res.status(201).json({ message: 'Request received - maintenance has been notified.', request: { ...data, kind: 'maintenance' } });
  }

  const { data, error } = await supabaseAdmin
    .from('guest_service_requests')
    .insert({ business_id: business.id, room_id: room?.id || null, reservation_id: reservation?.id || null, request_type: requestType, note: noteWithContext, target_section: targetSection || null })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json({ message: 'Request received - our team has been notified.', request: { ...data, kind: 'general' } });
});

// @route POST /api/public/hotel/:slug/room/:roomId/orders
// Body: { outletId, items: [{ menuItemId, quantity, note? }], paymentMethod: 'room' | 'now' }
// The guest-facing order path: Room Service / a bar / breakfast, all
// through the same shared menu engine, routed into the exact same
// orders/order_items/kitchen pipeline staff already work from. Charge
// to Room posts straight to the guest's open folio, same mechanism the
// POS "Charge to Room" flow uses. Pay Now isn't wired to a live gateway
// session yet - the guest sees this as a clear "unavailable for now"
// rather than a broken or fake success state.
const submitGuestOrder = asyncHandler(async (req, res) => {
  const { outletId, items, paymentMethod = 'room', note = '' } = req.body;
  if (!outletId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'outletId and at least one item are required' });
  }
  if (paymentMethod === 'now') {
    return res.status(400).json({ message: 'Pay Now for room service isn\'t available yet - please choose Charge to Room.' });
  }

  const ctx = await resolveGuestContext(req.params.slug, req.params.roomId);
  if (!ctx) return res.status(404).json({ message: 'Not found' });
  const { business, room, reservation } = ctx;
  if (!reservation) return res.status(400).json({ message: 'No active stay found for this room' });

  const { data: folio } = await supabaseAdmin
    .from('hotel_folios')
    .select('id, status')
    .eq('reservation_id', reservation.id)
    .eq('is_primary', true)
    .eq('status', 'open')
    .maybeSingle();
  if (!folio) return res.status(400).json({ message: 'No open bill found for this stay - please contact reception' });

  const { data: outlet } = await supabaseAdmin.from('hotel_outlets').select('id, name, enabled').eq('id', outletId).eq('business_id', business.id).single();
  if (!outlet || !outlet.enabled) return res.status(404).json({ message: 'This outlet is not available' });

  const menuItemIds = items.map((i) => i.menuItemId);
  const { data: outletItems } = await supabaseAdmin
    .from('hotel_outlet_items')
    .select('menu_item_id, price_override_aed, available, menu_items(id, name, price, is_available)')
    .eq('outlet_id', outletId)
    .in('menu_item_id', menuItemIds);

  const byId = Object.fromEntries((outletItems || []).map((oi) => [oi.menu_item_id, oi]));
  for (const id of menuItemIds) {
    const oi = byId[id];
    if (!oi || !oi.available || !oi.menu_items?.is_available) {
      return res.status(400).json({ message: 'One or more items are no longer available' });
    }
  }

  const orderItemRows = items.map((i) => {
    const oi = byId[i.menuItemId];
    const unitPrice = oi.price_override_aed != null ? Number(oi.price_override_aed) : Number(oi.menu_items.price);
    return {
      menu_item_id: oi.menu_items.id,
      item_name: oi.menu_items.name,
      unit_price: unitPrice,
      quantity: Math.max(1, Number(i.quantity) || 1),
      note: i.note || '',
      addons: [],
      addon_total: 0,
      paid: true,
      paid_at: new Date().toISOString(),
    };
  });
  const total = orderItemRows.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: business.id,
      card_id: null,
      table_label: `Room ${room.room_number} - ${outlet.name}`,
      note,
      total,
      status: 'pending',
      source: 'guest_portal_hotel',
      payment_method: 'other',
      charged_to_folio_id: folio.id,
      hotel_outlet_id: outletId,
      room_id: room.id,
    })
    .select()
    .single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  await supabaseAdmin.from('hotel_folio_charges').insert({
    folio_id: folio.id,
    description: `${outlet.name} - order (${items.length} item${items.length === 1 ? '' : 's'})`,
    amount_aed: total,
    charge_type: 'fnb',
    source_order_id: order.id,
  });

  const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })));
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  res.status(201).json({ message: `Order sent to ${outlet.name} and charged to your room.`, order });
});

// @route GET /api/public/hotel/:slug/room/:roomId/my-requests
// Polled by the guest portal's "My Requests" tracker (a few seconds
// apart) rather than a raw Realtime subscription - the operational
// tables here (housekeeping_tasks, maintenance_tickets, orders) don't
// have anonymous-safe RLS policies scoped to a guest's own room today,
// and opening that up without being able to test it against a live
// database first isn't a risk worth taking. This still updates within
// a few seconds of a staff action, which reads as live to a guest.
const getMyRequests = asyncHandler(async (req, res) => {
  const ctx = await resolveGuestContext(req.params.slug, req.params.roomId);
  if (!ctx) return res.status(404).json({ message: 'Not found' });
  const { business, room } = ctx;

  // A lobby/unassigned stand has no room to scope "my requests" by -
  // there's no reliable, safe way to show "your" requests to an
  // anonymous visitor with no room or reservation tying them to
  // anything, so this returns an empty list rather than every request
  // for the whole business (which would leak other guests' requests).
  if (!room) return res.json([]);

  const [{ data: general }, { data: housekeeping }, { data: maintenance }, { data: orders }] = await Promise.all([
    supabaseAdmin.from('guest_service_requests').select('id, request_type, note, status, created_at, resolved_at').eq('room_id', room.id).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('housekeeping_tasks').select('id, task_type, notes, status, created_at, completed_at').eq('room_id', room.id).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('maintenance_tickets').select('id, title, status, priority, created_at, resolved_at').eq('room_id', room.id).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('orders').select('id, table_label, total, status, created_at').eq('room_id', room.id).order('created_at', { ascending: false }).limit(20),
  ]);

  const normalize = (rows, kind, labelFn, statusFn) =>
    (rows || []).map((r) => ({ id: r.id, kind, label: labelFn(r), status: statusFn(r), createdAt: r.created_at }));

  const combined = [
    ...normalize(general, 'general', (r) => r.request_type.replace('_', ' '), (r) => r.status),
    ...normalize(housekeeping, 'housekeeping', (r) => r.task_type.replace('_', ' '), (r) => r.status),
    ...normalize(maintenance, 'maintenance', (r) => r.title, (r) => r.status),
    ...normalize(orders, 'order', (r) => r.table_label, (r) => r.status),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(combined);
});

// --- Owner-facing management of the guest portal's service list ---
// (routes live under the authenticated /hotel/guest-services prefix,
// not /public - separate from everything above this line)

const ROUTING_TYPES = ['towels', 'turndown', 'housekeeping', 'maintenance', 'taxi', 'laundry', 'pool', 'transportation', 'other'];

const listGuestServices = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_guest_services')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });

  if (data && data.length > 0) return res.json(data);

  // Materializes the defaults into real rows the first time this is
  // opened for a business that has none yet - returning fake string ids
  // instead would mean the very first edit anyone makes fails with "not
  // found", since there'd be no real row behind it to update.
  const { data: seeded, error: seedError } = await req.supabase
    .from('hotel_guest_services')
    .insert(DEFAULT_GUEST_SERVICES.map((d, i) => ({
      business_id: req.params.businessId, routing_type: d.routingType, label: d.label, options: d.options, sort_order: i,
    })))
    .select();
  if (seedError) return res.status(400).json({ message: seedError.message });
  res.json(seeded);
});

const createGuestService = asyncHandler(async (req, res) => {
  const { routingType, label, options = [], sortOrder = 0 } = req.body;
  if (!routingType || !label) return res.status(400).json({ message: 'routingType and label are required' });
  if (!ROUTING_TYPES.includes(routingType)) return res.status(400).json({ message: 'Invalid routingType' });

  const { data, error } = await req.supabase
    .from('hotel_guest_services')
    .insert({ business_id: req.params.businessId, routing_type: routingType, label, options, sort_order: sortOrder })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateGuestService = asyncHandler(async (req, res) => {
  const { label, options, enabled, sortOrder, routingType } = req.body;
  const update = {};
  if (label !== undefined) update.label = label;
  if (options !== undefined) update.options = options;
  if (enabled !== undefined) update.enabled = enabled;
  if (sortOrder !== undefined) update.sort_order = sortOrder;
  if (routingType !== undefined) {
    if (!ROUTING_TYPES.includes(routingType)) return res.status(400).json({ message: 'Invalid routingType' });
    update.routing_type = routingType;
  }

  const { data, error } = await req.supabase
    .from('hotel_guest_services')
    .update(update)
    .eq('id', req.params.serviceId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Service not found' });
  res.json(data);
});

const deleteGuestService = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_guest_services')
    .delete({ count: 'exact' })
    .eq('id', req.params.serviceId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Service not found' });
  res.json({ message: 'Service removed' });
});

module.exports = {
  getGuestPortal, submitGuestRequest, submitGuestOrder, getMyRequests,
  listGuestServices, createGuestService, updateGuestService, deleteGuestService,
};
