const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/bookings?status=
const listBookings = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('bookings')
    .select('*, cards(label)')
    .eq('business_id', req.params.businessId)
    .order('requested_at', { ascending: true });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/bookings
// Body: { guestName, contactPhone, partySize, requestedAt, note?, tableId?, serviceId? }
// The real gap this closes: staff had no way to create a booking at all
// - every reservation had to come through the customer's own NFC tap or
// public booking page, so a phone call ("table for 4 at 8pm") had
// nowhere to go. Same table, same list, same status flow as a
// guest-submitted booking from here on - just created directly by staff
// instead of arriving as an event.
const createBooking = asyncHandler(async (req, res) => {
  const { guestName, contactPhone = '', partySize, requestedAt, note = '', tableId = null, serviceId = null, serviceName = '' } = req.body;
  if (!guestName || !requestedAt) {
    return res.status(400).json({ message: 'guestName and requestedAt are required' });
  }

  const { data, error } = await req.supabase
    .from('bookings')
    .insert({
      business_id: req.params.businessId,
      guest_name: guestName,
      contact_phone: contactPhone,
      party_size: partySize || null,
      requested_at: requestedAt,
      note,
      table_id: tableId,
      service_id: serviceId,
      service_name: serviceName,
      status: 'confirmed', // staff-created reservations are confirmed on the spot, not left pending for someone to approve their own phone call
      created_by_staff_id: req.user.id,
    })
    .select('*, cards(label)')
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'booking_created_by_staff', targetId: data.id, details: { guestName, requestedAt, partySize } });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/bookings/:bookingId
// Body: { status?, tableId? }
const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status, tableId } = req.body;
  const allowed = ['pending', 'confirmed', 'declined', 'completed', 'cancelled'];
  const update = {};
  if (status !== undefined) {
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    update.status = status;
  }
  if (tableId !== undefined) update.table_id = tableId;
  if (Object.keys(update).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const { data, error } = await req.supabase
    .from('bookings')
    .update(update)
    .eq('id', req.params.bookingId)
    .eq('business_id', req.params.businessId)
    .select('*, cards(label)')
    .single();

  if (error || !data) return res.status(404).json({ message: 'Booking not found' });
  res.json(data);
});

module.exports = { listBookings, createBooking, updateBookingStatus };
