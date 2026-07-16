const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/bookings?status=
const listBookings = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('bookings')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('requested_at', { ascending: true });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/bookings/:bookingId
// Body: { status: 'pending'|'confirmed'|'declined'|'completed'|'cancelled' }
const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'declined', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const { data, error } = await req.supabase
    .from('bookings')
    .update({ status })
    .eq('id', req.params.bookingId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Booking not found' });
  res.json(data);
});

module.exports = { listBookings, updateBookingStatus };
